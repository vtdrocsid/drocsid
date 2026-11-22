const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2000);
}

let state;

async function save(patch) {
  try {
    state.settings = (await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) })).settings;
    toast('Saved');
    await load();
  } catch (e) { toast(e.message); }
}

function person(p, removable, onRemove) {
  const el = document.createElement('div');
  el.className = 'li';
  el.innerHTML = `${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : ''}
    <div class="grow"><div>${esc(p.name)}</div><div class="sub">${esc(p.username ? '@' + p.username + ' · ' : '')}${esc(p.id)}</div></div>
    ${removable ? '<button class="btn sm danger">Remove</button>' : '<span class="sub">Owner</span>'}`;
  if (removable) $('button', el).onclick = onRemove;
  return el;
}

/** Turn "Name (@user)" from the datalist, or a raw ID, into a user ID. */
function resolveUser(text) {
  text = text.trim();
  if (/^\d{5,25}$/.test(text)) return text;
  const m = state.directory.members.find((x) => `${x.name} (@${x.username})` === text || x.username === text || x.name === text);
  return m?.id || null;
}

function render() {
  const { settings: s, directory, valid } = state;

  // streams
  const streams = $('#streams');
  streams.innerHTML = state.streams.length ? '' : '<p class="muted">Nothing playing.</p>';
  state.streams.forEach((st) => {
    const el = document.createElement('div');
    el.className = 'li';
    el.innerHTML = `<div class="grow"><div><b>${esc(st.title)}</b> ${st.playing ? '' : '(paused)'}</div>
      <div class="sub">🔊 ${esc(st.voiceChannel)} · ${st.viewers} watching · started by ${esc(st.startedBy)} · ${st.duration ? `${fmt(st.position)} / ${fmt(st.duration)}` : 'LIVE'}</div></div>
      <button class="btn sm danger">Stop</button>`;
    $('button', el).onclick = async () => { await api('/api/admin/stop', { method: 'POST', body: JSON.stringify({ voiceChannelId: st.voiceChannelId }) }); load(); };
    streams.append(el);
  });

  // roles
  $('#roles').innerHTML = directory.roles.map((r) => `<label class="row"><input type="checkbox" value="${r.id}" ${s.approvedRoleIds.includes(r.id) ? 'checked' : ''}>
    <span style="color:${r.color === '#000000' ? 'inherit' : r.color}">${esc(r.name)}</span></label>`).join('') || '<p class="muted">No roles found.</p>';
  $('#roles').onchange = () => save({ approvedRoleIds: [...document.querySelectorAll('#roles input:checked')].map((i) => i.value) });

  // members datalist
  $('#memberList').innerHTML = directory.members.map((m) => `<option value="${esc(`${m.name} (@${m.username})`)}">`).join('');

  // users
  const users = $('#users');
  users.innerHTML = state.approvedUsers.length ? '' : '<p class="muted">None yet.</p>';
  state.approvedUsers.forEach((u) => users.append(person(u, true, () => save({ approvedUserIds: s.approvedUserIds.filter((id) => id !== u.id) }))));

  // admins
  const admins = $('#admins');
  admins.innerHTML = '';
  state.owners.forEach((u) => admins.append(person(u, false)));
  state.admins.forEach((u) => admins.append(person(u, true, () => save({ adminUserIds: s.adminUserIds.filter((id) => id !== u.id) }))));

  // libraries
  $('#libraries').innerHTML = state.libraries.map((l) => `<label class="row"><input type="checkbox" value="${l.id}" ${s.librarySections.includes(l.id) ? 'checked' : ''}>
    ${esc(l.title)} <span class="muted small">${l.type === 'show' ? 'TV' : 'Movies'}</span></label>`).join('') || '<p class="muted">Could not reach Plex.</p>';
  $('#libraries').onchange = () => save({ librarySections: [...document.querySelectorAll('#libraries input:checked')].map((i) => i.value) });

  // quality
  const srcNames = { highest: 'Highest available', 2160: 'Prefer up to 4K', 1080: 'Prefer up to 1080p', 720: 'Prefer up to 720p', 480: 'Prefer up to 480p' };
  $('#sourceMaxResolution').innerHTML = valid.sourceMaxResolution.map((v) => `<option value="${v}" ${v === s.sourceMaxResolution ? 'selected' : ''}>${srcNames[v]}</option>`).join('');
  const outNames = { original: 'Original (no transcode if compatible)', '3840x2160': '4K', '1920x1080': '1080p', '1280x720': '720p', '854x480': '480p' };
  $('#outputResolution').innerHTML = valid.outputResolution.map((v) => `<option value="${v}" ${v === s.outputResolution ? 'selected' : ''}>${outNames[v]}</option>`).join('');
  const br = $('#outputBitrate');
  if (![...br.options].some((o) => Number(o.value) === s.outputBitrate)) br.append(new Option(String(s.outputBitrate)));
  br.value = String(s.outputBitrate);
  br.disabled = s.outputResolution === 'original';
  $('#viewRequiresApproval').checked = s.viewRequiresApproval;
  $('#announceInVoiceChat').checked = s.announceInVoiceChat;

  // live
  $('#live').innerHTML = state.live.available
    ? `<p>DVR found · <b>${state.live.channels}</b> channels<br><span class="muted small">${esc(state.live.provider)}</span></p>`
    : `<p class="error">${esc(state.live.error || 'Live TV unavailable')}</p>`;
}

const addUser = (input, key) => {
  const id = resolveUser($(input).value);
  if (!id) return toast('Pick someone from the list or paste a user ID');
  if (state.settings[key].includes(id)) return toast('Already added');
  $(input).value = '';
  save({ [key]: [...state.settings[key], id] });
};
$('#userAddBtn').onclick = () => addUser('#userAdd', 'approvedUserIds');
$('#adminAddBtn').onclick = () => addUser('#adminAdd', 'adminUserIds');
$('#sourceMaxResolution').onchange = (e) => save({ sourceMaxResolution: e.target.value });
$('#outputResolution').onchange = (e) => save({ outputResolution: e.target.value });
$('#outputBitrate').onchange = (e) => save({ outputBitrate: Number(e.target.value) });
$('#applyNow').onclick = () => { if (confirm('Restart every running stream with the current quality settings?')) save({ applyNow: true }); };
$('#viewRequiresApproval').onchange = (e) => save({ viewRequiresApproval: e.target.checked });
$('#announceInVoiceChat').onchange = (e) => save({ announceInVoiceChat: e.target.checked });
$('#refreshLive').onclick = async () => {
  try {
    const r = await api('/api/admin/refresh-live', { method: 'POST' });
    toast(r.available ? `${r.channels} channels loaded` : r.error);
    load();
  } catch (e) { toast(e.message); }
};

async function load() {
  try {
    const me = await api('/api/me');
    $('#who').textContent = me.name;
    state = await api('/api/admin/state');
    $('#msg').hidden = true;
    $('#admin').hidden = false;
    if (!document.activeElement || !$('#admin').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') render();
  } catch (e) {
    if (e.status === 401) location.href = '/auth/login';
    $('#msg').textContent = e.status === 403 ? 'Admins only.' : e.message;
  }
}
load();
setInterval(() => { if (!document.hidden) load(); }, 10_000);
