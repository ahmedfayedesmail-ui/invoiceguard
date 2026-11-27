// Shared by the browser tests (not a test file itself).
export const PAGE_PW = 'correct horse battery';
export async function makeVault(page, pw = PAGE_PW) {
  await page.waitForFunction('window.__gateReady === true'); await page.type('#g-pw', pw); await page.type('#g-pw2', pw);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Create vault').click());
  await page.waitForSelector('#g-rec'); const rec = await page.$eval('#g-rec', e => e.textContent); await page.$eval('#g-saved', e => { e.checked = true; });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Continue').click()); await page.waitForFunction('window.__loopReady === true', { timeout: 20000 }); return rec;
}
// Staged import: "Check before storing" runs the preflight in memory; "Store this file" persists. Ticks every WARN, as a seller would after reading it.
export async function storeStep(page) {
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Check before storing').click());
  await page.waitForFunction(() => document.querySelector('#stage')?.innerText.includes('Preflight') || document.querySelector('#msg')?.className.includes('err'), { timeout: 15000 });
  await page.evaluate(() => { document.querySelectorAll('[data-warn]').forEach(t => { t.checked = true; t.dispatchEvent(new Event('change')); }); const b = document.querySelector('#st-store'); if (b && !b.disabled) b.click(); });
}
