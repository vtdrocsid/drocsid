import crypto from 'node:crypto';
import { config } from './config.js';
import { settings } from './settings.js';
import * as conn from './connections.js';

import * as discord from './discord.js';

/** Super admins (owners + promoted users) can change everything, including libraries, Live TV and connections. */
export function isSuperAdmin(userId) {
  return config.ownerIds.includes(userId) || (settings().superAdminUserIds || []).includes(userId);
}
/** Any admin: super admins plus regular admins (users, roles, admins and access settings only). */
export function isAdmin(userId) {
  return isSuperAdmin(userId) || settings().adminUserIds.includes(userId);
}

/** Who is approved in one Discord server: { userIds, roleIds }. */
export const accessFor = (guildId) => settings().guildAccess?.[guildId] || { userIds: [], roleIds: [] };

/** True if the user may browse and start streams in this server. Admins are approved everywhere. */
export async function isApproved(userId, guildId) {
  if (isAdmin(userId)) return true;
  if (!guildId) return (await approvedGuilds(userId)).length > 0;
  const a = accessFor(guildId);
  if (a.userIds.includes(userId)) return true;
  if (!a.roleIds.length) return false;
  const guild = discord.guild(guildId);
  if (!guild) return false;
  try {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
    return member.roles.cache.some((r) => a.roleIds.includes(r.id));
  } catch {
    return false;
  }
}

/** Every server (with a drocsid bot in it) where the user is approved. */
export async function approvedGuilds(userId) {
  const ids = discord.guilds().map((g) => g.guild.id);
  if (isAdmin(userId)) return ids;
  const out = [];
  for (const id of ids) if (await isApproved(userId, id)) out.push(id);
  return out;
}

/** Servers the bots are in, for the Admin page. */
export function guildList() {
  return discord.guilds().map(({ guild: g, appIds }) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), appIds }));
}

/** Roles and members of a server, for the Admin page pickers. Cached: Discord rate-limits full member fetches. */
const dirCache = new Map(); // guildId -> { at, data }
export async function guildDirectory(guildId) {
  const hit = dirCache.get(guildId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
  const guild = discord.guild(guildId);
  if (!guild) return { roles: [], members: [] };
  const roles = (await guild.roles.fetch())
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  let members = hit?.data.members || [];
  try {
    members = (await guild.members.fetch({ time: 15_000 }))
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username, avatar: m.displayAvatarURL({ size: 64 }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.warn(`Member list for ${guild.name} unavailable:`, e.message);
  }
  const data = { roles, members };
  dirCache.set(guildId, { at: Date.now(), data });
  return data;
}

export async function lookupUser(userId) {
  try {
    const u = await discord.anyClient().users.fetch(userId);
    return { id: u.id, name: u.globalName || u.username, username: u.username, avatar: u.displayAvatarURL({ size: 64 }) };
  } catch { return { id: userId, name: 'Unknown user', username: '', avatar: '' }; }
}

/** Voice channels in the given servers (default: all), with who is in them. */
export function voiceChannels(guildIds = null) {
  return discord.guilds()
    .filter(({ guild }) => !guildIds || guildIds.includes(guild.id))
    .flatMap(({ guild }) => guild.channels.cache
      .filter((c) => c.isVoiceBased())
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name, guildId: guild.id, guildName: guild.name, members: c.members.map((m) => m.displayName) })));
}

/** Text channels a bot can post in, for "now playing" announcements. */
export function textChannels(guildIds = null) {
  return discord.guilds()
    .filter(({ guild }) => !guildIds || guildIds.includes(guild.id))
    .flatMap(({ guild }) => {
      const me = guild.members.me;
      if (!me) return [];
      return guild.channels.cache
        .filter((c) => (c.type === 0 || c.type === 5) && c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']))
        .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name || '', guildId: guild.id, guildName: guild.name }));
    });
}

/** Display name + avatar for a member, from the gateway cache (no API call). */
export function memberCard(userId, fallbackName = '', guildId = null) {
  const guilds = guildId ? [discord.guild(guildId)] : discord.guilds().map((g) => g.guild);
  for (const g of guilds) {
    const m = g?.members.cache.get(userId);
    if (m) return { id: userId, name: m.displayName, avatar: m.displayAvatarURL({ size: 64 }) };
  }
  return { id: userId, name: fallbackName, avatar: null };
}

export function logout(token) { sessions.delete(token); }

/** The voice channel the user is currently sitting in, or null. */
export function voiceChannelOf(userId) {
  for (const { guild } of discord.guilds()) {
    const id = guild.voiceStates.cache.get(userId)?.channelId;
    if (id) return id;
  }
  return null;
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

/** Exchange an OAuth code for a Discord user. appId picks which Discord app's Activity it came from. */
export async function exchangeCode(code, redirectUri, appId = null) {
  const app = (appId && conn.app(appId)) || conn.primaryApp();
  if (!app) throw Object.assign(new Error('No Discord app is set up yet'), { status: 503 });
  const body = new URLSearchParams({
    client_id: app.id,
    client_secret: conn.appSecret(app),
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
