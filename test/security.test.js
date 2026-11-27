import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { passwordProblem, totpAt, totpMatch, newTotpSecret, purgeBuyerData } from '../src/security.js';
import { openDb } from '../src/db.js';

test('password rules: length, mixed case, number, symbol, not part of the email', () => {
  assert.match(passwordProblem('Short1!a', 'a@b.es'), /12/);
  assert.match(passwordProblem('alllowercase-123!', 'a@b.es'), /upper and lower/);
  assert.match(passwordProblem('NoNumbersHere-ok!', 'a@b.es'), /number/);
  assert.match(passwordProblem('NoSymbols1234Abc', 'a@b.es'), /symbol/);
  assert.match(passwordProblem('Janedoe-2026!x', 'jane.doe@x.com'), /email/);
  assert.equal(passwordProblem('Correct-Horse-42!', 'jane@x.com'), null);
});

test('TOTP matches the RFC 6238 test vector and rejects wrong, stale and malformed codes', () => {
  const sec = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII 12345678901234567890
  assert.equal(totpAt(sec, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(sec, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpMatch(sec, '287082', 59000), 1);
  assert.equal(totpMatch(sec, '287082', 59000 + 3 * 30000), null);
  assert.equal(totpMatch(sec, '12345', 59000), null); assert.equal(totpMatch(sec, 'abcdef', 59000), null);
  assert.equal(newTotpSecret().length, 32);
});

async function boot() {
  const { server, db } = createApp({ validate: async v => ({ status: 'valid', vat: v }), secret: 'test-secret' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json() }; };
  return { server, call, db, clear: () => { sid = ''; } };
}

test('two-step sign-in: setup, enable, required at login, no code reuse, disable', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 27, 12, 0, 10) }); // fixed clock mid-step: no 30 s boundary can fall inside this test (see security-clock.test.js)
  const { server, call, clear } = await boot(); const pw = 'Correct-Horse-42!';
  assert.equal((await call('signup', { email: 'm@x.es', password: pw })).status, 200);
  const su = await call('mfa/setup', {}); assert.equal(su.status, 200); assert.match(su.body.url, /^otpauth:\/\/totp\//);
  assert.equal((await call('mfa/enable', { code: '000000' })).status, 400);
  const now = () => Math.floor(Date.now() / 30000);
  assert.equal((await call('mfa/enable', { code: totpAt(su.body.secret, now()) })).status, 200);
  assert.equal((await call('me')).body.security.twoStep, true);
  clear(); let r = await call('login', { email: 'm@x.es', password: pw }); assert.equal(r.status, 401); assert.equal(r.body.mfa, true);
  r = await call('login', { email: 'm@x.es', password: pw, code: totpAt(su.body.secret, now()) }); assert.equal(r.status, 401, 'same code cannot be used twice');
  r = await call('login', { email: 'm@x.es', password: pw, code: totpAt(su.body.secret, now() + 1) }); assert.equal(r.status, 200);
  r = await call('mfa/disable', { password: pw, code: totpAt(su.body.secret, now() + 1) }); assert.equal(r.status, 401, 'disable needs a fresh code');
  r = await call('mfa/disable', { password: 'wrong', code: totpAt(su.body.secret, now() - 1) }); assert.equal(r.status, 401);
  server.close(); mock.timers.reset();
});

test('password change: needs current password, enforces rules and the last-10 history, ends other sessions', async () => {
  const { server, call, clear } = await boot(); const pw = 'Correct-Horse-42!';
  await call('signup', { email: 'p@x.es', password: pw });
  assert.equal((await call('password', { current: 'nope', next: 'Another-Horse-43!' })).status, 401);
  assert.equal((await call('password', { current: pw, next: 'weak' })).status, 400);
  assert.equal((await call('password', { current: pw, next: pw })).status, 400);
  assert.equal((await call('password', { current: pw, next: 'Another-Horse-43!' })).status, 200);
  assert.equal((await call('password', { current: 'Another-Horse-43!', next: pw })).status, 400, 'old password is in history');
  clear(); assert.equal((await call('login', { email: 'p@x.es', password: pw })).status, 401);
  assert.equal((await call('login', { email: 'p@x.es', password: 'Another-Horse-43!' })).status, 200);
  server.close();
});

test('account locks after 8 wrong attempts (Amazon allows at most 10)', async () => {
  const { server, call, clear } = await boot();
  await call('signup', { email: 'l@x.es', password: 'Correct-Horse-42!' }); clear(); let last;
  for (let i = 0; i < 8; i++) last = await call('login', { email: 'l@x.es', password: 'Wrong-Wrong-1!' + i });
  assert.equal(last.status, 401); assert.equal((await call('login', { email: 'l@x.es', password: 'Correct-Horse-42!' })).status, 429);
  server.close();
});

test('buyer personal data is removed 30 days after shipment; non-personal fields survive; unprocessed shipments are held with a reason', () => {
  const db = openDb(); const now = new Date('2026-03-01T00:00:00Z');
  const ins = db.prepare('INSERT INTO shipments (seller_id,key,order_id,shipping_id,buyer_vat,buyer,country,total,vat,shipment_date,status,raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const raw = JSON.stringify({ orderId: 'O1', shippingId: 'S1', marketplace: 'A1', billing: { name: 'Jane Doe', lines: ['Street 1'] }, buyerCompany: 'Jane Doe' });
  ins.run('s', 'old-done', 'O1', 'S1', null, 'Jane Doe', 'ES', 10, 2, '2026-01-01T00:00:00Z', 'uploaded', raw);
  ins.run('s', 'old-open', 'O2', 'S2', null, 'John Roe', 'ES', 10, 2, '2026-01-02T00:00:00Z', 'detected', raw);
  ins.run('s', 'recent', 'O3', 'S3', null, 'Keep Me', 'ES', 10, 2, '2026-02-20T00:00:00Z', 'detected', raw);
  assert.equal(purgeBuyerData(db, now), 2); assert.equal(purgeBuyerData(db, now), 0, 'idempotent');
  const g = k => db.prepare('SELECT * FROM shipments WHERE key=?').get(k);
  assert.equal(g('old-done').buyer, '[removed]'); assert.equal(g('old-done').status, 'uploaded');
  const s = JSON.parse(g('old-done').raw); assert.equal(s.billing, undefined); assert.equal(s.orderId, 'O1'); assert.equal(s.shippingId, 'S1');
  assert.equal(g('old-open').status, 'held'); assert.match(g('old-open').reason, /removed 30 days/);
  assert.equal(g('recent').buyer, 'Keep Me');
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM shipments WHERE key != 'recent'").all()), /Jane Doe|John Roe|Street 1/);
});

import { rotateKeys, logSec, purgeSecLog, migrateSecLog, migrateSecurity } from '../src/security.js';
import { encrypt, decrypt } from '../src/auth.js';
import { migrateAuth } from '../src/db.js';

test('key rotation re-encrypts stored secrets, is safe to repeat, and reports what it could not open', () => {
  const db = openDb(); migrateAuth(db); migrateSecurity(db); const logs = [];
  db.prepare("INSERT INTO amazon_conn (seller_id,mode,secret_enc) VALUES ('s1','live',?)").run(encrypt({ refreshToken: 'R1' }, 'old-key'));
  db.prepare("INSERT INTO amazon_conn (seller_id,mode,secret_enc) VALUES ('s2','demo',NULL)").run();
  db.prepare("INSERT INTO amazon_conn (seller_id,mode,secret_enc) VALUES ('s3','live',?)").run(encrypt({ refreshToken: 'R3' }, 'unrelated-key'));
  db.prepare("INSERT INTO mfa (user_id,secret_enc,enabled) VALUES ('u1',?,1)").run(encrypt('TOTPSECRET', 'old-key'));
  let r = rotateKeys(db, 'new-key', 'old-key', m => logs.push(m)); assert.deepEqual([r.rotated, r.failed], [2, 1]);
  assert.equal(decrypt(db.prepare("SELECT secret_enc FROM amazon_conn WHERE seller_id='s1'").get().secret_enc, 'new-key').refreshToken, 'R1');
  assert.equal(decrypt(db.prepare("SELECT secret_enc FROM mfa").get().secret_enc, 'new-key'), 'TOTPSECRET');
  assert.throws(() => decrypt(db.prepare("SELECT secret_enc FROM amazon_conn WHERE seller_id='s1'").get().secret_enc, 'old-key'));
  r = rotateKeys(db, 'new-key', 'old-key', m => logs.push(m)); assert.deepEqual([r.rotated, r.current], [0, 2]);
  assert.match(logs.join(' '), /1 could not be opened/);
  assert.equal(rotateKeys(db, 'new-key', undefined, () => {}).keyAgeDays, 0);
  db.prepare("UPDATE secret_meta SET v='2025-01-01T00:00:00Z' WHERE k='since'").run(); const l2 = []; rotateKeys(db, 'new-key', undefined, m => l2.push(m)); assert.match(l2.join(), /rotation due/);
});

test('security log records sign-in events without the email, and old entries are purged after 13 months', async () => {
  const { server, call, db, clear } = await boot();
  await call('signup', { email: 'log@x.es', password: 'Correct-Horse-42!' }); clear();
  await call('login', { email: 'log@x.es', password: 'Wrong-Wrong-1!' }); await call('login', { email: 'log@x.es', password: 'Correct-Horse-42!' });
  await call('password', { current: 'Correct-Horse-42!', next: 'Another-Horse-43!' });
  const types = db.prepare('SELECT type FROM security_log ORDER BY rowid').all().map(r => r.type); assert.deepEqual(types, ['signup', 'login_failed', 'login_ok', 'password_changed']);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM security_log').all()), /log@x\.es|Correct-Horse/);
  db.prepare("INSERT INTO security_log VALUES ('2024-01-01T00:00:00Z','login_ok','u',NULL,'1.1.1.1')").run();
  assert.equal(purgeSecLog(db), 1); assert.equal(db.prepare('SELECT count(*) n FROM security_log').get().n, 4);
  server.close();
});
