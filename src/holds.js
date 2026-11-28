// Expedition W2-2: the review queue for ledger findings (HOLD / BLOCK). Until now these were written by the pipeline and read only by tests: no route listed them and none recorded the human decision.
// Every item answers: what happened, why, which evidence, what the system knows, what it does not know, what is allowed, what is blocked, what happens next. Pure text from stored fields; nothing is inferred.
import { releaseIntegrity } from './integrity.js';
import { logEvent } from './db.js';
import { listRepairs } from './repair.js';
const parse = (s) => { try { return JSON.parse(s ?? 'null') ?? {}; } catch { return {}; } };
const CN = {
  CREDIT_NOTE_IDENTITY_UNPROVEN: { happened: 'Amazon sent a report row about a credit note, but the row could not be proven to be our document.', blocked: ['No status change on the credit note', 'No replacement invoice', 'No retry or re-upload of any correction document of this pair'] },
  CREDIT_NOTE_ROWS_CONFLICT: { happened: 'The report rows of one credit note disagree with each other (different statuses).', blocked: ['No status change on the credit note', 'No replacement invoice', 'No retry or re-upload of any correction document of this pair'] },
  CREDIT_NOTE_VERDICT_CONTRADICTION: { happened: 'Amazon reported this credit note as uploaded earlier and now reports it as rejected.', blocked: ['No replacement invoice (if none was issued yet)', 'No retry or re-upload of any correction document of this pair', 'Nothing is cancelled automatically'] },
};

// ---- Seller guidance per code (usable HOLD flow). Plain words only: no raw code names, no UTC times, no invented facts. A resolution says WHAT resolves the hold and WHO can do it.
const REPORT = 'Request the VAT invoice data report again in Seller Central with the All statuses view (it includes the invoice number column) and upload it. If it matches our document exactly, the hold lifts by itself.';
const FIXFILE = (what) => ({ type: 'NEW_EVIDENCE', who: 'you', text: `Correct ${what} in your Amazon report (or ask Amazon support to correct it at the source) and upload the corrected file. The next import is checked from scratch.` });
const DECIDE = (what) => ({ type: 'MANUAL', who: 'you', onlyFor: 'HUMAN_DECISION', text: `If you checked ${what} and it is right, record your decision below with a reason. The decision covers exactly the evidence on this card.` });
const NOTES = { type: 'NONE', who: 'you', text: 'You can write an investigation note at any time. A note never changes anything.' };
export const HOLD_GUIDE = {
  TRANSACTION_TYPE_UNSUPPORTED: { title: 'This row is not a sale that can be invoiced here', resolutions: [{ type: 'NEW_EVIDENCE', who: 'you', text: 'Export the report again so that sales are listed as shipments. Refunds and returns follow their own steps.' }] },
  UNKNOWN_TRANSACTION_TYPE: { title: 'Amazon sent a transaction type we do not know', resolutions: [{ type: 'NEW_EVIDENCE', who: 'you', text: 'Upload a report that uses the documented transaction types (shipment, refund, return). Nothing is guessed for an unknown type.' }] },
  CURRENCY_UNSUPPORTED: { title: 'The currency of this order is not supported yet', resolutions: [{ type: 'NEW_EVIDENCE', who: 'you', text: 'Invoice this order outside InvoiceGuard. Uploading the same file again will not change this.' }] },
  QUANTITY_UNREADABLE: { title: 'The quantity could not be read', resolutions: [FIXFILE('the quantity')] },
  AMOUNT_UNREADABLE: { title: 'An amount could not be read', resolutions: [FIXFILE('the amount'), DECIDE('the amounts in Seller Central')] },
  AMOUNT_INCOMPLETE: { title: 'An amount is missing', resolutions: [FIXFILE('the missing amount')] },
  AMOUNT_OUT_OF_RANGE: { title: 'An amount is too large to be exact', resolutions: [FIXFILE('the amount')] },
  AMOUNT_INCONSISTENT: { title: 'The amounts do not add up', resolutions: [FIXFILE('the amounts')] },
  AMOUNT_RATE_MISMATCH: { title: 'The VAT does not match the stated rate', resolutions: [FIXFILE('the VAT amounts or the rate')] },
  NEGATIVE_CORE_AMOUNT: { title: 'A sale amount is negative', resolutions: [FIXFILE('the amount'), DECIDE('the order in Seller Central')] },
  DATE_MISSING: { title: 'The shipment date is missing', resolutions: [FIXFILE('the shipment date')] },
  DATE_UNREADABLE: { title: 'The shipment date could not be read', resolutions: [FIXFILE('the date format (year-month-day)')] },
  DATE_ORDER: { title: 'The order date is later than the shipment date', resolutions: [FIXFILE('the dates'), DECIDE('both dates in Seller Central')] },
  NONPOSITIVE_TOTAL: { title: 'The total of this shipment is zero or negative', resolutions: [FIXFILE('the amounts')] },
  DUPLICATE_ITEM_ROW: { title: 'The same item appears twice', resolutions: [FIXFILE('the duplicated row'), DECIDE('that the two rows are two real items')] },
  SHIPMENT_FIELD_CONFLICT: { title: 'The rows of one shipment disagree', resolutions: [FIXFILE('the conflicting field so that all rows agree')] },
  CREDIT_NOTE_IDENTITY_UNPROVEN: { title: 'A report row about a credit note could not be matched to our document', resolutions: [{ type: 'MANUAL', who: 'you', onlyFor: 'HUMAN_DECISION', text: 'Compare the report row with our credit note. If it is our document, record your decision below. The decision applies nothing by itself: the next matching report is evaluated again from scratch.' }, { type: 'NEW_EVIDENCE', who: 'you', text: REPORT }] },
  CREDIT_NOTE_ROWS_CONFLICT: { title: 'The report rows of one credit note disagree', resolutions: [{ type: 'MANUAL', who: 'you', onlyFor: 'HUMAN_DECISION', text: 'Check the credit note in Seller Central. If you can say which row is right, record your decision below.' }, { type: 'NEW_EVIDENCE', who: 'you', text: REPORT }] },
  CREDIT_NOTE_VERDICT_CONTRADICTION: { title: 'Amazon first accepted this credit note and now rejects it', resolutions: [{ type: 'MANUAL', who: 'you', onlyFor: 'HUMAN_DECISION', text: 'Check what Amazon shows for this credit note in Seller Central, then record your decision below. Nothing is cancelled automatically.' }, { type: 'NEW_EVIDENCE', who: 'you', text: REPORT }] },
  CORRECTION_PARTIAL_REVERSAL: { title: 'The correction reverses only part of the invoice', resolutions: [{ type: 'NEW_EVIDENCE', who: 'you', text: 'Review the correction as a pair (credit note and replacement) in Repairs, or upload a report that shows the full reversal.' }] },
  CORRECTION_EXCEEDS_BALANCE: { title: 'The correction is larger than what is left on the invoice', resolutions: [{ type: 'NEW_EVIDENCE', who: 'you', text: 'Check which credit notes already exist for this invoice, then upload a corrected report. A correction is never issued above the remaining balance.' }] },
  REFUND_ROW_INVOICE_STATUS: { title: 'A refund row carries an invoice status', kind: 'NO_RELEASE', resolutions: [{ type: 'NONE', who: 'nobody', text: 'No one can release this hold, with a note or with a decision, until there is new trusted evidence of what Amazon means by this row. The original invoice and the credit note are not changed by it. You can write investigation notes.' }] },
  RETURN_ROW_INVOICE_STATUS: { title: 'A return row carries an invoice status', resolutions: [{ type: 'NEW_EVIDENCE', who: 'amazon', text: 'Only documented Amazon evidence of what this combination means, or a corrected report, resolves it. The original invoice, the credit note and the replacement are not changed by this row.' }, { type: 'NEW_EVIDENCE', who: 'you', text: REPORT }] },
  ORIGINAL_INVOICE_VERDICT_UNPROVEN: { title: 'Amazon\'s status for this invoice could not be confirmed', resolutions: [{ type: 'NEW_EVIDENCE', who: 'you', text: REPORT }] },
  UPLOADED_THEN_REJECTED: { title: 'Amazon first showed this invoice as uploaded and now rejects it', resolutions: [{ type: 'MANUAL', who: 'you', onlyFor: 'HUMAN_DECISION', text: 'Check what Amazon shows for this invoice in Seller Central, then record your decision below. Nothing is cancelled or re-uploaded automatically.' }, { type: 'NEW_EVIDENCE', who: 'you', text: REPORT }] },
  UPLOAD_OUTCOME_UNKNOWN: { title: 'The upload may have reached Amazon, and we cannot tell', resolutions: [{ type: 'MANUAL', who: 'you', text: 'Check the document and the feed in Seller Central. Then record who checked, when and what you found, and authorize ONE retry below. Nothing resends it automatically.' }, { type: 'NEW_EVIDENCE', who: 'amazon', text: 'A later Amazon report that shows a verdict for this document closes the hold without a retry.' }] },
  LATE_FEED_ARRIVED: { title: 'A feed arrived late for this document', resolutions: [{ type: 'MANUAL', who: 'you', text: 'Check this exact feed in Seller Central. Then record who checked, when and what you found, and confirm that feed below. Only that confirmation lets the document continue.' }] },
};
const RESIDUAL_RISK = 'Residual risk: an earlier request can still land after you authorize a retry, and then Amazon would hold two submissions. Your authorization is your own recorded decision. It is not an Amazon confirmation.';
const money = (n) => Number.isFinite(Number(n)) ? Number(n).toFixed(2) : null;
const cap = (v, n = 400) => { const t = String(v ?? ''); return t.length > n ? t.slice(0, n) + '...' : t; };
export function holdSummary(items) { const open = items.filter(x => x.status === 'OPEN'); return { waitingOnYou: open.filter(x => x.kind === 'WAITING_ON_YOU').length, waitingOnEvidence: open.filter(x => x.kind === 'WAITING_ON_EVIDENCE').length, noRelease: open.filter(x => x.kind === 'NO_RELEASE').length, total: open.length }; }
function heldText(db, sellerId, key, ev) {
  const number = ev?.documentNumber ?? ev?.number ?? null;
  const inv = number ? db?.prepare('SELECT number, total, shipment_key FROM invoices WHERE seller_id=? AND number=?').get(sellerId, number) : null;
  const sh = db?.prepare('SELECT order_id, total FROM shipments WHERE seller_id=? AND key=?').get(sellerId, inv?.shipment_key ?? key);
  const parts = []; if (inv) parts.push(`Invoice ${inv.number}`); else if (number) parts.push(`Document ${cap(number, 60)}`);
  if (sh?.order_id) parts.push(`order ${cap(sh.order_id, 40)}`); const amt = money(inv?.total ?? sh?.total); if (amt) parts.push(`total ${amt}`);
  return { text: parts.length ? parts.join(', ') + '. Paused: nothing is changed or sent for it until this is settled.' : 'One item of your report. Paused: nothing is changed or sent for it until this is settled.', number: inv?.number ?? number ?? null, order: sh?.order_id ?? null, total: amt };
}
export function explainFinding(f, db = null, sellerId = null) {
  const ev = parse(f.evidence); const snap = ev.snapshot ?? null; let cn = CN[f.code];
  if (cn && ev.documentKind === 'replacement invoice') cn = { ...cn, happened: 'Amazon sent a report row that says our replacement invoice was uploaded, but the row could not be proven to be our document (number, amounts or context do not match exactly).' };
  if (f.code === 'REFUND_ROW_INVOICE_STATUS') cn = { happened: 'A refund row in the Amazon report carries an invoice status. We do not know what Amazon means by that.', blocked: ['The original invoice and the credit note are not changed by this row', 'The row is not read as an acceptance or a rejection of anything'] };
  const known = [], unknown = [];
  if (cn) {
    known.push('Our stored credit note exists' + (ev.number ? ` (${cap(ev.number, 60)})` : ''), 'The report was ingested and nothing was applied from it');
    if (snap) { if (snap.documentNumbers?.length) known.push(`The report names document number(s): ${snap.documentNumbers.map(x => x === '' ? '(blank)' : x).join(', ')}`); if (snap.statuses?.length) known.push(`The report status set: ${snap.statuses.join(', ')}`); if (snap.reportRequestedAt) known.push(`Report requested at ${snap.reportRequestedAt}`); }
    unknown.push('Whether Amazon actually holds our document under another number', 'Which of two conflicting reports is the right one', 'Amazon refund sign convention is not proven by a real report');
    if (ev.failed?.length) known.push(`Checks that failed: ${ev.failed.join(', ')}`);
  } else { known.push('The ledger recorded this finding from the data we hold' + (ev.field ? ` (field: ${ev.field})` : '')); unknown.push('Whether the finding is a real discrepancy or a data problem on the other side'); }
  const releasable = f.status === 'OPEN' && f.resolution === 'HUMAN_DECISION' && f.severity !== 'BLOCK';
  return {
    key: f.shipment_key, code: f.code, severity: f.severity, status: f.status, fingerprint: f.fingerprint, firstSeen: f.first_seen, lastSeen: f.last_seen, seenCount: f.seen_count,
    happened: cn?.happened ?? f.explanation ?? 'A finding is open.', why: f.explanation ?? '', evidence: ev,
    known, unknown,
    allowed: releasable ? ['Record a documented decision (your name and a reason of 10+ characters) for exactly this evidence'] : f.severity === 'BLOCK' ? [] : f.status === 'OPEN' ? ['Provide a corrected file'] : [],
    blocked: cn?.blocked ?? (f.status === 'OPEN' ? ['Nothing automatic proceeds for this item until it is resolved'] : []),
    next: f.status !== 'OPEN' ? 'No action: this finding is not open.' : releasable ? (cn ? 'After a decision, the credit-note block lifts. Nothing is applied by the decision itself: the next matching Amazon report is evaluated again from scratch and a changed fingerprint needs a new decision.' : 'A decision is recorded for exactly this evidence. It does not by itself release anything else: whether a shipment or document continues is decided by its own checks, and a changed fingerprint needs a new decision.') : f.severity === 'BLOCK' ? 'Only a corrected file resolves this. A decision cannot release it.' : 'A corrected file resolves it.',
    releasable,
    source: 'ledger', title: (HOLD_GUIDE[f.code]?.title) ?? 'This item needs attention', form: releasable ? 'decide' : null, notes: [],
    kind: HOLD_GUIDE[f.code]?.kind ?? (releasable ? 'WAITING_ON_YOU' : 'WAITING_ON_EVIDENCE'),
    resolutions: [...(HOLD_GUIDE[f.code]?.resolutions ?? [{ type: 'NEW_EVIDENCE', who: 'you', text: 'Upload a corrected report. The next import is checked from scratch.' }]).filter(r => !r.onlyFor || (r.onlyFor === f.resolution && f.severity !== 'BLOCK')), NOTES].map(({ onlyFor, ...r }) => r),
    held: heldText(db, sellerId, f.shipment_key, ev),
  };
}
export function listHolds(db, sellerId, { includeClosed = false } = {}) {
  const LIMIT = 200;
  const rows = db.prepare(`SELECT * FROM integrity_findings WHERE seller_id=? ${includeClosed ? '' : "AND status='OPEN'"} AND severity IN ('HOLD','BLOCK') ORDER BY last_seen DESC LIMIT ${LIMIT + 1}`).all(sellerId);
  const notesOf = (key) => db.prepare("SELECT ts, detail FROM events WHERE seller_id=? AND type='hold_note' AND instr(detail, ?) > 0 ORDER BY rowid DESC LIMIT 50").all(sellerId, JSON.stringify({ k: key }).slice(5, -1)).map(r => ({ ts: r.ts, ...parse(r.detail) })).filter(d => d.key === key).map(d => ({ at: d.ts, by: d.by, note: d.note }));
  const items = rows.slice(0, LIMIT).map(f => {
    const x = explainFinding(f, db, sellerId);
    // Decision history of this exact item (append-only table) and its ledger events, newest first. Plain stored fields.
    x.decisions = db.prepare('SELECT fingerprint, decided_by AS decidedBy, reason, decided_at AS decidedAt FROM integrity_decisions WHERE seller_id=? AND shipment_key=? AND code=? ORDER BY decided_at DESC LIMIT 20').all(sellerId, f.shipment_key, f.code).map(r => ({ ...r }));
    x.history = db.prepare('SELECT event, fingerprint, at FROM integrity_history WHERE seller_id=? AND shipment_key=? AND code=? ORDER BY at DESC LIMIT 20').all(sellerId, f.shipment_key, f.code).map(r => ({ ...r }));
    x.notes = notesOf(f.shipment_key);
    return x;
  });
  // One inbox: upload-outcome holds (unknown outcome, late feed) are repair rows. They are listed here with their own form; the authorization rules stay in repair.js.
  const states = includeClosed ? ['proposed', 'dismissed', 'uploaded'] : ['proposed'];
  for (const st of states) for (const r of listRepairs(db, sellerId, st)) {
    if (r.kind !== 'unknown_outcome') continue; const late = String(r.event_key).startsWith('LATE_FEED:'); const code = late ? 'LATE_FEED_ARRIVED' : 'UPLOAD_OUTCOME_UNKNOWN'; const g = HOLD_GUIDE[code];
    const number = r.suggestion?.number ?? r.original_number ?? null; const status = st === 'proposed' ? 'OPEN' : 'AUTHORIZED';
    items.push({ source: 'repair', key: r.event_key, code, severity: 'HOLD', status, fingerprint: null, firstSeen: r.created_at, lastSeen: r.created_at, seenCount: 1, title: g.title, kind: 'WAITING_ON_YOU', form: late ? 'confirm_late_feed' : 'authorize_retry',
      happened: cap(r.reason, 700), why: '', evidence: { number, key: r.event_key }, known: ['The upload was started and its outcome was not saved', number ? `The document is ${cap(number, 60)}` : 'The document is not named'],
      unknown: ['Whether Amazon already holds this document', 'Whether an earlier request will still land later'], allowed: st === 'proposed' ? ['Record your Seller Central check and authorize ONE retry'.replace('ONE retry', late ? 'confirmation of that exact feed' : 'ONE retry')] : [],
      blocked: ['The document is not resent automatically, whatever the report says'], next: st === 'proposed' ? 'Nothing happens until you record your check. A report that shows a verdict for the document closes this without a retry.' : 'Your authorization is recorded. It is not an Amazon confirmation.',
      releasable: false, decisions: [], history: [], resolutions: [...g.resolutions, NOTES], held: heldText(db, sellerId, r.shipment_key, { number }), residualRisk: RESIDUAL_RISK, notes: notesOf(r.event_key) });
  }
  items.truncated = rows.length > LIMIT; return items;
}
export function decideHold(db, sellerId, { key, code, fingerprint, reason }, user) {
  if (typeof key !== 'string' || typeof code !== 'string' || typeof fingerprint !== 'string') throw new Error('Choose the item and send its fingerprint.');
  return releaseIntegrity(db, sellerId, key, code, fingerprint, { user, reason });
}

/** Ruling 5 (decision 1): a person may record an investigation note on a hold. A note is an operational record only: it never changes a finding, a document, a shipment or any financial state, and it is never read as Amazon evidence. */
export function addHoldNote(db, sellerId, { key, code, note }, user) {
  if (typeof key !== 'string' || typeof code !== 'string') throw new Error('Choose the item.');
  if (!String(user ?? '').trim()) throw new Error('A note needs the user who writes it.');
  const text = String(note ?? '').trim(); if (text.length < 3) throw new Error('Write the note.');
  const known = db.prepare('SELECT 1 FROM integrity_findings WHERE seller_id=? AND shipment_key=? AND code=?').get(sellerId, key, code) || (() => { try { return db.prepare("SELECT 1 FROM repairs WHERE seller_id=? AND event_key=? AND kind='unknown_outcome'").get(sellerId, key); } catch { return null; } })();
  if (!known) throw new Error('There is no such item.');
  logEvent(db, sellerId, 'hold_note', { key, code, by: String(user).trim(), note: text.slice(0, 1000), effect: 'none' });
  return { recorded: true, stateChanged: false };
}
