// Discord Activity player: signs in through the Embedded App SDK, then plays the voice
// channel's shared Plex stream and stays in sync with the server's clock.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import Hls from 'hls.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};

let token = null, ws = null, hls = null, myId = null, publicUrl = '';
// Only the person who started the stream gets working controls.
const canControl = () => !!myId && state.startedById === myId;
let state = { active: false }, stateAt = 0, clockSkew = 0, loadedVersion = null, seeking = false;

function screen(title, html = '') {
  $('#screen').hidden = false;
  $('#screenTitle').textContent = title;
  $('#screenText').innerHTML = html;
}

// ---------- sign in ----------
let sdk = null, cfg = null;
async function signIn() {
  if (!sdk) {
    cfg = await fetch('/api/config').then((r) => r.json());
    publicUrl = cfg.publicUrl;
    sdk = new DiscordSDK(cfg.clientId);
    await sdk.ready();
  }
  const { code } = await sdk.commands.authorize({
    client_id: cfg.clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'],
  });
  const res = await fetch('/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!res.ok) throw new Error('Sign-in failed');
  const auth = await res.json();
  await sdk.commands.authenticate({ access_token: auth.access_token });
  token = auth.token;
  return sdk.channelId;
}

// ---------- server connection ----------
function connect(channelId) {
  ws = new WebSocket(`wss://${location.host}/ws?token=${encodeURIComponent(token)}&channel=${encodeURIComponent(channelId)}`);
  ws.onopen = () => { while (pending.length) send({ type: 'clientlog', text: pending.shift() }); report(`player v${__VERSION__} connected`); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') {
      myId = msg.userId;
      $('#ui').classList.toggle('viewer-only', !canControl());
    }
    if (msg.type === 'state') applyState(msg.state);
    if (msg.type === 'error') console.warn(msg.error);
  };
  ws.onclose = (e) => {
    if (e.code === 4001) {
      // Server restarted and forgot our login: sign in again silently.
      screen('Reconnecting…');
      return signIn().then(() => connect(channelId)).catch(() => setTimeout(() => connect(channelId), 3000));
    }
    if (e.code === 4003) return screen("Can't watch here", e.reason === 'not approved' ? 'An admin needs to approve you before you can watch.' : 'Join the voice channel first.');
    screen('Reconnecting…');
    setTimeout(() => connect(channelId), 2000);
  };
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const pending = [];
const report = (text) => {
  console.warn(text);
  if (ws?.readyState === 1) send({ type: 'clientlog', text }); else pending.push(text);
};
const control = (action, seconds) => canControl() && send({ type: 'control', action, seconds });

// ---------- playback ----------
function expectedPosition() {
  if (!state.active) return 0;
  if (!state.playing) return state.position;
  const serverNow = Date.now() + clockSkew;
  return state.position + (serverNow - state.serverTime) / 1000;
}
const mediaStart = () => (video.seekable.length ? video.seekable.start(0) : 0);
const isLive = () => state.source === 'live';
function bufferedAhead() {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) return video.buffered.end(i) - video.currentTime;
  }
  return 0;
}

function loadStream() {
  loadedVersion = state.playlistVersion;
  if (hls) { hls.destroy(); hls = null; }
  const src = `/media/t/${encodeURIComponent(token)}/${state.playlist}`;
  if (Hls.isSupported()) {
    hls = new Hls({
      maxBufferLength: 30,
      // Plex's playlist grows while it transcodes, so hls.js sees it as "live". For library titles,
      // stop hls.js from jumping toward the live edge on its own; our sync handles position.
      ...(isLive() ? { liveSyncDuration: 6 } : { liveMaxLatencyDurationCount: Infinity, liveSyncDurationCount: 3 }),
      backBufferLength: 30,
      startPosition: isLive() ? -1 : Math.max(0, expectedPosition() - state.offsetBase),
    });
    hls.on(Hls.Events.ERROR, (_, d) => {
      report(`hls ${d.fatal ? 'FATAL' : 'warn'} ${d.type}/${d.details} ${d.response?.code ?? ''} ${d.url || d.frag?.url || ''}`.replace(/\/media\/t\/[^/]+\//, '/media/t/<token>/'));
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls?.startLoad(), 1500);
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else { console.error(d); setTimeout(loadStream, 2000); }
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => report(`manifest ok: ${d.levels.length} level(s) ${d.levels.map((l) => `${l.width}x${l.height} ${l.videoCodec || ''}/${l.audioCodec || ''}`).join(', ')}`));
    let fragCount = 0;
    hls.on(Hls.Events.FRAG_LOADED, (_, d) => {
      const st = d.frag.stats, ms = Math.round(st.loading.end - st.loading.start);
      if (fragCount++ < 3 || fragCount % 20 === 0 || ms > d.frag.duration * 1000) {
        report(`segment ${d.frag.sn}: ${d.frag.duration.toFixed(1)}s of video, ${(st.total / 1048576).toFixed(1)} MB, downloaded in ${ms}ms, buffer ahead ${bufferedAhead().toFixed(1)}s`);
      }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src; // Safari / iOS Discord: native HLS
  }
  video.addEventListener('loadedmetadata', () => {
    baseMediaStart = mediaStart();
    report(`video metadata ${video.videoWidth}x${video.videoHeight}, media starts at ${baseMediaStart.toFixed(2)}s`);
    sync(true);
    tryPlay();
  }, { once: true });
  let stalledAt = 0;
  video.onwaiting = () => { stalledAt = Date.now(); };
  video.onplaying = () => {
    if (stalledAt) report(`stall: buffered for ${((Date.now() - stalledAt) / 1000).toFixed(1)}s at ${video.currentTime.toFixed(0)}s (buffer ahead ${bufferedAhead().toFixed(1)}s)`);
    stalledAt = 0;
  };
  video.onerror = () => report(`video element error ${video.error?.code} ${video.error?.message || ''}`);
}

async function tryPlay() {
  if (!state.playing) return;
  try {
    await video.play();
    $('#tapToPlay').hidden = true;
    report(`playing at ${video.currentTime.toFixed(1)}s`);
  } catch {
    // Autoplay with sound blocked: start muted and offer an unmute button.
    video.muted = true;
    try { await video.play(); $('#unmute').hidden = false; } catch { $('#tapToPlay').hidden = false; }
  }
}

// Sync policy: leave small drift alone, nudge gently for medium drift, seek only for large drift.
// Rate changes stay tiny (±3%) so they're inaudible, and nothing is corrected while buffering.
let baseMediaStart = 0, correcting = false, settleUntil = 0;
function sync(force = false) {
  if (!state.active || video.readyState < 1) return;
  if (state.playing && video.paused && $('#tapToPlay').hidden) tryPlay();
  if (!state.playing && !video.paused) video.pause();
  if (isLive()) return;
  if (!force && (video.seeking || video.readyState < 3 || Date.now() < settleUntil)) return;

  const target = expectedPosition() - state.offsetBase + baseMediaStart;
  const drift = video.currentTime - target;
  const abs = Math.abs(drift);
  if (force || abs > 4) {
    if (!force) report(`resync: was ${drift.toFixed(1)}s off`);
    video.currentTime = Math.max(0, target);
    video.playbackRate = 1;
    correcting = false;
    settleUntil = Date.now() + 5000; // give the decoder time before judging drift again
  } else if (abs > 1 || (correcting && abs > 0.2)) {
    correcting = true;
    video.playbackRate = drift > 0 ? 0.97 : 1.03;
  } else if (correcting || video.playbackRate !== 1) {
    correcting = false;
    video.playbackRate = 1;
  }
}

// Clock offset to the server. Each sample = true offset minus network delay, so the largest recent
// sample is the most accurate; using it keeps the target position from jittering with latency.
const skewSamples = [];
function updateSkew(serverTime) {
  if (!serverTime) return;
  skewSamples.push(serverTime - Date.now());
  if (skewSamples.length > 12) skewSamples.shift();
  clockSkew = Math.max(...skewSamples);
}

function applyState(s) {
  updateSkew(s.serverTime);
  const wasPlaying = state.playing;
  state = s;
  stateAt = Date.now();

  if (!s.active) {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    loadedVersion = null;
    $('#ui').hidden = true;
    const link = publicUrl ? `<a href="${publicUrl}/browse/" target="_blank" rel="noopener">${publicUrl.replace(/^https?:\/\//, '')}</a>` : 'the Drocsid website';
    return screen('Nothing playing yet', `Pick a movie, show or channel at ${link}, choose this voice channel, and it'll start here for everyone.`);
  }

  $('#screen').hidden = true;
  $('#ui').hidden = false;
  $('#ui').classList.toggle('viewer-only', !canControl());
  $('#title').textContent = s.title;
  $('#badge').textContent = isLive() ? 'LIVE' : `Started by ${s.startedBy}`;
  $('#badge').classList.toggle('live', isLive());
  $('#playPause').textContent = s.playing ? '⏸' : '▶';
  $('#seek').hidden = isLive();
  if (!isLive()) $('#seek').max = Math.floor(s.duration);

  if (loadedVersion !== s.playlistVersion) return loadStream();
  sync(wasPlaying !== s.playing);
}

// ---------- controls ----------
$('#playPause').onclick = () => control(state.playing ? 'pause' : 'resume');
$('#stop').onclick = () => control('stop');
$('#seek').oninput = () => { seeking = true; $('#time').textContent = `${fmt($('#seek').value)} / ${fmt(state.duration)}`; };
$('#seek').onchange = () => { seeking = false; control('seek', Number($('#seek').value)); };
$('#tapToPlay').onclick = () => { $('#tapToPlay').hidden = true; video.muted = false; tryPlay(); };
// Any click or tap in the Activity counts as the "start watching" gesture browsers require.
document.addEventListener('pointerdown', () => {
  if (!$('#tapToPlay').hidden) { $('#tapToPlay').hidden = true; video.muted = false; tryPlay(); }
  else if (!$('#unmute').hidden) { video.muted = false; $('#unmute').hidden = true; }
}, true);
$('#unmute').onclick = () => { video.muted = false; $('#unmute').hidden = true; };
$('#volume').oninput = () => {
  video.volume = Number($('#volume').value);
  try { localStorage.setItem('volume', $('#volume').value); } catch { /* storage unavailable */ }
};
try { const v = localStorage.getItem('volume'); if (v) { $('#volume').value = v; video.volume = Number(v); } } catch { /* ignore */ }

let hideTimer;
document.addEventListener('pointermove', () => {
  $('#ui').classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => $('#ui').classList.remove('show'), 2500);
});

setInterval(() => {
  if (!state.active) return;
  sync();
  if (!seeking && !isLive()) {
    const pos = expectedPosition();
    $('#seek').value = Math.floor(pos);
    $('#time').textContent = `${fmt(pos)} / ${fmt(state.duration)}`;
  } else if (isLive()) {
    $('#time').textContent = '';
  }
  if (Date.now() - stateAt > 8000) send({ type: 'sync' });
}, 1000);

// ---------- start ----------
screen('Connecting…');
signIn()
  .then((channelId) => {
    if (!channelId) return screen('Open this in a voice channel', 'Start the activity from a voice channel to watch together.');
    connect(channelId);
  })
  .catch((e) => { console.error(e); screen('Could not sign in', 'Close the activity and open it again.'); });
