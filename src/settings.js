// Runtime settings, edited on the Admin page and saved to DATA_DIR/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'settings.json');

// Plex's standard quality presets (same list Plex apps offer). One setting for every stream.
export const QUALITY_PRESETS = [
  { id: 'original', label: 'Original (no conversion)', height: null, resolution: null, bitrate: null },
  { id: '2160-40000', label: '4K · 40 Mbps', height: 2160, resolution: '3840x2160', bitrate: 40000 },
  { id: '2160-30000', label: '4K · 30 Mbps', height: 2160, resolution: '3840x2160', bitrate: 30000 },
  { id: '2160-20000', label: '4K · 20 Mbps', height: 2160, resolution: '3840x2160', bitrate: 20000 },
  { id: '1080-20000', label: '1080p · 20 Mbps', height: 1080, resolution: '1920x1080', bitrate: 20000 },
  { id: '1080-12000', label: '1080p · 12 Mbps', height: 1080, resolution: '1920x1080', bitrate: 12000 },
  { id: '1080-10000', label: '1080p · 10 Mbps', height: 1080, resolution: '1920x1080', bitrate: 10000 },
  { id: '1080-8000', label: '1080p · 8 Mbps', height: 1080, resolution: '1920x1080', bitrate: 8000 },
  { id: '720-4000', label: '720p · 4 Mbps', height: 720, resolution: '1280x720', bitrate: 4000 },
  { id: '720-3000', label: '720p · 3 Mbps', height: 720, resolution: '1280x720', bitrate: 3000 },
  { id: '720-2000', label: '720p · 2 Mbps', height: 720, resolution: '1280x720', bitrate: 2000 },
  { id: '480-1500', label: '480p · 1.5 Mbps', height: 480, resolution: '720x480', bitrate: 1500 },
  { id: '320-720', label: '320p · 720 kbps', height: 320, resolution: '576x320', bitrate: 720 },
];
export const VALID = { quality: QUALITY_PRESETS.map((p) => p.id) };

const defaults = {
  adminUserIds: [],            // in addition to OWNER_USER_IDS
  approvedUserIds: [],
  approvedRoleIds: [],
  viewRequiresApproval: false,
  announceInVoiceChat: true,
  librarySections: [],         // empty = all movie/show libraries

  quality: '1080-8000',        // default for new streams = last quality picked in the player bar
};

let current = { ...defaults };
export let version = 1; // bumps on every save so cached approvals refresh
try {
  current = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch { /* first run */ }

export const settings = () => current;
export const findPreset = (id) => QUALITY_PRESETS.find((p) => p.id === id) || QUALITY_PRESETS.find((p) => p.id === defaults.quality);

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
  if (VALID.quality.includes(patch.quality)) next.quality = patch.quality;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  current = next;
  version++;
  return current;
}
