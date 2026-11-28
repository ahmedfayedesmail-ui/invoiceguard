// T9 journey fixes in a real browser, synthetic data only. Skips locally without Chrome, FAILS when CI=true (same rule as holds-ui).
import puppeteer from 'puppeteer-core'; import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync, readFileSync } from 'node:fs';
import { mock } from 'node:test';
import { createApp } from '../src/app.js';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
async function boot(env) {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env }); await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) => fetch(base + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const r1 = await post('signup', { email: 'j@example.test', password: 'Long-Enough-Pw-42!' }); const cookie = r1.headers.get('set-cookie').split(';')[0];
  await post('seller', { name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }, cookie);
  return { server, base, cookie, post };
}
const btns = (page) => page.evaluate(() => [...document.querySelectorAll('#app button, #app a.btn')].map(b => b.textContent.trim()));
const click = (page, t) => page.evaluate((t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t)?.click(), t);
async function open(base, cookie, browser) { const page = await browser.newPage(); await page.setCookie({ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }); await page.goto(base + '/app'); return page; }

test('JUI1 gate closed: the start screen says so, has no dead-end CTA, routes to the demo; the demo banner invites nothing the gate refuses', { timeout: 120000 }, async () => {
  assert.ok(existsSync(CHROME), 'Chrome is required at ' + CHROME);
  const { server, base, cookie } = await boot({}); const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await open(base, cookie, browser); await page.waitForFunction(() => document.body.innerText.includes('How do you want to start?'), { timeout: 8000 });
    const text = await page.$eval('#app', e => e.innerText), b = await btns(page);
    assert.ok(!b.includes('Start with my own report'), 'no dead-end CTA'); assert.match(text, /not open yet/i); assert.match(text, /sample data only/i); assert.ok(b.includes('Just look around with simulated data')); assert.ok(b.includes('Ask to be told when it opens'));
    await click(page, 'Just look around with simulated data');
    await page.waitForFunction(() => document.body.innerText.includes('simulated sample data'), { timeout: 15000 });
    const t2 = await page.$eval('#app', e => e.innerText), b2 = await btns(page);
    assert.match(t2, /not open in this pilot yet/i); assert.ok(!b2.some(x => /^Upload (an order report|my VAT)/.test(x)), 'banner has no upload button while the gate is closed'); assert.ok(!/upload your own/i.test(t2.split('\n').find(l => /simulated sample data/.test(l)) || ''));
    const r = await fetch(base + '/api/me', { headers: { cookie } }); assert.equal((await r.json()).features.manualUpload, false);
  } finally { await browser.close(); server.close(); }
});

test('JUI2 gate open: the guide leads with the VAT Invoice Data Report, Order Report is preview-only; Uploaded needs a confirm and Cancel marks nothing', { timeout: 120000 }, async () => {
  assert.ok(existsSync(CHROME), 'Chrome is required at ' + CHROME);
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 24, 10, 30, 0) });
  const { server, base, cookie, post } = await boot({ ALLOW_MANUAL_UPLOAD: '1' });
  const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
  await post('amazon/connect', { manual: true }, cookie); assert.equal((await (await post('manual/issue', { text, attest: true }, cookie)).json()).issued, 3);
  mock.timers.reset();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await open(base, cookie, browser); await page.waitForFunction(() => document.body.innerText.includes('Get your VAT Invoice Data Report'), { timeout: 10000 });
    const g = await page.$eval('#app', e => e.innerText);
    assert.ok(g.indexOf('VAT Invoice Data Report') < g.indexOf('preview only')); assert.match(g, /VAT Calculation Service/); assert.match(g, /never creates an invoice/); assert.ok(!/1\. Get your order report/.test(g));
    await click(page, 'Ready to upload'); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Uploaded'));
    const state = () => fetch(base + '/api/dashboard', { headers: { cookie } }).then(r => r.json()).then(d => d.kpis);
    assert.equal((await state()).ready, 3);
    await click(page, 'Uploaded'); await page.waitForSelector('#dlg[open]'); assert.match(await page.$eval('#dlg', e => e.innerText), /Only do this after you have uploaded/);
    assert.equal((await state()).ready, 3, 'nothing marked while the dialog is open');
    await page.evaluate(() => [...document.querySelectorAll('#dlg button')].find(b => b.textContent.trim() !== 'Confirm').click()); await new Promise(r => setTimeout(r, 400));
    assert.equal((await state()).ready, 3, 'Cancel marks nothing');
    await click(page, 'I uploaded these'); await page.waitForSelector('#dlg[open]'); assert.match(await page.$eval('#dlg', e => e.innerText), /Mark all 3/); await page.evaluate(() => [...document.querySelectorAll('#dlg button')].find(b => b.textContent.trim() === 'Confirm').click());
    await page.waitForFunction(() => !document.querySelector('#dlg[open]')); await new Promise(r => setTimeout(r, 800));
    const k = await state(); assert.equal(k.ready, 0); assert.equal(k.uploaded, 3);
  } finally { await browser.close(); server.close(); mock.timers.reset(); }
});
