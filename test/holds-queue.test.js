// Expedition W2-2: the HOLD review queue and the documented decision, over the real HTTP app. Written to fail before src/holds.js existed (the routes did not exist).
import test from 'node:test'; import assert from 'node:assert/strict'; import { createApp } from '../src/app.js'; import { openCreditNoteHold } from '../src/cn-gate.js'; import { writeLedger } from '../src/integrity.js';
const validate = async (v) => ({ status: 'valid', vat: v });
async function client() { const { server, db } = createApp({ validate, secret: 'test' }); await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json() }; };
  return { server, db, call }; }
async function seller(c, email, nif) { await c.call('signup', { email, password: 'Long-Enough-Pw-42!' }); await c.call('seller', { name: 'Tienda Demo S.L.', nif, address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }); }
const sid = (db, email) => db.prepare('SELECT s.id FROM sellers s JOIN users u ON u.seller_id=s.id WHERE u.email=?').get(email)?.id ?? db.prepare('SELECT id FROM sellers ORDER BY rowid DESC LIMIT 1').get().id;
const SNAP = { documentNumbers: ['R-2026-999999'], statuses: ['CreditNoteUploaded'], reportRequestedAt: '2026-11-25T09:00:00.000Z', reportSeq: 3 };
const open = (db, sellerId, key = 'REFUND:CorrectionReversal:X:1') => openCreditNoteHold(db, sellerId, key, 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'The report names document R-2026-999999, not ours (R-2026-000001).' }], { number: 'R-2026-000001', snapshot: SNAP });
test('HQ1 an open credit-note hold is listed with what happened, why, evidence, known, unknown, allowed, blocked and next; no empty field and no "undefined"', async () => {
  const c = await client(); try { await seller(c, 'a@b.es', 'b11111111'); const id = sid(c.db, 'a@b.es'); open(c.db, id);
    const h = (await c.call('holds')).body.holds; assert.equal(h.length, 1); const x = h[0];
    for (const f of ['happened', 'why', 'next']) assert.ok(typeof x[f] === 'string' && x[f].length > 10, f); for (const f of ['known', 'unknown', 'allowed', 'blocked']) assert.ok(Array.isArray(x[f]) && x[f].length >= 1, f);
    assert.ok(x.known.some(k => /R-2026-999999/.test(k)), 'the report value is shown'); assert.ok(x.blocked.some(b => /replacement/i.test(b))); assert.equal(x.releasable, true); assert.doesNotMatch(JSON.stringify(x), /undefined|null,null/);
  } finally { c.server.close(); }
});
test('HQ2 a seller never sees another seller\'s holds', async () => {
  const a = await client(), b = await client(); try { await seller(a, 'a@b.es', 'b11111111'); open(a.db, sid(a.db, 'a@b.es')); await seller(b, 'c@d.es', 'b22222222'); assert.equal((await b.call('holds')).body.holds.length, 0); assert.equal((await a.call('holds')).body.holds.length, 1); } finally { a.server.close(); b.server.close(); }
});
test('HQ3 unauthenticated callers get 401 on both routes; GET on decide is refused', async () => {
  const c = await client(); try { assert.equal((await c.call('holds')).status, 401); assert.equal((await c.call('holds/decide', {})).status, 401); await seller(c, 'a@b.es', 'b11111111'); const r = await fetch(`http://127.0.0.1:${c.server.address().port}/api/holds/decide`, { headers: { cookie: 'x' } }); assert.ok([401, 405].includes(r.status)); } finally { c.server.close(); }
});
test('HQ4 the decision needs a reason of 10+ characters and the CURRENT fingerprint; a wrong one changes nothing', async () => {
  const c = await client(); try { await seller(c, 'a@b.es', 'b11111111'); const id = sid(c.db, 'a@b.es'); open(c.db, id); const x = (await c.call('holds')).body.holds[0]; const base = { key: x.key, code: x.code };
    assert.equal((await c.call('holds/decide', { ...base, fingerprint: x.fingerprint, reason: 'short' })).status, 422); assert.equal((await c.call('holds/decide', { ...base, fingerprint: 'deadbeef', reason: 'compared the report row with our credit note' })).status, 422);
    assert.equal((await c.call('holds')).body.holds.length, 1, 'still open'); assert.equal(c.db.prepare('SELECT count(*) n FROM integrity_decisions').get().n, 0);
  } finally { c.server.close(); }
});
test('HQ5 a valid decision records WHO decided, releases exactly that finding and lists it as closed', async () => {
  const c = await client(); try { await seller(c, 'a@b.es', 'b11111111'); const id = sid(c.db, 'a@b.es'); open(c.db, id); const x = (await c.call('holds')).body.holds[0];
    const r = await c.call('holds/decide', { key: x.key, code: x.code, fingerprint: x.fingerprint, reason: 'compared the report row with our credit note' }); assert.equal(r.status, 200);
    const d = c.db.prepare('SELECT decided_by, reason FROM integrity_decisions').get(); assert.equal(d.decided_by, 'a@b.es'); assert.equal((await c.call('holds')).body.holds.length, 0); assert.equal((await c.call('holds?all=1')).body.holds[0].status, 'RELEASED');
  } finally { c.server.close(); }
});
test('HQ6 a decision on old evidence cannot release a hold whose evidence changed (the API gives the same refusal as the ledger)', async () => {
  const c = await client(); try { await seller(c, 'a@b.es', 'b11111111'); const id = sid(c.db, 'a@b.es'); open(c.db, id); const old = (await c.call('holds')).body.holds[0];
    openCreditNoteHold(c.db, id, old.key, 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'x' }], { number: 'R-2026-000001', snapshot: { ...SNAP, documentNumbers: ['R-2026-555555'] } });
    assert.equal((await c.call('holds/decide', { key: old.key, code: old.code, fingerprint: old.fingerprint, reason: 'reusing the earlier decision here' })).status, 422); assert.equal((await c.call('holds')).body.holds.length, 1);
  } finally { c.server.close(); }
});
test('HQ7 a BLOCK finding is listed but offers no decision and the API refuses to release it', async () => {
  const c = await client(); try { await seller(c, 'a@b.es', 'b11111111'); const id = sid(c.db, 'a@b.es');
    writeLedger(c.db, id, 'SHIPMENT:B1', [{ code: 'TEST_BLOCK', severity: 'BLOCK', resolution: 'NEW_EVIDENCE', fingerprint: 'fp1', evidence: { field: 'f' }, explanation: 'The file contradicts itself.', action: 'Upload a corrected file.' }]);
    const x = (await c.call('holds')).body.holds[0]; assert.equal(x.releasable, false); assert.deepEqual(x.allowed, []); assert.equal((await c.call('holds/decide', { key: x.key, code: x.code, fingerprint: x.fingerprint, reason: 'I want this released anyway' })).status, 422);
  } finally { c.server.close(); }
});
