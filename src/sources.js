// Media sources: every connected server (Plex, Jellyfin, Emby) behind one set of calls.
// Item and library keys carry the server: "<server id>~<native id>". Keys without a "~"
// belong to the first Plex server, so play history, lineup and resume points saved before
// multi-server support keep working unchanged.
import * as conn from './connections.js';
import * as plex from './plex.js';
import * as jf from './jellyfin.js';
import { settings } from './settings.js';

export const safeKey = (k) => String(k ?? '').replace(/[^A-Za-z0-9~_.:-]/g, '').slice(0, 120);

const defaultPlex = () => conn.plexServer();
const isDefault = (srv) => !!srv && srv.id === defaultPlex()?.id;

/** Split a key into its server and the server's own id. */
export function parseKey(key) {
  key = safeKey(key);
  const i = key.indexOf('~');
  if (i < 0) return { srv: defaultPlex(), id: key };
  return { srv: conn.server(key.slice(0, i)), id: key.slice(i + 1) };
}
function need(key) {
  const p = parseKey(key);
  if (!p.srv) throw Object.assign(new Error('That media server is no longer connected'), { status: 404 });
  return p;
}
const prefix = (srv, id) => (id == null ? id : isDefault(srv) ? String(id) : `${srv.id}~${id}`);

/** Mark Plex items with their server (keys and image paths prefixed unless it's the first Plex server). */
function tagPlex(srv, item) {
  return {
    ...item, server: srv.id, serverType: 'plex',
    ratingKey: prefix(srv, item.ratingKey),
    thumb: prefix(srv, item.thumb),
    art: prefix(srv, item.art),
  };
}

const run = (srv, plexFn, jfFn) => (srv.type === 'plex' ? plex.withServer(srv, plexFn) : jfFn());

// ---------------- libraries ----------------
/** Media servers in the admin's order (Admin → Connections); servers not ordered yet follow. */
export function orderedServers() {
  const order = settings().serverOrder || [];
  const pos = (id) => { const i = order.indexOf(id); return i === -1 ? 1e6 : i; };
  return conn.servers().map((s, i) => ({ s, i })).sort((a, b) => pos(a.s.id) - pos(b.s.id) || a.i - b.i).map((x) => x.s);
}

/** Movie and TV libraries across all servers, grouped by server (in server order), then the library order. */
export async function libraries({ all = false } = {}) {
  const servers = orderedServers();
  const multi = servers.length > 1;
  const lists = await Promise.all(servers.map(async (srv, si) => {
    try {
      const libs = await run(srv, () => plex.libraries(), () => jf.libraries(srv));
      return libs.map((l, i) => ({ ...l, id: prefix(srv, l.id), server: srv.id, serverName: srv.name, serverType: srv.type, multi, rank: si * 1000 + i }));
    } catch (e) {
      console.warn(`[sources] ${srv.name}: ${e.message}`);
      return [];
    }
  }));
  lists.push(await liveEntries(servers, multi));
  const { librarySections: allowed, libraryOrder: order, librarySort: sorts } = settings();
  const pos = (id) => { const i = order.indexOf(id); return i === -1 ? 1e6 : i; };
  return lists.flat()
    .filter((l) => all || !allowed.length || allowed.includes(l.id))
    .map((l) => ({ ...l, defaultSort: sorts[l.id] || 'title' }))
    .sort((a, b) => Math.floor(a.rank / 1000) - Math.floor(b.rank / 1000) || (a.type === 'live') - (b.type === 'live') || pos(a.id) - pos(b.id) || a.rank - b.rank)
    .map(({ rank, multi: m, ...l }) => (m ? l : { ...l, serverName: undefined }));
}

function checkAllowed(libKey) {
  const allowed = settings().librarySections;
  if (allowed.length && !allowed.includes(safeKey(libKey))) throw Object.assign(new Error('Library not allowed'), { status: 403 });
}

export async function libraryItems(libKey, opts) {
  checkAllowed(libKey);
  const { srv, id } = need(libKey);
  if (srv.type === 'plex') {
    const r = await plex.withServer(srv, () => plex.libraryItems(id, opts));
    return { ...r, items: r.items.map((x) => tagPlex(srv, x)) };
  }
  return jf.libraryItems(srv, id, opts);
}

export async function libraryLetters(libKey) {
  checkAllowed(libKey);
  const { srv, id } = need(libKey);
  return run(srv, () => plex.libraryLetters(id), () => jf.libraryLetters(srv, id));
}

export async function search(query) {
  const results = await Promise.all(conn.servers().map((srv) => (srv.type === 'plex'
    ? plex.withServer(srv, () => plex.search(query)).then((xs) => xs.map((x) => tagPlex(srv, x)))
    : jf.search(srv, query)).catch((e) => { console.warn(`[sources] search on ${srv.name}: ${e.message}`); return []; })));
  const order = { movie: 0, show: 0, season: 1, episode: 2 };
  return results.flat().sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3)).slice(0, 40);
}

export async function children(key) {
  const { srv, id } = need(key);
  if (srv.type === 'plex') return (await plex.withServer(srv, () => plex.children(id))).map((x) => tagPlex(srv, x));
  return jf.children(srv, id);
}

export async function metadata(key) {
  const { srv, id } = need(key);
  if (srv.type === 'plex') return tagPlex(srv, await plex.withServer(srv, () => plex.metadata(id)));
  return jf.metadata(srv, id);
}

// Cast photos: which server each face id came from.
const faceOwner = new Map();
export async function info(key) {
  const { srv, id } = need(key);
  if (srv.type !== 'plex') return jf.info(srv, id);
  const i = tagPlex(srv, await plex.withServer(srv, () => plex.info(id)));
  for (const c of i.cast || []) if (c.face) faceOwner.set(c.face, srv.id);
  if (faceOwner.size > 5000) faceOwner.clear();
  return i;
}

// ---------------- images ----------------
const PLEX_IMG = /^\/library\/metadata\/\d+\/(thumb|art)(\/\d+)?$/;

/** Fetch a poster/art image by the `thumb` value an item carries. Resolves to a Response or null. */
/** Split an image ref into its server and path. Plain paths and URLs belong to the first Plex server. */
function splitRef(ref) {
  ref = String(ref || '');
  const m = !ref.startsWith('/') && !/^https?:/.test(ref) && ref.match(/^([A-Za-z0-9_-]{1,40})~(.*)$/);
  return m ? { srv: conn.server(m[1]), path: m[2] } : { srv: defaultPlex(), path: ref };
}

export async function image(ref, w = 300, h = 450) {
  const { srv, path } = splitRef(ref);
  if (!srv) return null;
  if (srv.type === 'plex') {
    if (!PLEX_IMG.test(path)) return null;
    return fetch(plex.withServer(srv, () => plex.photoUrl(path, w, h))).catch(() => null);
  }
  return jf.image(srv, path, w, h)?.catch(() => null) || null;
}

/** Any Plex-style image (including external URLs Plex returned), for Discord posts. */
export async function anyImage(ref, w, h) {
  const { srv, path } = splitRef(ref);
  if (!srv) return null;
  if (srv.type !== 'plex') return jf.image(srv, path, w, h)?.catch(() => null) || null;
  if (!path.startsWith('/') && !/^https?:/.test(path)) return null;
  return fetch(plex.withServer(srv, () => plex.photoUrl(path, w, h))).catch(() => null);
}

/** A cast photo by face id. */
export async function faceImage(fid) {
  const jfFace = jf.face(fid);
  if (jfFace) {
    const srv = conn.server(jfFace.srvId);
    return srv ? jf.image(srv, jfFace.personId, 120, 120)?.catch(() => null) : null;
  }
  const url = plex.faceUrl(fid);
  if (!url) return null;
  const srv = conn.server(faceOwner.get(fid)) || defaultPlex();
  if (!srv) return null;
  return fetch(plex.withServer(srv, () => plex.photoUrl(url, 120, 120))).catch(() => null);
}

// ---------------- connection checks ----------------
/** Library count etc. for the Connections panel. */
export async function health(srv) {
  const started = Date.now();
  try {
    const libs = await run(srv, () => plex.libraries(), () => jf.libraries(srv));
    return { ok: true, libraries: libs.length, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'No answer' : e.message };
  }
}

// ---------------- Live TV (every server that has it) ----------------
// Each server's Live TV is listed in Admin → Libraries as "Live TV" and turned on or off like a
// library. Its key is "live" for the first Plex server (as before) and "<server id>~live" otherwise.
// Channel ids carry the server the same way as item keys.
export const liveKey = (srv) => prefix(srv, 'live');
const noLive = new Map(); // server id -> time we learned it has no Live TV (rechecked after 5 minutes)

async function rawChannels(srv) {
  return run(srv, () => plex.liveChannels(), () => jf.liveChannels(srv));
}

/** Servers with Live TV, as Libraries entries: { id, title: 'Live TV', type: 'live', ... }. */
async function liveEntries(servers, multi) {
  const out = await Promise.all(servers.map(async (srv, si) => {
    const miss = noLive.get(srv.id);
    if (miss && Date.now() - miss < 5 * 60_000) return null;
    try {
      const ch = await rawChannels(srv);
      if (!ch.length) throw new Error('no channels');
      noLive.delete(srv.id);
      return { id: liveKey(srv), title: 'Live TV', type: 'live', channels: ch.length, server: srv.id, serverName: srv.name, serverType: srv.type, multi, rank: si * 1000 + 999 };
    } catch {
      noLive.set(srv.id, Date.now());
      return null;
    }
  }));
  return out.filter(Boolean);
}

const liveEnabled = (srv) => {
  const allowed = settings().librarySections;
  return !allowed.length || allowed.includes(liveKey(srv));
};
/** Servers whose Live TV is turned on (and that have it). */
async function liveServers() {
  const servers = conn.servers().filter(liveEnabled);
  const live = await liveEntries(servers, false);
  return servers.filter((s) => live.some((l) => l.server === s.id));
}

const tagChannel = (srv, c, multi) => ({
  ...c, id: prefix(srv, c.id), server: srv.id, serverName: multi ? srv.name : undefined,
  thumb: c.thumb ? (srv.type === 'plex' ? prefix(srv, c.thumb) : `${srv.id}~${c.thumb}`) : '',
});
const tagProgramme = (srv, p) => ({ ...p, thumb: p.thumb ? (srv.type === 'plex' ? prefix(srv, p.thumb) : `${srv.id}~${p.thumb}`) : '' });

/** Every enabled channel, server by server. */
export async function liveChannels() {
  const servers = await liveServers();
  const lists = await Promise.all(servers.map((srv) => rawChannels(srv).then((cs) => cs.map((c) => tagChannel(srv, c, servers.length > 1))).catch(() => [])));
  return lists.flat();
}

/** Guide rows for every enabled channel (or just onlyIds, or one server's) between from and to. */
export async function guide(from, to, onlyIds = null, serverId = null) {
  const servers = (await liveServers()).filter((s) => !serverId || s.id === serverId);
  const lists = await Promise.all(servers.map(async (srv) => {
    const mine = onlyIds ? onlyIds.map((k) => parseKey(k)).filter((p) => p.srv?.id === srv.id).map((p) => p.id) : null;
    if (mine && !mine.length) return [];
    try {
      const rows = await run(srv, () => plex.guide(from, to, mine), () => jf.guide(srv, from, to, mine));
      return rows.map((r) => ({ ...tagChannel(srv, r, servers.length > 1), programmes: r.programmes.map((p) => tagProgramme(srv, p)) }));
    } catch (e) {
      console.warn(`[sources] guide from ${srv.name}: ${e.message}`);
      return [];
    }
  }));
  return lists.flat();
}

/** One channel as a playable item. */
export async function liveChannel(key) {
  const { srv, id } = need(key);
  if (!liveEnabled(srv)) throw Object.assign(new Error('Live TV is turned off for that server'), { status: 403 });
  const c = (await rawChannels(srv)).find((ch) => ch.id === id);
  if (!c) throw Object.assign(new Error('Channel not found'), { status: 404 });
  return { source: 'live', kind: 'channel', channelId: prefix(srv, c.id), number: c.number, server: srv.id, serverType: srv.type, title: `${c.number ? c.number + ' ' : ''}${c.name}`, duration: 0, thumb: null };
}

/** A channel plus what's on now and next, for "now playing" posts and history. */
export async function liveNow(key) {
  const { srv } = parseKey(key);
  if (!srv) return null;
  const t = Date.now();
  const row = (await guide(t - 6 * 3600_000, t + 6 * 3600_000, [safeKey(key)]))[0];
  if (!row) return null;
  const progs = row.programmes || [];
  const i = progs.findIndex((p) => p.start <= t && p.stop > t);
  const { programmes, ...channel } = row;
  return { channel, now: i >= 0 ? progs[i] : null, next: i >= 0 ? progs[i + 1] || null : progs.find((p) => p.start > t) || null };
}

/** Live TV status of every server, for the Admin page. */
export async function liveStatus() {
  return Promise.all(conn.servers().map(async (srv) => {
    try {
      const ch = await rawChannels(srv);
      const extra = srv.type === 'plex' ? await plex.withServer(srv, () => plex.liveStatus()) : {};
      return { server: srv.id, serverName: srv.name, serverType: srv.type, key: liveKey(srv), enabled: liveEnabled(srv), available: ch.length > 0, channels: ch.length, provider: extra.provider || '' };
    } catch (e) {
      return { server: srv.id, serverName: srv.name, serverType: srv.type, key: liveKey(srv), enabled: liveEnabled(srv), available: false, error: e.message };
    }
  }));
}

export function clearLiveCache() { plex.clearLiveCache(); jf.clearLiveCache(); noLive.clear(); }

/** Which server an entry (history, lineup, stream) is from, for the side rails. Only when several servers are set up. */
export function serverTag(entry) {
  if (conn.servers().length < 2 || !entry) return undefined;
  const key = entry.source === 'live' ? entry.channelId : entry.ratingKey;
  if (!key) return undefined;
  const { srv } = parseKey(key);
  return srv ? { id: srv.id, name: srv.name, type: srv.type } : undefined;
}
