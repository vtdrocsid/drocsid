// Watch progress per Discord user per title, so people can resume where they left off.
// Saved to DATA_DIR/progress.json as { userId: { ratingKey: { pos, duration, at } } }.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'progress.json');
const MIN_POS = 60;          // under a minute in isn't worth resuming
const DONE_FRACTION = 0.95;  // past 95% (credits) counts as finished
const MAX_PER_USER = 200;
let data = {};
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.warn('progress save failed:', e.message); }
  }, 2000);
}

/** Record how far a user has got in a title (finished titles are cleared). */
export function record(userId, ratingKey, pos, duration) {
  if (!userId || !ratingKey || !duration) return;
  const mine = (data[userId] ||= {});
  if (pos >= duration * DONE_FRACTION) {
    if (mine[ratingKey]) { delete mine[ratingKey]; save(); }
    return;
  }
  if (pos < MIN_POS) return;
  mine[ratingKey] = { pos: Math.floor(pos), duration: Math.floor(duration), at: Date.now() };
  const keys = Object.keys(mine);
  if (keys.length > MAX_PER_USER) {
    keys.sort((a, b) => mine[a].at - mine[b].at).slice(0, keys.length - MAX_PER_USER).forEach((k) => delete mine[k]);
  }
  save();
}

/** Where this user left off in a title, or null. */
export function get(userId, ratingKey) {
  return data[userId]?.[String(ratingKey)] || null;
}

export function clear(userId, ratingKey) {
  if (data[userId]?.[ratingKey]) { delete data[userId][ratingKey]; save(); }
}
