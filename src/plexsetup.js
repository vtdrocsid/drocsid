// Connecting a Plex server from the browser: "Sign in with Plex" (PIN flow on plex.tv),
// listing the account's servers and their addresses, and testing a server URL + token.
import { config } from './config.js';

const PLEX_TV = 'https://plex.tv/api/v2';
const headers = () => ({
  Accept: 'application/json',
  'X-Plex-Product': 'drocsid',
  'X-Plex-Client-Identifier': config.plexClientId,
  'X-Plex-Device-Name': 'drocsid',
});

// Sign-in attempts in progress: pin id -> { code, token, at }. Tokens never go to the browser.
const pins = new Map();
setInterval(() => { for (const [id, p] of pins) if (Date.now() - p.at > 30 * 60_000) pins.delete(id); }, 60_000).unref();

/** Start "Sign in with Plex": returns the plex.tv page to open. */
export async function startPin(returnUrl) {
  const r = await fetch(`${PLEX_TV}/pins?strong=true`, { method: 'POST', headers: headers() });
  if (!r.ok) throw new Error(`plex.tv answered ${r.status}`);
  const { id, code } = await r.json();
  pins.set(String(id), { code, token: null, at: Date.now() });
  const qs = new URLSearchParams({ clientID: config.plexClientId, code, 'context[device][product]': 'drocsid' });
  if (returnUrl) qs.set('forwardUrl', returnUrl);
  return { id: String(id), authUrl: `https://app.plex.tv/auth#?${qs}` };
}

/** Has the user finished signing in on plex.tv yet? */
export async function checkPin(id) {
  const p = pins.get(String(id));
  if (!p) throw Object.assign(new Error('That sign-in expired. Start again.'), { status: 404 });
  if (p.token) return true;
  const r = await fetch(`${PLEX_TV}/pins/${encodeURIComponent(id)}`, { headers: headers() });
  if (!r.ok) return false;
  const j = await r.json();
  if (j.authToken) p.token = j.authToken;
  return !!p.token;
}
export const pinToken = (id) => pins.get(String(id))?.token || null;

/** Plex Media Servers on the signed-in account, with every address Plex knows for each. */
export async function servers(accountToken) {
  const r = await fetch(`${PLEX_TV}/resources?includeHttps=1&includeRelay=0`, { headers: { ...headers(), 'X-Plex-Token': accountToken } });
  if (!r.ok) throw new Error(`plex.tv answered ${r.status}`);
  return (await r.json())
    .filter((x) => (x.provides || '').includes('server'))
    .map((x) => ({
      machineId: x.clientIdentifier,
      name: x.name,
      owned: !!x.owned,
      version: x.productVersion,
      token: x.accessToken, // server-specific token (stays on the server side)
      connections: (x.connections || []).map((c) => ({ uri: c.uri, local: !!c.local, relay: !!c.relay, address: c.address, port: c.port, protocol: c.protocol })),
    }));
}

/** Try a server address. Returns { ok, name, machineId, version, ms } or { ok:false, error }. */
export async function testServer(url, token) {
  url = String(url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^/\s]+/.test(url)) return { ok: false, error: 'Enter an address like http://192.168.1.10:32400' };
  if (!token) return { ok: false, error: 'A Plex token is needed' };
  const started = Date.now();
  try {
    const r = await fetch(`${url}/identity`, { headers: { Accept: 'application/json', 'X-Plex-Token': token }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false, error: `Plex answered ${r.status}` };
    const id = (await r.json()).MediaContainer || {};
    // /identity answers without a token; check the token on something that needs it.
    const lib = await fetch(`${url}/library/sections`, { headers: { Accept: 'application/json', 'X-Plex-Token': token }, signal: AbortSignal.timeout(6000) });
    if (lib.status === 401) return { ok: false, error: 'Plex rejected the token' };
    if (!lib.ok) return { ok: false, error: `Plex answered ${lib.status}` };
    const sections = ((await lib.json()).MediaContainer?.Directory || []).length;
    const named = await fetch(`${url}/`, { headers: { Accept: 'application/json', 'X-Plex-Token': token }, signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => ({}));
    return { ok: true, url, name: named.MediaContainer?.friendlyName || 'Plex', machineId: id.machineIdentifier || '', version: id.version || '', libraries: sections, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'No answer from that address (from inside the container)' : e.message };
  }
}
