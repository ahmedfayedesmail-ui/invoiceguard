// Accounting export reader. Maps ANY column naming into one shape, and refuses what it cannot read exactly. Nothing is guessed:
// a column is mapped only when its header AND its cells agree, or the seller confirms it in a saved mapping profile.
// Amounts are integer minor units. Dates and decimal separators follow the profile's declaration.
export const LEDGER_MAX_ROWS = 20000;
export const PARSER_VERSION = 'ledger-1';
export const FIELDS = ['number', 'kind', 'series', 'issueDate', 'operationDate', 'currency', 'gross', 'net', 'vat', 'issuerTaxId', 'buyerTaxId', 'orderRef', 'channel', 'originalRef'];
export const REQUIRED = ['number', 'issueDate', 'currency']; // plus kind, or a declared constant kind
const norm = (h) => String(h ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const DICT = {
  number: ['invoice number', 'invoice no', 'invoice nr', 'invoice id', 'document number', 'document no', 'doc number', 'numero de factura', 'numero factura', 'n factura', 'num factura', 'numero de documento', 'rechnungsnummer', 'rechnungsnr', 'dokumentnummer', 'numero de facture', 'numero fattura', 'numero documento', 'number'],
  kind: ['document type', 'doc type', 'type', 'document kind', 'kind', 'tipo', 'tipo de documento', 'tipo documento', 'dokumenttyp', 'belegart', 'type de document', 'tipo di documento'],
  series: ['series', 'serie', 'invoice series', 'serie de factura'],
  issueDate: ['invoice date', 'issue date', 'date issued', 'date', 'fecha', 'fecha de factura', 'fecha factura', 'fecha de emision', 'fecha emision', 'rechnungsdatum', 'datum', 'date de facture', 'data fattura'],
  operationDate: ['order date', 'operation date', 'sale date', 'sales date', 'fecha de operacion', 'fecha operacion', 'fecha de venta', 'fecha pedido', 'bestelldatum', 'date de commande', 'data ordine'],
  currency: ['currency', 'moneda', 'divisa', 'wahrung', 'whrung', 'devise', 'valuta'],
  gross: ['gross', 'gross amount', 'total', 'total amount', 'total gross', 'importe total', 'total factura', 'brutto', 'bruttobetrag', 'total ttc', 'totale'],
  net: ['net', 'net amount', 'total net', 'base imponible', 'importe neto', 'netto', 'nettobetrag', 'total ht', 'imponibile'],
  vat: ['vat', 'vat amount', 'tax', 'tax amount', 'iva', 'cuota iva', 'importe iva', 'mwst', 'umsatzsteuer', 'tva', 'imposta'],
  issuerTaxId: ['issuer vat', 'issuer tax id', 'seller vat', 'seller tax id', 'nif emisor', 'nif del emisor', 'ust id verkaufer', 'ust idnr aussteller'],
  buyerTaxId: ['buyer vat', 'buyer tax id', 'customer vat', 'customer tax id', 'vat number', 'nif cliente', 'nif comprador', 'cif cliente', 'ust idnr kaufer', 'ust idnr kunde'],
  orderRef: ['amazon order id', 'order id', 'amazon order', 'order reference', 'order ref', 'pedido amazon', 'id de pedido', 'referencia pedido', 'referencia de pedido', 'bestellnummer', 'numero de pedido', 'numero de commande'],
  channel: ['channel', 'sales channel', 'canal', 'canal de venta', 'marketplace', 'verkaufskanal', 'source', 'origen'],
  originalRef: ['original invoice', 'original document', 'rectifies', 'factura rectificada', 'factura original', 'documento original'],
};
const KIND_WORDS = { invoice: ['invoice', 'factura', 'rechnung', 'facture', 'fattura', 'factura emitida'], credit_note: ['credit note', 'creditnote', 'credit memo', 'abono', 'nota de credito', 'factura de abono', 'factura rectificativa', 'rectificativa', 'gutschrift', 'avoir', 'nota di credito', 'nota credito'] };
export const kindOf = (v) => { const n = norm(v); for (const [k, ws] of Object.entries(KIND_WORDS)) if (ws.includes(n)) return k; return null; };

/** Quote-aware delimited reader. Returns arrays of cells. */
export function splitLine(line, d) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur === '') q = true; else if (c === d) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out.map(x => x.trim());
}
export function readDelimited(text, delimiter = null) {
  text = String(text ?? '').replace(/^\uFEFF/, '');
  const all = text.split(/\r?\n/), isBlank = (l) => !l.trim();
  let lo = 0, hi = all.length; while (lo < hi && isBlank(all[lo])) lo++; while (hi > lo && isBlank(all[hi - 1])) hi--;
  const lines = all.slice(lo, hi); if (lines.length < 2) return { ok: false, error: 'The file has no header and data rows.' };
  const count = (c) => splitLine(lines[0], c).length;
  const d = delimiter ?? ['\t', ';', ','].map(c => [c, count(c)]).sort((a, b) => b[1] - a[1] || '\t;,'.indexOf(a[0]) - '\t;,'.indexOf(b[0]))[0][0];
  const head = splitLine(lines[0], d); if (head.length < 2) return { ok: false, error: 'The file does not look like a table with columns.' };
  const body = lines.slice(1), kept = body.slice(0, LEDGER_MAX_ROWS); let blankLines = 0, raggedRows = 0; const rows = [];
  kept.forEach((l, i) => { if (isBlank(l)) { blankLines++; return; } const cells = splitLine(l, d); if (cells.length !== head.length) raggedRows++; rows.push({ row: lo + i + 2, cells }); });
  return { ok: true, delimiter: d, head, rows, truncated: body.length > LEDGER_MAX_ROWS, blankLines, raggedRows };
}

const validDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return m >= 1 && m <= 12 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** All readings a date value allows: { ISO?, DMY?, MDY? } each an ISO day or absent. A value is never read under an order the profile does not declare. */
export function dateReadings(v) {
  const s = String(v ?? '').trim(), r = {}; let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)) && validDay(+m[1], +m[2], +m[3])) r.ISO = iso(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) { if (validDay(+m[3], +m[2], +m[1])) r.DMY = iso(+m[3], +m[2], +m[1]); if (validDay(+m[3], +m[1], +m[2])) r.MDY = iso(+m[3], +m[1], +m[2]); }
  return r;
}
export function readDate(v, order) { const r = dateReadings(v); return r.ISO ?? (order === 'DMY' ? r.DMY : order === 'MDY' ? r.MDY : undefined) ?? null; }
/** Integer minor units, or NaN when the text cannot be read exactly under the declared separators. Blank is null. */
export function readMoney(v, decimal, thousands = '') {
  let s = String(v ?? '').trim(); if (s === '') return null;
  const dec = decimal === ',' ? ',' : '.', esc = (c) => c.replace(/[.\-\\^$*+?()[\]{}|]/g, '\\$&');
  const grp = thousands ? `(?:\\d{1,3}(?:${esc(thousands)}\\d{3})+|\\d+)` : '\\d+';
  const m = new RegExp(`^(-?)(${grp})(?:${esc(dec)}(\\d{1,2}))?$`).exec(s); if (!m) return NaN;
  const whole = m[2].split(thousands || '\u0000').join(''), frac = (m[3] ?? '').padEnd(2, '0');
  return (m[1] ? -1 : 1) * (parseInt(whole, 10) * 100 + parseInt(frac || '0', 10));
}

/** A proposal only. Nothing in it is stored until the seller confirms a profile. */
export function detectLedgerMapping(text) {
  const t = readDelimited(text); if (!t.ok) return { ok: false, error: t.error };
  const heads = t.head.map(norm), cols = (i) => t.rows.map(r => r.cells[i] ?? '').filter(x => x !== ''), fields = {}, used = new Map();
  for (const f of FIELDS) {
    const cand = heads.map((h, i) => DICT[f].includes(h) ? i : -1).filter(i => i >= 0);
    if (cand.length === 0) { fields[f] = { status: REQUIRED.includes(f) || f === 'kind' ? 'MISSING' : 'ABSENT', header: null, candidates: [] }; continue; }
    if (cand.length > 1) { fields[f] = { status: 'AMBIGUOUS', header: null, candidates: cand.map(i => t.head[i]), reason: 'More than one column fits this field. Choose one.' }; continue; }
    const i = cand[0], vals = cols(i); let bad = 0, example = null, reason = null;
    const fail = (v, why) => { bad++; if (example === null) { example = v; reason = why; } };
    if (f === 'issueDate' || f === 'operationDate') vals.forEach(v => { if (!Object.keys(dateReadings(v)).length) fail(v, 'not a date we can read'); });
    else if (f === 'currency') vals.forEach(v => { if (!/^[A-Za-z]{3}$/.test(v)) fail(v, 'not a three-letter currency code'); });
    else if (f === 'orderRef') vals.forEach(v => { if (!/^\d{3}-\d{7}-\d{7}$/.test(v)) fail(v, 'not an Amazon order id (3-7-7 digits)'); });
    else if (f === 'kind') vals.forEach(v => { if (!kindOf(v)) fail(v, 'a document type we do not recognise'); });
    else if (f === 'number') { if (!vals.length) fail('', 'no document numbers at all'); }
    fields[f] = bad ? { status: 'CONTENT_FAILED', header: t.head[i], candidates: [t.head[i]], reason: `${bad} cell(s) fail, for example ${JSON.stringify(example)}: ${reason}.` } : { status: 'DETECTED', header: t.head[i], candidates: [t.head[i]] };
    if (!bad) used.set(i, f);
  }
  const unknownColumns = t.head.filter((h, i) => !used.has(i));
  // Dates: proof from the file, never from a global guess.
  const dateCols = ['issueDate', 'operationDate'].map(f => fields[f].header).filter(Boolean).map(h => t.head.indexOf(h));
  let dmy = 0, mdy = 0, isoOnly = 0, amb = 0, n = 0;
  for (const i of dateCols) for (const v of cols(i)) { n++; const r = dateReadings(v); if (r.ISO) { isoOnly++; continue; } if (r.DMY && !r.MDY) dmy++; else if (r.MDY && !r.DMY) mdy++; else if (r.DMY && r.MDY) amb++; }
  const dateOrder = !n ? { status: 'NONE' } : dmy && mdy ? { status: 'CONTRADICTION', reason: 'Some dates can only be day first and others only month first.' } : isoOnly === n ? { status: 'PROVEN', proposed: 'ISO' } : dmy ? { status: 'PROVEN', proposed: 'DMY' } : mdy ? { status: 'PROVEN', proposed: 'MDY' } : { status: 'AMBIGUOUS', reason: 'Every date fits both day-first and month-first. Say which one this file uses.' };
  // Money: decimal comma or point, from the cells.
  const moneyCols = ['gross', 'net', 'vat'].map(f => fields[f].header).filter(Boolean).map(h => t.head.indexOf(h));
  let comma = 0, point = 0, both = 0, mn = 0;
  for (const i of moneyCols) for (const v of cols(i)) { mn++; const c = /,\d{1,2}$/.test(v), p = /\.\d{1,2}$/.test(v), thC = /,\d{3}/.test(v), thP = /\.\d{3}($|[^\d])/.test(v); if (c && !p && !thC) comma++; else if (p && !c && !thP) point++; else if (/^-?\d+$/.test(v)) { /* integer: fits both */ } else both++; }
  const decimal = !mn ? { status: 'NONE' } : comma && point ? { status: 'CONTRADICTION' } : comma ? { status: 'PROPOSED', proposed: ',' } : point ? { status: 'PROPOSED', proposed: '.' } : { status: both ? 'AMBIGUOUS' : 'PROPOSED', proposed: '.' };
  const kindColumn = fields.kind.status === 'DETECTED';
  const problems = []; // the page must show these; any of them stops the import until the seller fixes the mapping
  for (const f of [...REQUIRED, ...(kindColumn ? [] : [])]) if (fields[f].status !== 'DETECTED') problems.push({ field: f, status: fields[f].status, reason: fields[f].reason ?? `No column found for "${f}".` });
  if (!kindColumn && fields.kind.status !== 'MISSING') problems.push({ field: 'kind', status: fields.kind.status, reason: fields.kind.reason });
  if (dateOrder.status === 'CONTRADICTION') problems.push({ field: 'dates', status: 'CONTRADICTION', reason: dateOrder.reason });
  if (decimal.status === 'CONTRADICTION') problems.push({ field: 'amounts', status: 'CONTRADICTION', reason: 'Some amounts use a decimal comma and others a decimal point.' });
  return { ok: true, delimiter: t.delimiter, headers: t.head, rowCount: t.rows.length, truncated: t.truncated, blankLines: t.blankLines, raggedRows: t.raggedRows, fields, unknownColumns, dateOrder, decimal, needsKindDeclaration: !kindColumn, problems,
    proposedProfile: { delimiter: t.delimiter, columns: Object.fromEntries(FIELDS.filter(f => fields[f].status === 'DETECTED').map(f => [f, fields[f].header])), constantKind: null, dateOrder: dateOrder.proposed ?? null, decimal: decimal.proposed ?? null, thousands: '', unknownColumnsAcknowledged: false, confirmed: false } };
}

/** Is this profile one the seller confirmed, and complete enough to read the file? Returns a list of plain-language problems (empty = usable). */
export function profileProblems(profile, head) {
  const p = []; if (!profile || typeof profile !== 'object') return ['No mapping profile.'];
  if (profile.confirmed !== true) p.push('The seller has not confirmed the column mapping.');
  const cols = profile.columns ?? {};
  for (const f of REQUIRED) if (!cols[f]) p.push(`No column is mapped for "${f}".`);
  if (!cols.kind && !['invoice', 'credit_note'].includes(profile.constantKind)) p.push('No document type column is mapped and the seller has not declared what every row is.');
  for (const [f, h] of Object.entries(cols)) { if (!FIELDS.includes(f)) p.push(`Unknown field "${f}".`); else if (head && !head.includes(h)) p.push(`The mapped column "${h}" is not in this file.`); }
  if ((new Set(Object.values(cols))).size !== Object.values(cols).length) p.push('One column is mapped to two fields.');
  if (!['ISO', 'DMY', 'MDY'].includes(profile.dateOrder)) p.push('The date order is not declared.');
  if ((cols.gross || cols.net || cols.vat) && ![',', '.'].includes(profile.decimal)) p.push('The decimal separator is not declared.');
  if (head) { const mapped = new Set(Object.values(cols)), unk = head.filter(h => !mapped.has(h)); if (unk.length && profile.unknownColumnsAcknowledged !== true) p.push(`Columns not mapped and not acknowledged: ${unk.join(', ')}.`); }
  return p;
}

/**
 * Applies a confirmed profile. Returns documents (one per readable row) and rejected rows with reasons. Nothing is dropped silently.
 * `amazonScope`: {mode:'ALL'|'CHANNEL'|'UNKNOWN', channelValues:[]} decides each document's isAmazon (true/false/null).
 */
export function readLedger(text, profile, { importId = null, amazonScope = { mode: 'UNKNOWN' }, sourceSystem = '' } = {}) {
  const t = readDelimited(text, profile?.delimiter ?? null);
  if (!t.ok) return { ok: false, error: t.error, documents: [], rejected: [], defects: [t.error], parserVersion: PARSER_VERSION };
  const probs = profileProblems(profile, t.head);
  const base = { parserVersion: PARSER_VERSION, rowCount: t.rows.length, truncated: t.truncated, blankLines: t.blankLines, raggedRows: t.raggedRows, head: t.head };
  if (probs.length) return { ok: false, ...base, error: probs.join(' '), documents: [], rejected: [], defects: probs };
  const ix = Object.fromEntries(Object.entries(profile.columns).map(([f, h]) => [f, t.head.indexOf(h)])), documents = [], rejected = [];
  const chan = new Set((amazonScope.channelValues ?? []).map(norm));
  for (const { row, cells } of t.rows) {
    const reasons = [], g = (f) => ix[f] === undefined ? '' : (cells[ix[f]] ?? '');
    if (cells.length !== t.head.length) { rejected.push({ row, reasons: ['WRONG_CELL_COUNT: the row has a different number of columns from the header'], cells }); continue; }
    const number = g('number'); if (!number) reasons.push('BLANK_NUMBER: the document number is empty');
    const kind = ix.kind !== undefined ? kindOf(g('kind')) : profile.constantKind; if (!kind) reasons.push(`UNREADABLE_KIND: ${JSON.stringify(g('kind'))} is not a document type we recognise`);
    const issueDate = readDate(g('issueDate'), profile.dateOrder); if (!issueDate) reasons.push(`BAD_ISSUE_DATE: ${JSON.stringify(g('issueDate'))} cannot be read as a date in the declared order`);
    let operationDate = null; if (ix.operationDate !== undefined && g('operationDate') !== '') { operationDate = readDate(g('operationDate'), profile.dateOrder); if (!operationDate) reasons.push(`BAD_OPERATION_DATE: ${JSON.stringify(g('operationDate'))} cannot be read as a date in the declared order`); }
    const currency = g('currency').toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) reasons.push(`BAD_CURRENCY: ${JSON.stringify(g('currency'))}`);
    const money = {}; for (const f of ['gross', 'net', 'vat']) if (ix[f] !== undefined) { const v = readMoney(g(f), profile.decimal, profile.thousands ?? ''); if (Number.isNaN(v)) reasons.push(`BAD_AMOUNT_${f.toUpperCase()}: ${JSON.stringify(g(f))} cannot be read exactly with decimal "${profile.decimal}"`); else money[f] = v; }
    const orderRef = g('orderRef'); if (orderRef && !/^\d{3}-\d{7}-\d{7}$/.test(orderRef)) reasons.push(`BAD_ORDER_REF: ${JSON.stringify(orderRef)}`);
    if (reasons.length) { rejected.push({ row, reasons, cells }); continue; }
    const channel = ix.channel !== undefined ? g('channel') : null;
    const isAmazon = amazonScope.mode === 'ALL' ? true : amazonScope.mode === 'CHANNEL' ? (channel !== null && chan.has(norm(channel))) : null;
    documents.push({ importId, row, number, kind, series: g('series'), issueDate, operationDate, currency, gross: money.gross ?? null, net: money.net ?? null, vat: money.vat ?? null,
      issuerTaxId: g('issuerTaxId'), buyerTaxId: g('buyerTaxId'), orderRef: orderRef || null, channel, originalRef: g('originalRef') || null, isAmazon,
      identity: ['led', sourceSystem, kind, g('series'), number, g('issuerTaxId')].join('|'), raw: cells });
  }
  const defects = []; if (rejected.length) defects.push(`${rejected.length} row(s) could not be read exactly and were rejected`); if (t.truncated) defects.push('only the first part of the file was read'); if (t.blankLines) defects.push(`${t.blankLines} blank line(s) inside the data`); if (t.raggedRows) defects.push(`${t.raggedRows} row(s) with the wrong number of columns`);
  return { ok: true, ...base, documents, rejected, defects };
}
