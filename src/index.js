import { startBot } from './bot.js';
import { startServer } from './server.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
console.log(`Drocsid v${version} starting`);

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

await startBot();
startServer();
