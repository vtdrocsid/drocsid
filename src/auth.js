import crypto from 'node:crypto';
import { config } from './config.js';
import { settings } from './settings.js';

let discordClient = null;
export const setClient = (c) => { discordClient = c; };

/** Super admins (owners + promoted users) can change everything, including libraries and Live TV. */
export function isSuperAdmin(userId) {
  return config.ownerIds.includes(userId) || (settings().superAdminUserIds || []).includes(userId);
}
/** Any admin: super admins plus regular admins (users, roles, admins and access settings only). */
export function isAdmin(userId) {
  return isSuperAdmin(userId) || settings().adminUserIds.includes(userId);
}

/** True if the user may browse and control content. Admins are always approved. */
export async function isApproved(userId, guildId = config.guildId) {
  const s = settings();
  if (isAdmin(userId) || s.approvedUserIds.includes(userId)) return true;
  if (!s.approvedRoleIds.length) return false;
  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.roles.cache.some((r) => s.approvedRoleIds.includes(r.id));
  } catch {
    return false;
  }
}

/** Roles and members of the server, for the Admin page pickers. Cached: Discord rate-limits full member fetches. */
let dirCache = { at: 0, data: null };
export async function guildDirectory(guildId = config.guildId) {
  if (dirCache.data && Date.now() - dirCache.at < 5 * 60_000) return dirCache.data;
  const guild = await discordClient.guilds.fetch(guildId);
  const roles = (await guild.roles.fetch())
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  let members = dirCache.data?.members || [];
  try {
    members = (await guild.members.fetch({ time: 15_000 }))
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username, avatar: m.displayAvatarURL({ size: 64 }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.warn('Member list unavailable:', e.message);
  }
  dirCache = { at: Date.now(), data: { roles, members } };
  return dirCache.data;
}

export async function lookupUser(userId) {
  try {
    const u = await discordClient.users.fetch(userId);
    return { id: u.id, name: u.globalName || u.username, username: u.username, avatar: u.displayAvatarURL({ size: 64 }) };
  } catch { return { id: userId, name: 'Unknown user', username: '', avatar: '' }; }
}

/** Voice channels in the server, with who is in them. */
export function voiceChannels(guildId = config.guildId) {
  const guild = discordClient?.guilds.cache.get(guildId);
  if (!guild) return [];
  return guild.channels.cache
    .filter((c) => c.isVoiceBased())
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name, members: c.members.map((m) => m.displayName) }));
}

/** Text channels the bot can post in, for "now playing" announcements. */
export function textChannels(guildId = config.guildId) {
  const guild = discordClient?.guilds.cache.get(guildId);
  const me = guild?.members.me;
  if (!guild || !me) return [];
  return guild.channels.cache
    .filter((c) => (c.type === 0 || c.type === 5) && c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']))
    .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name || '' }));
}

/** Display name + avatar for a member, from the gateway cache (no API call). */
export function memberCard(userId, fallbackName = '', guildId = config.guildId) {
  const m = discordClient?.guilds.cache.get(guildId)?.members.cache.get(userId);
  return { id: userId, name: m?.displayName || fallbackName, avatar: m ? m.displayAvatarURL({ size: 64 }) : null };
}

export function logout(token) { sessions.delete(token); }

/** The voice channel the user is currently sitting in, or null. */
export function voiceChannelOf(userId, guildId = config.guildId) {
  const guild = discordClient?.guilds.cache.get(guildId);
  return guild?.voiceStates.cache.get(userId)?.channelId || null;
}

// ---- Activity sessions (opaque bearer tokens handed to the embedded player) ----
const sessions = new Map(); // token -> { userId, username, expires }

export function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, username: user.global_name || user.username, expires: Date.now() + 12 * 3600_000 });
  return token;
}

export function getSession(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

setInterval(() => {
  for (const [t, s] of sessions) if (s.expires < Date.now()) sessions.delete(t);
}, 3600_000).unref();

/** Exchange the Activity's OAuth code for a Discord user. */
export async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
  });
  if (redirectUri) body.set('redirect_uri', redirectUri); // web login; the Activity flow has none
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`OAuth exchange failed (${res.status})`);
  const { access_token } = await res.json();
  const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
  if (!me.ok) throw new Error('Could not read Discord user');
  return { access_token, user: await me.json() };
}
