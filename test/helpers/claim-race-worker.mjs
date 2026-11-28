import { readFileSync } from 'node:fs'; import { openDb } from '../../src/db.js'; import { processCorrections } from '../../src/pipeline.js'; import { releaseStuckClaim } from '../../src/claims.js';
const [file, cfgPath] = process.argv.slice(2); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); const db = openDb(file);
const api = { uploadInvoice: async () => 'feed-' + process.pid, feedStatus: async () => ({ status: 'DONE' }) }; const validate = async (v) => ({ status: 'valid', vat: v });
const log = { mode: cfg.mode, ok: 0, refused: 0, errs: [] };
for (let r = 0; r < cfg.items.length; r++) {
  const w = cfg.t0 + r * cfg.stepMs - Date.now(); if (w > 0) await new Promise(res => setTimeout(res, w)); const it = cfg.items[r];
  try { if (cfg.mode === 'issue') { const o = await processCorrections(db, cfg.seller, it.report, { api, validate }); log.ok += o.creditNotes ?? 0; } else { releaseStuckClaim(db, cfg.seller.id, it.key, it.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed', minAgeMs: 0 }); log.ok++; } }
  catch (e) { log.refused++; log.errs.push(String(e.message).slice(0, 70)); }
}
console.log('RESULT ' + JSON.stringify(log));
