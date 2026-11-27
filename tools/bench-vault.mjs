// P3 performance benchmark, synthetic data only. Node's Web Crypto (the same primitives the browser uses); reconciliation is the real engine.
import { createVault } from '../src/loop/vault.js';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from './make-loop-fixtures.mjs';
const N = Number(process.argv[2] || 2000), ms = (t) => Math.round(performance.now() - t);
const vidrRows = [], ledRows = []; for (let n = 1; n <= N; n++) { vidrRows.push({ n: 100 + n, status: 'InvoiceUploaded', num: 'B-' + n }); ledRows.push([`B-${n}`, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', F.O(100 + n), 'Amazon.es'].join(';')); }
const vidr = F.vidr(vidrRows), ledger = F.LH + '\n' + ledRows.join('\n') + '\n';
const out = { rows: N, vidrBytes: vidr.length, ledgerBytes: ledger.length };
const mem = () => Math.round(process.memoryUsage().heapUsed / 1048576);
for (const [label, mk] of [['plain', async () => ({ adapter: memoryAdapter() })], ['vault', async () => { const raw = memoryAdapter(), v = createVault(raw); let t = performance.now(); await v.create('correct horse battery'); out.vaultCreateMs = ms(t); t = performance.now(); v.lock(); await v.unlock('correct horse battery'); out.unlockMs = ms(t); return { adapter: v.adapter, v, raw }; }]]) {
  const h = await mk(), s = createLoopStore(h.adapter, { now: () => '2026-11-20T10:00:00Z' });
  let t = performance.now(); await s.addVidr({ text: vidr, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: ledger, profile: F.PROFILE, declared: F.LDECL() }); out[label + 'ImportMs'] = ms(t);
  t = performance.now(); const imps = await s.imports(); out[label + 'ReadMs'] = ms(t); t = performance.now(); const r = await s.project(); out[label + 'ProjectMs'] = ms(t); out[label + 'Issues'] = r.issues.length;
  if (h.v) { t = performance.now(); const bk = await h.v.exportBackup(); out.backupMs = ms(t); out.backupBytes = JSON.stringify(bk).length; const raw2 = memoryAdapter(), v2 = createVault(raw2); t = performance.now(); await v2.restoreBackup(JSON.parse(JSON.stringify(bk)), 'correct horse battery'); out.restoreMs = ms(t); }
  out[label + 'HeapMB'] = mem(); void imps;
}
console.log(JSON.stringify(out, null, 1));
