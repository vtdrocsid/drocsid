// Setup wizard. Also used after setup by super admins (from Admin → Connections) to add or
// change a Discord app (?add=discord[&app=<id>]) or add/edit a media server (?add=media[&server=<id>]).
import { npmGuide } from '/browse/guide.js';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}
const copy = (text) => `<div class="copy"><span>${esc(text)}</span><button type="button" data-copy="${esc(text)}">COPY</button></div>`;

const params = new URLSearchParams(location.search);
const mode = params.get('add') === 'plex' ? 'media' : params.get('add'); // null = first-time setup
const editServer = params.get('server') || null; // media server being edited
let mediaType = null;   // plex | jellyfin | emby
let mediaSaved = false; // a server was added/saved in this visit
let st = null;          // /api/setup/status
let appId = params.get('app') || null; // Discord app being set up
let pollTimer = null;
const err = (m = '') => { $('#err').textContent = m; };

const STEPS = {
  welcome: { label: 'Welcome' },
  discord: { label: 'Discord app' },
  invite: { label: 'Add to server' },
  signin: { label: 'Sign in' },
  url: { label: 'Public address' },
  mtype: { label: 'Server type' },
  media: { label: 'Connect' },
  done: { label: 'Done' },
};
const order = mode === 'url' ? ['url', 'done']
  : mode === 'discord' ? ['discord', 'invite', 'done']
  : mode === 'media' ? (editServer ? ['media', 'done'] : ['mtype', 'media', 'done'])
  : ['welcome', 'discord', 'invite', 'signin', 'mtype', 'media', 'done'];
let step = order[0];

const currentApp = () => st.discordApps?.find((a) => a.id === appId) || (mode ? null : st.discordApps?.find((a) => a.primary)) || null;
const doneFor = {
  welcome: () => st.unlocked && !!st.publicUrl,
  discord: () => !!currentApp(),
  invite: () => (currentApp()?.guilds || []).length > 0,
  signin: () => (st.ownerIds || []).length > 0,
  url: () => mode === 'url' && step === 'done',
  mtype: () => !!mediaType || (!mode && (st.mediaServers || []).length > 0),
  media: () => mediaSaved || (!mode && (st.mediaServers || []).length > 0),
  done: () => !mode && st.configured,
};

async function refresh() {
  st = await api('/api/setup/status');
  if (st.configured && !mode) location.href = '/browse/admin.html#connections';
  if (editServer && !mediaType) mediaType = st.mediaServers?.find((x) => x.id === editServer)?.type || null;
}

function drawSteps() {
  $('#steps').innerHTML = order.map((k) => `<div class="${k === step ? 'on' : doneFor[k]() ? 'done' : ''}">${STEPS[k].label}</div>`).join('');
  $('#back').style.visibility = order.indexOf(step) > 0 ? 'visible' : 'hidden';
  // Opened from Admin (add or edit): Cancel goes back there, on every step except the last.
  $('#cancel').hidden = !mode || step === 'done';
  $('#mode').textContent = mode === 'url' ? 'Public address' : mode === 'discord' ? 'Add a Discord app' : mode === 'media' ? (editServer ? 'Edit media server' : 'Add a media server') : 'Setup';
}

function go(k) {
  clearInterval(pollTimer);
  step = k;
  err();
  $('#next').disabled = false;
  $('#next').textContent = 'Continue →';
  drawSteps();
  render[k]();
}

// ---------------- steps ----------------
const render = {
  welcome() {
    if (!st.unlocked) {
      $('#body').innerHTML = `<h2>Welcome to drocsid</h2>
        <p class="lead">Let's connect your Discord and your media server. First, enter the setup code to prove this is your server.</p>
        <div class="box"><h4>Where's the code?</h4>It's printed in the container log. On Unraid: <b>Docker</b> tab → click the drocsid icon → <b>Logs</b>. Look for <code>drocsid setup code</code>.</div>
        <div class="field"><label>Setup code</label><input id="code" class="code" maxlength="9" placeholder="XXXX-XXXX" autocomplete="off"></div>`;
      $('#code').focus();
      $('#code').onkeydown = (e) => e.key === 'Enter' && $('#next').click();
      return;
    }
    const https = st.suggestedUrl?.startsWith('https://') ? st.suggestedUrl : '';
    $('#body').innerHTML = `<h2>Your public address</h2>
      <p class="lead">The https address people use to reach drocsid (through your reverse proxy). Discord loads the player from here.</p>
      <div class="field"><label>Public URL</label><input id="url" value="${esc(st.publicUrl || https)}" placeholder="https://example.domain.com"><div class="hint">No path or trailing slash. It must be reachable from the internet with a valid certificate. You can keep using this page on its current address for now; the address is needed when you sign in with Discord.</div></div>${npmGuide()}`;
  },

  discord() {
    const a = currentApp();
    const editing = !!a;
    $('#body').innerHTML = `<h2>${editing ? `Discord app: ${esc(a.name)}` : mode ? 'Add another Discord app' : 'Create your Discord app'}</h2>
      <p class="lead">${mode ? 'Each Discord app is its own bot with its own name and icon, and can be invited to any servers you manage.' : "drocsid runs as your own Discord app, so it's yours to name and brand."}</p>
      <div class="box"><h4>In the Discord Developer Portal</h4><ol class="g">
        <li>Open <a href="https://discord.com/developers/applications" target="_blank" rel="noopener"><b>discord.com/developers/applications</b></a> → <b>New Application</b> and name it.</li>
        <li><b>OAuth2 → Redirects</b>: add ${copy(st.redirectUri)}Then copy the <b>Client ID</b> and <b>Reset Secret</b> to get the client secret.</li>
        <li><b>Bot</b>: turn on <b>Server Members Intent</b>, save, then <b>Reset Token</b> and copy the token.</li>
        <li><b>Activities → Settings</b>: turn on <b>Enable Activities</b>. <b>Activities → URL Mappings</b>: set <code>/</code> to ${copy(st.activityHost)}</li>
      </ol></div>
      <div class="row">
        <div class="field"><label>Application (Client) ID</label><input id="clientId" value="${esc(a?.id || '')}" ${editing ? 'readonly' : ''} inputmode="numeric"></div>
        <div class="field"><label>Client Secret</label><input id="clientSecret" type="password" autocomplete="off" placeholder="${a?.hasSecret ? 'Saved (leave blank to keep)' : ''}"></div>
      </div>
      <div class="field"><label>Bot Token</label><input id="botToken" type="password" autocomplete="off" placeholder="${a?.hasToken ? 'Saved (leave blank to keep)' : ''}"></div>
      <div><button class="btn" id="test">Test</button> <span id="testMsg"></span></div>
      <ul class="checks" id="checks"></ul>`;
    $('#test').onclick = testDiscord;
  },

  invite() {
    const a = currentApp();
    if (!a) return go('discord');
    const draw = () => {
      const app = currentApp();
      const guilds = app.guilds || [];
      const status = app.status === 'online' ? `<span class="ok">● ${esc(app.user?.tag || app.botUser)} is online</span>`
        : app.status === 'error' ? `<span class="bad">● Bot can't sign in: ${esc(app.error)}</span>` : '<span class="wait">● Bot is starting…</span>';
      $('#body').innerHTML = `<h2>Add the bot to your Discord server</h2>
        <p class="lead">Invite <b>${esc(a.name)}</b> to each server where you want to watch together. You need <b>Manage Server</b> there. You can add more servers any time from Admin → Connections.</p>
        <p>${status}</p>
        <a class="btn discord" href="${esc(app.invite)}" target="_blank" rel="noopener">Add to a Discord server</a>
        <div class="box"><h4>Servers the bot is in</h4>${guilds.length ? guilds.map((g) => `<div class="srv">${g.icon ? `<img src="${esc(g.icon)}" alt="">` : `<span class="ic">${esc(g.name[0] || '?')}</span>`}<div class="grow"><div class="n">${esc(g.name)}</div><div class="m">${esc(g.id)}</div></div><span class="ok">✓ Joined</span></div>`).join('')
          : '<p class="wait">Waiting for the bot to join a server… (this updates by itself)</p>'}</div>`;
      $('#next').disabled = !guilds.length && !mode;
    };
    draw();
    pollTimer = setInterval(async () => { try { await refresh(); draw(); drawSteps(); } catch {} }, 3000);
  },

  signin() {
    const me = st.signedIn;
    // Discord always returns to the public address, so setup carries on there after signing in.
    const away = st.publicUrl && location.origin !== st.publicUrl;
    $('#body').innerHTML = `<h2>Sign in as the owner</h2>
      <p class="lead">Sign in with your Discord account. You become an <b>owner</b>: a super admin who can always change everything, including these connections.</p>
      ${away && !me?.owner ? `<div class="box"><h4>Your public address has to work for this step</h4>Discord returns you to <b>${esc(st.publicUrl)}</b>, and setup carries on there. If the sign-in doesn't come back, set up the address in your reverse proxy first.${npmGuide()}</div>` : ''}
      ${me?.owner ? `<p class="ok">✓ Signed in as ${esc(me.name)} (owner)</p>`
        : `<a class="btn discord" href="/auth/login">Sign in with Discord</a>${me ? `<p class="hint">Signed in as ${esc(me.name)}, but not as an owner yet. Sign in again here to become one.</p>` : ''}`}
      ${(st.ownerIds || []).length && !me?.owner ? `<p class="hint">${st.ownerIds.length} owner(s) already set.</p>` : ''}`;
    $('#next').disabled = !(st.ownerIds || []).length;
  },

  url() {
    const cur = st.publicUrl || '';
    $('#body').innerHTML = `<h2>${cur ? 'Change the public address' : 'Add the public address'}</h2>
      <p class="lead"><b>Required:</b> a public <b>https</b> address with a valid certificate that anyone on the internet can reach. Discord loads the player from it and sends people back to it after <b>Sign in with Discord</b>, so creating a bot and signing in only work with a real public address.</p>
      <div class="field"><label>Public address</label><input id="pubUrl" value="${esc(cur || (st.suggestedUrl?.startsWith('https://') ? st.suggestedUrl : ''))}" placeholder="https://example.domain.com" autocomplete="off"><div class="hint">No path or trailing slash.</div></div>
      <div><button class="btn" id="urlTest">Test</button> <span id="urlMsg"></span></div>
      <ul class="checks" id="urlChecks"></ul>
      <div id="urlGuide" style="margin-top:12px"></div>`;
    $('#urlGuide').innerHTML = npmGuide(!cur);
    $('#urlTest').onclick = () => testAddress();
  },

  mtype() {
    const cards = [
      ['plex', 'Plex', 'Sign in with Plex, or address + token', '<img class="logo" src="/browse/img/plex.svg" alt="">'],
      ['jellyfin', 'Jellyfin', 'Address + username and password, or an API key', '<img class="logo" src="/browse/img/jellyfin.svg" alt="">'],
      ['emby', 'Emby', 'Address + username and password, or an API key', '<img class="logo" src="/browse/img/emby.svg" alt="">'],
    ];
    $('#body').innerHTML = `<h2>What kind of server?</h2>
      <p class="lead">${mode ? 'Add as many as you like.' : 'You can add more later from Admin → Connections.'} Each one's libraries show up on the Browse page.</p>
      <div class="pick">${cards.map(([k, n, m, logo]) => `<button class="card ${mediaType === k ? 'on' : ''}" data-type="${k}">${logo}<div class="n">${n}</div><div class="m">${m}</div></button>`).join('')}</div>
      ${(st.mediaServers || []).length && !mode ? `<p class="hint">Already connected: ${st.mediaServers.map((x) => esc(x.name)).join(', ')}.</p>` : ''}`;
    document.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { mediaType = b.dataset.type; render.mtype(); drawSteps(); }; });
    $('#next').disabled = !mediaType && !(!mode && (st.mediaServers || []).length);
  },

  media() {
    if (!mediaType) {
      if (!mode && (st.mediaServers || []).length) return go('done');
      return go('mtype');
    }
    const ex = editServer ? st.mediaServers?.find((x) => x.id === editServer) : null;
    if (mediaType === 'plex') {
      $('#body').innerHTML = `<h2>${ex ? `Edit ${esc(ex.name)}` : 'Connect Plex'}</h2>
        <p class="lead">Sign in with Plex to pick a server, or enter its address and token yourself.</p>
        <button class="btn plex" id="plexSignin">Sign in with Plex</button> <span id="pinMsg" class="hint"></span>
        <div id="servers"></div>
        <div class="or">— or enter it yourself —</div>
        <div class="row">
          <div class="field"><label>Server address</label><input id="plexUrl" value="${esc(ex?.url || '')}" placeholder="http://192.168.1.10:32400"><div class="hint">As reached from the drocsid container.</div></div>
          <div class="field"><label>Plex token</label><input id="plexToken" type="password" autocomplete="off" placeholder="${ex?.hasToken ? 'Saved (leave blank to keep)' : ''}"><div class="hint"><a href="https://support.plex.tv/articles/204059436" target="_blank" rel="noopener">Finding your token</a></div></div>
        </div>
        <button class="btn" id="plexManual">Test &amp; save</button> <span id="manualMsg"></span>`;
      $('#plexSignin').onclick = plexSignin;
      $('#plexManual').onclick = () => saveServer({ url: $('#plexUrl').value, token: $('#plexToken').value }, $('#manualMsg'));
      $('#next').disabled = !mediaSaved && !(ex && mode);
      return;
    }
    const brand = mediaType === 'emby' ? 'Emby' : 'Jellyfin';
    $('#body').innerHTML = `<h2>${ex ? `Edit ${esc(ex.name)}` : `Connect ${brand}`}</h2>
      <p class="lead">The address as reached from the drocsid container.</p>
      <div class="field"><label>Server address</label><input id="jfUrl" value="${esc(ex?.url || '')}" placeholder="http://192.168.1.10:8096"></div>
      <div class="row">
        <div class="field"><label>Username</label><input id="jfUser" autocomplete="off" placeholder="${esc(ex?.username || '')}"></div>
        <div class="field"><label>Password</label><input id="jfPass" type="password" autocomplete="off"></div>
      </div>
      <div class="field"><label>Or an API key</label><input id="jfKey" type="password" autocomplete="off"><div class="hint">${brand} → Dashboard → API Keys. ${ex ? 'Leave all three blank to keep the saved sign-in. ' : ''}A dedicated user that can see only the libraries you want to share is best.</div></div>
      <button class="btn" id="jfTest">Test</button> <span id="jfMsg"></span>`;
    $('#jfTest').onclick = testServer;
  },

  done() {
    if (mode) {
      if (mode === 'url') {
        $('#body').innerHTML = `<h2>All set</h2><p class="lead">The public address is saved: <b>${esc(st.publicUrl)}</b></p>
          <p>If it changed, update each Discord app in the Developer Portal: OAuth2 → Redirects <code>${esc(st.publicUrl)}/auth/callback</code>, and Activities → URL Mappings <code>/</code> → <code>${esc(st.publicUrl.replace(/^https:\/\//, ''))}</code>.</p>`;
        $('#next').textContent = 'Back to Admin';
        return;
      }
      $('#body').innerHTML = mode === 'media'
        ? `<h2>All set</h2><p class="lead">The media server is saved.</p><p>Choose which of its libraries appear on the Browse page, and their order, under <b>Admin → Libraries</b>.</p>`
        : `<h2>All set</h2><p class="lead">The Discord app is saved. Invite it to more servers from Admin → Connections any time.</p>
        <p>New servers start with nobody approved. Approve roles or people for each server under <b>Admin → Access by server</b>.</p>`;
      $('#next').textContent = 'Back to Admin';
      return;
    }
    const a = currentApp();
    $('#body').innerHTML = `<h2>Ready to go</h2>
      <p class="lead">Here's what's connected. Press <b>Finish</b> to open drocsid.</p>
      <div class="box"><h4>Summary</h4>
        <div>🌐 ${esc(st.publicUrl)}</div>
        <div>🤖 ${esc(a?.name || '')} in ${(a?.guilds || []).map((g) => esc(g.name)).join(', ') || 'no servers yet'}</div>
        <div>👑 ${(st.ownerIds || []).length} owner(s)</div>
        ${(st.mediaServers || []).map((x) => `<div>🎬 ${esc(x.name)} (${esc({ plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[x.type] || x.type)}) at ${esc(x.url)}</div>`).join('')}
      </div>
      <p>Next: in <b>Admin</b>, approve the Discord roles or people who can start streams in each server.</p>`;
    $('#next').textContent = 'Finish';
  },
};

// ---------------- actions ----------------
const discordFields = () => ({ clientId: $('#clientId').value.trim(), clientSecret: $('#clientSecret').value.trim(), botToken: $('#botToken').value.trim() });

function showChecks(test) {
  $('#checks').innerHTML = test.checks.map((c) => `<li>${c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${esc(c.label)}
    ${c.id === 'members' && !c.ok ? ' <button class="btn sm" data-fix="members">Turn it on for me</button>' : ''}
    ${!c.ok && c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ''}</li>`).join('');
  const fix = $('[data-fix=members]');
  if (fix) fix.onclick = async () => {
    try {
      const f = discordFields();
      await api(`/api/connections/discord/${encodeURIComponent(f.clientId || 'new')}/members-intent`, { method: 'POST', body: JSON.stringify({ botToken: f.botToken }) });
      await testDiscord();
    } catch (e) { err(e.message); }
  };
}

async function testDiscord() {
  err();
  $('#testMsg').innerHTML = '<span class="wait">Checking…</span>';
  try {
    const t = await api('/api/connections/discord/test', { method: 'POST', body: JSON.stringify(discordFields()) });
    $('#testMsg').innerHTML = t.ok ? `<span class="ok">✓ All good${t.app ? ` · ${esc(t.app.name)}` : ''}</span>` : '<span class="bad">Some things need fixing</span>';
    showChecks(t);
    return t;
  } catch (e) { $('#testMsg').textContent = ''; err(e.message); }
}

async function plexSignin() {
  err();
  const win = window.open('about:blank', 'plexauth', 'width=600,height=720');
  try {
    const pin = await api('/api/connections/plex/pin', { method: 'POST', body: '{}' });
    if (win) win.location = pin.authUrl; else location.href = pin.authUrl;
    $('#pinMsg').textContent = 'Waiting for you to sign in to Plex…';
    const started = Date.now();
    pollTimer = setInterval(async () => {
      if (Date.now() - started > 5 * 60_000) { clearInterval(pollTimer); $('#pinMsg').textContent = 'Timed out. Try again.'; return; }
      const r = await api(`/api/connections/plex/pin/${pin.id}`).catch(() => null);
      if (!r?.done) return;
      clearInterval(pollTimer);
      try { win?.close(); } catch {}
      $('#pinMsg').textContent = '';
      showServers(pin.id, r.servers);
    }, 2000);
  } catch (e) { try { win?.close(); } catch {} err(e.message); }
}

function showServers(pinId, servers) {
  if (!servers.length) { $('#servers').innerHTML = '<p class="bad">No Plex servers found on that account.</p>'; return; }
  // Prefer a direct LAN address: the container usually sits on the same network as Plex.
  const rank = (c) => (c.relay ? 9 : 0) + (c.local ? 0 : 2) + (c.protocol === 'http' ? 0 : 1);
  $('#servers').innerHTML = servers.map((s, i) => {
    const conns = [...s.connections].sort((a, b) => rank(a) - rank(b));
    return `<div class="srv"><img class="ic" src="/browse/img/plex.svg" alt="Plex"><div class="grow"><div class="n">${esc(s.name)}</div><div class="m">${s.owned ? 'Your server' : 'Shared with you'} · Plex ${esc(s.version || '')}</div></div>
      <button class="btn primary sm" data-use="${i}">Test &amp; use</button></div>
      <div class="conns">${conns.map((c, j) => `<label><input type="radio" name="conn${i}" value="${esc(c.uri)}" ${j === 0 ? 'checked' : ''}> ${esc(c.uri)} <span class="tag">${c.relay ? 'relay' : c.local ? 'local' : 'remote'}</span></label>`).join('')}
        <label><input type="radio" name="conn${i}" value="custom"> other: <input class="custom" data-for="${i}" placeholder="http://plex:32400" style="font:12px monospace;padding:2px 4px"></label>
        <div class="hint" style="margin-left:50px" id="useMsg${i}"></div></div>`;
  }).join('');
  document.querySelectorAll('[data-use]').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.use);
      let url = document.querySelector(`input[name=conn${i}]:checked`)?.value;
      if (url === 'custom') url = document.querySelector(`.custom[data-for="${i}"]`).value;
      savePlex({ url, pinId, machineId: servers[i].machineId, name: servers[i].name }, $(`#useMsg${i}`));
    };
  });
}

/**
 * Check a public address from this browser: right format, reachable with a valid certificate,
 * it's this drocsid, and WebSockets get through. Also asks the drocsid server (informational).
 */
async function testAddress() {
  err();
  const url = $('#pubUrl').value.trim().replace(/\/+$/, '');
  const list = [];
  const add = (ok, label, hint = '', warn = false) => list.push({ ok, label, hint, warn });
  const draw = () => {
    $('#urlChecks').innerHTML = list.map((c) => `<li>${c.ok ? '<span class="ok">✓</span>' : c.warn ? '<span class="wait">!</span>' : '<span class="bad">✗</span>'} ${esc(c.label)}${c.hint ? `<div class="hint">${c.hint}</div>` : ''}</li>`).join('');
  };
  $('#urlMsg').innerHTML = '<span class="wait">Checking…</span>';
  $('#urlChecks').innerHTML = '';
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
    add(false, 'https address', 'Use the https:// address people open, with no path (e.g. https://example.domain.com).');
    draw(); $('#urlMsg').textContent = ''; return false;
  }
  add(true, 'https address');
  const mine = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  let theirs = null;
  try {
    const r = await fetch(`${url}/api/config`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    theirs = r.ok ? await r.json() : null;
    add(!!theirs, 'Reachable with a valid certificate', theirs ? '' : `It answered ${r.status}. Check the proxy host's forward hostname and port.`);
  } catch {
    add(false, 'Reachable with a valid certificate', "No answer from this browser, or the certificate isn't valid. Check the DNS record, port forwarding (80/443) and the SSL tab in Nginx Proxy Manager.");
  }
  if (theirs) add(theirs.instance && theirs.instance === mine.instance, 'Reaches this drocsid', theirs.instance === mine.instance ? '' : 'Another server answered at this address. Check the proxy host points at the drocsid container (port 3000).');
  if (theirs) {
    const wsOk = await new Promise((resolve) => {
      let done = false;
      const end = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const ws = new WebSocket(`${url.replace(/^https:/, 'wss:')}/ws`);
        ws.onclose = (e) => end(e.code === 4001); // drocsid answers a sign-in-less connection with 4001
        ws.onerror = () => {};
        setTimeout(() => { try { ws.close(); } catch {} end(false); }, 8000);
      } catch { end(false); }
    });
    add(wsOk, 'WebSockets get through (keeps the player in sync)', wsOk ? '' : 'Turn on <b>Websockets Support</b> on the proxy host.');
  }
  const fromServer = await api('/api/connections/public-url/test', { method: 'POST', body: JSON.stringify({ publicUrl: url }) }).catch(() => null);
  if (fromServer) add(fromServer.ok && fromServer.instance === mine.instance, 'Reachable from the drocsid server too',
    fromServer.ok ? '' : `From inside your network: ${esc(fromServer.error || 'no answer')}. This is only a warning: some routers don't loop back to their own public address. The checks above are what matter.`, true);
  draw();
  const ok = list.filter((c) => !c.warn).every((c) => c.ok);
  $('#urlMsg').innerHTML = ok ? '<span class="ok">✓ Working</span>' : '<span class="bad">Not working yet</span>';
  return ok;
}

const savePlex = (body, msgEl) => saveServer(body, msgEl);

/** Save the server (add, or update when editing), then move on. */
async function saveServer(body, msgEl) {
  err();
  msgEl.innerHTML = '<span class="wait">Testing…</span>';
  try {
    st = { ...st, ...(await api('/api/connections/media', { method: 'POST', body: JSON.stringify({ type: mediaType, serverId: editServer || undefined, ...body }) })) };
    msgEl.innerHTML = '<span class="ok">✓ Connected</span>';
    mediaSaved = true;
    go(order[order.indexOf('media') + 1]);
  } catch (e) { msgEl.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}

const jfFields = () => ({ url: $('#jfUrl').value.trim(), username: $('#jfUser').value.trim(), password: $('#jfPass').value, apiKey: $('#jfKey').value.trim() });
async function testServer() {
  err();
  $('#jfMsg').innerHTML = '<span class="wait">Checking…</span>';
  try {
    const t = await api('/api/connections/media/test', { method: 'POST', body: JSON.stringify({ type: mediaType, serverId: editServer || undefined, ...jfFields() }) });
    $('#jfMsg').innerHTML = t.ok
      ? `<span class="ok">✓ ${esc({ jellyfin: 'Jellyfin', emby: 'Emby' }[mediaType])} ${esc(t.version)} · "${esc(t.name)}" · ${t.libraries} movie/TV ${t.libraries === 1 ? 'library' : 'libraries'}${t.username ? ` · as ${esc(t.username)}` : ''}</span>`
      : `<span class="bad">${esc(t.error)}</span>`;
    return t.ok;
  } catch (e) { $('#jfMsg').textContent = ''; err(e.message); return false; }
}

// What "Continue" does on each step.
const next = {
  async welcome() {
    if (!st.unlocked) {
      await api('/api/setup/unlock', { method: 'POST', body: JSON.stringify({ code: $('#code').value }) });
      await refresh();
      return render.welcome();
    }
    st = { ...st, ...(await api('/api/connections/public-url', { method: 'PUT', body: JSON.stringify({ publicUrl: $('#url').value }) })) };
    return true;
  },
  async discord() {
    const f = discordFields();
    const r = await api('/api/connections/discord', { method: 'POST', body: JSON.stringify(f) }).catch((e) => {
      if (e.data?.test) showChecks(e.data.test);
      throw e;
    });
    st = { ...st, ...r };
    appId = f.clientId;
    return true;
  },
  async invite() { await refresh(); return true; },
  async signin() { return (st.ownerIds || []).length > 0; },
  async url() {
    if (!(await testAddress())) throw new Error('Fix the address first: it has to work before it can be saved.');
    st = { ...st, ...(await api('/api/connections/public-url', { method: 'PUT', body: JSON.stringify({ publicUrl: $('#pubUrl').value }) })) };
    return true;
  },
  async mtype() {
    if (!mediaType && !mode && (st.mediaServers || []).length) { go('done'); return false; }
    if (!mediaType) throw new Error('Pick a server type');
    return true;
  },
  async media() {
    if (mediaSaved || (!mode && (st.mediaServers || []).length && mediaType === 'plex')) return true;
    if (mediaType === 'plex') {
      if (editServer) return true; // nothing changed
      throw new Error('Sign in with Plex or enter the address and token first');
    }
    const f = jfFields();
    const r = await api('/api/connections/media', { method: 'POST', body: JSON.stringify({ type: mediaType, serverId: editServer || undefined, ...f }) });
    st = { ...st, ...r };
    mediaSaved = true;
    return true;
  },
  async done() {
    if (mode) { location.href = '/browse/admin.html#connections'; return false; }
    await api('/api/setup/finish', { method: 'POST', body: '{}' });
    location.href = '/browse/admin.html';
    return false;
  },
};

$('#next').onclick = async () => {
  err();
  $('#next').disabled = true;
  try {
    if (await next[step]()) go(order[order.indexOf(step) + 1]);
  } catch (e) { err(e.message); }
  if (step !== 'invite' && step !== 'signin') $('#next').disabled = false;
};
$('#back').onclick = () => go(order[Math.max(0, order.indexOf(step) - 1)]);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy);
  b.textContent = 'COPIED';
  setTimeout(() => { b.textContent = 'COPY'; }, 1200);
});

(async () => {
  try {
    await refresh();
    if (mode && !st.unlocked) { location.href = '/auth/login'; return; }
    // Open at the first step that still needs doing.
    go(mode ? order[0] : order.find((k) => !doneFor[k]()) || 'done');
  } catch (e) { $('#body').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
})();
