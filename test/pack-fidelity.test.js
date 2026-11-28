// T9 pack fidelity (swarm-t6 findings, implemented on swarm/t9-pack-fix).
// F1  the CSV formula guard applies to free-text cells only; a negative amount stays a plain numeric -24.20
// F3  manifest amount columns carry exactly two decimals
// F6  the archive carries a fixed timestamp (newest issue date in it) so an unchanged pack re-exports to the
//     same bytes; a GET changes nothing; a POST records the export once, after the archive is built
// F4  the manifest carries kind, rectifies, mode and net
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { ensureRepairTables } from '../src/repair.js';
import { renderPdf } from '../src/pdf.js';

const HEADER = 'invoice_number,order_id,buyer,buyer_vat,issue_date,currency,total_incl_vat,vat,file,kind,rectifies,mode,net';

// makeZip stores entries uncompressed, so the manifest text sits verbatim inside the archive bytes.
function manifestLines(buf) {
  const s = buf.toString('latin1');
  const i = s.indexOf('invoice_number,order_id,buyer');
  assert.ok(i > 0, 'the pack contains a manifest');
  const j = s.indexOf('PK\x03\x04', i); // the next local file header ends the manifest entry
  return s.slice(i, j < 0 ? undefined : j).split('\r\n').filter(Boolean);
}
// Minimal CSV reader, so a broken quote shows up as a wrong field instead of a wrong substring.
function parseCsvLine(line) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
// The DOS timestamp of the first entry in the archive (offset 10 = time, 12 = date).
function dosStamp(buf) {
  const time = buf.readUInt16LE(10), date = buf.readUInt16LE(12);
  return { y: 1980 + (date >> 9), mo: (date >> 5) & 0xf, d: date & 0x1f, h: time >> 11, mi: (time >> 5) & 0x3f, s: (time & 0x1f) * 2 };
}

async function boot({ now } = {}) {
  if (now) mock.timers.enable({ apis: ['Date'], now });
  const { server, db } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => {
    const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0];
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await call('signup', { email: 'pack@x.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Pack S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { manual: true });
  const issued = (await call('manual/issue', { text: readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'), attest: true })).body;
  assert.equal(issued.issued, 3, 'the VIDR fixture issues three invoices');
  const sellerId = db.prepare('SELECT seller_id FROM invoices LIMIT 1').get().seller_id;
  return { server, db, call, sellerId };
}
const readyRows = (db, sellerId) => db.prepare("SELECT number, kind, rectifies, issued_at, total, vat, json FROM invoices WHERE seller_id=? AND upload_status='ready' ORDER BY number").all(sellerId);
const exportedCount = (db, sellerId) => db.prepare("SELECT COUNT(*) c FROM events WHERE seller_id=? AND type='exported'").get(sellerId).c;

test('F1/F3/F4 manifest: amounts are plain 2-decimal numbers, free text is formula-guarded, kind/rectifies/mode/net are present', async () => {
  const { server, db, call, sellerId } = await boot();
  try {
    const tpl = JSON.parse(readyRows(db, sellerId)[0].json);
    // A correction with a negative total whose buyer name and order id would open a spreadsheet formula.
    const rect = { ...tpl, type: 'rectificativa', series: 'R', number: 'R-2026-000001', mode: 'differences', issueDate: '2026-11-24',
      orderId: '@SUM(A1:A2)', buyer: { ...tpl.buyer, name: '=HYPERLINK("http://evil.example","click")' },
      rectifies: { number: tpl.number, issueDate: tpl.issueDate, reason: 'Goodwill discount' },
      lines: [{ description: 'Discount', qty: 1, unitExcl: -20, rate: 0.21, excl: -20, vat: -4.2 }], totals: { excl: -20, vat: -4.2, incl: -24.2 } };
    db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status,uploaded_at,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(sellerId, 'R-2026-000001', 'SHIPMENT:Correction:T9FID', 'rectificativa', tpl.number, '2026-11-24T10:30:00.000Z', -24.2, -4.2, JSON.stringify(rect), null, 'ready', null, null);

    const pack = await call('pack');
    assert.equal(pack.status, 200);
    const [header, ...rows] = manifestLines(pack.body);
    assert.equal(header, HEADER, 'the manifest header is the documented contract');

    const byNumber = new Map(rows.map(l => { const f = parseCsvLine(l); return [f[0], { line: l, f }]; }));
    assert.equal(byNumber.size, 4, 'three invoices and one correction');

    const neg = byNumber.get('R-2026-000001');
    assert.ok(neg, 'the correction is in the manifest');
    assert.equal(neg.f[6], '-24.20', 'total is the plain number -24.20, not text');
    assert.equal(neg.f[7], '-4.20', 'vat is a plain 2-decimal number');
    assert.ok(!neg.line.includes("'-24.20"), 'a negative amount is never prefixed with a quote');
    assert.ok(neg.line.includes(',-24.20,-4.20,'), 'the numeric cells are unquoted in the raw row');
    assert.equal(neg.f[1], "'@SUM(A1:A2)", 'the order id is kept, neutralised by the leading apostrophe');
    assert.ok(neg.line.includes("\"'@SUM(A1:A2)\""), 'a leading @ in free text is neutralised for spreadsheets');
    assert.equal(neg.f[2], "'=HYPERLINK(\"http://evil.example\",\"click\")", 'the buyer name is kept, neutralised by the leading apostrophe');
    assert.ok(neg.line.includes("\"'=HYPERLINK"), 'a leading = in free text is neutralised for spreadsheets');
    assert.equal(neg.f[9], 'rectificativa', 'kind column');
    assert.equal(neg.f[10], tpl.number, 'rectifies column names the original invoice');
    assert.equal(neg.f[11], 'differences', 'mode column');
    assert.equal(neg.f[12], '-20.00', 'net column, 2 decimals');

    for (const r of readyRows(db, sellerId).filter(x => x.kind === 'invoice')) {
      const row = byNumber.get(r.number);
      assert.equal(row.f[6], Number(r.total).toFixed(2), 'every total is exactly 2 decimals');
      assert.equal(row.f[7], Number(r.vat).toFixed(2), 'every vat is exactly 2 decimals');
      assert.equal(row.f[9], 'invoice', 'kind column');
      assert.equal(row.f[10], '', 'an invoice rectifies nothing');
      assert.equal(row.f[11], '', 'an invoice has no correction mode');
      assert.equal(row.f[12], Number(JSON.parse(r.json).totals.excl).toFixed(2), 'net comes from the invoice totals');
    }
  } finally { server.close(); }
});

test('F6 a GET renders without changing state; a POST records the export once, however often the pack is downloaded', async () => {
  const { server, db, call, sellerId } = await boot();
  try {
    ensureRepairTables(db);
    const rows = readyRows(db, sellerId);
    db.prepare("INSERT INTO repairs (seller_id,event_key,kind,original_number,shipment_key,reason,suggestion,state,created_at,rect_number) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(sellerId, 'T9FID', 'credit_note', rows[0].number, 'SHIPMENT:T9FID', 'refund', 'issue a credit note', 'issued', '2026-11-24T10:00:00.000Z', rows[0].number);
    assert.equal(exportedCount(db, sellerId), 0, 'nothing has been exported yet');

    const get1 = await call('pack');
    assert.equal(get1.status, 200);
    assert.equal(exportedCount(db, sellerId), 0, 'a GET is a render, not an export: no exported events');
    assert.equal(db.prepare("SELECT state FROM repairs WHERE seller_id=? AND event_key='T9FID'").get(sellerId).state, 'issued', 'a GET leaves the correction untouched');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM invoices WHERE seller_id=? AND upload_status='ready'").get(sellerId).c, rows.length, 'a GET uploads nothing');

    const post1 = await call('pack', {});
    assert.equal(post1.status, 200);
    assert.equal(exportedCount(db, sellerId), rows.length, 'a POST records one exported event per document in the pack');
    assert.equal(db.prepare("SELECT state FROM repairs WHERE seller_id=? AND event_key='T9FID'").get(sellerId).state, 'exported', 'the correction travelling in the pack moves to exported');
    assert.deepEqual(manifestLines(post1.body), manifestLines(get1.body), 'the POST returns the same pack the GET renders');

    const post2 = await call('pack', {});
    assert.equal(post2.status, 200);
    assert.equal(exportedCount(db, sellerId), rows.length, 'exporting the same pack again adds no duplicate events');
    assert.ok(post1.body.equals(post2.body), 'two exports of an unchanged pack are byte-identical');
  } finally { server.close(); }
});

test('F6 the archive carries a fixed timestamp: the newest issue date inside it, never the moment of the download', async () => {
  const { server, db, call, sellerId } = await boot({ now: Date.UTC(2026, 10, 24, 10, 30, 0) });
  try {
    const rows = readyRows(db, sellerId);
    const newest = rows.reduce((t, r) => Math.max(t, Date.parse(r.issued_at)), 0);
    const want = new Date(newest);
    const first = await call('pack');
    assert.equal(first.status, 200);
    assert.deepEqual(dosStamp(first.body), { y: want.getUTCFullYear(), mo: want.getUTCMonth() + 1, d: want.getUTCDate(), h: want.getUTCHours(), mi: want.getUTCMinutes(), s: want.getUTCSeconds() }, 'the entry timestamp is the newest issue date, read in UTC');

    mock.timers.setTime(Date.UTC(2026, 10, 24, 10, 30, 5)); // five seconds later: the old writer stamped this moment instead
    const second = await call('pack');
    assert.equal(second.status, 200);
    assert.deepEqual(dosStamp(second.body), dosStamp(first.body), 'the timestamp does not follow the clock');
    assert.ok(first.body.equals(second.body), 're-exporting the unchanged pack produces identical bytes (PDFs included)');
  } finally { server.close(); mock.timers.reset(); }
});

// The route caches rendered PDFs, so the archive test above cannot see the PDF's own clock. This one calls the
// renderer directly: the file a pack carries must not embed the moment it was produced, or a cold process would
// write a different pack for the same invoices.
test('F6 the same document renders to the same PDF bytes, so a pack built in a fresh process is identical too', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 24, 10, 30, 0) });
  try {
    const inv = { type: 'invoice', langs: ['es'], number: 'A-2026-000001', issueDate: '2026-11-20', orderId: '111-1111111-1111111', currency: 'EUR',
      seller: { name: 'Tienda Pack S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' },
      buyer: { name: 'Cliente SL', company: 'Cliente SL', vat: 'DE123456789', address: ['Street 1', 'Berlin', 'Deutschland'] },
      lines: [{ description: 'Widget', qty: 1, unitExcl: 100, rate: 0.21, excl: 100, vat: 21 }], totals: { excl: 100, vat: 21, incl: 121 }, vatNote: null };
    const first = await renderPdf(inv);
    mock.timers.setTime(Date.UTC(2026, 10, 24, 11, 0, 0)); // half an hour later: an unstamped PDF would differ here
    const second = await renderPdf(inv);
    assert.equal(first.subarray(0, 4).toString(), '%PDF');
    assert.ok(first.equals(second), 'the PDF bytes do not depend on when it was rendered');
  } finally { mock.timers.reset(); }
});
