import { createLoopStore, Refused, detectLedgerMapping, indexedDbAdapter } from '/local/loop-engine.js';
const $ = (s) => document.querySelector(s);
const el = (t, props = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : k === 'onclick' ? e.addEventListener('click', v) : e.setAttribute(k, v); for (const x of kids.flat()) if (x != null) e.append(x.nodeType ? x : String(x)); return e; };
const baseline = new Set(performance.getEntriesByType('resource').map(r => r.name));
const net = () => { $('#netcount').textContent = String(performance.getEntriesByType('resource').filter(r => !baseline.has(r.name) && !/^(blob|data):/.test(r.name)).length); };
setInterval(net, 500);
const store = createLoopStore(indexedDbAdapter('invoiceguard-loop'));
const say = (t, bad) => { const m = $('#msg'); m.textContent = t; m.className = 'small' + (bad ? ' err' : ''); };
const field = (label, node) => el('div', {}, el('label', {}, label), node);
const inp = (id, type = 'text', value = '') => { const i = el('input', { id, type }); i.value = value; return i; };
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
const refused = (e) => { if (e instanceof Refused) { say('Not stored. ' + e.reasons.join(' '), true); return; } say('Something went wrong: ' + (e?.message ?? e), true); };
const nowLocal = () => new Date().toISOString().slice(0, 16);

$('#vfile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; if (!f) return; const text = await readFile(f); const form = $('#form'); form.replaceChildren(); say('');
  const box = el('div', { class: 'card' }, el('h3', {}, 'Declare this Amazon report: ' + f.name));
  box.append(el('p', { class: 'small mut' }, 'None of this is guessed from the file. You say how the report was obtained; it is stored with the file.'));
  box.append(el('div', { class: 'row' }, field('Marketplace id (as in the marketplace-id column)', inp('v-mkt', 'text', (() => { const ls = text.split(/\r?\n/), i = ls[0].split('\t').indexOf('marketplace-id'); return i >= 0 && ls[1] ? ls[1].split('\t')[i] : ''; })())), field('Range from', inp('v-from', 'date')), field('Range to', inp('v-to', 'date'))));
  const opt = el('select', { id: 'v-opt' }, el('option', { value: 'ALL' }, 'All statuses'), el('option', { value: 'PENDING' }, 'Pending only')), cb = el('input', { type: 'checkbox', id: 'v-after' });
  box.append(el('div', { class: 'row' }, field('Report options', opt), field('Report created at (UTC)', inp('v-created', 'datetime-local', nowLocal())), field('Downloaded at (UTC)', inp('v-down', 'datetime-local', nowLocal()))));
  box.append(el('label', {}, cb, ' I created this report after my last upload was confirmed in Seller Central'));
  box.append(field('How you obtained it', inp('v-how', 'text', 'downloaded by the seller from Seller Central')));
  box.append(el('button', { onclick: async () => {
    const iso = (v) => v ? new Date(v + (v.length === 16 ? ':00' : '') + 'Z').toISOString() : '';
    const declared = { reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', options: $('#v-opt').value, marketplace: $('#v-mkt').value, rangeFrom: $('#v-from').value, rangeTo: $('#v-to').value, createdAt: iso($('#v-created').value), createdAfterUploadConfirmed: cb.checked, downloadedAt: iso($('#v-down').value), obtainedHow: $('#v-how').value, dateOrderConfirmed: 'DD/MM/YYYY' };
    try { await store.addVidr({ text, declared, fileName: f.name }); form.replaceChildren(); ev.target.value = ''; say('Stored: ' + f.name); await render(); } catch (e) { refused(e); }
  } }, 'Confirm and store'));
  form.append(box);
});

$('#lfile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; if (!f) return; const text = await readFile(f); const form = $('#form'); form.replaceChildren(); say('');
  const m = detectLedgerMapping(text); if (!m.ok) { say(m.error, true); return; }
  const box = el('div', { class: 'card' }, el('h3', {}, 'Confirm how to read: ' + f.name), el('p', { class: 'small mut' }, `${m.rowCount} data rows. Check each column the reader found. Nothing is stored until you confirm.`));
  const sel = {}, tb = el('table', {}, el('tr', {}, el('th', {}, 'Field'), el('th', {}, 'Column'), el('th', {}, 'Result')));
  for (const [name, fd] of Object.entries(m.fields)) {
    const s = el('select', {}, el('option', { value: '' }, '(none)'), ...m.headers.map(h => el('option', { value: h }, h))); s.value = fd.header ?? ''; sel[name] = s;
    tb.append(el('tr', {}, el('td', {}, name), el('td', {}, s), el('td', { class: fd.status === 'DETECTED' || fd.status === 'ABSENT' ? 'mut' : 'err' }, fd.status + (fd.reason ? ': ' + fd.reason : ''))));
  }
  box.append(tb);
  const dates = el('select', {}, ...['ISO', 'DMY', 'MDY'].map(x => el('option', { value: x }, x))); dates.value = m.dateOrder.proposed ?? 'ISO';
  const dec = el('select', {}, el('option', { value: '.' }, 'point (1234.50)'), el('option', { value: ',' }, 'comma (1234,50)')); dec.value = m.decimal.proposed ?? '.';
  box.append(el('div', { class: 'row' }, field('Date order' + (m.dateOrder.status === 'PROVEN' ? ' (proven by the file)' : ' (not proven: choose)'), dates), field('Decimal separator', dec)));
  const kindSel = el('select', {}, el('option', { value: '' }, '(use the kind column)'), el('option', { value: 'invoice' }, 'Every row is an invoice'), el('option', { value: 'credit_note' }, 'Every row is a credit note'));
  if (m.needsKindDeclaration) box.append(field('This file has no document-kind column', kindSel));
  box.append(el('h3', {}, 'What this export covers'));
  const sys = inp('l-sys'), mkt = inp('l-mkt'), pf = inp('l-from', 'date'), pt = inp('l-to', 'date');
  const complete = el('select', { id: 'l-complete' }, el('option', { value: '' }, '(choose)'), el('option', { value: 'yes' }, 'Complete export of that period'), el('option', { value: 'no' }, 'Partial export'));
  const kinds = el('select', { id: 'l-kinds' }, el('option', { value: '' }, '(choose)'), el('option', { value: 'invoice' }, 'Invoices only'));
  const scope = el('select', { id: 'l-scope' }, el('option', { value: '' }, '(choose)'), el('option', { value: 'ALL' }, 'Every document is an Amazon sale'), el('option', { value: 'CHANNEL' }, 'Amazon sales are marked in the channel column'), el('option', { value: 'UNKNOWN' }, 'I cannot say'));
  const level = el('select', { id: 'l-level' }, el('option', { value: '' }, '(choose)'), el('option', { value: 'DOCUMENT' }, 'One row is one whole document'), el('option', { value: 'LINE' }, 'One row is one line item of a document'), el('option', { value: 'UNKNOWN' }, 'I do not know'));
  const chv = inp('l-chan', 'text', 'Amazon.es'), exp = inp('l-exp', 'datetime-local');
  box.append(el('div', { class: 'row' }, field('Accounting system name', sys), field('When this export was created (declared by you, not read from the file)', exp), field('Marketplace id (same as in the Amazon report)', mkt), field('Period from', pf), field('Period to', pt), field('Completeness', complete), field('Document kinds', kinds), field('Amazon scope', scope), field('What one row of the file is', level), field('Channel values meaning Amazon (comma separated)', chv)));
  box.append(el('button', { onclick: async () => {
    const columns = Object.fromEntries(Object.entries(sel).filter(([, s]) => s.value).map(([k, s]) => [k, s.value]));
    const profile = { delimiter: m.delimiter, columns, constantKind: kindSel.value || null, dateOrder: dates.value, decimal: dec.value, thousands: '', unknownColumnsAcknowledged: true, confirmed: true };
    const declared = { exportedAt: exp.value ? new Date(exp.value + (exp.value.length === 16 ? ':00' : '') + 'Z').toISOString() : undefined, sourceSystem: sys.value, marketplace: mkt.value, periodFrom: pf.value, periodTo: pt.value, documentKinds: kinds.value ? [kinds.value] : [], documentLevel: level.value === 'DOCUMENT' || level.value === 'LINE' ? level.value : undefined, complete: complete.value === '' ? undefined : complete.value === 'yes', amazonScope: { mode: scope.value, channelValues: chv.value.split(',').map(x => x.trim()).filter(Boolean) } };
    try { await store.addLedger({ text, profile, declared, fileName: f.name }); form.replaceChildren(); ev.target.value = ''; say('Stored: ' + f.name); await render(); } catch (e) { refused(e); }
  } }, 'Confirm and store'));
  form.append(box);
});

const GROUPS = [['Needs action', i => i.state === 'ACTION_REQUIRED'], ['Needs a human reading', i => i.state === 'OPEN'], ['In progress, waiting for a newer file', i => i.state === 'AWAITING_NEW_EVIDENCE'], ['Reported resolved by you, not confirmed by a file', i => i.state === 'MANUALLY_REPORTED_RESOLUTION'], ['Closed, with evidence from a newer file', i => i.state === 'VERIFIED_CLOSED']];
async function ask(issue, type, extra = {}) {
  const author = prompt('Your name or role (any name you choose):'); if (!author) return; const reasoning = prompt('Your reasoning, in words:'); if (!reasoning) return;
  try { await store.addEvent({ type, issueKey: issue.key, author, reasoning, ...extra }); await render(); } catch (e) { refused(e); }
}
function cardNode(i) {
  const c = i.card, n = el('div', { class: 'card', 'data-state': i.state, 'data-family': i.family, 'data-key': i.key });
  n.append(el('h3', {}, c.title), el('span', { class: 'badge' }, c.stateLabel), el('p', { class: 'kv' }, c.what), el('p', { class: 'small mut' }, c.why));
  if (c.proof.length) n.append(el('p', { class: 'small' }, 'Proof: ' + c.proof.map(p => `${p.role}, ${p.file}${p.rows ? ', rows ' + (Array.isArray(p.rows) ? p.rows.map(x => x.ref ?? JSON.stringify(x)).join(', ') : p.rows) : ''}`).join('; ')));
  if (c.action) n.append(el('p', { class: 'kv' }, el('b', {}, 'What to do: '), c.action));
  n.append(el('p', { class: 'small mut' }, 'Closes when: ' + c.closesWhen)); if (c.stateNote) n.append(el('p', { class: 'small' }, c.stateNote));
  if (i.state !== 'VERIFIED_CLOSED') {
    const b = el('div', {});
    if (i.state === 'ACTION_REQUIRED') b.append(el('button', { class: 'alt', onclick: () => ask(i, 'ACTION_STARTED') }, 'I started this'), ' ');
    if (i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'PROPOSED_LINK_UNCONFIRMED') for (const d of ['CONFIRM', 'REJECT']) b.append(el('button', { class: 'alt', onclick: async () => { const author = prompt('Your name or role:'), reasoning = author && prompt('Your reasoning, in words:'); if (!reasoning) return; try { await store.addEvent({ type: 'LINK_DECISION', ledgerKey: i.subject.ledgerKey, amazonId: i.finding.evidence.candidate.amazonId, decision: d, author, reasoning }); await render(); } catch (e) { refused(e); } } }, d === 'CONFIRM' ? 'Confirm link' : 'Reject link'), ' ');
    if (i.family === 'DATA_MISMATCH' && i.subtype === 'FIELDS_DIFFER') b.append(el('button', { class: 'alt', onclick: () => ask(i, 'DIFFERENCE_EXPLAINED') }, 'Declare: difference explained'));
    const kind = i.family === 'UNMATCHED_DOCUMENT' ? 'NOT_AN_AMAZON_SALE' : i.family === 'BOOKS_GAP' ? 'RESOLUTION_DECLARED' : null;
    if (kind && !(i.family === 'UNMATCHED_DOCUMENT' && i.subtype !== 'NO_CANDIDATE')) b.append(el('button', { class: 'alt', onclick: () => ask(i, 'RESOLUTION_DECLARED', { kind }) }, kind === 'NOT_AN_AMAZON_SALE' ? 'Declare: not an Amazon sale' : 'Declare: resolved'));
    if (b.childNodes.length) n.append(b);
  }
  if (i.history.length > 1) n.append(el('details', {}, el('summary', { class: 'small' }, 'History'), ...i.history.map(h => el('div', { class: 'small mut' }, `${h.file ?? h.import}: ${h.status}${h.note ? ' (' + h.note + ')' : ''}`))));
  return n;
}
async function render() {
  const r = await store.project(), out = $('#results'); out.replaceChildren();
  const b = r.buckets; out.append(el('div', { class: 'card', id: 'summary' }, el('h3', {}, 'Summary'), el('p', { class: 'kv' }, `Matched by invoice number: ${b.matchedByInvoiceNumber} (currency and buyer tax id are compared for each pair; the invoice total, net, VAT, dates and lines are not compared in this version). In progress at Amazon: ${b.inProgressAtAmazon}. Needs action: ${b.needsActionNow}. Needs a human reading: ${b.needsHumanReading}. Waiting for a newer file: ${b.awaitingNewEvidence}. Cannot determine: ${b.cannotDetermine}.`),
    el('p', { class: 'kv' }, el('b', {}, 'Closed with evidence: ' + b.closedWithEvidence), '. Reported resolved by you, not confirmed by a file: ' + b.reportedResolvedBySeller + '. These two numbers are never added.')));
  for (const [name, f] of GROUPS) { const xs = r.issues.filter(f); if (xs.length) out.append(el('details', { class: 'group', open: '' }, el('summary', {}, `${name} (${xs.length})`), ...xs.map(cardNode))); }
  if (r.coverageNotes.length) out.append(el('details', { class: 'group' }, el('summary', {}, `Cannot determine (${b.cannotDetermine})`), ...r.coverageNotes.map(g => el('p', { class: 'small' }, `${g.count} x ${g.note ?? g.reason ?? JSON.stringify(g)}`))));
  const imps = await store.imports(); out.append(el('details', { class: 'group' }, el('summary', {}, `Loaded files (${imps.length})`), el('table', {}, el('tr', {}, el('th', {}, 'File'), el('th', {}, 'Kind'), el('th', {}, 'sha256'), el('th', {}, 'Loaded')), ...imps.map(x => el('tr', {}, el('td', {}, x.fileName ?? x.id), el('td', {}, x.kind), el('td', {}, x.sha256.slice(0, 12)), el('td', {}, x.importedAt))))));
  $('#notchecked').textContent = r.notCheckedInThisVersion.join('; ') + '.';
  net();
}
$('#bundle').addEventListener('click', async () => { const b = await store.bundle(), a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' })), download: 'invoiceguard-loop-bundle.json' }); document.body.append(a); a.click(); a.remove(); });
$('#wipe').addEventListener('click', async () => { if (confirm('Delete every file and note stored in this browser?')) { await store.deleteEverything(); await render(); } });
await render(); window.__loopReady = true;
