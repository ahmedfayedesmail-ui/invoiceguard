// swarm-security: black-box tenant-isolation attack tests. Synthetic data only, in-memory DB, mock Amazon (demo mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const validate = async (v) => ({ status: 'valid', vat: v });
async function boot() {
  const { server, db } = createApp({ validate, secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => { let sid = ''; const call = async (path, body, { raw = false, headers = {} } = {}) => {
    const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(sid ? { cookie: sid } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c && /^sid=[^;]/.test(c)) sid = c.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString()); } catch { /* not json */ }
    return { status: r.status, body: j, buf, headers: r.headers, text: buf.toString('utf8') }; };
    return { call, get sid() { return sid; }, set sid(v) { sid = v; } }; };
  return { server, db, base, client };
}
async function seller(c, email, name, nif) {
  assert.equal((await c.call('signup', { email, password: 'Long-Enough-Pw-42!x' })).status, 200);
  await c.call('seller', { name, nif, address: 'Calle Falsa 1, Madrid', marketplaces: ['ES', 'DE'] });
  await c.call('amazon/connect', { demo: true }); await c.call('sync', {});
}

test('tenant isolation: seller B cannot read or mutate seller A through any seller-scoped route', async () => {
  const { server, db, client } = await boot();
  const A = client(), B = client();
  await seller(A, 'alice@example.test', 'ALICE-SECRET-NAME SL', 'B11111111');
  await seller(B, 'bob@example.test', 'Bob Tienda SL', 'B22222222');
  const da = (await A.call('dashboard')).body, db_ = (await B.call('dashboard')).body;
  const aNums = da.invoices.map(i => i.number), aKeys = da.shipments.map(s => s.key);
  assert.ok(aNums.length > 0);
  // numbers are per-seller counters: B holds the same numbers. B reading "A's number" must return B's own document only.
  for (const n of aNums) {
    const r = await B.call(`invoices/${n}/json`);
    if (r.status === 200) { assert.ok(db_.invoices.some(i => i.number === n), 'B received a number it does not own'); assert.ok(!JSON.stringify(r.body).includes('ALICE-SECRET-NAME'), 'LEAK: seller A name in B response'); }
  }
  // a number only A has
  const onlyA = (await A.call('rectify', { number: aNums[0], mode: 'substitution', reason: 'tenant test', buyerName: 'Changed Name SL' })).body?.number;
  assert.ok(onlyA, 'A rectificativa created'); const da2 = (await A.call('dashboard')).body;
  const rOnlyA = da2.invoices.map(i => i.number).filter(n => !db_.invoices.some(i => i.number === n));
  assert.ok(rOnlyA.length >= 1);
  for (const n of rOnlyA) {
    for (const suffix of ['json', 'pdf', 'trail', 'checks']) assert.equal((await B.call(`invoices/${n}/${suffix}`)).status, 404, `IDOR on ${suffix}`);
    assert.equal((await B.call('rectify', { number: n, mode: 'substitution', reason: 'x', buyerName: 'Evil' })).status, 404);
    const rej = await B.call('invoices/reject', { number: n, error: 'evil' }); assert.equal(rej.status, 404);
    const mk = await B.call('invoices/mark', { numbers: [n] }); assert.equal(mk.body.marked, 0);
  }
  // A's invoice state unchanged
  const after = (await A.call('dashboard')).body; assert.deepEqual(after.invoices.map(i => [i.number, i.upload_status]), da2.invoices.map(i => [i.number, i.upload_status]));
  // shipment keys: release / retry / holds / repairs from B with A's keys must not change A rows
  const snap = JSON.stringify(db.prepare('SELECT * FROM shipments WHERE seller_id=? ORDER BY key').all(da.seller ? db.prepare('SELECT id FROM sellers WHERE nif=?').get('B11111111').id : ''));
  const aId = db.prepare('SELECT id FROM sellers WHERE nif=?').get('B11111111').id;
  for (const k of aKeys) { await B.call('release', { key: k }); await B.call('retry', { key: k }); await B.call('repairs/approve', { key: k }); await B.call('repairs/dismiss', { key: k }); await B.call('repairs/authorize-retry', { key: k, checkedBy: 'bob' }); await B.call('holds/decide', { key: k, code: 'X', fingerprint: 'f', reason: 'a long enough reason' }); await B.call('holds/note', { key: k, code: 'X', note: 'abc' }); }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM shipments WHERE seller_id=? ORDER BY key').all(aId)), snap, 'A shipments mutated by B');
  // exports contain only B's data
  const ex = await B.call('export.zip', { from: '2000-01-01', to: '2100-01-01' }); assert.equal(ex.status, 200); assert.ok(!ex.buf.toString('latin1').includes('ALICE-SECRET-NAME'));
  const csv = await B.call('export.csv'); assert.ok(!csv.text.includes('ALICE-SECRET-NAME'));
  const pk = await B.call('pack'); assert.ok(pk.status === 404 || !pk.buf.toString('latin1').includes('ALICE-SECRET-NAME'));
  for (const p of ['dashboard', 'radar', 'holds', 'repairs', 'watch', 'explainer', 'me']) assert.ok(!(await B.call(p)).text.includes('ALICE-SECRET-NAME') && !(await B.call(p)).text.includes('alice@example.test'), `leak via ${p}`);
  server.close();
});

test('auth: every seller route refuses unauthenticated and forged cookies; admin routes 404 without token', async () => {
  const { server, client, base } = await boot(); const N = client();
  const routes = ['dashboard', 'export.csv', 'pack', 'holds', 'repairs', 'radar', 'sync', 'me', 'rules', 'holds/decide', 'invoices/mark', 'rectify', 'release', 'export/external', 'amazon/connect', 'seller'];
  for (const r of routes) { assert.equal((await N.call(r, r === 'dashboard' || r === 'me' ? undefined : {})).status, 401, r); }
  N.sid = 'sid=' + 'a'.repeat(64); assert.equal((await N.call('dashboard')).status, 401);
  N.sid = "sid=' OR 1=1 --"; assert.equal((await N.call('dashboard')).status, 401);
  for (const p of ['/admin/messages', '/admin/counters', '/admin/db-snapshot', '/admin/weekly-summary', '/admin/ingest-health']) { assert.equal((await fetch(base + p)).status, 404); assert.equal((await fetch(base + p, { headers: { authorization: 'Bearer ' } })).status, 404); }
  server.close();
});

test('cross-origin POST is refused; export.zip date params cannot inject headers', async () => {
  const { server, client, base } = await boot(); const A = client(); await seller(A, 'carol@example.test', 'Carol SL', 'B33333333');
  const r = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: A.sid }, body: '{"invoiceLang":"es"}' }); assert.equal(r.status, 403);
  const z = await A.call('export.zip', { from: '2026-01-01\r\nX-Injected: 1', to: '2026-12-31' }); assert.equal(z.status, 400); assert.equal(z.headers.get('x-injected'), null);
  server.close();
});

test('error bodies do not leak stack traces, SQL or file paths', async () => {
  const { server, client } = await boot(); const A = client(); await seller(A, 'dave@example.test', 'Dave SL', 'B44444444');
  const probes = [['rectify', { number: { toString() { return 1; } } }], ['rectify', { number: "R-1'; DROP TABLE invoices;--" }], ['export/external', { name: '../../etc/passwd', date: '2026-01-01', pdfBase64: Buffer.from('%PDF-1.4 x').toString('base64') }], ['holds/decide', { key: 1, code: 2, fingerprint: 3 }], ['invoices/mark', { numbers: [{}, [], null] }], ['watch/add', { vat: { a: 1 } }], ['rules/review', { rule: 'x' }], ['buyer/message', { orderId: 'x'.repeat(10), country: { a: 1 } }], ['b2c', { key: { a: 1 } }]];
  for (const [p, b] of probes) { const r = await A.call(p, b); assert.ok(r.status < 600); assert.ok(!/\bat .*\.js:\d+|node:sqlite|SQLITE|\/home\/|\/tmp\/|node_modules/.test(r.text), `${p} leaked internals: ${r.text.slice(0, 200)}`); }
  server.close();
});

test('CSV exports neutralise formula-leading buyer text but keep negative amounts numeric', async () => {
  const { server, client } = await boot(); const A = client(); await seller(A, 'erin@example.test', 'Erin SL', 'B55555555');
  const n = (await A.call('dashboard')).body.invoices[0].number;
  const r = await A.call('rectify', { number: n, mode: 'substitution', reason: 'csv test', buyerName: '=HYPERLINK("http://evil.invalid/","x")' }); assert.equal(r.status, 200);
  const zip = (await A.call('export.zip', { from: '2000-01-01', to: '2100-01-01' })).buf;
  // stored (method 0) or deflated entries: locate invoices.csv by inflating every local entry
  const { inflateRawSync } = await import('node:zlib'); let off = 0, csv = null;
  while (zip.readUInt32LE(off) === 0x04034b50) { const m = zip.readUInt16LE(off + 8), cs = zip.readUInt32LE(off + 18), nl = zip.readUInt16LE(off + 26), el = zip.readUInt16LE(off + 28), name = zip.subarray(off + 30, off + 30 + nl).toString(), data = zip.subarray(off + 30 + nl + el, off + 30 + nl + el + cs); if (name === 'invoices.csv') csv = (m === 8 ? inflateRawSync(data) : data).toString(); off += 30 + nl + el + cs; }
  assert.ok(csv, 'invoices.csv found'); assert.ok(!/,"=HYPERLINK/.test(csv), 'formula cell not neutralised'); assert.match(csv, /"'=HYPERLINK/);
  server.close();
});
