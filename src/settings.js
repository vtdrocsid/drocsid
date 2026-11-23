// Runtime settings, edited on the Admin page and saved to DATA_DIR/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as conn from './connections.js';

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
export const VALID = { quality: QUALITY_PRESETS.map((p) => p.id), librarySort: ['title', 'added', 'released'] };

const defaults = {
  superAdminUserIds: [],       // full access incl. libraries & Live TV (in addition to OWNER_USER_IDS)
  adminUserIds: [],            // users, roles, admins, access; no library or Live TV settings
  guildAccess: {},             // Discord server id -> { userIds: [], roleIds: [] } approved in that server
  viewRequiresApproval: false,
  announceInVoiceChat: true,
  librarySections: [],         // empty = all movie/show libraries
  libraryOrder: [],            // library ids in Browse-page order; libraries not listed follow in Plex's order
  librarySort: {},
  serverOrder: [],             // media server ids in Browse order; the first is selected by default             // library id -> default sort: title | added | released

  quality: '1080-8000',        // default for new streams = last quality picked in the player bar
};

let current = { ...defaults };
export let version = 1; // bumps on every save so cached approvals refresh
try {
  current = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch { /* first run */ }

// Before per-server approval there was one list for the single server: move it to that server.
if (current.approvedUserIds || current.approvedRoleIds) {
  const gid = conn.get().legacyGuildId || process.env.DISCORD_GUILD_ID;
  if (gid) {
    if (!current.guildAccess[gid]) {
      current.guildAccess = { ...current.guildAccess, [gid]: { userIds: current.approvedUserIds || [], roleIds: current.approvedRoleIds || [] } };
      console.log(`Moved approved users and roles to server ${gid}`);
    }
    delete current.approvedUserIds;
    delete current.approvedRoleIds;
    try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(current, null, 2)); } catch {}
  }
}

// 0.4.0: Live TV became an on/off entry in the library list ("live" for the first Plex server).
// Installs that had picked libraries keep Live TV on.
if (!current.liveInSections) {
  if (current.librarySections.length && !current.librarySections.includes('live')) current.librarySections = [...current.librarySections, 'live'];
  current.liveInSections = true;
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(current, null, 2)); } catch {}
}

export const settings = () => current;
export const findPreset = (id) => QUALITY_PRESETS.find((p) => p.id === id) || QUALITY_PRESETS.find((p) => p.id === defaults.quality);

// Library ids: Plex section numbers, or "<server id>~<id>" for other servers.
const LIB_ID = /^[A-Za-z0-9~_.:-]{1,120}$/;
const ids = (v) => (Array.isArray(v) ? v : []).map(String).filter((s) => /^\d{5,25}$/.test(s));

/** Validate and save a partial update. */
export function update(patch) {
  const next = { ...current };
  if ('superAdminUserIds' in patch) next.superAdminUserIds = ids(patch.superAdminUserIds);
  if ('adminUserIds' in patch) next.adminUserIds = ids(patch.adminUserIds);
  // Someone is either a super admin or an admin, not both.
  next.adminUserIds = next.adminUserIds.filter((id) => !next.superAdminUserIds.includes(id));
  // Per-server approval: { guildAccess: { <server id>: { userIds?, roleIds? } } }
  if (patch.guildAccess && typeof patch.guildAccess === 'object') {
    next.guildAccess = { ...current.guildAccess };
    for (const [gid, a] of Object.entries(patch.guildAccess)) {
      if (!/^\d{5,25}$/.test(gid) || !a || typeof a !== 'object') continue;
      const was = next.guildAccess[gid] || { userIds: [], roleIds: [] };
      next.guildAccess[gid] = {
        userIds: 'userIds' in a ? ids(a.userIds) : was.userIds,
        roleIds: 'roleIds' in a ? ids(a.roleIds) : was.roleIds,
      };
    }
  }
  if ('librarySections' in patch) next.librarySections = (patch.librarySections || []).map(String);
  if ('serverOrder' in patch) next.serverOrder = (patch.serverOrder || []).map(String).filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id));
  if ('libraryOrder' in patch) next.libraryOrder = (patch.libraryOrder || []).map(String).filter((id) => LIB_ID.test(id));
  if (patch.librarySort && typeof patch.librarySort === 'object') {
    next.librarySort = { ...current.librarySort };
    for (const [id, sort] of Object.entries(patch.librarySort)) {
      if (LIB_ID.test(id) && VALID.librarySort.includes(sort)) next.librarySort[id] = sort;
    }
  }
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
