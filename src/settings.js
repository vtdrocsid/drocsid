// Runtime settings, edited on the Admin page and saved to DATA_DIR/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'settings.json');

export const VALID = {
  // Plex source: which version of a title Plex reads when an item has several.
  sourceMaxResolution: ['highest', '2160', '1080', '720', '480'],
  // Activity output: what Plex transcodes to for viewers. "original" = direct stream when the browser can play it.
  outputResolution: ['original', '3840x2160', '1920x1080', '1280x720', '854x480'],
};

const defaults = {
  adminUserIds: [],            // in addition to OWNER_USER_IDS
  approvedUserIds: [],
  approvedRoleIds: [],
  viewRequiresApproval: false,
  announceInVoiceChat: true,
  librarySections: [],         // empty = all movie/show libraries

  sourceMaxResolution: 'highest',
  outputResolution: '1920x1080',
  outputBitrate: 8000,         // kbps, ignored when outputResolution is "original"
};

let current = { ...defaults };
export let version = 1; // bumps on every save so cached approvals refresh
try {
  current = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch { /* first run */ }

export const settings = () => current;

const ids = (v) => (Array.isArray(v) ? v : []).map(String).filter((s) => /^\d{5,25}$/.test(s));

/** Validate and save a partial update. */
export function update(patch) {
  const next = { ...current };
  if ('adminUserIds' in patch) next.adminUserIds = ids(patch.adminUserIds);
  if ('approvedUserIds' in patch) next.approvedUserIds = ids(patch.approvedUserIds);
  if ('approvedRoleIds' in patch) next.approvedRoleIds = ids(patch.approvedRoleIds);
  if ('librarySections' in patch) next.librarySections = (patch.librarySections || []).map(String);
  if ('viewRequiresApproval' in patch) next.viewRequiresApproval = !!patch.viewRequiresApproval;
  if ('announceInVoiceChat' in patch) next.announceInVoiceChat = !!patch.announceInVoiceChat;
  if (VALID.sourceMaxResolution.includes(patch.sourceMaxResolution)) next.sourceMaxResolution = patch.sourceMaxResolution;
  if (VALID.outputResolution.includes(patch.outputResolution)) next.outputResolution = patch.outputResolution;
  if ('outputBitrate' in patch) next.outputBitrate = Math.min(80000, Math.max(500, Number(patch.outputBitrate) || 8000));
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  current = next;
  version++;
  return current;
}
