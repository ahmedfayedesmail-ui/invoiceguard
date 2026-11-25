// Operator-only password reset (v1 has no email channel). Run on the server:
//   EMAIL=seller@example.com NEWPW='a-long-new-password' DB_FILE=/data/invoiceguard.db node tools/reset_password.mjs
// Sets the new password and signs the account out everywhere. Only do this after you have confirmed the person's identity yourself.
import { openDb } from '../src/db.js';
import { hashPw } from '../src/auth.js';
const email = String(process.env.EMAIL ?? '').trim().toLowerCase(), pw = String(process.env.NEWPW ?? '');
if (!email || pw.length < 10) { console.error('Set EMAIL and NEWPW (at least 10 characters).'); process.exit(1); }
const db = openDb(process.env.DB_FILE ?? 'invoiceguard.db');
const u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
if (!u) { console.error('No such account.'); process.exit(1); }
const { salt, hash } = hashPw(pw);
db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, u.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
console.log('Password reset and all sessions ended for', email);
