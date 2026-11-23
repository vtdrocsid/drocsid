// Play history: every stream that starts, who started it, and who watched it in the Activity.
// Saved to DATA_DIR/history.json (newest first, capped).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.join(config.dataDir, 'history.json');
const MAX = 300;
let entries = [];
try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(entries));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.warn('history save failed:', e.message); }
  }, 1000);
}

/** Record a new stream; returns its history id. */
export function begin({ item, voiceChannelId, voiceChannelName, startedBy, startedById, scheduled = false }) {
  const entry = {
    id: crypto.randomUUID(),
    title: item.title,
    source: item.source,
    ratingKey: item.ratingKey || null,
    channelId: item.channelId || null,
    thumb: item.thumb || null,
    voiceChannelId,
    voiceChannelName,
    startedBy,
    startedById,
    scheduled,
    startedAt: Date.now(),
    endedAt: null,
    watchers: [],
  };
  entries.unshift(entry);
  if (entries.length > MAX) entries.length = MAX;
  save();
  return entry.id;
}

/** Live TV: remember the programme that was on when the stream started (title, sub-title, poster). */
export function setProgram(id, { program, subtitle, programThumb }) {
  const e = id && entries.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, { program: program || null, subtitle: subtitle || null, programThumb: programThumb || null });
  save();
}
export const get = (id) => entries.find((x) => x.id === id) || null;

export function addWatcher(id, name) {
  const e = id && entries.find((x) => x.id === id);
  if (!e || e.watchers.includes(name)) return;
  e.watchers.push(name);
  save();
}

export function end(id) {
  const e = id && entries.find((x) => x.id === id);
  if (!e || e.endedAt) return;
  e.endedAt = Date.now();
  save();
}

export const list = (limit = 30) => entries.slice(0, limit);

// Streams still marked open from before a restart can't be playing any more.
for (const e of entries) if (!e.endedAt) e.endedAt = e.startedAt;
