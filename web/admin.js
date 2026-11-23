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
let conns = null;      // Admin → Connections (super admins only)
let selGuild = null;   // server shown in Access by server

async function save(patch) {
  try {
    state.settings = (await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) })).settings;
    toast('Saved');
    await load();
  } catch (e) { toast(e.message); }
}

function person(p, removable, onRemove, label = 'Owner') {
  const el = document.createElement('div');
  el.className = 'li';
  el.innerHTML = `${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : ''}
    <div class="grow"><div>${esc(p.name)}</div><div class="sub">${esc(p.username ? '@' + p.username + ' · ' : '')}${esc(p.id)}</div></div>
    ${removable ? '<button class="btn sm danger">Remove</button>' : `<span class="sub">${esc(label)}</span>`}`;
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
      <div class="sub">🔊 ${esc(st.voiceChannel)}${st.guildName && (state.guilds || []).length > 1 ? ` (${esc(st.guildName)})` : ''} · ${st.viewers} watching · started by ${esc(st.startedBy)} · ${esc(st.qualityLabel)} · ${st.duration ? `${fmt(st.position)} / ${fmt(st.duration)}` : 'LIVE'}</div></div>
      <button class="btn sm danger">Stop</button>`;
    $('button', el).onclick = async () => { await api('/api/admin/stop', { method: 'POST', body: JSON.stringify({ voiceChannelId: st.voiceChannelId }) }); load(); };
    streams.append(el);
  });

  // access by server: tabs, then that server's approved roles and users
  const guilds = state.guilds || [];
  $('#noGuilds').hidden = guilds.length > 0;
  $('#guildAccess').hidden = $('#guildTabs').hidden = !guilds.length;
  if (!guilds.some((g) => g.id === selGuild)) selGuild = guilds[0]?.id || null;
  const icon = (g, cls = 'gi') => (g.icon ? `<img src="${esc(g.icon)}" alt="">` : `<span class="${cls}">${esc((g.name || '?')[0])}</span>`);
  $('#guildTabs').innerHTML = guilds.map((g) => `<button data-g="${g.id}" class="${g.id === selGuild ? 'active' : ''}">${icon(g)} ${esc(g.name)}
    <span class="cnt">· ${g.roleIds.length + g.approvedUsers.length}</span></button>`).join('');
  $('#guildTabs').querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => { selGuild = b.dataset.g; render(); }; });
  const g = guilds.find((x) => x.id === selGuild);
  if (g) {
    $('#roles').innerHTML = g.roles.map((r) => `<label class="row"><input type="checkbox" value="${r.id}" ${g.roleIds.includes(r.id) ? 'checked' : ''}>
      <span style="color:${r.color === '#000000' ? 'inherit' : r.color}">${esc(r.name)}</span></label>`).join('') || '<p class="muted">No roles found.</p>';
    $('#roles').onchange = () => save({ guildAccess: { [g.id]: { roleIds: [...document.querySelectorAll('#roles input:checked')].map((i) => i.value) } } });
    const users = $('#users');
    users.innerHTML = g.approvedUsers.length ? '' : '<p class="muted">None yet.</p>';
    const ids = g.approvedUsers.map((u) => u.id);
    g.approvedUsers.forEach((u) => users.append(person(u, true, () => save({ guildAccess: { [g.id]: { userIds: ids.filter((id) => id !== u.id) } } }))));
    const inGuild = new Set(g.memberIds);
    $('#guildMemberList').innerHTML = directory.members.filter((m) => inGuild.has(m.id)).map((m) => `<option value="${esc(`${m.name} (@${m.username})`)}">`).join('');
  }

  // members datalist (everyone the bots can see, for the admin pickers)
  $('#memberList').innerHTML = directory.members.map((m) => `<option value="${esc(`${m.name} (@${m.username})`)}">`).join('');

  // admins: super admins (owners + promoted) and regular admins
  const isSuper = state.role === 'super';
  document.querySelectorAll('.super-only').forEach((el) => { el.hidden = !isSuper; });
  $('#superAddRow').hidden = !isSuper;
  const supers = $('#supers');
  supers.innerHTML = '';
  state.owners.forEach((u) => supers.append(person(u, false)));
  state.superAdmins.forEach((u) => supers.append(person(u, isSuper, () => save({ superAdminUserIds: s.superAdminUserIds.filter((id) => id !== u.id) }), 'Super admin')));
  const admins = $('#admins');
  admins.innerHTML = state.admins.length ? '' : '<p class="muted">None yet.</p>';
  state.admins.forEach((u) => admins.append(person(u, true, () => save({ adminUserIds: s.adminUserIds.filter((id) => id !== u.id) }))));
  if (isSuper) renderConnections();
  if (!isSuper) {
    $('#viewRequiresApproval').checked = s.viewRequiresApproval;
    $('#announceInVoiceChat').checked = s.announceInVoiceChat;
    return; // no library or Live TV settings for regular admins
  }

  // libraries: shown on Browse, default sort, and order
  const sortNames = { title: 'A–Z', added: 'Recently added', released: 'Release date' };
  const libBox = $('#libraries');
  libBox.innerHTML = '';
  state.libraries.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'li';
    row.innerHTML = `<input type="checkbox" ${s.librarySections.includes(l.id) ? 'checked' : ''} title="Show on Browse page">
      <div class="grow"><div>${esc(l.title)}</div><div class="sub">${l.type === 'show' ? 'TV' : 'Movies'}${l.serverName ? ` · ${esc(l.serverName)} (${esc({ plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[l.serverType] || l.serverType)})` : ''}</div></div>
      <select title="Default sort">${valid.librarySort.map((v) => `<option value="${v}" ${v === (s.librarySort[l.id] || 'title') ? 'selected' : ''}>${sortNames[v]}</option>`).join('')}</select>
      <button class="btn sm" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
      <button class="btn sm" data-move="1" ${i === state.libraries.length - 1 ? 'disabled' : ''} title="Move down">↓</button>`;
    $('input', row).onchange = () => save({ librarySections: state.libraries.filter((x, j) => libBox.children[j].querySelector('input').checked).map((x) => x.id) });
    $('select', row).onchange = (e) => save({ librarySort: { [l.id]: e.target.value } });
    row.querySelectorAll('[data-move]').forEach((b) => {
      b.onclick = () => {
        const ids = state.libraries.map((x) => x.id);
        const j = i + Number(b.dataset.move);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        save({ libraryOrder: ids });
      };
    });
    libBox.append(row);
  });

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
$('#userAddBtn').onclick = () => {
  const g = (state.guilds || []).find((x) => x.id === selGuild);
  if (!g) return;
  const id = resolveUser($('#userAdd').value);
  if (!id) return toast('Pick someone from the list or paste a user ID');
  const ids = g.approvedUsers.map((u) => u.id);
  if (ids.includes(id)) return toast('Already approved in this server');
  $('#userAdd').value = '';
  save({ guildAccess: { [g.id]: { userIds: [...ids, id] } } });
};

// ---------- Connections (super admins) ----------
function renderConnections() {
  if (!conns) return;
  const firstPlex = conns.mediaServers.find((x) => x.type === 'plex')?.id;
  $('#pubUrl').textContent = conns.publicUrl || 'Not set';
  const icon = (g) => (g.icon ? `<img src="${esc(g.icon)}" alt="">` : `<span class="gi">${esc((g.name || '?')[0])}</span>`);
  const apps = $('#apps');
  apps.innerHTML = conns.discordApps.length ? '' : '<p class="muted">No Discord apps.</p>';
  conns.discordApps.forEach((a) => {
    const pill = a.status === 'online' ? '<span class="pill">Online</span>' : a.status === 'error' ? '<span class="pill off">Error</span>' : '<span class="pill wait">Starting</span>';
    const el = document.createElement('div');
    el.className = 'li';
    el.innerHTML = `${a.user?.avatar ? `<img src="${esc(a.user.avatar)}" alt="" style="border-radius:50%">` : `<span class="ic">${esc((a.name || '?')[0])}</span>`}
      <div class="grow"><div><b>${esc(a.name)}</b> ${pill} ${a.primary ? '<span class="pill wait" title="Used for Sign in with Discord on the website">Web sign-in</span>' : ''}</div>
        <div class="sub">${esc(a.user?.tag || a.botUser || '')} · App ID ${esc(a.id)}${a.error ? ` · <span class="error">${esc(a.error)}</span>` : ''}</div>
        <div class="gchips">${a.guilds.length ? a.guilds.map((g) => `<span class="gchip">${icon(g)}${esc(g.name)}</span>`).join('') : '<span class="sub">Not in any server yet</span>'}</div></div>
      <div class="acts">
        <a class="btn sm" href="${esc(a.invite)}" target="_blank" rel="noopener">Invite to server</a>
        <a class="btn sm" href="/setup/?add=discord&app=${encodeURIComponent(a.id)}">Edit</a>
        ${a.primary ? '' : '<button class="btn sm" data-act="primary">Use for web sign-in</button>'}
        <button class="btn sm danger" data-act="remove">Remove</button>
      </div>`;
    el.querySelector('[data-act=primary]')?.addEventListener('click', () => connAct(`/api/connections/discord/${a.id}/primary`, 'POST'));
    el.querySelector('[data-act=remove]').onclick = () => {
      if (confirm(`Remove ${a.name}? Its bot goes offline and streams in its servers stop working.`)) connAct(`/api/connections/discord/${a.id}`, 'DELETE');
    };
    apps.append(el);
  });
  const media = $('#media');
  media.innerHTML = conns.mediaServers.length ? '' : '<p class="muted">No media server connected.</p>';
  const TYPE = { plex: ['Plex', 'plex', '▶'], jellyfin: ['Jellyfin', 'jf', 'J'], emby: ['Emby', 'emby', 'E'] };
  conns.mediaServers.forEach((p) => {
    const [typeName, cls, letter] = TYPE[p.type] || [p.type, '', '?'];
    const el = document.createElement('div');
    el.className = 'li';
    const h = plexHealth[p.id];
    el.innerHTML = `<span class="ic ${cls}">${letter}</span>
      <div class="grow"><div><b>${esc(p.name)}</b> <span class="muted small">${typeName}</span> ${h ? (h.ok ? '<span class="pill">Online</span>' : '<span class="pill off">Offline</span>') : '<span class="pill wait">Checking</span>'}</div>
        <div class="sub">${esc(p.url)}${p.username ? ` · as ${esc(p.username)}` : ''}${h?.ok ? ` · ${h.libraries} movie/TV ${h.libraries === 1 ? 'library' : 'libraries'} · ${h.ms} ms` : h?.error ? ` · <span class="error">${esc(h.error)}</span>` : ''}${p.id === firstPlex ? ' · Live TV' : ''}</div></div>
      <div class="acts">
        <button class="btn sm" data-act="test">Test</button>
        <a class="btn sm" href="/setup/?add=media&server=${encodeURIComponent(p.id)}">Edit</a>
        <button class="btn sm danger" data-act="remove">Remove</button>
      </div>`;
    el.querySelector('[data-act=test]').onclick = () => checkPlex(p, true);
    el.querySelector('[data-act=remove]').onclick = () => {
      if (confirm(`Remove ${p.name}? Its libraries disappear from Browse, and anything playing from it stops working.`)) connAct(`/api/connections/media/${encodeURIComponent(p.id)}`, 'DELETE');
    };
    media.append(el);
  });
}
const plexHealth = {};
async function checkPlex(p, announce = false) {
  try { plexHealth[p.id] = await api(`/api/connections/media/${encodeURIComponent(p.id)}/health`); }
  catch (e) { plexHealth[p.id] = { ok: false, error: e.message }; }
  if (announce) toast(plexHealth[p.id].ok ? `${p.name} is online` : plexHealth[p.id].error);
  renderConnections();
}
async function connAct(url, method, body) {
  try { conns = { ...conns, ...(await api(url, { method, body: body ? JSON.stringify(body) : undefined })) }; toast('Saved'); load(); }
  catch (e) { toast(e.message); }
}
$('#pubEdit').onclick = () => {
  const url = prompt('Public https address (no path):', conns?.publicUrl || '');
  if (url) connAct('/api/connections/public-url', 'PUT', { publicUrl: url });
};
$('#adminAddBtn').onclick = () => {
  const id = resolveUser($('#adminAdd').value);
  if (id && (state.settings.superAdminUserIds.includes(id) || state.owners.some((o) => o.id === id))) return toast('Already a super admin');
  addUser('#adminAdd', 'adminUserIds');
};
$('#superAddBtn').onclick = () => addUser('#superAdd', 'superAdminUserIds');
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
    $('#who').innerHTML = `Signed in as <b>${esc(me.name)}</b>`;
    const d = new Date();
    $('#today').textContent = `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${d.toLocaleDateString('en-US', { month: 'long' })} ${d.getDate()}, ${d.getFullYear()}`;
    if (me.version) { const v = document.createElement('span'); v.className = 'ver'; v.textContent = ` · v${me.version}`; $('#today').append(v); }
    state = await api('/api/admin/state');
    if (state.role === 'super') {
      const first = !conns;
      conns = await api('/api/connections').catch(() => conns);
      if (first) conns?.mediaServers.forEach((p) => checkPlex(p));
    }
    $('#msg').hidden = true;
    $('#admin').hidden = false;
    if (!document.activeElement || !$('#admin').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') render();
  } catch (e) {
    if (e.status === 401) location.href = '/auth/login';
    $('#msg').textContent = e.status === 403 ? 'Admins only.' : e.message;
  }
}
load().then(() => { if (location.hash === '#connections') $('#connections')?.scrollIntoView(); });
setInterval(() => { if (!document.hidden) load(); }, 10_000);
