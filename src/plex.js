// Everything Plex: libraries, metadata, Live TV (DVR tuner + guide) and the universal transcoder.
// No media is processed here — Plex does all tuning and transcoding; we only proxy its HLS output.
import crypto from 'node:crypto';
import { config } from './config.js';
import { settings } from './settings.js';

const CLIENT_ID = 'drocsid-' + crypto.createHash('sha1').update(config.clientId).digest('hex').slice(0, 12);

const baseHeaders = {
  Accept: 'application/json',
  'X-Plex-Token': config.plexToken,
  'X-Plex-Client-Identifier': CLIENT_ID,
  'X-Plex-Product': 'Drocsid',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Device': 'Discord Activity',
  'X-Plex-Device-Name': 'Drocsid',
  'X-Plex-Platform': 'Chrome',
};

async function plexFetch(path, { params = {}, method = 'GET', headers = {} } = {}) {
  const url = new URL(config.plexUrl + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers: { ...baseHeaders, ...headers } });
  if (!res.ok) throw Object.assign(new Error(`Plex ${res.status} on ${path}`), { status: res.status });
  return res;
}
const plexGet = async (path, params) => (await plexFetch(path, { params })).json();

// ---------------- library ----------------
function toItem(m) {
  const kind = m.type; // movie | show | season | episode
  let label = m.title;
  if ((kind === 'movie' || kind === 'show') && m.year) label += ` (${m.year})`;
  if (kind === 'season') label = `${m.parentTitle ? m.parentTitle + ' — ' : ''}${m.title}`;
  if (kind === 'episode') {
    const se = `S${String(m.parentIndex ?? 0).padStart(2, '0')}E${String(m.index ?? 0).padStart(2, '0')}`;
    label = `${m.grandparentTitle ? m.grandparentTitle + ' ' : ''}${se} — ${m.title}`;
  }
  return {
    source: 'plex',
    kind,
    ratingKey: m.ratingKey,
    title: label,
    shortTitle: m.title,
    titleSort: m.titleSort || m.title,
    year: m.year,
    summary: m.summary || '',
    contentRating: m.contentRating || '',
    index: m.index,
    thumb: m.thumb || m.parentThumb || m.grandparentThumb || null,
    art: m.art || null,
    duration: m.duration ? m.duration / 1000 : 0, // seconds
    leafCount: m.leafCount,
    childCount: m.childCount,
    // Rotten Tomatoes scores, present when the library's ratings source is Rotten Tomatoes.
    rt: rtScore(m),
  };
}

/** Tomatometer (critics) or, failing that, audience score: { kind, score, fresh } or null. */
function rtScore(m) {
  const pct = (v) => Math.round(Number(v) * 10);
  if (typeof m.ratingImage === 'string' && m.ratingImage.startsWith('rottentomatoes://') && m.rating != null) {
    return { kind: 'critic', score: pct(m.rating), fresh: !/rotten/.test(m.ratingImage) };
  }
  if (typeof m.audienceRatingImage === 'string' && m.audienceRatingImage.startsWith('rottentomatoes://') && m.audienceRating != null) {
    return { kind: 'audience', score: pct(m.audienceRating), fresh: !/spilled/.test(m.audienceRatingImage) };
  }
  return null;
}

export async function libraries({ all = false } = {}) {
  const data = await plexGet('/library/sections');
  const { librarySections: allowed, libraryOrder: order, librarySort: sorts } = settings();
  const rank = (id) => { const i = order.indexOf(id); return i === -1 ? 1e6 : i; };
  return (data.MediaContainer?.Directory || [])
    .filter((d) => ['movie', 'show'].includes(d.type))
    .filter((d) => all || !allowed.length || allowed.includes(String(d.key)))
    .map((d, i) => ({ id: String(d.key), title: d.title, type: d.type, defaultSort: sorts[String(d.key)] || 'title', plexIndex: i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.plexIndex - b.plexIndex)
    .map(({ plexIndex, ...l }) => l);
}

const SORTS = { title: 'titleSort', added: 'addedAt:desc', year: 'year:desc', released: 'originallyAvailableAt:desc' };

export async function libraryItems(sectionId, { start = 0, size = 60, sort = 'title' } = {}) {
  const allowed = settings().librarySections;
  if (allowed.length && !allowed.includes(String(sectionId))) throw new Error('Library not allowed');
  const data = await plexGet(`/library/sections/${encodeURIComponent(sectionId)}/all`, {
    sort: SORTS[sort] || SORTS.title,
    'X-Plex-Container-Start': start,
    'X-Plex-Container-Size': size,
  });
  const mc = data.MediaContainer || {};
  return { total: mc.totalSize ?? mc.size ?? 0, items: (mc.Metadata || []).map(toItem) };
}

/** How many titles start with each character, in A–Z sort order (for the letter jump bar). */
export async function libraryLetters(sectionId) {
  const allowed = settings().librarySections;
  if (allowed.length && !allowed.includes(String(sectionId))) throw new Error('Library not allowed');
  const data = await plexGet(`/library/sections/${encodeURIComponent(sectionId)}/firstCharacter`);
  return (data.MediaContainer?.Directory || []).map((d) => ({ key: String(d.key ?? d.title), title: String(d.title ?? d.key), size: Number(d.size) || 0 }));
}

export async function search(query) {
  const data = await plexGet('/hubs/search', { query, limit: 10, includeCollections: 0 });
  const items = [];
  for (const hub of data.MediaContainer?.Hub || []) {
    for (const m of hub.Metadata || []) if (['movie', 'show', 'season', 'episode'].includes(m.type)) items.push(toItem(m));
  }
  const order = { movie: 0, show: 0, season: 1, episode: 2 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 40);
}

export async function children(ratingKey) {
  const data = await plexGet(`/library/metadata/${ratingKey}/children`);
  return (data.MediaContainer?.Metadata || []).map(toItem);
}

export async function metadata(ratingKey) {
  const data = await plexGet(`/library/metadata/${ratingKey}`);
  const m = data.MediaContainer?.Metadata?.[0];
  if (!m) throw new Error('Item not found in Plex');
  return toItem(m);
}

/** Resized image from Plex (posters, art, channel logos). */
/**
 * Hover-card details: tagline, genres, director(s) and top-billed cast.
 * Actor photos are usually hosted by Plex's metadata service, so callers get an opaque face id
 * (see faceUrl) instead of a raw URL; only photos Plex actually returned can be fetched.
 */
const faces = new Map(); // id -> photo url
export function faceUrl(id) { return faces.get(id) || null; }
function faceId(url) {
  if (!url) return null;
  const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  if (faces.size > 5000) faces.clear();
  faces.set(id, url);
  return id;
}
export async function info(ratingKey) {
  const data = await plexGet(`/library/metadata/${ratingKey}`);
  const m = data.MediaContainer?.Metadata?.[0];
  if (!m) throw new Error('Item not found in Plex');
  const tags = (arr) => (arr || []).map((t) => t.tag).filter(Boolean);
  return {
    ...toItem(m),
    tagline: m.tagline || '',
    studio: m.studio || '',
    genres: tags(m.Genre).slice(0, 4),
    directors: tags(m.Director).slice(0, 2),
    cast: (m.Role || []).slice(0, 10).map((r) => ({ name: r.tag, role: r.role || '', face: faceId(r.thumb) })),
  };
}

export function photoUrl(path, width = 300, height = 450) {
  const url = new URL(config.plexUrl + '/photo/:/transcode');
  url.search = new URLSearchParams({ width, height, minSize: 1, upscale: 1, url: path, 'X-Plex-Token': config.plexToken }).toString();
  return url;
}

// ---------------- Live TV (Plex DVR) ----------------
let liveCache = { at: 0, dvr: null, provider: null, channels: [] };
const guideCache = new Map(); // `${gridKey}|${date}` -> { at, programmes }

/** Find the DVR and its guide provider, then the channel lineup. Cached for 10 minutes. */
async function liveSetup() {
  if (Date.now() - liveCache.at < 10 * 60_000 && liveCache.dvr) return liveCache;
  const dvrs = await plexGet('/livetv/dvrs');
  const list = dvrs.MediaContainer?.Dvr || dvrs.MediaContainer?.DVR || [];
  const dvr = list[0];
  if (!dvr) throw new Error('No Plex DVR is set up, so Live TV is unavailable.');

  // Guide provider id looks like "tv.plex.providers.epg.xmltv:12".
  const providers = await plexGet('/media/providers');
  const epgProviders = (providers.MediaContainer?.MediaProvider || [])
    .map((p) => p.identifier)
    .filter((id) => id?.startsWith('tv.plex.providers.epg.'));
  const type = (/tv\.plex\.providers\.epg\.(\w+)/.exec(dvr.lineup || '') || [])[1] || 'xmltv';
  const provider = epgProviders.find((id) => id === `tv.plex.providers.epg.${type}:${dvr.key}`)
    || epgProviders.find((id) => id.startsWith(`tv.plex.providers.epg.${type}`))
    || `tv.plex.providers.epg.${type}:${dvr.key}`;

  const ch = await plexGet(`/${provider}/lineups/dvr/channels`);
  const channels = (ch.MediaContainer?.Channel || []).map((c) => ({
    id: String(c.id || c.gridKey || c.vcn),
    gridKey: c.gridKey,
    number: c.vcn || '',
    name: c.title || c.callSign || c.vcn,
    callSign: c.callSign || '',
    hd: !!c.isHd,
    thumb: c.thumb || '',
  })).sort((a, b) => (parseFloat(a.number) || 9e9) - (parseFloat(b.number) || 9e9));

  liveCache = { at: Date.now(), dvr: { key: dvr.key, lineup: dvr.lineup }, provider, channels };
  return liveCache;
}

export function clearLiveCache() { liveCache = { at: 0, dvr: null, provider: null, channels: [] }; guideCache.clear(); }

export async function liveChannels() { return (await liveSetup()).channels; }

export async function liveStatus() {
  try {
    const s = await liveSetup();
    return { available: true, provider: s.provider, channels: s.channels.length };
  } catch (e) { return { available: false, error: e.message }; }
}

export async function liveChannel(id) {
  const c = (await liveChannels()).find((ch) => ch.id === id);
  if (!c) throw new Error('Channel not found');
  return { source: 'live', kind: 'channel', channelId: c.id, number: c.number, title: `${c.number ? c.number + ' ' : ''}${c.name}`, duration: 0, thumb: null };
}

const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function gridFor(provider, gridKey, date) {
  const key = `${gridKey}|${date}`;
  const hit = guideCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.programmes;
  const data = await plexGet(`/${provider}/grid`, { channelGridKey: gridKey, date });
  const programmes = [];
  for (const m of data.MediaContainer?.Metadata || []) {
    for (const media of m.Media || []) {
      if (media.gridKey && media.gridKey !== gridKey) continue;
      programmes.push({
        start: (media.beginsAt || 0) * 1000,
        stop: (media.endsAt || 0) * 1000,
        title: m.grandparentTitle || m.title,
        subtitle: m.grandparentTitle ? m.title : '',
        desc: m.summary || '',
      });
    }
  }
  programmes.sort((a, b) => a.start - b.start);
  guideCache.set(key, { at: Date.now(), programmes });
  return programmes;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]).catch(() => []); }
  }));
  return out;
}

/** Guide rows for every channel between `from` and `to` (ms). One grid call per channel per day, cached. */
export async function guide(from, to, onlyIds = null) {
  const { provider } = await liveSetup();
  const channels = onlyIds ? (await liveSetup()).channels.filter((c) => onlyIds.includes(c.id)) : (await liveSetup()).channels;
  const dates = [...new Set([ymd(from), ymd(to)])];
  const rows = await mapLimit(channels, 8, async (c) => {
    if (!c.gridKey) return [];
    const lists = await Promise.all(dates.map((d) => gridFor(provider, c.gridKey, d)));
    const seen = new Set();
    return lists.flat().filter((p) => p.stop > from && p.start < to && !seen.has(p.start) && seen.add(p.start));
  });
  return channels.map((c, i) => ({ ...c, programmes: rows[i] || [] }));
}

/** Tune a channel on the DVR. Returns the live session's metadata key, which the transcoder plays. */
export async function tune(channel, sessionId) {
  const { dvr } = await liveSetup();
  const id = channel.number || channel.channelId;
  console.log(`[live] tuning DVR ${dvr.key} channel ${id}`);
  const res = await plexFetch(`/livetv/dvrs/${dvr.key}/channels/${encodeURIComponent(id)}/tune`, {
    method: 'POST',
    headers: { 'X-Plex-Session-Identifier': sessionId },
  });
  const data = await res.json();
  // Plex nests the live session differently across versions (Metadata, or
  // MediaSubscription > MediaGrabOperation > Metadata/Video). Search the whole reply for it.
  const session = findLiveSession(data);
  if (!session) {
    console.warn('[live] tune reply had no live session:', JSON.stringify(data).slice(0, 1500));
    throw new Error('Plex accepted the tune but returned no stream. Check the container log for details.');
  }
  return session;
}

/** Find { key: "/livetv/sessions/<id>", ratingKey } anywhere in a tune reply. */
function findLiveSession(node) {
  let best = null, partKey = null;
  const walk = (v) => {
    if (!v || typeof v !== 'object' || best) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v.key === 'string') {
      if (/^\/livetv\/sessions\/[^/]+$/.test(v.key)) { best = { key: v.key, ratingKey: v.ratingKey }; return; }
      if (!partKey && v.key.startsWith('/livetv/sessions/')) partKey = v.key; // a Part like /livetv/sessions/<id>/<n>/index.m3u8
    }
    Object.values(v).forEach(walk);
  };
  walk(node);
  if (best) return best;
  if (partKey) return { key: partKey.split('/').slice(0, 4).join('/'), ratingKey: undefined };
  return null;
}

// ---------------- transcoder ----------------
/**
 * Pick which version (Media index) of a title to read. For "Original" take the best copy;
 * otherwise the smallest copy that still meets the preset's resolution (less work for Plex).
 */
export async function pickMediaIndex(ratingKey, preset) {
  const data = await plexGet(`/library/metadata/${ratingKey}`);
  const media = data.MediaContainer?.Metadata?.[0]?.Media || [];
  if (media.length <= 1) return 0;
  const height = (m) => m.height || ({ '4k': 2160, 1080: 1080, 720: 720, 480: 480, sd: 480 }[String(m.videoResolution).toLowerCase()] || 0);
  const ranked = media.map((m, i) => ({ i, h: height(m), br: m.bitrate || 0 })).sort((a, b) => b.h - a.h || b.br - a.br);
  const target = preset.height;
  if (!target) return ranked[0].i;
  const fits = ranked.filter((r) => r.h >= target);
  return (fits.length ? fits[fits.length - 1] : ranked[0]).i;
}

/**
 * Start a Plex universal-transcoder HLS session using the admin's "Activity output" setting.
 * `path` is a library item (/library/metadata/123) or a tuned live session key.
 * Returns the master playlist rewritten to go through /media/plex.
 */
export async function startTranscode({ path, offset, mediaIndex = 0, sessionId, preset }) {
  const q = preset;
  const original = q.id === 'original';
  const params = {
    path,
    mediaIndex,
    partIndex: 0,
    protocol: 'hls',
    fastSeek: 1,
    copyts: 1,
    directPlay: 0,
    // Browsers in Discord can't reliably decode HEVC/AV1/10-bit, so always transcode to H.264
    // unless the admin picked "Original" (then Plex may pass compatible video through).
    directStream: original ? 1 : 0,
    directStreamAudio: 0, // AAC audio so every browser can play it
    videoQuality: 100,
    videoResolution: original ? '3840x2160' : q.resolution,
    maxVideoBitrate: original ? 200000 : q.bitrate,
    subtitleSize: 100,
    audioBoost: 100,
    location: 'lan',
    session: sessionId,
    offset: offset == null ? undefined : Math.max(0, Math.floor(offset)),
  };
  const res = await plexFetch('/video/:/transcode/universal/start.m3u8', {
    params,
    headers: {
      Accept: '*/*',
      'X-Plex-Session-Identifier': sessionId,
      // Tell Plex this client plays H.264 + AAC in HLS/MPEG-TS, so anything else gets transcoded.
      'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)',
    },
  });
  const text = await res.text();
  // Variant URLs are relative ("session/<id>/base/index.m3u8"); route them through our proxy.
  return text.split('\n').map((line) => (line && !line.startsWith('#') && !/^https?:/.test(line)
    ? `/media/plex/video/:/transcode/universal/${line.trim()}`
    : line)).join('\n');
}

export async function pingTranscode(sessionId) {
  await plexFetch('/video/:/transcode/universal/ping', { params: { session: sessionId } }).catch(() => {});
}

export async function stopTranscode(sessionId) {
  await plexFetch('/video/:/transcode/universal/stop', { params: { session: sessionId } }).catch(() => {});
}

/** Report playback to Plex (shows in its dashboard; "stopped" releases a live tuner). */
export async function timeline({ key, ratingKey, state, timeMs = 0, durationMs = 0, sessionId }) {
  await plexFetch('/:/timeline', {
    params: { key, ratingKey, state, time: Math.floor(timeMs), duration: Math.floor(durationMs), ...(state === 'stopped' ? { continuing: 0 } : {}) },
    headers: { 'X-Plex-Session-Identifier': sessionId },
  }).catch(() => {});
}

/** Proxy target for transcoder playlists/segments, with the token added server-side. */
export function plexProxyUrl(pathAndQuery) {
  const url = new URL(config.plexUrl + pathAndQuery);
  url.searchParams.set('X-Plex-Token', config.plexToken);
  url.searchParams.set('X-Plex-Client-Identifier', CLIENT_ID);
  return url;
}
