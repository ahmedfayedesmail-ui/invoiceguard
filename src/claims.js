// Stuck credit-claim recovery. A claim is stuck when it was reserved for an approved correction pair and no document row ever followed (a crash between the two). It counts against the creditable balance, so it fails safe, but it never frees itself.
// Rules (Ahmed, Nov 28 2026): no auto-release; time alone never proves abandonment (age only LISTS a candidate); never with a document or an unsettled upload; nothing active may own the claim; every release is a documented HUMAN_DECISION (user, reason, time, fingerprint); full history.
// Double-issue safety: release and the issuing insert are both BEGIN IMMEDIATE transactions and the insert (pipeline.js issueRectificativa) refuses when its claim is gone, so exactly one of them wins.
import { createHash } from 'node:crypto';
import { txImm } from './db.js';
import { correctionLedger, releaseIntegrityTx } from './integrity.js';
export const MIN_STUCK_AGE_MS = 15 * 60 * 1000; // quiet period: a necessary condition only, never a proof
export const STUCK_CODE = 'CLAIM_STUCK_REVIEW';
const fk = (key) => 'CLAIM:' + key;
const docRows = (db, sid, key) => db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa'").all(sid, key);
function evidenceOf(db, sid, key) {
  const c = db.prepare('SELECT * FROM credit_claims WHERE seller_id=? AND reversal_key=?').get(sid, key); if (!c) return null;
  const orig = db.prepare("SELECT number, json FROM invoices WHERE seller_id=? AND number=?").get(sid, c.original_number);
  const others = db.prepare("SELECT number, total, upload_status FROM invoices WHERE seller_id=? AND rectifies=? AND kind='rectificativa' AND shipment_key<>? ORDER BY number").all(sid, c.original_number, key);
  const otherClaims = db.prepare('SELECT reversal_key, amount FROM credit_claims WHERE seller_id=? AND original_number=? AND reversal_key<>? ORDER BY reversal_key').all(sid, c.original_number, key);
  const hist = db.prepare('SELECT id, event FROM credit_claim_history WHERE seller_id=? AND reversal_key=? ORDER BY id').all(sid, key);
  return { claim: c, evidence: { field: 'stuck-claim', reversalKey: key, original: { number: c.original_number, sha256: orig ? createHash('sha256').update(orig.json).digest('hex') : null }, amount: c.amount, claimedAt: c.claimed_at, documentsForEvent: docRows(db, sid, key), otherCreditNotes: others, otherClaims, history: hist } };
}
const fpOf = (ev) => createHash('sha256').update(JSON.stringify([STUCK_CODE, ev])).digest('hex');
const oldEnough = (c, minAgeMs) => Date.now() - Date.parse(c.claimed_at) >= minAgeMs;
/** Candidates for a person to look at. Pure read. A claim with a document row of any status is never listed. */
export function listStuckClaims(db, sellerId, { minAgeMs = MIN_STUCK_AGE_MS } = {}) {
  return db.prepare('SELECT * FROM credit_claims WHERE seller_id=? ORDER BY claimed_at').all(sellerId).filter(c => !docRows(db, sellerId, c.reversal_key).length && oldEnough(c, minAgeMs)).map(c => ({ reversalKey: c.reversal_key, originalNumber: c.original_number, amount: c.amount, claimedAt: c.claimed_at }));
}
/** Open (or refresh) the HUMAN_DECISION review for one stuck claim. Releases nothing. */
export function openStuckClaimReview(db, sellerId, key, { minAgeMs = MIN_STUCK_AGE_MS } = {}) {
  return txImm(db, () => {
    const e = evidenceOf(db, sellerId, key); if (!e) throw new Error('There is no credit claim for this event.');
    if (e.evidence.documentsForEvent.length) throw new Error('A document or upload already exists for this event: the claim belongs to that document and is not stuck.');
    if (!oldEnough(e.claim, minAgeMs)) throw new Error('This claim is inside the quiet period: an issuance may still be in progress. Look again later.');
    const fingerprint = fpOf(e.evidence);
    correctionLedger(db, sellerId, fk(key), [{ code: STUCK_CODE, severity: 'HOLD', resolution: 'HUMAN_DECISION', fingerprint, evidence: e.evidence, explanation: `The credit claim of ${Number(e.claim.amount).toFixed(2)} on invoice ${e.claim.original_number} has no document. It blocks that amount until a person decides.`, action: 'Check that nothing was uploaded for this event, then decide with a reason.' }]);
    return { fingerprint, evidence: e.evidence };
  });
}
/** Release one stuck claim after a documented human decision. Everything is re-checked inside the same transaction. */
export function releaseStuckClaim(db, sellerId, key, fingerprint, { user, reason, minAgeMs = MIN_STUCK_AGE_MS } = {}) {
  return txImm(db, () => {
    if (!db.prepare("SELECT 1 FROM integrity_findings WHERE seller_id=? AND shipment_key=? AND code=? AND status='OPEN'").get(sellerId, fk(key), STUCK_CODE)) throw new Error('There is no open review finding for this claim: open the review first.');
    const e = evidenceOf(db, sellerId, key); if (!e) throw new Error('There is no credit claim for this event any more.');
    if (e.evidence.documentsForEvent.length) throw new Error('A document or upload exists for this event: the claim cannot be released.');
    if (!oldEnough(e.claim, minAgeMs)) throw new Error('This claim is inside the quiet period: an issuance may still be in progress.');
    if (!String(user ?? '').trim()) throw new Error('A decision needs the user who takes it.');
    if (String(reason ?? '').trim().length < 10) throw new Error('A decision needs a reason of at least 10 characters.');
    const now = fpOf(e.evidence); if (now !== fingerprint) throw new Error('The evidence changed since the review or the fingerprint is wrong: nothing was released. Open the review again.');
    releaseIntegrityTx(db, sellerId, fk(key), STUCK_CODE, fingerprint, { user, reason });
    db.prepare('DELETE FROM credit_claims WHERE seller_id=? AND reversal_key=?').run(sellerId, key);
    db.prepare('INSERT INTO credit_claim_history (seller_id,reversal_key,original_number,amount,event,actor,reason,fingerprint,at) VALUES (?,?,?,?,?,?,?,?,?)').run(sellerId, key, e.claim.original_number, e.claim.amount, 'RELEASED', user, reason, fingerprint, new Date().toISOString());
    return { released: true };
  });
}
