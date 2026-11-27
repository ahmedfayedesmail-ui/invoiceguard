// Issuance Integrity Gate, ledger and decisions (Phase B, stage 1). The pure assessment is in integrity-core.js. Design: docs/PHASE-B-DESIGN.md.
import { logEvent } from './db.js';
import { assessShipment } from './integrity-core.js';
export * from './integrity-core.js';

export const gateReason = (findings) => 'Not issued: ' + findings.map(f => f.explanation).join(' ') + ' Nothing was guessed.';

/** Ledger write and decision lookup. Returns null when nothing blocks, or { reason, findings } when the shipment must be held. Idempotent. */
export function integrityGate(db, seller, s) {
  let a;
  try { a = assessShipment(s); } catch { return { reason: 'Not issued: the numbers of this shipment could not be checked, so nothing was issued.', findings: [] }; }
  const now = new Date().toISOString(), key = s.key, sid = seller.id;
  const open = a.findings.filter(f => f.severity !== 'INFO');
  const rows = new Map(db.prepare('SELECT * FROM integrity_findings WHERE seller_id=? AND shipment_key=?').all(sid, key).map(r => [r.code + '|' + r.field, r]));
  const hist = (f, event) => db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run(sid, key, f.code, f.evidence.field, event, f.fingerprint, now);
  let changed = false; const blocking = [];
  for (const f of open) {
    const k = f.code + '|' + f.evidence.field, row = rows.get(k); rows.delete(k);
    const ev = JSON.stringify(f.evidence);
    if (!row) { db.prepare("INSERT INTO integrity_findings (seller_id,shipment_key,code,field,severity,resolution,status,fingerprint,evidence,explanation,action,first_seen,last_seen,seen_count,reopened_count) VALUES (?,?,?,?,?,?,'OPEN',?,?,?,?,?,?,1,0)").run(sid, key, f.code, f.evidence.field, f.severity, f.resolution, f.fingerprint, ev, f.explanation, f.action, now, now); hist(f, 'OPENED'); changed = true; blocking.push(f); continue; }
    if (row.status === 'RESOLVED') { db.prepare("UPDATE integrity_findings SET status='OPEN', severity=?, resolution=?, fingerprint=?, evidence=?, explanation=?, action=?, last_seen=?, seen_count=seen_count+1, reopened_count=reopened_count+1, resolved_at=NULL WHERE seller_id=? AND shipment_key=? AND code=? AND field=?").run(f.severity, f.resolution, f.fingerprint, ev, f.explanation, f.action, now, sid, key, f.code, f.evidence.field); hist(f, 'REOPENED'); changed = true; blocking.push(f); continue; }
    if (row.fingerprint !== f.fingerprint) { db.prepare("UPDATE integrity_findings SET status='OPEN', severity=?, resolution=?, fingerprint=?, evidence=?, explanation=?, action=?, last_seen=?, seen_count=seen_count+1 WHERE seller_id=? AND shipment_key=? AND code=? AND field=?").run(f.severity, f.resolution, f.fingerprint, ev, f.explanation, f.action, now, sid, key, f.code, f.evidence.field); hist(f, 'CHANGED'); changed = true; blocking.push(f); continue; }
    db.prepare('UPDATE integrity_findings SET last_seen=?, seen_count=seen_count+1 WHERE seller_id=? AND shipment_key=? AND code=? AND field=?').run(now, sid, key, f.code, f.evidence.field); hist(f, 'RECHECKED_SAME');
    if (row.status === 'OPEN') blocking.push(f);
  }
  for (const row of rows.values()) if (row.status !== 'RESOLVED') { db.prepare("UPDATE integrity_findings SET status='RESOLVED', resolved_at=? WHERE seller_id=? AND shipment_key=? AND code=? AND field=?").run(now, sid, key, row.code, row.field); db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run(sid, key, row.code, row.field, 'RESOLVED', row.fingerprint, now); }
  if (changed) logEvent(db, sid, 'integrity', { key, codes: blocking.map(f => f.code), severities: blocking.map(f => f.severity) });
  return blocking.length ? { reason: gateReason(blocking), findings: blocking } : null;
}

/** A person releases a HUMAN_DECISION hold. Refused for BLOCK and NEW_EVIDENCE, for a stale fingerprint, a missing user or a reason under 10 characters. Issues nothing by itself. */
export function releaseIntegrity(db, sellerId, shipmentKey, code, fingerprint, { user, reason } = {}) {
  const rows = db.prepare("SELECT * FROM integrity_findings WHERE seller_id=? AND shipment_key=? AND code=? AND status='OPEN'").all(sellerId, shipmentKey, code);
  if (!rows.length) throw new Error('There is no open finding of that kind for this shipment.');
  const row = rows.find(r => r.fingerprint === fingerprint) ?? rows[0];
  if (row.severity === 'BLOCK') throw new Error('A BLOCK finding cannot be released: the file contradicts itself and only a corrected file resolves it.');
  if (row.resolution !== 'HUMAN_DECISION') throw new Error('This finding needs new evidence: only a corrected file resolves it, and a decision cannot release it.');
  if (row.fingerprint !== fingerprint) throw new Error('The decision must name the fingerprint of the evidence it covers. The evidence changed or the fingerprint is wrong.');
  if (!String(user ?? '').trim()) throw new Error('A decision needs the user who takes it.');
  if (String(reason ?? '').trim().length < 10) throw new Error('A decision needs a reason of at least 10 characters.');
  const now = new Date().toISOString();
  db.prepare("UPDATE integrity_findings SET status='RELEASED' WHERE seller_id=? AND shipment_key=? AND code=? AND field=? AND fingerprint=?").run(sellerId, shipmentKey, row.code, row.field, fingerprint);
  db.prepare('INSERT INTO integrity_decisions (seller_id,shipment_key,code,field,fingerprint,decided_by,reason,decided_at) VALUES (?,?,?,?,?,?,?,?)').run(sellerId, shipmentKey, row.code, row.field, fingerprint, String(user).trim(), String(reason).trim(), now);
  db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run(sellerId, shipmentKey, row.code, row.field, 'RELEASED', fingerprint, now);
  return { released: true };
}
