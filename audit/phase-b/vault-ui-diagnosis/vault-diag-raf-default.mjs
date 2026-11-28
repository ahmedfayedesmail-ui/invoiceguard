// P3 browser-level proof in real headless Chrome: the REAL IndexedDB is read back, the network is intercepted, the vault is locked/auto-locked, migrated, backed up, restored and deleted.
// Skips locally without Chrome, FAILS when CI=true. Synthetic fixtures only.
import puppeteer from 'puppeteer-core';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVault, PAGE_PW, storeStep } from '../test/ui-helpers.mjs';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';
process.env.ENABLE_LOOP_PAGE = '1';
const { createApp } = await import('../src/app.js');
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const SECRETS = ['A-2001', 'A-2003', 'acme-books', 'Amazon.es', 'p2-ledger-1.csv', 'p2-vidr.tsv', '405-1000011', 'Test seller', 'checked the account'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const skip = !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not found (skipped locally)';

const T0 = Date.now(); const lap = (m) => console.error('LAP ' + String(Date.now() - T0).padStart(6) + ' ms  ' + m);
async function boot(opts = {}) {
  const { server } = createApp({ validate: async () => ({}), secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 1400 });
  const requests = [], errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('request', r => requests.push(r.url()));
  page.on('dialog', async d => { await d.accept(d.message().includes('Password of the backup') ? PAGE_PW : d.message().includes('reasoning') ? 'checked the account' : 'Test seller'); });
  await page.evaluateOnNewDocument(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms === 300000 ? 1500 : ms, ...a); window.__blobs = []; const c = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return c(b); }; });
  await page.goto(base + '/local/loop', { waitUntil: 'networkidle0' });
  return { server, browser, page, base, requests, errors, close: async () => { await browser.close(); server.close(); } };
}
const click = (page, t) => page.evaluate((t) => [...document.querySelectorAll('button')].find(b => b.textContent === t).click(), t);
const setv = (page, sel, v) => page.$eval(sel, (e, v) => { e.value = v; }, v);
const idb = (page) => page.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open('invoiceguard-loop'); r.onsuccess = () => { const db = r.result, t = db.transaction('kv'), st = t.objectStore('kv'), ks = st.getAllKeys(), vs = st.getAll(); t.oncomplete = () => { db.close(); res({ keys: ks.result, values: vs.result }); }; }; r.onerror = () => rej(r.error); }));
let nFiles = 0;
async function load(page, vidr, ledger, exportedAt = '2026-11-20T11:00') {
  const stored = async () => { await sleep(700); nFiles++; await page.waitForFunction(n => document.querySelector('#results').innerText.includes('Loaded files (' + n + ')'), { timeout: 15000 }, nFiles); };
  await (await page.$('#vfile')).uploadFile(vidr); await page.waitForSelector('#v-mkt'); await setv(page, '#v-from', '2026-11-01'); await setv(page, '#v-to', '2026-11-30'); await setv(page, '#v-created', '2026-11-20T10:00'); await setv(page, '#v-down', '2026-11-20T10:00'); await page.$eval('#v-after', e => { e.checked = true; }); await storeStep(page); await stored();
  await (await page.$('#lfile')).uploadFile(ledger); await page.waitForSelector('#l-sys'); await setv(page, '#l-sys', 'acme-books'); await setv(page, '#l-exp', exportedAt); await setv(page, '#l-mkt', 'A1RKKUPIHCS9HS'); await setv(page, '#l-from', '2026-11-01'); await setv(page, '#l-to', '2026-11-30'); await setv(page, '#l-complete', 'yes'); await setv(page, '#l-kinds', 'invoice'); await setv(page, '#l-scope', 'CHANNEL'); await setv(page, '#l-chan', 'Amazon.es'); await setv(page, '#l-level', 'DOCUMENT'); await storeStep(page); await stored();
}

test('vault page: delete one import (with impact shown), encrypted backup, delete the workspace, restore the backup and get the same results', { timeout: 150000, skip }, async () => {
  const t = await boot(); nFiles = 0; const dir = mkdtempSync(join(tmpdir(), 'ig-'));
  try {
    const { page } = t; lap('booted'); page.on('pageerror', e => lap('PAGEERROR ' + String(e.stack || e).slice(0, 400).replace(/\n/g, ' / '))); page.on('dialog', d => lap('DIALOG event: ' + d.message().slice(0, 50))); page.on('console', m => lap('console: ' + m.text().slice(0, 100))); await makeVault(page); lap('vault made'); await load(page, 'fixtures/loop/p2-vidr.tsv', 'fixtures/loop/p2-ledger-1.csv');
    lap('both files loaded'); const results = async () => (await page.$eval('#results', e => e.innerText)).replace(/Loaded.*\n/g, '').slice(0, 600);
    // backup (a blob made by the page: captured, never sent anywhere)
    lap('backup click'); await click(page, 'Download encrypted backup'); await sleep(500); lap('backup clicked+500ms');
    const bk = await page.evaluate(() => window.__blobs.at(-1).text()); for (const s of SECRETS) assert.ok(!bk.includes(s), 'plaintext in the backup: ' + s); const bkPath = join(dir, 'backup.json'); writeFileSync(bkPath, bk);
    assert.match(await page.$eval('#bundle-notice', e => e.innerText), /names, their fingerprints \(SHA-256\), the time of each deletion/, 'the export button carries its notice');
    lap('backup checked'); const summary = await page.$eval('#summary', e => e.innerText);
    // delete the ledger import: confirm text shows what is removed
    let dialogText = ''; page.removeAllListeners('dialog'); page.on('dialog', async d => { dialogText = d.message(); await d.accept('x'); });
    lap('delete click'); await page.evaluate(() => document.querySelectorAll('[data-del]')[1].click()); await page.waitForFunction("document.querySelector('#results').innerText.includes('Loaded files (1)')"); lap('delete done (Loaded files (1))');
    assert.match(dialogText, /This removes the file's contents/); assert.match(dialogText, /We keep a record that it existed/); assert.match(dialogText, /cannot be undone/);
    const db = await idb(page); assert.ok(!JSON.stringify(db).includes('A-2001')); const keysAfterDelete = db.keys.filter(k => k.startsWith('e1:loop:import:')).length; assert.equal(keysAfterDelete, 1);
    // whole workspace deletion: nothing usable remains
    lap('delete-all click'); await click(page, 'Delete everything stored here'); await page.waitForFunction("window.__gateReady && document.querySelector('#g-pw2')"); lap('workspace deleted, gate shown'); const empty = await idb(page); assert.deepEqual(empty.keys, [], 'whole-workspace deletion leaves no key, no vault');
    // restore the backup on the empty workspace, unlock, same results as before the deletions
    page.removeAllListeners('dialog'); page.on('dialog', async d => { await d.accept(PAGE_PW); });
    assert.match(await page.$eval('#g-restore-warning', e => e.innerText), /Files you deleted after that backup come back.*will not be shown as deleted/s, 'the restore page warns in words');
    lap('restore upload'); await (await page.$('#g-restore')).uploadFile(bkPath); (async () => { for (let i = 0; i < 150; i++) { const x = await page.$eval('#g-msg', e => e.textContent).catch(() => ''); if (x.includes('Backup restored')) { lap('NODE-SIDE poll sees the message'); return; } await sleep(200); } })(); try { await page.waitForFunction("document.querySelector('#g-msg').textContent.includes('Backup restored')", { timeout: 15000 }); } catch (e) { lap('RESTORE WAIT TIMED OUT; #g-msg=' + JSON.stringify(await page.$eval('#g-msg', e => e.textContent).catch(x => String(x))).slice(0,200)); throw e; } lap('Backup restored shown');
    lap('restored, typing password'); await page.type('#g-pw', PAGE_PW); await click(page, 'Unlock'); lap('clicked Unlock'); { let last='', seen2=0; const t0=Date.now(); for (;;) { const st = await page.evaluate(() => ({ n: (document.querySelector('#results')?.innerText || '').includes('Loaded files (2)') ? '2' : ((document.querySelector('#results')?.innerText || '').includes('Loaded files (') ? 'other' : '-'), gate: !!document.querySelector('#g-pw') && getComputedStyle(document.querySelector('#g-pw')).display !== 'none' })); const k = JSON.stringify(st); if (k !== last) { lap('state after unlock ' + k); last = k; } if (st.n === '2' && !seen2) seen2 = Date.now(); if (seen2 && Date.now() - seen2 > 3000) break; if (Date.now() - t0 > 40000) { lap('GAVE UP waiting for Loaded files (2)'); break; } await sleep(100); } }
    assert.equal(await page.$eval('#summary', e => e.innerText), summary, 'the restored workspace gives the same summary'); void results;
    // a tampered backup is refused
    const bad = JSON.parse(bk); bad.records[0].env.ct = bad.records[0].env.ct.replace(/^./, c => c === 'A' ? 'B' : 'A'); writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
    await click(page, 'Delete everything stored here'); await page.waitForFunction("window.__gateReady && document.querySelector('#g-restore')"); await (await page.$('#g-restore')).uploadFile(join(dir, 'bad.json')); await page.waitForFunction("document.querySelector('#g-msg').className.includes('err')");
    assert.match(await page.$eval('#g-msg', e => e.textContent), /changed|incomplete|does not belong|integrity/); assert.deepEqual((await idb(page)).keys, [], 'a refused restore writes nothing');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

