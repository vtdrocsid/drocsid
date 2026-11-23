// Poster cache on disk (DATA_DIR/cache/posters), for every media server. Posters are served
// from here when present, so browsing doesn't wait on Plex/Jellyfin/Emby and survives restarts.
// Every night at 2:00 (container time zone) the posters of every library that's turned on are
// fetched again: new titles are ready before anyone browses, changed artwork is picked up, and
// posters nobody has needed for a week are removed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as sources from './sources.js';
import { config } from './config.js';

const dir = path.join(config.dataDir, 'cache', 'posters');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const KEEP_DAYS = 7;
const PARALLEL = 6;

const index = new Map(); // hash -> { ext, size, at } (at = last written or used)
try {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([0-9a-f]{40})(\.\w+)$/);
    if (!m) continue;
    const st = fs.statSync(path.join(dir, f));
    index.set(m[1], { ext: m[2], size: st.size, at: st.mtimeMs });
  }
} catch (e) { console.warn('[posters] cache folder unavailable:', e.message); }

const hashOf = (ref, w, h) => crypto.createHash('sha1').update(`${ref}|${w}x${h}`).digest('hex');
const fileOf = (hash, ext) => path.join(dir, hash + ext);

function write(hash, buf, type) {
  const ext = EXT[type] || '.jpg';
  const old = index.get(hash);
  const tmp = fileOf(hash, ext) + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, fileOf(hash, ext));
  if (old && old.ext !== ext) fs.rmSync(fileOf(hash, old.ext), { force: true });
  index.set(hash, { ext, size: buf.length, at: Date.now() });
}

/** Fetch a poster from its media server and save it. Returns { buf, type } or { status }. */
async function fetchAndSave(ref, w, h) {
  const r = await sources.image(ref, w, h);
  if (!r) return { status: 400 };
  if (!r.ok) return { status: r.status };
  const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return { status: 502 };
  try { write(hashOf(ref, w, h), buf, type); } catch (e) { console.warn('[posters] could not save:', e.message); }
  return { buf, type };
}

/** A poster for the browser: { file, type } from disk, { buf, type } freshly fetched, or { status }. */
export async function get(ref, w, h) {
  const hash = hashOf(ref, w, h);
  const hit = index.get(hash);
  if (hit && fs.existsSync(fileOf(hash, hit.ext))) {
    if (Date.now() - hit.at > 86400_000) { // note that it's still used (once a day is enough)
      hit.at = Date.now();
      fs.utimes(fileOf(hash, hit.ext), new Date(), new Date(), () => {});
    }
    return { file: fileOf(hash, hit.ext), type: TYPE[hit.ext] || 'image/jpeg' };
  }
  return fetchAndSave(ref, w, h);
}

// ---------------- nightly refresh ----------------
let running = null;
let last = null;      // { at, ms, posters, fetched, failed, removed }
let nextAt = null;
let progress = null;  // { done, total } while running

export function status() {
  let bytes = 0;
  for (const v of index.values()) bytes += v.size;
  return {
    files: index.size, bytes, running: !!running, progress, last, next: nextAt,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Fetch every poster of every library that's turned on, then drop ones unused for a week. */
export function refreshAll(reason = 'nightly') {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const refs = new Set();
    try {
      const libs = (await sources.libraries()).filter((l) => l.type !== 'live');
      for (const l of libs) {
        for (let start = 0; ; start += 200) {
          const page = await sources.libraryItems(l.id, { start, size: 200, sort: 'title' }).catch((e) => {
            console.warn(`[posters] ${l.title}: ${e.message}`);
            return { items: [], total: 0 };
          });
          page.items.forEach((x) => x.thumb && refs.add(x.thumb));
          if (!page.items.length || start + page.items.length >= page.total) break;
        }
      }
    } catch (e) { console.warn('[posters] could not list libraries:', e.message); }
    const list = [...refs];
    console.log(`[posters] ${reason} refresh: ${list.length} posters`);
    let fetched = 0, failed = 0;
    progress = { done: 0, total: list.length };
    await mapLimit(list, PARALLEL, async (ref) => {
      const r = await fetchAndSave(ref, 300, 450).catch(() => ({ status: 500 }));
      if (r.buf) fetched++; else failed++;
      progress.done++;
    });
    // Remove posters not written or used for a week (other sizes, removed titles, old artwork).
    let removed = 0;
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const [hash, v] of index) {
      if (v.at >= cutoff) continue;
      fs.rmSync(fileOf(hash, v.ext), { force: true });
      index.delete(hash);
      removed++;
    }
    last = { at: started, ms: Date.now() - started, reason, posters: list.length, fetched, failed, removed };
    console.log(`[posters] done in ${Math.round(last.ms / 1000)} s: ${fetched} saved, ${failed} failed, ${removed} removed`);
  })().finally(() => { running = null; progress = null; });
  return running;
}

/** Remove every saved poster (they're fetched again as people browse, or at the next refresh). */
export function clear() {
  for (const [hash, v] of index) fs.rmSync(fileOf(hash, v.ext), { force: true });
  index.clear();
}

function scheduleNext() {
  const n = new Date();
  n.setHours(2, 0, 0, 0);
  if (n.getTime() <= Date.now()) n.setDate(n.getDate() + 1);
  nextAt = n.getTime();
  setTimeout(() => { refreshAll('nightly').finally(scheduleNext); }, nextAt - Date.now()).unref();
}
scheduleNext();
