// CI smoke test: starts the real server twice.
//  1. Fresh install (no env, empty /data): setup mode, setup code, wizard APIs.
//  2. Existing install (old .env variables + old settings.json): imported automatically,
//     secrets encrypted, approvals moved to the server they belonged to, portal reachable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockJellyfin } from './mockjf.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}: ${e.message}`); }
};

async function boot(port, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drocsid-'));
  if (env.__settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(env.__settings));
  delete env.__settings;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISCORD_|PLEX_|PUBLIC_URL|OWNER_USER_IDS)/.test(k)));
  const proc = spawn('node', ['src/index.js'], { env: { ...clean, ...env, DATA_DIR: dataDir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/config`).then((r) => r.ok).catch(() => false)) break;
    if (proc.exitCode !== null) break;
    await sleep(200);
  }
  return { proc, base, dataDir, log: () => log };
}

const get = (base, p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const json = (base, p, method = 'GET', body, cookie = '') => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') || '' }));

// ---------------------------------------------------------------- fresh install
console.log('Fresh install');
{
  const s = await boot(3901, {});
  const { base } = s;
  await check('server is up', async () => assert.equal(s.proc.exitCode, null, s.log()));
  await check('config says not configured', async () => assert.equal((await json(base, '/api/config')).body.configured, false));
  await check('/ goes to the wizard', async () => assert.match((await get(base, '/')).headers.get('location') || '', /\/setup\/$/));
  await check('wizard page loads', async () => assert.match(await (await get(base, '/setup/')).text(), /drocsid/));
  await check('portal API is closed', async () => assert.equal((await json(base, '/api/libraries')).status, 503));
  await check('setup code is in the log', async () => assert.match(s.log(), /setup code:\s+[A-Z0-9]{4}-[A-Z0-9]{4}/));
  await check('locked before the code', async () => {
    assert.equal((await json(base, '/api/setup/status')).body.unlocked, false);
    assert.equal((await json(base, '/api/connections')).status, 403);
  });
  await check('wrong code refused', async () => assert.equal((await json(base, '/api/setup/unlock', 'POST', { code: 'AAAA-AAAA' })).status, 403));
  const code = (s.log().match(/setup code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1];
  const un = await json(base, '/api/setup/unlock', 'POST', { code: code?.toLowerCase() });
  const cookie = (un.setCookie.match(/pc_setup=[^;]+/) || [''])[0];
  await check('right code unlocks', async () => { assert.equal(un.status, 200); assert.ok(cookie); });
  await check('status shows connections once unlocked', async () => {
    const st = (await json(base, '/api/setup/status', 'GET', null, cookie)).body;
    assert.equal(st.unlocked, true);
    assert.deepEqual(st.discordApps, []);
  });
  await check('public URL must be https', async () => assert.equal((await json(base, '/api/connections/public-url', 'PUT', { publicUrl: 'http://x' }, cookie)).status, 400));
  await check('public URL saved', async () => {
    const r = await json(base, '/api/connections/public-url', 'PUT', { publicUrl: 'https://tv.example.com/' }, cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.redirectUri, 'https://tv.example.com/auth/callback');
  });
  await check('Discord test reports bad values', async () => {
    const r = await json(base, '/api/connections/discord/test', 'POST', { clientId: '123456789012345678', clientSecret: 'nope', botToken: 'nope' }, cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.checks.some((c) => c.id === 'token' && !c.ok));
  });
  await check('bad Discord app not saved', async () => assert.equal((await json(base, '/api/connections/discord', 'POST', { clientId: '123456789012345678', clientSecret: 'x', botToken: 'y' }, cookie)).status, 400));
  await check('Plex test rejects bad address', async () => assert.equal((await json(base, '/api/connections/media/test', 'POST', { type: 'plex', url: 'nope', token: 't' }, cookie)).body.ok, false));
  const mock = await startMockJellyfin(3913);
  await check('Jellyfin test signs in (no token returned)', async () => {
    const r = await json(base, '/api/connections/media/test', 'POST', { type: 'jellyfin', url: mock.url, username: 'drocsid', password: 'pw' }, cookie);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.token, undefined);
    assert.equal(r.body.libraries, 2);
  });
  let jfId;
  await check('Jellyfin server added', async () => {
    const r = await json(base, '/api/connections/media', 'POST', { type: 'jellyfin', url: mock.url, username: 'drocsid', password: 'pw' }, cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const srv = r.body.mediaServers.find((x) => x.type === 'jellyfin');
    jfId = srv.id;
    assert.equal(srv.name, 'MockJF');
    assert.equal(srv.token, undefined);
  });
  await check('same server not added twice', async () => assert.equal((await json(base, '/api/connections/media', 'POST', { type: 'jellyfin', url: mock.url, username: 'drocsid', password: 'pw' }, cookie)).status, 409));
  await check('edit keeps the saved sign-in', async () => {
    const r = await json(base, '/api/connections/media', 'POST', { type: 'jellyfin', serverId: jfId, name: 'Basement' }, cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mediaServers.find((x) => x.id === jfId).name, 'MockJF'); // the server's own name, not a typed one
    assert.equal(r.body.mediaServers.length, 1);
  });
  await check('health check', async () => {
    const r = await json(base, `/api/connections/media/${jfId}/health`, 'GET', null, cookie);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.libraries, 2);
  });
  await check('removed', async () => {
    const r = await json(base, `/api/connections/media/${jfId}`, 'DELETE', null, cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.mediaServers.length, 0);
  });
  mock.close();
  await check('finish lists what is missing', async () => {
    const r = await json(base, '/api/setup/finish', 'POST', {}, cookie);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Discord app/);
  });
  s.proc.kill();
}

// ---------------------------------------------------------------- existing .env install
console.log('Existing install (.env import)');
{
  const env = {
    PUBLIC_URL: 'https://tv.example.com', DISCORD_CLIENT_ID: '111111111111111111', DISCORD_CLIENT_SECRET: 'secret-abc',
    DISCORD_BOT_TOKEN: 'bot-token-xyz', DISCORD_GUILD_ID: '222222222222222222', OWNER_USER_IDS: '333333333333333333',
    PLEX_URL: 'http://127.0.0.1:1/', PLEX_TOKEN: 'plex-token-123',
    __settings: { approvedRoleIds: ['444444444444444444'], approvedUserIds: ['555555555555555555'], quality: '720-4000' },
  };
  const s = await boot(3902, env);
  const { base, dataDir } = s;
  await sleep(1500); // let the bot fail to sign in with the fake token
  await check('server stays up with a bad bot token', async () => assert.equal(s.proc.exitCode, null, s.log()));
  await check('config says configured', async () => {
    const c = (await json(base, '/api/config')).body;
    assert.equal(c.configured, true);
    assert.equal(c.clientId, '111111111111111111');
    assert.equal(c.publicUrl, 'https://tv.example.com');
  });
  await check('/ goes to the portal', async () => assert.match((await get(base, '/')).headers.get('location') || '', /\/browse\/$/));
  await check('wizard redirects to admin once configured', async () => assert.match((await get(base, '/setup/')).headers.get('location') || '', /admin/));
  await check('connections closed without a super admin', async () => assert.equal((await json(base, '/api/connections')).status, 403));
  await check('connections.json written with encrypted secrets', async () => {
    const raw = fs.readFileSync(path.join(dataDir, 'connections.json'), 'utf8');
    for (const secret of ['secret-abc', 'bot-token-xyz', 'plex-token-123']) assert.ok(!raw.includes(secret), `${secret} stored in plain text`);
    const c = JSON.parse(raw);
    assert.equal(c.setupComplete, true);
    assert.equal(c.discordApps[0].id, '111111111111111111');
    assert.equal(c.mediaServers[0].url, 'http://127.0.0.1:1');
    assert.equal(c.mediaServers[0].type, 'plex');
    assert.deepEqual(c.ownerIds, ['333333333333333333']);
    assert.ok(fs.existsSync(path.join(dataDir, 'secret.key')));
  });
  await check('approvals moved to the old server', async () => {
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual(st.guildAccess['222222222222222222'], { userIds: ['555555555555555555'], roleIds: ['444444444444444444'] });
    assert.equal(st.approvedRoleIds, undefined);
    assert.equal(st.quality, '720-4000');
  });
  await check('portal API needs sign-in (not setup)', async () => assert.equal((await json(base, '/api/libraries')).status, 401));
  s.proc.kill();

  // Restart on the same data: secrets decrypt and nothing is re-imported.
  const again = spawn('node', ['--input-type=module', '-e', `
    process.env.DATA_DIR=${JSON.stringify(dataDir)};
    const c = await import('./src/connections.js');
    const a = c.primaryApp();
    if (c.appSecret(a) !== 'secret-abc' || c.appToken(a) !== 'bot-token-xyz' || c.plexServer().token !== 'plex-token-123') { console.log('BAD'); process.exit(1); }
    console.log('OK');`], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  again.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => again.on('exit', r));
  await check('secrets decrypt after restart', async () => assert.match(out, /OK/));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
