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

let token = null, ws = null, hls = null, canControl = false, publicUrl = '';
let state = { active: false }, stateAt = 0, clockSkew = 0, loadedVersion = null, seeking = false;

function screen(title, html = '') {
  $('#screen').hidden = false;
  $('#screenTitle').textContent = title;
  $('#screenText').innerHTML = html;
}

// ---------- sign in ----------
async function signIn() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  publicUrl = cfg.publicUrl;
  const sdk = new DiscordSDK(cfg.clientId);
  await sdk.ready();
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
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') {
      canControl = msg.canControl;
      $('#ui').classList.toggle('viewer-only', !canControl);
    }
    if (msg.type === 'state') applyState(msg.state);
    if (msg.type === 'error') console.warn(msg.error);
  };
  ws.onclose = (e) => {
    if (e.code === 4003) return screen("Can't watch here", e.reason === 'not approved' ? 'An admin needs to approve you before you can watch.' : 'Join the voice channel first.');
    screen('Reconnecting…');
    setTimeout(() => connect(channelId), 2000);
  };
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const control = (action, seconds) => canControl && send({ type: 'control', action, seconds });

// ---------- playback ----------
function expectedPosition() {
  if (!state.active) return 0;
  if (!state.playing) return state.position;
  const serverNow = Date.now() + clockSkew;
  return state.position + (serverNow - state.serverTime) / 1000;
}
const mediaStart = () => (video.seekable.length ? video.seekable.start(0) : 0);
const isLive = () => state.source === 'live';

function loadStream() {
  loadedVersion = state.playlistVersion;
  if (hls) { hls.destroy(); hls = null; }
  const src = `/media/t/${encodeURIComponent(token)}/${state.playlist}`;
  if (Hls.isSupported()) {
    hls = new Hls({
      maxBufferLength: 30,
      liveSyncDuration: 6,
      startPosition: isLive() ? -1 : Math.max(0, expectedPosition() - state.offsetBase),
    });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls?.startLoad(), 1500);
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else { console.error(d); setTimeout(loadStream, 2000); }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src; // Safari / iOS Discord: native HLS
  }
  video.addEventListener('loadedmetadata', () => { sync(true); tryPlay(); }, { once: true });
}

async function tryPlay() {
  if (!state.playing) return;
  try {
    await video.play();
    $('#tapToPlay').hidden = true;
  } catch {
    // Autoplay with sound blocked: start muted and offer an unmute button.
    video.muted = true;
    try { await video.play(); $('#unmute').hidden = false; } catch { $('#tapToPlay').hidden = false; }
  }
}

function sync(force = false) {
  if (!state.active || video.readyState < 1) return;
  if (state.playing && video.paused && $('#tapToPlay').hidden) tryPlay();
  if (!state.playing && !video.paused) video.pause();
  if (isLive()) return;

  const target = expectedPosition() - state.offsetBase + mediaStart();
  const drift = video.currentTime - target;
  if (force || Math.abs(drift) > 2) {
    video.currentTime = Math.max(0, target);
    video.playbackRate = 1;
  } else if (Math.abs(drift) > 0.3) {
    video.playbackRate = drift > 0 ? 0.95 : 1.05; // ease back into sync without a visible jump
  } else {
    video.playbackRate = 1;
  }
}

function applyState(s) {
  clockSkew = s.serverTime ? s.serverTime - Date.now() : clockSkew;
  const wasPlaying = state.playing;
  state = s;
  stateAt = Date.now();

  if (!s.active) {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    loadedVersion = null;
    $('#ui').hidden = true;
    const link = publicUrl ? `<a href="${publicUrl}/browse/" target="_blank" rel="noopener">${publicUrl.replace(/^https?:\/\//, '')}</a>` : 'the Plexcord website';
    return screen('Nothing playing yet', `Pick a movie, show or channel at ${link}, choose this voice channel, and it'll start here for everyone.`);
  }

  $('#screen').hidden = true;
  $('#ui').hidden = false;
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
