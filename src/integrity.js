// Issuance Integrity Gate, ledger and decisions (Phase B, stage 1). The pure assessment is in integrity-core.js. Design: docs/PHASE-B-DESIGN.md.
import { logEvent, txImm } from './db.js';
import { assessShipment } from './integrity-core.js';
export * from './integrity-core.js';

export const gateReason = (findings) => 'Not issued: ' + findings.map(f => f.explanation).join(' ') + ' Nothing was guessed.';

/** Ledger write and decision lookup. Returns null when nothing blocks, or { reason, findings } when the shipment must be held. Idempotent. INFO findings (rounding differences, split shipments) are saved as NOTED: they never hold, and they stay visible. */
export function integrityGate(db, seller, s) {
  // the whole ledger write of one evaluation is one transaction (unless the caller already holds one): an interruption leaves no record without history and no history without a record
  return db.isTransaction ? gateWrite(db, seller, s) : txImm(db, () => gateWrite(db, seller, s));
}
function gateWrite(db, seller, s) {
  let a;
  try { a = assessShipment(s); } catch { return { reason: 'Not issued: the numbers of this shipment could not be checked, so nothing was issued.', findings: [] }; }
  return writeLedger(db, seller.id, s.key, a.findings);
}
/** The ledger write shared by shipments and correction pairs: findings in, blocking findings out. */
export function writeLedger(db, sid, key, findings) {
  const a = { findings };
  const now = new Date().toISOString();
  const rows = new Map(db.prepare('SELECT * FROM integrity_findings WHERE seller_id=? AND shipment_key=?').all(sid, key).map(r => [r.code + '|' + r.field, r]));
  const hist = (f, event) => db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at,evidence) VALUES (?,?,?,?,?,?,?,?)').run(sid, key, f.code, f.evidence.field, event, f.fingerprint, now, event === 'RECHECKED_SAME' ? null : JSON.stringify(f.evidence));
  let changed = false; const blocking = [];
  for (const f of a.findings) {
    const info = f.severity === 'INFO', target = info ? 'NOTED' : 'OPEN', k = f.code + '|' + f.evidence.field, row = rows.get(k); rows.delete(k);
    const ev = JSON.stringify(f.evidence);
    const upd = (extra) => db.prepare(`UPDATE integrity_findings SET status=?, severity=?, resolution=?, fingerprint=?, evidence=?, explanation=?, action=?, last_seen=?, seen_count=seen_count+1${extra} WHERE seller_id=? AND shipment_key=? AND code=? AND field=?`).run(target, f.severity, f.resolution, f.fingerprint, ev, f.explanation, f.action, now, sid, key, f.code, f.evidence.field);
    if (!row) { db.prepare('INSERT INTO integrity_findings (seller_id,shipment_key,code,field,severity,resolution,status,fingerprint,evidence,explanation,action,first_seen,last_seen,seen_count,reopened_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)').run(sid, key, f.code, f.evidence.field, f.severity, f.resolution, target, f.fingerprint, ev, f.explanation, f.action, now, now); hist(f, 'OPENED'); if (!info) { changed = true; blocking.push(f); } continue; }
    if (row.status === 'RESOLVED') { upd(', reopened_count=reopened_count+1, resolved_at=NULL'); hist(f, 'REOPENED'); if (!info) { changed = true; blocking.push(f); } continue; }
    if (row.fingerprint !== f.fingerprint) { upd(''); hist(f, 'CHANGED'); if (!info) { changed = true; blocking.push(f); } continue; }
    db.prepare('UPDATE integrity_findings SET last_seen=?, seen_count=seen_count+1 WHERE seller_id=? AND shipment_key=? AND code=? AND field=?').run(now, sid, key, f.code, f.evidence.field); hist(f, 'RECHECKED_SAME');
    if (row.status === 'OPEN') blocking.push(f);
  }
  for (const row of rows.values()) if (row.status !== 'RESOLVED') { db.prepare("UPDATE integrity_findings SET status='RESOLVED', resolved_at=? WHERE seller_id=? AND shipment_key=? AND code=? AND field=?").run(now, sid, key, row.code, row.field); db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run(sid, key, row.code, row.field, 'RESOLVED', row.fingerprint, now); }
  if (changed) logEvent(db, sid, 'integrity', { key, codes: blocking.map(f => f.code), severities: blocking.map(f => f.severity) });
  return blocking.length ? { reason: gateReason(blocking), findings: blocking } : null;
}

/** What the user should see next to a shipment that is NOT held: the INFO findings, in plain words. Pure. */
export function integrityNotes(s) { try { return assessShipment(s).findings.filter(f => f.severity === 'INFO').map(f => ({ code: f.code, text: f.explanation })); } catch { return []; } }

/** A person releases a HUMAN_DECISION hold. Refused for BLOCK and NEW_EVIDENCE, for a stale fingerprint, a missing user or a reason under 10 characters. Issues nothing by itself.
 * ATOMIC: decision, status change and history are one transaction, and the status change is conditional on the finding still being OPEN with this exact fingerprint. A trigger in the database also refuses RELEASED without a recorded decision. */
export function releaseIntegrity(db, sellerId, shipmentKey, code, fingerprint, { user, reason } = {}) {
  return txImm(db, () => {
    const rows = db.prepare("SELECT * FROM integrity_findings WHERE seller_id=? AND shipment_key=? AND code=? AND status='OPEN'").all(sellerId, shipmentKey, code);
    if (!rows.length) throw new Error('There is no open finding of that kind for this shipment.');
    const row = rows.find(r => r.fingerprint === fingerprint) ?? rows[0];
    if (row.severity === 'BLOCK') throw new Error('A BLOCK finding cannot be released: the file contradicts itself and only a corrected file resolves it.');
    if (row.resolution !== 'HUMAN_DECISION') throw new Error('This finding needs new evidence: only a corrected file resolves it, and a decision cannot release it.');
    if (row.fingerprint !== fingerprint) throw new Error('The decision must name the fingerprint of the evidence it covers. The evidence changed or the fingerprint is wrong.');
    if (!String(user ?? '').trim()) throw new Error('A decision needs the user who takes it.');
    if (String(reason ?? '').trim().length < 10) throw new Error('A decision needs a reason of at least 10 characters.');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO integrity_decisions (seller_id,shipment_key,code,field,fingerprint,decided_by,reason,decided_at) VALUES (?,?,?,?,?,?,?,?)').run(sellerId, shipmentKey, row.code, row.field, fingerprint, String(user).trim(), String(reason).trim(), now);
    const r = db.prepare("UPDATE integrity_findings SET status='RELEASED' WHERE seller_id=? AND shipment_key=? AND code=? AND field=? AND fingerprint=? AND status='OPEN' AND resolution='HUMAN_DECISION' AND severity<>'BLOCK'").run(sellerId, shipmentKey, row.code, row.field, fingerprint);
    if (Number(r.changes) !== 1) throw new Error('The finding is no longer open with this evidence: nothing was recorded.');
    db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run(sellerId, shipmentKey, row.code, row.field, 'RELEASED', fingerprint, now);
    return { released: true };
  });
}

/** Ledger write for a correction pair (one transaction unless the caller holds one). */
export function correctionLedger(db, sellerId, key, findings) { return db.isTransaction ? writeLedger(db, sellerId, key, findings) : txImm(db, () => writeLedger(db, sellerId, key, findings)); }
