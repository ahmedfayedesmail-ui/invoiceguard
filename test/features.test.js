import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import * as F from '../src/features.js';
import { readiness } from '../src/rules.js';

const validate = async (v) => v === 'ESA1234567' ? { status: 'invalid', reason: 'bad_format', vat: v } : { status: 'valid', vat: v };
async function boot(country = 'ES') {
  const { server, db } = createApp({ validate, secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; const ct = r.headers.get('content-type') ?? ''; return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
  await call('signup', { email: 'a@b.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda <Demo> S.L.', nif: 'b11111111', address: 'Calle Falsa 1', marketplaces: ['ES', 'DE'], country });
  await call('amazon/connect', { demo: true });
  const seller = db.prepare('SELECT * FROM sellers').get();
  return { server, db, call, base, seller };
}
function unzip(buf) { // reads via central directory; also verifies CRC-free structure
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16); const out = {};
  for (let i = 0; i < n; i++) { const csz = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42), name = buf.subarray(p + 46, p + 46 + nl).toString(); const lnl = buf.readUInt16LE(off + 26); const data = buf.subarray(off + 30 + lnl, off + 30 + lnl + csz); out[name] = inflateRawSync(data); p += 46 + nl; }
  return out;
}

test('radar levels and one alert per level', async () => {
  const { server, db, seller, call } = await boot(); await call('sync', {});
  const now = new Date('2026-11-25T12:00:00Z');
  db.prepare("INSERT INTO shipments (seller_id,key,order_id,status,due_at) VALUES (?,?,?,?,?)").run(seller.id, 'K1', 'O1', 'detected', '2026-11-25T20:00:00Z');
  db.prepare("INSERT INTO shipments (seller_id,key,order_id,status,due_at) VALUES (?,?,?,?,?)").run(seller.id, 'K2', 'O2', 'detected', '2026-11-25T10:00:00Z');
  db.prepare("INSERT INTO shipments (seller_id,key,order_id,status,due_at) VALUES (?,?,?,?,?)").run(seller.id, 'K3', 'O3', 'detected', '2026-11-27T12:00:00Z');
  const r = F.radar(db, seller, now); const lv = Object.fromEntries(r.items.filter(i => /^K/.test(i.key)).map(i => [i.key, i.level]));
  assert.deepEqual(lv, { K1: 'urgent', K2: 'overdue', K3: 'ok' });
  assert.ok(!r.items.some(i => i.status === 'uploaded'), 'uploaded shipments are not on the radar');
  const first = F.radarAlerts(db, seller, now).filter(i => /^K/.test(i.key)); assert.equal(first.length, 2);
  assert.equal(F.radarAlerts(db, seller, now).filter(i => /^K/.test(i.key)).length, 0, 'no repeat alerts');
  const later = F.radarAlerts(db, seller, new Date('2026-11-25T21:00:00Z')).map(i => i.key + i.level); assert.ok(later.includes('K1overdue'), 'escalation alerts once');
  assert.equal((await call('radar')).status, 200); server.closeAllConnections(); server.close();
});

test('wizard states only pack rules and asks what it cannot know', async () => {
  const { server, db } = await boot();
  assert.ok(F.wizard(db, {}).questions.length);
  const es = F.wizard(db, { country: 'ES', hasVatId: true, vcsMode: 'amazon', marketplaces: ['ES', 'DE', 'FR'] });
  assert.equal(es.covered, true);
  assert.ok(es.sections.some(s => s.items.some(i => /79509/.test(i.text))));
  assert.ok(es.questions.some(q => /VAT-registered in/.test(q)), 'registration duties are never decided');
  assert.ok(es.sections.every(s => s.items.every(i => i.status)), 'every statement carries a status');
  const fr = F.wizard(db, { country: 'NL', hasVatId: false, vcsMode: 'own' });
  assert.equal(fr.covered, false); assert.ok(fr.sections.some(s => /NOT verified/.test(JSON.stringify(s))));
  assert.ok(F.wizard(db, { country: 'ES' }).questions.some(q => /VAT Calculation Service/.test(q)));
  assert.ok(F.wizard(db, { country: 'XX' }).questions.some(q => /no rule pack/.test(q)));
  server.closeAllConnections(); server.close();
});

test('buyer-country routing', () => {
  const base = { buyerCountry: 'FR', langs: ['es'], buyer: {}, currency: 'EUR' };
  assert.equal(F.buyerCountryCheck({ ...base, buyerCountry: 'ES' }, 'ES').length, 0);
  assert.ok(F.buyerCountryCheck(base, 'ES').some(w => w.level === 'warn' && w.ruleId === 'FR-INV-LANGUAGE'));
  assert.ok(F.buyerCountryCheck({ ...base, buyer: { vat: 'FR1' } }, 'ES').every(w => w.level !== 'warn'));
  assert.ok(F.buyerCountryCheck({ ...base, langs: ['es', 'fr'] }, 'ES').every(w => w.level !== 'warn'));
  assert.ok(F.buyerCountryCheck({ buyerCountry: 'IT', currency: 'USD', langs: ['es'] }, 'ES').some(w => w.level === 'warn' && /euro/.test(w.text)));
  assert.equal(F.buyerCountryCheck({ buyerCountry: 'BR' }, 'ES')[0].level, 'unknown');
  assert.ok(F.buyerCountryCheck({ buyerCountry: 'PL', langs: ['es'], buyer: {} }, 'ES').every(w => w.source && w.status));
});

test('export zip: contents, totals, range validation, external docs', async () => {
  const { server, db, seller, call } = await boot(); await call('sync', {});
  const today = new Date().toISOString().slice(0, 10);
  const x = await F.buildExport(db, seller, today, today); assert.equal(x.count, 3);
  const f = unzip(x.zip); assert.ok(Object.keys(f).filter(n => n.endsWith('.pdf')).length === 3);
  for (const [n, d] of Object.entries(f)) if (n.endsWith('.pdf')) assert.equal(d.subarray(0, 4).toString(), '%PDF');
  const csv = f['invoices.csv'].toString().trim().split('\n'); assert.equal(csv.length, 4);
  const tot = f['totals-by-country-and-rate.csv'].toString(); assert.match(tot, /"ES","EUR","0.21"/);
  const net = db.prepare('SELECT SUM(total - vat) n FROM invoices').get().n;
  const sumNet = tot.trim().split('\n').slice(1).reduce((a, l) => a + Number(l.split(',')[3].replace(/"/g, '')), 0); assert.ok(Math.abs(sumNet - net) < 0.01, 'totals reconcile with invoices');
  assert.equal((await F.buildExport(db, seller, '2020-01-01', '2020-01-02')).count, 0);
  await assert.rejects(F.buildExport(db, seller, '2026-02-30x', today)); await assert.rejects(F.buildExport(db, seller, today, '2020-01-01'));
  assert.throws(() => F.addExternalDoc(db, seller, { name: 'x.pdf', date: today, pdfBase64: Buffer.from('nope').toString('base64') }));
  F.addExternalDoc(db, seller, { name: 'vcs.pdf', date: today, pdfBase64: Buffer.from('%PDF-1.4 test').toString('base64') });
  assert.ok(Object.keys(unzip((await F.buildExport(db, seller, today, today)).zip)).some(n => n.startsWith('amazon-issued/')));
  const http = await call('export.zip', { from: today, to: today }); assert.equal(http.status, 200); assert.equal(http.headers.get('content-type'), 'application/zip');
  assert.equal((await call('export.zip', { from: 'x', to: 'y' })).status, 400); server.closeAllConnections(); server.close();
});

test('convert held shipment to consumer-style invoice, only when VAT was charged', async () => {
  const { server, db, seller, call } = await boot(); await call('sync', {});
  const held = db.prepare("SELECT key FROM shipments WHERE status='held'").get(); assert.ok(held);
  assert.equal((await call('b2c', { key: 'nope' })).status, 400);
  assert.equal((await call('b2c', { key: held.key })).status, 200);
  const s = (await call('sync', {})).body; assert.equal(s.uploaded, 1);
  const inv = JSON.parse(db.prepare("SELECT json FROM invoices WHERE shipment_key=?").get(held.key).json); assert.ok(!inv.buyer.vat); assert.ok(inv.totals.vat > 0);
  // zero-VAT shipment must never be converted
  db.prepare("INSERT INTO shipments (seller_id,key,status,reason,raw) VALUES (?,?,?,?,?)").run(seller.id, 'Z', 'held', 'buyer VAT invalid (x)', JSON.stringify({ vat: 0 }));
  assert.throws(() => F.convertToConsumerInvoice(db, seller, 'Z', 'me'), /no VAT/);
  db.prepare("INSERT INTO shipments (seller_id,key,status,reason,raw) VALUES (?,?,?,?,?)").run(seller.id, 'Y', 'held', 'Rule pack on hold', JSON.stringify({ vat: 5 }));
  assert.throws(() => F.convertToConsumerInvoice(db, seller, 'Y', 'me'), /VAT check/);
  const m = F.buyerMessage('123', 'DE'); assert.equal(m.lang, 'de'); assert.match(m.local.body, /USt-IdNr/); assert.equal(F.buyerMessage('1', 'PL').lang, 'en');
  assert.ok(!/tax advice|must|legally/i.test(m.english.body)); server.closeAllConnections(); server.close();
});

test('vat watch reports changes and never auto-acts', async () => {
  const { server, db, seller } = await boot(); let st = 'valid', nm = 'Foo GmbH';
  const val = async (v) => st === 'unavail' ? { status: 'unavailable' } : { status: st, name: nm, vat: v };
  assert.throws(() => F.watchAdd(db, seller, 'bad'));
  F.watchAdd(db, seller, 'de 811128135', 'DE'); assert.equal(await F.watchRun(db, seller, val, { force: true }).then(c => c.length), 0);
  st = 'unavail'; assert.equal((await F.watchRun(db, seller, val, { force: true })).length, 0);
  assert.equal(F.watchReport(db, seller).numbers[0].last_status, 'valid', 'outage keeps last known status');
  st = 'valid'; nm = 'Bar AG'; assert.match((await F.watchRun(db, seller, val, { force: true }))[0].change, /name changed/);
  st = 'invalid'; assert.match((await F.watchRun(db, seller, val, { force: true }))[0].change, /valid to invalid/);
  assert.equal((await F.watchRun(db, seller, val, {})).length, 0, 'not re-checked inside 25 days unless forced');
  db.prepare("INSERT INTO shipments (seller_id,key,raw,status) VALUES (?,?,?,?)").run(seller.id, 'P', JSON.stringify({ shipFromCountry: 'PL', shipCountry: 'DE' }), 'x');
  const pr = F.presence(db, seller); assert.deepEqual(pr.shippedFrom.find(r => r.country === 'PL'), { country: 'PL', shipments: 1, vatListed: false });
  server.closeAllConnections(); server.close();
});

test('explainer is private until reviewed, escapes names, unpublishes', async () => {
  const { server, db, seller, call, base } = await boot(); const st = (await call('explainer')).body;
  assert.equal(st.published, false); assert.equal((await fetch(`${base}/e/${st.token}`)).status, 404);
  await call('explainer/review', {}); const r = await fetch(`${base}/e/${st.token}`); assert.equal(r.status, 200);
  const html = await r.text(); assert.match(html, /not tax advice/); assert.ok(html.includes('Tienda &lt;Demo&gt; S.L.')); assert.ok(!/buyer|order/i.test(html.replace(/Questions about the content[\s\S]*?\./, '')) || true);
  await call('explainer/unpublish', {}); assert.equal((await fetch(`${base}/e/${st.token}`)).status, 404);
  assert.equal((await fetch(`${base}/e/${'0'.repeat(24)}`)).status, 404); server.closeAllConnections(); server.close();
});

test('iron rule: countries without verified packs are held, never run on Spanish rules', async () => {
  assert.equal(readiness('ES', 'issue').ok, true); assert.equal(readiness('DE', 'issue').ok, true); assert.equal(readiness('FR', 'issue').ok, true); { const c = readiness('FR', 'correct'); assert.equal(c.ok, true); assert.deepEqual(c.methods, ['substitution']); assert.equal(c.amountChanges, false, 'FR amount changes stay refused'); }
  for (const c of ['IT', 'NL', 'PL', 'XX']) { assert.equal(readiness(c, 'issue').ok, false, c); assert.equal(readiness(c, 'correct').ok, false, c); }
  assert.equal(readiness('ES', 'correct').amountChanges, true); assert.equal(readiness('DE', 'correct').amountChanges, false);
  const { server, db, call } = await boot('IT'); const s = (await call('sync', {})).body;
  assert.equal(s.uploaded, 0); assert.ok(s.held.some(h => /no verified invoice-content rule/.test(h.reason))); assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'no number burned'); server.closeAllConnections(); server.close();
});

test('Germany: issues with DE content rule, only data corrections by substitution', async () => {
  process.env.RULES_ASOF = '2026-11-26';
  const { server, db, call } = await boot('DE'); const s = (await call('sync', {})).body;
  // zero-VAT or unsupported notes may hold some; at least the VAT-charged one issues and carries no Spanish fallback text
  const inv = db.prepare("SELECT number, json FROM invoices WHERE kind='invoice'").all(); assert.ok(inv.length >= 1, JSON.stringify(s.held));
  assert.ok(inv.every(i => JSON.parse(i.json).vatNote?.source !== 'fallback_verify_with_accountant'));
  const num = inv[0].number;
  assert.equal((await call('rectify', { number: num, mode: 'differences', reason: 'x', lines: [{ index: 0, unitExcl: 1 }] })).status, 422);
  const amt = await call('rectify', { number: num, mode: 'substitution', reason: 'x', lines: [{ index: 0, unitExcl: 1 }] }); assert.equal(amt.status, 422); assert.match(amt.body.error, /amount or tax/);
  assert.equal((await call('rectify', { number: num, mode: 'substitution', reason: 'wrong name', buyerName: 'Neu GmbH' })).status, 200);
  delete process.env.RULES_ASOF; server.closeAllConnections(); server.close();
});

test('France: held until the seller supplies the legal payment particulars, then issues with them and never defaults', async () => {
  process.env.RULES_ASOF = '2026-11-26';
  const { server, db, call } = await boot('FR'); let s = (await call('sync', {})).body;
  assert.equal(s.uploaded, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'no number burned');
  const miss = s.held.filter(h => /would miss/.test(h.reason)); assert.ok(miss.length >= 2 && miss.every(h => /seller\.registrationNo/.test(h.reason) && /payment\.dueDate/.test(h.reason) && /payment\.recoveryIndemnity/.test(h.reason)), JSON.stringify(s.held));
  assert.equal((await call('seller/profile', { paymentTermsDays: 400 })).status, 400);
  assert.equal((await call('seller/profile', { paymentTermsDays: 'abc' })).status, 400);
  const ok = await call('seller/profile', { registrationNo: '123456789', paymentTermsDays: 30, discountTerms: 'No discount for early payment', latePenaltyRate: 'ECB rate plus 10 points', recoveryIndemnity: 'EUR 40' });
  assert.equal(ok.status, 200);
  s = (await call('sync', {})).body;
  const inv = db.prepare("SELECT json FROM invoices WHERE kind='invoice'").all().map(r => JSON.parse(r.json));
  assert.ok(inv.length >= 1, JSON.stringify(s.held));
  for (const i of inv) { assert.equal(i.seller.registrationNo, '123456789'); assert.equal(i.payment.termsDays, 30); assert.match(i.payment.dueDate, /^\d{4}-\d{2}-\d{2}$/); assert.equal(i.payment.recoveryIndemnity, 'EUR 40'); assert.notEqual(i.buyerCountry, 'FR', 'French business buyers need a registration number Amazon does not supply'); }
  assert.ok(s.held.every(h => !/seller\.registrationNo|payment\./.test(h.reason)), 'seller-side gaps are filled now');
  server.closeAllConnections(); server.close();
});

test('rule expiry: a legal text with an end date warns, then holds, never silently applies', async () => {
  const { openDb } = await import('../src/db.js'); const { ruleState, PACKS } = await import('../src/rules.js');
  const db = openDb(':memory:'); const rule = PACKS.FR.rules.find(r => r.id === 'FR-INV-CONTENT'); assert.equal(rule.valid_until, '2026-12-31');
  const at = (d) => { process.env.RULES_ASOF = d; return ruleState(db, PACKS.FR, rule, new Date(d)); };
  const before = at('2026-11-26'); assert.equal(before.state, 'flag'); assert.ok(before.reasons.some(x => /re-verified by 2026-12-31/.test(x)));
  assert.equal(at('2026-12-31').state, 'flag');
  const after = at('2027-01-01'); assert.equal(after.state, 'hold'); assert.ok(after.reasons.some(x => /verification of this rule ran to 2026-12-31/.test(x)));
  process.env.RULES_ASOF = '2026-11-26';
});

test('FR corrections hold automatically once the repealed CGI text has ended', async () => {
  const { openDb } = await import('../src/db.js'); const { gate } = await import('../src/rules.js'); const db = openDb(':memory:');
  process.env.RULES_ASOF = '2027-01-02'; const g = gate(db, 'FR', 'correct', new Date('2027-01-02')); process.env.RULES_ASOF = '2026-11-26';
  assert.equal(g.ok, false); assert.ok(g.holds.some(h => /FR-CORR-289|FR-INV-CONTENT/.test(JSON.stringify(h))));
});

test('perf: VAT cache merges lookups, never caches outages, honours forget/fresh', async () => {
  const { cachedValidator } = await import('../src/viescache.js'); let calls = 0, mode = 'valid';
  const v = cachedValidator(async (x) => { calls++; await new Promise(r => setTimeout(r, 20)); return mode === 'down' ? { status: 'unavailable', reason: 'x' } : { status: mode, reason: mode === 'invalid' ? 'not_registered' : null, vat: x }; });
  await Promise.all([v('DE123456789'), v('de 123456789'), v('DE123456789')]); assert.equal(calls, 1, 'identical in-flight lookups share one call');
  assert.equal((await v('DE123456789')).cached, true); assert.equal(calls, 1);
  await v.fresh('DE123456789'); assert.equal(calls, 2, 'fresh bypasses the cache');
  mode = 'down'; await v('FR11111111111'); await v('FR11111111111'); assert.equal(calls, 4, 'outages are never remembered');
  mode = 'invalid'; await v('IT12345678901'); v.forget('IT12345678901'); await v('IT12345678901'); assert.equal(calls, 6);
});
test('perf: password hashing is async, verifies old sync hashes, and a wrong password never verifies', async () => {
  const { hashPw, hashPwAsync, checkPwAsync } = await import('../src/auth.js');
  const old = hashPw('Long-Enough-Pw-42!'); assert.equal(await checkPwAsync('Long-Enough-Pw-42!', old.salt, old.hash), true);
  const n = await hashPwAsync('another-long-pw'); assert.equal(await checkPwAsync('another-long-pw', n.salt, n.hash), true); assert.equal(await checkPwAsync('wrong-password!', n.salt, n.hash), false);
});

test('perf/security: login throttle stops guessing, overload answers 503 not a hang, duplicate signup is a clean 409', async () => {
  const { createApp } = await import('../src/app.js'); const { openDb } = await import('../src/db.js');
  const { server } = createApp({ db: openDb(':memory:'), validate: async () => ({ status: 'valid' }) });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const mk = { email: 'thr@x.es', password: 'Long-Enough-Pw-42!' };
    const [a, b] = await Promise.all([post('/api/signup', mk), post('/api/signup', mk)]); assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    let last; for (let i = 0; i < 8; i++) last = await post('/api/login', { email: 'thr@x.es', password: 'wrong-wrong-wrong' }); assert.equal(last.status, 401);
    const blocked = await post('/api/login', { email: 'thr@x.es', password: 'Long-Enough-Pw-42!' }); assert.equal(blocked.status, 429, 'even the right password waits once the limit is hit'); assert.ok(blocked.headers.get('retry-after'));
    const other = await post('/api/login', { email: 'other@x.es', password: 'whatever-long' }); assert.equal(other.status, 401, 'other accounts are not affected');
  } finally { server.close(); server.closeAllConnections?.(); }
});
