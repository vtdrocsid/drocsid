// Lineup: scheduled showings. Saved to DATA_DIR/schedule.json. The runner in server.js starts them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.join(config.dataDir, 'schedule.json');
let items = [];
try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(items, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.warn('schedule save failed:', e.message); }
}

export function add(entry) {
  const item = { id: crypto.randomUUID(), createdAt: Date.now(), reminded: false, ...entry };
  items.push(item);
  items.sort((a, b) => a.at - b.at);
  save();
  return item;
}

export function remove(id) {
  const before = items.length;
  items = items.filter((x) => x.id !== id);
  if (items.length !== before) save();
}

export const get = (id) => items.find((x) => x.id === id);
export const upcoming = () => items.filter((x) => x.at > Date.now() - 60_000).sort((a, b) => a.at - b.at);
export const due = () => items.filter((x) => x.at <= Date.now());
export const needReminder = (ms) => items.filter((x) => !x.reminded && x.at - Date.now() <= ms && x.at > Date.now());
export function markReminded(id) { const x = get(id); if (x) { x.reminded = true; save(); } }

// Drop anything that was due more than an hour ago (e.g. the server was off at the time).
items = items.filter((x) => x.at > Date.now() - 3600_000);
