// P3 adversarial tests of the encrypted vault. Synthetic data only. Real Web Crypto (Node's global crypto.subtle), no mocks of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, VaultLocked, VaultError, recoveryToText, recoveryFromText, META_KEY } from '../src/loop/vault.js';
import { memoryAdapter } from '../src/history.js';

const ITER = 1000; // test speed only; the shipped default is 600000 (asserted below)
const PW = 'correct horse battery', SECRET = { text: 'A-1001;Amazon.es;DE811128135;121,00', vat: 'DE811128135' };
const mk = (raw = memoryAdapter(), o = {}) => ({ raw, v: createVault(raw, { iterations: ITER, ...o }) });
const dump = async (raw) => JSON.stringify(await Promise.all((await raw.list()).map(async k => [k, await raw.get(k)])));

test('vault: the shipped key-derivation cost is 600000 PBKDF2-SHA256 iterations and the metadata names the algorithm', async () => {
  const { KDF_ITERATIONS } = await import('../src/loop/vault.js'); assert.equal(KDF_ITERATIONS, 600000);
  const { v, raw } = mk(); await v.create(PW); const m = await raw.get(META_KEY); assert.equal(m.kdf.alg, 'PBKDF2-HMAC-SHA256'); assert.equal(m.v, 1);
});
test('1: a wrong password cannot unlock; the right one can; a wrong guess leaves the vault locked', async () => {
  const { v, raw } = mk(); await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); v.lock();
  await assert.rejects(() => v.unlock('wrong password!!'), (e) => e.code === 'WRONG_PASSWORD'); assert.equal(v.unlocked, false);
  const v2 = createVault(raw, { iterations: ITER }); await v2.unlock(PW); assert.deepEqual(await v2.adapter.get('loop:import:i1'), SECRET);
});
test('2: a modified ciphertext, a modified IV and a truncated record are all rejected, never returned as data', async () => {
  const { v, raw } = mk(); await v.create(PW); await v.adapter.put('loop:import:i1', SECRET);
  const sk = (await raw.list()).find(k => k.startsWith('e1:')), env = await raw.get(sk);
  const flip = (b64) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); u[0] ^= 1; return btoa(String.fromCharCode(...u)); };
  for (const bad of [{ ...env, ct: flip(env.ct) }, { ...env, iv: flip(env.iv) }, { ...env, ct: env.ct.slice(0, -8) }, { e: 1 }, { ...env, e: 2 }]) {
    await raw.put(sk, bad); v.lock(); await v.unlock(PW);
    await assert.rejects(() => v.adapter.get('loop:import:i1'), (e) => e.code === 'CORRUPT', 'rejected'); await assert.rejects(() => v.adapter.list(), (e) => e.code === 'CORRUPT', 'a damaged record is reported, not silently skipped');
  }
});
test('3: a record moved to another key or another vault is detected (identity and context binding)', async () => {
  const { v, raw } = mk(); await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); await v.adapter.put('loop:import:i2', { other: 1 });
  const keys = (await raw.list()).filter(k => k.startsWith('e1:')); const [a, b] = await Promise.all(keys.map(async k => [k, await raw.get(k)]));
  await raw.put(a[0], b[1]); // the other record's envelope under this record's key
  v.lock(); await v.unlock(PW); await assert.rejects(() => v.adapter.list(), (e) => e.code === 'CORRUPT');
  await raw.put(a[0], a[1]); v.lock(); await v.unlock(PW); assert.equal((await v.adapter.list()).length, 2);
  const o = mk(); await o.v.create(PW); const sk = a[0]; await o.raw.put(sk, a[1]); // the same envelope in another vault with the same password
  await assert.rejects(() => o.v.adapter.list(), (e) => e.code === 'CORRUPT', 'another vault id');
});
test('4: every write uses a fresh random 96-bit IV: 2000 writes of the same value give 2000 different IVs and ciphertexts', async () => {
  const { v, raw } = mk(); await v.create(PW); const ivs = new Set(), cts = new Set();
  for (let i = 0; i < 2000; i++) { await v.adapter.put('loop:event:e1', SECRET); const env = await raw.get((await raw.list()).find(k => k.startsWith('e1:'))); ivs.add(env.iv); cts.add(env.ct); assert.equal(atob(env.iv).length, 12); }
  assert.equal(ivs.size, 2000); assert.equal(cts.size, 2000);
});
test('5: a locked vault exposes nothing: every read and write throws VaultLocked, also after manual lock and after the inactivity timer', async () => {
  const { v } = mk(); await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); v.lock();
  for (const f of [() => v.adapter.get('loop:import:i1'), () => v.adapter.put('loop:import:i1', 1), () => v.adapter.list(), () => v.adapter.del('loop:import:i1'), () => v.exportBackup(), () => v.adapter.clear()]) await assert.rejects(f, VaultLocked);
  let fire; const t = mk(memoryAdapter(), { setTimer: (f) => { fire = f; return 1; }, clearTimer: () => {} }); await t.v.create(PW); t.v.setAutoLock(60000); await t.v.adapter.put('loop:import:i1', SECRET);
  assert.ok(fire, 'timer armed'); fire(); assert.equal(t.v.unlocked, false); await assert.rejects(() => t.v.adapter.get('loop:import:i1'), VaultLocked);
});
test('6: no sensitive plaintext is in the persisted storage: not the values, not the ids, not the password, not the master secret', async () => {
  const { v, raw } = mk(); await v.create(PW); await v.adapter.put('loop:import:imp-20261120-a1b2c3-0', { text: SECRET.text, sha256: 'a1b2c3deadbeef', declared: { sourceSystem: 'acme-books' } }); await v.adapter.put('loop:event:ev-1', { reasoning: 'checked the account', author: 'Test seller' });
  const all = await dump(raw); for (const s of ['A-1001', 'DE811128135', 'Amazon.es', 'acme-books', 'a1b2c3', 'imp-2026', 'checked the account', 'Test seller', PW]) assert.ok(!all.includes(s), 'persisted storage must not contain: ' + s);
  for (const k of (await raw.list()).filter(k => k.startsWith('e1:'))) assert.match(k, /^e1:loop:(import|event):[A-Za-z0-9_-]{43}$/, 'only the record kind is visible in a storage key');
  const m = await raw.get(META_KEY); assert.deepEqual(Object.keys(m).sort(), ['createdAt', 'kdf', 'pw', 'rec', 'v', 'vaultId']);
});
test('7: the recovery key opens the vault without the password; a wrong or malformed one does not; no escrow exists', async () => {
  const { v, raw } = mk(); const { recoveryKey } = await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); v.lock();
  assert.match(recoveryKey, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/); assert.equal(recoveryFromText(recoveryToText(recoveryFromText(recoveryKey))).length, 32);
  await assert.rejects(() => v.unlockWithRecoveryKey(recoveryToText(new Uint8Array(32))), (e) => e.code === 'WRONG_RECOVERY'); await assert.rejects(() => v.unlockWithRecoveryKey('nonsense!'), (e) => e.code === 'BAD_RECOVERY');
  await v.unlockWithRecoveryKey(recoveryKey.toLowerCase()); assert.deepEqual(await v.adapter.get('loop:import:i1'), SECRET);
  assert.ok(!(await dump(raw)).includes(recoveryKey.slice(0, 9)), 'the recovery key is not stored');
});
test('8: change of password re-wraps only the key: old password stops, new one works, data and recovery key unchanged', async () => {
  const { v, raw } = mk(); const { recoveryKey } = await v.create(PW); await v.adapter.put('loop:import:i1', SECRET);
  const before = await dump(raw).then(d => JSON.parse(d).filter(([k]) => k.startsWith('e1:'))); await assert.rejects(() => v.changePassword('nope nope nope', 'new password 123'), (e) => e.code === 'WRONG_PASSWORD'); await v.changePassword(PW, 'new password 123'); v.lock();
  await assert.rejects(() => v.unlock(PW)); await v.unlock('new password 123'); assert.deepEqual(await v.adapter.get('loop:import:i1'), SECRET); v.lock(); await v.unlockWithRecoveryKey(recoveryKey);
  assert.equal(JSON.stringify(before), JSON.stringify(JSON.parse(await dump(raw)).filter(([k]) => k.startsWith('e1:'))), 'records were not rewritten');
});
test('9: weak passwords are refused and a second vault cannot be created over the first', async () => {
  const { v } = mk(); await assert.rejects(() => v.create('short'), (e) => e.code === 'WEAK_PASSWORD'); await v.create(PW); await assert.rejects(() => v.create(PW), (e) => e.code === 'EXISTS');
});
test('10: backup is encrypted, restores into an empty workspace after validation, and every tampering or wrong password is refused', async () => {
  const a = mk(); await a.v.create(PW); for (let i = 0; i < 5; i++) await a.v.adapter.put('loop:import:i' + i, { n: i, ...SECRET }); const bk = await a.v.exportBackup(); const text = JSON.stringify(bk);
  for (const s of ['A-1001', 'DE811128135', PW]) assert.ok(!text.includes(s)); assert.equal(bk.count, 5);
  const b = mk(); await b.v.restoreBackup(JSON.parse(text), PW); await b.v.unlock(PW); assert.deepEqual((await b.v.adapter.list()).sort(), [0, 1, 2, 3, 4].map(i => 'loop:import:i' + i)); assert.equal((await b.v.adapter.get('loop:import:i3')).n, 3);
  const c = mk(); await assert.rejects(() => c.v.restoreBackup(JSON.parse(text), 'wrong password!!'), (e) => e.code === 'WRONG_PASSWORD'); assert.equal(await c.raw.get(META_KEY), null, 'a refused restore writes nothing');
  const cut = JSON.parse(text); cut.records.pop(); await assert.rejects(() => mk().v.restoreBackup(cut, PW), (e) => e.code === 'CORRUPT');
  const cut2 = JSON.parse(text); cut2.records.pop(); cut2.count = 4; await assert.rejects(() => mk().v.restoreBackup(cut2, PW), (e) => e.code === 'CORRUPT', 'a record removed and the count adjusted: the manifest MAC catches it');
  const flip = JSON.parse(text); flip.records[2].env.ct = flip.records[2].env.ct.replace(/^./, (ch) => ch === 'A' ? 'B' : 'A'); await assert.rejects(() => mk().v.restoreBackup(flip, PW), (e) => e.code === 'CORRUPT');
  await assert.rejects(() => b.v.restoreBackup(JSON.parse(text), PW), (e) => e.code === 'BUSY' || e.code === 'NOT_EMPTY'); b.v.lock(); await assert.rejects(() => b.v.restoreBackup(JSON.parse(text), PW), (e) => e.code === 'NOT_EMPTY', 'never overwrites silently');
  await assert.rejects(() => mk().v.restoreBackup({ nope: 1 }, PW), (e) => e.code === 'BAD_BACKUP');
});
test('11: whole-workspace deletion leaves nothing that opens: no metadata, no records, the old password and recovery key are useless', async () => {
  const { v, raw } = mk(); const { recoveryKey } = await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); const keep = await raw.get(META_KEY); await v.adapter.clear();
  assert.deepEqual(await raw.list(), []); assert.equal(v.unlocked, false); const v2 = createVault(raw, { iterations: ITER }); await assert.rejects(() => v2.unlock(PW), (e) => e.code === 'NO_VAULT'); await assert.rejects(() => v2.unlockWithRecoveryKey(recoveryKey), (e) => e.code === 'NO_VAULT'); void keep;
});
test('12: a storage failure on write surfaces as an error, never as silent success, and earlier records stay readable', async () => {
  const raw = memoryAdapter(); let fail = false; const flaky = { ...raw, put: async (k, v) => { if (fail && k.startsWith('e1:')) throw new Error('QuotaExceededError'); return raw.put(k, v); } };
  const v = createVault(flaky, { iterations: ITER }); await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); fail = true;
  await assert.rejects(() => v.adapter.put('loop:import:i2', { big: 1 }), /QuotaExceeded/); fail = false; assert.deepEqual(await v.adapter.get('loop:import:i1'), SECRET); assert.equal(await v.adapter.get('loop:import:i2'), null);
});
test('13: errors and messages never contain seller values or secrets', async () => {
  const { v, raw } = mk(); await v.create(PW); await v.adapter.put('loop:import:i1', SECRET); const sk = (await raw.list()).find(k => k.startsWith('e1:')); const env = await raw.get(sk); await raw.put(sk, { ...env, ct: env.ct.slice(0, -4) + 'AAAA' }); v.lock(); await v.unlock(PW);
  const msgs = []; for (const f of [() => v.adapter.get('loop:import:i1'), () => v.unlock('bad bad bad bad'), () => v.unlockWithRecoveryKey('AAAA')]) try { await f(); } catch (e) { msgs.push(String(e.message) + ' ' + String(e.stack).split('\n')[0]); }
  for (const m of msgs) for (const s of ['A-1001', 'DE811128135', PW, 'loop:import', 'i1']) assert.ok(!m.includes(s), m);
});
