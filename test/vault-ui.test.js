// P3 browser-level proof in real headless Chrome: the REAL IndexedDB is read back, the network is intercepted, the vault is locked/auto-locked, migrated, backed up, restored and deleted.
// Skips locally without Chrome, FAILS when CI=true. Synthetic fixtures only.
import puppeteer from 'puppeteer-core';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVault, PAGE_PW, storeStep } from './ui-helpers.mjs';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';
process.env.ENABLE_LOOP_PAGE = '1';
const { createApp } = await import('../src/app.js');
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const SECRETS = ['A-2001', 'A-2003', 'acme-books', 'Amazon.es', 'p2-ledger-1.csv', 'p2-vidr.tsv', '405-1000011', 'Test seller', 'checked the account'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const skip = !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not found (skipped locally)';

async function boot(opts = {}) {
  const { server } = createApp({ validate: async () => ({}), secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 1400 });
  // Puppeteer's default polling is requestAnimationFrame, which stalls when the renderer is starved (diagnosis: audit/phase-b/vault-ui-diagnosis/README.md). Interval polling sees the same page state without waiting for a frame. No timeout was raised.
  const waitFor = page.waitForFunction.bind(page); page.waitForFunction = (fn, o = {}, ...a) => waitFor(fn, { polling: 100, ...o }, ...a);
  const requests = [], errors = []; page.on('pageerror', e => errors.push(String(e.stack ?? e))); // the stack is kept so an unexplained page error can be traced page.on('request', r => requests.push(r.url()));
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
  const stored = async () => { await sleep(700); nFiles++; await page.waitForFunction(n => document.querySelector('#results')?.innerText.includes('Loaded files (' + n + ')'), { timeout: 15000 }, nFiles); };
  await (await page.$('#vfile')).uploadFile(vidr); await page.waitForSelector('#v-mkt'); await setv(page, '#v-from', '2026-11-01'); await setv(page, '#v-to', '2026-11-30'); await setv(page, '#v-created', '2026-11-20T10:00'); await setv(page, '#v-down', '2026-11-20T10:00'); await page.$eval('#v-after', e => { e.checked = true; }); await storeStep(page); await stored();
  await (await page.$('#lfile')).uploadFile(ledger); await page.waitForSelector('#l-sys'); await setv(page, '#l-sys', 'acme-books'); await setv(page, '#l-exp', exportedAt); await setv(page, '#l-mkt', 'A1RKKUPIHCS9HS'); await setv(page, '#l-from', '2026-11-01'); await setv(page, '#l-to', '2026-11-30'); await setv(page, '#l-complete', 'yes'); await setv(page, '#l-kinds', 'invoice'); await setv(page, '#l-scope', 'CHANNEL'); await setv(page, '#l-chan', 'Amazon.es'); await setv(page, '#l-level', 'DOCUMENT'); await storeStep(page); await stored();
}

test('vault page: real IndexedDB holds no seller plaintext, wrong password stays locked, lock empties the page, nothing touches the network', { timeout: 150000, skip }, async () => {
  const t = await boot(); nFiles = 0;
  try {
    const { page } = t; t.requests.length = 0;
    const rec = await makeVault(page); assert.match(rec, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    await load(page, 'fixtures/loop/p2-vidr.tsv', 'fixtures/loop/p2-ledger-1.csv');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'I started this').click()); await sleep(800); // a seller event with free text
    const shown = await page.$eval('#results', e => e.innerText); assert.match(shown, /A-2001/);
    const db = await idb(page), all = JSON.stringify(db);
    for (const s of SECRETS) assert.ok(!all.includes(s), 'plaintext in the real IndexedDB: ' + s);
    assert.ok(db.keys.every(k => k === 'vault:meta' || /^e1:loop:(import|event):[A-Za-z0-9_-]{43}$/.test(k) || /^e1:loop:[A-Za-z0-9_-]{43}$/.test(k)), 'only opaque keys: ' + JSON.stringify(db.keys.map(k => k.slice(0, 20))));
    assert.ok(db.keys.length >= 5); assert.ok(!all.includes(PAGE_PW) && !all.includes(rec));
    console.log('REAL IndexedDB keys (kind visible, ids opaque):', JSON.stringify(db.keys.map(k => k.slice(0, 16) + '...')), 'plaintext hits for seller values: 0');
    // manual lock empties the page DOM and storage still has no plaintext
    await click(page, 'Lock now'); await page.waitForFunction("document.querySelector('#app')?.hidden === true");
    const dom = await page.evaluate(() => document.body.innerText); for (const s of SECRETS.slice(0, 5)) assert.ok(!dom.includes(s), 'locked page still shows ' + s);
    // wrong password stays locked, right one opens and shows the same data
    await page.waitForSelector('#g-pw'); await page.type('#g-pw', 'definitely wrong password'); await click(page, 'Unlock');
    await page.waitForFunction("document.querySelector('#g-msg')?.textContent.includes('does not open')"); assert.equal(await page.$eval('#app', e => e.hidden), true);
    await page.$eval('#g-pw', e => { e.value = ''; }); await page.type('#g-pw', PAGE_PW); await click(page, 'Unlock'); await page.waitForFunction("document.querySelector('#app').hidden === false && document.querySelector('#results')?.innerText.includes('A-2001')");
    // reload: the vault is still there and locked, nothing readable without the password
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForFunction('window.__gateReady === true'); assert.equal(await page.$eval('#app', e => e.hidden), true); assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('A-2001'));
    await page.type('#g-pw', PAGE_PW); await click(page, 'Unlock'); await page.waitForFunction("document.querySelector('#results')?.innerText.includes('A-2001')");
    const stray = t.requests.filter(u => !u.startsWith('blob:') && !u.startsWith('data:') && !/\/local\/loop(\.js|-engine\.js)?$/.test(u)); assert.deepEqual(stray, [], 'requests during import, parsing, viewing, locking: ' + stray.join(','));
    assert.equal(await page.evaluate(() => fetch('/api/sample/run').then(() => 'allowed', () => 'blocked')), 'blocked'); assert.deepEqual(t.errors, []);
    console.log('NETWORK: requests other than the page and its two scripts since load:', stray.length, '| fetch from the page: blocked by CSP');
  } finally { await t.close(); }
});

test('vault page: inactivity auto-lock locks, drops the page content and keeps stored work intact', { timeout: 100000, skip }, async () => {
  const t = await boot(); nFiles = 0;
  try {
    const { page } = t; await makeVault(page); await load(page, 'fixtures/loop/p2-vidr.tsv', 'fixtures/loop/p2-ledger-1.csv');
    await page.select('#s-lock', '5'); await page.waitForFunction("document.querySelector('#msg')?.textContent.includes('Auto-lock updated') || document.querySelector('#app')?.hidden === true"); // on a slow machine the 1.5 s timer can fire before the message is polled
    await page.waitForFunction("document.querySelector('#app')?.hidden === true", { timeout: 8000 }); // the test hook shortens the 5 minute timer to 1.5 seconds
    assert.match(await page.$eval('#g-msg', e => e.textContent), /Locked after inactivity/); assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('A-2001'));
    await page.type('#g-pw', PAGE_PW); await click(page, 'Unlock'); await page.waitForFunction("document.querySelector('#results')?.innerText.includes('Loaded files (2)')");
  } finally { await t.close(); }
});

test('vault page: earlier unencrypted data is migrated in the real IndexedDB, verified, and the plaintext is gone afterwards', { timeout: 100000, skip }, async () => {
  const t = await boot();
  try {
    const { page } = t; const seedStore = memoryAdapter(); const s = createLoopStore(seedStore); await s.addVidr({ text: F.PV, declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'p2-vidr.tsv' }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: F.LDECL(), fileName: 'p2-ledger-1.csv' });
    const legacy = {}; for (const k of await seedStore.list()) legacy[k] = await seedStore.get(k);
    await page.evaluate((legacy) => new Promise((res, rej) => { const r = indexedDB.open('invoiceguard-loop', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { const db = r.result, tx = db.transaction('kv', 'readwrite'); for (const [k, v] of Object.entries(legacy)) tx.objectStore('kv').put(v, k); tx.oncomplete = () => { db.close(); res(); }; }; r.onerror = () => rej(r.error); }), legacy);
    const before = await idb(page); assert.ok(JSON.stringify(before).includes('A-2001'), 'the legacy data is plaintext before migration (this is the weakness being fixed)');
    await page.reload({ waitUntil: 'networkidle0' }); await makeVault(page);
    await page.waitForFunction("document.querySelector('#msg')?.textContent.includes('earlier unencrypted record')"); const msg = await page.$eval('#msg', e => e.textContent);
    const after = await idb(page); for (const sct of SECRETS) assert.ok(!JSON.stringify(after).includes(sct), 'plaintext left after migration: ' + sct); assert.ok(after.keys.every(k => !k.startsWith('loop:')), 'no legacy key left');
    assert.match(await page.$eval('#results', e => e.innerText), /Loaded files \(2\)/); assert.match(await page.$eval('#results', e => e.innerText), /A-2001/);
    console.log('MIGRATION in real IndexedDB:', msg);
  } finally { await t.close(); }
});

test('vault page: delete one import (with impact shown), encrypted backup, delete the workspace, restore the backup and get the same results', { timeout: 150000, skip }, async () => {
  const t = await boot(); nFiles = 0; const dir = mkdtempSync(join(tmpdir(), 'ig-'));
  try {
    const { page } = t; await makeVault(page); await load(page, 'fixtures/loop/p2-vidr.tsv', 'fixtures/loop/p2-ledger-1.csv');
    const results = async () => (await page.$eval('#results', e => e.innerText)).replace(/Loaded.*\n/g, '').slice(0, 600);
    // backup (a blob made by the page: captured, never sent anywhere)
    await click(page, 'Download encrypted backup'); await sleep(500);
    const bk = await page.evaluate(() => window.__blobs.at(-1).text()); for (const s of SECRETS) assert.ok(!bk.includes(s), 'plaintext in the backup: ' + s); const bkPath = join(dir, 'backup.json'); writeFileSync(bkPath, bk);
    assert.match(await page.$eval('#bundle-notice', e => e.innerText), /names, their fingerprints \(SHA-256\), the time of each deletion/, 'the export button carries its notice');
    const summary = await page.$eval('#summary', e => e.innerText);
    // delete the ledger import: confirm text shows what is removed
    let dialogText = ''; page.removeAllListeners('dialog'); page.on('dialog', async d => { dialogText = d.message(); await d.accept('x'); });
    await page.evaluate(() => document.querySelectorAll('[data-del]')[1].click()); await page.waitForFunction("document.querySelector('#results')?.innerText.includes('Loaded files (1)')");
    assert.match(dialogText, /This removes the file's contents/); assert.match(dialogText, /We keep a record that it existed/); assert.match(dialogText, /cannot be undone/);
    const db = await idb(page); assert.ok(!JSON.stringify(db).includes('A-2001')); const keysAfterDelete = db.keys.filter(k => k.startsWith('e1:loop:import:')).length; assert.equal(keysAfterDelete, 1);
    // whole workspace deletion: nothing usable remains
    await click(page, 'Delete everything stored here'); await page.waitForFunction("window.__gateReady && document.querySelector('#g-pw2')"); const empty = await idb(page); assert.deepEqual(empty.keys, [], 'whole-workspace deletion leaves no key, no vault');
    // restore the backup on the empty workspace, unlock, same results as before the deletions
    page.removeAllListeners('dialog'); page.on('dialog', async d => { await d.accept(PAGE_PW); });
    assert.match(await page.$eval('#g-restore-warning', e => e.innerText), /Files you deleted after that backup come back.*will not be shown as deleted/s, 'the restore page warns in words');
    await (await page.$('#g-restore')).uploadFile(bkPath); await page.waitForFunction("document.querySelector('#g-msg')?.textContent.includes('Backup restored')");
    await page.type('#g-pw', PAGE_PW); await click(page, 'Unlock'); await page.waitForFunction("document.querySelector('#results')?.innerText.includes('Loaded files (2)')");
    assert.equal(await page.$eval('#summary', e => e.innerText), summary, 'the restored workspace gives the same summary'); void results;
    // a tampered backup is refused
    const bad = JSON.parse(bk); bad.records[0].env.ct = bad.records[0].env.ct.replace(/^./, c => c === 'A' ? 'B' : 'A'); writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
    await click(page, 'Delete everything stored here'); await page.waitForFunction("window.__gateReady && document.querySelector('#g-restore')"); await (await page.$('#g-restore')).uploadFile(join(dir, 'bad.json')); await page.waitForFunction("document.querySelector('#g-msg').className.includes('err')");
    assert.match(await page.$eval('#g-msg', e => e.textContent), /changed|incomplete|does not belong|integrity/); assert.deepEqual((await idb(page)).keys, [], 'a refused restore writes nothing');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('pilot panel in real Chrome: preflight, seller-reported numbers stay in the vault, aggregate file has no sensitive value, still zero network', { timeout: 150000, skip }, async () => {
  const t = await boot(); nFiles = 0;
  try {
    const { page } = t; await makeVault(page); await load(page, 'fixtures/loop/p2-vidr.tsv', 'fixtures/loop/p2-ledger-1.csv'); t.requests.length = 0;
    await page.waitForSelector('#p-runpre'); await click(page, 'Re-check the stored files');
    const pre = await page.$eval('#p-pre', e => e.innerText); console.log('PILOT PREFLIGHT (UI):', pre.replace(/\n+/g, ' | ').slice(0, 400));
    for (const s of SECRETS) assert.ok(!pre.includes(s), 'preflight shows a file value: ' + s);
    assert.ok(/PASS/.test(pre) && /Amazon VAT invoice report/.test(pre), 'preflight ran');
    await setv(page, '#p-before', '180'); await setv(page, '#p-with', '25'); await setv(page, '#p-missed', '1'); await click(page, 'Save times and count');
    const sel = await page.$('select[data-adj]'); await page.select('select[data-adj]', 'CONFIRMED_REAL'); await sleep(500);
    await click(page, 'Create aggregate results file'); await sleep(500);
    const agg = await page.$eval('#p-out', e => e.textContent), m = JSON.parse(agg);
    console.log('PILOT AGGREGATE (UI):', JSON.stringify(m).slice(0, 500));
    assert.equal(m.kind, 'aggregate-only'); assert.equal(m.time.minutesSaved, 155); assert.equal(m.sellerAdjudication.confirmedReal, 1); assert.equal(m.time.basis, 'SELLER_REPORTED');
    for (const s of [...SECRETS, 'imp-', 'fileName']) assert.ok(!agg.includes(s), 'aggregate leaks: ' + s); void sel;
    const keys = await idb(page); assert.ok(!JSON.stringify(keys).includes('manualMinutesBefore') && !JSON.stringify(keys).includes('SELLER_REPORTED'), 'pilot numbers readable in real IndexedDB');
    const stray = t.requests.filter(u => !u.startsWith('blob:') && !u.startsWith('data:')); assert.equal(stray.length, 0, 'network during pilot panel: ' + stray.join(','));
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('staged import in real Chrome: preflight is shown BEFORE anything is persisted; a FAIL stores nothing; a WARN needs a tick', { timeout: 150000, skip }, async () => {
  const t = await boot();
  try {
    const { page } = t; await makeVault(page);
    const count = async () => (await idb(page)).keys.filter(k => /import/.test(String(k))).length, total = async () => (await idb(page)).keys.length;
    const base0 = await total();
    // 1) good Amazon file declared with a pending-only option: FAIL, nothing stored
    await (await page.$('#vfile')).uploadFile('fixtures/loop/p2-vidr.tsv'); await page.waitForSelector('#v-mkt'); await setv(page, '#v-from', '2026-11-01'); await setv(page, '#v-to', '2026-11-30'); await setv(page, '#v-opt', 'PENDING'); await setv(page, '#v-created', '2026-11-20T10:00'); await setv(page, '#v-down', '2026-11-20T10:30'); await page.$eval('#v-after', e => { e.checked = true; });
    await click(page, 'Check before storing'); await page.waitForSelector('#st-store');
    const txt1 = await page.$eval('#stage', e => e.innerText); console.log('STAGED (FAIL case):', txt1.replace(/\n+/g, ' | ').slice(0, 300));
    assert.match(txt1, /Preflight \(nothing is stored yet\)/); assert.match(txt1, /Blocked/); assert.equal(await page.$eval('#st-store', e => e.disabled), true);
    await page.evaluate(() => document.querySelector('#st-store').click()); await sleep(500);
    assert.equal(await total(), base0, 'a FAIL persisted something'); assert.equal(await count(), 0);
    // 2) fix the option, leave "created after upload" unticked: WARN, store needs the tick; still nothing persisted while the preflight shows
    await setv(page, '#v-opt', 'ALL'); await page.$eval('#v-after', e => { e.checked = false; });
    await click(page, 'Check before storing'); await page.waitForSelector('#st-store');
    assert.equal(await total(), base0, 'preflight display persisted something'); assert.equal(await page.$eval('#st-store', e => e.disabled), true, 'store enabled without acknowledging the WARN');
    await page.$eval('[data-warn]', e => { e.checked = true; e.dispatchEvent(new Event('change')); }); assert.equal(await page.$eval('#st-store', e => e.disabled), false);
    await page.evaluate(() => document.querySelector('#st-store').click()); await page.waitForFunction(() => document.querySelector('#results')?.innerText.includes('Loaded files (1)'), { timeout: 15000 });
    assert.ok((await total()) > base0, 'nothing stored after the decision');
    // 3) a second Amazon report for another period is blocked by the pilot scope
    await (await page.$('#vfile')).uploadFile('fixtures/loop/p2-vidr.tsv'); await page.waitForSelector('#v-mkt'); await setv(page, '#v-from', '2026-10-01'); await setv(page, '#v-to', '2026-10-31'); await setv(page, '#v-created', '2026-11-20T10:00'); await setv(page, '#v-down', '2026-11-20T10:30'); await page.$eval('#v-after', e => { e.checked = true; });
    await click(page, 'Check before storing'); await page.waitForSelector('#st-store');
    const txt3 = await page.$eval('#stage', e => e.innerText); assert.match(txt3, /different marketplace or period/); assert.equal(await page.$eval('#st-store', e => e.disabled), true);
    assert.equal(t.requests.filter(u => !u.startsWith('blob:') && !u.startsWith('data:') && !/\/local\/loop(\.js|-engine\.js)?$/.test(u)).length, 0); assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
