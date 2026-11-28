// Shared by the correction tests (owner decision of Nov 28 2026: every CorrectionReversal needs a documented human decision before a credit note).
import { releaseIntegrity } from '../src/integrity.js';
export const CODE = 'CORRECTION_PAIR_REVIEW';
export const openReviews = (db) => db.prepare("SELECT * FROM integrity_findings WHERE code=? AND status='OPEN'").all(CODE);
/** Approve every open correction-pair review as a person would: decision, reason and the fingerprint of what was shown. */
export function approveAll(db, sellerId, who = 'reviewer-1', reason = 'checked the pair against the original invoice') {
  const rows = openReviews(db); for (const f of rows) releaseIntegrity(db, sellerId, f.shipment_key, f.code, f.fingerprint, { user: who, reason }); return rows.length;
}
/** For the older correction tests written before the owner decision: stage the review, approve it as a reviewer would, then run the pass that issues. Their assertions are unchanged. */
export const withApproval = (pc) => async (db, seller, ...rest) => { const a = await pc(db, seller, ...rest); approveAll(db, seller.id); const b = await pc(db, seller, ...rest); return { creditNotes: a.creditNotes + b.creditNotes, invoices: a.invoices + b.invoices, skipped: b.skipped, errors: [...a.errors, ...b.errors] }; };
// Strict credit-note acceptance (owner ruling A, Nov 28 2026): Amazon's CreditNoteUploaded only counts when the row names OUR document number and the report comes with its authenticated sequence.
// The older tests feed key-only acceptance rows; this wrapper turns such a row into a complete one (adds the invoice-number column filled with OUR stored credit note number for that key). Their assertions are unchanged.
import { processReport as _pr } from '../src/pipeline.js'; import { currentAttemptSeq } from '../src/db.js';
export function withOurNumbers(db, sellerId, text) {
  const lines = text.split('\n'); const head = lines[0].split('\t'); let c = head.indexOf('invoice-number'); const add = c < 0; if (add) { c = head.length; lines[0] += '\tinvoice-number'; }
  const t = head.indexOf('transaction-type'), i = head.indexOf('transaction-id'), s = head.indexOf('invoice-status');
  return lines.map((l, n) => { if (!n) return l; const f = l.split('\t'); if (add) while (f.length < c) f.push(''); const key = `${f[t]}:${f[i]}`; if (f[s]?.trim() === 'CreditNoteUploaded') { const r = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa' ORDER BY issued_at DESC LIMIT 1").get(sellerId, key); if (r) f[c] = r.number; } else if (add) f[c] = f[c] ?? ''; return f.join('\t'); }).join('\n');
}
export const acceptReport = (db, seller, text, opts = {}) => _pr(db, seller, withOurNumbers(db, seller.id, text), { reportAttemptSeq: currentAttemptSeq(db, seller.id), ...opts });
