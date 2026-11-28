// Headless Chrome: counters in the real page. Off by default; log mode shows exact payloads and sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { createApp } from '../src/app.js';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
test('counters in the page: off by default, log mode exact payloads, no network, nothing sensitive', { timeout: 90000, skip: !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not installed' }, async () => {
  const { server } = createApp({ validate: async () => ({}), secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const dir = mkdtempSync(tmpdir() + '/mc-');
    const secretName = 'SECRET-Mueller-GmbH-report.txt';
    const f = dir + '/' + secretName; writeFileSync(f, readFileSync('fixtures/order-report.tsv'));
    for (const mode of ['off', 'log']) {
      const page = await browser.newPage(); const reqs = [];
      await page.setRequestInterception(true);
      page.on('request', (rq) => { reqs.push(rq.url()); if (rq.url().endsWith('/local') || rq.url().endsWith('/local/')) { fetch(rq.url()).then(r => r.text()).then(t => rq.respond({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; form-action 'none'; frame-src blob:; base-uri 'none'" }, body: t.replace('name="ig-counters" content="off"', `name="ig-counters" content="${mode}"`) })); } else rq.continue(); });
      await page.goto(base + '/local', { waitUntil: 'networkidle0' });
      const before = reqs.length;
      assert.match(await page.$eval('#counted', e => e.textContent), /Only these four numbers/);
      await (await page.$('#file')).uploadFile(f);
      await page.waitForSelector('#out .card .badge', { timeout: 30000 });
      const log = await page.evaluate(() => window.__counters.log);
      assert.equal(reqs.length, before, 'no network request after load');
      if (mode === 'off') { assert.equal(log.length, 0); assert.match(await page.$eval('#countmode', e => e.textContent), /switched off/); }
      else {
        assert.deepEqual(log.map(e => e.e), ['page_view', 'check_started', 'check_completed']);
        assert.deepEqual(Object.keys(log[2]).sort(), ['bucket', 'e', 'outcome', 'v']);
        assert.ok(['0', '1-29', '30-49', '50-199', '200+'].includes(log[2].bucket));
        const s = JSON.stringify(log); assert.ok(!/SECRET|Mueller|\.txt|\d{3}-\d{7}-\d{7}/.test(s), 'no file name, order number or value: ' + s);
        await page.evaluate(() => { const b = document.createElement('button'); b.dataset.checkout = '1'; b.id = 'cb'; document.body.append(b); }); await page.click('#cb');
        assert.equal((await page.evaluate(() => window.__counters.log)).at(-1).e, 'checkout_click');
      }
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
});
