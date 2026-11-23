import { readFileSync } from 'node:fs';
import * as conn from './connections.js';
import { startBot } from './bot.js';
import { startServer } from './server.js';
import { logSetupCode } from './setup.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
console.log(`Drocsid v${version} starting`);

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
// Last resort: an unexpected error is logged and the server keeps running for everyone else,
// instead of the whole site going down mid-stream.
process.on('uncaughtException', (e) => console.error('[uncaught] kept running after:', e?.stack || e));

startServer();
// Bots start for every saved Discord app; one that can't sign in is reported on the
// Connections page instead of stopping the container.
startBot().catch((e) => console.error('Discord bots:', e.message));
if (!conn.isConfigured()) logSetupCode(true);
// Use each media server's own name (e.g. an imported "Plex" becomes "VAULT").
setTimeout(() => import('./sources.js').then((s) => s.refreshNames()).catch(() => {}), 3000);
