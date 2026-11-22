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
  $('#today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).replace(/,/g, '');
  try { me = await api('/api/me'); } catch { $('#signin').hidden = false; return; }
  $('#who').innerHTML = `<span>Signed in as <b>${esc(me.name)}</b></span><button class="btn sm" id="logout">Sign out</button>`;
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); };
  if (!me.approved) { $('#denied').hidden = false; return; }
  $('#adminLink').hidden = !me.admin;
  $('#qwrap').hidden = false;
  $('#layout').hidden = false;
  loadLibraries();
  showTab(location.hash.slice(1) || 'libraries');
  pollNowPlaying();
  refreshRails();
  setInterval(refreshRails, 30_000);
}

function showTab(name) {
  if (!['libraries', 'live'].includes(name)) name = 'libraries';
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#libs button').forEach((b) => b.classList.toggle('active', name === 'live' ? b.dataset.live === '1' : b === curLibEl));
  $('#sort').hidden = name === 'live';
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  history.replaceState(null, '', `#${name}`);
  if (name === 'libraries' && !libsLoaded) loadLibraries();
  if (name === 'live') loadGuide();
}
$('#tabs').onclick = (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };

// ---------- cards ----------
/** Rotten Tomatoes badge: tomato (fresh) or green splat (rotten); popcorn for audience scores. */
function rtBadge(rt) {
  if (!rt || !Number.isFinite(rt.score)) return '';
  const icon = rt.kind === 'audience'
    ? `<span class="pop">${rt.fresh ? '🍿' : '🫗'}</span>`
    : (rt.fresh ? '<span class="rt-tomato" aria-hidden="true"></span>' : '<span class="rt-splat" aria-hidden="true"></span>');
  const label = `${rt.kind === 'audience' ? 'Audience score' : 'Tomatometer'} ${rt.score}%${rt.fresh ? '' : ' (rotten)'}`;
  return `<span class="rt ${rt.fresh ? 'fresh' : 'rotten'}" title="${label}">${icon}${rt.score}%</span>`;
}
function card(item) {
  const sub = item.kind === 'show' ? `${item.childCount || ''} season${item.childCount === 1 ? '' : 's'}`
    : item.kind === 'episode' ? 'Episode' : item.year || '';
  const el = h(`<div class="card">
    <div class="poster" style="background-image:url('${thumb(item.thumb)}')">${item.kind === 'show' ? '<span class="badge">TV</span>' : ''}</div>
    <div class="t" title="${esc(item.title)}">${esc(item.kind === 'episode' ? item.title : item.shortTitle || item.title)}</div>
    <div class="s"><span>${esc(sub)}</span>${rtBadge(item.rt)}</div></div>`);
  el.onclick = () => openDetail(item.ratingKey);
  return el;
}

// ---------- libraries ----------
let libsLoaded = false, curLib = null, curLibEl = null, libStart = 0;
async function loadLibraries() {
  libsLoaded = true;
  const libs = await api('/api/libraries');
  const box = $('#libs');
  box.innerHTML = '';
  libs.forEach((l, i) => {
    const c = h(`<button>${esc(l.title)}</button>`);
    c.onclick = (ev) => {
      curLib = l.id;
      curLibEl = c;
      $('#secTitle').textContent = l.title;
      $('#sort').value = l.defaultSort || 'title'; // admin's default for this library; viewers can still change it
      if (ev?.isTrusted || $('#tab-live').hidden) showTab('libraries');
      loadItems(true);
    };
    box.append(c);
    if (i === 0) c.click();
  });
  const live = h('<button class="live" data-live="1">📡 Live TV</button>');
  live.onclick = () => showTab('live');
  box.append(live);
  if (!libs.length) box.prepend(h('<span class="muted small">No libraries available.</span>'));
  showTab(location.hash.slice(1) || 'libraries');
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

// ---------- search (top bar, live results, max 7) ----------
const MAX_RESULTS = 7;
let qTimer, qSeq = 0, qActive = -1;
const qres = $('#qres');
function closeResults() { qres.hidden = true; qActive = -1; }
function highlight(i) {
  const rows = [...qres.querySelectorAll('.qrow')];
  if (!rows.length) return;
  qActive = (i + rows.length) % rows.length;
  rows.forEach((r, j) => r.classList.toggle('active', j === qActive));
  rows[qActive].scrollIntoView({ block: 'nearest' });
}
$('#q').oninput = () => {
  clearTimeout(qTimer);
  const q = $('#q').value.trim();
  if (!q) return closeResults();
  qTimer = setTimeout(async () => {
    const seq = ++qSeq;
    let items = [];
    try { items = await api(`/api/search?q=${encodeURIComponent(q)}`); } catch { /* ignore */ }
    if (seq !== qSeq) return; // a newer search is already running
    qres.innerHTML = '';
    qActive = -1;
    if (!items.length) qres.append(h('<div class="qempty">No matches</div>'));
    items.slice(0, MAX_RESULTS).forEach((it) => {
      const kind = { movie: 'Movie', show: 'TV show', season: 'Season', episode: 'Episode' }[it.kind] || '';
      const row = h(`<div class="qrow">
        <div class="qthumb" style="background-image:url('${thumb(it.thumb, 80, 120)}')"></div>
        <div class="qtext"><div class="qt">${esc(it.kind === 'episode' ? it.title : it.shortTitle || it.title)}</div>
        <div class="qs">${esc([kind, it.year].filter(Boolean).join(' · '))}</div></div></div>`);
      row.onmousedown = (e) => { e.preventDefault(); closeResults(); openDetail(it.ratingKey); };
      qres.append(row);
    });
    qres.hidden = false;
  }, 250);
};
$('#q').onkeydown = (e) => {
  if (qres.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight(qActive + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(qActive - 1); }
  else if (e.key === 'Enter') { const r = qres.querySelectorAll('.qrow')[qActive < 0 ? 0 : qActive]; if (r) r.onmousedown(e); }
  else if (e.key === 'Escape') closeResults();
};
$('#q').onfocus = () => { if ($('#q').value.trim() && qres.children.length) qres.hidden = false; };
$('#q').onblur = () => setTimeout(closeResults, 100);

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
        ${playable ? '<div class="row"><button class="btn primary" id="playThis">▶ Play in Discord</button><button class="btn" id="schedThis">📅 Schedule…</button></div>' : ''}
      </div>
    </div>
    <div class="detail-body"><div class="seasons"></div><div class="eps"></div></div>`;
  $('.close', body).onclick = () => dlg.close();
  if (playable) {
    $('#playThis').onclick = () => choosePlay({ source: 'plex', ratingKey: item.ratingKey, title: item.title });
    $('#schedThis').onclick = () => openSchedule({ source: 'plex', ratingKey: item.ratingKey, title: item.title, thumb: item.thumb });
  }

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
      <button class="btn sm" title="Schedule">📅</button><button class="btn sm primary">▶ Play</button></div>`);
    const [schedBtn, playBtn] = row.querySelectorAll('button');
    playBtn.onclick = () => choosePlay({ source: 'plex', ratingKey: e.ratingKey, title: e.title });
    schedBtn.onclick = () => openSchedule({ source: 'plex', ratingKey: e.ratingKey, title: e.title, thumb: e.thumb });
    box.append(row);
  });
}

// ---------- play dialog ----------
async function choosePlay(target) {
  const dlg = $('#playDlg');
  $('#playTitle').textContent = `Play: ${target.title}`;
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
const GUIDE_HOURS = 12;
const STEP_PX = 60 * PX_PER_MIN; // one hour per arrow click
let guideData = null;
async function loadGuide() {
  const box = $('#guide');
  if (!guideData) box.innerHTML = '<p class="center muted">Loading guide…</p>';
  try {
    const from = Math.floor((Date.now() - 30 * 60_000) / 1_800_000) * 1_800_000; // half-hour boundary
    guideData = await api(`/api/livetv/guide?hours=${GUIDE_HOURS}&from=${from}`);
    renderGuide();
  } catch (e) { box.innerHTML = `<p class="center error">${esc(e.message)}</p>`; }
}

// Layout: a fixed timeline header (with ◀ ▶ buttons) above a body that only scrolls vertically.
// Horizontal movement is by the buttons; header and body are kept aligned in code.
function renderGuide() {
  const { from, to, channels } = guideData;
  const f = $('#chfilter').value.trim().toLowerCase();
  const width = ((to - from) / 60_000) * PX_PER_MIN;
  const x = (t) => ((Math.max(from, Math.min(to, t)) - from) / 60_000) * PX_PER_MIN;
  const box = $('#guide');
  const keepLeft = $('.g-body', box)?.scrollLeft;
  const keepTop = $('.g-body', box)?.scrollTop;
  box.innerHTML = `
    <div class="g-top">
      <div class="g-headwrap">
        <div class="g-row g-head">
          <div class="g-ch muted small">Channel<button class="g-nav prev" title="Earlier">◀</button></div>
          <div class="g-track" style="width:${width}px;height:34px"></div>
        </div>
      </div>
      <div class="g-endcol"><button class="g-nav next" title="Later">▶</button></div>
    </div>
    <div class="g-body"></div>`;
  const headwrap = $('.g-headwrap', box), body = $('.g-body', box);
  for (let t = from; t < to; t += 1_800_000) $('.g-track', headwrap).append(h(`<div class="g-tick" style="left:${x(t)}px">${clock(t)}</div>`));

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
        el.dataset.left = x(p.start);
        el.dataset.width = w;
        // Details pop up only for blocks squeezed at the left edge: scrolled under the channel column
        // AND too narrow to show the title in full.
        el.onmouseenter = () => {
          const t = $('.pt', el);
          if (Number(el.dataset.shift) > 0 && t && t.scrollWidth > t.clientWidth + 1) el.classList.add('expand');
        };
        el.onmouseleave = () => el.classList.remove('expand');
        // Now/past: watch the channel. Future: schedule that channel for the programme's start.
        el.onclick = () => (p.start > Date.now() + 60_000
          ? openSchedule({ source: 'live', channelId: c.id, title: `${c.name} — ${p.title}`, logo: c.thumb ? c.id : null }, p.start)
          : choosePlay({ source: 'live', channelId: c.id, title: `${c.name}${isNow ? ' — ' + p.title : ''}` }));
        track.append(el);
      });
      body.append(row);
    });

  if (now > from && now < to) {
    const line = h('<div class="g-now"></div>');
    line.style.left = `calc(var(--ch) + ${x(now)}px)`;
    body.append(line);
    line.style.height = `${body.scrollHeight}px`;
  }

  const maxLeft = () => Math.max(0, body.scrollWidth - body.clientWidth);
  const onMove = () => {
    headwrap.scrollLeft = body.scrollLeft;
    $('.g-nav.prev', box).disabled = body.scrollLeft <= 0;
    $('.g-nav.next', box).disabled = body.scrollLeft >= maxLeft() - 1;
    const visFrom = from + (body.scrollLeft / PX_PER_MIN) * 60_000;
    const visTo = Math.min(to, visFrom + ((body.clientWidth - $('.g-ch', body)?.offsetWidth || 0) / PX_PER_MIN) * 60_000);
    $('#guiderange').textContent = `${clock(visFrom)} – ${clock(visTo)}`;
    if (!slideQueued) { slideQueued = true; requestAnimationFrame(slideLabels); }
  };
  body.onscroll = onMove;
  $('.g-nav.prev', box).onclick = () => body.scrollTo({ left: Math.max(0, body.scrollLeft - STEP_PX), behavior: 'smooth' });
  $('.g-nav.next', box).onclick = () => body.scrollTo({ left: Math.min(maxLeft(), body.scrollLeft + STEP_PX), behavior: 'smooth' });

  body.scrollLeft = keepLeft ?? Math.max(0, x(now) - 120);
  if (keepTop) body.scrollTop = keepTop;
  onMove();
}

// Keep each show's label in view: when a block starts left of the visible area (under the channel
// column), move its label to the visible edge and shorten it to the space left.
let slideQueued = false;
function slideLabels() {
  slideQueued = false;
  const box = $('#guide .g-body');
  if (!box) return;
  const visibleStart = box.scrollLeft; // track x that sits right at the channel column's edge
  box.querySelectorAll('.g-prog[data-left]').forEach((el) => {
    const left = Number(el.dataset.left), width = Number(el.dataset.width);
    const shift = Math.max(0, Math.min(visibleStart - left, width - 24));
    if (Number(el.dataset.shift || 0) === shift) return;
    el.dataset.shift = shift;
    const inner = $('.g-in', el);
    inner.style.marginLeft = shift ? `${shift}px` : '';
    inner.style.maxWidth = shift ? `${width - shift}px` : '';
  });
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

// ---------- side rails: upcoming lineup (left) and play history (right) ----------
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayOf(ms, past = false) {
  const d = new Date(ms), today = new Date();
  const days = Math.round((new Date(d.toDateString()) - new Date(today.toDateString())) / 86400_000);
  if (days === 0) return past ? 'Today' : (d.getHours() >= 17 ? 'Tonight' : 'Today');
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const railThumb = (x) => (x.source === 'live'
  ? `<div class="r-thumb logo" style="background-image:url('/api/logo?id=${encodeURIComponent(x.channelId)}')"></div>`
  : `<div class="r-thumb" style="background-image:url('${thumb(x.thumb, 80, 120)}')"></div>`);

async function refreshRails() {
  await Promise.all([loadLineup().catch(() => {}), loadHistory().catch(() => {})]);
}

async function loadLineup() {
  const items = await api('/api/schedule');
  const box = $('#lineup');
  box.innerHTML = items.length ? '' : '<div class="rail-empty">Nothing scheduled yet. Open a title (or a future show in the TV guide) and choose 📅 Schedule.</div>';
  let day = null;
  items.forEach((x) => {
    const d = dayOf(x.at);
    if (d !== day) { box.append(h(`<div class="r-day">${esc(d)}</div>`)); day = d; }
    const row = h(`<div class="r-item">${railThumb(x)}
      <div class="r-text"><div class="r-time">${timeOf(x.at)}${x.source === 'live' ? ' <span class="tag-live">LIVE TV</span>' : ''}</div>
        <div class="r-title" title="${esc(x.title)}">${esc(x.title)}</div>
        <div class="r-meta">🔊 ${esc(x.voiceChannelName)} · by ${esc(x.by)}</div></div>
      ${x.canDelete ? '<button class="r-del" title="Remove from lineup">✕</button>' : ''}</div>`);
    const del = $('.r-del', row);
    if (del) del.onclick = async () => {
      if (!confirm(`Remove “${x.title}” from the lineup?`)) return;
      try { await api(`/api/schedule/${x.id}`, { method: 'DELETE' }); toast('Removed from lineup'); loadLineup(); } catch (e) { toast(e.message); }
    };
    box.append(row);
  });
}

async function loadHistory() {
  const items = await api('/api/history?limit=25');
  const box = $('#history');
  box.innerHTML = items.length ? '' : '<div class="rail-empty">Nothing has been played yet.</div>';
  items.forEach((x) => {
    const when = x.playing ? 'Now playing' : `${dayOf(x.startedAt, true)} ${timeOf(x.startedAt)}`;
    box.append(h(`<div class="r-item">${railThumb(x)}
      <div class="r-text"><div class="r-title" title="${esc(x.title)}">${esc(x.title)}${x.playing ? ' <span class="tag-now">● NOW</span>' : ''}</div>
        <div class="r-meta">${esc(when)} · started by <b>${esc(x.startedBy)}</b>${x.scheduled ? ' 📅' : ''}</div>
        <div class="r-meta">🔊 ${esc(x.voiceChannelName || '')}</div>
        ${x.watchers?.length ? `<div class="r-who">👥 ${esc(x.watchers.join(', '))}</div>` : ''}</div></div>`));
  });
}

// ---------- schedule dialog ----------
let schedTarget = null, schedTimer;
const localInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function setSchedTarget(t) {
  schedTarget = t;
  $('#schedPick').hidden = !!t;
  $('#schedChosen').hidden = !t;
  if (t) {
    const img = t.source === 'live' ? (t.logo ? `/api/logo?id=${encodeURIComponent(t.channelId)}` : '') : thumb(t.thumb, 80, 120);
    $('#schedChosen').innerHTML = `<div class="qthumb" style="background-image:url('${img}')"></div><div><b>${esc(t.title)}</b></div><button type="button" class="btn sm">Change</button>`;
    $('#schedChosen button').onclick = () => { setSchedTarget(null); $('#schedQ').value = ''; $('#schedQ').focus(); };
  }
}
async function openSchedule(target = null, at = null) {
  $('#detail').open && $('#detail').close();
  setSchedTarget(target);
  $('#schedErr').textContent = '';
  $('#schedRes').hidden = true;
  const { current, channels } = await api('/api/voice');
  $('#schedVoice').innerHTML = channels.map((c) => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>🔊 ${esc(c.name)}</option>`).join('');
  const nextHalfHour = Math.ceil((Date.now() + 5 * 60_000) / 1_800_000) * 1_800_000;
  $('#schedAt').value = localInput(at || nextHalfHour);
  $('#schedAt').min = localInput(Date.now() + 60_000);
  $('#schedDlg').showModal();
  if (!target) $('#schedQ').focus();
}
$('#schedNew').onclick = () => openSchedule();
$('#schedQ').oninput = () => {
  clearTimeout(schedTimer);
  const q = $('#schedQ').value.trim();
  if (!q) { $('#schedRes').hidden = true; return; }
  schedTimer = setTimeout(async () => {
    const items = (await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => [])).filter((it) => ['movie', 'episode'].includes(it.kind)).slice(0, 7);
    const box = $('#schedRes');
    box.innerHTML = items.length ? '' : '<div class="qempty">No movies or episodes match</div>';
    items.forEach((it) => {
      const row = h(`<div class="qrow"><div class="qthumb" style="background-image:url('${thumb(it.thumb, 80, 120)}')"></div>
        <div class="qtext"><div class="qt">${esc(it.title)}</div><div class="qs">${it.kind === 'episode' ? 'Episode' : 'Movie'}${it.year ? ' · ' + it.year : ''}</div></div></div>`);
      row.onmousedown = (e) => { e.preventDefault(); box.hidden = true; setSchedTarget({ source: 'plex', ratingKey: it.ratingKey, title: it.title, thumb: it.thumb }); };
      box.append(row);
    });
    box.hidden = false;
  }, 250);
};
$('#schedGo').onclick = async (e) => {
  e.preventDefault();
  $('#schedErr').textContent = '';
  if (!schedTarget) { $('#schedErr').textContent = 'Pick a movie or episode first.'; return; }
  const at = new Date($('#schedAt').value).getTime();
  if (!at) { $('#schedErr').textContent = 'Pick a date and time.'; return; }
  $('#schedGo').disabled = true;
  try {
    await api('/api/schedule', { method: 'POST', body: JSON.stringify({ ...schedTarget, voiceChannelId: $('#schedVoice').value, at }) });
    $('#schedDlg').close();
    toast(`Added to the lineup for ${dayOf(at)} at ${timeOf(at)}`);
    loadLineup();
  } catch (err) {
    $('#schedErr').textContent = err.message;
  } finally { $('#schedGo').disabled = false; }
};

boot();
