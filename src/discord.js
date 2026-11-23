// Discord bot manager: one discord.js client per Discord app (bot). Each bot serves every
// server (guild) it has been invited to. Apps can be added, changed or removed at runtime.
import { Client, GatewayIntentBits, Events } from 'discord.js';
import crypto from 'node:crypto';
import * as conn from './connections.js';

const bots = new Map(); // app id -> { client, tokenHash, status: 'starting'|'online'|'error', error, user }
const hooks = [];       // functions called with every new client, to attach event handlers

/** Register handlers that should be attached to every bot (now and in the future). */
export function onClient(fn) {
  hooks.push(fn);
  for (const b of bots.values()) fn(b.client);
}

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function startOne(app) {
  const token = conn.appToken(app);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
  const bot = { client, tokenHash: hash(token || ''), status: 'starting', error: '', user: null, appId: app.id };
  bots.set(app.id, bot);
  client.once(Events.ClientReady, (c) => {
    bot.status = 'online';
    bot.user = { id: c.user.id, tag: c.user.tag, avatar: c.user.displayAvatarURL({ size: 64 }) };
    console.log(`Discord bot ${c.user.tag} online in ${c.guilds.cache.size} server(s): ${c.guilds.cache.map((g) => g.name).join(', ') || 'none yet'}`);
    if (app.botUser !== c.user.tag) conn.update((d) => { const a = d.discordApps.find((x) => x.id === app.id); if (a) a.botUser = c.user.tag; });
  });
  client.on(Events.GuildCreate, (g) => console.log(`Bot ${client.user?.tag} joined server ${g.name}`));
  client.on(Events.GuildDelete, (g) => console.log(`Bot ${client.user?.tag} left server ${g.name || g.id}`));
  client.on(Events.Error, (e) => console.warn(`Discord client error (${app.id}):`, e.message));
  for (const fn of hooks) fn(client);
  if (!token) { bot.status = 'error'; bot.error = 'No bot token saved'; return; }
  try {
    await client.login(token);
  } catch (e) {
    bot.status = 'error';
    bot.error = /disallowed intents/i.test(e.message)
      ? 'Server Members Intent is off. Turn it on under Bot → Privileged Gateway Intents.'
      : e.message;
    console.error(`Discord bot for app ${app.id} could not sign in: ${bot.error}`);
  }
}

/** Start, restart or stop bots so they match the saved Discord apps. */
export async function sync() {
  const apps = conn.apps();
  for (const [id, b] of bots) {
    const app = apps.find((a) => a.id === id);
    if (!app || hash(conn.appToken(app) || '') !== b.tokenHash) {
      bots.delete(id);
      try { await b.client.destroy(); } catch {}
    }
  }
  await Promise.all(apps.filter((a) => !bots.has(a.id)).map(startOne));
}

/** Reconnect one bot (after its settings changed on Discord's side). */
export async function restart(appId) {
  const b = bots.get(appId);
  if (b) { bots.delete(appId); try { await b.client.destroy(); } catch {} }
  await sync();
}

/** Status of every bot, for the admin page. */
export function status(appId) {
  const b = bots.get(appId);
  if (!b) return { status: 'stopped', error: '', user: null, guilds: [] };
  return {
    status: b.status, error: b.error, user: b.user,
    guilds: b.status === 'online' ? b.client.guilds.cache.map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) })) : [],
  };
}

const online = () => {
  // Primary app's bot first, so it's preferred when several bots share a server.
  const primary = conn.primaryApp()?.id;
  return [...bots.values()].filter((b) => b.status === 'online').sort((a, b) => (b.appId === primary) - (a.appId === primary));
};

/** Every server any bot is in (each listed once). */
export function guilds() {
  const seen = new Map();
  for (const b of online()) {
    for (const g of b.client.guilds.cache.values()) {
      if (!seen.has(g.id)) seen.set(g.id, { guild: g, appIds: [] });
      seen.get(g.id).appIds.push(b.appId);
    }
  }
  return [...seen.values()];
}

/** A cached Guild object, from whichever bot is in it. */
export function guild(guildId) {
  for (const b of online()) {
    const g = b.client.guilds.cache.get(guildId);
    if (g) return g;
  }
  return null;
}

/** A cached channel from whichever bot can see it. */
export function channel(channelId) {
  for (const b of online()) {
    const c = b.client.channels.cache.get(channelId);
    if (c) return c;
  }
  return null;
}

/** Any online client (for user lookups that don't depend on a server). */
export const anyClient = () => online()[0]?.client || null;

// ---------- checks used by the setup wizard and Admin → Connections ----------
const API = 'https://discord.com/api/v10';
const FLAG_MEMBERS = 1 << 14, FLAG_MEMBERS_LIMITED = 1 << 15, FLAG_EMBEDDED = 1 << 17;

/**
 * Check a Discord app's details before saving: bot token, client secret, Server Members
 * intent, Activities and the web sign-in redirect. Returns a list of checks plus app info.
 */
export async function testApp({ clientId, clientSecret, botToken, redirectUri }) {
  const checks = [];
  const add = (id, ok, label, hint = '') => checks.push({ id, ok, label, hint });
  let appInfo = null;

  if (!/^\d{15,25}$/.test(clientId || '')) add('id', false, 'Application ID', 'Copy the Application ID from General Information.');

  if (botToken) {
    const r = await fetch(`${API}/applications/@me`, { headers: { Authorization: `Bot ${botToken}` } }).catch(() => null);
    if (!r?.ok) {
      add('token', false, 'Bot token', r?.status === 401 ? 'Discord rejected the token. Use Bot → Reset Token and paste the new one.' : 'Could not reach Discord.');
    } else {
      appInfo = await r.json();
      if (clientId && appInfo.id !== clientId) {
        add('token', false, 'Bot token', 'This token belongs to a different application.');
      } else {
        add('token', true, `Bot token works (${appInfo.bot?.username || appInfo.name})`);
        const flags = appInfo.flags || 0;
        add('members', !!(flags & (FLAG_MEMBERS | FLAG_MEMBERS_LIMITED)), 'Server Members Intent',
          'Turn on Bot → Privileged Gateway Intents → Server Members Intent, then save.');
        add('activity', !!(flags & FLAG_EMBEDDED), 'Activities enabled',
          'Open Activities → Settings and turn on “Enable Activities”.');
        if (Array.isArray(appInfo.redirect_uris) && redirectUri) {
          add('redirect', appInfo.redirect_uris.includes(redirectUri), 'Sign-in redirect',
            `Add ${redirectUri} under OAuth2 → Redirects, then save.`);
        }
      }
    }
  } else {
    add('token', false, 'Bot token', 'Paste the bot token from the Bot page.');
  }

  if (clientSecret) {
    const r = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }),
    }).catch(() => null);
    add('secret', !!r?.ok, 'Client secret', r?.ok ? '' : 'Discord rejected the secret. Use OAuth2 → Reset Secret and paste the new one.');
  } else {
    add('secret', false, 'Client secret', 'Paste the client secret from OAuth2.');
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    app: appInfo ? { id: appInfo.id, name: appInfo.name, bot: appInfo.bot?.username || '' } : null,
  };
}

/** Turn on the Server Members intent for the app (allowed for apps in fewer than 100 servers). */
export async function enableMembersIntent(botToken) {
  const me = await fetch(`${API}/applications/@me`, { headers: { Authorization: `Bot ${botToken}` } });
  if (!me.ok) throw new Error('Bot token not accepted');
  const { flags = 0 } = await me.json();
  const r = await fetch(`${API}/applications/@me`, {
    method: 'PATCH',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ flags: (flags & (FLAG_MEMBERS_LIMITED | (1 << 13) | (1 << 19))) | FLAG_MEMBERS_LIMITED }),
  });
  if (!r.ok) throw new Error('Discord would not change it here. Turn it on in the Developer Portal instead.');
}

/** The link that adds a bot to a server. Permissions: view channels, send messages, embed links, attach files, read history. */
export const inviteUrl = (clientId, guildId) => {
  const u = new URL('https://discord.com/oauth2/authorize');
  u.search = new URLSearchParams({ client_id: clientId, scope: 'bot', permissions: '117760', integration_type: '0', ...(guildId ? { guild_id: guildId } : {}) });
  return u.toString();
};
