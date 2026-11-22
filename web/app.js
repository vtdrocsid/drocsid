// Browse portal: Discord login, Plex libraries/search, live TV guide, and now-playing controls.
const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (hh ? `${hh}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const thumb = (p, w = 300, hh = 450) => (p ? `/api/thumb?path=${encodeURIComponent(p)}&w=${w}&h=${hh}` : '');

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, body: data });
  return data;
}
function toast(msg) {
  const t = h(`<div class="toast">${esc(msg)}</div>`);
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}

// ---------- boot ----------
let me = null;
async function boot() {
  try { me = await api('/api/me'); } catch { $('#signin').hidden = false; return; }
  $('#who').innerHTML = `${me.admin ? '<a href="/browse/admin.html" class="btn sm">Admin</a>' : ''}
    <span>${esc(me.name)}</span><button class="btn sm" id="logout">Sign out</button>`;
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); };
  if (!me.approved) { $('#denied').hidden = false; return; }
  $('#tabs').hidden = false;
  showTab(location.hash.slice(1) || 'libraries');
  pollNowPlaying();
}

function showTab(name) {
  if (!['libraries', 'search', 'live'].includes(name)) name = 'libraries';
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  history.replaceState(null, '', `#${name}`);
  if (name === 'libraries' && !libsLoaded) loadLibraries();
  if (name === 'live') loadGuide();
  if (name === 'search') $('#q').focus();
}
$('#tabs').onclick = (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };

// ---------- cards ----------
function card(item) {
  const sub = item.kind === 'show' ? `${item.childCount || ''} season${item.childCount === 1 ? '' : 's'}`
    : item.kind === 'episode' ? 'Episode' : item.year || '';
  const el = h(`<div class="card">
    <div class="poster" style="background-image:url('${thumb(item.thumb)}')">${item.kind === 'show' ? '<span class="badge">TV</span>' : ''}</div>
    <div class="t" title="${esc(item.title)}">${esc(item.kind === 'episode' ? item.title : item.shortTitle || item.title)}</div>
    <div class="s">${esc(sub)}</div></div>`);
  el.onclick = () => openDetail(item.ratingKey);
  return el;
}

// ---------- libraries ----------
let libsLoaded = false, curLib = null, libStart = 0;
async function loadLibraries() {
  libsLoaded = true;
  const libs = await api('/api/libraries');
  const box = $('#libs');
  box.innerHTML = '';
  libs.forEach((l, i) => {
    const c = h(`<button class="chip">${esc(l.title)}</button>`);
    c.onclick = () => {
      box.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      curLib = l.id;
      $('#sort').value = l.defaultSort || 'title'; // admin's default for this library; viewers can still change it
      loadItems(true);
    };
    box.append(c);
    if (i === 0) c.click();
  });
  if (!libs.length) box.textContent = 'No libraries available.';
}
async function loadItems(reset) {
  if (reset) { libStart = 0; $('#grid').innerHTML = ''; }
  const { items, total } = await api(`/api/libraries/${curLib}/items?start=${libStart}&size=60&sort=${$('#sort').value}`);
  items.forEach((it) => $('#grid').append(card(it)));
  libStart += items.length;
  $('#more').hidden = libStart >= total;
}
$('#sort').onchange = () => curLib && loadItems(true);
$('#more').onclick = () => loadItems(false);

// ---------- search ----------
let qTimer;
$('#q').oninput = () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const q = $('#q').value.trim();
    const box = $('#results');
    box.innerHTML = q ? '<p class="muted">Searching…</p>' : '';
    if (!q) return;
    const items = await api(`/api/search?q=${encodeURIComponent(q)}`);
    box.innerHTML = items.length ? '' : '<p class="muted">No matches.</p>';
    items.forEach((it) => box.append(card(it)));
  }, 300);
};

// ---------- detail ----------
async function openDetail(ratingKey) {
  const dlg = $('#detail');
  const body = $('#detailBody');
  body.innerHTML = '<p class="center muted">Loading…</p>';
  dlg.showModal();
  const { item, children } = await api(`/api/item/${ratingKey}`);
  const playable = ['movie', 'episode'].includes(item.kind);
  const dur = item.duration ? `${Math.round(item.duration / 60)} min` : '';
  body.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <div class="detail-hero" style="--art:url('${thumb(item.art, 1280, 720)}')">
      <div class="poster" style="background-image:url('${thumb(item.thumb)}')"></div>
      <div>
        <h2>${esc(item.title)}</h2>
        <div class="muted">${esc([item.year, item.contentRating, dur].filter(Boolean).join(' · '))}</div>
        <p>${esc(item.summary)}</p>
        ${playable ? '<button class="btn primary" id="playThis">▶ Play in Discord</button>' : ''}
      </div>
    </div>
    <div class="detail-body"><div class="seasons"></div><div class="eps"></div></div>`;
  $('.close', body).onclick = () => dlg.close();
  if (playable) $('#playThis').onclick = () => choosePlay({ source: 'plex', ratingKey: item.ratingKey, title: item.title });

  if (item.kind === 'show') {
    const bar = $('.seasons', body);
    children.forEach((s, i) => {
      const b = h(`<button class="chip">${esc(s.shortTitle || s.title)}</button>`);
      b.onclick = async () => {
        bar.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        showEpisodes((await api(`/api/item/${s.ratingKey}`)).children);
      };
      bar.append(b);
      if (i === 0) b.click();
    });
  } else if (item.kind === 'season') {
    showEpisodes(children);
  }
}
function showEpisodes(eps) {
  const box = $('#detailBody .eps');
  box.innerHTML = '';
  eps.forEach((e) => {
    const row = h(`<div class="ep"><div class="n">${e.index ?? ''}</div>
      <div class="info"><div>${esc(e.shortTitle || e.title)}</div><div class="sum">${esc(e.summary)}</div></div>
      <span class="muted small">${e.duration ? Math.round(e.duration / 60) + 'm' : ''}</span>
      <button class="btn sm primary">▶ Play</button></div>`);
    $('button', row).onclick = () => choosePlay({ source: 'plex', ratingKey: e.ratingKey, title: e.title });
    box.append(row);
  });
}

// ---------- play dialog ----------
async function choosePlay(target) {
  const dlg = $('#playDlg');
  $('#playTitle').textContent = `Play “${target.title}”`;
  $('#playErr').textContent = '';
  const { current, channels } = await api('/api/voice');
  const sel = $('#voiceSel');
  sel.innerHTML = channels.map((c) => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>🔊 ${esc(c.name)}${c.members.length ? ` (${c.members.length})` : ''}${c.nowPlaying.active ? ' — playing' : ''}</option>`).join('');
  $('#voiceHint').textContent = current ? 'Defaulted to the channel you are in.' : "Tip: join a voice channel in Discord first, then open Activities (🚀) to watch.";
  dlg.showModal();
  const start = async (extra = {}) => {
    await api('/api/play', { method: 'POST', body: JSON.stringify({ ...target, voiceChannelId: sel.value, ...extra }) });
    dlg.close();
    $('#detail').close();
    toast('Started. Open Activities (🚀) in that voice channel to watch.');
    pollNowPlaying(true);
  };
  $('#playGo').onclick = async (e) => {
    e.preventDefault();
    $('#playGo').disabled = true;
    $('#playErr').textContent = '';
    const extra = {};
    try {
      for (;;) {
        try { await start(extra); break; } catch (err) {
          const body = err.body || {};
          if (body.conflict === 'channel' && body.canReplace && !extra.replace && confirm(`${err.message}\n\nReplace it?`)) { extra.replace = true; continue; }
          if (body.conflict === 'user' && !extra.stopMine && confirm(`${err.message}\n\nStop it and start this instead?`)) { extra.stopMine = true; continue; }
          throw err;
        }
      }
    } catch (err) {
      $('#playErr').textContent = err.message;
    } finally { $('#playGo').disabled = false; }
  };
}

// ---------- live TV guide ----------
const PX_PER_MIN = 5;
let guideData = null;
async function loadGuide() {
  const box = $('#guide');
  if (!guideData) box.innerHTML = '<p class="center muted">Loading guide…</p>';
  try {
    const from = Math.floor((Date.now() - 30 * 60_000) / 1_800_000) * 1_800_000; // half-hour boundary
    guideData = await api(`/api/livetv/guide?hours=6&from=${from}`);
    renderGuide();
  } catch (e) { box.innerHTML = `<p class="center error">${esc(e.message)}</p>`; }
}
function renderGuide() {
  const { from, to, channels } = guideData;
  const f = $('#chfilter').value.trim().toLowerCase();
  const width = ((to - from) / 60_000) * PX_PER_MIN;
  const x = (t) => ((Math.max(from, Math.min(to, t)) - from) / 60_000) * PX_PER_MIN;
  $('#guiderange').textContent = `${clock(from)} – ${clock(to)}`;
  const box = $('#guide');
  box.innerHTML = '';

  const head = h(`<div class="g-row g-head"><div class="g-ch muted small">Channel</div><div class="g-track" style="width:${width}px;height:34px"></div></div>`);
  for (let t = from; t < to; t += 1_800_000) $('.g-track', head).append(h(`<div class="g-tick" style="left:${x(t)}px">${clock(t)}</div>`));
  box.append(head);

  const now = Date.now();
  channels
    .filter((c) => !f || c.name.toLowerCase().includes(f) || (c.number || '').startsWith(f) || (c.group || '').toLowerCase().includes(f))
    .forEach((c) => {
      const row = h(`<div class="g-row">
        <div class="g-ch">${c.thumb ? `<img loading="lazy" src="/api/logo?id=${c.id}" alt="">` : ''}
          <div class="nm"><div>${esc(c.name)}</div><div class="num">${esc(c.number || '')}</div></div>
          <button class="btn sm primary" title="Watch live">▶</button></div>
        <div class="g-track" style="width:${width}px"></div></div>`);
      $('.g-ch button', row).onclick = () => choosePlay({ source: 'live', channelId: c.id, title: c.name });
      const track = $('.g-track', row);
      if (!c.programmes.length) track.append(h(`<div class="g-prog" style="left:0;width:${width - 4}px;--w:${width - 4}px"><div class="g-in"><div class="ps">No guide data</div></div></div>`));
      c.programmes.forEach((p) => {
        const isNow = p.start <= now && p.stop > now;
        const w = Math.max(8, x(p.stop) - x(p.start) - 3);
        const el = h(`<div class="g-prog${isNow ? ' now' : ''}" style="left:${x(p.start)}px;width:${w}px;--w:${w}px">
          <div class="g-in"><div class="pt">${esc(p.title)}</div>
          <div class="ps">${clock(p.start)}–${clock(p.stop)}${p.subtitle ? ' · ' + esc(p.subtitle) : ''}</div>
          ${p.desc ? `<div class="pd">${esc(p.desc)}</div>` : ''}</div></div>`);
        el.onclick = () => choosePlay({ source: 'live', channelId: c.id, title: `${c.name}${isNow ? ' — ' + p.title : ''}` });
        track.append(el);
      });
      box.append(row);
    });

  if (now > from && now < to) {
    const line = h('<div class="g-now"></div>');
    line.style.left = `calc(var(--ch) + ${x(now)}px)`;
    box.append(line);
  }
  box.scrollLeft = Math.max(0, x(now) - 120);
}
$('#chfilter').oninput = () => guideData && renderGuide();
setInterval(() => { if (!$('#tab-live').hidden) loadGuide(); }, 5 * 60_000);

// ---------- now playing ----------
let npTimer;
let qualities = [];
async function pollNowPlaying(immediate) {
  clearTimeout(npTimer);
  try {
    const data = await api('/api/voice');
    qualities = data.qualities || qualities;
    renderNowPlaying(data.channels.filter((c) => c.nowPlaying.active));
  } catch { /* ignore */ }
  npTimer = setTimeout(pollNowPlaying, immediate ? 1500 : 5000);
}
function renderNowPlaying(active) {
  const bar = $('#np');
  bar.hidden = !active.length;
  const focused = document.activeElement;
  if (bar.contains(focused) && (focused.type === 'range' || focused.tagName === 'SELECT')) return; // don't fight the user
  bar.innerHTML = '';
  active.forEach((c) => {
    const s = c.nowPlaying;
    const mine = me && s.startedById === me.id;
    const el = h(`<div class="np-item">
      <div class="meta"><div><b>${esc(s.title)}</b></div><div class="ch">🔊 ${esc(c.name)} · started by ${esc(s.startedBy)} · ${c.members.length} in channel</div></div>
      ${mine ? `<select class="quality" title="Stream quality">${qualities.map((q) => `<option value="${q.id}" ${q.id === s.quality ? 'selected' : ''}>${esc(q.label)}</option>`).join('')}</select>
      <button class="btn sm" data-a="${s.playing ? 'pause' : 'resume'}">${s.playing ? '⏸' : '▶'}</button>` : `<span class="time">${s.playing ? '▶ Playing' : '⏸ Paused'}</span>`}
      ${s.duration ? `<input type="range" min="0" max="${Math.floor(s.duration)}" value="${Math.floor(s.position)}" ${mine ? '' : 'disabled'}>
        <span class="time">${fmt(s.position)} / ${fmt(s.duration)}</span>` : '<span class="time">LIVE</span>'}
      ${mine ? '<button class="btn sm danger" data-a="stop">Stop</button>' : ''}</div>`);
    const control = (action, seconds) => api('/api/control', { method: 'POST', body: JSON.stringify({ voiceChannelId: c.id, action, seconds }) })
      .then(() => pollNowPlaying(true)).catch((e) => toast(e.message));
    el.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => control(b.dataset.a); });
    const qSel = $('select.quality', el);
    if (qSel) qSel.onchange = () => {
      qSel.disabled = true;
      toast('Changing quality… viewers will rejoin in a few seconds');
      api('/api/control', { method: 'POST', body: JSON.stringify({ voiceChannelId: c.id, action: 'quality', quality: qSel.value }) })
        .then(() => { qSel.blur(); pollNowPlaying(true); }).catch((e) => { toast(e.message); qSel.disabled = false; });
    };
    const range = $('input[type=range]', el);
    if (range && mine) {
      range.oninput = () => { $('.time', el).textContent = `${fmt(range.value)} / ${fmt(s.duration)}`; };
      range.onchange = () => { control('seek', Number(range.value)); range.blur(); };
    }
    bar.append(el);
  });
}

boot();
