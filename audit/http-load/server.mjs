// Audit server: boots the real app from APP_ROOT on a synthetic DB, probes event-loop lag.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.env.APP_ROOT;
const { createApp } = await import(pathToFileURL(join(root, 'src/app.js')).href);
const { openDb } = await import(pathToFileURL(join(root, 'src/db.js')).href);
const db = openDb(process.env.DB_FILE);
const validate = async (v) => (String(v).toUpperCase() === 'ESA1234567' ? { status: 'invalid', reason: 'bad_format', vat: v } : { status: 'valid', vat: v });
const { server, stats } = createApp({ db, validate, secret: 'audit-secret-0123456789abcdef', env: { ...process.env, ALLOW_MANUAL_UPLOAD: '1', NO_RULE_CHECK: '1' } });
let maxLag = 0, lastTick = performance.now();
setInterval(() => { const now = performance.now(); const lag = now - lastTick - 10; if (lag > maxLag) maxLag = lag; lastTick = now; }, 10).unref();
server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY ' + server.address().port));
process.on('SIGUSR2', () => { console.log('STATS ' + JSON.stringify({ ...stats(), maxLoopLagMs: Math.round(maxLag), rssMb: Math.round(process.memoryUsage().rss / 1048576) })); maxLag = 0; });
process.on('SIGTERM', () => process.exit(0));
