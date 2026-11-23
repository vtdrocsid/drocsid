// Connections: the public URL, Discord apps (bots) and media servers, set up in the browser
// (setup wizard and Admin → Connections) and saved to DATA_DIR/connections.json.
// Secrets (client secrets, bot tokens, Plex tokens) are encrypted with AES-256-GCM using a
// key kept in DATA_DIR/secret.key, so the JSON file never holds them in plain text.
// On first start of an existing install, everything is imported from the old .env variables.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const dataDir = process.env.DATA_DIR || '/data';
const file = path.join(dataDir, 'connections.json');
const keyFile = path.join(dataDir, 'secret.key');

// ---------- encryption ----------
let key = null;
function getKey() {
  if (key) return key;
  try {
    key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('bad key');
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  }
  return key;
}
export function seal(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
const opened = new Map(); // sealed -> plain, so hot paths (every video segment) don't decrypt again
export function open(sealed) {
  if (!sealed) return '';
  if (!sealed.startsWith('v1:')) return sealed;
  if (opened.has(sealed)) return opened.get(sealed);
  try {
    const b = Buffer.from(sealed.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const plain = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    opened.set(sealed, plain);
    return plain;
  } catch {
    console.error('Could not decrypt a saved secret (was secret.key replaced?)');
    return '';
  }
}

// ---------- store ----------
const blank = () => ({
  publicUrl: '',
  setupComplete: false,
  ownerIds: [],
  discordApps: [], // { id (client id), name, botUser, clientSecret*, botToken*, primary, addedAt }
  mediaServers: [], // { id, type: plex|jellyfin|emby, name, url, token*, userId, machineId, addedAt }
  plexClientId: 'drocsid-' + crypto.randomBytes(6).toString('hex'),
  legacyGuildId: '',
});

let data = null;

function save() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

/** Bring an existing .env-based install across without any clicks. */
function importFromEnv() {
  const e = process.env;
  if (!(e.DISCORD_CLIENT_ID && e.DISCORD_BOT_TOKEN)) return null;
  const d = blank();
  d.publicUrl = (e.PUBLIC_URL || '').replace(/\/$/, '');
  d.ownerIds = (e.OWNER_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  d.discordApps.push({
    id: e.DISCORD_CLIENT_ID, name: 'Drocsid', botUser: '',
    clientSecret: seal(e.DISCORD_CLIENT_SECRET || ''), botToken: seal(e.DISCORD_BOT_TOKEN),
    primary: true, addedAt: Date.now(),
  });
  if (e.PLEX_URL && e.PLEX_TOKEN) {
    d.mediaServers.push({ id: 'plex1', type: 'plex', name: 'Plex', url: e.PLEX_URL.replace(/\/$/, ''), token: seal(e.PLEX_TOKEN), machineId: '', addedAt: Date.now() });
  }
  // Keep the same Plex device identity the old version used, so Plex doesn't see a new device.
  d.plexClientId = 'drocsid-' + crypto.createHash('sha1').update(e.DISCORD_CLIENT_ID).digest('hex').slice(0, 12);
  d.legacyGuildId = e.DISCORD_GUILD_ID || '';
  d.setupComplete = !!(d.publicUrl && d.ownerIds.length && d.mediaServers.length && e.DISCORD_CLIENT_SECRET);
  return d;
}

function load() {
  try {
    data = { ...blank(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    // 0.3.0 kept a single Plex server in plexServers; now every kind of server is in mediaServers.
    if (Array.isArray(data.plexServers)) {
      if (!data.mediaServers.length) data.mediaServers = data.plexServers.map((x) => ({ type: 'plex', userId: '', ...x }));
      delete data.plexServers;
      save();
    }
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error('connections.json unreadable:', e.message); throw e; }
  }
  data = importFromEnv();
  if (data) {
    save();
    console.log(`Imported settings from environment variables into ${file}${data.setupComplete ? '' : ' (setup still needs finishing)'}`);
  } else {
    data = blank();
  }
}
load();

export const get = () => data;
export const isConfigured = () => !!data.setupComplete;

export function update(fn) {
  fn(data);
  save();
  return data;
}

// ---------- convenience ----------
export const apps = () => data.discordApps;
export const app = (id) => data.discordApps.find((a) => a.id === id) || null;
export const primaryApp = () => data.discordApps.find((a) => a.primary) || data.discordApps[0] || null;
export const appSecret = (a) => open(a?.clientSecret);
export const appToken = (a) => open(a?.botToken);

/** Media servers with their tokens decrypted (server side only). */
export const servers = () => data.mediaServers.map((s) => ({ ...s, token: open(s.token) }));
export const server = (id) => servers().find((s) => s.id === id) || null;
/** The first Plex server: Live TV comes from here, and plain (unprefixed) item keys belong to it. */
export const plexServer = () => servers().find((s) => s.type === 'plex') || null;

/** Safe to send to a browser: no secrets, just whether they are set. */
export function publicView() {
  return {
    publicUrl: data.publicUrl,
    setupComplete: data.setupComplete,
    ownerIds: data.ownerIds,
    discordApps: data.discordApps.map((a) => ({
      id: a.id, name: a.name, botUser: a.botUser, primary: !!a.primary, addedAt: a.addedAt,
      hasSecret: !!a.clientSecret, hasToken: !!a.botToken,
    })),
    mediaServers: data.mediaServers.map((s) => ({ id: s.id, type: s.type, name: s.name, url: s.url, machineId: s.machineId, hasToken: !!s.token, username: s.username || '' })),
  };
}
