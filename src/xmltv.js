// Reads the XMLTV guide file directly (the same one Plex uses).
// Plex merges airings that share a title and date ("NFL Football" on FOX at 1:00 and on CBS at 4:25
// become one programme with one description). The XMLTV file has the right details for each airing:
// sub-title (the matchup), description, poster, episode number, rating, new/live flags.
import { settings } from './settings.js';

const REFRESH_MS = 30 * 60_000;
let cache = { at: 0, url: '', channels: new Map(), byChannel: new Map(), count: 0, error: '' };
let loading = null;

const ent = (s = '') => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (s, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s); return m ? ent(m[1]) : ''; };
const text = (s, tag) => { const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(s); return m ? ent(m[1].trim()) : ''; };
const texts = (s, tag) => [...s.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => ent(m[1].trim()));

/** "20261122212500 +0000" -> ms */
function xmltvTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(v || '');
  if (!m) return 0;
  const [, y, mo, d, h, mi, se = '00', tz = '+0000'] = m;
  const off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - off * 60_000;
}

// Categories that describe the listing type rather than the genre.
const NOT_GENRES = new Set(['episode', 'series', 'sports event', 'sports non-event', 'team event', 'movie', 'special', 'show']);

function parse(xml) {
  const channels = new Map(); // id -> [display names]
  for (const m of xml.matchAll(/<channel\s[^>]*>[\s\S]*?<\/channel>/g)) {
    channels.set(attr(m[0], 'id'), texts(m[0], 'display-name').map((n) => n.toLowerCase()));
  }
  const byChannel = new Map(); // channel id -> programmes sorted by start
  let count = 0;
  for (const m of xml.matchAll(/<programme\s[^>]*>[\s\S]*?<\/programme>/g)) {
    const p = m[0];
    const head = p.slice(0, p.indexOf('>'));
    const ch = attr(head, 'channel');
    const onscreen = /<episode-num[^>]*system="onscreen"[^>]*>([^<]*)</.exec(p);
    const icon = /<icon\s[^>]*src="([^"]*)"/.exec(p);
    const rating = /<rating[^>]*>[\s\S]*?<value>([^<]*)<\/value>/.exec(p);
    const prog = {
      start: xmltvTime(attr(head, 'start')),
      stop: xmltvTime(attr(head, 'stop')),
      title: text(p, 'title'),
      subtitle: text(p, 'sub-title'),
      desc: text(p, 'desc'),
      episodeLabel: onscreen ? ent(onscreen[1].trim()) : '',
      thumb: icon ? ent(icon[1]) : '',
      contentRating: rating ? ent(rating[1].trim()) : '',
      genres: texts(p, 'category').filter((c) => !NOT_GENRES.has(c.toLowerCase())).slice(0, 3),
      premiere: /<new\s*\/>|<premiere/.test(p),
      live: /<live\s*\/>/.test(p),
    };
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(prog);
    count++;
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.start - b.start);
  return { channels, byChannel, count };
}

/** The XMLTV URL: the admin's override, or the one in Plex's DVR lineup (lineup://…xmltv/<url>#name). */
export function sourceUrl(plexLineup = '') {
  const own = settings().guideXmltvUrl;
  if (own) return own;
  const m = /xmltv\/([^#]+)/.exec(plexLineup || '');
  if (!m) return '';
  let u = m[1];
  try { u = decodeURIComponent(u); } catch {}
  return /^https?:\/\//i.test(u) ? u : '';
}

async function load(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parse(await res.text());
    cache = { at: Date.now(), url, ...parsed, error: '' };
    console.log(`[xmltv] loaded ${parsed.count} programmes on ${parsed.byChannel.size} channels from ${url}`);
  } catch (e) {
    cache = { ...cache, at: Date.now(), url, error: e.message };
    console.warn(`[xmltv] could not load ${url}: ${e.message}`);
  }
}

/** Make sure the guide file is loaded and fresh. Waits for the first load; later refreshes run in the background. */
export async function ensure(url) {
  if (!url) return false;
  const stale = cache.url !== url || Date.now() - cache.at > REFRESH_MS;
  if (stale && !loading) loading = load(url).finally(() => { loading = null; });
  if (!cache.count || cache.url !== url) await loading;
  return cache.count > 0;
}

export function clear() { cache = { at: 0, url: '', channels: new Map(), byChannel: new Map(), count: 0, error: '' }; }
export function status() { return { url: cache.url, programmes: cache.count, loadedAt: cache.at || null, error: cache.error }; }

/** Find the XMLTV channel id for a Plex channel (by number, identifier, call sign or name). */
function channelId(ch) {
  for (const key of [ch.number, ch.identifier]) if (key && cache.byChannel.has(String(key))) return String(key);
  const names = [ch.callSign, ch.name].filter(Boolean).map((n) => n.toLowerCase());
  for (const [id, dn] of cache.channels) if (dn.some((n) => names.includes(n))) return id;
  return null;
}

/** The XMLTV airing on this channel starting at (about) this time, or null. */
export function airing(ch, start) {
  const id = channelId(ch);
  const list = id && cache.byChannel.get(id);
  if (!list) return null;
  let best = null, gap = 5 * 60_000;
  for (const p of list) {
    const d = Math.abs(p.start - start);
    if (d <= gap) { best = p; gap = d; }
    if (p.start > start + gap) break;
  }
  return best;
}
