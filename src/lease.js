// Claim lease: who is issuing for a reserved credit claim. Written in the SAME transaction as the claim, removed when the document row is written (or the claim rolls back / is released).
// It exists so that "no issuance is running" can be PROVEN, never assumed from age or from a missing document row.
// Proof of absence = a recorded owner on THIS machine whose process is gone (no such pid, or the pid now belongs to a different process: its start time differs).
// Anything else (no lease, another host, a start time we cannot read while the pid lives) is "unproven" and nothing may be released.
import { hostname } from 'node:os';
import { readFileSync, readlinkSync } from 'node:fs';
// identity of the machine boot and of the PID namespace: a pid number only means something inside the same boot and the same namespace
export const bootId = () => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } };
export const pidNs = () => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } };
export const procStart = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; } };
export function writeLease(db, sellerId, key, claimId, at) {
  db.prepare('INSERT OR REPLACE INTO claim_leases (seller_id,reversal_key,claim_id,host,pid,proc_start,started_at,boot_id,pid_ns) VALUES (?,?,?,?,?,?,?,?,?)').run(sellerId, key, claimId, hostname(), process.pid, procStart(process.pid), at, bootId(), pidNs());
}
export const dropLease = (db, sellerId, key) => db.prepare('DELETE FROM claim_leases WHERE seller_id=? AND reversal_key=?').run(sellerId, key);
const validPid = (p) => Number.isInteger(p) && p > 0 && p <= 4194304; // a stored pid must be a positive integer within the Linux pid range; anything else is no identity at all
/** 'absent' only for ESRCH (no such process); 'present' for success or EPERM; 'unknown' for every other outcome (never proof of absence). */
const probePid = (pid) => { try { process.kill(pid, 0); return 'present'; } catch (e) { return e.code === 'EPERM' ? 'present' : e.code === 'ESRCH' ? 'absent' : 'unknown'; } };
/** state: 'alive' (an issuing process exists), 'gone' (proven: it ended), 'unproven' (cannot tell). proven is true only for 'gone'. */
export function ownerState(db, sellerId, key) {
  const l = db.prepare('SELECT host, proc_start, started_at, boot_id, pid_ns, CAST(pid AS TEXT) AS pid_txt FROM claim_leases WHERE seller_id=? AND reversal_key=?').get(sellerId, key); // pid is read as text: a value the driver cannot represent must not throw, it is just not a valid pid
  if (!l) return { state: 'unproven', proven: false, lease: null, why: 'No owner is recorded for this claim, so it cannot be proven that nothing is issuing it.' };
  const spid = /^[1-9][0-9]{0,9}$/.test(l.pid_txt ?? '') ? Number(l.pid_txt) : null; const lease = { host: l.host, bootId: l.boot_id, pidNs: l.pid_ns, pid: spid, procStart: l.proc_start, startedAt: l.started_at };
  if (l.boot_id == null || l.boot_id !== bootId()) return { state: 'unproven', proven: false, lease, why: 'The issuing process was recorded in another system start (or the start cannot be checked): its process number means nothing now.' };
  if (l.pid_ns == null || l.pid_ns !== pidNs()) return { state: 'unproven', proven: false, lease, why: 'The issuing process was recorded in another process space (for example another container): its absence here proves nothing.' };
  if (l.host !== hostname()) return { state: 'unproven', proven: false, lease, why: 'The issuing process was recorded on another machine and cannot be checked from here.' };
  if (!validPid(spid)) return { state: 'unproven', proven: false, lease, why: 'The recorded process number is missing or invalid, so nothing can be said about whether the issuing process ended.' };
  const probe = probePid(spid);
  if (probe === 'unknown') return { state: 'unproven', proven: false, lease, why: 'The system could not tell whether the recorded process exists, so its absence is not proven.' };
  if (probe === 'absent') return { state: 'gone', proven: true, lease, why: 'The process that was issuing this claim has ended.' };
  const now = procStart(spid);
  if (now && l.proc_start && now !== l.proc_start) return { state: 'gone', proven: true, lease, why: 'The process that was issuing this claim has ended (its process number now belongs to another program).' };
  if (!now || !l.proc_start) return { state: 'unproven', proven: false, lease, why: 'A process with the recorded number exists and its identity cannot be checked.' };
  return { state: 'alive', proven: false, lease, why: 'The process that is issuing this claim is still running.' };
}
