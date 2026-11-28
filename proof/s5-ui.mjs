import puppeteer from 'puppeteer-core';
import { startServer, signup, vidrOf, sleep } from './lib.mjs';
import { rmSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'happy'; // happy | restart
const dbFile = '/tmp/p5.db'; for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
let srv = await startServer({ dbFile, port: 4120 }); const base = 'http://127.0.0.1:4120';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
const page = await browser.newPage(); await page.setViewport({ width: 900, height: 1500 });
await page.goto(base); 
await page.evaluate(async () => { const p = (u, b) => fetch('/api/' + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); await p('signup', { email: 'ui@x.es', password: 'Long-Enough-Pw-42!' }); await p('seller', { name: 'Tienda UI S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }); await p('amazon/connect', { manual: true }); });
await page.reload(); await sleep(800);
const snap = async (path) => { await page.evaluate(() => { const b = [...document.querySelectorAll('button.pri')].find(b => /^Creat/.test(b.textContent)); (b?.closest('.card') ?? b)?.scrollIntoView({ block: 'center' }); const st = document.querySelector('[role=status]'); if (!b && st) st.scrollIntoView({ block: 'center' }); }); await sleep(100); await page.screenshot({ path }); };
const clickText = (t) => page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t || b.textContent.startsWith(t)); if (b) { b.click(); return true; } return false; }, t);
await clickText('Upload report'); await sleep(500);
const rows = mode === 'restart' ? 3000 : 3000; writeFileSync('/tmp/ui/report.tsv', vidrOf(rows));
const fi = await page.$('input[type=file]'); await fi.uploadFile('/tmp/ui/report.tsv'); await page.waitForFunction(() => /We read your file/.test(document.body.innerText), { timeout: 30000 }); await sleep(500);
await page.evaluate(() => document.querySelectorAll('input[type=checkbox]').forEach(c => { const t = c.parentElement?.innerText ?? ''; if (!c.checked && !/no billing address/.test(t)) c.click(); }));
await page.screenshot({ path: `/tmp/ui/${mode}-1-preview.png` });
// a competing job from another seller occupies the FIFO so ours is visibly QUEUED first (happy mode)
let other = null; if (mode === 'happy') { other = await signup(base, 'ui-other@x.es'); await other('manual/issue', { text: vidrOf(1500, 1000000, '999'), attest: true }); await sleep(200); }
const trace = []; const t0 = Date.now(); const clicked0 = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).join(' | ')); console.error('buttons before click:', clicked0);
const sampler = setInterval(async () => { try { const x = await page.evaluate(() => ({ btn: [...document.querySelectorAll('button.pri')].map(b => b.textContent + (b.disabled ? ' [disabled]' : '')).join(' | '), status: document.querySelector('[role=status]')?.textContent ?? '', statusClass: document.querySelector('[role=status]')?.className ?? '' })); const last = trace.at(-1); if (!last || last.btn !== x.btn || last.status !== x.status) trace.push({ ms: Date.now() - t0, ...x }); } catch {} }, 150);
await clickText('Create 2700'); await sleep(300); await snap(`/tmp/ui/${mode}-2-after-click-queued.png`);
if (mode === 'happy') {
  await page.waitForFunction(() => /of 2700/.test(document.body.innerText), { timeout: 60000 }); await sleep(1500); await snap(`/tmp/ui/happy-3-running.png`);
  await page.waitForFunction(() => /ready|Ready|issued|Shipments/i.test(document.querySelector('.tabs')?.innerText ?? '') && !/Creating invoices/.test(document.body.innerText), { timeout: 90000 }); await sleep(800); await page.screenshot({ path: `/tmp/ui/happy-4-done.png` });
} else if (mode === 'fast') {
  await page.waitForFunction(() => /of 2700/.test(document.body.innerText), { timeout: 60000 }); await sleep(1500); srv.kill('SIGKILL'); srv = await startServer({ dbFile, port: 4120 }); await sleep(2500); await snap('/tmp/ui/fast-3-after-fast-restart.png');
} else {
  await page.waitForFunction(() => /of 2700/.test(document.body.innerText), { timeout: 60000 }); await sleep(2500); await snap(`/tmp/ui/restart-3-running-before-kill.png`);
  srv.kill('SIGKILL'); await sleep(2500); await snap(`/tmp/ui/restart-4-server-down.png`);
  srv = await startServer({ dbFile, port: 4120 }); await sleep(3500); await snap(`/tmp/ui/restart-5-server-back.png`);
  // what the seller sees if they reload the page after the restart, then re-upload
  await page.reload(); await sleep(1200); await clickText('Upload report'); await sleep(500); await page.screenshot({ path: `/tmp/ui/restart-6-reload-upload-tab.png` });
}
clearInterval(sampler);
const body = await page.evaluate(() => document.body.innerText.slice(0, 1200));
writeFileSync(`/tmp/ui/${mode}-trace.json`, JSON.stringify({ mode, trace, finalPageText: body }, null, 1)); console.log(JSON.stringify(trace, null, 1)); console.log(body.slice(0, 600));
await browser.close(); srv.kill('SIGKILL'); process.exit(0);
