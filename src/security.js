// Security controls: password rules, two-step sign-in (TOTP, RFC 6238), password history, and buyer-data retention.
// Controls follow Amazon's Data Protection Policy guidance (developer-docs.amazon.com, Key Security Control Guidance).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PW_MIN = 12, PW_HISTORY = 10, PW_MAX_AGE_DAYS = 365, PII_DAYS = 30;

/** Returns a plain-language problem, or null when the password is acceptable. */
export function passwordProblem(pw, email = '') {
  pw = String(pw ?? '');
  if (pw.length < PW_MIN) return `Password must be at least ${PW_MIN} characters`;
  if (pw.length > 200) return 'Password is too long';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return 'Password needs both upper and lower case letters';
  if (!/[0-9]/.test(pw)) return 'Password needs at least one number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password needs at least one symbol, such as ! or -';
  const low = pw.toLowerCase();
  for (const part of String(email).toLowerCase().split('@')[0].split(/[^a-z0-9]+/)) if (part.length >= 3 && low.includes(part)) return 'Password must not contain part of your email address';
  return null;
}

// ---- TOTP ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32encode = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
export const b32decode = (s) => { let bits = ''; for (const c of String(s).replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export const newTotpSecret = () => b32encode(randomBytes(20));
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32decode(secret)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
/** Accepts the current 30-second step and one either side. Returns the matched step, or null. */
export function totpMatch(secret, code, now = Date.now()) {
  code = String(code ?? '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) { const exp = totpAt(secret, cur + d); if (timingSafeEqual(Buffer.from(exp), Buffer.from(code))) return cur + d; }
  return null;
}
export const otpauthUrl = (email, secret) => `otpauth://totp/InvoiceGuard:${encodeURIComponent(email)}?secret=${secret}&issuer=InvoiceGuard&algorithm=SHA1&digits=6&period=30`;

export function migrateSecurity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mfa (user_id TEXT PRIMARY KEY, secret_enc TEXT, enabled INTEGER DEFAULT 0, last_step INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE IF NOT EXISTS pw_history (user_id TEXT, salt TEXT, hash TEXT, at TEXT);
  CREATE INDEX IF NOT EXISTS idx_pwh ON pw_history (user_id, at);`);
  try { db.exec('ALTER TABLE users ADD COLUMN pw_changed_at TEXT'); } catch { /* exists */ }
}

/** Remove buyer personal data (name, billing address) from shipment records older than PII_DAYS after shipment.
 *  Issued invoices are legal documents and are NOT touched here: see the open question in the security checklist. */
export function purgeBuyerData(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - PII_DAYS * 864e5).toISOString();
  const rows = db.prepare("SELECT seller_id, key, raw, status FROM shipments WHERE COALESCE(shipment_date, json_extract(raw, '$.orderDate')) IS NOT NULL AND COALESCE(shipment_date, json_extract(raw, '$.orderDate')) < ? AND (buyer IS NOT NULL AND buyer != '[removed]')").all(cutoff);
  const upd = db.prepare("UPDATE shipments SET buyer='[removed]', raw=?, status=?, reason=? WHERE seller_id=? AND key=?");
  let n = 0;
  for (const r of rows) {
    let s = {}; try { s = JSON.parse(r.raw); } catch { /* keep empty */ }
    delete s.billing; s.buyerCompany = '[removed]';
    const done = ['uploaded', 'submitted', 'ready'].includes(r.status);
    upd.run(JSON.stringify(s), done ? r.status : 'held', done ? null : 'Buyer personal data was removed 30 days after shipment, as Amazon requires, so this invoice can no longer be created here.', r.seller_id, r.key); n++;
  }
  db.prepare("DELETE FROM vat_checks WHERE checked_at < ? AND name IS NOT NULL").run(cutoff);
  return n;
}

// ---- Key rotation ----
// Stored secrets (Amazon credentials, two-step keys) are encrypted with a key derived from APP_SECRET.
// To rotate: set APP_SECRET_PREVIOUS to the old value, APP_SECRET to the new one, restart. At boot every stored secret
// that still opens with the old key is re-encrypted with the new one. Then remove APP_SECRET_PREVIOUS.
import { createHash } from 'node:crypto';
import { encrypt, decrypt } from './auth.js';
export function rotateKeys(db, secret, previous, log = console.log) {
  db.exec('CREATE TABLE IF NOT EXISTS secret_meta (k TEXT PRIMARY KEY, v TEXT)');
  const out = { rotated: 0, current: 0, failed: 0 };
  if (previous && previous !== secret) {
    for (const [table, key] of [['amazon_conn', 'seller_id'], ['mfa', 'user_id']]) {
      for (const r of db.prepare(`SELECT ${key} AS id, secret_enc FROM ${table} WHERE secret_enc IS NOT NULL`).all()) {
        let obj; try { obj = decrypt(r.secret_enc, secret); out.current++; continue; } catch { /* not under the new key */ }
        try { obj = decrypt(r.secret_enc, previous); } catch { out.failed++; continue; }
        db.prepare(`UPDATE ${table} SET secret_enc=? WHERE ${key}=?`).run(encrypt(obj, secret), r.id); out.rotated++;
      }
    }
    log(`key rotation: ${out.rotated} re-encrypted, ${out.current} already on the new key, ${out.failed} could not be opened with either key. Remove APP_SECRET_PREVIOUS now.`);
  }
  const fp = createHash('sha256').update('fp:' + secret).digest('hex').slice(0, 16), meta = db.prepare("SELECT v FROM secret_meta WHERE k='fp'").get();
  if (!meta || meta.v !== fp) { const now = new Date().toISOString(); db.prepare("INSERT INTO secret_meta VALUES ('fp',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(fp); db.prepare("INSERT INTO secret_meta VALUES ('since',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(now); }
  const since = db.prepare("SELECT v FROM secret_meta WHERE k='since'").get()?.v, days = Math.floor((Date.now() - Date.parse(since)) / 864e5);
  if (days >= 335) log(`key rotation due: the encryption key has been in use for ${days} days (Amazon asks for yearly rotation)`);
  return { ...out, keyAgeDays: days };
}

// ---- Security log (kept 13 months; Amazon asks for at least 12) ----
export const LOG_KEEP_DAYS = 395;
export function migrateSecLog(db) { db.exec('CREATE TABLE IF NOT EXISTS security_log (ts TEXT, type TEXT, user_id TEXT, who_hash TEXT, ip TEXT); CREATE INDEX IF NOT EXISTS idx_seclog_ts ON security_log (ts); CREATE TABLE IF NOT EXISTS contact_messages (id TEXT PRIMARY KEY, ts TEXT, email TEXT, message TEXT)'); }
export function logSec(db, req, type, userId = null, email = null) {
  try {
    const xf = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim(), ip = (xf || req?.socket?.remoteAddress || '').slice(0, 64);
    db.prepare('INSERT INTO security_log VALUES (?,?,?,?,?)').run(new Date().toISOString(), type, userId, email ? createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16) : null, ip);
  } catch (e) { console.error('security log failed', e.message); }
}
export const purgeSecLog = (db, now = new Date()) => db.prepare('DELETE FROM security_log WHERE ts < ?').run(new Date(now.getTime() - LOG_KEEP_DAYS * 864e5).toISOString()).changes;
