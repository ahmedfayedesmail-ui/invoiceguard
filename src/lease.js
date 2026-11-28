// Claim lease: who is issuing for a reserved credit claim. Written in the SAME transaction as the claim, removed when the document row is written (or the claim rolls back / is released).
// It exists so that "no issuance is running" can be PROVEN, never assumed from age or from a missing document row.
// Proof of absence = a recorded owner on THIS machine whose process is gone (no such pid, or the pid now belongs to a different process: its start time differs).
// Anything else (no lease, another host, a start time we cannot read while the pid lives) is "unproven" and nothing may be released.
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
export const procStart = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; } };
export function writeLease(db, sellerId, key, claimId, at) {
  db.prepare('INSERT OR REPLACE INTO claim_leases (seller_id,reversal_key,claim_id,host,pid,proc_start,started_at) VALUES (?,?,?,?,?,?,?)').run(sellerId, key, claimId, hostname(), process.pid, procStart(process.pid), at);
}
export const dropLease = (db, sellerId, key) => db.prepare('DELETE FROM claim_leases WHERE seller_id=? AND reversal_key=?').run(sellerId, key);
const pidExists = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** state: 'alive' (an issuing process exists), 'gone' (proven: it ended), 'unproven' (cannot tell). proven is true only for 'gone'. */
export function ownerState(db, sellerId, key) {
  const l = db.prepare('SELECT * FROM claim_leases WHERE seller_id=? AND reversal_key=?').get(sellerId, key);
  if (!l) return { state: 'unproven', proven: false, lease: null, why: 'No owner is recorded for this claim, so it cannot be proven that nothing is issuing it.' };
  const lease = { host: l.host, pid: l.pid, procStart: l.proc_start, startedAt: l.started_at };
  if (l.host !== hostname()) return { state: 'unproven', proven: false, lease, why: 'The issuing process was recorded on another machine and cannot be checked from here.' };
  if (!pidExists(l.pid)) return { state: 'gone', proven: true, lease, why: 'The process that was issuing this claim has ended.' };
  const now = procStart(l.pid);
  if (now && l.proc_start && now !== l.proc_start) return { state: 'gone', proven: true, lease, why: 'The process that was issuing this claim has ended (its process number now belongs to another program).' };
  if (!now || !l.proc_start) return { state: 'unproven', proven: false, lease, why: 'A process with the recorded number exists and its identity cannot be checked.' };
  return { state: 'alive', proven: false, lease, why: 'The process that is issuing this claim is still running.' };
}
