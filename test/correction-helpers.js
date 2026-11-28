// Shared by the correction tests (owner decision of Nov 28 2026: every CorrectionReversal needs a documented human decision before a credit note).
import { releaseIntegrity } from '../src/integrity.js';
export const CODE = 'CORRECTION_PAIR_REVIEW';
export const openReviews = (db) => db.prepare("SELECT * FROM integrity_findings WHERE code=? AND status='OPEN'").all(CODE);
/** Approve every open correction-pair review as a person would: decision, reason and the fingerprint of what was shown. */
export function approveAll(db, sellerId, who = 'reviewer-1', reason = 'checked the pair against the original invoice') {
  const rows = openReviews(db); for (const f of rows) releaseIntegrity(db, sellerId, f.shipment_key, f.code, f.fingerprint, { user: who, reason }); return rows.length;
}
