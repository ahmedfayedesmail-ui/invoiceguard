// Worker for crossprocess-credit-cap.test.js: one OS process, its own connection to the shared SQLite file.
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db.js';
import { processCorrections } from '../../src/pipeline.js';
const [file, cfgPath] = process.argv.slice(2); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const db = openDb(file); const seller = cfg.seller; if (cfg.busyMs != null) db.exec(`PRAGMA busy_timeout=${cfg.busyMs}`); // provocation mode: waiting is nearly off, so lock contention surfaces as SQLITE_BUSY
const api = { uploadInvoice: async () => 'feed-' + process.pid, feedStatus: async () => ({ status: 'DONE' }) };
const validate = async (v) => ({ status: 'valid', vat: v });
const log = { pid: process.pid, worker: cfg.worker, rounds: 0, busy: 0, otherErrors: [], issued: 0 };
for (let r = 0; r < cfg.rounds; r++) {
  const wait = cfg.t0 + r * cfg.stepMs - Date.now(); if (wait > 0) await new Promise(res => setTimeout(res, wait)); // all workers start each round together
  try {
    const out = await processCorrections(db, seller, cfg.reports[r], { api, validate });
    log.issued += out.creditNotes ?? 0;
    for (const e of out.errors ?? []) { const m = String(e.error ?? e.reason ?? e.message ?? e); if (/SQLITE_BUSY|database is locked/i.test(m)) log.busy++; else log.otherErrors.push(m.slice(0, 160)); }
  } catch (e) { const m = String(e.message ?? e); if (/SQLITE_BUSY|database is locked|busy/i.test(m + (e.code ?? ''))) log.busy++; else log.otherErrors.push(m.slice(0, 160)); }
  log.rounds++;
}
console.log('RESULT ' + JSON.stringify(log));
