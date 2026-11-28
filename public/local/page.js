import { analyze, samplePdf } from '/local/engine.js';
const $ = (s) => document.querySelector(s), out = $('#out');
const el = (t, props = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : e.setAttribute(k, v); for (const x of kids.flat()) if (x != null) e.append(x.nodeType ? x : String(x)); return e; };

// Network counter: the browser's own resource log, minus the files this page needed to start.
const baseline = new Set(performance.getEntriesByType('resource').map(r => r.name));
$('#loaded').replaceChildren(el('p', {}, 'Files the page loaded at start (not counted): ', [...baseline].map(u => new URL(u).pathname).join(', ')));
const tick = () => { const n = performance.getEntriesByType('resource').filter(r => !baseline.has(r.name)).length; $('#netcount').textContent = String(n); window.__netAfterLoad = n; };
try { new PerformanceObserver(tick).observe({ type: 'resource', buffered: false }); } catch { /* old browser: counter refreshed on each action */ }
setInterval(tick, 1000); tick();

const rows = (items, cols) => el('table', {}, el('tr', {}, cols.map(c => el('th', {}, c[0]))), items.map(i => el('tr', {}, cols.map(c => el('td', {}, c[1](i))))));
async function handle(file) {
  const card = el('div', { class: 'card' }, el('h2', {}, file.name)); out.prepend(card);
  const text = await file.text(); const r = await analyze(text); tick();
  if (!r.ok) { card.append(el('p', { class: 'err' }, r.error)); return; }
  card.append(el('p', { class: 'mut small' }, `${r.formatName} - ${r.rows} data rows${r.truncated ? ' (only the first part was read)' : ''}`),
    el('p', {}, el('span', { class: 'badge b-ok' }, `${r.ready.length} ready to invoice`), ' ', el('span', { class: 'badge b-bad' }, `${r.held.length} held`), ' ', el('span', { class: 'badge b-warn' }, `${r.skipped.length} skipped`)));
  if (r.held.length) card.append(el('h2', {}, 'Held: what is wrong'), rows(r.held, [['Order', (i) => i.orderId], ['Reason', (i) => i.reason]]));
  if (r.ready.length) card.append(el('h2', {}, 'Ready to invoice'), rows(r.ready, [['Order', (i) => i.orderId], ['Buyer', (i) => i.buyer], ['VAT no.', (i) => i.buyerVat], ['Total', (i) => `${i.total} ${i.currency}`],
    ['', (i) => el('button', { class: 'sm', type: 'button' }, 'Sample PDF')]]));
  card.querySelectorAll('button.sm').forEach((b, idx) => b.addEventListener('click', async () => {
    const order = r.ready[idx].orderId; b.disabled = true; b.textContent = 'Working...';
    try { const bytes = await samplePdf(order); window.__lastPdfBytes = bytes; const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); const a = el('a', { href: url, download: `sample-invoice-${order}.pdf` }, 'Download sample PDF'); b.replaceWith(a); }
    catch (e) { b.textContent = 'Failed: ' + e.message; } tick();
  }));
  if (r.skipped.length) card.append(el('details', {}, el('summary', {}, `Skipped (${r.skipped.length})`), rows(r.skipped, [['Order', (i) => i.orderId], ['Why', (i) => i.why]])));
  card.append(el('p', { class: 'mut small' }, 'VIES (EU VAT register) check: not run on this page, see the note above.'));
}
const pick = () => $('#file').click();
$('#pick').addEventListener('click', (e) => { e.stopPropagation(); pick(); }); $('#drop').addEventListener('click', pick);
$('#drop').addEventListener('keydown', (e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
$('#file').addEventListener('change', (e) => [...e.target.files].forEach(handle));
for (const ev of ['dragenter', 'dragover']) $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.remove('over'); });
$('#drop').addEventListener('drop', (e) => [...e.dataTransfer.files].forEach(handle));
window.addEventListener('dragover', (e) => e.preventDefault()); window.addEventListener('drop', (e) => e.preventDefault());
