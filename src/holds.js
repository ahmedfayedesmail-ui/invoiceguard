// Expedition W2-2: the review queue for ledger findings (HOLD / BLOCK). Until now these were written by the pipeline and read only by tests: no route listed them and none recorded the human decision.
// Every item answers: what happened, why, which evidence, what the system knows, what it does not know, what is allowed, what is blocked, what happens next. Pure text from stored fields; nothing is inferred.
import { releaseIntegrity } from './integrity.js';
const parse = (s) => { try { return JSON.parse(s ?? 'null') ?? {}; } catch { return {}; } };
const CN = {
  CREDIT_NOTE_IDENTITY_UNPROVEN: { happened: 'Amazon sent a report row about a credit note, but the row could not be proven to be our document.', blocked: ['No status change on the credit note', 'No replacement invoice', 'No retry or re-upload of any correction document of this pair'] },
  CREDIT_NOTE_ROWS_CONFLICT: { happened: 'The report rows of one credit note disagree with each other (different statuses).', blocked: ['No status change on the credit note', 'No replacement invoice', 'No retry or re-upload of any correction document of this pair'] },
  CREDIT_NOTE_VERDICT_CONTRADICTION: { happened: 'Amazon reported this credit note as uploaded earlier and now reports it as rejected.', blocked: ['No replacement invoice (if none was issued yet)', 'No retry or re-upload of any correction document of this pair', 'Nothing is cancelled automatically'] },
};
export function explainFinding(f) {
  const ev = parse(f.evidence); const snap = ev.snapshot ?? null; let cn = CN[f.code];
  if (cn && ev.documentKind === 'replacement invoice') cn = { ...cn, happened: 'Amazon sent a report row that says our replacement invoice was uploaded, but the row could not be proven to be our document (number, amounts or context do not match exactly).' };
  if (f.code === 'REFUND_ROW_INVOICE_STATUS') cn = { happened: 'A refund row in the Amazon report carries an invoice status. We do not know what Amazon means by that.', blocked: ['The original invoice and the credit note are not changed by this row', 'The row is not read as an acceptance or a rejection of anything'] };
  const known = [], unknown = [];
  if (cn) {
    known.push('Our stored credit note exists' + (ev.number ? ` (${ev.number})` : ''), 'The report was ingested and nothing was applied from it');
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
  };
}
export function listHolds(db, sellerId, { includeClosed = false } = {}) {
  const LIMIT = 200;
  const rows = db.prepare(`SELECT * FROM integrity_findings WHERE seller_id=? ${includeClosed ? '' : "AND status='OPEN'"} AND severity IN ('HOLD','BLOCK') ORDER BY last_seen DESC LIMIT ${LIMIT + 1}`).all(sellerId);
  const items = rows.slice(0, LIMIT).map(f => {
    const x = explainFinding(f);
    // Decision history of this exact item (append-only table) and its ledger events, newest first. Plain stored fields.
    x.decisions = db.prepare('SELECT fingerprint, decided_by AS decidedBy, reason, decided_at AS decidedAt FROM integrity_decisions WHERE seller_id=? AND shipment_key=? AND code=? ORDER BY decided_at DESC LIMIT 20').all(sellerId, f.shipment_key, f.code).map(r => ({ ...r }));
    x.history = db.prepare('SELECT event, fingerprint, at FROM integrity_history WHERE seller_id=? AND shipment_key=? AND code=? ORDER BY at DESC LIMIT 20').all(sellerId, f.shipment_key, f.code).map(r => ({ ...r }));
    return x;
  });
  items.truncated = rows.length > LIMIT; return items;
}
export function decideHold(db, sellerId, { key, code, fingerprint, reason }, user) {
  if (typeof key !== 'string' || typeof code !== 'string' || typeof fingerprint !== 'string') throw new Error('Choose the item and send its fingerprint.');
  return releaseIntegrity(db, sellerId, key, code, fingerprint, { user, reason });
}
