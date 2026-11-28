// Expedition: the HOLD reviewer screen in a real browser, synthetic data only. Skips locally without Chrome, FAILS when CI=true.
import puppeteer from 'puppeteer-core'; import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync } from 'node:fs';
import { createApp } from '../src/app.js'; import { openCreditNoteHold } from '../src/cn-gate.js'; import { writeLedger } from '../src/integrity.js';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
test('HUI1 a reviewer sees an open hold, its reasons and evidence, records a decision bound to the evidence, and sees the new state; a BLOCK offers no decision; evidence text is never rendered as HTML', { timeout: 120000, skip: !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not found (skipped locally)' }, async () => {
  assert.ok(existsSync(CHROME), 'Chrome is required at ' + CHROME);
  const { server, db } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test' }); await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const r1 = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rev@example.test', password: 'Long-Enough-Pw-42!' }) }); const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  await fetch(base + '/api/seller', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['DE'] }) });
  await fetch(base + '/api/amazon/connect', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ demo: true }) });
  const sid = db.prepare('SELECT id FROM sellers ORDER BY rowid DESC LIMIT 1').get().id;
  openCreditNoteHold(db, sid, 'REFUND:CorrectionReversal:X:1', 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'The report names document <img src=x onerror=window.__xss=1> not ours.' }], { snapshot: { documentNumbers: ['R-2026-999999'], statuses: ['CreditNoteUploaded'] }, number: 'R-2026-000001' });
  writeLedger(db, sid, 'SHIPMENT:BLK1', [{ code: 'TOTALS_CONTRADICT', severity: 'BLOCK', resolution: 'NEW_EVIDENCE', fingerprint: 'f'.repeat(64), evidence: { field: 'totals' }, explanation: 'The file contradicts itself.', action: 'Upload a corrected file.' }]);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.setCookie({ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base });
    await page.goto(base + '/app'); const click = (t) => page.evaluate((t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t)?.click(), t);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Documents'), { timeout: 8000 }).catch(async e => { console.log('PAGE:', await page.$eval('body', x => x.innerText.slice(0, 400)), cookie, r1.status); throw e; }); await click('Documents');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Holds')); await click('Holds');
    await page.waitForSelector('[data-hold]'); const text = await page.$eval('#app', e => e.innerText);
    assert.match(text, /Needs your decision/); assert.match(text, /R-2026-999999/); assert.match(text, /What the system knows/); assert.match(text, /What it does not know/); assert.match(text, /Blocked until/); assert.match(text, /Blocked: needs a corrected file/); assert.doesNotMatch(text, /undefined|\[object/);
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'evidence must be text, never HTML'); assert.equal(await page.evaluate(() => document.querySelectorAll('#app img').length), 0);
    assert.equal(await page.$$eval('[data-hold="TOTALS_CONTRADICT"] textarea', e => e.length), 0, 'a BLOCK has no decision form');
    // too short a reason is refused in the screen and nothing is recorded
    await page.type('[data-hold="CREDIT_NOTE_IDENTITY_UNPROVEN"] textarea', 'short'); await click('Record my decision for this evidence'); await page.waitForFunction(() => document.body.innerText.includes('at least 10 characters')); assert.equal(db.prepare('SELECT count(*) n FROM integrity_decisions').get().n, 0);
    await page.type('[data-hold="CREDIT_NOTE_IDENTITY_UNPROVEN"] textarea', ' - compared with Seller Central, row matches'); await click('Record my decision for this evidence');
    await page.waitForFunction(() => document.body.innerText.includes('Decision recorded for this evidence'), { timeout: 10000 });
    const d = db.prepare('SELECT decided_by, fingerprint FROM integrity_decisions').all(); assert.equal(d.length, 1); assert.equal(d[0].decided_by, 'rev@example.test');
    assert.equal(db.prepare("SELECT status FROM integrity_findings WHERE code='CREDIT_NOTE_IDENTITY_UNPROVEN'").get().status, 'RELEASED'); assert.equal(db.prepare("SELECT status FROM integrity_findings WHERE code='TOTALS_CONTRADICT'").get().status, 'OPEN');
    await page.$eval('input[type=checkbox]', e => e.click()); await page.waitForFunction(() => document.body.innerText.includes('Decision history')); assert.match(await page.$eval('#app', e => e.innerText), /rev@example\.test/);
  } finally { await browser.close(); server.close(); }
});
