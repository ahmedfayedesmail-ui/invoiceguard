// WP7 measurement script (lab branch, synthetic data only). Local machine numbers, not CI. Usage: node lab/perf/perf-night.mjs
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { parseVidr } from '../../src/vidr.js'; import { assessShipment } from '../../src/integrity-core.js'; import { openDb } from '../../src/db.js'; import { processReport } from '../../src/pipeline.js';
const FX = readFileSync(new URL('../../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n'); const H = FX[0].split('\t'); const ix = k => H.indexOf(k);
const rowOf = (ship, item, over = {}) => { const c = FX[1].split('\t'); while (c.length < H.length) c.push(''); c[ix('shipping-id')] = 'S' + ship; c[ix('transaction-id')] = 'S' + ship; c[ix('order-id')] = `405-${String(ship).padStart(7, '0')}-7710365`; c[ix('order-item-id')] = String(item); c[ix('sku')] = 'SKU' + item; for (const [k, v] of Object.entries(over)) c[ix(k)] = v; return c.join('\t'); };
const mb = () => Math.round(process.memoryUsage().rss / 1048576); const t0 = () => performance.now(); const ms = (t) => Math.round(performance.now() - t);
const out = [];
for (const n of [1, 100, 1000, 5000]) { const text = [FX[0], ...Array.from({ length: n }, (_, i) => rowOf(1, i + 1))].join('\n') + '\n'; let t = t0(); const s = parseVidr(text)[0]; const tp = ms(t); t = t0(); const a = assessShipment(s); out.push({ test: `one shipment, ${n} rows`, parseMs: tp, assessMs: ms(t), findings: a.findings.length, rssMb: mb() }); }
const api = { uploadInvoice: async () => 'f', feedStatus: async () => ({ status: 'DONE' }) }, vies = async v => ({ status: 'valid', vat: v }), SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
for (const n of [500, 2000]) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-')); try {
    const db = openDb(join(dir, 'p.db')); const rows = []; for (let i = 0; i < n; i++) rows.push(rowOf(10000 + i, 1, i % 4 === 0 ? { 'item-vat-amount': '8,4x' } : i % 7 === 0 ? { currency: 'JPY' } : {}));
    const text = [FX[0], ...rows].join('\n') + '\n'; let t = t0(); const r = await processReport(db, SELLER, text, { api, validate: vies, now: new Date('2026-11-25T13:00:00Z') });
    const first = ms(t), sizeAfter1 = statSync(join(dir, 'p.db')).size, hist1 = db.prepare('SELECT count(*) c FROM integrity_history').get().c, fnd = db.prepare('SELECT count(*) c FROM integrity_findings').get().c; t = t0();
    for (let k = 0; k < 4; k++) await processReport(db, SELLER, text, { api, validate: vies, now: new Date('2026-11-25T13:00:00Z') });
    const rerunMs = Math.round(ms(t) / 4), hist5 = db.prepare('SELECT count(*) c FROM integrity_history').get().c, size5 = statSync(join(dir, 'p.db')).size;
    const q = t0(); db.prepare("SELECT count(*) c FROM integrity_findings WHERE status='OPEN'").get(); db.prepare("SELECT * FROM integrity_findings WHERE seller_id=? AND shipment_key=?").all('sel1', 'SHIPMENT:S10001'); const queryMs = ms(q);
    out.push({ test: `processReport ${n} shipments (25% bad amount, ~11% JPY)`, firstMs: first, rerunMsEach: rerunMs, uploaded: r.uploaded, held: r.held.length, findings: fnd, history1: hist1, historyAfter5: hist5, dbBytes1: sizeAfter1, dbBytes5: size5, queryMs, rssMb: mb() });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(JSON.stringify(out, null, 1));
