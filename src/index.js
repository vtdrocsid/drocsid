import { readFileSync } from 'node:fs';
import * as conn from './connections.js';
import { startBot } from './bot.js';
import { startServer } from './server.js';
import { logSetupCode } from './setup.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
console.log(`Drocsid v${version} starting`);

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

startServer();
// Bots start for every saved Discord app; one that can't sign in is reported on the
// Connections page instead of stopping the container.
startBot().catch((e) => console.error('Discord bots:', e.message));
if (!conn.isConfigured()) logSetupCode(true);
