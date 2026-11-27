// Problem loop, phase 2: DATA_MISMATCH on confirmed pairs, DUPLICATE_DOCUMENT, DIFFERENCE_EXPLAINED. Ordinary invoices, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import { createLoopStore, Refused } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text, created = '2026-11-20T10:00:00Z') => imp('v', 'vidr', text, F.VDECL(created), '2026-11-20T10:01:00Z');
const LH2 = F.LH + ';NIF comprador';
const P2PROFILE = { ...F.PROFILE, columns: { ...F.PROFILE.columns, buyerTaxId: 'NIF comprador' } };
const row2 = (num, order, { total = '121,00', cur = 'EUR', nif = 'DE811128135' } = {}) => [num, 'Factura', '2026-11-18', '2026-11-17', cur, total, '100,00', '21,00', order, 'Amazon.es', nif].join(';');
const led2 = (rows) => [LH2, ...rows].join('\n') + '\n';
const L = (text, n = 1, exported = '2026-11-20T11:00:00Z', profile = P2PROFILE) => imp('l' + n, 'ledger', text, F.LDECL({ exportedAt: exported }), `2026-11-2${n}T11:01:00Z`, profile);
/** Edit the Amazon rows of one order: buyer vat, currency, VAT-inclusive amount (all rows of that order). */
const vmod = (text, n, { buyer, cur, amt } = {}) => text.split('\n').map(l => { if (!l.includes(F.O(n))) return l; const c = l.split('\t'); if (buyer !== undefined) c[13] = buyer; if (cur !== undefined) c[14] = cur; if (amt !== undefined) c[15] = amt; return c.join('\t'); }).join('\n');
const vone = (n = 1, o = {}) => vmod(F.vidr([{ n, status: 'InvoiceUploaded', num: 'M-1' }]), n, o);
const mm = (r) => r.issues.filter(i => i.family === 'DATA_MISMATCH');
const dup = (r) => r.issues.filter(i => i.family === 'DUPLICATE_DOCUMENT');
const run = (v, l, events = []) => project({ imports: [V(v), l], events });

test('p2 fixtures: committed P2 files equal the generator output', () => {
  for (const [f, t] of Object.entries({ 'p2-vidr.tsv': F.PV, 'p2-ledger-1.csv': F.PL1, 'p2-ledger-2.csv': F.PL2 })) assert.equal(readFileSync(new URL('../fixtures/loop/' + f, import.meta.url), 'utf8'), t, f);
});
test('mismatch: a buyer tax id that differs is ONE problem for the pair, with both values', () => {
  const r = run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })])));
  assert.equal(mm(r).length, 1); const m = mm(r)[0];
  assert.equal(m.state, 'ACTION_REQUIRED'); assert.equal(m.subtype, 'FIELDS_DIFFER');
  const d = m.finding.evidence.differences; assert.equal(d.length, 1); assert.deepEqual([d[0].field, d[0].amazon, d[0].books], ['buyerTaxId', 'DE811128135', 'DE000000000']);
  assert.match(m.card.what, /Buyer tax id: Amazon shows DE811128135, your accounting export shows DE000000000/);
  assert.ok(m.card.proof.some(p => p.role === 'Amazon VAT invoice report') && m.card.proof.some(p => p.role === 'Your accounting export'));
});
test('mismatch: every difference of the pair is in the same single problem', () => {
  const r = run(vone(1), L(led2([row2('M-1', F.O(1), { cur: 'USD', nif: 'DE000000000' })])));
  assert.equal(mm(r).length, 1); assert.deepEqual(mm(r)[0].finding.evidence.differences.map(x => x.field).sort(), ['buyerTaxId', 'currency']);
});
test('fix-1: the invoice total is NEVER compared: a total that differs from the item price (shipping, gift wrap, discount) gives no phantom mismatch, and is listed as not compared', () => {
  // synthetic extra columns: Amazon states the item price; the invoice total also holds shipping, gift wrap and a discount, as separate amounts
  const withExtra = (rows) => { const t = F.vidr(rows).split('\n'); return t.map((l, i) => i === 0 ? l + '\tshipping-vat-incl-amount\tgift-wrap-vat-incl-amount\tpromo-discount-amount' : l ? l + '\t4.90\t2.00\t-5.00' : l).join('\n'); };
  const single = withExtra([{ n: 1, status: 'InvoiceUploaded', num: 'M-1' }]);
  const r = run(single, L(led2([row2('M-1', F.O(1), { total: '122,90' })]))); assert.equal(mm(r).length, 0, 'invoice total = item + shipping + gift wrap + discount, not the item price');
  const multi = withExtra([{ n: 1, status: 'InvoiceUploaded', num: 'M-1' }, { n: 1, status: 'InvoiceUploaded', num: 'M-1' }]); // the shipment values repeat on every row of the transaction
  const r2 = run(multi, L(led2([row2('M-1', F.O(1), { total: '240,80' })]))); assert.equal(mm(r2).length, 0, 'repeated shipment values are never summed');
  const cur = mm(run(vone(1), L(led2([row2('M-1', F.O(1), { cur: 'USD', total: '1,00' })]))))[0];
  assert.deepEqual(cur.finding.evidence.differences.map(x => x.field), ['currency']);
  assert.ok(cur.finding.evidence.notCompared.some(x => x.field === 'gross' && /item price, not the invoice total/.test(x.reason)));
  const ok = run(vone(1), L(led2([row2('M-1', F.O(1), { total: '5,00' })]))); assert.equal(mm(ok).length, 0, 'whatever the invoice total, no mismatch from it');
  assert.equal(ok.issues.filter(i => i.family === 'DATA_MISMATCH').length, 0); assert.equal(ok.buckets.matchedByInvoiceNumber, 1);
});
test('mismatch: an id one side does not state is not compared and never invents a mismatch', () => {
  const noBuyer = run(vone(1, { buyer: '' }), L(led2([row2('M-1', F.O(1), { nif: 'DE811128135' })]))); assert.equal(mm(noBuyer).length, 0);
  const noNif = run(vone(1), L(led2([row2('M-1', F.O(1), { nif: '' })]))); assert.equal(mm(noNif).length, 0);
  const spaced = run(vone(1, { buyer: 'DE 811.128-135' }), L(led2([row2('M-1', F.O(1), { nif: 'de811128135' })]))); assert.equal(mm(spaced).length, 0, 'the same id written differently is the same id');
});
test('fix-4: the buyer tax id is compared only when EVERY Amazon row of the transaction carries it: a value on one row and an empty cell on another is not comparable', () => {
  const two = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'M-1' }, { n: 1, status: 'InvoiceUploaded', num: 'M-1' }]).split('\n');
  const edit = (vals) => two.map((l, i) => { if (i === 0 || !l) return l; const c = l.split('\t'); c[13] = vals[i - 1]; return c.join('\t'); }).join('\n');
  const partial = run(edit(['DE811128135', '']), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })])));
  assert.equal(mm(partial).length, 0, 'the row that carries a value must not decide alone');
  const full = mm(run(edit(['DE811128135', 'DE811128135']), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]))))[0]; assert.ok(full, 'every row states the same id: compared'); assert.deepEqual(full.finding.evidence.differences.map(x => x.field), ['buyerTaxId']);
  const clash = run(edit(['DE811128135', 'DE999999999']), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]))); assert.equal(mm(clash).length, 0, 'rows that disagree among themselves are not comparable');
  const why = (r) => r.issues.length; void why;
  // the reason is stated: through a mismatch on another field
  const withCur = mm(run(edit(['DE811128135', '']), L(led2([row2('M-1', F.O(1), { cur: 'USD', nif: 'DE000000000' })]))))[0];
  assert.ok(withCur.finding.evidence.notCompared.some(x => x.field === 'buyerTaxId' && /only some Amazon rows/.test(x.reason)));
});
test('mismatch: only CONFIRMED pairs (unique number on both sides): a proposal, a different number or a declared link never compares', () => {
  const noNum = vmod(F.vidr([{ n: 1, status: 'InvoiceUploaded' }]), 1, {}); // Amazon shows no number: the order id alone is only a proposal
  assert.equal(mm(run(noNum, L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })])))).length, 0);
  const other = vmod(F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-9' }]), 1, {});
  assert.equal(mm(run(other, L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })])))).length, 0, 'a different number for the same order is no pair');
  const twice = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'M-1' }, { n: 2, status: 'InvoiceUploaded', num: 'M-1' }]);
  assert.equal(mm(run(twice, L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })])))).length, 0, 'two Amazon transactions with one number: not unique');
});
test('mismatch: the key is the pair, never the values; a changed value keeps the key and changes what is shown', () => {
  const a = mm(run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]))))[0], b = mm(run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE111111111' })]))))[0];
  assert.equal(a.key, b.key); assert.notEqual(JSON.stringify(a.finding.evidence.differences), JSON.stringify(b.finding.evidence.differences));
  const other = mm(run(vone(2), L(led2([row2('M-1', F.O(2), { nif: 'DE000000000' })]))))[0]; assert.notEqual(a.key, other.key);
});
test('mismatch: a corrected export of the same pair closes it by evidence; a field that can no longer be compared does not', () => {
  const v = vone(1), bad = L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]), 1);
  const fixed = L(led2([row2('M-1', F.O(1))]), 2, '2026-11-21T11:00:00Z');
  const closed = project({ imports: [V(v), bad, fixed] }); const c = mm(closed)[0];
  assert.equal(c.state, 'VERIFIED_CLOSED'); assert.equal(c.outcome, 'evidence'); assert.equal(c.history[c.history.length - 1].status, 'CLOSED'); assert.equal(c.history[0].status, 'PRESENT'); assert.ok(c.episodes[0].closedBy);
  const noNif = L(led2([row2('M-1', F.O(1), { nif: '' })]), 2, '2026-11-21T11:00:00Z');   // total fixed, the buyer id that differed is now missing
  const open = mm(project({ imports: [V(v), bad, noNif] }))[0];
  assert.notEqual(open.state, 'VERIFIED_CLOSED'); assert.equal(open.state, 'OPEN'); assert.match(open.card.title, /Cannot confirm/);
  const again = mm(project({ imports: [V(v), bad, fixed, L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]), 3, '2026-11-22T11:00:00Z')] }))[0];
  assert.equal(again.state, 'ACTION_REQUIRED'); assert.equal(again.episodes.length, 2, 'a later disagreement reopens it as a new episode');
});
test('explained: DIFFERENCE_EXPLAINED gives MANUALLY_REPORTED_RESOLUTION, never VERIFIED_CLOSED, and keeps author, time and words', () => {
  const base = run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]))), m = mm(base)[0];
  const e = { id: 'x1', type: 'DIFFERENCE_EXPLAINED', issueKey: m.key, author: 'Accountant', reasoning: 'rounding of a promotion, booked on purpose', createdAt: '2026-11-20T12:00:00Z', basedOnFingerprint: m.fingerprint };
  const r = run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })])), [e]), x = mm(r)[0];
  assert.equal(x.state, 'MANUALLY_REPORTED_RESOLUTION'); assert.equal(x.outcome, 'declaration'); assert.equal(x.declaration.author, 'Accountant'); assert.equal(x.declaration.reasoning, e.reasoning);
  assert.equal(r.buckets.closedWithEvidence, 0); assert.equal(r.buckets.reportedResolvedBySeller, 1); assert.match(x.card.stateNote, /No file confirms it/);
});
test('explained: it lapses when the values change, and refuses on every other family and on a general declaration', async () => {
  const base = run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]))), m = mm(base)[0];
  const e = { id: 'x1', type: 'DIFFERENCE_EXPLAINED', issueKey: m.key, author: 'a', reasoning: 'because', createdAt: '2026-11-20T12:00:00Z', basedOnFingerprint: m.fingerprint };
  const changed = mm(run(vone(1), L(led2([row2('M-1', F.O(1), { nif: 'DE111111111' })])), [e]))[0];
  assert.equal(changed.state, 'ACTION_REQUIRED'); assert.equal(changed.lapsedDeclarations.length, 1);
  const s = createLoopStore(memoryAdapter(), { now: (() => { let t = Date.parse('2026-11-20T10:00:00Z'); return () => new Date(t += 60000).toISOString(); })() });
  await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const r = await s.project(), rej = r.issues.find(i => i.family === 'INVOICE_AMAZON_STATE');
  await assert.rejects(() => s.addEvent({ type: 'DIFFERENCE_EXPLAINED', issueKey: rej.key, author: 'a', reasoning: 'x' }), Refused);
  const udoc = r.issues.find(i => i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'NO_CANDIDATE');
  await assert.rejects(() => s.addEvent({ type: 'DIFFERENCE_EXPLAINED', issueKey: udoc.key, author: 'a', reasoning: 'x' }), Refused);
  const s2 = createLoopStore(memoryAdapter()); await s2.addVidr({ text: vone(1), declared: F.VDECL('2026-11-20T10:00:00Z') }); await s2.addLedger({ text: led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]), profile: P2PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }) });
  const mi = (await s2.project()).issues.find(i => i.family === 'DATA_MISMATCH');
  await assert.rejects(() => s2.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'DIFFERENCE_EXPLAINED', issueKey: mi.key, author: 'a', reasoning: 'x' }), Refused, 'a general declaration cannot explain a difference');
  await assert.rejects(() => s2.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'RESOLUTION_DECLARED', issueKey: mi.key, author: 'a', reasoning: 'x' }), Refused);
  await assert.rejects(() => s2.addEvent({ type: 'DIFFERENCE_EXPLAINED', issueKey: mi.key, author: 'a', reasoning: '' }), Refused, 'words are required');
  await s2.addEvent({ type: 'DIFFERENCE_EXPLAINED', issueKey: mi.key, author: 'a', reasoning: 'booked on purpose' });
  const after = (await s2.project()).issues.find(i => i.key === mi.key); assert.equal(after.state, 'MANUALLY_REPORTED_RESOLUTION'); assert.equal((await s2.bundle()).headline.verifiedClosedByEvidence, 0);
});
test('duplicate: one document identity twice in ONE file with different content is one problem, rows named, and nothing is picked', () => {
  const l = led2([row2('M-1', F.O(1)), row2('M-1', F.O(1), { total: '99,00' })]), r = run(vone(1), L(l));
  assert.equal(dup(r).length, 1); assert.equal(dup(r)[0].subtype, 'SAME_NUMBER_DIFFERENT_CONTENT'); assert.deepEqual(dup(r)[0].finding.evidence.rowNumbers, ['row 2', 'row 3']);
  assert.equal(mm(r).length, 0, 'no pair is compared while the identity holds two documents'); assert.equal(r.issues.filter(i => i.subject?.number === 'M-1' && i.family === 'UNMATCHED_DOCUMENT').length, 0);
});
test('duplicate: identical copies in one file are a duplicate of kind EXACT_REPEAT', () => {
  const r = run(vone(1), L(led2([row2('M-1', F.O(1)), row2('M-1', F.O(1))]))); assert.equal(dup(r).length, 1); assert.equal(dup(r)[0].subtype, 'EXACT_REPEAT');
});
test('duplicate: a re-export of the same document in a later file is NEVER a duplicate, identical or changed', () => {
  const v = V(vone(1)), a = L(led2([row2('M-1', F.O(1))]), 1), same = L(led2([row2('M-1', F.O(1))]), 2, '2026-11-21T11:00:00Z');
  assert.equal(dup(project({ imports: [v, a, same] })).length, 0, 'identical re-export');
  const changed = L(led2([row2('M-1', F.O(1), { nif: 'DE000000000' })]), 2, '2026-11-21T11:00:00Z');
  assert.equal(dup(project({ imports: [v, a, changed] })).length, 0, 'changed re-export replaces the record'); assert.equal(mm(project({ imports: [v, a, changed] })).length, 1, 'and the new content is compared');
  const partial = imp('l2p', 'ledger', led2([row2('M-1', F.O(1))]), F.LDECL({ complete: false, exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', P2PROFILE);
  assert.equal(dup(project({ imports: [v, a, partial] })).length, 0, 'a partial export that repeats it');
});
test('duplicate: a corrected file in which the document appears once closes it by evidence; no declaration closes it', async () => {
  const v = V(vone(1)), twice = L(led2([row2('M-1', F.O(1)), row2('M-1', F.O(1), { total: '99,00' })]), 1), once = L(led2([row2('M-1', F.O(1))]), 2, '2026-11-21T11:00:00Z');
  const d = dup(project({ imports: [v, twice, once] }))[0]; assert.equal(d.state, 'VERIFIED_CLOSED'); assert.equal(d.outcome, 'evidence');
  const open = dup(project({ imports: [v, twice] }))[0];
  const e = { id: 'd1', type: 'RESOLUTION_DECLARED', kind: 'RESOLUTION_DECLARED', issueKey: open.key, author: 'a', reasoning: 'x', createdAt: '2026-11-20T12:00:00Z', basedOnFingerprint: open.fingerprint };
  assert.equal(dup(project({ imports: [v, twice], events: [e] }))[0].state, 'OPEN', 'a declaration is ignored for a duplicate (information only, Ledger Data Quality)');
  const s = createLoopStore(memoryAdapter()); await s.addVidr({ text: vone(1), declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: led2([row2('M-1', F.O(1)), row2('M-1', F.O(1))]), profile: P2PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }) });
  const di = (await s.project()).issues.find(i => i.family === 'DUPLICATE_DOCUMENT');
  await assert.rejects(() => s.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'RESOLUTION_DECLARED', issueKey: di.key, author: 'a', reasoning: 'x' }), Refused);
});
test('p2 fixtures end to end: round 1 shows one mismatch and one duplicate, round 2 closes both by evidence and nothing is invented', () => {
  const v = V(F.PV), l1 = imp('pl1', 'ledger', F.PL1, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE), l2 = imp('pl2', 'ledger', F.PL2, F.LDECL({ exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  const r1 = project({ imports: [v, l1] }); assert.equal(mm(r1).length, 1); assert.equal(dup(r1).length, 1); assert.equal(r1.buckets.closedWithEvidence, 0);
  const r2 = project({ imports: [v, l1, l2] }); assert.ok(mm(r2).every(i => i.state === 'VERIFIED_CLOSED')); assert.ok(dup(r2).every(i => i.state === 'VERIFIED_CLOSED'));
  console.log('P2 round 1:', JSON.stringify({ mismatch: mm(r1).map(i => i.card.what), duplicate: dup(r1).map(i => i.card.what), states: r1.issues.map(i => `${i.family}/${i.subtype}/${i.state}`) }));
  console.log('P2 round 2:', JSON.stringify({ states: r2.issues.map(i => `${i.family}/${i.subtype}/${i.state}`), closedWithEvidence: r2.buckets.closedWithEvidence, matched: r2.buckets.matchedByInvoiceNumber }));
});
test('p2 determinism: the same imports in any order and the same events give identical results, and the inputs are not mutated', () => {
  const v = V(F.PV), l1 = imp('pl1', 'ledger', F.PL1, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE), l2 = imp('pl2', 'ledger', F.PL2, F.LDECL({ exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  const snap = JSON.stringify([v, l1, l2]), a = project({ imports: [v, l1, l2] }), b = project({ imports: [l2, l1, v] });
  assert.equal(JSON.stringify(a.issues.map(i => [i.key, i.state])), JSON.stringify(b.issues.map(i => [i.key, i.state]))); assert.equal(JSON.stringify([v, l1, l2]), snap);
});

const LV = (text, n, exported, level, complete = true) => imp('l' + n, 'ledger', text, F.LDECL({ exportedAt: exported, documentLevel: level, complete }), `2026-11-2${n}T11:01:00Z`, P2PROFILE);
test('fix-2: a newer PARTIAL export that holds the document once does NOT close a duplicate of a complete file; only a complete file of the same scope does', () => {
  const v = V(vone(1)), twice = LV(led2([row2('M-1', F.O(1)), row2('M-1', F.O(1), { total: '99,00' })]), 1, '2026-11-20T11:00:00Z', 'DOCUMENT');
  const partialOnce = LV(led2([row2('M-1', F.O(1))]), 2, '2026-11-21T11:00:00Z', 'DOCUMENT', false);
  const r = project({ imports: [v, twice, partialOnce] }), d = dup(r)[0];
  assert.equal(dup(r).length, 1); assert.equal(d.state, 'OPEN'); assert.equal(d.section, 'LEDGER_DATA_QUALITY'); assert.notEqual(d.state, 'VERIFIED_CLOSED'); assert.equal(r.buckets.closedWithEvidence, 0);
  assert.equal(mm(r).length, 0, 'no pair is compared while the duplicate stands');
  const completeOnce = LV(led2([row2('M-1', F.O(1))]), 3, '2026-11-22T11:00:00Z', 'DOCUMENT');
  assert.equal(dup(project({ imports: [v, twice, partialOnce, completeOnce] }))[0].state, 'VERIFIED_CLOSED', 'a complete file of the same scope closes it');
});
test('fix-3: where the file does not say what one row is, repeated rows are an UNDETERMINED suspicion, never a duplicate, and the card never tells the seller to remove rows', () => {
  const v = V(vone(1)), lines = led2([row2('M-1', F.O(1), { total: '60,50' }), row2('M-1', F.O(1), { total: '60,50' }), row2('M-1', F.O(1), { total: '30,00' })]);
  const unknown = project({ imports: [v, LV(lines, 1, '2026-11-20T11:00:00Z', undefined)] }), d = dup(unknown)[0];
  assert.equal(d.subtype, 'SUSPECTED_DUPLICATE'); assert.equal(d.state, 'OPEN', 'shown as a case for a human reading, not as an action'); assert.notEqual(d.state, 'ACTION_REQUIRED'); assert.notEqual(d.state, 'VERIFIED_CLOSED');
  assert.match(d.card.action, /state what one row is/); assert.match(d.card.action, /Do not remove rows/); assert.doesNotMatch(JSON.stringify(d.card), /Correct the export so the document appears once/);
  assert.equal(unknown.buckets.closedWithEvidence, 0);
  const asLines = project({ imports: [v, LV(lines, 1, '2026-11-20T11:00:00Z', 'LINE')] }); assert.equal(dup(asLines).length, 0, 'declared one row per line item: the repeat is expected, no problem'); assert.equal(asLines.buckets.matchedByInvoiceNumber, 1);
  const asDoc = dup(project({ imports: [v, LV(lines, 1, '2026-11-20T11:00:00Z', 'DOCUMENT')] }))[0]; assert.equal(asDoc.state, 'OPEN'); assert.equal(asDoc.section, 'LEDGER_DATA_QUALITY'); assert.equal(asDoc.subtype, 'SAME_NUMBER_DIFFERENT_CONTENT'); assert.match(asDoc.card.action, /Do not delete anything that is correct/);
  const identityClash = project({ imports: [v, LV(led2([row2('M-1', F.O(1)), row2('M-1', F.O(1), { nif: 'DE000000000' })]), 1, '2026-11-20T11:00:00Z', 'LINE')] }); assert.equal(dup(identityClash).length, 1, 'even per line, the document-level fields must agree');
  const cc = dup(identityClash)[0].card, txt = JSON.stringify(cc);
  assert.match(cc.title, /disagree on data that belongs to the whole document/); assert.match(cc.what, /declared that each row of this export is one line item/); assert.match(cc.what, /buyer tax id \(row 2: DE811128135; row 3: DE000000000\)/); assert.match(cc.what, /Rows row 2, row 3/);
  assert.doesNotMatch(txt, /You declared that one row of this export is a whole document/); assert.doesNotMatch(txt, /declare that one row is one line item/); assert.doesNotMatch(txt, /Correct the export so the document appears once/);
  assert.match(cc.why, /are supposed to be the same on every line of one document/); assert.match(cc.why, /The rows shown here mark where they differ/); assert.doesNotMatch(cc.why, /are the same for every line/);
  assert.match(cc.action, /Nothing in this message means that a row should be deleted/); assert.doesNotMatch(cc.action, /delete (the|a|any) row|remove rows/i);
  console.log('LINE-conflict card:', JSON.stringify({ title: cc.title, what: cc.what, action: cc.action }));
  const later = project({ imports: [v, LV(lines, 1, '2026-11-20T11:00:00Z', undefined), LV(lines, 2, '2026-11-21T11:00:00Z', 'LINE')] }); assert.equal(dup(later)[0].state, 'VERIFIED_CLOSED', 'a later complete export that declares the level settles it'); assert.match(dup(later)[0].episodes[0].closedBy.why, /declared by the seller/);
});
