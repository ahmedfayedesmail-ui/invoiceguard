// A real second OS process for the credit-note race tests (one SQLite file, shared with the parent test and another worker).
// usage: node cn-race-worker.mjs <dbfile> <role: issue|contradict> <goFile> <payloadFile>
// It opens the database, waits until the go-file exists (a real barrier), then performs its action once and prints one JSON line.
import { readFileSync, existsSync } from 'node:fs'; import { openDb } from '../../src/db.js'; import { processReport, processCorrections } from '../../src/pipeline.js';
const [, , file, role, go, payloadFile] = process.argv; const P = JSON.parse(readFileSync(payloadFile, 'utf8')); const db = openDb(file); const vies = async (v) => ({ status: 'valid', vat: v });
const api = { calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (!existsSync(go)) sleep(2);
if (P.delayMs?.[role]) sleep(P.delayMs[role]);
let out;
try {
  if (role === 'issue') out = await processCorrections(db, P.seller, P.pairReport, { api, validate: vies });
  else if (role === 'contradict') out = await processReport(db, P.seller, P.rejectedReport, { api, validate: vies, reportAttemptSeq: P.seq, reportRequestedAt: new Date(P.reqTs) });
  console.log(JSON.stringify({ role, ok: true, uploads: api.calls.length, creditNotes: out?.creditNotes ?? null, invoices: out?.invoices ?? null }));
} catch (e) { console.log(JSON.stringify({ role, ok: false, error: String(e.message).slice(0, 200) })); }
