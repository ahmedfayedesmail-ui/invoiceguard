// A11y: the dashboard tabs and the section sub-tabs are real tablists - tab/tabpanel wiring, aria-selected,
// roving tabindex, Arrow/Home/End navigation - and toast() uses a colour variable that actually exists.
// Real headless Chrome, synthetic data only. Skips locally without Chrome, FAILS when CI=true.
import puppeteer from 'puppeteer-core'; import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync } from 'node:fs';
import { createApp } from '../src/app.js';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const SKIP = !existsSync(CHROME) && process.env.CI !== 'true' && 'Chrome not found (skipped locally)';
const DASH = '[role=tablist][aria-label="Sections"]', DOCS = '[role=tablist][aria-label="Document sections"]';

// A demo-mode seller on the dashboard, exactly the state the tabs live in.
async function bootDashboard() {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test' });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const r1 = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a11y@example.test', password: 'Long-Enough-Pw-42!' }) });
  const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  await fetch(base + '/api/seller', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }) });
  await fetch(base + '/api/amazon/connect', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ demo: true }) });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setCookie({ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base });
  await page.goto(base + '/app');
  await page.waitForSelector('[role=tablist] [role=tab]', { timeout: 20000 });
  return { browser, server, page };
}

// Everything the tab semantics promise, read straight off the live DOM. A tablist is looked up by its
// accessible name, so an unnamed (or absent) tablist reports as missing instead of throwing.
const readTabs = (sel) => {
  const list = document.querySelector(sel);
  if (!list) return { missing: true };
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const sel2 = tabs.filter(t => t.getAttribute('aria-selected') === 'true');
  const panelId = tabs.length ? tabs[0].getAttribute('aria-controls') : null;
  const panel = panelId ? document.getElementById(panelId) : null;
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
  return {
    label: list.getAttribute('aria-label'), role: list.getAttribute('role'),
    texts: tabs.map(t => t.textContent.trim()), ids: tabs.map(t => t.id),
    selected: sel2.map(t => t.id), tabindex: tabs.map(t => t.getAttribute('tabindex')),
    controls: tabs.map(t => t.getAttribute('aria-controls')),
    panel: panel && { id: panel.id, role: panel.getAttribute('role'), labelledby: panel.getAttribute('aria-labelledby'), tabindex: panel.getAttribute('tabindex'), text: panel.innerText.slice(0, 400) },
    dupIds: ids.length - new Set(ids).size,
  };
};

test('A11Y1 the dashboard tabs are a tablist with tabpanel wiring and Arrow/Home/End move the selection', { timeout: 120000, skip: SKIP }, async () => {
  const { browser, server, page } = await bootDashboard();
  try {
    const s = await page.evaluate(readTabs, DASH);
    assert.ok(!s.missing, 'the dashboard tab bar is a tablist with an accessible name');
    assert.equal(s.role, 'tablist');
    assert.equal(s.label, 'Sections');
    assert.deepEqual(s.texts, ['Shipments', 'Documents', 'Compliance', 'Export', 'Help']);
    assert.deepEqual(s.selected, ['dash-tab-overview'], 'exactly one tab is selected');
    assert.equal(s.tabindex[0], '0', 'the selected tab is in the tab order');
    assert.deepEqual(s.tabindex.slice(1), ['-1', '-1', '-1', '-1'], 'the other tabs are not separate tab stops');
    assert.deepEqual([...new Set(s.controls)], ['dash-panel'], 'every tab names the panel it controls');
    assert.ok(s.panel, 'aria-controls points at a panel that exists');
    assert.equal(s.panel.role, 'tabpanel');
    assert.equal(s.panel.id, 'dash-panel');
    assert.equal(s.panel.labelledby, 'dash-tab-overview', 'the panel is labelled by the selected tab');
    assert.equal(s.panel.tabindex, '0', 'the panel is reachable with the keyboard');
    assert.equal(s.dupIds, 0, 'no duplicate element ids on the page');

    // ArrowRight: selection, focus and the panel all follow the key.
    await page.focus('#dash-tab-overview'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('dash-tab-docs')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    let now = await page.evaluate(readTabs, DASH);
    assert.deepEqual(now.selected, ['dash-tab-docs']);
    assert.equal(now.panel.labelledby, 'dash-tab-docs', 'the panel re-labels itself to the new tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dash-tab-docs', 'focus lands on the newly selected tab');
    assert.match(now.panel.text, /Invoices/, 'the Documents section is what is shown');
    assert.deepEqual(now.tabindex, ['-1', '0', '-1', '-1', '-1'], 'the roving tabindex follows the selection');

    // ArrowRight again -> Compliance, and the panel content changes with it.
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('dash-tab-compliance')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    now = await page.evaluate(readTabs, DASH);
    assert.deepEqual(now.selected, ['dash-tab-compliance']);
    assert.match(now.panel.text, /Needs you before the deadline/);

    // End -> last tab, Home -> first tab.
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.getElementById('dash-tab-help')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    now = await page.evaluate(readTabs, DASH);
    assert.deepEqual(now.selected, ['dash-tab-help']);
    assert.match(now.panel.text, /Connect your real Amazon account/);
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.getElementById('dash-tab-overview')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });

    // ArrowLeft from the first tab wraps to the last one.
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.getElementById('dash-tab-help')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dash-tab-help', 'wrap-around keeps focus on the tab');
  } finally { await browser.close(); server.close(); }
});

test('A11Y2 a tab stays a real button (Enter activates it), the section sub-tabs are wired the same way, and toast() uses a defined colour', { timeout: 120000, skip: SKIP }, async () => {
  const { browser, server, page } = await bootDashboard();
  try {
    const s0 = await page.evaluate(readTabs, DASH);
    assert.ok(!s0.missing, 'the dashboard tab bar is a tablist with an accessible name');

    // Enter on a focused tab activates it: the tabs are still ordinary buttons.
    await page.focus('#dash-tab-export'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('dash-tab-export')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    let now = await page.evaluate(readTabs, DASH);
    assert.deepEqual(now.selected, ['dash-tab-export']);
    assert.match(now.panel.text, /Export for your accountant/);

    // Documents -> its sub-tabs are a tablist of their own, with the same wiring.
    await page.evaluate(() => [...document.querySelectorAll('[role=tablist] [role=tab]')].find(b => b.textContent.trim() === 'Documents').click());
    await page.waitForSelector(DOCS + ' [role=tab]', { timeout: 10000 });
    let sub = await page.evaluate(readTabs, DOCS);
    assert.ok(!sub.missing, 'the section sub-tabs are a tablist with an accessible name');
    assert.equal(sub.role, 'tablist');
    assert.equal(sub.label, 'Document sections');
    assert.deepEqual(sub.texts, ['Invoices', 'Repairs', 'Holds']);
    assert.deepEqual(sub.selected, ['docs-tab-invoices']);
    assert.deepEqual([...new Set(sub.controls)], ['docs-panel']);
    assert.ok(sub.panel, 'the sub-tabs control a panel that exists');
    assert.equal(sub.panel.role, 'tabpanel');
    assert.equal(sub.panel.labelledby, 'docs-tab-invoices');
    assert.deepEqual(sub.tabindex, ['0', '-1', '-1']);
    assert.equal(sub.dupIds, 0, 'the nested tablists introduce no duplicate ids');

    // Arrow navigation inside the sub-tabs, and the panel follows.
    await page.focus('#docs-tab-invoices'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('docs-tab-repairs')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    sub = await page.evaluate(readTabs, DOCS);
    assert.deepEqual(sub.selected, ['docs-tab-repairs']);
    assert.equal(sub.panel.labelledby, 'docs-tab-repairs');
    assert.match(sub.panel.text, /Repairs/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'docs-tab-repairs');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.getElementById('docs-tab-holds')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.getElementById('docs-tab-invoices')?.getAttribute('aria-selected') === 'true', { timeout: 10000 });

    // toast() used var(--err), which is defined nowhere, so the border fell back to a one-off hex. It now uses --red.
    const border = await page.evaluate(() => { window.toast('colour check'); const t = [...document.body.children].filter(e => e.getAttribute('role') === 'alert').pop(); return t ? getComputedStyle(t).borderTopColor : null; });
    assert.equal(border, 'rgb(198, 40, 40)', 'the toast border uses the app red (#c62828), not an undefined variable');
  } finally { await browser.close(); server.close(); }
});
