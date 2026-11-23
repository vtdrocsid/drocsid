// A tiny fake Jellyfin/Emby server for tests: sign-in, libraries, items, images and HLS playback.
import http from 'node:http';

export function startMockJellyfin(port, { product = 'Jellyfin Server', token = 'tok-123' } = {}) {
  const log = [];
  const items = {
    m1: { Id: 'm1', Name: 'Alpha Movie', Type: 'Movie', ProductionYear: 2001, RunTimeTicks: 60 * 60 * 1e7, ImageTags: { Primary: 'x' }, CriticRating: 91, OfficialRating: 'PG',
      People: [{ Id: 'p1', Name: 'Ann Actor', Role: 'Hero', Type: 'Actor', PrimaryImageTag: 't' }, { Id: 'p2', Name: 'Dee Director', Type: 'Director' }], Genres: ['Drama'], Taglines: ['A tagline'] },
    m2: { Id: 'm2', Name: 'Beta Movie', Type: 'Movie', ProductionYear: 2005, RunTimeTicks: 90 * 60 * 1e7 },
    s1: { Id: 's1', Name: 'Some Show', Type: 'Series', ProductionYear: 2010, ChildCount: 1, ImageTags: { Primary: 'y' } },
    se1: { Id: 'se1', Name: 'Season 1', Type: 'Season', SeriesName: 'Some Show', SeriesId: 's1', SeriesPrimaryImageTag: 'y', IndexNumber: 1, ParentId: 's1' },
    e1: { Id: 'e1', Name: 'Pilot', Type: 'Episode', SeriesName: 'Some Show', SeriesId: 's1', SeriesPrimaryImageTag: 'y', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 30 * 60 * 1e7, ParentId: 'se1' },
  };
  const lib = { movies: ['m1', 'm2'], shows: ['s1'] };
  const authed = (req) => (req.headers.authorization || '').includes(`Token="${token}"`) || req.headers['x-emby-token'] === token;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace(/^\/emby/, '');
    log.push(`${req.method} ${p}${u.search}`);
    let body = '';
    for await (const c of req) body += c;
    const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/System/Info/Public') return json({ ServerName: 'MockJF', Version: '10.11.0', Id: 'mock-machine', ProductName: product });
    if (p === '/Users/AuthenticateByName' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (b.Username === 'drocsid' && b.Pw === 'pw') return json({ AccessToken: token, User: { Id: 'u1', Name: 'drocsid' } });
      return json({}, 401);
    }
    if (!authed(req)) return json({}, 401);
    if (p === '/Users') return json([{ Id: 'u1', Name: 'admin', Policy: { IsAdministrator: true } }]);
    if (p === '/Users/u1/Views') return json({ Items: [{ Id: 'movies', Name: 'Films', CollectionType: 'movies' }, { Id: 'shows', Name: 'Shows', CollectionType: 'tvshows' }, { Id: 'music', Name: 'Music', CollectionType: 'music' }] });
    if (p === '/Users/u1/Items') {
      const q = Object.fromEntries(u.searchParams);
      let list;
      if (q.SearchTerm) list = Object.values(items).filter((m) => m.Name.toLowerCase().includes(q.SearchTerm.toLowerCase()));
      else if (lib[q.ParentId]) list = lib[q.ParentId].map((id) => items[id]);
      else list = Object.values(items).filter((m) => m.ParentId === q.ParentId);
      if (q.NameStartsWith) list = list.filter((m) => m.Name.toUpperCase().startsWith(q.NameStartsWith));
      if (q.NameLessThan) list = list.filter((m) => m.Name < q.NameLessThan);
      const start = Number(q.StartIndex || 0), limit = q.Limit != null ? Number(q.Limit) : 1e9;
      return json({ Items: list.slice(start, start + limit), TotalRecordCount: list.length });
    }
    let m = p.match(/^\/Users\/u1\/Items\/(\w+)$/);
    if (m) return items[m[1]] ? json(items[m[1]]) : json({}, 404);
    m = p.match(/^\/Items\/(\w+)\/Images\/Primary$/);
    if (m) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from('JPEGDATA')); }
    m = p.match(/^\/Items\/(\w+)\/PlaybackInfo$/);
    if (m && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (!b.DeviceProfile?.TranscodingProfiles?.length) return json({ ErrorCode: 'NoCompatibleStream' });
      return json({ PlaySessionId: 'ps1', MediaSources: [{ Id: m[1], TranscodingUrl: `/videos/${m[1]}/master.m3u8?MediaSourceId=${m[1]}&PlaySessionId=ps1&api_key=${token}` }] });
    }
    m = p.match(/^\/videos\/(\w+)\/master\.m3u8$/);
    if (m) { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nmain.m3u8?PlaySessionId=ps1&api_key=${token}\n`); }
    m = p.match(/^\/videos\/(\w+)\/main\.m3u8$/);
    if (m) { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhls1/main/0.ts?PlaySessionId=ps1&api_key=${token}\n#EXT-X-ENDLIST\n`); }
    m = p.match(/^\/videos\/(\w+)\/hls1\/main\/(\d+)\.ts$/);
    if (m) { const b = Buffer.alloc(188 * 4, 0); for (let i = 0; i < 4; i++) b[i * 188] = 0x47; res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(b); }
    if (p.startsWith('/Sessions/Playing') || p === '/Videos/ActiveEncodings') { res.writeHead(204); return res.end(); }
    json({ error: 'not found' }, 404);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, log, url: `http://127.0.0.1:${port}`, close: () => server.close() })));
}
