// Runs the exact V1 files of the audited sellers through the CURRENT engine (the checkout this script sits in). Read-only, synthetic data.
// usage: node tools/audit-v1-current.mjs <dump-dir> <out.json>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
const [dir, out] = process.argv.slice(2); const res = {};
for (const f of readdirSync(dir).filter(x => x.startsWith('seller-'))) {
  const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); let n = 0;
  const s = createLoopStore(memoryAdapter(), { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (n++) * 1000).toISOString() });
  try { await s.addVidr({ text: d.vText, declared: d.vdecl, fileName: 'vidr.tsv' }); await s.addLedger({ text: d.lText, profile: d.profile, declared: d.ldecl, fileName: 'books.csv' }); const p = await s.project(); const by = {}; for (const i of p.issues) { const k = `${i.family}/${i.subtype}/${i.state}`; by[k] = (by[k] ?? 0) + 1; }
    res[d.seller] = { scenario: d.scenario, byFamily: by, confident: p.issues.filter(i => i.state === 'ACTION_REQUIRED').length, notes: (p.coverageNotes ?? []).map(x => `${x.count} x ${x.reason}`).slice(0, 4) }; }
  catch (e) { res[d.seller] = { scenario: d.scenario, error: String(e.message).slice(0, 200) }; }
}
writeFileSync(out, JSON.stringify(res, null, 1)); console.log(Object.keys(res).length);
