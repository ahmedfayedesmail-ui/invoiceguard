// Feeds Amazon's OFFICIAL VIDR samples (and derived variants) through the real upload path (POST /api/manual/preview and /api/manual/issue on a real createApp, in-memory DB). Synthetic/public data only.
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
const FX = (f) => readFileSync(new URL('../test/fixtures/amazon-vidr/' + f, import.meta.url));
async function boot() {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'run', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  await call('signup', { email: 'run@x.es', password: 'Long-Enough-Pw-42!' }); await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }); await call('amazon/connect', { manual: true });
  return { server, call };
}
const flipBusiness = (buf, isXml) => isXml ? Buffer.from(buf.toString('utf8').replace(/<IsBusinessOrder>false</g, '<IsBusinessOrder>true<')) : (() => { // latin1 round trip keeps every byte
  const lines = buf.toString('latin1').split('\r\n'); const h = lines[0].split(','), i = h.indexOf('is-business-order');
  return Buffer.from(lines.map((l, k) => { if (!k || !l) return l; const c = l.split(','); c[i] = 'TRUE'; return c.join(','); }).join('\r\n'), 'latin1'); })();
const summary = (r) => r.status !== 200 ? { status: r.status, error: r.body?.error } : { status: 200, rows: r.body.rows, willIssue: r.body.willIssue, heldCount: r.body.heldCount, skippedCount: r.body.skippedCount, invalidRows: r.body.invalidRowsCount, warnings: r.body.warnings, issued: r.body.issued, heldNow: r.body.heldNow, errors: r.body.errors, repairsProposed: r.body.repairsProposed };
const cases = [['Amazon CSV sample, as published', FX('VIDR_FLAT_FILE_SAMPLE.csv')], ['Amazon XML sample, as published', FX('VIDR_XML_SAMPLE_V2.xml')],
  ['DERIVED: CSV sample, every is-business-order set TRUE', flipBusiness(FX('VIDR_FLAT_FILE_SAMPLE.csv'), false)], ['DERIVED: XML sample, every IsBusinessOrder set true', flipBusiness(FX('VIDR_XML_SAMPLE_V2.xml'), true)]];
for (const [name, bytes] of cases) {
  const a = await boot(); const pre = await a.call('manual/preview', { bytesBase64: bytes.toString('base64') });
  const out = { name, bytes: bytes.length, preview: summary(pre) }; if (pre.status === 200) { out.heldReasons = pre.body.held.map(h => h.reason.slice(0, 110)); out.skipped = pre.body.skipped.map(s => s.why.slice(0, 70)); const iss = await a.call('manual/issue', { bytesBase64: bytes.toString('base64'), attest: true }); out.issue = summary(iss); }
  a.server.close(); console.log(JSON.stringify(out, null, 1));
}
process.exit(0);
