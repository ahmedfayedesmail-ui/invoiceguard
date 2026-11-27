// Headless-Chrome proof that the local engine makes ZERO network requests after the page has loaded.
// Run: node test/local-engine.mjs   (needs `npm i --no-save puppeteer-core` and Chrome at CHROME_BIN or /usr/bin/google-chrome)
// Fails (exit 1) if ANY request leaves the page after load, if a CSP-blocked probe succeeds, or if the PDF does not render.
import puppeteer from 'puppeteer-core';
import { createApp } from '../src/app.js';
import { readFileSync, writeFileSync } from 'node:fs';
const FILES = ['fixtures/order-report.tsv', 'fixtures/vidr.tsv'];
const { server } = createApp({ validate: async () => ({}), secret: 'test' }); await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 1200 });
  const requests = []; page.on('request', r => requests.push(r.url()));
  await page.goto(base + '/local', { waitUntil: 'networkidle0' });
  const loaded = requests.length; requests.length = 0;
  for (const f of FILES) { const h = await page.$('#file'); await h.uploadFile(f); await new Promise(r => setTimeout(r, 1200)); }
  const text = await page.$eval('#out', e => e.innerText);
  ok(/ready to invoice/.test(text) && /held/.test(text), 'both synthetic fixture files analysed in the page');
  const btn = await page.$('button.sm'); ok(!!btn, 'a Sample PDF button exists');
  if (btn) await btn.click();
  await page.waitForSelector('a[download]', { timeout: 20000 }).catch(() => {});
  const href = await page.$eval('a[download]', a => a.href).catch(() => null); ok(!!href, 'PDF rendered in the browser');
  if (href) { const b64 = await page.evaluate(() => { let s = ''; window.__lastPdfBytes.forEach(x => s += String.fromCharCode(x)); return btoa(s); });
    const buf = Buffer.from(b64, 'base64'); ok(buf.slice(0, 5).toString() === '%PDF-' && buf.length > 2000, `PDF bytes valid (${buf.length} bytes)`); writeFileSync('/tmp/local-sample.pdf', buf); }
  // probe: the browser itself must refuse a fetch to our own server
  const probe = await page.evaluate(() => fetch('/api/sample/run').then(() => 'allowed', () => 'blocked')); ok(probe === 'blocked', 'CSP blocks a fetch probe from the page');
  const net = await page.$eval('#netcount', e => e.textContent);
  const stray = requests.filter(u => !u.startsWith('blob:') && !u.startsWith('data:'));
  ok(stray.length === 0, `zero network requests after load (requests seen: ${stray.length}, counter shows ${net}; ${loaded} at load)`);
  await page.screenshot({ path: '/tmp/local-proof.png', fullPage: true });
} finally { await browser.close(); server.close(); }
process.exit(fail ? 1 : 0);
