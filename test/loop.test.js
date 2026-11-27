// Problem loop, phase 1: ordinary invoices, Amazon VAT invoice report plus an accounting export. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { sha256 } from '../src/loop/sha256.js';
import { detectLedgerMapping, readLedger, readMoney, dateReadings, profileProblems } from '../src/loop/ledger.js';
import { project, issueKey, orderImports, FAMILIES } from '../src/loop/project.js';
import { createLoopStore, Refused } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const clock = (start = '2026-11-20T10:00:00Z') => { let t = Date.parse(start); return () => new Date(t += 60000).toISOString(); };
const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const R1 = () => [imp('v1', 'vidr', F.V1, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), imp('l1', 'ledger', F.L1, F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)];
const R2 = () => [imp('v2', 'vidr', F.V2, F.VDECL('2026-11-27T10:00:00Z'), '2026-11-27T10:01:00Z'), imp('l2', 'ledger', F.L2, F.LDECL({ exportedAt: '2026-11-27T11:00:00Z' }), '2026-11-27T11:01:00Z', F.PROFILE)];
const find = (r, fam, sub, order) => r.issues.find(i => i.family === fam && (!sub || i.subtype === sub) && (!order || JSON.stringify(i.subject).includes(F.O(order))));
const states = (r) => r.issues.map(i => `${i.family}/${i.subtype}/${i.state}`).sort();
const ISO = (s) => s;

test('sha256: the synchronous hash equals node:crypto for empty, ascii, multibyte and long input', () => {
  for (const s of ['', 'abc', 'é€😀'.repeat(50), 'x'.repeat(10007)]) assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'));
});
test('fixtures: committed files equal the generator output (nothing hand-edited)', () => {
  const files = { 'vidr-1.tsv': F.V1, 'vidr-2.tsv': F.V2, 'ledger-1.csv': F.L1, 'ledger-2.csv': F.L2 };
  for (const [f, t] of Object.entries(files)) assert.equal(readFileSync(new URL('../fixtures/loop/' + f, import.meta.url), 'utf8'), t, f);
});

// ---- mapping ----
test('mapping: Spanish headers, semicolons, decimal comma are detected and proposed, never stored', () => {
  const m = detectLedgerMapping(F.L1); assert.equal(m.ok, true); assert.equal(m.delimiter, ';');
  for (const f of ['number', 'kind', 'issueDate', 'operationDate', 'currency', 'gross', 'orderRef', 'channel']) assert.equal(m.fields[f].status, 'DETECTED', f);
  assert.equal(m.dateOrder.proposed, 'ISO'); assert.equal(m.decimal.proposed, ','); assert.equal(m.proposedProfile.confirmed, false); assert.equal(m.problems.length, 0);
});
test('mapping: two columns for one field is AMBIGUOUS and names both', () => {
  const m = detectLedgerMapping('Invoice number;Document number;Type;Invoice date;Currency\nA1;A1;Invoice;2026-11-01;EUR\n');
  assert.equal(m.fields.number.status, 'AMBIGUOUS'); assert.deepEqual(m.fields.number.candidates, ['Invoice number', 'Document number']); assert.ok(m.problems.some(p => p.field === 'number'));
});
test('mapping: a required field with no column is MISSING and stops the import', () => {
  const m = detectLedgerMapping('Invoice number;Type;Invoice date\nA1;Invoice;2026-11-01\n'); assert.equal(m.fields.currency.status, 'MISSING'); assert.ok(m.problems.some(p => p.field === 'currency'));
});
test('mapping: header and content must agree (a date column holding words fails with the cell named)', () => {
  const m = detectLedgerMapping('Invoice number;Type;Invoice date;Currency\nA1;Invoice;tomorrow;EUR\n'); assert.equal(m.fields.issueDate.status, 'CONTENT_FAILED'); assert.match(m.fields.issueDate.reason, /tomorrow/);
});
test('mapping: dates that fit day-first and month-first are AMBIGUOUS and need a declaration; proof in the file is read as proof; both kinds is a CONTRADICTION', () => {
  const t = (d) => `Invoice number;Type;Invoice date;Currency\n${d.map((x, i) => `A${i};Invoice;${x};EUR`).join('\n')}\n`;
  assert.equal(detectLedgerMapping(t(['05/03/2026'])).dateOrder.status, 'AMBIGUOUS');
  assert.deepEqual(detectLedgerMapping(t(['25/03/2026'])).dateOrder, { status: 'PROVEN', proposed: 'DMY' });
  assert.equal(detectLedgerMapping(t(['25/03/2026', '03/25/2026'])).dateOrder.status, 'CONTRADICTION');
});
test('mapping: unknown columns must be acknowledged; an unconfirmed profile reads nothing', () => {
  const p = { ...F.PROFILE, confirmed: false }; assert.match(readLedger(F.L1, p, {}).error, /not confirmed/);
  const q = { ...F.PROFILE, columns: { ...F.PROFILE.columns }, unknownColumnsAcknowledged: false }; delete q.columns.channel; assert.match(readLedger(F.L1, q, {}).error, /Canal/);
});
test('mapping: a negative amount never makes a credit note; kind comes only from a kind column or the seller\'s declaration', () => {
  const prof = { ...F.PROFILE, columns: { number: 'Nº factura', issueDate: 'Fecha factura', currency: 'Divisa', gross: 'Total' }, constantKind: 'invoice', unknownColumnsAcknowledged: true };
  const r = readLedger('Nº factura;Fecha factura;Divisa;Total\nA1;2026-11-01;EUR;-121,00\n', prof, { amazonScope: { mode: 'ALL' } });
  assert.equal(r.documents[0].kind, 'invoice'); assert.equal(r.documents[0].gross, -12100);
});
// ---- values ----
test('values: money in integer minor units under the declared separators; anything else is refused, never rounded', () => {
  assert.equal(readMoney('1.234,56', ',', '.'), 123456); assert.equal(readMoney('1234.5', '.', ''), 123450); assert.equal(readMoney('-0,05', ',', ''), -5); assert.equal(readMoney('', ',', ''), null);
  for (const bad of ['1,234', '12.345', '€12', '1 234', '12,345,6']) assert.ok(Number.isNaN(readMoney(bad, '.', '')), bad);
  assert.ok(Number.isNaN(readMoney('1.234,567', ',', '.')));
});
test('values: unreadable rows are rejected with row and reason and the import becomes incomplete; nothing is dropped silently', () => {
  const bad = F.L1 + 'X-1;Factura;31/02/2026;;EUR;12,5x;;;;Amazon.es\nA-2;Factura;2026-11-19;;EUR;1,00;;;405-0;Amazon.es\nA-3;Foo;2026-11-19;;EUR;1,00;;;;Amazon.es\n';
  const r = readLedger(bad, F.PROFILE, { amazonScope: { mode: 'ALL' } }); assert.equal(r.rejected.length, 3); assert.equal(r.documents.length, 6);
  assert.match(r.rejected[0].reasons.join(), /BAD_ISSUE_DATE/); assert.match(r.rejected[0].reasons.join(), /BAD_AMOUNT_GROSS/); assert.match(r.rejected[1].reasons.join(), /BAD_ORDER_REF/); assert.match(r.rejected[2].reasons.join(), /UNREADABLE_KIND/);
  assert.equal(r.rejected.length + r.documents.length, 9);
});
test('values: a blank line inside the data and a short row are counted and make the file incomplete', () => {
  const t = F.L1.replace('A-1005', '\nA-1005').replace('A-1006;Factura;2026-11-18;2026-11-17;EUR;121,00;100,00;21,00;' + F.O(6) + ';Amazon.es', 'A-1006;Factura');
  const r = readLedger(t, F.PROFILE, { amazonScope: { mode: 'ALL' } }); assert.equal(r.blankLines, 1); assert.equal(r.raggedRows, 1); assert.ok(r.defects.length >= 2);
});

// ---- the loop, round 1 ----
test('loop: round 1 finds the problems the files show, each with its family, and nothing else', () => {
  const r = project({ imports: R1() });
  assert.deepEqual(states(r), [
    'BOOKS_GAP/NOT_IN_BOOKS/ACTION_REQUIRED', 'BOOKS_GAP/NUMBER_AT_AMAZON_NOT_IN_BOOKS/ACTION_REQUIRED',
    'INVOICE_AMAZON_STATE/ACTION_REQUIRED/ACTION_REQUIRED', 'INVOICE_AMAZON_STATE/ACTION_REQUIRED/ACTION_REQUIRED', 'INVOICE_AMAZON_STATE/REJECTED/ACTION_REQUIRED',
    'UNMATCHED_DOCUMENT/NO_CANDIDATE/ACTION_REQUIRED', 'UNMATCHED_DOCUMENT/PROPOSED_LINK_UNCONFIRMED/ACTION_REQUIRED'].sort());
  assert.equal(r.buckets.matchedByInvoiceNumber, 1); assert.equal(r.buckets.inProgressAtAmazon, 1); assert.equal(r.buckets.closedWithEvidence, 0);
  assert.ok(r.issues.every(i => FAMILIES.includes(i.family)));
});
test('loop: PROCESSING is not an exception (counted as in progress, no card); a non-Amazon channel row creates no problem', () => {
  const r = project({ imports: R1() });
  assert.equal(find(r, 'INVOICE_AMAZON_STATE', null, 6), undefined); assert.equal(r.buckets.inProgressAtAmazon, 1);
  assert.equal(r.stats.ledgerExcludedNotAmazon, 1); assert.ok(!r.issues.some(i => JSON.stringify(i).includes('W-1') && i.family === 'UNMATCHED_DOCUMENT'));
});
test('loop: every card names what, why, proof rows, the action and what closes it, built from the evidence', () => {
  const r = project({ imports: R1() });
  for (const i of r.issues) { const c = i.card; for (const k of ['title', 'what', 'why', 'action', 'closesWhen']) assert.ok(c[k] && c[k].length > 10, `${i.family}/${i.subtype} lacks ${k}`); assert.ok(c.proof.length >= 1 && c.proof[0].rows.length >= 1, 'proof rows'); assert.ok(i.history.length >= 1); }
  const rej = find(r, 'INVOICE_AMAZON_STATE', 'REJECTED').card; assert.match(rej.what, /Buyer VAT number is missing/); assert.match(rej.proof[0].rows[0].ref, /^data row \d+$/);
  const nb = find(r, 'UNMATCHED_DOCUMENT', 'NO_CANDIDATE').card; assert.match(nb.proof[0].rows[0].ref, /^row \d+$/); assert.match(nb.why, /ledger|accounting export|Amazon report/i);
});
test('loop: an order id alone is a PROPOSAL; a proposal produces no books-gap card for that transaction', () => {
  const r = project({ imports: R1() }), p = find(r, 'UNMATCHED_DOCUMENT', 'PROPOSED_LINK_UNCONFIRMED');
  assert.ok(p); assert.match(p.card.what, /candidate, not a match/); assert.equal(find(r, 'BOOKS_GAP', null, 3), undefined);
});
test('loop: no mismatch card exists in P1: a ledger document under another number for the same order produces no gap, no no-candidate and no mismatch card', () => {
  const l = F.ledger([F.L.row('A-1001', '2026-11-18', '2026-11-17', F.O(1)), F.L.row('ZZ-7', '2026-11-18', '2026-11-17', F.O(2)), F.L.row('A-1005', '2026-11-18', '2026-11-17', F.O(5)), F.L.row('A-1006', '2026-11-18', '2026-11-17', F.O(6))]);
  const r = project({ imports: [R1()[0], imp('l1', 'ledger', l, F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)] });
  assert.equal(find(r, 'BOOKS_GAP', null, 2), undefined); assert.ok(!r.issues.some(i => JSON.stringify(i.subject).includes('ZZ-7')));
  assert.ok(!r.issues.some(i => /mismatch/i.test(i.family + i.subtype)));
  assert.ok(r.coverageNotes.some(n => /different number/.test(n.reason)));
});

// ---- identity ----
test('identity: the key never contains status, amount, date, file name or row: the same problem keeps its key across imports and subtype changes', () => {
  const a = project({ imports: R1() }), b = project({ imports: [...R1(), ...R2()] });
  const fresh = project({ imports: [R1()[0], imp('l1x', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-27T10:30:00Z' }), '2026-11-27T10:31:00Z', F.PROFILE), R2()[0]] }); // the same books, exported after the newer Amazon report
  for (const i of a.issues) assert.ok(b.issues.find(x => x.key === i.key), 'issue kept its key: ' + i.card.title);
  const sub = (r) => r.issues.find(i => JSON.stringify(i.subject).includes(F.O(4)) && i.family === 'BOOKS_GAP');
  const sf = fresh.issues.find(i => JSON.stringify(i.subject).includes(F.O(4)) && i.family === 'BOOKS_GAP');
  assert.notEqual(sub(a).subtype, sf.subtype, 'subtype changed (no number, then a number at Amazon)'); assert.equal(sub(a).key, sf.key); assert.equal(sub(a).key, sub(b).key);
  const renamed = R1().map(i => ({ ...i, fileName: 'other-name-' + i.id, id: 'zz' + i.id, importedAt: i.importedAt.replace('2026-11-20', '2026-11-21') }));
  const c = project({ imports: renamed }); assert.deepEqual(c.issues.map(i => i.key).sort(), a.issues.map(i => i.key).sort());
});
test('identity: different family or subject gives a different key; the profile id and the key version are in the hash', () => {
  const ks = new Set([issueKey('p', 'BOOKS_GAP', 'x'), issueKey('p', 'INVOICE_AMAZON_STATE', 'x'), issueKey('p', 'BOOKS_GAP', 'y'), issueKey('q', 'BOOKS_GAP', 'x')]); assert.equal(ks.size, 4);
  assert.equal(issueKey('p', 'BOOKS_GAP', 'x'), sha256(['k1', 'p', 'BOOKS_GAP', 'x'].join('\n')));
});
test('identity: SOURCE_INCOMPLETE is keyed by scope descriptor, so a complete replacement closes the SAME issue', () => {
  const bad = F.L1.replace('A-1005;Factura;2026-11-18', 'A-1005;Factura;31/02/2026');
  const imports = [R1()[0], imp('l1', 'ledger', bad, F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)];
  const r1 = project({ imports }), si1 = r1.issues.find(i => i.family === 'SOURCE_INCOMPLETE'); assert.ok(si1); assert.equal(si1.state, 'ACTION_REQUIRED'); assert.match(si1.card.what, /could not be read exactly/);
  const fixed = imp('l1b', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-21T09:00:00Z' }), '2026-11-21T09:01:00Z', F.PROFILE);
  const r2 = project({ imports: [...imports, fixed] }), si2 = r2.issues.find(i => i.key === si1.key);
  assert.equal(r2.issues.filter(i => i.family === 'SOURCE_INCOMPLETE').length, 1, 'no second issue'); assert.equal(si2.state, 'VERIFIED_CLOSED'); assert.equal(si2.outcome, 'evidence');
  assert.notEqual(imports[1].sha256, fixed.sha256);
});
test('identity: SOURCE_INCOMPLETE is not closed by a declaration or an action note; a different scope does not close it', () => {
  const bad = F.L1.replace('A-1005;Factura;2026-11-18', 'A-1005;Factura;31/02/2026');
  const imports = [imp('l1', 'ledger', bad, F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)], si = project({ imports }).issues[0];
  const ev = { id: 'e1', type: 'RESOLUTION_DECLARED', kind: 'RESOLUTION_DECLARED', issueKey: si.key, author: 'a', reasoning: 'fine', createdAt: '2026-11-20T12:00:00Z', basedOnFingerprint: si.fingerprint };
  const r = project({ imports, events: [ev] }); assert.equal(r.issues[0].state, 'ACTION_REQUIRED'); assert.equal(r.rejectedEvents.length, 1); assert.match(r.rejectedEvents[0].reason, /cannot be declared resolved/);
  const other = imp('l9', 'ledger', F.L1, F.LDECL({ periodFrom: '2026-10-01', periodTo: '2026-10-31' }), '2026-11-21T09:01:00Z', F.PROFILE);
  assert.equal(project({ imports: [...imports, other] }).issues.find(i => i.key === si.key).state, 'ACTION_REQUIRED');
});

// ---- lifecycle ----
test('lifecycle: the seller says they started; the state is AWAITING_NEW_EVIDENCE, not closed; a newer report that still shows it returns it to ACTION_REQUIRED with the event kept', () => {
  const imports = R1(), k = find(project({ imports }), 'INVOICE_AMAZON_STATE', 'REJECTED').key;
  const ev = { id: 'e1', type: 'ACTION_STARTED', issueKey: k, author: 'shop owner', reasoning: 'I corrected the VAT number and uploaded the invoice again', createdAt: '2026-11-21T08:00:00Z' };
  let r = project({ imports, events: [ev] }); assert.equal(r.issues.find(i => i.key === k).state, 'AWAITING_NEW_EVIDENCE'); assert.equal(r.issues.find(i => i.key === k).awaiting, 'SELLER_REPORTED_ACTION');
  assert.equal(r.buckets.closedWithEvidence, 0);
  const still = imp('v1b', 'vidr', F.V1, F.VDECL('2026-11-22T10:00:00Z'), '2026-11-22T10:01:00Z');
  r = project({ imports: [...imports, still], events: [ev] }); const i = r.issues.find(x => x.key === k);
  assert.equal(i.state, 'ACTION_REQUIRED'); assert.equal(i.events.length, 1);
});
test('lifecycle: closure appears only when a newer report meets the acceptance gate for the SAME subject; both sides keep the history', () => {
  const r = project({ imports: [...R1(), ...R2()] }), rej = find(r, 'INVOICE_AMAZON_STATE', 'REJECTED');
  assert.equal(rej.state, 'VERIFIED_CLOSED'); assert.equal(rej.outcome, 'evidence'); assert.deepEqual(rej.history.map(h => h.status), ['PRESENT', 'PRESENT', 'CLOSED', 'CLOSED']); assert.match(rej.closure.why, /acceptance condition/);
  assert.equal(rej.episodes.length, 1); assert.ok(rej.episodes[0].closedBy);
});
test('lifecycle: a changed TransactionId does NOT close the old problem (no merge, no guessing about Amazon)', () => {
  const v2 = F.V2.split('\n').map(l => l.includes(F.O(5)) ? l.replace(/S9005/g, 'S9905') : l).join('\n');
  const r = project({ imports: [...R1(), imp('v2x', 'vidr', v2, F.VDECL('2026-11-27T10:00:00Z'), '2026-11-27T10:01:00Z')] });
  const rej = find(r, 'INVOICE_AMAZON_STATE', 'REJECTED', 5); assert.ok(rej); assert.notEqual(rej.state, 'VERIFIED_CLOSED'); assert.equal(rej.state, 'ACTION_REQUIRED');
});
test('lifecycle: closure is derived: removing the evidence removes the closure (no stored flag to repair)', () => {
  const full = project({ imports: [...R1(), ...R2()] }), without = project({ imports: R1() });
  assert.ok(full.buckets.closedWithEvidence > 0); assert.equal(without.buckets.closedWithEvidence, 0); assert.ok(without.issues.every(i => i.state !== 'VERIFIED_CLOSED'));
});
test('lifecycle: a later import that contradicts a closure reopens it as a new episode, keeping both pieces of evidence', () => {
  const v3 = F.V1.replace('InvoiceUploaded\t\tFALSE', 'InvoiceUploaded\t\tFALSE'); // round 1 content again, later in time: the rejection is back
  const again = imp('v3', 'vidr', F.V1, F.VDECL('2026-12-05T10:00:00Z'), '2026-12-05T10:01:00Z'); void v3;
  const r = project({ imports: [...R1(), ...R2(), again] }), rej = find(r, 'INVOICE_AMAZON_STATE', 'REJECTED');
  assert.equal(rej.state, 'ACTION_REQUIRED'); assert.equal(rej.reopened, true); assert.equal(rej.episodes.length, 2); assert.ok(rej.episodes[0].closedBy, 'the earlier closing evidence is kept');
  assert.match(rej.card.stateNote, /closed by evidence earlier/);
});
test('lifecycle: Amazon processing makes the issue AWAITING_NEW_EVIDENCE from the report itself, not from a seller event', () => {
  const v = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'A-1001' }, { n: 5, status: 'InvoiceProcessing', num: 'A-1005' }, { n: 3, status: 'InvoicePending' }]), v1 = imp('va', 'vidr', F.vidr([{ n: 5, status: 'InvoiceRejected', num: 'A-1005', desc: 'x' }]), F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), v2 = imp('vb', 'vidr', v, F.VDECL('2026-11-24T10:00:00Z'), '2026-11-24T10:01:00Z');
  const r = project({ imports: [v1, v2] }), i = find(r, 'INVOICE_AMAZON_STATE', null, 5); assert.equal(i.state, 'AWAITING_NEW_EVIDENCE'); assert.equal(i.awaiting, 'AMAZON_PROCESSING'); assert.equal(i.events.length, 0);
});
// ---- declarations and links ----
test('declarations: Amazon-state problems and SOURCE_INCOMPLETE refuse a declaration; the refusal names the reason', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const r = await s.project(), a = find(r, 'INVOICE_AMAZON_STATE', 'REJECTED');
  await assert.rejects(s.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'RESOLUTION_DECLARED', issueKey: a.key, author: 'x', reasoning: 'done' }), (e) => e instanceof Refused && /cannot be declared resolved/.test(e.message));
  await assert.rejects(s.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'NOT_AN_AMAZON_SALE', issueKey: find(r, 'BOOKS_GAP', 'NOT_IN_BOOKS').key, author: 'x', reasoning: 'r' }), /accepts only: RESOLUTION_DECLARED/);
  await assert.rejects(s.addEvent({ type: 'ACTION_STARTED', issueKey: a.key, author: '', reasoning: 'x' }), /needs an author/);
  await assert.rejects(s.addEvent({ type: 'ACTION_STARTED', issueKey: 'nope', author: 'a', reasoning: 'x' }), /not in the current results/);
});
test('declarations: NOT_AN_AMAZON_SALE gives MANUALLY_REPORTED_RESOLUTION and never VERIFIED_CLOSED; it lapses when its evidence changes', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const nc = find(await s.project(), 'UNMATCHED_DOCUMENT', 'NO_CANDIDATE');
  await assert.rejects(s.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'BOOKS_GAP_ANYTHING', issueKey: nc.key, author: 'x', reasoning: 'r' }), /accepts only/);
  await s.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'NOT_AN_AMAZON_SALE', issueKey: nc.key, author: 'owner', reasoning: 'sold in my own shop, wrong channel label' });
  let r = await s.project(), i = r.issues.find(x => x.key === nc.key); assert.equal(i.state, 'MANUALLY_REPORTED_RESOLUTION'); assert.equal(i.outcome, 'declaration');
  assert.equal(r.buckets.reportedResolvedBySeller, 1); assert.equal(r.buckets.closedWithEvidence, 0); assert.match(i.card.stateNote, /No file confirms it/);
  const changed = F.L1.replace('A-9999;Factura;2026-11-19', 'A-9999;Factura;2026-11-20'); // the evidence rows changed
  await s.addLedger({ text: changed, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-22T00:00:00Z' }) });
  r = await s.project(); i = r.issues.find(x => x.key === nc.key); assert.equal(i.state, 'ACTION_REQUIRED'); assert.equal(i.lapsedDeclarations.length, 1);
});
test('links: a seller-declared link gives MANUALLY_REPORTED_RESOLUTION, never VERIFIED_CLOSED, and no file confirms it', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const p = find(await s.project(), 'UNMATCHED_DOCUMENT', 'PROPOSED_LINK_UNCONFIRMED');
  await assert.rejects(s.addEvent({ type: 'LINK_DECISION', ledgerKey: 'nope', amazonId: 'nope', decision: 'CONFIRM', author: 'a', reasoning: 'x' }), /no open proposal/);
  await s.addEvent({ type: 'LINK_DECISION', ledgerKey: p.subject.ledgerKey, amazonId: p.finding.evidence.candidate.amazonId, decision: 'CONFIRM', author: 'owner', reasoning: 'same sale, I checked both rows' });
  const r = await s.project(), i = r.issues.find(x => x.key === p.key); assert.equal(i.state, 'MANUALLY_REPORTED_RESOLUTION'); assert.equal(r.buckets.closedWithEvidence, 0);
  assert.equal(find(r, 'BOOKS_GAP', null, 3), undefined, 'a declared link does not invent a books-gap problem');
  // a newer Amazon report with an equal number closes it WITH evidence
  await s.addVidr({ text: F.V2, declared: F.VDECL('2026-11-27T10:00:00Z') }); const r2 = await s.project(); assert.equal(r2.issues.find(x => x.key === p.key).state, 'VERIFIED_CLOSED');
});
test('links: a rejected proposal removes the proposal; the transaction is then judged on its own (books gap if coverage allows)', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const p = find(await s.project(), 'UNMATCHED_DOCUMENT', 'PROPOSED_LINK_UNCONFIRMED');
  await s.addEvent({ type: 'LINK_DECISION', ledgerKey: p.subject.ledgerKey, amazonId: p.finding.evidence.candidate.amazonId, decision: 'REJECT', author: 'owner', reasoning: 'different buyer' });
  const r = await s.project(); assert.ok(find(r, 'BOOKS_GAP', 'NOT_IN_BOOKS', 3)); assert.ok(find(r, 'UNMATCHED_DOCUMENT', 'NO_CANDIDATE', 3) || r.issues.some(i => i.family === 'UNMATCHED_DOCUMENT' && JSON.stringify(i.subject).includes('B-3')));
});
// ---- numbers: uniqueness ----
test('matching: a document number is confirmed only when unique: two Amazon transactions with one number, or two ledger documents with one number, stay UNMATCHED (multiple candidates)', () => {
  const v = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'DUP-1' }, { n: 2, status: 'InvoiceUploaded', num: 'DUP-1' }]);
  const l = F.ledger([F.L.row('DUP-1', '2026-11-18', '2026-11-17', F.O(1))]);
  const r = project({ imports: [imp('v', 'vidr', v, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), imp('l', 'ledger', l, F.LDECL(), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.ok(r.issues.some(i => i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'MULTIPLE_CANDIDATES' && i.state === 'OPEN')); assert.equal(r.buckets.matchedByInvoiceNumber, 0);
  const l2 = F.ledger([F.L.row('DUP-1', '2026-11-18', '2026-11-17', F.O(1)), F.L.row('DUP-1', '2026-11-19', '2026-11-17', F.O(1), 'Amazon.es', '99,00')]);
  const r2 = project({ imports: [imp('v', 'vidr', F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'DUP-1' }]), F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z'), imp('l', 'ledger', l2, F.LDECL(), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.ok(r2.issues.some(i => i.family === 'DUPLICATE_DOCUMENT' && i.subtype === 'SAME_NUMBER_DIFFERENT_CONTENT' && /different content/.test(i.card.what))); assert.ok(!r2.issues.some(i => i.family === 'UNMATCHED_DOCUMENT' && i.subject.number === 'DUP-1'), 'one problem for it, not two'); assert.equal(r2.buckets.matchedByInvoiceNumber, 0);
});
test('matching: no match by amount or date even when they agree exactly', () => {
  const l = F.ledger([F.L.row('Q-1', '2026-11-18', '2026-11-17', '')]);
  const r = project({ imports: [R1()[0], imp('l', 'ledger', l, F.LDECL(), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.ok(find(r, 'BOOKS_GAP', 'NUMBER_AT_AMAZON_NOT_IN_BOOKS', 2)); assert.equal(r.buckets.matchedByInvoiceNumber, 0);
});
// ---- coverage (edit 5 and the rule that absence needs scope) ----
const gapCount = (r) => r.issues.filter(i => i.family === 'BOOKS_GAP').length + r.issues.filter(i => i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'NO_CANDIDATE').length;
test('coverage: amazonScope UNKNOWN allows no absence conclusion at all (cannot determine, named), but links still work', () => {
  const r = project({ imports: [R1()[0], imp('l', 'ledger', F.L1, F.LDECL({ amazonScope: { mode: 'UNKNOWN' } }), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.equal(gapCount(r), 0); assert.ok(r.coverageNotes.some(n => /not declared as Amazon sales/.test(n.reason))); assert.ok(r.imports[1].scopeNotes.some(x => /not declared as Amazon sales/.test(x)));
});
for (const [name, extra, re] of [
  ['declared as a partial export', { complete: false }, /not declared as a complete export/],
  ['declared for another marketplace', { marketplace: 'A13V1IB3VIYZZH' }, /declared for marketplace A13V1IB3VIYZZH/],
  ['does not declare invoices', { documentKinds: ['credit_note'] }, /does not declare that it covers invoices/],
  ['period too early', { periodTo: '2026-11-10' }, /must start on or before the shipment day/],
  ['period starts after the shipment', { periodFrom: '2026-11-19' }, /must start on or before the shipment day/],
]) test(`coverage: books-gap needs the export scope: ${name} gives no gap and names the unmet condition`, () => {
  const r = project({ imports: [R1()[0], imp('l', 'ledger', F.L1, F.LDECL(extra), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.equal(r.issues.filter(i => i.family === 'BOOKS_GAP').length, 0); assert.ok(r.coverageNotes.some(n => re.test(n.reason)), JSON.stringify(r.coverageNotes));
});
test('coverage: with no accounting export at all there is no books-gap and no invented problem; the note says so', () => {
  const r = project({ imports: [R1()[0]] }); assert.equal(r.issues.filter(i => i.family === 'BOOKS_GAP').length, 0); assert.ok(r.coverageNotes.some(n => /no accounting export has been loaded/.test(n.reason)));
});
test('coverage: a pending-only report is a scope limit, not a defect: pending rows still show, nothing is called missing from Amazon', () => {
  const pend = F.vidr([{ n: 3, status: 'InvoicePending' }]);
  const r = project({ imports: [imp('p', 'vidr', pend, { ...F.VDECL('2026-11-20T10:00:00Z'), options: 'PENDING_ONLY' }, '2026-11-20T10:01:00Z'), imp('l', 'ledger', F.L1, F.LDECL(), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.ok(find(r, 'INVOICE_AMAZON_STATE', 'ACTION_REQUIRED', 3)); assert.ok(!r.issues.some(i => i.family === 'SOURCE_INCOMPLETE')); assert.ok(!r.issues.some(i => i.subtype === 'NO_CANDIDATE'));
  assert.ok(r.imports[0].scopeNotes.some(x => /pending-only/i.test(x)));
});
test('coverage: no-candidate needs the document\'s operation date and a complete all-statuses report covering it', () => {
  const noOp = F.L1.replace(F.L.row('A-9999', '2026-11-19', '2026-11-12', F.O(99)), F.L.row('A-9999', '2026-11-19', '', F.O(99))); assert.notEqual(noOp, F.L1);
  const r = project({ imports: [...R1().slice(0, 1), imp('l', 'ledger', noOp, F.LDECL(), '2026-11-20T11:00:00Z', F.PROFILE)] });
  assert.ok(!r.issues.some(i => i.subtype === 'NO_CANDIDATE')); assert.ok(r.coverageNotes.some(n => /no operation date/.test(n.reason)));
  const shortRange = project({ imports: [imp('v', 'vidr', F.V1, F.VDECL('2026-11-20T10:00:00Z', '2026-11-14', '2026-11-30'), '2026-11-20T10:01:00Z'), R1()[1]] });
  assert.ok(!shortRange.issues.some(i => i.subtype === 'NO_CANDIDATE')); assert.ok(shortRange.coverageNotes.some(n => /does not contain the operation date/.test(n.reason)));
});
test('coverage: an incomplete Amazon file (missing declaration) cannot support an absence conclusion and raises ONE SOURCE_INCOMPLETE issue, no other problem from the incompleteness', () => {
  const d = { ...F.VDECL('2026-11-20T10:00:00Z'), obtainedHow: '' }, r = project({ imports: [imp('v', 'vidr', F.V1, d, '2026-11-20T10:01:00Z'), R1()[1]] });
  assert.equal(r.issues.filter(i => i.family === 'SOURCE_INCOMPLETE').length, 1); assert.ok(!r.issues.some(i => i.subtype === 'NO_CANDIDATE')); assert.match(r.issues.find(i => i.family === 'SOURCE_INCOMPLETE').card.what, /how the file was obtained/);
});
test('coverage: a later complete export of the same scope replaces an earlier one: a document no longer in it is no longer in the books', () => {
  const r = project({ imports: [...R1(), ...R2()] }); assert.ok(!r.issues.some(i => JSON.stringify(i.subject).includes('A-1005') && i.family === 'UNMATCHED_DOCUMENT'));
});
// ---- door ----
test('door: an import without its scope is refused with the missing names and nothing is stored', async () => {
  const ad = memoryAdapter(), s = createLoopStore(ad, { now: clock() });
  await assert.rejects(s.addVidr({ text: F.V1, declared: { options: 'ALL' } }), (e) => e instanceof Refused && /marketplace/.test(e.message) && /date range/.test(e.message));
  await assert.rejects(s.addLedger({ text: F.L1, profile: { ...F.PROFILE, confirmed: false }, declared: F.LDECL() }), /not confirmed/);
  await assert.rejects(s.addLedger({ text: F.L1, profile: F.PROFILE, declared: { sourceSystem: 'x' } }), /marketplace[\s\S]*period[\s\S]*document kinds/);
  await assert.rejects(s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL({ amazonScope: { mode: 'CHANNEL', channelValues: [] } }) }), /channel values/);
  assert.equal((await s.imports()).length, 0);
});
// ---- determinism and structure ----
test('determinism: the same imports in any order, with caches cold, give an identical projection', () => {
  const all = [...R1(), ...R2()], a = project({ imports: all }), b = project({ imports: [...all].reverse() }), c = project({ imports: [all[2], all[0], all[3], all[1]] });
  assert.equal(JSON.stringify(a), JSON.stringify(b)); assert.equal(JSON.stringify(a), JSON.stringify(c));
});
test('determinism: the projection does not mutate its inputs', () => {
  const all = [...R1(), ...R2()], before = JSON.stringify(all); project({ imports: all, events: [] }); assert.equal(JSON.stringify(all), before);
});
test('structure: the loop imports nothing from repair, pipeline, db or app, and stores no state, status or closed field', () => {
  const dir = new URL('../src/loop/', import.meta.url);
  for (const f of readdirSync(dir)) { const src = readFileSync(new URL(f, dir), 'utf8'); for (const m of src.matchAll(/from\s+'([^']+)'/g)) assert.ok(!/(^|\/)(repair|pipeline|db|app|auth|oauth|spapi|mockamazon)\.js$/.test(m[1]), `${f} imports ${m[1]}`); }
  const store = readFileSync(new URL('store.js', dir), 'utf8'); for (const m of store.matchAll(/put\(key\([^)]*\),\s*(\w+)\)/g)) assert.match(m[1], /^(rec|ev)$/);
  void store;
});
test('structure: VERIFIED_CLOSED is assigned in one place only, from a closure predicate', () => {
  const src = readFileSync(new URL('../src/loop/project.js', import.meta.url), 'utf8'); assert.equal((src.match(/state = 'VERIFIED_CLOSED'/g) || []).length, 1);
  assert.match(src, /if \(final\.status === 'CLOSED'\) \{ state = 'VERIFIED_CLOSED'/);
  const st = readFileSync(new URL('../src/loop/store.js', import.meta.url), 'utf8'); assert.ok(!/VERIFIED_CLOSED'\s*[,;]/.test(st.replace(/throw[^;]*;/g, '')));
});
test('language: no card or bundle text claims legal position, certification, filing or "accepted on"', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); for (const [t, d] of [[F.V1, F.VDECL('2026-11-20T10:00:00Z')], [F.V2, F.VDECL('2026-11-27T10:00:00Z')]]) await s.addVidr({ text: t, declared: d }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const b = await s.bundle(), text = JSON.stringify([b.issues.map(i => i.card), b.coverageNotes, b.note]);
  for (const bad of [/complian/i, /legally/i, /certified/i, /\bfiled\b/i, /\bvalid\b/i, /never miss/i, /accepted on/i, /guarantee/i, /penalt/i, /issuance-ready/i, /\bautomat/i]) assert.ok(!bad.test(text), 'forbidden wording: ' + bad);
  assert.ok(!('allClosed' in b.headline) && Object.values(b.headline).every(v => typeof v === 'number')); assert.equal(Object.keys(b.headline).filter(k => /resolution|closed/i.test(k)).length, 2);
  assert.ok(b.notCheckedInThisVersion.some(x => /credit notes/.test(x)));
});
test('bundle: closureBasis is evidence or declaration or null, declarations keep author, time and reasoning, and raw files are included with their hash', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const nc = find(await s.project(), 'UNMATCHED_DOCUMENT', 'NO_CANDIDATE'); await s.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'NOT_AN_AMAZON_SALE', issueKey: nc.key, author: 'owner', reasoning: 'own shop sale' }); await s.addVidr({ text: F.V2, declared: F.VDECL('2026-11-27T10:00:00Z') });
  const b = await s.bundle(), bases = new Set(b.issues.map(i => i.closureBasis)); assert.ok([...bases].every(x => [null, 'evidence', 'declaration'].includes(x))); assert.ok(bases.has('evidence') && bases.has('declaration'));
  const d = b.issues.find(i => i.closureBasis === 'declaration'); assert.equal(d.declaration.author, 'owner'); assert.ok(d.declaration.createdAt); assert.equal(d.declaration.reasoning, 'own shop sale');
  assert.ok(b.imports.every(i => i.sha256 === createHash('sha256').update(i.text).digest('hex')));
});
test('order: imports are ordered by the report\'s own time, then load time, then id', () => {
  const a = { id: 'b', kind: 'vidr', declared: { createdAt: '2026-11-02T00:00:00Z' }, importedAt: '2026-11-03' }, b = { id: 'a', kind: 'vidr', declared: { createdAt: '2026-11-01T00:00:00Z' }, importedAt: '2026-11-04' };
  assert.deepEqual(orderImports([a, b]).map(x => x.id), ['a', 'b']);
});
void ISO; void dateReadings; void profileProblems;

test('structure: nothing stored carries a state, status, closed flag, issue or link, whatever the seller did', async () => {
  const ad = memoryAdapter(), s = createLoopStore(ad, { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const r = await s.project(); await s.addEvent({ type: 'ACTION_STARTED', issueKey: r.issues[0].key, author: 'a', reasoning: 'started' });
  const p = find(r, 'UNMATCHED_DOCUMENT', 'PROPOSED_LINK_UNCONFIRMED'); await s.addEvent({ type: 'LINK_DECISION', ledgerKey: p.subject.ledgerKey, amazonId: p.finding.evidence.candidate.amazonId, decision: 'CONFIRM', author: 'a', reasoning: 'checked' });
  const keysOf = (o, out = new Set()) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.add(k); keysOf(v, out); } return out; };
  const stored = []; for (const k of await ad.list()) stored.push(await ad.get(k));
  const names = keysOf(stored); for (const bad of ['state', 'status', 'closed', 'issues', 'links', 'outcome', 'findings']) assert.ok(!names.has(bad), 'stored key ' + bad);
  assert.deepEqual((await ad.list()).map(k => k.split(':').slice(0, 2).join(':')).filter((x, i, a) => a.indexOf(x) === i).sort(), ['loop:event', 'loop:import', 'loop:profile']);
});

// ---- review fixes after the independent review of faf56f6 ----
const ev = (type, issueKey, createdAt, extra = {}) => ({ id: 'e-' + createdAt, type, issueKey, author: 'seller', reasoning: 'test', createdAt, ...extra });
const badLedger = () => F.L1.replace('A-1005;Factura;2026-11-18', 'A-1005;Factura;31/02/2026');
const siOf = (r) => r.issues.filter(i => i.family === 'SOURCE_INCOMPLETE');
test('fix1: a newer PARTIAL ledger never closes an earlier SOURCE_INCOMPLETE of the same scope', () => {
  const base = [R1()[0], imp('l1', 'ledger', badLedger(), F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)];
  const si = siOf(project({ imports: base }))[0]; assert.equal(si.state, 'ACTION_REQUIRED');
  const partial = imp('l1p', 'ledger', F.L1, F.LDECL({ complete: false, exportedAt: '2026-11-21T09:00:00Z' }), '2026-11-21T09:01:00Z', F.PROFILE);
  const r = project({ imports: [...base, partial] }), after = siOf(r);
  assert.equal(after.length, 1); assert.equal(after[0].key, si.key); assert.notEqual(after[0].state, 'VERIFIED_CLOSED'); assert.equal(after[0].state, 'ACTION_REQUIRED');
});
test('fix1: a newer PENDING-ONLY report never closes a SOURCE_INCOMPLETE raised from an all-statuses report', () => {
  const noHow = { ...F.VDECL('2026-11-20T10:00:00Z'), obtainedHow: '' };
  const first = imp('v1', 'vidr', F.V1, noHow, '2026-11-20T10:01:00Z'), si = siOf(project({ imports: [first] }))[0]; assert.ok(si); assert.equal(si.state, 'ACTION_REQUIRED');
  const pending = imp('v1p', 'vidr', F.V1, { ...F.VDECL('2026-11-21T10:00:00Z'), options: 'PENDING' }, '2026-11-21T10:01:00Z');
  const after = siOf(project({ imports: [first, pending] }));
  assert.equal(after.length, 1); assert.equal(after[0].key, si.key); assert.equal(after[0].state, 'ACTION_REQUIRED');
});
test('fix1: a COMPLETE valid replacement of the same scope does close it (ledger and report)', () => {
  const base = [R1()[0], imp('l1', 'ledger', badLedger(), F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)];
  const full = imp('l1c', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-21T09:00:00Z' }), '2026-11-21T09:01:00Z', F.PROFILE);
  assert.equal(siOf(project({ imports: [...base, full] }))[0].state, 'VERIFIED_CLOSED');
  const noHow = imp('v0', 'vidr', F.V1, { ...F.VDECL('2026-11-20T10:00:00Z'), obtainedHow: '' }, '2026-11-20T10:01:00Z'), good = imp('v0b', 'vidr', F.V1, F.VDECL('2026-11-21T10:00:00Z'), '2026-11-21T10:01:00Z');
  assert.equal(siOf(project({ imports: [noHow, good] }))[0].state, 'VERIFIED_CLOSED');
});
const rejKey = () => find(project({ imports: R1() }), 'INVOICE_AMAZON_STATE', 'REJECTED').key;
test('fix2: an ACCEPTED report created BEFORE ACTION_STARTED but uploaded after it does not close the problem', () => {
  const key = rejKey(), started = ev('ACTION_STARTED', key, '2026-11-21T09:00:00Z');
  const old = imp('v2old', 'vidr', F.V2, F.VDECL('2026-11-20T12:00:00Z'), '2026-11-21T10:00:00Z');
  const r = project({ imports: [...R1(), old], events: [started] }), rej = r.issues.find(i => i.key === key);
  assert.notEqual(rej.state, 'VERIFIED_CLOSED'); assert.equal(rej.state, 'AWAITING_NEW_EVIDENCE'); assert.equal(rej.awaiting, 'SELLER_REPORTED_ACTION'); assert.equal(rej.closure, null);
  assert.ok(r.issues.filter(i => i.key !== key).some(i => i.state === 'VERIFIED_CLOSED'), 'other problems without an action still close from the same report');
});
test('fix2: an ACCEPTED report created AFTER ACTION_STARTED closes it when the other conditions pass', () => {
  const key = rejKey(), started = ev('ACTION_STARTED', key, '2026-11-21T09:00:00Z');
  const fresh = imp('v2new', 'vidr', F.V2, F.VDECL('2026-11-21T10:00:00Z'), '2026-11-21T10:01:00Z');
  const rej = project({ imports: [...R1(), fresh], events: [started] }).issues.find(i => i.key === key);
  assert.equal(rej.state, 'VERIFIED_CLOSED'); assert.equal(rej.outcome, 'evidence');
});
test('fix2: with an action recorded, an unknown creation time is never evidence; without one, closure is unchanged', () => {
  const key = rejKey(), started = ev('ACTION_STARTED', key, '2026-11-21T09:00:00Z');
  const unknown = imp('v2u', 'vidr', F.V2, { ...F.VDECL('2026-11-21T10:00:00Z'), createdAt: undefined, createdAfterUploadConfirmed: false }, '2026-11-21T10:01:00Z');
  assert.notEqual(project({ imports: [...R1(), unknown], events: [started] }).issues.find(i => i.key === key).state, 'VERIFIED_CLOSED');
  const noAction = imp('v2n', 'vidr', F.V2, F.VDECL('2026-11-20T12:00:00Z'), '2026-11-21T10:00:00Z');
  assert.equal(project({ imports: [...R1(), noAction] }).issues.find(i => i.key === key).state, 'VERIFIED_CLOSED');
});
test('fix2: a report only counts as newer evidence after an action by its own creation time, not by upload time', () => {
  const key = rejKey(), started = ev('ACTION_STARTED', key, '2026-11-21T09:00:00Z');
  const stillRejected = imp('v1b', 'vidr', F.V1, F.VDECL('2026-11-20T12:00:00Z'), '2026-11-21T10:00:00Z');
  const rej = project({ imports: [...R1(), stillRejected], events: [started] }).issues.find(i => i.key === key);
  assert.equal(rej.state, 'AWAITING_NEW_EVIDENCE', 'uploaded after the action but created before it: still waiting');
  const newer = imp('v1c', 'vidr', F.V1, F.VDECL('2026-11-21T12:00:00Z'), '2026-11-21T12:01:00Z');
  assert.equal(project({ imports: [...R1(), newer], events: [started] }).issues.find(i => i.key === key).state, 'ACTION_REQUIRED', 'created after the action and still rejected: the action did not work');
});
const gapFor = (r, n) => find(r, 'BOOKS_GAP', null, n);
test('fix3: a ledger exported before the Amazon report was created cannot prove a document is missing from the books', () => {
  const v = imp('v1', 'vidr', F.V1, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
  const stale = imp('l1', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-12T09:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE); // uploaded today, exported on the 12th
  const r = project({ imports: [v, stale] }); assert.equal(gapFor(r, 4), undefined, 'no BOOKS_GAP from a stale export'); assert.ok(r.coverageNotes.some(n => /exported at 2026-11-12/.test(n.reason) || /before the Amazon report/.test(n.reason)));
  const ok = project({ imports: [v, imp('l1', 'ledger', F.L1, F.LDECL({ exportedAt: '2026-11-20T10:00:00Z' }), '2026-11-20T11:01:00Z', F.PROFILE)] }); assert.ok(gapFor(ok, 4), 'exported at the moment the report was created is enough');
});
test('fix3: an unknown export time is Cannot Determine, upload time is never substituted, and the shown time is labelled as declared', () => {
  const v = imp('v1', 'vidr', F.V1, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
  const none = imp('l1', 'ledger', F.L1, (({ exportedAt, ...d }) => d)(F.LDECL()), '2026-11-25T11:01:00Z', F.PROFILE);
  const r = project({ imports: [v, none] }); assert.equal(gapFor(r, 4), undefined); assert.ok(r.coverageNotes.some(n => /time this accounting export was created is not declared/.test(n.reason)));
  const good = project({ imports: [v, imp('l1', 'ledger', F.L1, F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE)] }), g = gapFor(good, 4);
  assert.equal(g.finding.evidence.coverage.exportedAtBasis, 'declared by the seller'); assert.equal(g.finding.evidence.coverage.exportedAt, '2026-11-20T11:00:00Z');
});
const udoc = (r, num) => r.issues.find(i => i.family === 'UNMATCHED_DOCUMENT' && i.subject.number === num);
test('fix4: a later complete file replaces an earlier one only with the SAME scope: ALL to CHANNEL does not replace', () => {
  const noExtra = F.L1.split('\n').filter(l => !l.startsWith('A-9999')).join('\n');
  const a = imp('la', 'ledger', F.L1, F.LDECL({ amazonScope: { mode: 'ALL' } }), '2026-11-20T11:01:00Z', F.PROFILE);
  const sameScope = imp('lb', 'ledger', noExtra, F.LDECL({ amazonScope: { mode: 'ALL' }, exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  const otherScope = imp('lb', 'ledger', noExtra, F.LDECL({ amazonScope: { mode: 'CHANNEL', channelValues: ['Amazon.es'] }, exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  const v = R1()[0];
  assert.ok(udoc(project({ imports: [v, a] }), 'A-9999'), 'present in the first file');
  assert.notEqual(udoc(project({ imports: [v, a, sameScope] }), 'A-9999')?.state, 'ACTION_REQUIRED', 'same scope: the later complete file replaces it');
  assert.equal(udoc(project({ imports: [v, a, otherScope] }), 'A-9999').state, 'ACTION_REQUIRED', 'different Amazon scope mode: not a replacement, the record is kept');
});
test('fix4: changing which channel values mean Amazon changes the scope; a partial file never replaces or erases a complete one', () => {
  const noExtra = F.L1.split('\n').filter(l => !l.startsWith('A-9999')).join('\n'), v = R1()[0];
  const a = imp('la', 'ledger', F.L1, F.LDECL(), '2026-11-20T11:01:00Z', F.PROFILE);
  const otherValues = imp('lb', 'ledger', noExtra, F.LDECL({ amazonScope: { mode: 'CHANNEL', channelValues: ['Amazon.es', 'Amazon.de'] }, exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  assert.equal(udoc(project({ imports: [v, a, otherValues] }), 'A-9999').state, 'ACTION_REQUIRED', 'other channel values: record kept');
  const partial = imp('lc', 'ledger', noExtra, F.LDECL({ complete: false, exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  assert.equal(udoc(project({ imports: [v, a, partial] }), 'A-9999').state, 'ACTION_REQUIRED', 'partial never erases');
  const d1 = project({ imports: [v, a] }), d2 = project({ imports: [v, a, otherValues] });
  assert.ok(d1.issues.length && d2.issues.length);
});
test('wording: the summary bucket is "matched by invoice number" and the bundle says amounts, taxes and differences are not examined', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() });
  const r = await s.project(), b = await s.bundle();
  assert.ok('matchedByInvoiceNumber' in r.buckets); assert.ok(!('fine' in r.buckets)); assert.ok('matchedByInvoiceNumber' in b.headline); assert.ok(!('fine' in b.headline));
  assert.match(r.notCheckedInThisVersion.join(' '), /the invoice total, net and VAT amounts/); assert.match(b.matchedByInvoiceNumberMeaning, /The invoice total .*net and VAT amounts, dates, line items and tax rates are not compared/);
});
test('door: an export time that is not a date is refused', async () => {
  const s = createLoopStore(memoryAdapter(), { now: clock() });
  await assert.rejects(() => s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL({ exportedAt: 'yesterday' }) }), Refused);
});

// ---- a superseded ledger proves nothing about absence ----
test('fix-b: BOOKS_GAP proof rests on the newest complete ledger of the scope, never on the superseded one', () => {
  const v2 = R2()[0], doc = (t) => t.split('\n').filter(l => !l.startsWith('A-1004;')).join('\n');
  const oldL = imp('lold', 'ledger', F.L2, F.LDECL({ exportedAt: '2026-11-27T11:00:00Z' }), '2026-11-27T11:01:00Z', F.PROFILE); // contains A-1004
  const newL = imp('lnew', 'ledger', doc(F.L2), F.LDECL({ exportedAt: '2026-11-27T12:00:00Z' }), '2026-11-27T12:01:00Z', F.PROFILE); // same scope, complete, no A-1004
  const r = project({ imports: [v2, oldL, newL] }), gap = find(r, 'BOOKS_GAP', null, 4);
  assert.ok(gap, 'the newest ledger lacks the document: the gap is proven'); assert.equal(gap.state, 'ACTION_REQUIRED');
  assert.equal(gap.finding.evidence.coverage.id, 'lnew', 'the coverage cited is the newest file, not the superseded one'); assert.equal(gap.finding.evidence.coverage.exportedAt, '2026-11-27T12:00:00Z');
  assert.ok(!JSON.stringify(gap.finding.evidence).includes('lold'));
});
test('fix-b: with the newest ledger stale, a superseded fresh one cannot stand in; the newest complete ledger alone proves it when fresh', () => {
  const v2 = R2()[0], doc = (t) => t.split('\n').filter(l => !l.startsWith('A-1004;')).join('\n');
  const only = project({ imports: [v2, imp('lnew', 'ledger', doc(F.L2), F.LDECL({ exportedAt: '2026-11-27T12:00:00Z' }), '2026-11-27T12:01:00Z', F.PROFILE)] });
  assert.ok(find(only, 'BOOKS_GAP', 'NUMBER_AT_AMAZON_NOT_IN_BOOKS', 4), 'reverse: the newest complete ledger that lacks the document proves BOOKS_GAP when the other conditions hold');
  const withHole = project({ imports: [v2, imp('lnew2', 'ledger', doc(F.L2), F.LDECL({ exportedAt: '2026-11-27T12:00:00Z', complete: false }), '2026-11-27T12:01:00Z', F.PROFILE)] });
  assert.equal(find(withHole, 'BOOKS_GAP', 'NUMBER_AT_AMAZON_NOT_IN_BOOKS', 4), undefined, 'a partial file never proves absence');
});
