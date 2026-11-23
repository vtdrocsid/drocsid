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
  // <img loading="lazy">: posters only download as they scroll into view, so long libraries stay fast.
  const el = h(`<div class="card" data-letter="${esc(firstLetter(item))}">
    <div class="poster">${item.thumb ? `<img loading="lazy" alt="" src="${thumb(item.thumb)}">` : ''}${item.kind === 'show' ? '<span class="badge">TV</span>' : ''}</div>
    <div class="t" title="${esc(item.title)}">${esc(item.kind === 'episode' ? item.title : item.shortTitle || item.title)}</div>
    <div class="s"><span>${esc(sub)}</span>${rtBadge(item.rt)}</div></div>`);
  el.onclick = () => { hideHover(true); openDetail(item.ratingKey); };
  if (['movie', 'show'].includes(item.kind)) {
    el.onmouseenter = () => scheduleHover(el, item);
    el.onmouseleave = () => leaveHover();
  }
  return el;
}

// ---------- hover card ----------
// Rest on a poster for a moment and a one-sheet pops out beside it: tagline, synopsis,
// genres, director and top cast. Details are fetched once per title and cached.
const infoCache = new Map();
const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
let hoverTimer = null, hideTimer = null, hoverFor = null, hc = null;
const getInfo = (key) => {
  if (!infoCache.has(key)) infoCache.set(key, api(`/api/info/${key}`).catch((e) => { infoCache.delete(key); throw e; }));
  return infoCache.get(key);
};
function scheduleHover(el, item) {
  if (!canHover) return;
  clearTimeout(hideTimer); clearTimeout(hoverTimer);
  if (hoverFor === el) return;
  hoverTimer = setTimeout(async () => {
    let info;
    try { info = await getInfo(item.ratingKey); } catch { return; }
    if (!el.matches(':hover')) return; // pointer moved on while loading
    showHover(el, info);
  }, hc && !hc.hidden ? 150 : 450); // already browsing cards: switch quickly
}
function leaveHover() {
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideHover(), 180); // grace period to move onto the card itself
}
function hideHover(now) {
  clearTimeout(hoverTimer); clearTimeout(hideTimer);
  if (hc) hc.hidden = true;
  if (hoverFor) hoverFor.classList.remove('hovering');
  hoverFor = null;
}
function hoverRuntime(i) {
  if (i.kind === 'show') return i.childCount ? `${i.childCount} season${i.childCount === 1 ? '' : 's'}` : '';
  if (!i.duration) return '';
  const m = Math.round(i.duration / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// Shared by the hover card and the details dialog so both read the same way.
function infoHead(i, extra = '') {
  const rt = i.rt && Number.isFinite(i.rt.score)
    ? `<div class="hc-rt"><small>${i.rt.kind === 'audience' ? 'AUDIENCE' : 'TOMATOMETER'}</small>${rtBadge(i.rt)}</div>` : '';
  const meta = [i.contentRating ? `<span class="cr">${esc(i.contentRating)}</span>` : '',
    esc([i.year, hoverRuntime(i)].filter(Boolean).join(' · '))].join('');
  const name = i.kind === 'episode' ? i.title : i.shortTitle || i.title;
  return `<div class="hc-head"><div class="hc-tt"><div class="t">${esc(name)}</div><div class="hc-meta">${meta}</div></div>${rt}${extra}</div>`;
}
function infoBody(i, castMax, clamp) {
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const cast = (i.cast || []).slice(0, castMax);
  return `${i.tagline ? `<div class="hc-tag">${esc(i.tagline)}</div>` : ''}
    ${i.summary ? `<div class="${clamp ? 'hc-syn' : 'hc-syn full'}">${esc(i.summary)}</div>` : '<div class="hc-syn muted">No synopsis available.</div>'}
    ${i.genres?.length ? `<div class="hc-genres">${i.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
    ${i.directors?.length ? `<div class="hc-lbl">Directed by</div><div class="hc-dir">${esc(i.directors.join(', '))}</div>` : ''}
    ${cast.length ? `<div class="hc-lbl">Starring</div><div class="hc-cast">${cast.map((c) => `
      <div><div class="ph">${c.face ? `<img alt="" src="/api/face/${c.face}" onerror="this.remove()">` : ''}<span>${esc(initials(c.name))}</span></div>
      <div class="nm">${esc(c.name)}</div>${c.role ? `<div class="ch">${esc(c.role)}</div>` : ''}</div>`).join('')}</div>` : ''}`;
}
function infoFoot(i, withMore) {
  const playable = ['movie', 'episode'].includes(i.kind);
  if (!playable && !withMore) return '';
  return `<div class="hc-foot">
    ${playable ? '<button class="btn primary sm" data-a="play">▶ Play</button><button class="btn sm" data-a="sched">📅 Schedule</button>'
      : '<button class="btn primary sm" data-a="more">Episodes</button>'}
    ${withMore ? '<button class="btn sm" data-a="more" style="margin-left:auto">More details</button>' : ''}
  </div>`;
}
function showHover(el, i) {
  if (!hc) {
    hc = h('<div class="hc" hidden></div>');
    hc.onmouseenter = () => clearTimeout(hideTimer);
    hc.onmouseleave = () => leaveHover();
    document.body.append(hc);
    addEventListener('scroll', () => hideHover(), true);
    addEventListener('resize', () => hideHover());
  }
  if (hoverFor) hoverFor.classList.remove('hovering');
  hoverFor = el;
  el.classList.add('hovering');
  hc.innerHTML = infoHead(i) + `<div class="hc-body">${infoBody(i, 5, true)}</div>` + infoFoot(i, true);
  hc.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = () => {
      hideHover(true);
      const t = { source: 'plex', ratingKey: i.ratingKey, title: i.title, thumb: i.thumb };
      if (b.dataset.a === 'play') choosePlay(t);
      else if (b.dataset.a === 'sched') openSchedule(t);
      else openDetail(i.ratingKey);
    };
  });
  // Place beside the poster; flip to the left near the right edge; keep it on screen vertically.
  hc.hidden = false;
  const r = el.getBoundingClientRect(), w = hc.offsetWidth, hh = hc.offsetHeight, gap = 12;
  const right = r.right + gap + w <= innerWidth - 8;
  const left = right ? r.right + gap : Math.max(8, r.left - gap - w);
  const top = Math.min(Math.max(8, r.top - 10), innerHeight - hh - 8);
  hc.classList.toggle('flip', !right);
  hc.style.left = `${left}px`;
  hc.style.top = `${top}px`;
  hc.style.setProperty('--ay', `${Math.min(Math.max(16, r.top + Math.min(70, r.height / 3) - top), hh - 30)}px`);
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
  const live = h('<button class="live" data-live="1"><span class="ico" aria-hidden="true">📡</span>Live TV</button>');
  live.onclick = () => showTab('live');
  box.append(live);
  if (!libs.length) box.prepend(h('<span class="muted small">No libraries available.</span>'));
  showTab(location.hash.slice(1) || 'libraries');
}
// Infinite scroll: a sentinel under the grid loads the next page as it nears the screen.
let libTotal = 0, loadGen = 0, loadingItems = null, letterCounts = [];
const PAGE = 60;
function firstLetter(item) {
  const c = (item.titleSort || item.shortTitle || item.title || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}
async function loadItems(reset, size = PAGE) {
  if (reset) {
    loadGen++;
    libStart = 0; libTotal = Infinity;
    $('#grid').innerHTML = '';
    loadingItems = null;
    loadLetters();
  }
  if (loadingItems) return loadingItems;
  if (libStart >= libTotal) return;
  const gen = loadGen;
  $('#more').hidden = false;
  loadingItems = (async () => {
    const { items, total } = await api(`/api/libraries/${curLib}/items?start=${libStart}&size=${size}&sort=${$('#sort').value}`);
    if (gen !== loadGen) return; // a newer library/sort replaced this one
    items.forEach((it) => $('#grid').append(card(it)));
    libStart += items.length;
    libTotal = total;
  })();
  try { await loadingItems; } catch (e) { toast(e.message); } finally { if (gen === loadGen) loadingItems = null; }
  $('#more').hidden = libStart >= libTotal;
  if (libStart < libTotal && nearBottom()) loadItems(false); // screen still not full
}
function nearBottom() {
  const r = $('#more').getBoundingClientRect();
  return !$('#more').hidden && r.top < window.innerHeight + 800;
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && curLib && !$('#tab-libraries').hidden) loadItems(false);
}, { rootMargin: '800px 0px' }).observe($('#more'));

// A–Z jump bar (only when sorted A–Z): Plex says how many titles start with each character,
// so the first title for a letter sits at the sum of the counts before it.
async function loadLetters() {
  const bar = $('#letters');
  bar.hidden = $('#sort').value !== 'title';
  if (bar.hidden) return;
  const lib = curLib;
  try { letterCounts = await api(`/api/libraries/${lib}/letters`); } catch { letterCounts = []; }
  if (lib !== curLib) return;
  const have = new Map(letterCounts.map((l) => [l.title.toUpperCase(), l.size]));
  const hasNum = letterCounts.some((l) => !/^[A-Z]$/i.test(l.title));
  bar.innerHTML = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((L) => {
    const n = L === '#' ? (hasNum ? 1 : 0) : (have.get(L) || 0);
    return `<button data-l="${L}" ${n ? '' : 'disabled'}>${L}</button>`;
  }).join('');
  bar.querySelectorAll('button').forEach((b) => { b.onclick = () => jumpTo(b.dataset.l); });
}
async function jumpTo(L) {
  // Offset of the first title for this letter = titles in all earlier characters.
  let offset = 0;
  for (const l of letterCounts) {
    const key = /^[A-Z]$/i.test(l.title) ? l.title.toUpperCase() : '#';
    if (key === L) break;
    offset += l.size;
  }
  $('#letters').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.l === L));
  while (libStart <= offset && libStart < libTotal) await loadItems(false, 300);
  const target = $('#grid').children[offset] || [...$('#grid').children].find((c) => c.dataset.letter === L);
  if (!target) return;
  window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1400);
}
$('#sort').onchange = () => curLib && loadItems(true);

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
  body.innerHTML = '<p class="center muted" style="padding:20px">Loading…</p>';
  dlg.showModal();
  const [i, { children }] = await Promise.all([getInfo(ratingKey), api(`/api/item/${ratingKey}`)]);
  const hasEps = ['show', 'season'].includes(i.kind);
  body.innerHTML = `<div class="dt">
    ${infoHead(i, '<button class="close" aria-label="Close">✕</button>')}
    <div class="dt-main">
      <div class="dt-poster">${i.thumb ? `<img alt="" src="${thumb(i.thumb)}">` : ''}</div>
      <div class="dt-info">${infoBody(i, 10, false)}</div>
    </div>
    ${hasEps ? '<div class="detail-body"><div class="seasons"></div><div class="eps"></div></div>' : ''}
    ${infoFoot(i, false)}
  </div>`;
  $('.close', body).onclick = () => dlg.close();
  body.querySelectorAll('[data-a]').forEach((b) => {
    const t = { source: 'plex', ratingKey: i.ratingKey, title: i.title, thumb: i.thumb };
    b.onclick = () => (b.dataset.a === 'play' ? choosePlay(t) : openSchedule(t));
  });

  if (i.kind === 'show') {
    const bar = $('.seasons', body);
    children.forEach((s, n) => {
      const b = h(`<button class="chip">${esc(s.shortTitle || s.title)}</button>`);
      b.onclick = async () => {
        bar.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        showEpisodes((await api(`/api/item/${s.ratingKey}`)).children);
      };
      bar.append(b);
      if (n === 0) b.click();
    });
  } else if (i.kind === 'season') {
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
  const { current, channels, textChannels = [] } = await api('/api/voice');
  const sel = $('#voiceSel');
  sel.innerHTML = channels.map((c) => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>🔊 ${esc(c.name)}${c.members.length ? ` (${c.members.length})` : ''}${c.nowPlaying.active ? ' — playing' : ''}</option>`).join('');
  $('#voiceHint').textContent = current ? 'Defaulted to the channel you are in.' : "Tip: join a voice channel in Discord first, then open Activities (🚀) to watch.";
  // Optional "now playing" post in a text channel; the last choice is remembered on this browser.
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('drocsid.announce') || '{}'); } catch {}
  const annOn = $('#annOn'), annSel = $('#annSel');
  $('#annBox').hidden = !textChannels.length;
  let lastCat = null;
  annSel.innerHTML = textChannels.map((c) => {
    const head = c.category !== lastCat ? `${lastCat !== null ? '</optgroup>' : ''}<optgroup label="${esc(c.category || 'Text channels')}">` : '';
    lastCat = c.category;
    return `${head}<option value="${c.id}">#${esc(c.name)}</option>`;
  }).join('') + (textChannels.length ? '</optgroup>' : '');
  if (textChannels.some((c) => c.id === saved.channel)) annSel.value = saved.channel;
  annOn.checked = !!saved.on && textChannels.length > 0;
  annSel.disabled = !annOn.checked;
  annOn.onchange = () => { annSel.disabled = !annOn.checked; };
  dlg.showModal();
  const start = async (extra = {}) => {
    const announceChannelId = annOn.checked ? annSel.value : undefined;
    try { localStorage.setItem('drocsid.announce', JSON.stringify({ on: annOn.checked, channel: annSel.value })); } catch {}
    await api('/api/play', { method: 'POST', body: JSON.stringify({ ...target, voiceChannelId: sel.value, announceChannelId, ...extra }) });
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

// ---------- Watching Now ----------
const AV_COLORS = ['#1a86d8', '#7b4bd6', '#2f9e6b', '#d6773b', '#c2410c', '#0e7490', '#be185d', '#4d7c0f'];
function avatar(v) {
  if (v.avatar) return `<span class="av" title="${esc(v.name)}" style="background-image:url('${esc(v.avatar)}')"></span>`;
  let n = 0; for (const ch of String(v.id || v.name)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="av" title="${esc(v.name)}" style="background-color:${AV_COLORS[n % AV_COLORS.length]}">${esc((v.name || '?').charAt(0).toUpperCase())}</span>`;
}
function dur(s) {
  s = Math.max(0, Math.round(s / 60));
  return s >= 60 ? `${Math.floor(s / 60)}h ${s % 60}m` : `${s}m`;
}
async function loadWatching() {
  const list = await api('/api/watching');
  const box = $('#watching');
  if (!list.length) { box.innerHTML = '<div class="rail-empty">Nobody\'s watching right now.</div>'; return; }
  box.innerHTML = '';
  for (const w of list) {
    const live = w.source === 'live';
    let pct = 0, left = '', right = '';
    if (live && w.progStop) {
      const now = Date.now();
      pct = ((now - w.progStart) / (w.progStop - w.progStart)) * 100;
      left = `Ends ${clock(w.progStop)}`;
      right = `${dur((w.progStop - now) / 1000)} left`;
    } else if (!live && w.duration) {
      pct = (w.position / w.duration) * 100;
      left = `${fmt(w.position)} / ${fmt(w.duration)}`;
      right = `${dur(w.duration - w.position)} left`;
    }
    const title = live && w.program ? `${w.title} — ${w.program}` : w.title;
    const names = w.viewers.map((v) => v.name).join(', ');
    const row = h(`<div class="wn-item" title="Join 🔊 ${esc(w.voiceChannelName)} in Discord and open Activities (🚀) to watch">
      ${live ? `<div class="wn-thumb logo" style="background-image:url('/api/logo?id=${encodeURIComponent(w.channelId)}')"></div>`
        : `<div class="wn-thumb" style="background-image:url('${thumb(w.thumb, 88, 132)}')"></div>`}
      <div class="wn-text">
        <div class="wn-ch"><span class="wn-dot${w.playing ? '' : ' off'}"></span>🔊 ${esc(w.voiceChannelName)}${live ? ' <span class="tag-live">LIVE</span>' : ''}</div>
        <div class="wn-title">${esc(title)}</div>
        ${left ? `<div class="wn-bar"><i style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></i></div>
        <div class="wn-meta"><span>${esc(left)}</span><span>${esc(right)}</span></div>` : ''}
        <div class="wn-who">${w.viewers.length ? `<span class="avs">${w.viewers.slice(0, 6).map(avatar).join('')}</span><em>${esc(names)}</em>`
          : `<em>started by ${esc(w.startedBy)} · no one in the player yet</em>`}${w.playing ? '' : '<b class="wn-paused">PAUSED</b>'}</div>
      </div></div>`);
    row.onclick = () => toast(`Join 🔊 ${w.voiceChannelName} in Discord, then open Activities (🚀) to watch.`);
    box.append(row);
  }
}
setInterval(() => { if (!document.hidden && me?.approved) loadWatching().catch(() => {}); }, 5000);

async function refreshRails() {
  await Promise.all([loadWatching().catch(() => {}), loadLineup().catch(() => {}), loadHistory().catch(() => {})]);
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
    // Live TV: programme title + poster, with the channel underneath. Older entries keep the channel only.
    const prog = x.source === 'live' && x.program;
    const title = prog ? x.program : x.title;
    const pic = prog && x.programPoster
      ? `<div class="r-thumb" style="background-image:url('${x.programPoster}')"></div>` : railThumb(x);
    box.append(h(`<div class="r-item">${pic}
      <div class="r-text"><div class="r-title" title="${esc(prog ? [x.program, x.subtitle].filter(Boolean).join(' — ') : title)}">${esc(title)}${x.playing ? ' <span class="tag-now">● NOW</span>' : ''}</div>
        ${prog ? `<div class="r-meta">📡 ${esc(x.title)}${x.subtitle ? ` · ${esc(x.subtitle)}` : ''}</div>` : ''}
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
