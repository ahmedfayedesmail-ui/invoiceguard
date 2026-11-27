// Exercises the REAL IndexedDB adapter and Web Crypto in headless Chrome: data survives a page reload, encryption hides it, delete clears it.
// Skips locally without Chrome, FAILS in CI (CI=true) like the privacy test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
test('history on IndexedDB: persists across reload, encrypted store hides content, deleteEverything clears it', { timeout: 90000, skip: !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not found (skipped locally; fails in CI)' }, async () => {
  assert.ok(existsSync(CHROME), 'Chrome is required in CI at ' + CHROME);
  const out = await build({ entryPoints: ['src/history.js'], bundle: true, format: 'iife', globalName: 'H', write: false, platform: 'browser' });
  const js = out.outputFiles[0].text, decl = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8')), text = readFileSync('fixtures/recon/all-r3-uploaded.tsv', 'utf8');
  const server = http.createServer((q, r) => { if (q.url === '/h.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(js); } else { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><script src="/h.js"></script>'); } });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(base);
    await page.evaluate(async (text, declared) => { const h = H.createHistory(H.indexedDbAdapter('t1')); await h.addImport({ id: 'r3', fileName: 'r3.tsv', text, declared }); const e = H.createHistory(H.indexedDbAdapter('t2'), { passphrase: 'pw-123' }); await e.addImport({ id: 'r3', fileName: 'r3.tsv', text, declared }); }, text, decl['all-r3-uploaded.tsv']);
    await page.reload(); // new page load, same origin: the data must still be there
    const r = await page.evaluate(async () => {
      const h = H.createHistory(H.indexedDbAdapter('t1')), res = await h.reconcile(), b = await h.evidenceBundle();
      const raw = await H.indexedDbAdapter('t2').get('import:r3'); const e = H.createHistory(H.indexedDbAdapter('t2'), { passphrase: 'pw-123' });
      let wrong = 'no error'; try { await H.createHistory(H.indexedDbAdapter('t2'), { passphrase: 'bad' }).imports(); } catch (x) { wrong = x.message; }
      const decrypted = (await e.imports())[0].id;
      await h.deleteEverything(); const after = (await h.imports()).length, keys = (await H.indexedDbAdapter('t1').list()).length;
      return { accepted: res.result.headline.accepted, logs: b.evidenceLogs.length, hashOk: b.imports[0].sha256 === await H.sha256Hex(b.imports[0].text), encrypted: raw.enc, leaks: /S9001|A-2026-000123/.test(JSON.stringify(raw)), wrong, decrypted, after, keys };
    });
    assert.ok(r.accepted >= 1 && r.logs >= 1 && r.hashOk, 'reload kept the import; reconcile and bundle work in a real browser');
    assert.equal(r.encrypted, true); assert.equal(r.leaks, false); assert.match(r.wrong, /Wrong passphrase/); assert.equal(r.decrypted, 'r3');
    assert.equal(r.after, 0); assert.equal(r.keys, 0);
    console.log('IDB test:', JSON.stringify(r));
  } finally { await browser.close(); server.close(); }
});
