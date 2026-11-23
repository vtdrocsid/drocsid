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
/** Movie and TV libraries across all servers, filtered and ordered by the admin settings. */
export async function libraries({ all = false } = {}) {
  const servers = conn.servers();
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
  const { librarySections: allowed, libraryOrder: order, librarySort: sorts } = settings();
  const pos = (id) => { const i = order.indexOf(id); return i === -1 ? 1e6 : i; };
  return lists.flat()
    .filter((l) => all || !allowed.length || allowed.includes(l.id))
    .map((l) => ({ ...l, defaultSort: sorts[l.id] || 'title' }))
    .sort((a, b) => pos(a.id) - pos(b.id) || a.rank - b.rank)
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
