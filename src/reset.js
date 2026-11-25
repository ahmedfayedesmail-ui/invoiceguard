// Operator password reset for hosts without a shell. Set RESET_EMAIL and RESET_PASSWORD (12+ chars) as environment
// variables and restart; the reset runs once at boot, signs the account out everywhere, and is remembered by a
// fingerprint so a later restart with the same variables does NOT overwrite a password the person has since changed.
// Remove both variables afterwards. Nothing here is reachable over the network.
import { createHash } from 'node:crypto';
import { hashPw } from './auth.js';
export function applyBootReset(db, env = process.env, log = console.log) {
  const email = String(env.RESET_EMAIL ?? '').trim().toLowerCase(), pw = String(env.RESET_PASSWORD ?? '');
  if (!email && !pw) return { done: false, why: 'not requested' };
  if (!email || pw.length < 12) { log('password reset skipped: set both RESET_EMAIL and RESET_PASSWORD (12+ characters)'); return { done: false, why: 'invalid' }; }
  db.exec('CREATE TABLE IF NOT EXISTS reset_log (fp TEXT PRIMARY KEY, at TEXT)');
  const fp = createHash('sha256').update(email + '\n' + pw).digest('hex');
  if (db.prepare('SELECT 1 FROM reset_log WHERE fp=?').get(fp)) { log('password reset already applied earlier; remove RESET_EMAIL and RESET_PASSWORD'); return { done: false, why: 'already applied' }; }
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!u) { log('password reset skipped: no such account'); return { done: false, why: 'no account' }; }
  const { salt, hash } = hashPw(pw);
  db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, u.id);
  try { db.prepare('UPDATE users SET pw_changed_at=? WHERE id=?').run(new Date().toISOString(), u.id); db.prepare('INSERT INTO pw_history VALUES (?,?,?,?)').run(u.id, salt, hash, new Date().toISOString()); } catch { /* security tables not created yet */ }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('INSERT INTO reset_log VALUES (?,?)').run(fp, new Date().toISOString());
  log('password reset applied and sessions ended for one account; remove RESET_EMAIL and RESET_PASSWORD now');
  return { done: true };
}
