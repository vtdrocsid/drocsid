// Media sources test (no npm packages needed): a mock Jellyfin and a mock Emby server next to
// an imported Plex server. Checks sign-in, keys, libraries, items, search, info, images,
// playback (tokens never reach the playlist), and the 0.3.0 → 0.4.0 data migration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockJellyfin } from './mockjf.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}: ${e.stack || e.message}`); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drocsid-src-'));
process.env.DATA_DIR = dataDir;
// A 0.3.0 connections file with one Plex server in plexServers.
fs.writeFileSync(path.join(dataDir, 'connections.json'), JSON.stringify({
  publicUrl: 'https://tv.example.com', setupComplete: true, ownerIds: ['1'], discordApps: [],
  plexServers: [{ id: 'plex1', name: 'VAULT', url: 'http://127.0.0.1:1', token: 'plain-old', machineId: '' }],
  plexClientId: 'drocsid-test',
}));

const jfMock = await startMockJellyfin(3911);
const embyMock = await startMockJellyfin(3912, { product: 'Emby Server', token: 'emby-tok' });
const conn = await import('../src/connections.js');
const jf = await import('../src/jellyfin.js');
const sources = await import('../src/sources.js');
const settings = await import('../src/settings.js');

console.log('Migration');
await check('plexServers moved to mediaServers', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'connections.json'), 'utf8'));
  assert.equal(raw.plexServers, undefined);
  assert.equal(raw.mediaServers[0].type, 'plex');
  assert.equal(conn.plexServer().id, 'plex1');
});
await check('old bare keys belong to the first Plex server', async () => {
  assert.equal(sources.parseKey('12345').srv.id, 'plex1');
  assert.equal(sources.parseKey('12345').id, '12345');
});

console.log('Jellyfin');
await check('wrong password refused', async () => {
  const r = await jf.connect({ type: 'jellyfin', url: jfMock.url, username: 'drocsid', password: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /password/);
});
await check('Emby server refused as Jellyfin', async () => {
  const r = await jf.connect({ type: 'jellyfin', url: embyMock.url, username: 'drocsid', password: 'pw' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Emby/);
});
let jfConn;
await check('sign in with username and password', async () => {
  jfConn = await jf.connect({ type: 'jellyfin', url: jfMock.url + '/', username: 'drocsid', password: 'pw' });
  assert.equal(jfConn.ok, true, jfConn.error);
  assert.equal(jfConn.userId, 'u1');
  assert.equal(jfConn.libraries, 2); // movies + tvshows, not music
});
await check('sign in with an API key picks an admin user', async () => {
  const r = await jf.connect({ type: 'jellyfin', url: jfMock.url, apiKey: 'tok-123' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.userId, 'u1');
});
conn.update((d) => {
  d.mediaServers.push({ id: 'jellyfin-aa', type: 'jellyfin', name: 'MockJF', url: jfConn.url, token: conn.seal(jfConn.token), userId: 'u1' });
  d.mediaServers.push({ id: 'emby-bb', type: 'emby', name: 'MockEmby', url: embyMock.url, token: conn.seal('emby-tok'), userId: 'u1' });
});
await check('tokens stored encrypted', async () => {
  const raw = fs.readFileSync(path.join(dataDir, 'connections.json'), 'utf8');
  assert.ok(!raw.includes('tok-123') && !raw.includes('emby-tok'));
});
await check('libraries from every server, keyed by server', async () => {
  const libs = await sources.libraries({ all: true }); // the Plex one is unreachable and skipped
  const ids = libs.map((l) => l.id);
  assert.ok(ids.includes('jellyfin-aa~movies') && ids.includes('emby-bb~shows'), ids.join(','));
  assert.equal(libs.find((l) => l.id === 'jellyfin-aa~movies').serverName, 'MockJF');
});
await check('library filter and order from settings', async () => {
  settings.update({ librarySections: ['jellyfin-aa~shows', 'jellyfin-aa~movies'], libraryOrder: ['jellyfin-aa~shows', 'jellyfin-aa~movies'], librarySort: { 'jellyfin-aa~shows': 'added' } });
  const libs = await sources.libraries();
  assert.deepEqual(libs.map((l) => l.id), ['jellyfin-aa~shows', 'jellyfin-aa~movies']);
  assert.equal(libs[0].defaultSort, 'added');
  await assert.rejects(() => sources.libraryItems('emby-bb~movies', {}), /not allowed/);
});
await check('library items', async () => {
  const r = await sources.libraryItems('jellyfin-aa~movies', { start: 0, size: 60, sort: 'title' });
  assert.equal(r.total, 3);
  // Posters don't depend on ImageTags (list replies can leave them out).
  assert.equal(r.items.find((x) => x.ratingKey === 'jellyfin-aa~m3').thumb, 'jellyfin-aa~img:m3');
  const a = r.items[0];
  assert.equal(a.ratingKey, 'jellyfin-aa~m1');
  assert.equal(a.title, 'Alpha Movie (2001)');
  assert.equal(a.kind, 'movie');
  assert.equal(a.duration, 3600);
  assert.equal(a.thumb, 'jellyfin-aa~img:m1');
  assert.deepEqual(a.rt, { kind: 'critic', score: 91, fresh: true });
});
await check('A–Z jump bar counts', async () => {
  const L = await sources.libraryLetters('jellyfin-aa~movies');
  assert.deepEqual(L.map((x) => [x.key, x.size]), [['A', 1], ['B', 1], ['G', 1]]);
});
await check('show → seasons → episodes', async () => {
  const seasons = await sources.children('jellyfin-aa~s1');
  assert.equal(seasons[0].kind, 'season');
  assert.equal(seasons[0].thumb, 'jellyfin-aa~img:s1'); // series poster
  const eps = await sources.children(seasons[0].ratingKey);
  assert.equal(eps[0].title, 'Some Show S01E01 — Pilot');
});
await check('search across servers', async () => {
  const r = await sources.search('movie');
  const keys = r.map((x) => x.ratingKey);
  assert.ok(keys.includes('jellyfin-aa~m1') && keys.includes('emby-bb~m1'), keys.join(','));
  assert.equal(r.find((x) => x.ratingKey === 'emby-bb~m1').serverName, 'MockEmby');
  assert.equal(r.find((x) => x.ratingKey === 'emby-bb~m1').serverType, 'emby');
});
await check('rail entries name their server', async () => {
  assert.deepEqual(sources.serverTag({ source: 'plex', ratingKey: 'jellyfin-aa~m1' }), { id: 'jellyfin-aa', name: 'MockJF', type: 'jellyfin' });
  assert.equal(sources.serverTag({ source: 'live', channelId: 'emby-bb~ch1' }).name, 'MockEmby');
  assert.equal(sources.serverTag({ source: 'plex', ratingKey: '123' }).id, 'plex1'); // old entries: first Plex
});
await check('hover info with cast photo', async () => {
  const i = await sources.info('jellyfin-aa~m1');
  assert.equal(i.tagline, 'A tagline');
  assert.deepEqual(i.directors, ['Dee Director']);
  assert.ok(i.cast[0].face);
  const img = await sources.faceImage(i.cast[0].face);
  assert.equal(await img.text(), 'JPEGDATA');
});
await check('posters through the server', async () => {
  const r = await sources.image('jellyfin-aa~img:m1', 300, 450);
  assert.equal(r.status, 200);
  assert.equal(await sources.image('jellyfin-aa~img:../../x'), null);
  assert.equal(await sources.image('nope~img:m1'), null);
});

await check('busy server: posters limited, retried and cached', async () => {
  const flaky = await startMockJellyfin(3914, { flakyImages: true });
  const srv = { id: 'flaky', type: 'jellyfin', name: 'Flaky', url: flaky.url, token: 'tok-123', userId: 'u1' };
  const ids = Array.from({ length: 30 }, (_, i) => `img:x${i}`);
  const res = await Promise.all(ids.map((id) => jf.image(srv, id, 300, 450)));
  assert.ok(res.every((r) => r.status === 200), res.map((r) => r.status).join(','));
  assert.ok(flaky.stats.imgMaxActive <= 6, `max parallel ${flaky.stats.imgMaxActive}`);
  const before = flaky.stats.imgRequests;
  const again = await jf.image(srv, 'img:x3', 300, 450);
  assert.equal(await again.text(), 'JPEGDATA');
  assert.equal(flaky.stats.imgRequests, before); // served from memory
  flaky.close();
});

console.log('Playback');
const rooms = await import('../src/rooms.js');
await check('stream starts and playlists carry no token', async () => {
  const item = await sources.metadata('jellyfin-aa~m1');
  const room = await rooms.start('room1', 'g1', item, { id: 'u', name: 'U' }, '1080-8000', 120);
  assert.match(room.masterPlaylist, /\/media\/jf\/jellyfin-aa\/videos\/m1\/main\.m3u8\?PlaySessionId=ps1/);
  assert.ok(!/api_key|ApiKey|tok-123|Trickplay/i.test(room.masterPlaylist), room.masterPlaylist);
  assert.ok(!/ApiKey|tok-123/.test(jf.cleanPlaylist('#EXTM3U\n#EXTINF:6,\nhls1/main/0.ts?PlaySessionId=1&ApiKey=tok-123&x=2\n')));
  assert.equal(room.anchorPos, 120);
  const variant = room.masterPlaylist.split('\n').find((l) => l.startsWith('/media/jf/')).replace('/media/jf/jellyfin-aa', '');
  assert.ok(jf.allowedStreamPath(variant));
  const srv = conn.server('jellyfin-aa');
  const main = await (await jf.streamFetch(srv, variant)).text();
  assert.match(main, /hls1\/main\/0\.ts/);
  assert.ok(jf.allowedStreamPath('/videos/m1/hls1/main/0.ts?PlaySessionId=ps1'));
  assert.ok(!jf.allowedStreamPath('/Users/u1/Items'));
  assert.ok(!jf.allowedStreamPath('/System/Info'));
  const seg = Buffer.from(await (await jf.streamFetch(srv, '/videos/m1/hls1/main/0.ts')).arrayBuffer());
  assert.equal(seg[0], 0x47);
});
await check('scrub previews: Jellyfin Trickplay tiles', async () => {
  const info = await rooms.previews(rooms.get('room1'));
  assert.equal(info.kind, 'tiles');
  assert.equal(info.width, 320); // the size closest to 320 px
  assert.deepEqual([info.cols, info.rows, info.count, info.interval], [10, 10, 360, 10000]);
  const tile = await jf.trickplayTile(conn.server('jellyfin-aa'), 'm1', info.width, 2, info.mediaSourceId);
  assert.equal(await tile.text(), 'TILE320-2');
  const none = await rooms.previews({ item: { source: 'live' } });
  assert.equal(none.kind, 'none');
});
await check('seek and stop report to the server', async () => {
  const infos = () => jfMock.log.filter((x) => x.includes('/PlaybackInfo')).length;
  const before = infos();
  await rooms.seek('room1', 600);
  await rooms.seek('room1', 1200);
  assert.equal(infos(), before, 'a seek must not start a new Jellyfin stream');
  assert.ok(Math.abs(rooms.position(rooms.get('room1')) - 1200) < 2);
  await rooms.stop('room1', false, 'test');
  const l = jfMock.log.join('\n');
  assert.match(l, /POST \/Sessions\/Playing\b/);
  assert.match(l, /POST \/Sessions\/Playing\/Stopped/);
  assert.match(l, /DELETE \/Videos\/ActiveEncodings\?deviceId=.*playSessionId=ps1/);
});
await check('Emby stream uses the Emby token header', async () => {
  const item = await sources.metadata('emby-bb~m2');
  await rooms.start('room2', 'g1', item, { id: 'u2', name: 'U2' }, '720-4000', 0);
  await rooms.stop('room2', false, 'test');
  assert.ok(embyMock.log.some((x) => x.startsWith('POST /Items/m2/PlaybackInfo')));
});

console.log('Live TV');
await check('Live TV listed per server in libraries', async () => {
  settings.update({ librarySections: [] });
  const libs = await sources.libraries({ all: true });
  const live = libs.filter((l) => l.type === 'live').map((l) => l.id);
  assert.ok(live.includes('jellyfin-aa~live') && live.includes('emby-bb~live'), live.join(','));
});
await check('guide merges servers, keyed by server', async () => {
  const rows = await sources.guide(Date.now() - 3600_000, Date.now() + 3 * 3600_000);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('jellyfin-aa~ch1') && ids.includes('emby-bb~ch2'), ids.join(','));
  const jfRows = rows.filter((r) => r.server === 'jellyfin-aa');
  assert.deepEqual(jfRows.map((r) => r.number), ['5', '12']); // channel number order
  const sports = jfRows[0];
  assert.equal(sports.programmes[0].title, 'The Game');
  assert.equal(sports.programmes[0].subtitle, 'Week 12');
  assert.equal(sports.programmes[0].premiere, true);
  assert.equal(sports.programmes[0].thumb, 'jellyfin-aa~img:pg1');
  assert.equal(jfRows[1].thumb, 'jellyfin-aa~img:ch2');
  assert.equal(sports.serverName, 'MockJF');
});
await check('turning a server\'s Live TV off hides it', async () => {
  settings.update({ librarySections: ['jellyfin-aa~movies', 'emby-bb~live'] });
  const rows = await sources.guide(Date.now(), Date.now() + 3600_000);
  assert.ok(rows.every((r) => r.server === 'emby-bb'), rows.map((r) => r.id).join(','));
  await assert.rejects(() => sources.liveChannel('jellyfin-aa~ch1'), /turned off/);
  settings.update({ librarySections: [] });
});
await check('now and next for a channel', async () => {
  const n = await sources.liveNow('jellyfin-aa~ch1');
  assert.equal(n.now.title, 'The Game');
  assert.equal(n.next.title, 'Postgame');
  assert.equal(n.channel.name, 'Sports');
});
await check('watching a channel opens and closes the live stream', async () => {
  const item = await sources.liveChannel('jellyfin-aa~ch1');
  assert.equal(item.title, '5 Sports');
  const room = await rooms.start('room3', 'g1', item, { id: 'u3', name: 'U3' }, '1080-8000', 0);
  assert.match(room.masterPlaylist, /\/media\/jf\/jellyfin-aa\/videos\/ch1\//);
  await rooms.stop('room3', false, 'test');
  assert.ok(jfMock.log.some((x) => x.startsWith('POST /LiveStreams/Close?LiveStreamId=ls-ch1')));
});
await check('old settings keep Live TV on', async () => {
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(st.liveInSections, true);
});

await check('server names come from the servers themselves', async () => {
  conn.update((d) => { d.mediaServers.find((x) => x.id === 'jellyfin-aa').name = 'Jellyfin'; });
  await sources.refreshNames();
  assert.equal(conn.server('jellyfin-aa').name, 'MockJF');
  assert.equal(conn.server('plex1').name, 'VAULT'); // unreachable: keeps its saved name
});

console.log('Server order');
await check('libraries grouped by server in the admin order', async () => {
  settings.update({ serverOrder: ['emby-bb', 'jellyfin-aa'], libraryOrder: [] });
  const libs = await sources.libraries({ all: true });
  const servers = [...new Set(libs.map((l) => l.server))];
  assert.deepEqual(servers.slice(0, 2), ['emby-bb', 'jellyfin-aa']);
  const emby = libs.filter((l) => l.server === 'emby-bb');
  assert.equal(emby[emby.length - 1].type, 'live'); // Live TV last within its server
});
await check('guide for one server', async () => {
  const rows = await sources.guide(Date.now(), Date.now() + 3600_000, null, 'jellyfin-aa');
  assert.ok(rows.length && rows.every((r) => r.server === 'jellyfin-aa'));
});

console.log('Poster cache');
const posters = await import('../src/posters.js');
await check('posters saved to disk and served from there', async () => {
  const before = jfMock.log.length;
  const first = await posters.get('jellyfin-aa~img:m1', 300, 450);
  assert.equal(first.buf.toString(), 'JPEGDATA');
  const second = await posters.get('jellyfin-aa~img:m1', 300, 450);
  assert.ok(second.file && fs.readFileSync(second.file, 'utf8') === 'JPEGDATA');
  assert.equal(jfMock.log.filter((x, i) => i >= before && x.includes('/Images/')).length <= 1, true);
  const bad = await posters.get('nope~img:m1', 300, 450);
  assert.equal(bad.status, 400);
});
await check('refresh fetches every poster of the libraries that are on', async () => {
  settings.update({ librarySections: ['jellyfin-aa~movies', 'jellyfin-aa~shows'] });
  await posters.refreshAll('test');
  const st = posters.status();
  assert.equal(st.last.posters, 4, JSON.stringify(st.last)); // m1, m2, m3, s1
  assert.equal(st.last.fetched, 3);
  assert.equal(st.last.none, 1); // m2 has no poster: not a failure
  assert.equal(st.last.failed, 0);
  const miss = await posters.get('jellyfin-aa~img:m2', 300, 450);
  assert.equal(miss.status, 404);
  // A saved poster always wins over an earlier "no poster".
  const before = await posters.get('jellyfin-aa~img:m1', 300, 450);
  assert.ok(before.file);
  assert.ok(st.files >= 2);
  assert.ok(st.next > Date.now() && new Date(st.next).getHours() === 2);
  posters.clear();
  assert.equal(posters.status().files, 0);
  settings.update({ librarySections: [] });
});

console.log('Several Plex servers');
const plex = await import('../src/plex.js');
await check('calls go to the chosen Plex server', async () => {
  conn.update((d) => { d.mediaServers.push({ id: 'plex-cc', type: 'plex', name: 'Second', url: 'http://10.9.9.9:32400', token: conn.seal('second-tok') }); });
  assert.match(String(plex.photoUrl('/library/metadata/1/thumb')), /127\.0\.0\.1:1/);
  const u = String(plex.withServer(conn.server('plex-cc'), () => plex.photoUrl('/library/metadata/1/thumb')));
  assert.match(u, /10\.9\.9\.9/);
  assert.match(u, /second-tok/);
  assert.equal(sources.parseKey('plex-cc~55').srv.id, 'plex-cc');
});

jfMock.close();
embyMock.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
