// The real app (src/app.js createApp) on a file DB with WAL, VIES stubbed (valid, deterministic), plus an in-process
// loop-lag/memory sampler written to SAMPLES_FILE. No application code is changed.
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { appendFileSync, writeFileSync } from 'node:fs';
const validate = async (v) => ({ status: 'valid', vat: v });
const db = openDb(process.env.DB_FILE);
const { server } = createApp({ db, secret: 'proof-secret-proof-secret-1', validate, env: { ALLOW_MANUAL_UPLOAD: '1' } });
const SF = process.env.SAMPLES_FILE; if (SF) writeFileSync(SF, '');
let last = performance.now(), lagMax = 0;
setInterval(() => { const now = performance.now(); lagMax = Math.max(lagMax, now - last - 20); last = now; }, 20);
if (SF) setInterval(() => { const m = process.memoryUsage(); appendFileSync(SF, JSON.stringify({ t: Date.now(), rssMB: +(m.rss / 1048576).toFixed(1), heapMB: +(m.heapUsed / 1048576).toFixed(1), lagMaxMs: +lagMax.toFixed(1) }) + '\n'); lagMax = 0; }, 250);
server.listen(+process.env.PORT, '127.0.0.1', () => console.log('UP ' + process.pid));
