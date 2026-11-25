// Perf server: the real app, with VIES replaced by a stub that has a fixed latency (VIES_MS, default 120 ms) and counts calls.
import { createApp } from '/downloads/invoicetool/src/app.js';
import { openDb } from '/downloads/invoicetool/src/db.js';
import { checkFormat } from '/downloads/invoicetool/src/vies.js';
let calls = 0; const ms = +(process.env.VIES_MS ?? 120);
const validate = async (v) => { const f = checkFormat(v); if (!f.ok) return { status: 'invalid', ...f }; calls++; await new Promise(r => setTimeout(r, ms)); return { status: 'valid', vat: f.vat, country: f.country, checkedAt: new Date().toISOString() }; };
import { cachedValidator } from '/downloads/invoicetool/src/viescache.js';
const cv = process.env.NO_VCACHE ? validate : cachedValidator(validate);
const { server } = createApp({ db: openDb(process.env.DB_FILE), validate: cv, secret: 'perf-secret-perf-secret' });
server.listen(+process.env.PORT, () => console.log('up'));
setInterval(() => { /* event-loop lag probe */ const t = performance.now(); setImmediate(() => { lag = Math.max(lag, performance.now() - t - 0); }); }, 50).unref();
let lag = 0; process.on('SIGUSR2', () => { console.log('STATS viesCalls=' + calls + ' maxLoopLagMs=' + lag.toFixed(0)); lag = 0; });
