// Jellyfin and Emby (their APIs are nearly the same): sign-in, libraries, titles, images and
// HLS playback. Every request is made from the server with the token in a header; tokens are
// never put in URLs that reach a browser.
import crypto from 'node:crypto';
import { config } from './config.js';

const VERSION = '1.0';
const deviceId = () => `${config.plexClientId || 'drocsid'}`;

function authHeaders(srv, token = srv.token) {
  const fields = `Client="drocsid", Device="drocsid", DeviceId="${deviceId()}", Version="${VERSION}"${token ? `, Token="${token}"` : ''}`;
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (srv.type === 'emby') {
    h['X-Emby-Authorization'] = `Emby UserId="${srv.userId || ''}", ${fields}`;
    if (token) h['X-Emby-Token'] = token;
  } else {
    h.Authorization = `MediaBrowser ${fields}`;
  }
  return h;
}

const base = (srv) => srv.url.replace(/\/$/, '');

async function call(srv, path, { method = 'GET', params, body, timeout = 15_000, raw = false } = {}) {
  const url = new URL(base(srv) + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers: authHeaders(srv), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  if (raw) return res;
  if (!res.ok) throw Object.assign(new Error(`${label(srv)} ${res.status} on ${path}`), { status: res.status === 401 ? 502 : res.status });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
const label = (srv) => (srv.type === 'emby' ? 'Emby' : 'Jellyfin');

// ---------------- connecting ----------------
/**
 * Check an address and sign in, with a username + password or an API key.
 * Returns { ok, name, version, machineId, token, userId, username, libraries } or { ok:false, error }.
 */
export async function connect({ type, url, username, password, apiKey, token, userId }) {
  url = String(url || '').trim().replace(/\/$/, '');
  const srv = { type, url, token: '', userId: userId || '' };
  if (!/^https?:\/\/[^/\s]+/.test(url)) return { ok: false, error: 'Enter an address like http://192.168.1.10:8096' };
  let info;
  try {
    const r = await fetch(`${url}/System/Info/Public`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false, error: `No ${type === 'emby' ? 'Emby' : 'Jellyfin'} server answered there (${r.status})` };
    info = await r.json();
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'No answer from that address (from inside the container)' : e.message };
  }
  const product = String(info.ProductName || '');
  if (type === 'jellyfin' && /emby/i.test(product)) return { ok: false, error: 'That is an Emby server. Pick Emby instead.' };
  if (type === 'emby' && /jellyfin/i.test(product)) return { ok: false, error: 'That is a Jellyfin server. Pick Jellyfin instead.' };

  try {
    if (username) {
      const r = await fetch(`${url}/Users/AuthenticateByName`, { method: 'POST', headers: authHeaders(srv, ''), body: JSON.stringify({ Username: username, Pw: password || '' }), signal: AbortSignal.timeout(10_000) });
      if (r.status === 401) return { ok: false, error: 'Wrong username or password' };
      if (!r.ok) return { ok: false, error: `Sign-in failed (${r.status})` };
      const j = await r.json();
      srv.token = j.AccessToken;
      srv.userId = j.User?.Id;
      srv.username = j.User?.Name || username;
    } else if (apiKey || token) {
      srv.token = String(apiKey || token).trim();
      if (!srv.userId) {
        // An API key isn't tied to a user: browse as the first administrator.
        const users = await call(srv, '/Users').catch((e) => { throw Object.assign(new Error(e.status === 502 ? 'The API key was not accepted' : e.message), { known: true }); });
        const admin = users.find((u) => u.Policy?.IsAdministrator) || users[0];
        if (!admin) return { ok: false, error: 'No users found on the server' };
        srv.userId = admin.Id;
        srv.username = admin.Name;
      }
    } else {
      return { ok: false, error: 'Enter a username and password, or an API key' };
    }
    const views = await call(srv, `/Users/${srv.userId}/Views`);
    const libs = (views.Items || []).filter((v) => ['movies', 'tvshows'].includes(v.CollectionType));
    return {
      ok: true, url, name: info.ServerName || label(srv), version: info.Version || '', machineId: info.Id || '',
      token: srv.token, userId: srv.userId, username: srv.username || '', libraries: libs.length,
    };
  } catch (e) {
    return { ok: false, error: e.known ? e.message : e.status === 502 ? 'The server rejected the sign-in' : e.message };
  }
}

// ---------------- library ----------------
const TYPES = { Movie: 'movie', Series: 'show', Season: 'season', Episode: 'episode' };
const FIELDS = 'Overview,ProductionYear,OfficialRating,ChildCount,RecursiveItemCount,SortName,CriticRating,PremiereDate';

/** Item keys and image refs carry the server id, so they can be routed back here. */
function toItem(srv, m) {
  const kind = TYPES[m.Type] || 'other';
  let title = m.Name;
  if ((kind === 'movie' || kind === 'show') && m.ProductionYear) title += ` (${m.ProductionYear})`;
  if (kind === 'season') title = `${m.SeriesName ? m.SeriesName + ' — ' : ''}${m.Name}`;
  if (kind === 'episode') {
    const se = `S${String(m.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(m.IndexNumber ?? 0).padStart(2, '0')}`;
    title = `${m.SeriesName ? m.SeriesName + ' ' : ''}${se} — ${m.Name}`;
  }
  // Poster: the item's own, else its season's or series'.
  // Poster: don't rely on ImageTags (list replies sometimes leave them out); ask for the title's own
  // poster, or for seasons/episodes without one, the show's. A title with no poster just 404s.
  const ownless = (kind === 'season' || kind === 'episode') && !m.ImageTags?.Primary && m.SeriesId;
  const thumbId = ownless ? m.SeriesId : m.Id;
  return {
    source: 'plex', // "library title" (as opposed to 'live'); the server is in `server`
    server: srv.id,
    serverType: srv.type,
    kind,
    ratingKey: `${srv.id}~${m.Id}`,
    title,
    shortTitle: m.Name,
    titleSort: m.SortName || m.Name,
    year: m.ProductionYear,
    summary: m.Overview || '',
    contentRating: m.OfficialRating || '',
    index: m.IndexNumber,
    thumb: thumbId ? `${srv.id}~img:${thumbId}` : null,
    art: null,
    duration: m.RunTimeTicks ? m.RunTimeTicks / 1e7 : 0,
    leafCount: m.RecursiveItemCount,
    childCount: m.ChildCount,
    rt: m.CriticRating != null ? { kind: 'critic', score: Math.round(m.CriticRating), fresh: m.CriticRating >= 60 } : null,
  };
}

export async function libraries(srv) {
  const views = await call(srv, `/Users/${srv.userId}/Views`);
  return (views.Items || [])
    .filter((v) => ['movies', 'tvshows'].includes(v.CollectionType))
    .map((v) => ({ id: v.Id, title: v.Name, type: v.CollectionType === 'movies' ? 'movie' : 'show' }));
}

const SORTS = { title: ['SortName', 'Ascending'], added: ['DateCreated', 'Descending'], released: ['PremiereDate,ProductionYear', 'Descending'], year: ['ProductionYear', 'Descending'] };

export async function libraryItems(srv, libId, { start = 0, size = 60, sort = 'title' } = {}) {
  const [by, order] = SORTS[sort] || SORTS.title;
  const j = await call(srv, `/Users/${srv.userId}/Items`, {
    params: {
      ParentId: libId, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: by, SortOrder: order,
      StartIndex: start, Limit: size, Fields: FIELDS, EnableTotalRecordCount: true, ImageTypeLimit: 1, EnableImageTypes: 'Primary',
    },
  });
  return { total: j.TotalRecordCount ?? (j.Items || []).length, items: (j.Items || []).map((m) => toItem(srv, m)) };
}

/** Titles per starting character, like Plex's jump bar ("#" for anything before A). */
const letterCache = new Map();
export async function libraryLetters(srv, libId) {
  const key = `${srv.id}:${libId}`;
  const hit = letterCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const count = (extra) => call(srv, `/Users/${srv.userId}/Items`, {
    params: { ParentId: libId, Recursive: true, IncludeItemTypes: 'Movie,Series', Limit: 0, EnableTotalRecordCount: true, ...extra },
  }).then((j) => j.TotalRecordCount || 0).catch(() => 0);
  const letters = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const out = [];
  for (let i = 0; i < letters.length; i += 6) {
    const part = letters.slice(i, i + 6);
    const sizes = await Promise.all(part.map((L) => count(L === '#' ? { NameLessThan: 'A' } : { NameStartsWith: L })));
    part.forEach((L, j) => sizes[j] && out.push({ key: L, title: L, size: sizes[j] }));
  }
  letterCache.set(key, { at: Date.now(), data: out });
  return out;
}

export async function search(srv, query) {
  const j = await call(srv, `/Users/${srv.userId}/Items`, {
    params: { SearchTerm: query, Recursive: true, IncludeItemTypes: 'Movie,Series,Episode', Limit: 30, Fields: FIELDS },
  });
  return (j.Items || []).map((m) => toItem(srv, m));
}

export async function children(srv, id) {
  const j = await call(srv, `/Users/${srv.userId}/Items`, {
    params: { ParentId: id, SortBy: 'ParentIndexNumber,IndexNumber,SortName', SortOrder: 'Ascending', Fields: FIELDS },
  });
  return (j.Items || []).filter((m) => TYPES[m.Type]).map((m) => toItem(srv, m));
}

async function raw(srv, id) {
  return call(srv, `/Users/${srv.userId}/Items/${encodeURIComponent(id)}`);
}

export async function metadata(srv, id) {
  return toItem(srv, await raw(srv, id));
}

// Cast photos: opaque ids so only people this server returned can be fetched.
const faces = new Map(); // face id -> { srvId, personId, tag }
export const face = (id) => faces.get(id) || null;

export async function info(srv, id) {
  const m = await raw(srv, id);
  const cast = (m.People || []).filter((p) => p.Type === 'Actor').slice(0, 10).map((p) => {
    let fid = null;
    if (p.PrimaryImageTag) {
      fid = crypto.createHash('sha1').update(`${srv.id}:${p.Id}`).digest('hex').slice(0, 16);
      if (faces.size > 5000) faces.clear();
      faces.set(fid, { srvId: srv.id, personId: p.Id, tag: p.PrimaryImageTag });
    }
    return { name: p.Name, role: p.Role || '', face: fid };
  });
  return {
    ...toItem(srv, m),
    tagline: (m.Taglines || [])[0] || '',
    studio: (m.Studios || [])[0]?.Name || '',
    genres: (m.Genres || []).slice(0, 4),
    directors: (m.People || []).filter((p) => p.Type === 'Director').slice(0, 2).map((p) => p.Name),
    cast,
  };
}

/** Fetch an image: "img:<item id>" (poster) or a person id (cast photo). */
// Posters: a library page asks for ~60 at once, and Jellyfin/Emby resize each one the first time
// (slow). So requests per server are limited, given time, retried once, and recent ones are
// kept in memory (shared by everyone browsing).
const IMG_PARALLEL = 6;
const IMG_CACHE_BYTES = 64 * 1024 * 1024;
const imgCache = new Map(); // key -> { buf, type, at }
let imgCacheBytes = 0;
const lanes = new Map(); // server id -> { active, queue: [] }
async function inLane(srvId, fn) {
  const lane = lanes.get(srvId) || lanes.set(srvId, { active: 0, queue: [] }).get(srvId);
  if (lane.active >= IMG_PARALLEL) await new Promise((r) => lane.queue.push(r));
  lane.active++;
  try { return await fn(); } finally {
    lane.active--;
    lane.queue.shift()?.();
  }
}
function remember(key, buf, type) {
  imgCache.set(key, { buf, type, at: Date.now() });
  imgCacheBytes += buf.length;
  for (const [k, v] of imgCache) { // oldest first
    if (imgCacheBytes <= IMG_CACHE_BYTES) break;
    imgCache.delete(k);
    imgCacheBytes -= v.buf.length;
  }
}

/** A poster or photo as a Response (from memory when possible). */
export async function image(srv, ref, w = 300, h = 450) {
  const id = ref.startsWith('img:') ? ref.slice(4) : ref;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
  const key = `${srv.id}|${id}|${w}x${h}`;
  const hit = imgCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) {
    imgCache.delete(key); imgCache.set(key, hit); // most recently used last
    return new Response(hit.buf, { headers: { 'content-type': hit.type } });
  }
  return inLane(srv.id, async () => {
    const started = Date.now();
    let last = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await call(srv, `/Items/${id}/Images/Primary`, { params: { maxWidth: w, maxHeight: h, quality: 90 }, raw: true, timeout: 45_000 });
        if (r.status === 404) return r; // no image: nothing to retry
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          const type = r.headers.get('content-type') || 'image/jpeg';
          remember(key, buf, type);
          return new Response(buf, { headers: { 'content-type': type } });
        }
        last = `HTTP ${r.status}`;
      } catch (e) {
        last = e.name === 'TimeoutError' ? 'timed out' : e.message;
      }
    }
    console.warn(`[jf image] ${srv.name}: ${id} ${w}x${h} failed after 2 tries (${last}, ${Date.now() - started} ms)`);
    return new Response(null, { status: 504 });
  });
}

// ---------------- playback ----------------
/**
 * Start a transcoded HLS stream (H.264 + AAC in MPEG-TS, which every Discord client plays).
 * Returns { masterPath, playSessionId, mediaSourceId } where masterPath is the server's
 * master playlist path with any token removed.
 */
export async function startStream(srv, id, { startSeconds = 0, preset }) {
  const maxBitrate = (preset?.bitrate || 200000) * 1000;
  const body = {
    UserId: srv.userId,
    MaxStreamingBitrate: maxBitrate,
    StartTimeTicks: Math.floor(startSeconds * 1e7),
    AutoOpenLiveStream: true,
    EnableDirectPlay: false,
    EnableDirectStream: false,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    DeviceProfile: {
      Name: 'drocsid',
      MaxStreamingBitrate: maxBitrate,
      MaxStaticBitrate: maxBitrate,
      DirectPlayProfiles: [],
      TranscodingProfiles: [{
        Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming',
        MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true,
      }],
      ContainerProfiles: [],
      CodecProfiles: preset?.height ? [{ Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'Height', Value: String(preset.height), IsRequired: false }] }] : [],
      SubtitleProfiles: [{ Format: 'srt', Method: 'Encode' }, { Format: 'ass', Method: 'Encode' }, { Format: 'pgssub', Method: 'Encode' }],
    },
  };
  const j = await call(srv, `/Items/${encodeURIComponent(id)}/PlaybackInfo`, { method: 'POST', params: { UserId: srv.userId }, body });
  const ms = (j.MediaSources || [])[0];
  if (!ms?.TranscodingUrl) throw new Error(`${label(srv)} could not start a stream for this title${j.ErrorCode ? ` (${j.ErrorCode})` : ''}`);
  const u = new URL(ms.TranscodingUrl, 'http://x');
  for (const k of [...u.searchParams.keys()]) if (/^(api_key|apikey|x-emby-token)$/i.test(k)) u.searchParams.delete(k);
  return { masterPath: u.pathname + u.search, playSessionId: j.PlaySessionId, mediaSourceId: ms.Id, liveStreamId: ms.LiveStreamId || null };
}

/** Is this a path the browser may fetch through our proxy (stream playlists and segments only)? */
export const allowedStreamPath = (p) => /^(\/emby)?\/videos\/[A-Za-z0-9-]+\/[^?]*\.(m3u8|ts|mp4|m4s|aac|vtt)(\?|$)/i.test(p)
  || /^(\/emby)?\/videos\/[A-Za-z0-9-]+\/hls1?\/[^?]+(\?|$)/i.test(p);

/** Fetch a stream playlist or segment from the server for the proxy. */
export async function streamFetch(srv, pathAndQuery) {
  // Time limit only until the server starts answering. A limit on the whole download would
  // abort long segment downloads mid-way (that crashed 0.5.3 while scrubbing).
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`${label(srv)} did not answer within 60 s`)), 60_000);
  try {
    return await fetch(base(srv) + pathAndQuery, { headers: authHeaders(srv), signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Remove anything from a playlist that a browser shouldn't get: tag lines that carry their own
 * URLs (e.g. Jellyfin's Trickplay preview tiles, whose URI includes the access key), and any
 * api_key/ApiKey left in segment URLs.
 */
export function cleanPlaylist(text) {
  return text.split('\n')
    .filter((line) => !/^#EXT-X-(IMAGE-STREAM-INF|I-FRAME-STREAM-INF|SESSION-DATA)/.test(line) && !/URI="[^"]*(api_?key|token)=/i.test(line))
    .map((line) => (line.startsWith('#') ? line : line.replace(/([?&])(api_key|apikey|x-emby-token)=[^&\s]*&?/gi, '$1').replace(/[?&]$/, '')))
    .join('\n');
}

/** Rewrite a master playlist so its variant URLs go through our proxy. */
export function rewriteMaster(srv, masterPath, text) {
  const dir = masterPath.split('?')[0].replace(/[^/]*$/, '');
  return cleanPlaylist(text).split('\n').map((line) => {
    if (!line || line.startsWith('#')) return line;
    const abs = /^https?:/.test(line) ? new URL(line).pathname + new URL(line).search : line.startsWith('/') ? line : dir + line.trim();
    const u = new URL(abs, 'http://x');
    for (const k of [...u.searchParams.keys()]) if (/^(api_key|apikey)$/i.test(k)) u.searchParams.delete(k);
    return `/media/jf/${srv.id}${u.pathname}${u.search}`;
  }).join('\n');
}

const ticks = (s) => Math.floor((s || 0) * 1e7);
export function report(srv, kind, { itemId, mediaSourceId, playSessionId, position, paused }) {
  const path = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped' }[kind];
  return call(srv, path, {
    method: 'POST',
    body: { ItemId: itemId, MediaSourceId: mediaSourceId, PlaySessionId: playSessionId, PositionTicks: ticks(position), IsPaused: !!paused, CanSeek: true, PlayMethod: 'Transcode' },
  }).catch(() => {});
}

export async function stopStream(srv, playSessionId) {
  await call(srv, '/Videos/ActiveEncodings', { method: 'DELETE', params: { deviceId: deviceId(), playSessionId } }).catch(() => {});
}

// ---------------- Live TV ----------------
const liveCache = new Map(); // server id -> { at, channels }

/** Channels in number order: { id, number, name, callSign, thumb }. Cached for 10 minutes. */
export async function liveChannels(srv) {
  const hit = liveCache.get(srv.id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.channels;
  const j = await call(srv, '/LiveTv/Channels', { params: { UserId: srv.userId, EnableImages: true, EnableUserData: false, SortBy: 'SortName' } });
  const channels = (j.Items || []).map((c) => ({
    id: c.Id,
    number: c.ChannelNumber || c.Number || '',
    name: c.Name,
    callSign: '',
    hd: false,
    thumb: c.ImageTags?.Primary ? `img:${c.Id}` : '',
  })).sort((a, b) => (parseFloat(a.number) || 9e9) - (parseFloat(b.number) || 9e9) || a.name.localeCompare(b.name));
  liveCache.set(srv.id, { at: Date.now(), channels });
  return channels;
}
export const clearLiveCache = () => { liveCache.clear(); guideCache.clear(); };

const guideCache = new Map(); // `${server}|${from}|${to}|${ids}` -> { at, rows }
/** Guide rows for channels between from and to (ms), in the same shape as Plex's. */
export async function guide(srv, from, to, onlyIds = null) {
  const channels = (await liveChannels(srv)).filter((c) => !onlyIds || onlyIds.includes(c.id));
  if (!channels.length) return [];
  // Round the window so the cache is useful while the guide scrolls.
  const f = Math.floor(from / 1_800_000) * 1_800_000, t = Math.ceil(to / 1_800_000) * 1_800_000;
  const key = `${srv.id}|${f}|${t}|${onlyIds ? onlyIds.join(',') : '*'}`;
  const hit = guideCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows;
  const progs = [];
  for (let i = 0; i < channels.length; i += 40) {
    const j = await call(srv, '/LiveTv/Programs', {
      params: {
        UserId: srv.userId, ChannelIds: channels.slice(i, i + 40).map((c) => c.id).join(','),
        MinEndDate: new Date(f).toISOString(), MaxStartDate: new Date(t).toISOString(),
        SortBy: 'StartDate', Fields: 'Overview,Genres', EnableImages: true, Limit: 5000,
      },
      timeout: 30_000,
    });
    progs.push(...(j.Items || []));
  }
  const byCh = new Map(channels.map((c) => [c.id, []]));
  for (const p of progs) {
    const list = byCh.get(p.ChannelId);
    if (!list) continue;
    list.push({
      start: Date.parse(p.StartDate), stop: Date.parse(p.EndDate),
      title: p.Name, subtitle: p.EpisodeTitle || '', desc: p.Overview || '',
      thumb: p.ImageTags?.Primary ? `img:${p.Id}` : '',
      season: p.ParentIndexNumber ?? null, episode: p.IndexNumber ?? null,
      year: p.ProductionYear || null, contentRating: p.OfficialRating || '',
      genres: (p.Genres || []).slice(0, 3), premiere: !!(p.IsPremiere || p.IsNew),
    });
  }
  const rows = channels.map((c) => ({ ...c, programmes: (byCh.get(c.id) || []).sort((a, b) => a.start - b.start) }));
  if (guideCache.size > 200) guideCache.clear();
  guideCache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Close a live stream (frees the tuner). */
export async function closeLive(srv, liveStreamId) {
  if (!liveStreamId) return;
  await call(srv, '/LiveStreams/Close', { method: 'POST', params: { LiveStreamId: liveStreamId } }).catch(() => {});
}
