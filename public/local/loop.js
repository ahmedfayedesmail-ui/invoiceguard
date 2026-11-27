import { createLoopStore, Refused, detectLedgerMapping, indexedDbAdapter, createVault, migrateLegacy, legacyKeys, preflight, preflightStored, pilotScope, createPilotRecord, aggregateMetrics } from '/local/loop-engine.js';
const $ = (s) => document.querySelector(s);
const el = (t, props = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : k === 'onclick' ? e.addEventListener('click', v) : e.setAttribute(k, v); for (const x of kids.flat()) if (x != null) e.append(x.nodeType ? x : String(x)); return e; };
const baseline = new Set(performance.getEntriesByType('resource').map(r => r.name));
const net = () => { $('#netcount').textContent = String(performance.getEntriesByType('resource').filter(r => !baseline.has(r.name) && !/^(blob|data):/.test(r.name)).length); };
setInterval(net, 500);
const raw = indexedDbAdapter('invoiceguard-loop');
let store = null; // exists only while the vault is unlocked
const vault = createVault(raw, { onLock: (reason) => lockedUi(reason) });
const say = (t, bad) => { const m = $('#msg'); m.textContent = t; m.className = 'small' + (bad ? ' err' : ''); };
const field = (label, node) => el('div', {}, el('label', {}, label), node);
const inp = (id, type = 'text', value = '') => { const i = el('input', { id, type }); i.value = value; return i; };
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
const refused = (e) => { if (e instanceof Refused) { say('Not stored. ' + e.reasons.join(' '), true); return; } say('Something went wrong: ' + (e?.message ?? e), true); };
const nowLocal = () => new Date().toISOString().slice(0, 16);

// Staged import: the file is read and checked in memory; nothing is stored until the preflight decision is complete.
async function stage(kind, text, declared, profile, store1, after) {
  const imps = await store.imports(), sc = pilotScope(imps), other = [...imps].reverse().find(i => i.kind === (kind === 'vidr' ? 'ledger' : 'vidr'));
  const args = kind === 'vidr' ? { vidrText: text, vidrDeclared: declared, ledgerText: other?.text, profile: other?.profile, ledgerDeclared: other?.declared } : { vidrText: other?.text, vidrDeclared: other?.declared, ledgerText: text, profile, ledgerDeclared: declared };
  const x = preflight({ ...args, scope: sc }), box = $('#stage'); box.replaceChildren();
  const ticks = [], go = el('button', { id: 'st-store' }, 'Store this file');
  box.append(el('h3', {}, 'Preflight (nothing is stored yet)'), el('p', {}, el('span', { class: 'badge ' + (x.ready ? 'b-ok' : 'b-bad') }, x.ready ? 'No blocking problem' : 'Blocked: fix the FAIL lines, then check again')));
  for (const c of x.checks) { const row = el('p', { class: 'kv' }, el('span', { class: 'badge ' + (c.status === 'PASS' ? 'b-ok' : c.status === 'WARN' ? 'b-warn' : c.status === 'NOTE' ? '' : 'b-bad') }, c.status), ' ' + c.detail);
    if (c.status === 'WARN') { const t = el('input', { type: 'checkbox', 'data-warn': c.id }); ticks.push(t); row.append(el('label', {}, t, ' I understand this and want to continue')); } box.append(row); }
  const sync = () => { go.disabled = !x.ready || ticks.some(t => !t.checked); }; ticks.forEach(t => t.addEventListener('change', sync)); sync();
  go.addEventListener('click', async () => { try { await store1(); box.replaceChildren(); await after(); } catch (e) { refused(e); } });
  box.append(go);
}

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
    try { await stage('vidr', text, declared, null, async () => { await store.addVidr({ text, declared, fileName: f.name }); form.replaceChildren(); ev.target.value = ''; say('Stored: ' + f.name); }, async () => { await render(); await pilotPanel(); }); } catch (e) { refused(e); }
  } }, 'Check before storing'));
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
    try { await stage('ledger', text, declared, profile, async () => { await store.addLedger({ text, profile, declared, fileName: f.name }); form.replaceChildren(); ev.target.value = ''; say('Stored: ' + f.name); }, async () => { await render(); await pilotPanel(); }); } catch (e) { refused(e); }
  } }, 'Check before storing'));
  form.append(box);
});

const GROUPS = [['Needs action', i => i.state === 'ACTION_REQUIRED'], ['Needs a human reading', i => i.state === 'OPEN'], ['In progress, waiting for a newer file', i => i.state === 'AWAITING_NEW_EVIDENCE'], ['Reported resolved by you, not confirmed by a file', i => i.state === 'MANUALLY_REPORTED_RESOLUTION'], ['Closed, with evidence from a newer file', i => i.state === 'VERIFIED_CLOSED']];
async function ask(issue, type, extra = {}) {
  const author = prompt('Your name or role (any name you choose):'); if (!author) return; const reasoning = prompt('Your reasoning, in words:'); if (!reasoning) return;
  try { await store.addEvent({ type, issueKey: issue.key, author, reasoning, ...extra }); await render(); await pilotPanel(); } catch (e) { refused(e); }
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
    if (i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'PROPOSED_LINK_UNCONFIRMED') for (const d of ['CONFIRM', 'REJECT']) b.append(el('button', { class: 'alt', onclick: async () => { const author = prompt('Your name or role:'), reasoning = author && prompt('Your reasoning, in words:'); if (!reasoning) return; try { await store.addEvent({ type: 'LINK_DECISION', ledgerKey: i.subject.ledgerKey, amazonId: i.finding.evidence.candidate.amazonId, decision: d, author, reasoning }); await render(); await pilotPanel(); } catch (e) { refused(e); } } }, d === 'CONFIRM' ? 'Confirm link' : 'Reject link'), ' ');
    if (i.family === 'DATA_MISMATCH' && i.subtype === 'FIELDS_DIFFER') b.append(el('button', { class: 'alt', onclick: () => ask(i, 'DIFFERENCE_EXPLAINED') }, 'Declare: difference explained'));
    const kind = i.family === 'UNMATCHED_DOCUMENT' ? 'NOT_AN_AMAZON_SALE' : i.family === 'BOOKS_GAP' ? 'RESOLUTION_DECLARED' : null;
    if (kind && !(i.family === 'UNMATCHED_DOCUMENT' && i.subtype !== 'NO_CANDIDATE')) b.append(el('button', { class: 'alt', onclick: () => ask(i, 'RESOLUTION_DECLARED', { kind }) }, kind === 'NOT_AN_AMAZON_SALE' ? 'Declare: not an Amazon sale' : 'Declare: resolved'));
    if (b.childNodes.length) n.append(b);
  }
  if (i.history.length > 1) n.append(el('details', {}, el('summary', { class: 'small' }, 'History'), ...i.history.map(h => el('div', { class: 'small mut' }, `${h.file ?? h.import}: ${h.status}${h.note ? ' (' + h.note + ')' : ''}`))));
  return n;
}
async function delImport(x) {
  try { const m = await store.deletionImpact(x.id), n = (o) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
    if (!confirm(`Delete ${x.fileName ?? x.id}?\n\nThis removes: the stored file and its declarations; problems that exist only because of it (${n(m.issuesDisappearing)}); ${m.issuesChanging} other problem(s) will change because this file no longer counts; your notes on the removed problems (${n(m.eventsRemoved)}).\nThis keeps: ${m.importsRemaining} other file(s) and your other notes. Copies you downloaded are not touched.\nIt cannot be undone unless you have a backup.`)) return;
    await store.deleteImport(x.id, { confirmed: true }); say('Deleted ' + (x.fileName ?? x.id) + '.'); await render(); await pilotPanel(); } catch (e) { refused(e); }
}
async function render() {
  const r = await store.project(), out = $('#results'); out.replaceChildren();
  const b = r.buckets; out.append(el('div', { class: 'card', id: 'summary' }, el('h3', {}, 'Summary'), el('p', { class: 'kv' }, `Matched by invoice number: ${b.matchedByInvoiceNumber} (currency and buyer tax id are compared for each pair; the invoice total, net, VAT, dates and lines are not compared in this version). In progress at Amazon: ${b.inProgressAtAmazon}. Needs action: ${b.needsActionNow}. Needs a human reading: ${b.needsHumanReading}. Waiting for a newer file: ${b.awaitingNewEvidence}. Cannot determine: ${b.cannotDetermine}.`),
    el('p', { class: 'kv' }, el('b', {}, 'Closed with evidence: ' + b.closedWithEvidence), '. Reported resolved by you, not confirmed by a file: ' + b.reportedResolvedBySeller + '. These two numbers are never added.')));
  for (const [name, f] of GROUPS) { const xs = r.issues.filter(f); if (xs.length) out.append(el('details', { class: 'group', open: '' }, el('summary', {}, `${name} (${xs.length})`), ...xs.map(cardNode))); }
  if (r.coverageNotes.length) out.append(el('details', { class: 'group' }, el('summary', {}, `Cannot determine (${b.cannotDetermine})`), ...r.coverageNotes.map(g => el('p', { class: 'small' }, `${g.count} x ${g.note ?? g.reason ?? JSON.stringify(g)}`))));
  const imps = await store.imports(); out.append(el('details', { class: 'group' }, el('summary', {}, `Loaded files (${imps.length})`), el('table', {}, el('tr', {}, el('th', {}, 'File'), el('th', {}, 'Kind'), el('th', {}, 'sha256'), el('th', {}, 'Loaded'), el('th', {}, '')), ...imps.map(x => el('tr', {}, el('td', {}, x.fileName ?? x.id), el('td', {}, x.kind), el('td', {}, x.sha256.slice(0, 12)), el('td', {}, x.importedAt), el('td', {}, el('button', { class: 'alt', 'data-del': x.id, onclick: () => delImport(x) }, 'Delete')))))));
  $('#notchecked').textContent = r.notCheckedInThisVersion.join('; ') + '.';
  net();
}
$('#bundle').addEventListener('click', async () => { if (!store) return; const b = await store.bundle(), a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' })), download: 'invoiceguard-loop-bundle.json' }); document.body.append(a); a.click(); a.remove(); });
$('#wipe').addEventListener('click', async () => {
  if (!store) return;
  if (!confirm('Delete the whole local workspace?\n\nThis removes every stored file, every note you wrote, the vault and its keys from this browser. It cannot be undone. Copies you downloaded (evidence bundles, backups) are not touched. The browser may keep traces of deleted data in its own files until it cleans them up; stored data is encrypted, so such traces are unreadable without your password.')) return;
  try { await store.deleteEverything(); await raw.clear(); store = null; await showGate(); say('The workspace was deleted.'); } catch (e) { refused(e); }
});

// ---- vault gate, lock, settings, backup (P3) ----
const download = (name, obj) => { const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove(); };
const gate = $('#gate');
function lockedUi(reason) {
  store = null; $('#app').hidden = true; for (const id of ['#results', '#form', '#msg', '#bar', '#settings']) $(id).replaceChildren(); // decrypted values leave the page, and so does a file chosen but not stored
  showGate(reason === 'inactivity' ? 'Locked after inactivity. A file you had chosen but not yet stored was dropped from the page; stored data is untouched.' : 'Locked.');
}
async function showGate(note = '') {
  gate.hidden = false; gate.replaceChildren(); const exists = await vault.exists();
  const msg = el('p', { class: 'small', id: 'g-msg' }, note); const bad = (t) => { msg.textContent = t; msg.className = 'small err'; };
  if (!exists) {
    gate.append(el('h3', {}, 'Create your local vault'), el('p', { class: 'small mut' }, 'Everything you load is encrypted in this browser with a password only you know. We cannot recover it for you: there is no account and no server copy. You get a recovery key once; keep it somewhere safe.'));
    const pw = inp('g-pw', 'password'), pw2 = inp('g-pw2', 'password');
    gate.append(field('Password (at least 10 characters)', pw), field('Repeat the password', pw2), msg, el('button', { onclick: async () => {
      if (pw.value !== pw2.value) return bad('The two passwords differ.');
      try { const { recoveryKey } = await vault.create(pw.value); gate.replaceChildren(el('h3', {}, 'Your recovery key'), el('p', { class: 'small' }, 'Write this down now. It is shown once, it is not stored anywhere, and it is the only way in if you forget the password.'), el('pre', { id: 'g-rec' }, recoveryKey), el('label', {}, (() => { const c = el('input', { type: 'checkbox', id: 'g-saved' }); return c; })(), ' I have saved the recovery key'), el('button', { onclick: async () => { if (!$('#g-saved').checked) return; await enter(); } }, 'Continue')); } catch (e) { bad(e.message); }
    } }, 'Create vault'));
    const rf = el('input', { type: 'file', id: 'g-restore' }); gate.append(el('h3', {}, 'Or restore an encrypted backup'), rf);
    rf.addEventListener('change', async () => { const f = rf.files[0]; if (!f) return; const p = prompt('Password of the backup:'); if (!p) return; try { await vault.restoreBackup(JSON.parse(await readFile(f)), p); await showGate('Backup restored and checked. Unlock with its password.'); } catch (e) { bad(e.message); } });
  } else {
    const pw = inp('g-pw', 'password');
    gate.append(el('h3', {}, 'Unlock'), field('Password', pw), msg, el('button', { onclick: async () => { try { await vault.unlock(pw.value); await enter(); } catch (e) { bad(e.message); } } }, 'Unlock'),
      el('button', { class: 'alt', onclick: async () => { const k = prompt('Recovery key:'); if (!k) return; try { await vault.unlockWithRecoveryKey(k); await enter(); } catch (e) { bad(e.message); } } }, 'Use recovery key'));
  }
  window.__gateReady = true;
}
async function pilotPanel() {
  const rec = createPilotRecord(vault.adapter), r0 = await rec.read(), imps = await store.imports(), proj = await store.project(), box = $('#pilot');
  const t = r0.times ?? {}, mi = inp('p-before', 'number', t.manualMinutesBefore ?? ''), wi = inp('p-with', 'number', t.toolMinutesWith ?? ''), ms = inp('p-missed', 'number', String(r0.missedBySeller ?? 0));
  const pre = el('div', { id: 'p-pre', class: 'small' });
  const runPre = el('button', { class: 'alt', id: 'p-runpre', onclick: () => { if (!imps.some(i => i.kind === 'vidr') || !imps.some(i => i.kind === 'ledger')) { pre.replaceChildren(el('p', { class: 'err' }, 'Load one Amazon report and one accounting export first.')); return; }
    const x = preflightStored(imps);
    pre.replaceChildren(el('p', {}, el('span', { class: 'badge ' + (x.ready ? 'b-ok' : 'b-bad') }, x.ready ? 'Ready for the pilot (this is the same check the aggregate file records)' : 'Not ready: fix the FAIL lines')), ...x.checks.map(c => el('p', { class: 'kv' }, el('span', { class: 'badge ' + (c.status === 'PASS' ? 'b-ok' : c.status === 'WARN' ? 'b-warn' : c.status === 'NOTE' ? '' : 'b-bad') }, c.status), ' ' + c.detail))); } }, 'Re-check the stored files');
  const saveT = el('button', { class: 'alt', id: 'p-savet', onclick: async () => { try { await rec.setTimes({ manualMinutesBefore: mi.value, toolMinutesWith: wi.value }); await rec.setMissed(ms.value); say('Pilot numbers saved (encrypted, in the vault).'); } catch (e) { say(e.message, true); } } }, 'Save times and count');
  const rows = proj.issues.map(i => { const sel = el('select', { 'data-adj': i.key }, el('option', { value: '' }, 'not reviewed'), ...[['CONFIRMED_REAL', 'confirmed real'], ['FALSE_POSITIVE', 'false positive'], ['COULD_NOT_CONFIRM', 'could not confirm']].map(([v, tx]) => { const o = el('option', { value: v }, tx); if (r0.adjudications?.[i.key] === v) o.selected = true; return o; }));
    sel.addEventListener('change', async () => { if (sel.value) await rec.adjudicate(i.key, sel.value); say('Saved. This is your statement, shown as seller-reported.'); }); return el('tr', {}, el('td', {}, `${i.family} / ${i.subtype}`), el('td', {}, i.subject?.number ?? i.subject?.orderId ?? ''), el('td', {}, sel)); });
  const out = el('pre', { id: 'p-out', class: 'small' });
  const mk = el('button', { class: 'alt', id: 'p-export', onclick: async () => { try { const m = aggregateMetrics({ projection: await store.project(), record: await rec.read(), imports: await store.imports() }); const txt = JSON.stringify(m, null, 2); out.textContent = txt; download('invoiceguard-pilot-aggregate.json', m); say('Aggregate file created. It holds numbers and fixed words only. Read it before you send it to anyone.'); } catch (e) { say(e.message, true); } } }, 'Create aggregate results file');
  box.replaceChildren(el('h3', {}, 'Pilot measurement'), el('p', { class: 'small mut' }, 'Everything here stays in this vault. The results file has numbers only: no order ids, document numbers, dates or file names. Times and adjudications are your statements and are labelled seller-reported.'),
    runPre, pre, el('div', { class: 'row' }, field('Minutes of manual investigation before', mi), field('Minutes with InvoiceGuard', wi), field('Real problems you found another way that the tool did not show', ms)), saveT,
    proj.issues.length ? el('table', {}, el('tr', {}, el('th', {}, 'Finding'), el('th', {}, 'Reference'), el('th', {}, 'Your check')), ...rows) : el('p', { class: 'small mut' }, 'No findings to review yet.'), mk, out);
}
async function enter() {
  store = createLoopStore(vault.adapter); gate.hidden = true; gate.replaceChildren();
  let note = '';
  try { if ((await legacyKeys(raw)).length) { const r = await migrateLegacy(vault); note = `Moved ${r.migrated} earlier unencrypted record(s) into the vault and removed the originals after checking them.` + (r.unreadable.length || r.conflicts.length ? ` ${r.unreadable.length + r.conflicts.length} could not be moved and were kept untouched.` : ''); } } catch (e) { note = 'Moving earlier data into the vault stopped: ' + e.message; }
  const s = await store.settings(); vault.setAutoLock(s.autoLockMinutes * 60000);
  try { const r = await store.applyRetention(); if (r.deleted.length) note += ` Retention removed ${r.deleted.length} file(s) older than your limit.`; } catch (e) { note += ' ' + e.message; }
  $('#app').hidden = false; await bars(); await render(); await pilotPanel(); if (note) say(note); window.__loopReady = true;
}
async function bars() {
  const s = await store.settings();
  $('#bar').replaceChildren(el('span', {}, 'Vault unlocked. '), el('button', { class: 'alt', id: 'lockbtn', onclick: () => vault.lock('manual') }, 'Lock now'), ' ', el('button', { class: 'alt', onclick: async () => { const a = prompt('Current password:'), b = a && prompt('New password (at least 10 characters):'); if (!b) return; try { await vault.changePassword(a, b); say('Password changed.'); } catch (e) { refused(e); } } }, 'Change password'));
  const lock = el('select', { id: 's-lock' }, ...[[5, '5 minutes'], [15, '15 minutes'], [60, '1 hour'], [0, 'never (not recommended)']].map(([v, t]) => { const o = el('option', { value: String(v) }, t); if (v === s.autoLockMinutes) o.selected = true; return o; }));
  lock.addEventListener('change', async () => { await store.setSettings({ autoLockMinutes: Number(lock.value) }); vault.setAutoLock(Number(lock.value) * 60000); say('Auto-lock updated.'); });
  const ret = el('select', { id: 's-ret' }, el('option', { value: 'KEEP' }, 'Keep everything until I delete it (default)'), el('option', { value: 'AFTER_DAYS' }, 'Delete files automatically after a number of days')), days = inp('s-days', 'number', String(s.retention.days ?? 365)); ret.value = s.retention.mode;
  const saveRet = el('button', { class: 'alt', id: 's-saveret', onclick: async () => {
    try { if (ret.value === 'KEEP') { await store.setSettings({ retention: { mode: 'KEEP' } }); say('Nothing will be deleted automatically.'); return; }
      const d = Number(days.value), prev = await store.setSettings.length; void prev;
      if (!confirm(`Turn on automatic deletion?\n\nEvery file stored here that is older than ${d} days will be deleted when you unlock the vault, together with the problems that exist only because of it and the notes you wrote on them. Deleted files cannot be recovered unless you kept a backup. Nothing is deleted if you leave this off.`)) return;
      await store.setSettings({ retention: { mode: 'AFTER_DAYS', days: d, confirmedAt: new Date().toISOString() } }); say('Automatic deletion is on: files older than ' + d + ' days are removed when you unlock.'); } catch (e) { refused(e); } } }, 'Save retention');
  $('#settings').replaceChildren(el('h3', {}, 'Protection and data'), el('div', { class: 'row' }, field('Lock automatically after inactivity', lock), field('Retention', ret), field('Days (30 to 3650)', days)), saveRet, ' ',
    el('button', { class: 'alt', id: 's-backup', onclick: async () => { try { download('invoiceguard-backup.json', await vault.exportBackup()); say('Encrypted backup downloaded. It opens with your password; keep it somewhere safe.'); } catch (e) { refused(e); } } }, 'Download encrypted backup'),
    el('p', { class: 'small mut' }, 'Deleting a file removes it and what was computed from it from this browser. Browsers keep storage in their own files and may keep traces until they clean up; stored data is encrypted, so traces are unreadable without your password. Backups and evidence bundles you downloaded stay where you saved them.'));
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => vault.touch(), true);
await showGate();
