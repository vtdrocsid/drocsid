import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { settings, update as updateSettings, VALID, QUALITY_PRESETS } from './settings.js';
import * as settingsMod from './settings.js';
import * as auth from './auth.js';
import * as plex from './plex.js';
import * as rooms from './rooms.js';
import { announce } from './bot.js';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

// Log Activity sign-in and every playlist request (segments only when they fail).
app.use((req, res, next) => {
  const p = req.path;
  if (!p.startsWith('/media/') && p !== '/api/token' && !p.startsWith('/activity')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const isSegment = !p.endsWith('.m3u8') && p.startsWith('/media/');
    if (isSegment && res.statusCode < 400) return;
    console.log(`[http] ${res.statusCode} ${req.method} ${p.replace(/\/media\/t\/[^/]+\//, '/media/t/<token>/')} ${Date.now() - started}ms`);
  });
  next();
});

const COOKIE = 'pc_session';
const REDIRECT_URI = `${config.publicUrl}/auth/callback`;

// ---------- helpers ----------
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return cookies(req)[COOKIE] || req.query.token || null;
}
async function approved(session) {
  if (session.approvedVer === settingsMod.version && Date.now() - session.approvedAt < 2 * 60_000) return session.approved;
  session.approved = await auth.isApproved(session.userId);
  session.approvedAt = Date.now();
  session.approvedVer = settingsMod.version;
  return session.approved;
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const needSession = wrap(async (req, res, next) => {
  const s = auth.getSession(tokenOf(req));
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  req.session = s;
  next();
});
const needApproved = wrap(async (req, res, next) => {
  if (!(await approved(req.session))) return res.status(403).json({ error: 'Not approved' });
  next();
});
const needAdmin = (req, res, next) => (auth.isAdmin(req.session.userId) ? next() : res.status(403).json({ error: 'Admins only' }));
const needViewer = wrap(async (req, res, next) => {
  if (settings().viewRequiresApproval && !(await approved(req.session))) return res.status(403).end();
  next();
});

// ---------- entry points ----------
// Discord loads the Activity at "/" with ?frame_id=...; browsers get the portal.
app.get('/', (req, res) => {
  if (req.query.frame_id) {
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(`/activity/?${qs}`);
  }
  res.redirect('/browse/');
});
app.get('/admin', (req, res) => res.redirect('/browse/admin.html'));
// The Activity page is served with versioned asset URLs so Discord never runs a stale cached player.
app.get(['/activity', '/activity/', '/activity/index.html'], (req, res) => {
  const html = readFileSync(path.join(root, 'public/activity/index.html'), 'utf8')
    .replace('/activity/style.css', `/activity/style.css?v=${VERSION}`)
    .replace('/activity/app.js', `/activity/app.js?v=${VERSION}`);
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use('/activity', express.static(path.join(root, 'public/activity'), { setHeaders: (r) => r.set('Cache-Control', 'no-cache') }));
app.use('/browse', express.static(path.join(root, 'web')));

// ---------- web login (Discord OAuth2) ----------
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('pc_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600_000 });
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', scope: 'identify', redirect_uri: REDIRECT_URI, state, prompt: 'none' });
  res.redirect(url.toString());
});

app.get('/auth/callback', wrap(async (req, res) => {
  if (!req.query.code || req.query.state !== cookies(req).pc_state) return res.status(400).send('Login failed, please try again.');
  const { user } = await auth.exchangeCode(String(req.query.code), REDIRECT_URI);
  const token = auth.createSession(user);
  res.clearCookie('pc_state');
  res.cookie(COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 12 * 3600_000 });
  res.redirect('/browse/');
}));

app.post('/auth/logout', (req, res) => {
  auth.logout(tokenOf(req));
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

// ---------- Activity login ----------
app.get('/api/config', (req, res) => res.json({ clientId: config.clientId, publicUrl: config.publicUrl }));

app.post('/api/token', wrap(async (req, res) => {
  const { access_token, user } = await auth.exchangeCode(String(req.body.code || ''));
  const token = auth.createSession(user);
  const s = auth.getSession(token);
  res.json({ access_token, token, user: { id: user.id, name: s.username }, approved: await approved(s) });
}));

// ---------- portal API ----------
app.get('/api/me', needSession, wrap(async (req, res) => {
  res.json({ id: req.session.userId, name: req.session.username, approved: await approved(req.session), admin: auth.isAdmin(req.session.userId) });
}));

app.get('/api/libraries', needSession, needApproved, wrap(async (req, res) => res.json(await plex.libraries())));

app.get('/api/libraries/:id/items', needSession, needApproved, wrap(async (req, res) => {
  res.json(await plex.libraryItems(req.params.id, {
    start: Math.max(0, Number(req.query.start) || 0),
    size: Math.min(100, Number(req.query.size) || 60),
    sort: String(req.query.sort || 'title'),
  }));
}));

app.get('/api/search', needSession, needApproved, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(q ? await plex.search(q) : []);
}));

app.get('/api/item/:key', needSession, needApproved, wrap(async (req, res) => {
  const key = req.params.key.replace(/\D/g, '');
  const item = await plex.metadata(key);
  const kids = ['show', 'season'].includes(item.kind) ? await plex.children(key) : [];
  res.json({ item, children: kids });
}));

app.get('/api/thumb', needSession, needApproved, wrap(async (req, res) => {
  const p = String(req.query.path || '');
  if (!/^\/library\/metadata\/\d+\/(thumb|art)(\/\d+)?$/.test(p)) return res.status(400).end();
  const w = Math.min(1280, Number(req.query.w) || 300);
  const h = Math.min(1280, Number(req.query.h) || 450);
  const upstream = await fetch(plex.photoUrl(p, w, h));
  if (!upstream.ok) return res.status(upstream.status).end();
  res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(upstream.body).pipe(res);
}));

app.get('/api/livetv/guide', needSession, needApproved, wrap(async (req, res) => {
  const hours = Math.min(12, Math.max(1, Number(req.query.hours) || 4));
  const from = Number(req.query.from) || Date.now() - 30 * 60_000;
  res.json({ from, to: from + hours * 3600_000, channels: await plex.guide(from, from + hours * 3600_000) });
}));

app.get('/api/logo', needSession, needApproved, wrap(async (req, res) => {
  // Channel logos may be Plex paths or LAN-only URLs, so fetch them server-side.
  const ch = (await plex.liveChannels()).find((c) => c.id === req.query.id);
  if (!ch?.thumb) return res.status(404).end();
  const upstream = await fetch(ch.thumb.startsWith('/') ? plex.photoUrl(ch.thumb, 120, 90) : ch.thumb);
  if (!upstream.ok) return res.status(404).end();
  res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
  res.set('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(upstream.body).pipe(res);
}));

app.get('/api/voice', needSession, needApproved, (req, res) => {
  res.json({
    current: auth.voiceChannelOf(req.session.userId),
    qualities: QUALITY_PRESETS.map(({ id, label }) => ({ id, label })),
    channels: auth.voiceChannels().map((c) => ({ ...c, nowPlaying: rooms.publicState(rooms.get(c.id)) })),
  });
});

app.post('/api/play', needSession, needApproved, wrap(async (req, res) => {
  const { source, ratingKey, channelId: liveId, voiceChannelId, replace = false, stopMine = false } = req.body || {};
  const channels = auth.voiceChannels();
  const channel = channels.find((c) => c.id === voiceChannelId);
  if (!channel) return res.status(400).json({ error: 'Pick a voice channel' });
  const me = { id: req.session.userId, name: req.session.username };
  const isAdmin = auth.isAdmin(me.id);

  // One video per channel: a busy channel can only be replaced by whoever started it, or an admin.
  const current = rooms.get(voiceChannelId);
  if (current && !replace) {
    const canReplace = isAdmin || current.startedById === me.id;
    return res.status(409).json({
      conflict: 'channel', canReplace,
      error: `“${current.item.title}” is already playing in ${channel.name} (started by ${current.startedBy}).`,
    });
  }
  if (current && replace && !(isAdmin || current.startedById === me.id)) {
    return res.status(403).json({ error: `Only ${current.startedBy} or an admin can replace what's playing in ${channel.name}.` });
  }

  // One stream per user: starting somewhere else means stopping your other stream first.
  const mine = rooms.startedBy(me.id);
  if (mine && mine.id !== voiceChannelId) {
    const where = channels.find((c) => c.id === mine.id)?.name || 'another channel';
    if (!stopMine) return res.status(409).json({ conflict: 'user', error: `You're already streaming “${mine.item.title}” in ${where}.` });
    await rooms.stop(mine.id, true, `${me.name} started something in another channel`);
  }

  const item = source === 'live' ? await plex.liveChannel(String(liveId)) : await plex.metadata(String(ratingKey).replace(/\D/g, ''));
  if (item.source === 'plex' && !['movie', 'episode'].includes(item.kind)) return res.status(400).json({ error: 'Pick a movie or an episode' });
  await rooms.start(voiceChannelId, config.guildId, item, me, settings().quality);
  rooms.setViewers(voiceChannelId, subs.get(voiceChannelId)?.size || 0);
  announce(voiceChannelId, `▶️ **${item.title}** started by ${me.name}. Open **Activities** (🚀) in this voice channel to watch.`);
  res.json({ ok: true, state: rooms.publicState(rooms.get(voiceChannelId)) });
}));

async function control(roomId, action, seconds, quality) {
  if (!rooms.get(roomId)) throw Object.assign(new Error('Nothing playing there'), { status: 404 });
  if (action === 'pause') rooms.pause(roomId);
  else if (action === 'resume') await rooms.resume(roomId);
  else if (action === 'seek') await rooms.seek(roomId, Number(seconds) || 0);
  else if (action === 'stop') await rooms.stop(roomId, true, 'stopped from the player');
  else if (action === 'quality') {
    if (!VALID.quality.includes(quality)) throw Object.assign(new Error('Unknown quality'), { status: 400 });
    await rooms.setQuality(roomId, quality);
    updateSettings({ quality }); // becomes the default for the next stream
  }
  else throw Object.assign(new Error('Unknown action'), { status: 400 });
}

app.post('/api/control', needSession, needApproved, wrap(async (req, res) => {
  await control(String(req.body.voiceChannelId), req.body.action, req.body.seconds, req.body.quality);
  res.json({ ok: true });
}));

// ---------- admin API ----------
app.get('/api/admin/state', needSession, needAdmin, wrap(async (req, res) => {
  const s = settings();
  const [directory, libs] = await Promise.all([auth.guildDirectory(), plex.libraries({ all: true }).catch(() => [])]);
  const named = (ids) => Promise.all(ids.map((id) => directory.members.find((m) => m.id === id) || auth.lookupUser(id)));
  res.json({
    settings: s,
    valid: VALID,
    owners: await named(config.ownerIds),
    admins: await named(s.adminUserIds),
    approvedUsers: await named(s.approvedUserIds),
    directory,
    libraries: libs,
    live: await plex.liveStatus(),
    streams: rooms.all().map((r) => ({
      voiceChannelId: r.id,
      voiceChannel: auth.voiceChannels().find((c) => c.id === r.id)?.name || r.id,
      viewers: r.viewers,
      ...rooms.publicState(r),
      qualityLabel: QUALITY_PRESETS.find((q) => q.id === r.quality)?.label || '',
    })),
  });
}));

app.put('/api/admin/settings', needSession, needAdmin, wrap(async (req, res) => {
  const { quality, ...patch } = req.body || {}; // quality is set from the player bar, not here
  res.json({ settings: updateSettings(patch) });
}));

app.post('/api/admin/stop', needSession, needAdmin, wrap(async (req, res) => {
  await rooms.stop(String(req.body.voiceChannelId), true, 'stopped by an admin');
  res.json({ ok: true });
}));

app.post('/api/admin/refresh-live', needSession, needAdmin, wrap(async (req, res) => {
  plex.clearLiveCache();
  res.json(await plex.liveStatus());
}));

// ---------- media (HLS) ----------
// The token is carried in the URL path so that relative playlist/segment URLs keep it.
// That works for hls.js and for Safari's native HLS player, which can't send headers.
const pathSession = (req, res, next) => {
  const s = auth.getSession(req.params.token);
  if (!s) return res.status(401).end();
  req.session = s;
  next();
};

app.get('/media/t/:token/room/:id/master.m3u8', pathSession, needViewer, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room?.masterPlaylist) return res.status(404).end();
  const body = room.masterPlaylist.replaceAll('/media/plex/', `/media/t/${encodeURIComponent(req.params.token)}/plex/`);
  console.log(`[media] ${req.session.username} loaded master playlist for ${room.item.title}:\n${body.replace(/\/media\/t\/[^/]+\//g, '/media/t/<token>/')}`);
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(body);
});

const seenSegments = new Set();
// Only the transcoder session paths are proxied; the rest of the Plex API stays private.
app.use('/media/t/:token/plex', pathSession, needViewer, wrap(async (req, res) => {
  if (req.method !== 'GET' || !req.url.startsWith('/video/:/transcode/universal/session/')) return res.status(403).end();
  const upstream = await fetch(plex.plexProxyUrl(req.url));
  const shortPath = req.url.split('?')[0];
  if (!upstream.ok) console.warn(`[plex proxy] ${upstream.status} for ${shortPath}`);
  else if (!shortPath.endsWith('.m3u8')) {
    const sess = (shortPath.match(/session\/([^/]+)/) || [])[1];
    if (sess && !seenSegments.has(sess)) {
      seenSegments.add(sess);
      console.log(`[plex proxy] first segment for session ${sess.slice(0, 8)}: ${upstream.headers.get('content-type')} ${upstream.headers.get('content-length') || '?'} bytes`);
    }
  }
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length']) if (upstream.headers.get(h)) res.set(h, upstream.headers.get(h));
  res.set('Cache-Control', 'no-store');
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
}));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ---------- WebSocket sync for the Activity ----------
const subs = new Map(); // roomId -> Set<ws>
export function startServer() {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const broadcast = (roomId, msg) => subs.get(roomId)?.forEach((ws) => send(ws, msg));

  rooms.events.on('update', (room) => broadcast(room.id, { type: 'state', state: rooms.publicState(room) }));
  rooms.events.on('end', (roomId) => {
    broadcast(roomId, { type: 'state', state: { active: false } });
    announce(roomId, '⏹️ Stream ended.');
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const session = auth.getSession(url.searchParams.get('token'));
    const roomId = url.searchParams.get('channel');
    if (!session || !roomId) { console.warn('[ws] rejected: no session'); return ws.close(4001, 'unauthorized'); }
    console.log(`[ws] ${session.username} connected to ${roomId}`);
    const isApproved = await approved(session);
    const inChannel = auth.voiceChannelOf(session.userId) === roomId;
    if (!inChannel && !isApproved) return ws.close(4003, 'join the voice channel first');
    if (settings().viewRequiresApproval && !isApproved) return ws.close(4003, 'not approved');

    if (!subs.has(roomId)) subs.set(roomId, new Set());
    subs.get(roomId).add(ws);
    rooms.setViewers(roomId, subs.get(roomId).size);
    send(ws, { type: 'hello', canControl: isApproved });
    send(ws, { type: 'state', state: rooms.publicState(rooms.get(roomId)) });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'clientlog') return console.warn(`[player ${session.username}] ${String(msg.text).slice(0, 500)}`);
      if (msg.type === 'sync') return send(ws, { type: 'state', state: rooms.publicState(rooms.get(roomId)) });
      if (msg.type === 'control' && isApproved) {
        try { await control(roomId, msg.action, msg.seconds, msg.quality); } catch (e) { send(ws, { type: 'error', error: e.message }); }
      }
    });
    ws.on('close', (code) => {
      console.log(`[ws] ${session.username} disconnected from ${roomId} (${code})`);
      subs.get(roomId)?.delete(ws);
      rooms.setViewers(roomId, subs.get(roomId)?.size || 0);
    });
  });

  // Periodic heartbeat state so clients correct drift.
  setInterval(() => {
    for (const roomId of subs.keys()) {
      const room = rooms.get(roomId);
      if (room) broadcast(roomId, { type: 'state', state: rooms.publicState(room) });
    }
  }, 5000).unref();

  server.listen(config.port, () => console.log(`Web server on :${config.port} (${config.publicUrl})`));
}
