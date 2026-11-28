// Issuing process for K14/K15. It runs the real correction pass on a file database and FREEZES (synchronously, as a hung or suspended process would) right after its claim is committed and before it writes the document.
import { readFileSync } from 'node:fs'; import { openDb } from '../../src/db.js'; import { processCorrections } from '../../src/pipeline.js';
const [file, cfgPath] = process.argv.slice(2); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); const db = openDb(file);
const api = { uploadInvoice: async () => 'feed-' + process.pid, feedStatus: async () => ({ status: 'DONE' }) }; const validate = async (v) => ({ status: 'valid', vat: v });
let frozen = false; const exec = db.exec.bind(db);
db.exec = (sql) => { const r = exec(sql); if (!frozen && /^\s*COMMIT/i.test(sql) && db.prepare('SELECT count(*) c FROM credit_claims').get().c > 0 && db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c === 0) { frozen = true; console.log('FROZEN pid=' + process.pid); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cfg.freezeMs); } return r; };
try { const o = await processCorrections(db, cfg.seller, cfg.report, { api, validate }); console.log('DONE ' + JSON.stringify({ cn: o.creditNotes, errors: o.errors })); } catch (e) { console.log('CRASH ' + e.message); }
