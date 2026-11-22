import { startBot } from './bot.js';
import { startServer } from './server.js';

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

await startBot();
startServer();
