// The projection. project(imports, events) is a PURE function: nothing it returns is stored, and the same inputs always give the same output.
// Lifecycle states are derived here and nowhere else. Imports and seller events are the only inputs; neither carries a state.
import { reconcile, REPORT_TYPE } from '../reconcile.js';
import { parseTable } from '../manual.js';
import { readLedger, readMoney } from './ledger.js';
import { sha256 } from './sha256.js';
import { eventShapeProblem, declarationProblem, DECLARATION_TYPES } from './events.js';
import { buildCard } from './cards.js';

export const LOOP_VERSION = 'loop-1.0';
export const KEY_VERSION = 'k1';
export const FAMILIES = Object.freeze(['SOURCE_INCOMPLETE', 'UNMATCHED_DOCUMENT', 'INVOICE_AMAZON_STATE', 'BOOKS_GAP', 'DATA_MISMATCH', 'DUPLICATE_DOCUMENT']); // P1 and P2, ordinary invoices only
export const NOT_CHECKED_IN_THIS_VERSION = Object.freeze(['credit notes and rectificativas', 'correction pairs', 'the invoice total, net and VAT amounts, document dates, line items and tax rates of a linked pair (the Amazon report states the item price, not the invoice total)', 'a document that appears in two different files (a re-export is not a duplicate)']);
const ms = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const day = (v) => { const t = ms(v); return t === null ? null : new Date(t).toISOString().slice(0, 10); };
const uniq = (a) => [...new Set(a)];
const DEFECT_CODES_EXCLUDED = ['NOT_ALL_STATUSES']; // a pending-only report limits conclusions; it is not a defect
export const issueKey = (sellerProfileId, family, identity) => sha256([KEY_VERSION, sellerProfileId, family, identity].join('\n'));
const isLedger = (i) => i.kind === 'ledger';
/** When the file itself was created: the VIDR's declared creation time, the ledger's declared export time. Upload time is never a substitute. Null = unknown. */
const createdMs = (i) => isLedger(i) ? ms(i.declared?.exportedAt) : ms(i.declared?.createdAt);
/** A full-scope import can replace or close: a complete ledger, an all-statuses report. A partial export or pending-only report only adds records. */
const fullScope = (i) => isLedger(i) ? i.declared?.complete === true : i.declared?.options === 'ALL';
const loopTime = (i) => { const d = i.declared ?? {}; return (isLedger(i) ? ms(d.exportedAt) : (ms(d.createdAt) ?? ms(d.downloadedAt))) ?? ms(i.importedAt) ?? 0; };
export const orderImports = (imports) => [...imports].sort((a, b) => loopTime(a) - loopTime(b) || String(a.importedAt).localeCompare(String(b.importedAt)) || String(a.id).localeCompare(String(b.id)));
const descriptor = (i) => { const d = i.declared ?? {}; return isLedger(i) ? ['ledger', d.sourceSystem, d.marketplace, `${d.periodFrom}..${d.periodTo}`, [...(d.documentKinds ?? [])].sort().join('+'), `scope=${d.amazonScope?.mode ?? 'UNKNOWN'}:${[...new Set((d.amazonScope?.channelValues ?? []).map(v => String(v).trim().toLowerCase()))].sort().join(',')}`].join('|') : ['vidr', 'amazon-vidr', d.marketplace, `${d.rangeFrom}..${d.rangeTo}`, 'all-kinds'].join('|'); };
const amazonId = (d) => ['amz', d.parts['marketplace-id'], d.parts['transaction-type'], d.parts['transaction-id'], d.parts['order-id'], d.parts['shipping-id'], 'INVOICE'].join('|');
const ledgerKey = (l) => `${l.marketplace}|${l.identity}`;

function evaluate(prefix, events, ctx) {
  const vidr = prefix.filter(i => !isLedger(i)), led = prefix.filter(isLedger);
  const rec = vidr.length ? reconcile(vidr) : { docs: [], imports: [] };
  const clsOf = (id) => rec.imports.find(x => x.id === id);
  const findings = new Map(), closed = new Map(), notes = [];
  const put = (key, f) => findings.set(key, { key, ...f });
  const idxOf = (imp) => { if (!ctx.rowIdx.has(imp.id)) { const t = parseTable(imp.text ?? ''); ctx.rowIdx.set(imp.id, new Map(t.rows.map((r, n) => [JSON.stringify(r), n + 1]))); } return ctx.rowIdx.get(imp.id); };
  const impById = new Map(prefix.map(i => [i.id, i]));
  const vidrEvidence = (d) => { const imp = impById.get(d.current.importId), ix = imp ? idxOf(imp) : new Map(); return { importId: d.current.importId, fileName: imp?.fileName ?? null, role: 'amazon', rows: d.evidence.rows.map(r => ({ ref: `data row ${ix.get(JSON.stringify(r)) ?? '?'}`, cells: r })) }; };
  const ledgerEvidence = (l) => { const imp = impById.get(l.importId), rd = readOf(imp); return { importId: l.importId, fileName: imp?.fileName ?? null, role: 'accounting', rows: [{ ref: `row ${l.row}`, cells: Object.fromEntries((rd.head ?? []).map((h, i) => [h, l.raw[i]])) }] }; };
  const readOf = (imp) => { const k = imp.id + '|' + imp.sha256; if (!ctx.led.has(k)) ctx.led.set(k, readLedger(imp.text ?? '', imp.profile, { importId: imp.id, amazonScope: imp.declared?.amazonScope ?? { mode: 'UNKNOWN' }, sourceSystem: imp.declared?.sourceSystem ?? '' })); return ctx.led.get(k); };
  const fp = (...parts) => sha256(JSON.stringify(parts));

  // ---- SOURCE_INCOMPLETE: identity is the scope descriptor, so a replacement import closes the same issue ----
  const groups = new Map(); for (const i of prefix) { const k = descriptor(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const importDefects = new Map();
  for (const i of prefix) {
    const defects = [], scopeNotes = [], d = i.declared ?? {};
    if (isLedger(i)) { const rd = readOf(i); defects.push(...rd.defects); if (d.complete !== true) scopeNotes.push('declared as a partial export: it can show that a document exists, never that one is missing'); if ((d.amazonScope?.mode ?? 'UNKNOWN') === 'UNKNOWN') scopeNotes.push('not declared as Amazon sales, so nothing can be concluded about missing documents'); }
    else {
      const c = clsOf(i.id); if (c) { c.problemCodes.forEach((code, n) => { if (DEFECT_CODES_EXCLUDED.includes(code)) scopeNotes.push(c.problems[n]); else defects.push(c.problems[n]); });
        if (c.dateOrder && !c.dateOrder.provenByFile && c.dateOrder.sellerConfirmed !== true) defects.push('the order of the dates (day first or month first) is not proven by the file and was not confirmed by the seller'); }
      if (d.reportType !== REPORT_TYPE) defects.push('the report type was not declared');
      if (!String(d.marketplace ?? '').trim()) defects.push('the marketplace was not declared');
      if (!(d.createdAfterUploadConfirmed && ms(d.createdAt) !== null)) defects.push('it was not declared that the report was created after the upload, with its creation time');
      if (ms(d.downloadedAt) === null) defects.push('the download time was not declared');
      if (!String(d.obtainedHow ?? '').trim()) defects.push('how the file was obtained was not declared');
    }
    importDefects.set(i.id, { defects, scopeNotes });
  }
  for (const [desc, list] of groups) {
    const latest = list[list.length - 1], full = list.filter(fullScope).at(-1), key = issueKey(ctx.seller, 'SOURCE_INCOMPLETE', desc);
    const subjectOf = (x) => ({ descriptor: desc, source: isLedger(x) ? 'accounting export' : 'Amazon VAT invoice report', fileName: x.fileName ?? null });
    const raise = (x) => { const { defects } = importDefects.get(x.id); put(key, { family: 'SOURCE_INCOMPLETE', subtype: 'DEFECTS', status: 'PRESENT', subject: subjectOf(x), evidence: { sources: [], defects, importId: x.id, fileName: x.fileName ?? null }, fingerprint: fp('SI', desc, defects), safeAction: true }); };
    // A newer file closes this problem only if it is a complete, valid replacement of the same scope. A partial export or a pending-only report is not one: it never closes the problem.
    if (importDefects.get(latest.id).defects.length) raise(latest);
    else if (fullScope(latest)) closed.set(key, { why: 'The latest import of this scope is complete.', importId: latest.id, fileName: latest.fileName ?? null });
    else if (full && importDefects.get(full.id).defects.length) raise(full);
    else if (full) closed.set(key, { why: 'The latest complete import of this scope has no defects.', importId: full.id, fileName: full.fileName ?? null });
  }
  const usableVidr = (i) => { const { defects } = importDefects.get(i.id); const c = clsOf(i.id); return !defects.length && c && c.declared.options === 'ALL'; };

  // ---- Amazon side: ordinary invoices only ----
  const A = rec.docs.filter(d => d.parts['transaction-type'] === 'SHIPMENT' && !d.correction && d.state !== 'CREATED_BY_AMAZON');
  const stats = { amazonInvoices: A.length, createdByAmazon: rec.docs.filter(d => d.state === 'CREATED_BY_AMAZON').length, notOrdinaryInvoice: rec.docs.filter(d => d.parts['transaction-type'] !== 'SHIPMENT' || d.correction).length, processing: 0, ledgerAmazonInvoices: 0, ledgerExcludedNotAmazon: 0, ledgerCreditNotes: 0, ledgerUnknownScope: 0, ledgerRejectedRows: 0 };
  // Closure after an action: if the seller recorded ACTION_STARTED before this report was loaded, only a report CREATED after that event can close the problem. Upload time never stands in for creation time; an unknown creation time is never evidence.
  const afterAction = (key, d) => { const imp = impById.get(d.current.importId), acts = (ctx.actions.get(key) ?? []).filter(e => ms(e.createdAt) <= (ms(imp?.importedAt) ?? Infinity)); if (!acts.length) return true; const t = imp ? createdMs(imp) : null; return t !== null && t > Math.max(...acts.map(e => ms(e.createdAt))); };
  for (const d of A) {
    const id = amazonId(d), key = issueKey(ctx.seller, 'INVOICE_AMAZON_STATE', id), subject = { amazonId: id, marketplace: d.parts['marketplace-id'], orderId: d.parts['order-id'], shippingId: d.parts['shipping-id'], transactionId: d.parts['transaction-id'] };
    const ev = { sources: [vidrEvidence(d)], state: d.state, statusAsShown: d.rawStatus, amazonDescription: d.evidence.statusDescription ?? null, invoiceNumber: d.evidence.invoiceNumber ?? null };
    if (d.state === 'PENDING' || d.state === 'SELLER_UPLOAD_REQUIRED') put(key, { family: 'INVOICE_AMAZON_STATE', subtype: 'ACTION_REQUIRED', status: 'PRESENT', subject, evidence: ev, fingerprint: fp('IAS', id, d.state, d.rawStatus, d.evidence.rows), safeAction: true });
    else if (d.state === 'REJECTED') put(key, { family: 'INVOICE_AMAZON_STATE', subtype: 'REJECTED', status: 'PRESENT', subject, evidence: ev, fingerprint: fp('IAS', id, d.state, d.rawStatus, d.evidence.statusDescription, d.evidence.rows), safeAction: true });
    else if (d.state === 'ACCEPTED' && !afterAction(key, d)) put(key, { family: 'INVOICE_AMAZON_STATE', subtype: 'ACCEPTED_BEFORE_ACTION', status: 'UNDETERMINED', subject, evidence: ev, fingerprint: fp('IAS', id, 'BEFORE', d.current.importId), note: `The report that shows this as accepted was created ${impById.get(d.current.importId)?.declared?.createdAt ?? 'at an unknown time'}, which is not after the action you recorded. It cannot show the effect of that action. Load a report created after it.` });
    else if (d.state === 'ACCEPTED') closed.set(key, { why: `A later report shows ${d.rawStatus} and every acceptance condition of the evidence contract is met.`, sources: ev.sources, importId: d.current.importId });
    else if (d.state === 'PROCESSING') { stats.processing++; put(key, { family: 'INVOICE_AMAZON_STATE', subtype: 'PROCESSING', status: 'UNDETERMINED', processing: true, subject, evidence: ev, fingerprint: fp('IAS', id, d.state), note: 'Amazon\'s report shows this as processing. Amazon says no new upload is needed while it processes.' }); }
    else { put(key, { family: 'INVOICE_AMAZON_STATE', subtype: 'UNDETERMINED', status: 'UNDETERMINED', subject, evidence: ev, fingerprint: fp('IAS', id, d.state), note: `Amazon's row says ${d.rawStatus}, but the file does not allow a conclusion: ${d.explanation ?? d.state}` });
      notes.push({ reason: `Amazon status could not be concluded (${d.state})`, subject: id }); }
  }

  // ---- Accounting side ----
  // A later complete import of the same scope replaces the earlier ones for that scope: a document that is no longer in it is no longer in the books. Partial exports only add.
  const activeLed = led.filter(i => !led.some(j => j !== i && descriptor(j) === descriptor(i) && led.indexOf(j) > led.indexOf(i) && j.declared?.complete === true && !importDefects.get(j.id).defects.length));
  const merged = new Map();
  for (const i of activeLed) {
    const rd = readOf(i), mk = i.declared?.marketplace ?? ''; stats.ledgerRejectedRows += rd.rejected.length;
    const seen = new Map();
    for (const doc of rd.documents) {
      if (doc.kind === 'credit_note') { stats.ledgerCreditNotes++; continue; }
      if (doc.isAmazon === false) { stats.ledgerExcludedNotAmazon++; continue; }
      if (doc.isAmazon === null) { stats.ledgerUnknownScope++; continue; }
      const level = i.declared?.documentLevel === 'DOCUMENT' || i.declared?.documentLevel === 'LINE' ? i.declared.documentLevel : null; // what one row of this export is, declared by the seller
      const l = { ...doc, marketplace: mk, conflicting: false, level }, k = ledgerKey(l), c = JSON.stringify(level === 'LINE' ? [doc.issueDate, doc.operationDate, doc.currency, doc.orderRef, doc.buyerTaxId] : [doc.issueDate, doc.operationDate, doc.currency, doc.gross, doc.net, doc.vat, doc.orderRef, doc.buyerTaxId]);
      if (seen.has(k)) { if (seen.get(k).c === c) { if (level !== 'LINE') seen.get(k).l.repeatRows = [...(seen.get(k).l.repeatRows ?? [seen.get(k).l.row]), doc.row]; } if (seen.get(k).c !== c) { seen.get(k).l.conflicting = true; seen.get(k).l.conflictRows = [...(seen.get(k).l.conflictRows ?? [seen.get(k).l.row]), doc.row]; } continue; }
      const prev = merged.get(k); if (prev && (prev.conflicting || prev.repeatRows)) continue; // a duplicate is replaced only by a complete file of the same scope, and then the earlier file no longer stands (see activeLed); a partial export proves nothing about it
      seen.set(k, { c, l }); merged.set(k, l); // a later import of the same document replaces an earlier one
    }
  }
  const Le = [...merged.values()]; stats.ledgerAmazonInvoices = Le.length;
  const byNum = new Map(), aNum = new Map(), aOrder = new Map();
  for (const l of Le) { const k = l.marketplace + '|' + l.number; if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(l); }
  for (const d of A) { const n = d.evidence.invoiceNumber; if (n) { const k = d.parts['marketplace-id'] + '|' + n; if (!aNum.has(k)) aNum.set(k, []); aNum.get(k).push(d); } const o = d.parts['marketplace-id'] + '|' + d.parts['order-id']; if (!aOrder.has(o)) aOrder.set(o, []); aOrder.get(o).push(d); }
  const link = new Map(), ledLink = new Map(); // amazonId -> {level, ledger[]} ; ledgerKey -> {level, amazon[]}
  const setA = (d, v) => link.set(amazonId(d), v), addL = (l, v) => { const c = ledLink.get(ledgerKey(l)) ?? { level: null, amazon: [], note: null }; ledLink.set(ledgerKey(l), { ...c, ...v, amazon: uniq([...(c.amazon ?? []), ...(v.amazon ?? [])]) }); };
  for (const d of A) {
    const n = d.evidence.invoiceNumber, mk = d.parts['marketplace-id'];
    if (n) {
      const Lc = byNum.get(mk + '|' + n) ?? [];
      if (Lc.length === 1 && !Lc[0].conflicting && aNum.get(mk + '|' + n).length === 1) { setA(d, { level: 'CONFIRMED', ledger: [ledgerKey(Lc[0])] }); addL(Lc[0], { level: 'CONFIRMED', amazon: [amazonId(d)] }); continue; }
      if (Lc.length) { setA(d, { level: 'AMBIGUOUS', ledger: Lc.map(ledgerKey), why: Lc.length > 1 ? `${Lc.length} accounting documents carry the number ${n}` : Lc[0].conflicting ? `the accounting document ${n} appears twice in one file with different content` : `${aNum.get(mk + '|' + n).length} Amazon transactions show the number ${n}` }); Lc.forEach(l => addL(l, { level: 'AMBIGUOUS', amazon: [amazonId(d)] })); continue; }
    }
    const Lo = Le.filter(l => l.marketplace === mk && l.orderRef === d.parts['order-id']);
    if (n && Lo.length) { setA(d, { level: 'OTHER_NUMBER', ledger: Lo.map(ledgerKey) }); Lo.forEach(l => addL(l, { level: ledLink.get(ledgerKey(l))?.level ?? 'OTHER_NUMBER', amazon: [amazonId(d)] })); continue; }
    if (!n && Lo.length) {
      const sameOrder = (aOrder.get(mk + '|' + d.parts['order-id']) ?? []).filter(x => !x.evidence.invoiceNumber);
      if (Lo.length === 1 && sameOrder.length === 1 && !Lo[0].conflicting) { setA(d, { level: 'PROPOSED', ledger: [ledgerKey(Lo[0])] }); addL(Lo[0], { level: 'PROPOSED', amazon: [amazonId(d)] }); }
      else { setA(d, { level: 'AMBIGUOUS', ledger: Lo.map(ledgerKey), why: Lo.length > 1 ? `${Lo.length} accounting documents name the order ${d.parts['order-id']}` : `${sameOrder.length} Amazon transactions of the order ${d.parts['order-id']} could belong to it` }); Lo.forEach(l => addL(l, { level: 'AMBIGUOUS', amazon: [amazonId(d)] })); }
    }
  }
  // Seller decisions on PROPOSED links. A decision counts only while that exact proposal exists. It is a declaration, never evidence.
  const decisions = new Map();
  for (const e of events.filter(e => e.type === 'LINK_DECISION' && !eventShapeProblem(e)).sort((a, b) => ms(a.createdAt) - ms(b.createdAt))) decisions.set(e.amazonId + '>' + e.ledgerKey, e);
  for (const d of A) { const l = link.get(amazonId(d)); if (l?.level !== 'PROPOSED') continue; const e = decisions.get(amazonId(d) + '>' + l.ledger[0]); if (!e) continue;
    const lk = Le.find(x => ledgerKey(x) === l.ledger[0]);
    if (e.decision === 'CONFIRM') { link.set(amazonId(d), { level: 'DECLARED', ledger: l.ledger, event: e }); ledLink.set(l.ledger[0], { level: 'DECLARED', amazon: [amazonId(d)], event: e }); }
    else { link.set(amazonId(d), { level: 'REJECTED_PROPOSAL', ledger: l.ledger }); ledLink.set(l.ledger[0], { level: 'REJECTED_PROPOSAL', amazon: [amazonId(d)] }); void lk; } }

  // ---- DUPLICATE_DOCUMENT (P2): one identity twice inside ONE file. The same document in a later file (a re-export) replaces the earlier record and is never a duplicate. ----
  const FIELD_LABEL = { issueDate: 'issue date', operationDate: 'operation date', currency: 'currency', orderRef: 'order reference', buyerTaxId: 'buyer tax id' };
  const disagreeing = (l) => { const rd = readOf(impById.get(l.importId)), docs = rd.documents.filter(x => x.identity === l.identity); return Object.keys(FIELD_LABEL).filter(f => new Set(docs.map(x => String(x[f] ?? ''))).size > 1).map(f => ({ field: f, label: FIELD_LABEL[f], values: docs.map(x => ({ row: `row ${x.row}`, value: x[f] ?? null })) })); };
  const rowsOfIdentity = (l) => { const imp = impById.get(l.importId), rd = readOf(imp); return rd.documents.filter(x => x.identity === l.identity).map(x => ({ ref: `row ${x.row}`, cells: Object.fromEntries((rd.head ?? []).map((h, i) => [h, x.raw[i]])) })); };
  for (const l of Le) {
    const lk = ledgerKey(l), key = issueKey(ctx.seller, 'DUPLICATE_DOCUMENT', 'L:' + lk), subject = { ledgerKey: lk, number: l.number, marketplace: l.marketplace, issueDate: l.issueDate };
    if (l.conflicting || l.repeatRows) { const rows = rowsOfIdentity(l), unknownLevel = l.level === null, sub = unknownLevel ? 'SUSPECTED_DUPLICATE' : l.conflicting ? 'SAME_NUMBER_DIFFERENT_CONTENT' : 'EXACT_REPEAT';
      put(key, { family: 'DUPLICATE_DOCUMENT', subtype: sub, status: 'PRESENT', subject, evidence: { sources: [{ importId: l.importId, fileName: impById.get(l.importId)?.fileName ?? null, role: 'accounting', rows }], rowNumbers: rows.map(r => r.ref), documentLevel: l.level, ...(l.level === 'LINE' && l.conflicting ? { disagreeingFields: disagreeing(l) } : {}) }, fingerprint: fp('DUP', lk, sub, rows.map(r => r.cells)), ...(unknownLevel ? { note: 'The export does not say whether one row is a whole document or one line of a document, so repeated rows cannot be called a duplicate.' } : { safeAction: true }) }); }
    else closed.set(key, { why: l.level === 'LINE' ? `The file is declared by the seller as one row per line item, so repeated rows of ${l.number} are expected.` : `The latest active accounting file holds the document ${l.number} once.`, sources: [ledgerEvidence(l)], importId: l.importId });
  }
  // ---- DATA_MISMATCH (P2): confirmed pairs only (a unique number on both sides). Zero tolerance, minor units. Nothing is compared that either side does not state exactly. ----
  const money = (v) => /^-?\d+(\.\d{1,2})?$/.test(String(v ?? '').trim()) ? readMoney(String(v).trim(), '.', '') : null;
  const taxNorm = (v) => String(v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const fmt = (m, cur) => `${m < 0 ? '-' : ''}${Math.floor(Math.abs(m) / 100)}.${String(Math.abs(m) % 100).padStart(2, '0')} ${cur}`;
  const mismatchFields = new Map();
  for (const d of A) {
    const L = link.get(amazonId(d)); if (L?.level !== 'CONFIRMED') continue;
    const l = merged.get(L.ledger[0]); if (!l) continue;
    const id = amazonId(d), key = issueKey(ctx.seller, 'DATA_MISMATCH', id + '>' + ledgerKey(l)), rows = d.evidence.rows, diffs = [], notCompared = [];
    const subject = { amazonId: id, ledgerKey: ledgerKey(l), number: l.number, marketplace: d.parts['marketplace-id'], orderId: d.parts['order-id'], shippingId: d.parts['shipping-id'], transactionId: d.parts['transaction-id'] };
    const curs = uniq(rows.map(r => String(r.currency ?? '').trim().toUpperCase())), aCur = curs.length === 1 && /^[A-Z]{3}$/.test(curs[0]) ? curs[0] : null;
    let sameCur = false;
    if (aCur && l.currency) { sameCur = aCur === l.currency; if (!sameCur) diffs.push({ field: 'currency', label: 'Currency', amazon: aCur, books: l.currency }); } else notCompared.push({ field: 'currency', reason: 'the currency is not stated exactly on both sides' });
    if (!sameCur) notCompared.push({ field: 'gross', reason: aCur && l.currency ? 'the two sides use different currencies, and the Amazon report states the item price, not the invoice total' : 'the currency is not stated exactly on both sides' });
    else notCompared.push({ field: 'gross', reason: 'the Amazon report states the item price, not the invoice total (shipping, gift wrap and discounts are separate amounts), so the invoice total cannot be compared reliably in this version' });
    const btxRaw = rows.map(r => taxNorm(r['buyer-vat-number'])), btx = uniq(btxRaw.filter(Boolean)), btxAll = btxRaw.every(Boolean);
    if (btxAll && btx.length === 1 && taxNorm(l.buyerTaxId)) { if (btx[0] !== taxNorm(l.buyerTaxId)) diffs.push({ field: 'buyerTaxId', label: 'Buyer tax id', amazon: btx[0], books: taxNorm(l.buyerTaxId) }); }
    else notCompared.push({ field: 'buyerTaxId', reason: btx.length > 1 ? 'the Amazon rows of this transaction show different buyer tax ids' : !btx.length ? 'the Amazon report shows no buyer tax id' : !btxAll ? 'only some Amazon rows of this transaction carry a buyer tax id' : 'the accounting export shows no buyer tax id' });
    notCompared.push({ field: 'netAndVat', reason: 'net and VAT amounts are not read from the Amazon report in this version' });
    const sources = [vidrEvidence(d), ledgerEvidence(l)];
    if (diffs.length) { mismatchFields.set(key, new Set(diffs.map(x => x.field))); put(key, { family: 'DATA_MISMATCH', subtype: 'FIELDS_DIFFER', status: 'PRESENT', subject, evidence: { sources, differences: diffs, notCompared }, fingerprint: fp('DM', id, ledgerKey(l), diffs, l.raw), safeAction: true }); }
    else { const was = ctx.prevMismatch.get(key);
      if (was && [...was].some(f => notCompared.some(n => n.field === f))) put(key, { family: 'DATA_MISMATCH', subtype: 'CANNOT_CONFIRM', status: 'UNDETERMINED', subject, evidence: { sources, differences: [], notCompared }, fingerprint: fp('DM', id, ledgerKey(l), 'CANNOT'), note: 'The difference is no longer shown, but a field that differed can no longer be compared, so it cannot be called agreed.' });
      else closed.set(key, { why: 'The compared values (currency and buyer tax id, where both sides state them) agree on the same confirmed pair.', sources, importId: l.importId }); }
  }

  // ---- coverage ----
  const booksCover = (d) => {
    const mk = d.parts['marketplace-id'], ship = String(d.evidence.rows[0]?.['shipment-date'] ?? '').slice(0, 10), imp = impById.get(d.current.importId), rep = imp ? (day(imp.declared?.createdAt) ?? day(imp.declared?.downloadedAt)) : null;
    const why = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ship)) return { ok: false, why: ['the Amazon row has no readable shipment date'] };
    if (!rep) return { ok: false, why: ['the day the Amazon report was taken is not declared'] };
    if (!activeLed.length) return { ok: false, why: ['no accounting export has been loaded'] };
    for (const i of activeLed) { // only the files that stand after the replacement rule: a superseded export proves nothing
      const g = i.declared ?? [], r = []; const dd = i.declared ?? {};
      if (dd.marketplace !== mk) r.push(`it is declared for marketplace ${dd.marketplace}, not ${mk}`);
      if (dd.complete !== true) r.push('it is not declared as a complete export');
      const expT = ms(dd.exportedAt), repT = imp ? (ms(imp.declared?.createdAt) ?? ms(imp.declared?.downloadedAt)) : null;
      if (expT === null) r.push('the time this accounting export was created is not declared, so it cannot show that the invoice was missing when the Amazon report was taken');
      else if (repT !== null && expT < repT) r.push(`it was exported at ${dd.exportedAt}, before the Amazon report was created (${imp.declared.createdAt}), so it cannot show what the books held on that day`);
      if (!['ALL', 'CHANNEL'].includes(dd.amazonScope?.mode)) r.push('it is not declared as Amazon sales');
      if (!(dd.documentKinds ?? []).includes('invoice')) r.push('it does not declare that it covers invoices');
      if (importDefects.get(i.id).defects.length) r.push('the file has defects: ' + importDefects.get(i.id).defects.join('; '));
      if (!(dd.periodFrom <= ship && dd.periodTo >= ship && dd.periodTo >= rep)) r.push(`its period ${dd.periodFrom} to ${dd.periodTo} must start on or before the shipment day ${ship} and end on or after the shipment day and the day the Amazon report was taken (${rep})`);
      if (!r.length) return { ok: true, import: { id: i.id, fileName: i.fileName ?? null, period: `${dd.periodFrom} to ${dd.periodTo}`, sourceSystem: dd.sourceSystem, exportedAt: dd.exportedAt, exportedAtBasis: 'declared by the seller' } };
      why.push(`${i.fileName ?? i.id}: ${r.join('; ')}`); void g;
    }
    return { ok: false, why };
  };
  const vidrCover = (l) => {
    if (!l.operationDate) return { ok: false, why: ['the document has no operation date, so we cannot tell which Amazon report would show it'] };
    const why = [];
    for (const i of vidr) { const c = clsOf(i.id), dd = i.declared ?? {}, r = [];
      if (dd.marketplace !== l.marketplace) r.push(`it is for marketplace ${dd.marketplace}`);
      if (!usableVidr(i)) r.push('it is not a complete all-statuses report');
      else if (!(c.declared.rangeFrom <= l.operationDate && l.operationDate <= c.declared.rangeTo)) r.push(`its range ${c.declared.rangeFrom} to ${c.declared.rangeTo} does not contain the operation date ${l.operationDate}`);
      const rep = day(dd.createdAt) ?? day(dd.downloadedAt); if (!rep || rep < l.issueDate) r.push('it was not taken on or after the issue date of the document');
      if (!r.length) return { ok: true, import: { id: i.id, fileName: i.fileName ?? null, range: `${c.declared.rangeFrom} to ${c.declared.rangeTo}` } };
      why.push(`${i.fileName ?? i.id}: ${r.join('; ')}`); }
    return { ok: false, why: why.length ? why : ['no Amazon report has been loaded'] };
  };
  const noteGroup = new Map(); const noteAdd = (reason, subject) => { const k = reason; if (!noteGroup.has(k)) noteGroup.set(k, { reason, count: 0, sample: [] }); const g = noteGroup.get(k); g.count++; if (g.sample.length < 5) g.sample.push(subject); };

  // ---- BOOKS_GAP ----
  for (const d of A) {
    if (!['PENDING', 'SELLER_UPLOAD_REQUIRED', 'REJECTED', 'PROCESSING', 'ACCEPTED'].includes(d.state)) continue;
    const id = amazonId(d), key = issueKey(ctx.seller, 'BOOKS_GAP', id), L = link.get(id), subject = { amazonId: id, marketplace: d.parts['marketplace-id'], orderId: d.parts['order-id'], shippingId: d.parts['shipping-id'], transactionId: d.parts['transaction-id'] };
    const number = d.evidence.invoiceNumber ?? null, base = { sources: [vidrEvidence(d)], amazonState: d.state, invoiceNumberAtAmazon: number };
    if (L?.level === 'CONFIRMED') { const l = merged.get(L.ledger[0]); closed.set(key, { why: `The accounting document ${l.number} matches the number Amazon shows, and it is the only one.`, sources: [ledgerEvidence(l)], importId: l.importId }); continue; }
    if (L?.level === 'DECLARED') { const l = merged.get(L.ledger[0]); put(key, { family: 'BOOKS_GAP', subtype: number ? 'NUMBER_AT_AMAZON_NOT_IN_BOOKS' : 'NOT_IN_BOOKS', status: 'DECLARED_LINK', declared: { event: L.event }, subject, evidence: { ...base, declaredLink: { document: l.number, by: L.event.author, reasoning: L.event.reasoning } }, fingerprint: fp('BG', id, 'DECLARED', ledgerKey(l), L.event.id ?? L.event.createdAt), safeAction: true }); continue; }
    if (L && ['PROPOSED', 'AMBIGUOUS', 'OTHER_NUMBER'].includes(L.level)) { put(key, { family: 'BOOKS_GAP', subtype: 'UNDETERMINED', status: 'UNDETERMINED', subject, evidence: base, fingerprint: fp('BG', id, L.level, L.ledger), note: L.level === 'PROPOSED' ? 'An accounting document for this order exists but is not confirmed as the same document. See the matching problem.' : L.level === 'AMBIGUOUS' ? `More than one document could belong to this transaction: ${L.why}.` : 'An accounting document for the same order exists under a different number. Comparing numbers is not part of this version.' });
      if (L.level === 'OTHER_NUMBER') noteAdd('A document for the same order is in the books under a different number than Amazon shows (comparison not part of this version)', id); continue; }
    const cov = booksCover(d);
    if (!cov.ok) { put(key, { family: 'BOOKS_GAP', subtype: 'UNDETERMINED', status: 'UNDETERMINED', subject, evidence: base, fingerprint: fp('BG', id, 'NOCOV', cov.why), note: 'Absence from the books cannot be concluded: ' + cov.why.join(' | ') }); noteAdd('Absence from the books cannot be concluded: ' + cov.why[0].replace(/^[^:]*: /, ''), id); continue; }
    put(key, { family: 'BOOKS_GAP', subtype: number ? 'NUMBER_AT_AMAZON_NOT_IN_BOOKS' : 'NOT_IN_BOOKS', status: 'PRESENT', subject, evidence: { ...base, coverage: cov.import }, fingerprint: fp('BG', id, number, d.state, d.evidence.rows), safeAction: true });
  }
  // ---- UNMATCHED_DOCUMENT (ledger side) ----
  for (const l of Le) {
    const lk = ledgerKey(l), key = issueKey(ctx.seller, 'UNMATCHED_DOCUMENT', 'L:' + lk), L = ledLink.get(lk), subject = { ledgerKey: lk, number: l.number, marketplace: l.marketplace, orderRef: l.orderRef, issueDate: l.issueDate };
    const ev = { sources: [ledgerEvidence(l)], document: { number: l.number, issueDate: l.issueDate, orderRef: l.orderRef, operationDate: l.operationDate } };
    if (l.conflicting) continue; // reported as DUPLICATE_DOCUMENT
    if (L?.level === 'CONFIRMED') { const a = A.find(x => amazonId(x) === L.amazon[0]); closed.set(key, { why: `Amazon shows the same number (${l.number}) on one transaction.`, sources: a ? [vidrEvidence(a)] : [], importId: a?.current.importId }); continue; }
    if (L?.level === 'DECLARED') { put(key, { family: 'UNMATCHED_DOCUMENT', subtype: 'PROPOSED_LINK_UNCONFIRMED', status: 'PRESENT', declared: { event: L.event }, subject, evidence: ev, fingerprint: fp('UD', lk, 'DECLARED', L.amazon, L.event.id ?? L.event.createdAt), safeAction: true }); continue; }
    if (L?.level === 'PROPOSED') { const a = A.find(x => amazonId(x) === L.amazon[0]); put(key, { family: 'UNMATCHED_DOCUMENT', subtype: 'PROPOSED_LINK_UNCONFIRMED', status: 'PRESENT', subject, evidence: { ...ev, candidate: { amazonId: L.amazon[0], sources: a ? [vidrEvidence(a)] : [] } }, fingerprint: fp('UD', lk, 'PROPOSED', l.raw, L.amazon, a?.evidence.rows), safeAction: true }); continue; }
    if (L?.level === 'AMBIGUOUS') { put(key, { family: 'UNMATCHED_DOCUMENT', subtype: 'MULTIPLE_CANDIDATES', status: 'PRESENT', subject, evidence: { ...ev, why: `more than one Amazon transaction could belong to it (${L.amazon.length})`, candidates: L.amazon }, fingerprint: fp('UD', lk, 'AMBIG', l.raw, L.amazon) }); continue; }
    if (L?.level === 'OTHER_NUMBER') { noteAdd('A document for the same order is in the books under a different number than Amazon shows (comparison not part of this version)', lk); continue; }
    const cov = vidrCover(l);
    if (!cov.ok) { noteAdd('Absence from Amazon cannot be concluded: ' + cov.why[0].replace(/^[^:]*: /, ''), lk); put(key, { family: 'UNMATCHED_DOCUMENT', subtype: 'UNDETERMINED', status: 'UNDETERMINED', subject, evidence: ev, fingerprint: fp('UD', lk, 'NOCOV', cov.why), note: 'Absence from Amazon cannot be concluded: ' + cov.why.join(' | ') }); continue; }
    put(key, { family: 'UNMATCHED_DOCUMENT', subtype: 'NO_CANDIDATE', status: 'PRESENT', subject, evidence: { ...ev, coverage: cov.import }, fingerprint: fp('UD', lk, 'NOCAND', l.raw, l.issueDate, l.operationDate), safeAction: true });
  }
  const covNotes = [...noteGroup.values()].sort((a, b) => a.reason.localeCompare(b.reason));
  const docsFine = A.filter(d => d.state === 'ACCEPTED' && link.get(amazonId(d))?.level === 'CONFIRMED').length;
  return { mismatchFields, findings, closed, notes: covNotes, stats: { ...stats, matchedByInvoiceNumber: docsFine }, links: { link, ledLink }, amazonDocs: A, importDefects, ledgerDocs: Le };
}

/** @param {{imports:object[], events?:object[], sellerProfileId?:string}} input */
export function project({ imports, events = [], sellerProfileId = 'local' }) {
  const ordered = orderImports(imports), ctx = { seller: sellerProfileId, led: new Map(), rowIdx: new Map(), actions: new Map(), prevMismatch: new Map() };
  const rejectedEvents = [], goodEvents = [];
  for (const e of events) { const p = eventShapeProblem(e); if (p) rejectedEvents.push({ event: e, reason: p }); else goodEvents.push(e); }
  for (const e of goodEvents) if (e.type === 'ACTION_STARTED') { if (!ctx.actions.has(e.issueKey)) ctx.actions.set(e.issueKey, []); ctx.actions.get(e.issueKey).push(e); }
  const hist = new Map(); let last = { findings: new Map(), closed: new Map(), notes: [], stats: {}, links: {}, amazonDocs: [], importDefects: new Map(), ledgerDocs: [] };
  const n = ordered.length;
  for (let k = 0; k < n; k++) {
    const horizon = k < n - 1 ? Math.min(...ordered.slice(k + 1).map(i => ms(i.importedAt) ?? Infinity)) : Infinity;
    const ev = evaluate(ordered.slice(0, k + 1), goodEvents.filter(e => ms(e.createdAt) < horizon), ctx), imp = ordered[k];
    const seen = new Set();
    for (const [key, f] of ev.findings) { seen.add(key); if ((f.status === 'UNDETERMINED' || (f.status === 'DECLARED_LINK')) && !hist.get(key)?.some(h => h.status === 'PRESENT')) continue; if (!hist.has(key)) hist.set(key, []); hist.get(key).push({ k, importId: imp.id, fileName: imp.fileName ?? null, status: f.status, subtype: f.subtype, family: f.family, subject: f.subject, evidence: f.evidence, fingerprint: f.fingerprint, note: f.note ?? null }); }
    for (const [key, c] of ev.closed) { seen.add(key); if (hist.has(key)) hist.get(key).push({ k, importId: imp.id, fileName: imp.fileName ?? null, status: 'CLOSED', closure: c }); }
    for (const [key, h] of hist) if (!seen.has(key) && h.at(-1).k !== k) h.push({ k, importId: imp.id, fileName: imp.fileName ?? null, status: 'UNDETERMINED', note: 'Not evaluated in this set of files.' });
    for (const [key, fs] of ev.mismatchFields ?? []) ctx.prevMismatch.set(key, fs); for (const key of ev.closed.keys()) ctx.prevMismatch.delete(key);
    last = ev;
  }
  const issues = [];
  for (const [key, h] of hist) {
    if (!h.some(x => x.status === 'PRESENT')) continue;
    const final = h.at(-1), live = last.findings.get(key), pastP = h.findLast(x => x.status === 'PRESENT'), f = live ?? { family: pastP.family, subtype: pastP.subtype, subject: pastP.subject, fingerprint: null, safeAction: false }, closure = last.closed.get(key);
    const episodes = []; let cur = null;
    for (const x of h) { if (x.status === 'PRESENT' || x.status === 'DECLARED_LINK') { if (!cur) { cur = { from: x.importId, fromFile: x.fileName, to: null, closedBy: null }; episodes.push(cur); } cur.last = x.importId; } else if (x.status === 'CLOSED' && cur) { cur.to = x.importId; cur.closedBy = x.closure; cur = null; } }
    let state, outcome = null, awaiting = null, declaration = null, lapsed = [];
    if (final.status === 'CLOSED') { state = 'VERIFIED_CLOSED'; outcome = 'evidence'; }
    else {
      const family = f.family;
      const decls = goodEvents.filter(e => e.issueKey === key && DECLARATION_TYPES.includes(e.type)).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
      for (const e of decls) { const bad = declarationProblem(e, family, f.subtype); if (bad) { rejectedEvents.push({ event: e, reason: bad }); continue; } if (final.status === 'PRESENT' && e.basedOnFingerprint === f.fingerprint) declaration = e; else lapsed.push(e); }
      const started = goodEvents.filter(e => e.issueKey === key && e.type === 'ACTION_STARTED').sort((a, b) => ms(a.createdAt) - ms(b.createdAt)).at(-1);
      const relevant = (i) => f.family === 'INVOICE_AMAZON_STATE' ? !isLedger(i) && h.some(x => x.importId === i.id) : f.family === 'SOURCE_INCOMPLETE' ? descriptor(i) === f.subject.descriptor : (f.subject.marketplace ? (i.declared?.marketplace === f.subject.marketplace) : true);
      const newer = started ? ordered.filter(i => createdMs(i) !== null && createdMs(i) > ms(started.createdAt) && relevant(i)) : []; // by the file's own creation time, never by when it was uploaded
      if ((final.status === 'PRESENT' || final.status === 'DECLARED_LINK') && f.declared) { state = 'MANUALLY_REPORTED_RESOLUTION'; outcome = 'declaration'; declaration = f.declared.event; }
      else if (declaration) { state = 'MANUALLY_REPORTED_RESOLUTION'; outcome = 'declaration'; }
      else if (final.status === 'UNDETERMINED' && f?.processing) { state = 'AWAITING_NEW_EVIDENCE'; awaiting = 'AMAZON_PROCESSING'; }
      else if (started && !newer.length) { state = 'AWAITING_NEW_EVIDENCE'; awaiting = 'SELLER_REPORTED_ACTION'; }
      else if (final.status === 'UNDETERMINED') state = 'OPEN';
      else state = f.safeAction ? 'ACTION_REQUIRED' : 'OPEN';
    }
    const shown = live ?? null, pastFinding = { family: f.family, subtype: f.subtype, subject: f.subject };
    const issue = { key, family: pastFinding.family, subtype: pastFinding.subtype, state, outcome, awaiting, subject: pastFinding.subject,
      reopened: episodes.length > 1, episodes, history: h.map(x => ({ import: x.importId, file: x.fileName, status: x.status, subtype: x.subtype ?? null, note: x.note ?? null })),
      events: goodEvents.filter(e => e.issueKey === key).map(e => ({ id: e.id ?? null, type: e.type, kind: e.kind ?? null, author: e.author, createdAt: e.createdAt, reasoning: e.reasoning })),
      lapsedDeclarations: lapsed.map(e => ({ author: e.author, createdAt: e.createdAt, reasoning: e.reasoning })), declaration: declaration ? { author: declaration.author, createdAt: declaration.createdAt, reasoning: declaration.reasoning, kind: declaration.kind ?? declaration.type } : null,
      fingerprint: shown?.fingerprint ?? null, closure: final.status === 'CLOSED' ? closure ?? final.closure : null, finding: shown ? { evidence: shown.evidence, note: shown.note ?? null } : { evidence: pastP.evidence, note: null, lastSeen: true } };
    issue.card = buildCard(issue);
    issues.push(issue);
  }
  issues.sort((a, b) => a.key.localeCompare(b.key));
  const count = (s) => issues.filter(i => i.state === s).length;
  const buckets = { matchedByInvoiceNumber: last.stats.matchedByInvoiceNumber ?? 0, inProgressAtAmazon: last.stats.processing ?? 0, needsActionNow: count('ACTION_REQUIRED'), needsHumanReading: count('OPEN'), awaitingNewEvidence: count('AWAITING_NEW_EVIDENCE'),
    cannotDetermine: last.notes.reduce((n, g) => n + g.count, 0), reportedResolvedBySeller: count('MANUALLY_REPORTED_RESOLUTION'), closedWithEvidence: count('VERIFIED_CLOSED') };
  return { loopVersion: LOOP_VERSION, keyVersion: KEY_VERSION, sellerProfileId, issues, buckets, coverageNotes: last.notes, stats: last.stats, rejectedEvents, notCheckedInThisVersion: NOT_CHECKED_IN_THIS_VERSION,
    imports: ordered.map(i => ({ id: i.id, kind: isLedger(i) ? 'ledger' : 'vidr', fileName: i.fileName ?? null, importedAt: i.importedAt, descriptor: descriptor(i), defects: last.importDefects.get(i.id)?.defects ?? [], scopeNotes: last.importDefects.get(i.id)?.scopeNotes ?? [] })) };
}
