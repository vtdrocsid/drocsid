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
  $('#guildAccess').hidden = !guilds.length;
  $('#guildTabs').hidden = guilds.length < 2;
  $('#accessTitle').textContent = state.role === 'super' || guilds.length !== 1 ? 'Access by server' : `Access · ${guilds[0].name}`;
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
    const gAdmins = $('#gAdmins');
    gAdmins.innerHTML = g.admins.length ? '' : '<p class="muted">None yet.</p>';
    g.admins.forEach((u) => gAdmins.append(person(u, true, () => save({ guildAccess: { [g.id]: { adminIds: g.adminIds.filter((id) => id !== u.id) } } }))));
    $('#gViewReq').checked = !!g.viewRequiresApproval;
    $('#gAnnounce').checked = !!g.announceInVoiceChat;
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
  if (isSuper) renderConnections();
  if (!isSuper) return; // no library, Live TV or connection settings for regular admins

  renderLibraries();
  renderPosters();
}

// ---------- libraries: one panel per media server ----------
const SERVER_ICON = { plex: ['Plex', 'plex', '▶'], jellyfin: ['Jellyfin', 'jf', 'J'], emby: ['Emby', 'emby', 'E'] };
function renderLibraries() {
  const { settings: s, valid } = state;
  const sortNames = { title: 'A–Z', added: 'Recently added', released: 'Release date' };
  const all = state.libraries; // grouped by server, in server order
  const groups = [];
  for (const l of all) {
    let g = groups.find((x) => x.server === l.server);
    if (!g) groups.push(g = { server: l.server, name: l.serverName || '', type: l.serverType, libs: [] });
    g.libs.push(l);
  }
  const box = $('#libPanels');
  box.innerHTML = '';
  const checked = () => [...box.querySelectorAll('input[data-lib]:checked')].map((i) => i.dataset.lib);
  const liveFor = (serverId) => (state.live || []).find((x) => x.server === serverId);
  groups.forEach((g) => {
    const [typeName, cls, letter] = SERVER_ICON[g.type] || [g.type, '', '?'];
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<h2 class="h-srv"><span class="srv-ic sm ${cls}">${letter}</span>Libraries${groups.length > 1 ? ` · ${esc(g.name || typeName)}` : ''}</h2>
      <p class="desc">Tick the libraries${g.libs.some((l) => l.type === 'live') ? ' (and Live TV)' : ''} to show on the Browse page (none ticked anywhere = show all), pick each one's default sort, and use ↑ ↓ to set their order. The top one opens first.</p>
      <div class="list"></div>`;
    const list = $('.list', panel);
    const lastLib = g.libs.map((l) => l.type).lastIndexOf('movie') > g.libs.map((l) => l.type).lastIndexOf('show')
      ? g.libs.map((l) => l.type).lastIndexOf('movie') : g.libs.map((l) => l.type).lastIndexOf('show'); // Live TV always comes last
    g.libs.forEach((l, i) => {
      const live = l.type === 'live';
      const lt = live ? liveFor(l.server) : null;
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = `<input type="checkbox" data-lib="${esc(l.id)}" ${s.librarySections.includes(l.id) ? 'checked' : ''} title="Show on Browse page">
        <div class="grow"><div>${live ? '📡 ' : ''}${esc(l.title)}${live && lt ? (lt.enabled ? ' <span class="pill">On</span>' : ' <span class="pill off">Off</span>') : ''}</div><div class="sub">${live ? `${l.channels} channels${lt?.provider ? ` · ${esc(lt.provider)}` : ''}` : l.type === 'show' ? 'TV' : 'Movies'}</div></div>
        ${live ? '<button class="btn sm" data-reload title="Fetch the channel list and guide again from every server">Reload channels &amp; guide</button>'
          : `<select title="Default sort">${valid.librarySort.map((v) => `<option value="${v}" ${v === (s.librarySort[l.id] || 'title') ? 'selected' : ''}>${sortNames[v]}</option>`).join('')}</select>`}
        ${live ? '' : `<button class="btn sm" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="btn sm" data-move="1" ${i === lastLib ? 'disabled' : ''} title="Move down">↓</button>`}`;
      $('input', row).onchange = () => save({ librarySections: checked() });
      $('select', row)?.addEventListener('change', (e) => save({ librarySort: { [l.id]: e.target.value } }));
      $('[data-reload]', row)?.addEventListener('click', reloadLive);
      row.querySelectorAll('[data-move]').forEach((b) => {
        b.onclick = () => {
          // Swap within this server; other servers keep their order.
          const ids = all.map((x) => x.id);
          const a = ids.indexOf(l.id), other = g.libs[i + Number(b.dataset.move)].id, c = ids.indexOf(other);
          [ids[a], ids[c]] = [ids[c], ids[a]];
          save({ libraryOrder: ids });
        };
      });
      list.append(row);
    });
    box.append(panel);
  });
}
async function reloadLive() {
  try {
    const r = await api('/api/admin/refresh-live', { method: 'POST' });
    const n = r.filter((x) => x.available).reduce((t, x) => t + x.channels, 0);
    toast(`${n} channels loaded`);
    load();
  } catch (e) { toast(e.message); }
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
      <div class="grow"><div><b>${esc(a.name)}</b> ${pill}</div>
        <div class="sub">${esc(a.user?.tag || a.botUser || '')} · App ID ${esc(a.id)}${a.error ? ` · <span class="error">${esc(a.error)}</span>` : ''}</div>
        <div class="gchips">${a.guilds.length ? a.guilds.map((g) => `<span class="gchip">${icon(g)}${esc(g.name)}</span>`).join('') : '<span class="sub">Not in any server yet</span>'}</div></div>
      <div class="acts">
        <a class="btn sm" href="${esc(a.invite)}" target="_blank" rel="noopener">Invite to server</a>
        <a class="btn sm" href="/setup/?add=discord&app=${encodeURIComponent(a.id)}">Edit</a>
        <button class="btn sm danger" data-act="remove">Remove</button>
      </div>`;
    el.querySelector('[data-act=remove]').onclick = () => {
      if (confirm(`Remove ${a.name}? Its bot goes offline and streams in its servers stop working.`)) connAct(`/api/connections/discord/${a.id}`, 'DELETE');
    };
    apps.append(el);
  });
  const media = $('#media');
  media.innerHTML = conns.mediaServers.length ? '' : '<p class="muted">No media server connected.</p>';
  const TYPE = { plex: ['Plex', 'plex', '▶'], jellyfin: ['Jellyfin', 'jf', 'J'], emby: ['Emby', 'emby', 'E'] };
  // Browse order: the first server is selected by default on the Browse page.
  const order = state.settings.serverOrder || [];
  const pos = (id) => { const i = order.indexOf(id); return i === -1 ? 1e6 : i; };
  const sorted = conns.mediaServers.map((x, i) => ({ x, i })).sort((a, b) => pos(a.x.id) - pos(b.x.id) || a.i - b.i).map((o) => o.x);
  sorted.forEach((p, idx) => {
    const [typeName, cls, letter] = TYPE[p.type] || [p.type, '', '?'];
    const el = document.createElement('div');
    el.className = 'li';
    const h = plexHealth[p.id];
    el.innerHTML = `<span class="ic ${cls}">${letter}</span>
      <div class="grow"><div><b>${esc(p.name)}</b> <span class="muted small">${typeName}</span> ${h ? (h.ok ? '<span class="pill">Online</span>' : '<span class="pill off">Offline</span>') : '<span class="pill wait">Checking</span>'}</div>
        <div class="sub">${esc(p.url)}${p.username ? ` · as ${esc(p.username)}` : ''}${h?.ok ? ` · ${h.libraries} movie/TV ${h.libraries === 1 ? 'library' : 'libraries'} · ${h.ms} ms` : h?.error ? ` · <span class="error">${esc(h.error)}</span>` : ''}</div></div>
      <div class="acts">
        ${sorted.length > 1 ? `<button class="btn sm" data-move="-1" ${idx === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="btn sm" data-move="1" ${idx === sorted.length - 1 ? 'disabled' : ''} title="Move down">↓</button>` : ''}
        <button class="btn sm" data-act="test">Test</button>
        <a class="btn sm" href="/setup/?add=media&server=${encodeURIComponent(p.id)}">Edit</a>
        <button class="btn sm danger" data-act="remove">Remove</button>
      </div>`;
    el.querySelector('[data-act=test]').onclick = () => checkPlex(p, true);
    el.querySelectorAll('[data-move]').forEach((b) => {
      b.onclick = () => {
        const ids = sorted.map((x) => x.id);
        const j = idx + Number(b.dataset.move);
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        save({ serverOrder: ids });
      };
    });
    el.querySelector('[data-act=remove]').onclick = () => {
      if (confirm(`Remove ${p.name}? Its libraries disappear from Browse, and anything playing from it stops working.`)) connAct(`/api/connections/media/${encodeURIComponent(p.id)}`, 'DELETE');
    };
    media.append(el);
  });
}
// ---------- poster cache ----------
function renderPosters() {
  const p = state.posters;
  if (!p) return;
  const mb = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
  const when = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
  const l = p.last;
  $('#posterCache').innerHTML = `<div><b>${p.files.toLocaleString()}</b> posters saved · ${mb(p.bytes)}</div>
    ${p.running ? `<div class="wait">Refreshing now… ${p.progress ? `${p.progress.done.toLocaleString()} of ${p.progress.total.toLocaleString()}` : 'listing libraries'}</div>`
      : l ? `<div class="muted">Last refresh ${when(l.at)} (${esc(l.reason)}): ${l.fetched.toLocaleString()} saved${l.none ? `, ${l.none} without a poster` : ''}${l.failed ? `, <span class="error">${l.failed} failed</span>` : ''}, ${l.removed} removed, took ${dur(l.ms)}</div>`
      : '<div class="muted">Not refreshed yet since drocsid started.</div>'}
    <div class="muted">Next refresh ${when(p.next)} · container time zone ${esc(p.timeZone)}</div>`;
  $('#postersRefresh').disabled = p.running;
}
$('#postersRefresh').onclick = async () => {
  try { state.posters = await api('/api/admin/posters/refresh', { method: 'POST' }); renderPosters(); toast('Refreshing posters in the background'); } catch (e) { toast(e.message); }
};
$('#postersClear').onclick = async () => {
  if (!confirm('Remove all saved posters? They are fetched again as people browse, or at the next refresh.')) return;
  try { state.posters = await api('/api/admin/posters/clear', { method: 'POST' }); renderPosters(); toast('Poster cache cleared'); } catch (e) { toast(e.message); }
};

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
const curGuild = () => (state.guilds || []).find((x) => x.id === selGuild);
$('#gAdminAddBtn').onclick = () => {
  const g = curGuild();
  if (!g) return;
  const id = resolveUser($('#gAdminAdd').value);
  if (!id) return toast('Pick someone from the list or paste a user ID');
  if (state.settings.superAdminUserIds.includes(id) || state.owners.some((o) => o.id === id)) return toast('Already a super admin');
  if (g.adminIds.includes(id)) return toast('Already an admin of this server');
  $('#gAdminAdd').value = '';
  save({ guildAccess: { [g.id]: { adminIds: [...g.adminIds, id] } } });
};
$('#superAddBtn').onclick = () => addUser('#superAdd', 'superAdminUserIds');
$('#gViewReq').onchange = (e) => { const g = curGuild(); if (g) save({ guildAccess: { [g.id]: { viewRequiresApproval: e.target.checked } } }); };
$('#gAnnounce').onchange = (e) => { const g = curGuild(); if (g) save({ guildAccess: { [g.id]: { announceInVoiceChat: e.target.checked } } }); };


async function load() {
  try {
    const me = await api('/api/me');
    $('#who').innerHTML = `Signed in as <b>${esc(me.name)}</b>${me.guild ? ` · ${esc(me.guild.name)}` : ''}`;
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
    $('#msg').textContent = e.status === 403 ? 'Admins only. Pick a server you admin from the Discord switcher on the Browse page.' : e.message;
  }
}
load().then(() => { if (location.hash === '#connections') $('#connections')?.scrollIntoView(); });
setInterval(() => { if (!document.hidden) load(); }, 10_000);
