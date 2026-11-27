// Synthetic scenarios shared by the coverage tests and the V5-unchanged regression. Never real data.
import { sha256 } from '../../src/loop/sha256.js';
import * as F from '../../tools/make-loop-fixtures.mjs';
export const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const setCol = (line, i, v) => { const c = line.split('\t'); c[i] = v; return c.join('\t'); };
const FLAG = F.vidr([{ n: 1, status: 'InvoiceUploaded' }]).split('\n')[0].split('\t').indexOf('is-business-order');
/** rows: [{n, status, num, flag}] ; extra raw rows may repeat a shipment (several item rows of ONE shipment). */
export function vidrWith(rows, extra = []) {
  const lines = rows.map(r => setCol(F.vrow(r), FLAG, r.flag ?? 'TRUE')).concat(extra.map(r => setCol(F.vrow(r), FLAG, r.flag ?? 'TRUE')));
  return [F.vidr([]).split('\n')[0], ...lines].join('\n') + '\n';
}
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const Lg = (rows) => imp('l', 'ledger', F.ledger(rows), F.LDECL({ exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const lr = (num, n) => F.L.row(num, '2026-11-18', '2026-11-17', F.O(n));
export const MIXED = () => ({ imports: [
  V(vidrWith([
    { n: 1, status: 'InvoiceUploaded', num: 'M-1', flag: 'TRUE' }, { n: 2, status: 'InvoiceUploaded', num: 'M-2', flag: 'TRUE' },
    { n: 3, status: 'InvoiceUploaded', num: 'M-3', flag: 'FALSE' }, { n: 4, status: 'InvoiceUploaded', num: 'M-4', flag: 'FALSE' },
    { n: 5, status: 'InvoiceUploaded', num: 'M-5', flag: '' }, { n: 6, status: 'InvoiceUploaded', num: 'M-6', flag: 'TRUE' }],
  [{ n: 1, status: 'InvoiceUploaded', num: 'M-1', flag: 'TRUE' }, { n: 6, status: 'InvoiceUploaded', num: 'M-6', flag: 'FALSE' }])),
  Lg([lr('M-1', 1), lr('M-3', 3)])], events: [] });
export const SCENARIOS = () => ({
  mixed: MIXED(),
  loop1: { imports: [imp('v1', 'vidr', F.V1, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), imp('l1', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE)], events: [] },
  loop2: { imports: [imp('v1', 'vidr', F.V1, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), imp('l1', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE), imp('v2', 'vidr', F.V2, F.VDECL('2026-11-25T10:00:00Z'), '2026-11-25T10:01:00Z'), imp('l2', 'ledger', F.L2, F.LDECL({ exportedAt: '2026-11-25T11:00:00Z' }), '2026-11-25T11:01:00Z', F.PROFILE)], events: [] },
  pilot: { imports: [imp('pv', 'vidr', F.PV, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), imp('pl', 'ledger', F.PL1, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE)], events: [] },
});
