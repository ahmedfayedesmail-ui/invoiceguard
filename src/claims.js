// Upload claim ownership (expedition re-review 1, N1 + in-flight class).
// Every claim on an upload takes a random token written on the document row. Three rules:
//  1. The result write of an upload only lands on the row while the row still carries THAT token.
//     A late result from a claim that lost the row is recorded as an event plus a human hold
//     (Amazon may then hold two feeds for one number) - it never overwrites the new owner.
//  2. The boot/timer sweep never takes a claim that a live call in THIS process still owns, and
//     its UPDATE is conditional on the token it read.
//  3. While a call is in flight its process stamps claim_heartbeat every 5 s; the sweep (any process) treats a claim as live until the newest of sending_at and claim_heartbeat is older than the grace.
//  4. A timed-out call is ABORTED (AbortSignal reaches the SP-API fetches), logged as upload_timeout_abandoned (the settle path waits a quiet period before any resend), and if the abandoned request still lands its feed is recorded, blocks the resend and opens a LATE_FEED hold.
//  5. An upload call has a hard timeout far below the sweep grace. A hung call becomes an
//     unknown outcome (held, settled by the next Amazon report) instead of a claim that outlives
//     the grace. Cross-process liveness is covered by timeout < grace, not by a heartbeat.
import { randomUUID } from 'node:crypto';
import { logEvent, tx } from './db.js';
import { proposeRejectedRetry } from './repair.js';
export const ABANDON_QUIET_MS = 5 * 60 * 1000;
export const UPLOAD_TIMEOUT_MS_DEFAULT = 2 * 60 * 1000;
const live = new Set();
export const newClaimToken = () => randomUUID();
export const isLiveClaim = (t) => !!t && live.has(t);
export const uploadTimeoutMs = () => Number(process.env.IG_UPLOAD_TIMEOUT_MS) > 0 ? Number(process.env.IG_UPLOAD_TIMEOUT_MS) : UPLOAD_TIMEOUT_MS_DEFAULT;
export const HEARTBEAT_MS = 5 * 1000;
function beat(db, token) { try { db.prepare('UPDATE invoices SET claim_heartbeat=? WHERE claim_token=?').run(new Date().toISOString(), token); } catch { /* a heartbeat must never break an upload */ } }
export async function guardedUpload(db, token, call, { sellerId = null, number = null } = {}) {
  const ac = new AbortController();
  live.add(token);
  let timer, p;
  beat(db, token); // ownership proof for OTHER processes: the sweep treats a claim as live while this keeps ticking
  const hb = setInterval(() => beat(db, token), HEARTBEAT_MS); hb.unref?.();
  try {
    return await Promise.race([
      (p = call(ac.signal)),
      new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); try { logEvent(db, sellerId, 'upload_timeout_abandoned', { number }); } catch { /* the hold below still applies */ } if (p) Promise.resolve(p).then(f => { if (f) lateUploadResult(db, sellerId, number, f, { fromTimeout: true }); }).catch(() => {}); rej(Object.assign(new Error('the upload call did not answer in time; Amazon may or may not have received it'), { unknownOutcome: true, uploadTimeout: true })); }, uploadTimeoutMs()); }),
    ]);
  } finally { clearTimeout(timer); clearInterval(hb); live.delete(token); }
}

/** The result write of an upload found the row owned by someone else (the claim was swept or the
 * document was claimed again). Amazon accepted a feed for this number, so it may now hold more than
 * one. Never overwrite the new owner: record the late feed and open a human hold. */
export function lateUploadResult(db, sellerId, number, feedId, { fromTimeout = false } = {}) {
  const row = db.prepare('SELECT shipment_key, kind, rectifies, upload_status, feed_id FROM invoices WHERE seller_id=? AND number=?').get(sellerId, number);
  if (!row) return;
  tx(db, () => {
    logEvent(db, sellerId, 'late_upload_result', { number, lateFeedId: feedId, currentFeedId: row.feed_id ?? null, status: row.upload_status });
    if (fromTimeout) db.prepare("UPDATE invoices SET blocked_feed_id=COALESCE(blocked_feed_id, ?) WHERE seller_id=? AND number=? AND upload_status='unknown'").run(feedId, sellerId, number); // the abandoned request landed after all: that feed blocks any resend
    if (row.upload_status === 'uploaded') return; // Amazon already accepted a document under this number
    proposeRejectedRetry(db, { id: sellerId }, { eventKey: `LATE_FEED:${row.shipment_key}:${feedId}`, kind: 'unknown_outcome', number, originalNumber: row.rectifies ?? number, shipmentKey: row.shipment_key, rectNumber: row.kind === 'rectificativa' ? number : null, action: 'hold',
      reason: `An upload of ${number} finished after the app had already treated that attempt as lost (feed ${feedId}). Amazon may now hold more than one submission for this document. Nothing was changed or resent automatically. Check Seller Central, then decide.` });
  });
}
