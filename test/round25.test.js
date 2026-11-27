import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb, appendAudit } from '../src/db.js';
import { backupNow } from '../src/backup.js';
import { validateSnapshot, stageRestore, applyPendingRestore } from '../src/restore.js';

const validate = async (v) => ({ status: 'valid', vat: v });
const PW = 'Long-Enough-Pw-42!', PW2 = 'Another-Strong-Pw-77?';
async function boot(opts = {}) {
  const { server, db } = createApp({ validate, secret: 'test', ...opts }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let sid = ''; return async (path, body) => { const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json().catch(() => ({})) }; }; };
  return { server, db, mk, base };
}

test('recovery codes: signup issues 8, one works once, password resets, sessions end, wrong codes are throttled', async () => {
  const { server, db, mk } = await boot(); const a = mk(), b = mk();
  const s = await a('/api/signup', { email: 'r@x.es', password: PW }); assert.equal(s.status, 200);
  const codes = s.body.recoveryCodes; assert.equal(codes.length, 8); assert.match(codes[0], /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM recovery_codes').all()).includes(codes[0]), false, 'codes are stored hashed');
  assert.equal((await a('/api/me')).body.security.recoveryLeft, 8);
  // wrong code and unknown email give the same answer
  const w1 = await b('/api/recover', { email: 'r@x.es', code: 'aaaa-bbbb-cccc', next: PW2 }), w2 = await b('/api/recover', { email: 'nobody@x.es', code: codes[0], next: PW2 });
  assert.equal(w1.status, 401); assert.equal(w2.status, 401); assert.equal(w1.body.error, w2.body.error);
  // weak new password does not burn the code
  assert.equal((await b('/api/recover', { email: 'r@x.es', code: codes[0], next: 'weak' })).status, 400);
  assert.equal((await b('/api/recover', { email: 'r@x.es', code: codes[0].toUpperCase().replaceAll('-', ' '), next: PW2 })).status, 200, 'case and separators do not matter');
  assert.equal((await a('/api/me')).status, 401, 'old session ended');
  assert.equal((await b('/api/login', { email: 'r@x.es', password: PW })).status, 401);
  assert.equal((await b('/api/login', { email: 'r@x.es', password: PW2 })).status, 200);
  assert.equal((await mk()('/api/recover', { email: 'r@x.es', code: codes[0], next: 'Third-Strong-Pw-91!' })).status, 401, 'a used code is dead');
  assert.equal((await b('/api/me')).body.security.recoveryLeft, 7);
  // a recovery code cannot be used to guess its way in: 5 wrong tries from one address+email lock it, even for a good code
  const c = mk(); for (let i = 0; i < 5; i++) await c('/api/recover', { email: 'r@x.es', code: 'zzzz-zzzz-zzz' + i, next: PW2 });
  assert.equal((await c('/api/recover', { email: 'r@x.es', code: codes[1], next: 'Third-Strong-Pw-91!' })).status, 429);
  server.closeAllConnections(); server.close();
});

test('recovery codes: new set needs the password and cancels the old set; two-step sign-in stays on after a reset', async () => {
  const { server, db, mk } = await boot(); const a = mk();
  const old = (await a('/api/signup', { email: 'n@x.es', password: PW })).body.recoveryCodes;
  assert.equal((await a('/api/recovery/new', { password: 'wrong' })).status, 401);
  const fresh = (await a('/api/recovery/new', { password: PW })).body.recoveryCodes; assert.equal(fresh.length, 8);
  assert.equal((await mk()('/api/recover', { email: 'n@x.es', code: old[0], next: PW2 })).status, 401);
  const uid = db.prepare('SELECT id FROM users WHERE email=?').get('n@x.es').id;
  db.prepare('INSERT INTO mfa (user_id,secret_enc,enabled,last_step,created_at) VALUES (?,?,1,0,?)').run(uid, 'x', 'now');
  const r = await mk()('/api/recover', { email: 'n@x.es', code: fresh[0], next: PW2 }); assert.equal(r.status, 200); assert.equal(r.body.twoStep, true);
  assert.equal((await mk()('/api/login', { email: 'n@x.es', password: PW2 })).body.mfa, true, 'login still asks for the authenticator code');
  server.closeAllConnections(); server.close();
});

test('restore drill: backup -> validate -> stage -> apply at boot; data and audit chain survive; bad files are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-rst-')), live = join(dir, 'live.db');
  { const { server, db, mk } = await boot({ db: openDb(live) }); const a = mk();
    await a('/api/signup', { email: 'd@x.es', password: PW }); await a('/api/seller', { name: 'Demo SL', nif: 'B11111111', address: 'Calle 1', marketplaces: ['ES'] });
    server.closeAllConnections(); server.close(); db.close(); }
  const bk = backupNow(live, join(dir, 'backups')); assert.equal(bk.ok, true);
  const v = validateSnapshot(bk.dest); assert.equal(v.ok, true); assert.equal(v.counts.users, 1);
  // disaster: the live database is damaged afterwards
  { const d = openDb(live); d.exec("DELETE FROM users"); d.close(); }
  // garbage and a doctored audit chain are refused, nothing is staged
  assert.equal(stageRestore(Buffer.from('not a database at all'), live).ok, false);
  const tampered = join(dir, 'tampered.db'); writeFileSync(tampered, readFileSync(bk.dest));
  { const d = openDb(tampered); const sid = d.prepare('SELECT id FROM sellers LIMIT 1').get().id; appendAudit(d, sid, 'x', 'ref1', {}); appendAudit(d, sid, 'y', 'ref2', {}); d.exec("UPDATE audit SET doc_hash='forged' WHERE seq=(SELECT min(seq) FROM audit)"); d.close(); }
  const t = stageRestore(readFileSync(tampered), live); assert.equal(t.ok, false); assert.match(t.reason, /audit chain/);
  assert.equal(existsSync(live + '.restore-pending'), false);
  // the good snapshot stages, then applies at the next boot
  const st = stageRestore(readFileSync(bk.dest), live); assert.equal(st.ok, true); assert.equal(existsSync(live + '.restore-pending'), true);
  const ap = applyPendingRestore(live, () => {}); assert.equal(ap.applied, true);
  assert.equal(existsSync(live + '.restore-pending'), false);
  assert.ok(readdirSync(join(dir, 'backups')).some(f => f.startsWith('pre-restore-')), 'the damaged database is kept');
  // and the restored database really serves the account: sign in over HTTP
  const { server, mk } = await boot({ db: openDb(live) });
  assert.equal((await mk()('/api/login', { email: 'd@x.es', password: PW })).status, 200);
  server.closeAllConnections(); server.close();
  assert.equal(applyPendingRestore(live, () => {}).applied, false, 'nothing pending, nothing happens');
}, { timeout: 60000 });

test('/admin/db-restore is invisible without the operator token and stages only valid snapshots', async () => {
  process.env.ADMIN_TOKEN = 'a'.repeat(32); const dir = mkdtempSync(join(tmpdir(), 'ig-adm-')); process.env.DB_FILE = join(dir, 'p.db');
  try {
    const { server, base } = await boot();
    assert.equal((await fetch(base + '/admin/db-restore', { method: 'POST', body: 'x' })).status, 404);
    const bad = await fetch(base + '/admin/db-restore', { method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(32) }, body: 'junk' }); assert.equal(bad.status, 422);
    assert.equal(existsSync(process.env.DB_FILE + '.restore-pending'), false);
    server.closeAllConnections(); server.close();
  } finally { delete process.env.ADMIN_TOKEN; delete process.env.DB_FILE; }
});

test('no SQL string in src uses double-quoted string literals (Node 22.23 treats them as column names and the scheduler crashed production)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const bad = [];
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter(x => x.endsWith('.js'))) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:prepare|exec)\(\s*(['`])((?:(?!\1)[^\\]|\\.)*)\1/g)) if (/(?:=|!=|<>|\bIN\b|\bLIKE\b)\s*\(?\s*"[A-Za-z_ ]+"/i.test(m[2])) bad.push(f + ': ' + m[2].slice(0, 80));
  }
  assert.deepEqual(bad, []);
});
