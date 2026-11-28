// Usable HOLD flow in a real browser, synthetic data only. Skips locally without Chrome, FAILS when CI=true.
import puppeteer from 'puppeteer-core'; import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync, readFileSync } from 'node:fs';
import { createApp } from '../src/app.js'; import { openOriginalHold } from '../src/orig-gate.js'; import { openCreditNoteHold } from '../src/cn-gate.js'; import { writeLedger } from '../src/integrity.js'; import { processReport } from '../src/pipeline.js';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const full = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const one = (([h, r]) => [h, r].join('\n'))(full.trim().split('\n'));
test('HFUI the whole seller path: see what is held and why, read what resolves it, write a note, take the action, see the new state', async (t) => {
  if (!existsSync(CHROME)) { if (process.env.CI) assert.fail('Chrome is required in CI at ' + CHROME); return t.skip('no Chrome'); }
  const { server, db } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test' }); await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const J = { 'content-type': 'application/json' }; const r1 = await fetch(base + '/api/signup', { method: 'POST', headers: J, body: JSON.stringify({ email: 'rev@example.test', password: 'Long-Enough-Pw-42!' }) }); const cookie = r1.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/seller', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['DE'] }) });
  await fetch(base + '/api/amazon/connect', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ demo: true }) });
  const seller = db.prepare('SELECT * FROM sellers ORDER BY rowid DESC LIMIT 1').get(); const sid = seller.id;
  // real unknown-outcome hold from the real pipeline
  const api = { uploadInvoice: async () => { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, one, { api, validate: async (v) => ({ status: 'valid', vat: v }), now: new Date('2026-11-24T12:00:00Z') });
  db.prepare("UPDATE invoices SET sending_at=? WHERE seller_id=? AND sending_at IS NOT NULL").run(new Date(Date.now() - 3600e3).toISOString(), sid); // the seller's check must come after the attempt; minute-precision form input
  const num = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' LIMIT 1").get(sid).number;
  openOriginalHold(db, sid, 'SHIPMENT:S9', [{ c: 'invoice-number', why: 'The report does not name our invoice number.' }], { number: num, status: 'InvoiceUploaded', reportSeq: 2 });
  writeLedger(db, sid, 'REFUND:T2', [{ code: 'REFUND_ROW_INVOICE_STATUS', severity: 'HOLD', resolution: 'NEW_EVIDENCE', evidence: { field: 'refund-row-invoice-status', reportStatus: 'InvoiceUploaded' }, fingerprint: 'a'.repeat(64), explanation: 'A refund row in the Amazon report carries an invoice status.', action: 'x' }], { partial: true });
  openCreditNoteHold(db, sid, 'REFUND:CorrectionReversal:X:1', 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'The report names another document.' }]);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.setCookie({ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base });
    const click = (txt) => page.evaluate((t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t)?.click(), txt);
    await page.goto(base + '/app'); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Documents'), { timeout: 8000 }); await click('Documents');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Holds')); await click('Holds');
    await page.waitForSelector('[data-summary]'); const sum = await page.$eval('[data-summary]', e => e.innerText); assert.match(sum, /4 open/); assert.match(sum, /2 waiting for you/); assert.match(sum, /1 waiting for new Amazon evidence/); assert.match(sum, /1 that cannot be released/);
    // plain words on every card outside the evidence details: no raw code names, no UTC timestamps, no "undefined"
    const cards = await page.$$eval('[data-hold]', els => els.map(e => { const c = e.cloneNode(true); c.querySelectorAll('details,textarea,input,select,option').forEach(n => n.remove()); return { code: e.dataset.hold, text: c.innerText }; }));
    assert.equal(cards.length, 4); for (const c of cards) { assert.ok(!/undefined|null|NaN|[A-Z]{3,}_[A-Z_]+|\d{4}-\d\d-\d\dT\d\d:/.test(c.text), c.code + ' shows raw text: ' + (c.text.match(/undefined|null|NaN|[A-Z]{3,}_[A-Z_]+|\d{4}-\d\d-\d\dT\d\d:/) || [])[0]); assert.match(c.text, /What resolves this/); }
    const orig = '[data-hold="ORIGINAL_INVOICE_VERDICT_UNPROVEN"]'; const oText = await page.$eval(orig, e => e.innerText); assert.match(oText, /could not be confirmed/); assert.match(oText, new RegExp(num)); assert.match(oText, /All statuses view/); assert.match(oText, /Waiting for new Amazon evidence/);
    // REFUND: no decision form, says nobody can release it
    const ref = await page.$eval('[data-hold="REFUND_ROW_INVOICE_STATUS"]', e => ({ t: e.innerText, buttons: [...e.querySelectorAll('button')].map(b => b.textContent.trim()) })); assert.match(ref.t, /No one can release this hold/); assert.ok(!ref.buttons.some(b => /decision|authorize|confirm/i.test(b)), 'no release action: ' + ref.buttons);
    // a hostile note is saved and shown as text; it changes no state
    const findingsBefore = JSON.stringify(db.prepare('SELECT * FROM integrity_findings ORDER BY 1,2,3').all()); const invBefore = JSON.stringify(db.prepare('SELECT * FROM invoices ORDER BY 1,2').all());
    await page.type(orig + ' [data-notes] textarea', '<img src=x onerror=window.__xss=1> asked the seller for the All view'); await page.evaluate((s) => [...document.querySelectorAll(s + ' button')].find(b => /Save note/.test(b.textContent)).click(), orig);
    await page.waitForFunction(() => document.body.innerText.includes('Note saved. It changed nothing.'), { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__xss), undefined); assert.equal(await page.evaluate(() => document.querySelectorAll('#app img').length), 0); assert.match(await page.$eval(orig + ' [data-notes]', e => e.innerText), /asked the seller for the All view/);
    assert.equal(db.prepare("SELECT count(*) c FROM events WHERE type='hold_note'").get().c, 1); assert.equal(JSON.stringify(db.prepare('SELECT * FROM integrity_findings ORDER BY 1,2,3').all()), findingsBefore); assert.equal(JSON.stringify(db.prepare('SELECT * FROM invoices ORDER BY 1,2').all()), invBefore);
    // the credit note hold keeps its evidence-bound decision form (too-short reason refused, nothing recorded)
    const cn = '[data-hold="CREDIT_NOTE_IDENTITY_UNPROVEN"]'; await page.type(cn + ' textarea[aria-label="Reason for the decision"]', 'short'); await page.evaluate((s) => [...document.querySelectorAll(s + ' button')].find(b => /Record my decision/.test(b.textContent)).click(), cn);
    await page.waitForFunction((s) => document.querySelector(s).innerText.includes('at least 10 characters'), {}, cn); assert.equal(db.prepare('SELECT count(*) c FROM integrity_decisions').get().c, 0);
    // the unknown-outcome hold: the authorize-one-retry form is in the same inbox. Without the risk box it is refused and nothing is recorded; with everything it is recorded once.
    const unk = '[data-hold="UPLOAD_OUTCOME_UNKNOWN"]'; await page.waitForSelector(unk); const uText = await page.$eval(unk, e => e.innerText); assert.match(uText, /two submissions/); assert.match(uText, /Nothing resends it automatically/);
    const fill = async (label, value) => { await page.$eval(`${unk} [aria-label="${label}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, value); };
    const now = new Date(Date.now() - 60e3); const local = new Date(now.getTime() - now.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    await fill('Who checked Seller Central', 'Reviewer A'); await fill('When you checked', local); await fill('What the check found', 'document_not_found'); await fill('Why a retry is justified (10+ characters)', 'Checked Seller Central, no such document');
    await page.evaluate((s) => [...document.querySelectorAll(s + ' button')].find(b => /authorize ONE retry/.test(b.textContent)).click(), unk);
    await page.waitForFunction((s) => /residual risk/i.test(document.querySelector(s).innerText) && document.querySelector(s + ' .err'), {}, unk); assert.equal(db.prepare("SELECT count(*) c FROM events WHERE type='unknown_retry_authorized'").get().c, 0, 'refused without the risk box');
    await page.$eval(unk + ' input[type=checkbox]', e => e.click()); await page.evaluate((s) => [...document.querySelectorAll(s + ' button')].find(b => /authorize ONE retry/.test(b.textContent)).click(), unk);
    await page.waitForFunction(() => document.body.innerText.includes('Recorded. Nothing was sent by this step'), { timeout: 10000 }).catch(async e => { console.log('PAGE:', await page.$eval(unk, x => x.innerText.slice(-500))); throw e; });
    assert.equal(db.prepare("SELECT count(*) c FROM events WHERE type='unknown_retry_authorized'").get().c, 1); assert.equal(await page.$$eval('[data-hold="UPLOAD_OUTCOME_UNKNOWN"]', e => e.length), 0, 'the authorized item left the open list');
    const sum2 = await page.$eval('[data-summary]', e => e.innerText); assert.match(sum2, /3 open/);
    assert.equal(db.prepare("SELECT status FROM integrity_findings WHERE code='ORIGINAL_INVOICE_VERDICT_UNPROVEN'").get().status, 'OPEN', 'the original hold is still open: only new evidence resolves it');
  } finally { await browser.close(); server.close(); }
});
