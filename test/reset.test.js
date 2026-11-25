import test from 'node:test'; import assert from 'node:assert/strict';
import { openDb, migrateAuth } from '../src/db.js'; import { hashPw, checkPwAsync } from '../src/auth.js'; import { applyBootReset } from '../src/reset.js';
const mk = (db) => { migrateAuth(db); const { salt, hash } = hashPw('old-password-123'); db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('u1', 'a@b.cc', salt, hash, null, 'x'); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('tok', 'u1', Date.now() + 1e6); };
test('boot reset: applies once, ends sessions, never overwrites a later change', async () => {
  const db = openDb(); mk(db); const logs = []; const env = { RESET_EMAIL: 'A@b.cc ', RESET_PASSWORD: 'brand-new-password' };
  assert.equal(applyBootReset(db, env, m => logs.push(m)).done, true);
  let u = db.prepare('SELECT * FROM users WHERE id=?').get('u1'); assert.equal(await checkPwAsync('brand-new-password', u.salt, u.hash), true);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 0);
  const { salt, hash } = hashPw('changed-by-owner-1'); db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hash, 'u1');
  assert.equal(applyBootReset(db, env, m => logs.push(m)).done, false); u = db.prepare('SELECT * FROM users WHERE id=?').get('u1');
  assert.equal(await checkPwAsync('changed-by-owner-1', u.salt, u.hash), true);
  assert.ok(!logs.join('').includes('brand-new-password'));
});
test('boot reset: no-op when unset, rejects short password and unknown account', () => {
  const db = openDb(); mk(db); const l = () => {};
  assert.equal(applyBootReset(db, {}, l).done, false); assert.equal(applyBootReset(db, { RESET_EMAIL: 'a@b.cc', RESET_PASSWORD: 'short' }, l).why, 'invalid');
  assert.equal(applyBootReset(db, { RESET_EMAIL: 'z@b.cc', RESET_PASSWORD: 'long-enough-pass' }, l).why, 'no account');
});
