// Setup wizard and Admin → Connections: public URL, Discord apps (bots), Plex server.
// Before setup is finished, only the wizard is reachable, and it is unlocked with a one-time
// setup code printed in the container log. Afterwards, only super admins can change connections.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as conn from './connections.js';
import * as discord from './discord.js';
import * as plexSetup from './plexsetup.js';
import * as plex from './plex.js';
import * as jf from './jellyfin.js';
import * as sources from './sources.js';
import * as auth from './auth.js';
import { config } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_COOKIE = 'pc_setup';

// ---------- setup code ----------
let setupCode = null;
const unlocked = new Set(); // setup cookie tokens
let lastLogged = 0;
function code() {
  if (!setupCode) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pick = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
    setupCode = `${pick()}-${pick()}`;
  }
  return setupCode;
}
export function logSetupCode(force = false) {
  if (conn.isConfigured() || (!force && Date.now() - lastLogged < 60_000)) return;
  lastLogged = Date.now();
  console.log('\n' + '='.repeat(52) + `\n  drocsid setup code:  ${code()}\n  Open ${config.publicUrl || 'http://<this server>:' + config.port}/setup/ to finish setup.\n` + '='.repeat(52) + '\n');
}

const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
const isUnlocked = (req) => unlocked.has(cookieOf(req, SETUP_COOKIE) || '');

/** During setup, whoever signs in with the setup code unlocked becomes an owner. */
export function claimOwner(req, user) {
  if (conn.isConfigured() || !isUnlocked(req)) return;
  if (!conn.get().ownerIds.includes(user.id)) {
    conn.update((d) => { d.ownerIds.push(user.id); });
    console.log(`[setup] ${user.username} (${user.id}) is now an owner`);
  }
}

// Paths that work before setup is finished.
const OPEN = [/^\/setup(\/|$)/, /^\/api\/setup\//, /^\/api\/connections(\/|$)/, /^\/auth\//, /^\/api\/config$/, /^\/api\/me$/, /^\/browse\/style\.css$/, /^\/browse\/img\//, /^\/browse\/guide\.js$/];

/** Until setup is finished, send everything else to the wizard. */
export function setupGate(req, res, next) {
  if (conn.isConfigured() || OPEN.some((r) => r.test(req.path))) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path === '/ws') return res.status(503).json({ error: 'Setup is not finished yet', setup: true });
  res.redirect('/setup/');
}

export function setupRoutes(app, { wrap, tokenOf }) {
  /** Who may change connections: the setup-code holder during setup, super admins afterwards. */
  const canManage = (req) => {
    const s = auth.getSession(tokenOf(req));
    if (s && auth.isSuperAdmin(s.userId)) return true;
    return !conn.isConfigured() && isUnlocked(req);
  };
  const needManage = (req, res, next) => (canManage(req) ? next() : res.status(403).json({ error: conn.isConfigured() ? 'Super admins only' : 'Enter the setup code first' }));

  // ---- pages ----
  app.get(['/setup', '/setup/'], (req, res) => {
    // After setup, the wizard is still used by super admins to add a bot or change the Plex server.
    if (conn.isConfigured() && !req.query.add) return res.redirect('/browse/admin.html#connections');
    logSetupCode();
    res.set('Cache-Control', 'no-store').type('html').send(readFileSync(path.join(root, 'web/setup.html'), 'utf8'));
  });
  app.get('/setup/setup.js', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(root, 'web/setup.js')));

  // ---- status ----
  app.get('/api/setup/status', (req, res) => {
    const manage = canManage(req);
    const s = auth.getSession(tokenOf(req));
    res.json({
      configured: conn.isConfigured(),
      unlocked: manage,
      signedIn: s ? { id: s.userId, name: s.username, owner: config.ownerIds.includes(s.userId) } : null,
      suggestedUrl: `${req.protocol}://${req.get('host')}`,
      ...(manage ? connectionsView() : {}),
    });
  });

  // Wrong guesses are limited so the code can't be brute-forced.
  let tries = [];
  app.post('/api/setup/unlock', (req, res) => {
    if (conn.isConfigured()) return res.status(400).json({ error: 'Setup is already finished' });
    tries = tries.filter((t) => Date.now() - t < 60_000);
    if (tries.length >= 10) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
    const given = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (given !== code().replace('-', '')) {
      tries.push(Date.now());
      logSetupCode(true);
      return res.status(403).json({ error: 'That code is not right. Check the container log for the current one.' });
    }
    const t = crypto.randomBytes(24).toString('base64url');
    unlocked.add(t);
    res.cookie(SETUP_COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 24 * 3600_000 });
    res.json({ ok: true });
  });

  // ---- connections overview (Admin → Connections and the wizard) ----
  app.get('/api/connections', needManage, (req, res) => res.json(connectionsView()));

  app.put('/api/connections/public-url', needManage, (req, res) => {
    let url = String(req.body?.publicUrl || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) return res.status(400).json({ error: 'Use the https:// address people open, with no path (e.g. https://tv.example.com)' });
    conn.update((d) => { d.publicUrl = url.toLowerCase(); });
    res.json(connectionsView());
  });

  /** Check an address from the drocsid server too (informational: some routers don't loop back). */
  app.post('/api/connections/public-url/test', needManage, wrap(async (req, res) => {
    const url = String(req.body?.publicUrl || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) return res.json({ ok: false, error: 'Not an https address' });
    try {
      const r = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.json({ ok: false, error: `Answered ${r.status}` });
      const j = await r.json().catch(() => null);
      res.json({ ok: !!j, instance: j?.instance || null });
    } catch (e) {
      res.json({ ok: false, error: e.name === 'TimeoutError' ? 'No answer within 8 s' : (e.cause?.code || e.message) });
    }
  }));

  // ---- Discord apps ----
  const appInput = (b) => {
    const clientId = String(b.clientId || '').trim();
    const existing = conn.app(clientId);
    return {
      clientId,
      clientSecret: String(b.clientSecret || '').trim() || conn.appSecret(existing),
      botToken: String(b.botToken || '').trim().replace(/^Bot\s+/i, '') || conn.appToken(existing),
      existing,
    };
  };

  app.post('/api/connections/discord/test', needManage, wrap(async (req, res) => {
    const { clientId, clientSecret, botToken } = appInput(req.body || {});
    res.json(await discord.testApp({ clientId, clientSecret, botToken, redirectUri: config.publicUrl ? `${config.publicUrl}/auth/callback` : null }));
  }));

  app.post('/api/connections/discord', needManage, wrap(async (req, res) => {
    const { clientId, clientSecret, botToken, existing } = appInput(req.body || {});
    const test = await discord.testApp({ clientId, clientSecret, botToken });
    const must = test.checks.filter((c) => ['id', 'token', 'secret'].includes(c.id) && !c.ok);
    if (must.length) return res.status(400).json({ error: must.map((c) => c.hint || c.label).join(' '), test });
    conn.update((d) => {
      const rec = d.discordApps.find((a) => a.id === clientId);
      const fields = { name: test.app?.name || rec?.name || 'Discord app', clientSecret: conn.seal(clientSecret), botToken: conn.seal(botToken) };
      if (rec) Object.assign(rec, fields);
      else d.discordApps.push({ id: clientId, botUser: '', primary: d.discordApps.length === 0, addedAt: Date.now(), ...fields });
    });
    console.log(`[connections] Discord app ${test.app?.name || clientId} ${existing ? 'updated' : 'added'}`);
    await discord.sync();
    res.json({ ...connectionsView(), test });
  }));

  app.post('/api/connections/discord/:id/members-intent', needManage, wrap(async (req, res) => {
    const a = conn.app(req.params.id);
    const token = String(req.body?.botToken || '').trim() || conn.appToken(a);
    if (!token) return res.status(400).json({ error: 'Paste the bot token first' });
    await discord.enableMembersIntent(token);
    if (a) await discord.restart(a.id); // the running bot reconnects to receive member data
    res.json({ ok: true });
  }));

  app.post('/api/connections/discord/:id/primary', needManage, (req, res) => {
    if (!conn.app(req.params.id)) return res.status(404).json({ error: 'Not found' });
    conn.update((d) => d.discordApps.forEach((a) => { a.primary = a.id === req.params.id; }));
    res.json(connectionsView());
  });

  app.delete('/api/connections/discord/:id', needManage, wrap(async (req, res) => {
    const a = conn.app(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (conn.isConfigured() && conn.apps().length === 1) return res.status(400).json({ error: 'This is the only Discord app. Add another before removing it.' });
    conn.update((d) => {
      d.discordApps = d.discordApps.filter((x) => x.id !== a.id);
      if (d.discordApps.length && !d.discordApps.some((x) => x.primary)) d.discordApps[0].primary = true;
    });
    console.log(`[connections] Discord app ${a.name} removed`);
    await discord.sync();
    res.json(connectionsView());
  }));

  // ---- Plex ----
  app.post('/api/connections/plex/pin', needManage, wrap(async (req, res) => {
    res.json(await plexSetup.startPin(req.body?.returnUrl));
  }));

  app.get('/api/connections/plex/pin/:id', needManage, wrap(async (req, res) => {
    if (!(await plexSetup.checkPin(req.params.id))) return res.json({ done: false });
    const list = await plexSetup.servers(plexSetup.pinToken(req.params.id));
    res.json({ done: true, servers: list.map(({ token, ...s }) => s) });
  }));

  /** Plex token from what the browser sent: a finished Plex sign-in, the saved server, or a pasted token. */
  async function plexToken(b, existing) {
    if (b.token) return String(b.token).trim();
    if (b.pinId && b.machineId) {
      const account = plexSetup.pinToken(b.pinId);
      if (!account) throw Object.assign(new Error('Plex sign-in expired. Sign in again.'), { status: 400 });
      const srv = (await plexSetup.servers(account)).find((s) => s.machineId === b.machineId);
      return srv?.token || account;
    }
    return existing?.token || '';
  }

  /** Check a server with what the browser sent. Returns the test result, including the token (server side only). */
  async function tryServer(b) {
    const type = String(b.type || '');
    const existing = b.serverId ? conn.server(String(b.serverId)) : null;
    if (existing && existing.type !== type) return { ok: false, error: 'Server type mismatch' };
    if (type === 'plex') {
      const token = await plexToken(b, existing);
      const t = await plexSetup.testServer(b.url || existing?.url, token);
      return t.ok ? { ...t, token, userId: '' } : t;
    }
    if (type === 'jellyfin' || type === 'emby') {
      const fresh = b.username || b.apiKey;
      return jf.connect({
        type, url: b.url || existing?.url,
        username: b.username, password: b.password, apiKey: b.apiKey,
        // Editing without new credentials keeps the saved sign-in.
        token: fresh ? undefined : existing?.token, userId: fresh ? undefined : existing?.userId,
      });
    }
    return { ok: false, error: 'Pick Plex, Jellyfin or Emby' };
  }
  const strip = ({ token, userId, ...t }) => t;

  app.post('/api/connections/media/test', needManage, wrap(async (req, res) => {
    res.json(strip(await tryServer(req.body || {})));
  }));

  /** Add a server, or save changes to one (serverId). */
  app.post('/api/connections/media', needManage, wrap(async (req, res) => {
    const b = req.body || {};
    const t = await tryServer(b);
    if (!t.ok) return res.status(400).json({ error: t.error });
    // The name is the server's own (Plex "friendly name", Jellyfin/Emby "server name").
    const name = String(t.name || conn.server(b.serverId)?.name || b.type).trim().slice(0, 60);
    conn.update((d) => {
      const rec = {
        type: b.type, name, url: t.url, token: conn.seal(t.token), userId: t.userId || '',
        username: t.username || '', machineId: t.machineId || '',
      };
      const i = d.mediaServers.findIndex((x) => x.id === b.serverId);
      if (i >= 0) {
        d.mediaServers[i] = { ...d.mediaServers[i], ...rec };
      } else {
        if (d.mediaServers.some((x) => x.type === b.type && x.machineId && x.machineId === t.machineId)) {
          throw Object.assign(new Error(`${name} is already connected`), { status: 409 });
        }
        const id = b.type === 'plex' && !d.mediaServers.some((x) => x.id === 'plex1') ? 'plex1' : `${b.type}-${crypto.randomBytes(3).toString('hex')}`;
        d.mediaServers.push({ id, addedAt: Date.now(), ...rec });
      }
    });
    sources.clearLiveCache();
    console.log(`[connections] ${b.type} server ${name} at ${t.url} ${b.serverId ? 'updated' : 'added'}`);
    res.json(connectionsView());
  }));

  app.delete('/api/connections/media/:id', needManage, (req, res) => {
    const srv = conn.server(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (conn.isConfigured() && conn.get().mediaServers.length === 1) return res.status(400).json({ error: 'This is the only media server. Add another before removing it.' });
    conn.update((d) => { d.mediaServers = d.mediaServers.filter((x) => x.id !== srv.id); });
    sources.clearLiveCache();
    console.log(`[connections] ${srv.type} server ${srv.name} removed`);
    res.json(connectionsView());
  });

  /** Online check for the Connections panel. */
  app.get('/api/connections/media/:id/health', needManage, wrap(async (req, res) => {
    const srv = conn.server(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    await sources.refreshNames([srv]).catch(() => {});
    res.json(await sources.health(srv));
  }));

  // ---- finish ----
  app.post('/api/setup/finish', needManage, (req, res) => {
    const d = conn.get();
    const missing = [
      !d.publicUrl && 'the public address',
      !d.discordApps.length && 'a Discord app',
      !d.ownerIds.length && 'an owner (sign in with Discord)',
      !d.mediaServers.length && 'a media server',
    ].filter(Boolean);
    if (missing.length) return res.status(400).json({ error: `Still needed: ${missing.join(', ')}.` });
    conn.update((x) => { x.setupComplete = true; });
    unlocked.clear();
    console.log('[setup] finished');
    res.json({ ok: true });
  });
}

/** Everything the wizard and Connections panel show (no secrets). */
function connectionsView() {
  const v = conn.publicView();
  return {
    ...v,
    redirectUri: v.publicUrl ? `${v.publicUrl}/auth/callback` : '',
    activityHost: v.publicUrl ? v.publicUrl.replace(/^https:\/\//, '') : '',
    discordApps: v.discordApps.map((a) => ({ ...a, ...discord.status(a.id), invite: discord.inviteUrl(a.id) })),
  };
}
