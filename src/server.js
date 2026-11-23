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
import { announce, announceNowPlaying } from './bot.js';
import { groupPlaylist, parseGroup, GROUP } from './hlsgroup.js';
import * as history from './history.js';
import * as progress from './progress.js';
import * as schedule from './schedule.js';
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
const needSuper = (req, res, next) => (auth.isSuperAdmin(req.session.userId) ? next() : res.status(403).json({ error: 'Super admins only' }));
// Settings only super admins may change.
const SUPER_KEYS = ['superAdminUserIds', 'librarySections', 'libraryOrder', 'librarySort'];
const LIB_KEYS = ['librarySections', 'libraryOrder', 'librarySort'];
/** Settings as a given admin may see them: regular admins don't get library settings. */
const settingsFor = (userId, s = settings()) => ({
  ...(auth.isSuperAdmin(userId) ? s : Object.fromEntries(Object.entries(s).filter(([k]) => !LIB_KEYS.includes(k)))),
  superAdminUserIds: s.superAdminUserIds || [],
});
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
  res.json({ id: req.session.userId, name: req.session.username, approved: await approved(req.session), admin: auth.isAdmin(req.session.userId), superAdmin: auth.isSuperAdmin(req.session.userId), version: VERSION });
}));

app.get('/api/libraries', needSession, needApproved, wrap(async (req, res) => res.json(await plex.libraries())));

app.get('/api/libraries/:id/items', needSession, needApproved, wrap(async (req, res) => {
  res.json(await plex.libraryItems(req.params.id, {
    start: Math.max(0, Number(req.query.start) || 0),
    size: Math.min(300, Number(req.query.size) || 60),
    sort: String(req.query.sort || 'title'),
  }));
}));

app.get('/api/libraries/:id/letters', needSession, needApproved, wrap(async (req, res) => {
  res.json(await plex.libraryLetters(req.params.id));
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

// Hover card: compact details for one poster, cached briefly so sweeping the mouse over the grid is cheap.
const infoCache = new Map(); // key -> { at, data }
app.get('/api/info/:key', needSession, needApproved, wrap(async (req, res) => {
  const key = req.params.key.replace(/\D/g, '');
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return res.json(hit.data);
  const data = await plex.info(key);
  if (infoCache.size > 1000) infoCache.clear();
  infoCache.set(key, { at: Date.now(), data });
  res.json(data);
}));
app.get('/api/face/:id', needSession, needApproved, wrap(async (req, res) => {
  const url = plex.faceUrl(String(req.params.id));
  if (!url) return res.status(404).end();
  const upstream = await fetch(plex.photoUrl(url, 120, 120));
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
    textChannels: auth.textChannels(),
  });
});

app.post('/api/play', needSession, needApproved, wrap(async (req, res) => {
  const { source, ratingKey, channelId: liveId, voiceChannelId, replace = false, stopMine = false, announceChannelId, startAt = 0 } = req.body || {};
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

  const item = await resolveItem(source, ratingKey, liveId);
  await startStream(channel, item, me, { startAt: Number(startAt) || 0 });
  if (announceChannelId && auth.textChannels().some((c) => c.id === announceChannelId)) {
    announceNowPlaying(announceChannelId, { item, voiceChannelId: channel.id, startedBy: me.name });
  }
  res.json({ ok: true, state: rooms.publicState(rooms.get(voiceChannelId)) });
}));

/** Look up a playable item from the client's request (library title or live channel). */
async function resolveItem(source, ratingKey, liveId) {
  const item = source === 'live' ? await plex.liveChannel(String(liveId)) : await plex.metadata(String(ratingKey).replace(/\D/g, ''));
  if (item.source === 'plex' && !['movie', 'episode'].includes(item.kind)) throw Object.assign(new Error('Pick a movie or an episode'), { status: 400 });
  return item;
}

/** Start a stream in a voice channel, record it in play history, and announce it. */
async function startStream(channel, item, user, { scheduled = false, startAt = 0 } = {}) {
  await rooms.start(channel.id, config.guildId, item, user, settings().quality, startAt);
  const room = rooms.get(channel.id);
  room.historyId = history.begin({ item, voiceChannelId: channel.id, voiceChannelName: channel.name, startedBy: user.name, startedById: user.id, scheduled });
  // Anyone already watching in the Activity counts as a watcher of the new title.
  subs.get(channel.id)?.forEach((ws) => history.addWatcher(room.historyId, ws.username));
  rooms.setViewers(channel.id, subs.get(channel.id)?.size || 0);
  if (item.source === 'live') {
    // Play history shows the programme that was on, not just the channel.
    const hid = room.historyId;
    plex.liveNow(item.channelId).then((info) => {
      if (info?.now) history.setProgram(hid, { program: info.now.title, subtitle: info.now.subtitle, programThumb: info.now.thumb });
    }).catch(() => {});
  }
  announce(channel.id, scheduled
    ? `📅 Scheduled showing: **${item.title}** (scheduled by ${user.name}) is starting now. Open **Activities** (🚀) in this voice channel to watch.`
    : `▶️ **${item.title}** started by ${user.name}. Open **Activities** (🚀) in this voice channel to watch.`);
}

// ---------- watch progress (resume where you left off) ----------
app.get('/api/progress/:key', needSession, needApproved, (req, res) => {
  res.json(progress.get(req.session.userId, String(req.params.key).replace(/\D/g, '')) || null);
});
// Every 20 s, remember the position for everyone who has the player open on a library title.
setInterval(() => {
  for (const room of rooms.all()) {
    if (room.item.source !== 'plex' || !room.item.duration || !room.item.ratingKey) continue;
    const st = rooms.publicState(room);
    for (const ws of subs.get(room.id) || []) progress.record(ws.userId, String(room.item.ratingKey), st.position, room.item.duration);
  }
}, 20_000).unref();

// ---------- Watching Now (left rail) ----------
// Every voice channel with a stream: what's on, how far along, and who has the player open.
app.get('/api/watching', needSession, needApproved, wrap(async (req, res) => {
  const list = rooms.all();
  const voice = auth.voiceChannels();
  let guide = null;
  const liveIds = list.filter((r) => r.item.source === 'live').map((r) => r.item.channelId);
  if (liveIds.length) {
    try { guide = await plex.guide(Date.now() - 3 * 3600_000, Date.now() + 3600_000, liveIds); } catch {}
  }
  const out = list.map((room) => {
    const st = rooms.publicState(room);
    const ch = voice.find((c) => c.id === room.id);
    const seen = new Set();
    const viewers = [...(subs.get(room.id) || [])]
      .filter((ws) => ws.userId && !seen.has(ws.userId) && seen.add(ws.userId))
      .map((ws) => auth.memberCard(ws.userId, ws.username));
    const entry = {
      voiceChannelId: room.id, voiceChannelName: ch?.name || 'Voice channel',
      title: st.title, source: st.source, playing: st.playing, position: st.position, duration: st.duration,
      startedBy: st.startedBy, thumb: room.item.thumb || null, channelId: room.item.channelId || null, viewers,
    };
    if (st.source === 'live' && guide) {
      const now = Date.now();
      const prog = guide.find((c) => c.id === room.item.channelId)?.programmes.find((p) => p.start <= now && p.stop > now);
      if (prog) Object.assign(entry, { program: prog.title, progStart: prog.start, progStop: prog.stop });
    }
    return entry;
  });
  res.json(out);
}));

// ---------- play history & lineup API ----------
app.get('/api/history', needSession, needApproved, (req, res) => {
  const live = new Set(rooms.all().map((r) => r.historyId));
  res.json(history.list(Math.min(100, Number(req.query.limit) || 30)).map(({ programThumb, ...e }) => ({
    ...e, playing: live.has(e.id), programPoster: programThumb ? `/api/history/${e.id}/poster` : null,
  })));
});

// Poster of the live programme recorded in a history entry (fetched through Plex's photo transcoder).
app.get('/api/history/:id/poster', needSession, needApproved, wrap(async (req, res) => {
  const src = history.get(String(req.params.id))?.programThumb;
  if (!src) return res.status(404).end();
  const upstream = await fetch(plex.photoUrl(src, 160, 240)).catch(() => null);
  if (!upstream?.ok) return res.status(404).end();
  res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(upstream.body).pipe(res);
}));

app.get('/api/schedule', needSession, needApproved, (req, res) => {
  res.json(schedule.upcoming().map((x) => ({ ...x, mine: x.byId === req.session.userId, canDelete: x.byId === req.session.userId || auth.isAdmin(req.session.userId) })));
});

app.post('/api/schedule', needSession, needApproved, wrap(async (req, res) => {
  const { source, ratingKey, channelId: liveId, voiceChannelId, at } = req.body || {};
  const channel = auth.voiceChannels().find((c) => c.id === voiceChannelId);
  if (!channel) return res.status(400).json({ error: 'Pick a voice channel' });
  const when = Number(at);
  if (!when || when < Date.now() + 60_000) return res.status(400).json({ error: 'Pick a time at least a minute from now' });
  if (when > Date.now() + 60 * 86400_000) return res.status(400).json({ error: 'Pick a time within the next 60 days' });
  const item = await resolveItem(source, ratingKey, liveId);
  const clash = schedule.upcoming().find((x) => x.voiceChannelId === channel.id && Math.abs(x.at - when) < 15 * 60_000);
  if (clash) return res.status(409).json({ error: `“${clash.title}” is already scheduled in ${channel.name} at that time.` });
  const entry = schedule.add({
    at: when, source: item.source, ratingKey: item.ratingKey || null, channelId: item.channelId || null,
    title: item.title, thumb: item.thumb || null, duration: item.duration || 0,
    voiceChannelId: channel.id, voiceChannelName: channel.name, by: req.session.username, byId: req.session.userId,
  });
  console.log(`[lineup] ${entry.by} scheduled ${entry.title} in ${entry.voiceChannelName} for ${new Date(entry.at).toISOString()}`);
  res.json(entry);
}));

app.delete('/api/schedule/:id', needSession, needApproved, (req, res) => {
  const x = schedule.get(req.params.id);
  if (!x) return res.status(404).json({ error: 'Not found' });
  if (x.byId !== req.session.userId && !auth.isAdmin(req.session.userId)) return res.status(403).json({ error: 'Only whoever scheduled it, or an admin, can remove it' });
  schedule.remove(x.id);
  res.json({ ok: true });
});

// Runner: 10-minute reminder, then start scheduled showings on time.
setInterval(async () => {
  for (const x of schedule.needReminder(10 * 60_000)) {
    schedule.markReminded(x.id);
    announce(x.voiceChannelId, `⏰ Coming up in ${Math.max(1, Math.round((x.at - Date.now()) / 60_000))} min: **${x.title}** (scheduled by ${x.by}).`);
  }
  for (const x of schedule.due()) {
    schedule.remove(x.id);
    try {
      const channel = auth.voiceChannels().find((c) => c.id === x.voiceChannelId) || { id: x.voiceChannelId, name: x.voiceChannelName };
      const item = await resolveItem(x.source, x.ratingKey, x.channelId);
      const current = rooms.get(channel.id);
      if (current) await rooms.stop(channel.id, false, `replaced by scheduled showing of ${item.title}`);
      await startStream(channel, item, { id: x.byId, name: x.by }, { scheduled: true });
      console.log(`[lineup] started ${item.title} in ${channel.name}`);
    } catch (e) {
      console.warn(`[lineup] could not start ${x.title}: ${e.message}`);
      announce(x.voiceChannelId, `⚠️ Couldn't start the scheduled showing of **${x.title}**: ${e.message}`);
    }
  }
}, 20_000).unref();

async function control(roomId, action, seconds, quality, userId) {
  const room = rooms.get(roomId);
  if (!room) throw Object.assign(new Error('Nothing playing there'), { status: 404 });
  // Only the person who started the stream controls it (admins can still stop it from the admin page).
  if (room.startedById !== userId) throw Object.assign(new Error(`Only ${room.startedBy} can control this stream.`), { status: 403 });
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
  await control(String(req.body.voiceChannelId), req.body.action, req.body.seconds, req.body.quality, req.session.userId);
  res.json({ ok: true });
}));

// ---------- admin API ----------
app.get('/api/admin/state', needSession, needAdmin, wrap(async (req, res) => {
  const s = settings();
  const sup = auth.isSuperAdmin(req.session.userId);
  const [directory, libs] = await Promise.all([auth.guildDirectory(), sup ? plex.libraries({ all: true }).catch(() => []) : []]);
  const named = (ids) => Promise.all(ids.map((id) => directory.members.find((m) => m.id === id) || auth.lookupUser(id)));
  res.json({
    role: sup ? 'super' : 'admin',
    settings: settingsFor(req.session.userId, s), // regular admins don't get library or Live TV details
    valid: VALID,
    owners: await named(config.ownerIds),
    superAdmins: await named(s.superAdminUserIds || []),
    admins: await named(s.adminUserIds),
    approvedUsers: await named(s.approvedUserIds),
    directory,
    libraries: sup ? libs : undefined,
    live: sup ? await plex.liveStatus() : undefined,
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
  if (!auth.isSuperAdmin(req.session.userId)) {
    const blocked = SUPER_KEYS.filter((k) => k in patch);
    if (blocked.length) return res.status(403).json({ error: 'Only super admins can change that' });
  }
  res.json({ settings: settingsFor(req.session.userId, updateSettings(patch)) });
}));

app.post('/api/admin/stop', needSession, needAdmin, wrap(async (req, res) => {
  await rooms.stop(String(req.body.voiceChannelId), true, 'stopped by an admin');
  res.json({ ok: true });
}));

// Super-admin diagnostics for guide times: /api/admin/guide-debug?id=<channel id>
app.get('/api/admin/guide-debug', needSession, needSuper, wrap(async (req, res) => {
  res.json(await plex.guideDebug(String(req.query.id || '')));
}));

app.post('/api/admin/refresh-live', needSession, needSuper, wrap(async (req, res) => {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one Plex segment, retrying while Plex is still producing it. A piece only counts once it
 * is real MPEG-TS (every TS packet starts with sync byte 0x47); right after a transcode restart
 * (start or seek) Plex can briefly answer with a 404, an empty body or a small non-video reply.
 */
const loggedOdd = new Set();
const loggedPlaylists = new Set();
async function fetchPiece(pathName, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let wait = 250, tries = 0;
  while (Date.now() < deadline) {
    tries++;
    const up = await fetch(plex.plexProxyUrl(pathName)).catch(() => null);
    if (up?.ok) {
      const buf = Buffer.from(await up.arrayBuffer());
      if (buf.length >= 188 && buf[0] === 0x47) return buf;
      const key = pathName.split('/session/')[1]?.slice(0, 8) + (tries === 1 ? ':first' : ':retry');
      if (!loggedOdd.has(key)) {
        loggedOdd.add(key);
        console.warn(`[plex proxy] ${pathName.split('/').pop()} not video yet (try ${tries}): ${up.headers.get('content-type')} ${buf.length} bytes, starts "${buf.subarray(0, 60).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}"`);
      }
    } else if (up && up.status !== 404) {
      await up.arrayBuffer().catch(() => {});
      console.warn(`[plex proxy] ${up.status} for ${pathName.split('/').pop()}`);
    }
    await sleep(wait);
    wait = Math.min(wait * 1.5, 2000);
  }
  return null;
}

// Only the transcoder session paths are proxied; the rest of the Plex API stays private.
app.use('/media/t/:token/plex', pathSession, needViewer, wrap(async (req, res) => {
  if (req.method !== 'GET' || !req.url.startsWith('/video/:/transcode/universal/session/')) return res.status(403).end();
  const shortPath = req.url.split('?')[0];
  const dir = shortPath.slice(0, shortPath.lastIndexOf('/') + 1);
  const sess = ((shortPath.match(/session\/([^/]+)/) || [])[1] || '').slice(0, 8);
  res.set('Cache-Control', 'no-store');

  // Grouped segment: fetch the pieces from Plex over the LAN and return them as one chunk.
  if (shortPath.endsWith('/grp.ts')) {
    const parts = parseGroup(new URLSearchParams(req.url.split('?')[1] || '').get('u'));
    if (!parts) return res.status(400).end();
    const started = Date.now();
    res.type('video/mp2t');
    let bytes = 0;
    // Pieces in order, one at a time: Plex lists a piece slightly before it has finished writing it,
    // and out-of-order requests can make it restart the transcode. Wait briefly for unfinished pieces.
    for (const name of parts) {
      const buf = await fetchPiece(dir + name);
      if (!buf) {
        console.warn(`[plex proxy] piece ${name} of ${sess} not ready after 30s`);
        if (!bytes) return res.status(503).end(); // player retries the whole group
        return res.end(); // send what we have; the player will refetch the rest
      }
      bytes += buf.length;
      res.write(buf);
    }
    res.end();
    const ms = Date.now() - started;
    if (!seenSegments.has(sess) || ms > 4000) {
      seenSegments.add(sess);
      console.log(`[plex proxy] group ${parts[0]}-${parts[parts.length - 1]} for ${sess}: ${(bytes / 1048576).toFixed(1)} MB from Plex in ${ms}ms`);
    }
    return;
  }

  const upstream = await fetch(plex.plexProxyUrl(req.url));
  if (!upstream.ok) console.warn(`[plex proxy] ${upstream.status} for ${shortPath}`);

  // Media playlist: regroup Plex's ~1 s segments into ~6 s ones.
  if (upstream.ok && shortPath.endsWith('.m3u8')) {
    const text = await upstream.text();
    if (!loggedPlaylists.has(sess)) {
      loggedPlaylists.add(sess);
      const lines = text.split('\n');
      console.log(`[plex proxy] playlist for ${sess}: ${lines.filter((l) => l.startsWith('#EXTINF')).length} segments; head: ${lines.slice(0, 8).join(' | ')}`);
    }
    return res.type('application/vnd.apple.mpegurl').send(groupPlaylist(text, GROUP));
  }

  res.status(upstream.status);
  for (const h of ['content-type', 'content-length']) if (upstream.headers.get(h)) res.set(h, upstream.headers.get(h));
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
    ws.username = session.username;
    ws.userId = session.userId;
    const isApproved = await approved(session);
    const inChannel = auth.voiceChannelOf(session.userId) === roomId;
    if (!inChannel && !isApproved) return ws.close(4003, 'join the voice channel first');
    if (settings().viewRequiresApproval && !isApproved) return ws.close(4003, 'not approved');

    if (!subs.has(roomId)) subs.set(roomId, new Set());
    subs.get(roomId).add(ws);
    rooms.setViewers(roomId, subs.get(roomId).size);
    history.addWatcher(rooms.get(roomId)?.historyId, session.username);
    send(ws, { type: 'hello', userId: session.userId });
    send(ws, { type: 'state', state: rooms.publicState(rooms.get(roomId)) });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'clientlog') return console.warn(`[player ${session.username}] ${String(msg.text).slice(0, 500)}`);
      if (msg.type === 'sync') return send(ws, { type: 'state', state: rooms.publicState(rooms.get(roomId)) });
      if (msg.type === 'control') {
        try { await control(roomId, msg.action, msg.seconds, msg.quality, session.userId); } catch (e) { send(ws, { type: 'error', error: e.message }); }
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
