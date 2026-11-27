import { createLoopStore } from '../../src/loop/store.js';
import { memoryAdapter } from '../../src/history.js';
import * as F from '../../tools/make-loop-fixtures.mjs';
const lrow = (num, order) => [num, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', order, 'Amazon.es'].join(';');
const two = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
const b1 = F.ledger([lrow('AMZ-1', F.O(1))]), b2 = F.ledger([lrow('AMZ-1', F.O(1)), lrow('AMZ-2', F.O(2))]);
let clock = 0; const mk = async () => { const s = createLoopStore(memoryAdapter(), { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (clock++) * 1000).toISOString() }); return s; };
const gap = (p) => p.issues.filter(i => i.family === 'BOOKS_GAP').map(i => ({ state: i.state, reopened: i.reopened, episodes: i.episodes.length, history: i.history.map(h => h.status + '@' + h.file) }));
const load = async (s) => { const v = await s.addVidr({ text: two, declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'report.tsv' }); const l1 = await s.addLedger({ text: b1, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), fileName: 'books1.csv' }); const l2 = await s.addLedger({ text: b2, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-22T11:00:00Z' }), fileName: 'books2.csv' }); return { v, l1, l2 }; };
const idOf = (r) => r;
const out = {};
{ const s = await mk(); await load(s); out.baseline_all_three_imports = gap(await s.project()); }
for (const which of ['l2', 'l1', 'v']) { const s = await mk(); const r = await load(s); const id = idOf(r[which]); const imp = await s.deletionImpact(id);
  const before = await s.project(); let refused = null; try { await s.deleteImport(id); } catch (e) { refused = String(e.message ?? e.reasons ?? e).slice(0, 100); }
  const del = await s.deleteImport(id, { confirmed: true }); const after = await s.project();
  out['delete_' + which] = { previewIssuesDisappearing: imp.issuesDisappearing, previewIssuesChanging: imp.issuesChanging, withoutConfirmationRefused: refused, deleted: del.deleted, importsRemaining: (await s.imports()).length, bookGapBefore: gap(before), bookGapAfter: gap(after), anyMarkerOfIncompleteHistory: JSON.stringify(after).includes('incomplete') || JSON.stringify(after).includes('deleted'), notesAfter: after.coverageNotes.map(n => n.reason.slice(0, 90)).slice(0, 2) }; }
console.log(JSON.stringify(out, null, 1));
