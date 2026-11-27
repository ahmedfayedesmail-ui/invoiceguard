// Headless-Chrome proof of the problem loop page: round 1 files, a seller action, round 2 files, closure by evidence, zero network requests.
// Skips locally without Chrome, FAILS when CI=true. The page is served only because this test sets ENABLE_LOOP_PAGE=1.
import puppeteer from 'puppeteer-core';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
process.env.ENABLE_LOOP_PAGE = '1';
const { createApp } = await import('../src/app.js');
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
test('loop page: two rounds of real files in a real browser, closure only by a newer file, zero network requests', { timeout: 120000, skip: !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not found (skipped locally)' }, async () => {
  assert.ok(existsSync(CHROME), 'Chrome is required in CI at ' + CHROME);
  const { server } = createApp({ validate: async () => ({}), secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms)); let nFiles = 0;
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 1400 });
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    page.on('dialog', async d => { await d.accept(d.message().includes('reasoning') ? 'checked the account' : 'Test seller'); });
    const requests = []; page.on('request', r => requests.push(r.url()));
    await page.goto(base + '/local/loop', { waitUntil: 'networkidle0' }); await page.waitForFunction('window.__loopReady === true');
    requests.length = 0;
    const setv = (sel, v) => page.$eval(sel, (e, v) => { e.value = v; }, v);
    const loadVidr = async (file, created) => {
      await (await page.$('#vfile')).uploadFile(file); await page.waitForSelector('#v-mkt');
      await setv('#v-from', '2026-11-01'); await setv('#v-to', '2026-11-30'); await setv('#v-created', created); await setv('#v-down', created);
      await page.$eval('#v-after', e => { e.checked = true; });
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Confirm and store').click()); await sleep(800); nFiles++; await page.waitForFunction(n => document.querySelector('#results').innerText.includes('Loaded files (' + n + ')'), { timeout: 15000 }, nFiles);
    };
    const loadLedger = async (file) => {
      await page.$eval('#lfile', e => { e.value = ''; }); await (await page.$('#lfile')).uploadFile(file); await page.waitForSelector('#l-sys');
      await setv('#l-sys', 'acme-books'); await setv('#l-mkt', 'A1RKKUPIHCS9HS'); await setv('#l-from', '2026-11-01'); await setv('#l-to', '2026-11-30'); await setv('#l-complete', 'yes'); await setv('#l-kinds', 'invoice'); await setv('#l-scope', 'CHANNEL'); await setv('#l-chan', 'Amazon.es');
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Confirm and store').click()); await sleep(800); nFiles++; await page.waitForFunction(n => document.querySelector('#results').innerText.includes('Loaded files (' + n + ')'), { timeout: 15000 }, nFiles);
    };
    // a refused import stores nothing and says why
    await (await page.$('#lfile')).uploadFile('fixtures/loop/ledger-1.csv'); await page.waitForSelector('#l-sys');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Confirm and store').click()); await sleep(500);
    assert.match(await page.$eval('#msg', e => e.textContent), /Not stored.*Missing/);
    // round 1
    await loadVidr('fixtures/loop/vidr-1.tsv', '2026-11-20T10:00'); await loadLedger('fixtures/loop/ledger-1.csv');
    const r1 = await page.$eval('#results', e => e.innerText); console.log('--- ROUND 1 ---\n' + r1.slice(0, 1500));
    assert.match(r1, /Needs action/); assert.ok(await page.$('[data-state="ACTION_REQUIRED"]'), 'an action card exists');
    assert.equal(await page.$('[data-state="VERIFIED_CLOSED"]'), null, 'nothing is closed after round 1');
    const before = (await page.$$('[data-state]')).length;
    // seller says they acted: that must NOT close anything
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'I started this').click()); await sleep(800);
    assert.ok(await page.$('[data-state="AWAITING_NEW_EVIDENCE"]'), 'action started moves it to waiting');
    assert.equal(await page.$('[data-state="VERIFIED_CLOSED"]'), null, 'saying so closes nothing');
    // round 2: newer files
    await sleep(1500); await loadVidr('fixtures/loop/vidr-2.tsv', new Date(Date.now() - 500).toISOString().slice(0, 19)); ; // report taken after the seller's action, as in real life
    await loadLedger('fixtures/loop/ledger-2.csv');
    await page.$$eval('details.group', ds => ds.forEach(d => { d.open = true; })); const r2 = await page.$eval('#results', e => e.innerText); console.log('--- ROUND 2 ---\n' + r2.slice(0, 1800));
    assert.ok(await page.$('[data-state="VERIFIED_CLOSED"]'), 'a newer file closes a problem by evidence');
    assert.match(r2, /Closed with evidence: [1-9]/);
    assert.match(await page.$eval('#notchecked', e => e.textContent), /credit notes/);
    // CSP: the page cannot call out, and it never did
    assert.equal(await page.evaluate(() => fetch('/api/sample/run').then(() => 'allowed', () => 'blocked')), 'blocked');
    const stray = requests.filter(u => !u.startsWith('blob:') && !u.startsWith('data:')); assert.equal(stray.length, 0, 'requests after load: ' + stray.join(','));
    assert.equal(await page.$eval('#netcount', e => e.textContent), '0'); assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/loop-proof.png', fullPage: true }); void before;
  } finally { await browser.close(); server.close(); }
});
