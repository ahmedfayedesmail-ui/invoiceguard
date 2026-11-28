// Input layer for the VAT Invoice Data Report (VIDR): bytes -> text, and text -> the canonical tab-separated form that parseVidr reads.
// Why it exists (verified against Amazon's own samples, 28 Nov 2026): the documented flat file is tab-delimited, but Amazon's OWN CSV sample is comma-separated and is not valid UTF-8
// (single bytes 0x81, 0x82, 0x84, 0x85 in names and citations, which are CP437/CP850 umlauts and accents). Amazon also publishes an XML variant of the same report.
// Rules: never guess. Anything that cannot be read exactly is reported, and a row whose text cannot be read exactly is held (see unreadableCells) instead of being issued.

/** Bytes -> text. UTF-8 when the bytes are valid UTF-8 (a BOM is dropped); otherwise a byte-for-byte latin-1 read, flagged, because the real encoding is then unknown. */
export function decodeReportBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^\uFEFF/, ''), encoding: 'utf-8', fallback: false }; }
  catch { return { text: b.toString('latin1'), encoding: 'latin1-fallback', fallback: true }; }
}

/** The characters a wrong encoding leaves behind: C1 controls (U+0080-U+009F, what latin-1 makes of CP437/CP850 accents) and the replacement character. A cell holding one is not read exactly. */
const UNREADABLE = /[\u0080-\u009F\uFFFD]/;
export const hasUnreadableText = (s) => UNREADABLE.test(String(s ?? ''));
/** Columns of one parsed row that hold unreadable text (names of columns only, never cell content). */
export const unreadableCells = (row) => Object.entries(row ?? {}).filter(([, v]) => hasUnreadableText(v)).map(([k]) => k);

/** The correction columns of the current report. Older samples (Amazon's own) lack them: absence is reported, never read as "not corrected". */
export const CORRECTION_COLUMNS = ['is-invoice-corrected', 'original-vat-invoice-number', 'invoice-correction-details'];

const firstLine = (t) => { const i = t.search(/\r?\n/); return i < 0 ? t : t.slice(0, i); };
/** Counts a character outside double quotes. */
const countOutsideQuotes = (line, ch) => { let q = false, n = 0; for (const c of line) { if (c === '"') q = !q; else if (c === ch && !q) n++; } return n; };

/** Delimiter of a flat file, read from its header line. '\t' or ',' (the more frequent one, at least 2 occurrences); null when neither is clear. A semicolon header is reported as 'semicolon' (not supported). */
export function detectDelimiter(text) {
  const h = firstLine(String(text ?? '').replace(/^\uFEFF/, ''));
  const tab = countOutsideQuotes(h, '\t'), com = countOutsideQuotes(h, ','), semi = countOutsideQuotes(h, ';');
  if (tab >= 2 && tab >= com) return '\t';
  if (com >= 2 && com > tab) return ',';
  if (semi >= 2) return 'semicolon';
  return null;
}

/** RFC 4180 reader. Returns { records, unterminated }. A cell holding a tab or a line break cannot be written in tab-separated form: it is replaced by U+FFFD so the row is held as unreadable, never repaired. */
function readCsv(text) {
  const records = []; let cells = [], cur = '', q = false, i = 0, started = false, unterminated = false;
  const endCell = () => { cells.push(cur); cur = ''; };
  const endRec = () => { endCell(); records.push(cells); cells = []; started = false; };
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } q = false; i++; continue; }
      cur += (c === '\n' || c === '\r' || c === '\t') ? '\uFFFD' : c; i++; continue;
    }
    if (c === '"' && cur === '') { q = true; started = true; i++; continue; }
    if (c === ',') { endCell(); started = true; i++; continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; if (started || cur !== '' || cells.length) endRec(); else records.push([]); i++; continue; }
    cur += c; started = true; i++;
  }
  if (q) { unterminated = true; cells.push('\uFFFD'); records.push(cells); }
  else if (started || cur !== '' || cells.length) endRec();
  return { records, unterminated };
}

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const unescapeXml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

/** Report-level and item-level XML elements -> flat-file columns. Component types become columns by their kebab-case name (ItemVatInclAmount -> item-vat-incl-amount). */
const XML_ADDR = { Name: 'name', AddressFieldOne: 'address-1', AddressFieldTwo: 'address-2', AddressFieldThree: 'address-3', City: 'city', StateOrRegion: 'state', PostalCode: 'postal-code', CountryCode: 'country', PhoneNumber: 'phone-number' };
const XML_SCALAR = {
  AmazonOrderID: 'order-id', OrderDate: 'order-date', MarketplaceId: 'marketplace-id', FulfillmentServiceLevel: 'ship-service-level', IsBusinessOrder: 'is-business-order', FulfillmentMethod: 'fulfilled-by', BuyerName: 'buyer-name', BuyerCompanyName: 'buyer-company-name',
  AmazonOrderItemCode: 'order-item-id', LegacyCustomerOrderItemId: 'legacy-customer-order-item-id', ShippingId: 'shipping-id', ShipmentDate: 'shipment-date', TransactionId: 'transaction-id', TransactionType: 'transaction-type', ASIN: 'asin', SKU: 'sku', Title: 'product-name', Quantity: 'quantity-purchased',
  ItemVatRate: 'item-vat-rate', ItemPromoVatRate: 'item-promo-vat-rate', ItemPromotionId: 'item-promotion-id', GiftVatRate: 'gift-wrap-vat-rate', GiftPromoVatRate: 'gift-promo-vat-rate', GiftPromotionId: 'gift-promotion-id', ShipVatRate: 'shipping-vat-rate', ShipPromoVatRate: 'shipping-promo-vat-rate', ShippingPromotionId: 'ship-promotion-id',
  IsAmazonInvoiced: 'is-amazon-invoiced', InvoiceStatus: 'invoice-status', InvoiceStatusDescription: 'invoice-status-description', InvoiceNumber: 'invoice-number', SellerVatNumber: 'seller-vat-number', BuyerVatNumber: 'buyer-vat-number', BuyerTaxRegistrationType: 'buyer-tax-registration-type',
  IsBuyerPhysicallyPresent: 'is-buyer-physically-present', IsSellerPhysicallyPresent: 'is-seller-physically-present', RecommendedInvoiceFormat: 'recommended-invoice-format', BuyerEInvoiceAccountId: 'buyer-e-invoice-account-id', PurchaseOrderNumber: 'purchase-order-number', PriceDesignation: 'price-designation',
  CitationEs: 'citation-es', CitationIt: 'citation-it', CitationFr: 'citation-fr', CitationDe: 'citation-de', CitationEn: 'citation-en',
  IsInvoiceCorrected: 'is-invoice-corrected', OriginalVatInvoiceNumber: 'original-vat-invoice-number', InvoiceCorrectionDetails: 'invoice-correction-details',
};
const ADDR_PREFIX = { BillingAddress: 'bill-', Address: 'ship-', ShipFromAddress: 'ship-from-' };
const ADDR_NAME = { BillingAddress: 'billing-name', Address: 'recipient-name', ShipFromAddress: 'ship-from-name' };
const ADDR_COL = (parent, el) => { const f = XML_ADDR[el]; if (!f) return null; if (f === 'name') return ADDR_NAME[parent]; const p = ADDR_PREFIX[parent]; return f === 'country' ? (parent === 'ShipFromAddress' ? 'ship-from-country' : p + 'country') : f === 'phone-number' ? (parent === 'BillingAddress' ? 'billing-phone-number' : parent === 'Address' ? 'ship-phone-number' : 'ship-from-phone-number') : p + f; };

/** XML VIDR -> flat rows (one per Item). Tolerant: unknown elements are counted and ignored; a malformed document returns { error }. Tag-level scan only: no DTD, no entity expansion beyond the five XML escapes and numeric references. */
export function xmlToRows(xml) {
  const text = String(xml).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { error: 'The XML file declares a DOCTYPE or entities, which are not read.' };
  const tok = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.\-:]*)([^>]*?)(\/?)>|([^<]+)/g;
  const rows = [], unknown = new Map(); const stack = []; let report = null, items = [], item = null, comp = null, sawEnvelope = false, depthErr = null, m;
  const add = (o, k, v) => { if (k) o[k] = v; };
  while ((m = tok.exec(text))) {
    if (m[5] !== undefined) { const t = unescapeXml(m[5]); if (stack.length) stack[stack.length - 1].text += t; continue; }
    if (m[2] === undefined) continue;
    const [, closing, name, attrs, selfClose] = m;
    if (!closing) {
      const node = { name, text: '', attrs, parent: stack[stack.length - 1]?.name }; if (name === 'AmazonEnvelope') sawEnvelope = true;
      if (name === 'ShipmentReport') { report = {}; items = []; }
      if (name === 'Item' && report) { item = {}; }
      if (name === 'Component') comp = { type: '', amount: '', currency: '' };
      if (!selfClose) stack.push(node); else { node.closed = true; stack.push(node); closeNode(); }
    } else {
      if (!stack.length || stack[stack.length - 1].name !== name) { depthErr = `unexpected closing tag ${name}`; break; }
      closeNode();
    }
  }
  function closeNode() {
    const n = stack.pop(), v = n.text.trim(), par = n.parent, grand = stack[stack.length - 2]?.name;
    if (n.name === 'Item' && item) { items.push(item); item = null; return; }
    if (n.name === 'ShipmentReport' && report) { for (const it of items) rows.push({ ...report, ...it }); report = null; items = []; return; }
    if (n.name === 'Component' && comp) { if (comp.type && item) { item[kebab(comp.type)] = comp.amount; if (comp.currency && !item.currency) item.currency = comp.currency; else if (comp.currency && item.currency !== comp.currency) item.currency = '\uFFFD'; } comp = null; return; }
    if (comp && par === 'Component') { if (n.name === 'Type') comp.type = v; else if (n.name === 'Amount') { comp.amount = v; comp.currency = (/currency\s*=\s*"([^"]*)"/.exec(n.attrs ?? '') ?? [])[1] ?? ''; } return; }
    const target = item ?? report; if (!target) return;
    if (ADDR_PREFIX[par] && XML_ADDR[n.name]) { add(target, ADDR_COL(par, n.name), v); return; }
    if (par === 'BuyerData' && n.name === 'BuyerName') { add(target, 'buyer-name', v); return; }
    if (XML_SCALAR[n.name]) { add(target, XML_SCALAR[n.name], v); return; }
    const container = ['Item', 'ShipmentReport', 'Message', 'AmazonEnvelope', 'Header', 'BuyerData', 'BillingAddress', 'ShippingDetails', 'Address', 'ShipFromAddress', 'ItemPriceData', 'ItemPromotion', 'Gift', 'GiftPromotion', 'Shipping', 'ShippingPromotion', 'Component', 'Type', 'Amount', 'DocumentVersion', 'MessageType', 'MessageID'];
    if (!container.includes(n.name)) unknown.set(n.name, (unknown.get(n.name) ?? 0) + 1);
  }
  if (depthErr) return { error: `The XML file is not well formed (${depthErr}).` };
  if (stack.length) return { error: 'The XML file is cut off: an element is never closed.' };
  if (!sawEnvelope) return { error: 'The XML file has no AmazonEnvelope element.' };
  return { rows, unknownElements: [...unknown.keys()].sort() };
}

// Canonical column order of the flat file (Amazon's current report). Columns the source lacks are simply absent from the header, never filled.
const CANON = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-number', 'invoice-status', 'invoice-status-description', 'is-amazon-invoiced', 'order-date', 'shipment-date', 'buyer-vat-number', 'seller-vat-number', 'asin', 'sku', 'product-name', 'quantity-purchased', 'currency'];
const tsvLine = (cells) => cells.map(c => String(c ?? '').replace(/[\t\r\n]+/g, '\uFFFD')).join('\t');

/**
 * Any supported VIDR text -> canonical tab-separated text plus facts about the input.
 * source: 'tsv' (returned unchanged), 'csv', 'xml'. { text, source, notes[], error? }. A text that is none of them is returned unchanged with source 'unknown' so the caller's own checks and messages apply.
 */
export function normalizeReport(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, ''); const notes = [];
  if (/^\s*(<\?xml|<AmazonEnvelope)/i.test(text)) {
    const x = xmlToRows(text); if (x.error) return { text: '', source: 'xml', notes, error: x.error };
    if (!x.rows.length) return { text: '', source: 'xml', notes, error: 'The XML file holds no shipment items.' };
    const cols = new Set(); x.rows.forEach(r => Object.keys(r).forEach(k => cols.add(k)));
    const head = [...CANON.filter(c => cols.has(c)), ...[...cols].filter(c => !CANON.includes(c)).sort()];
    if (x.unknownElements.length) notes.push(`${x.unknownElements.length} XML element name(s) are not mapped to a column and were ignored: ${x.unknownElements.slice(0, 12).join(', ')}`);
    const conflict = x.rows.filter(r => r.currency === '\uFFFD').length; if (conflict) notes.push(`${conflict} XML item(s) carry amounts in more than one currency; the currency is not known, so they are held`);
    return { text: [tsvLine(head), ...x.rows.map(r => tsvLine(head.map(h => r[h] ?? '')))].join('\n'), source: 'xml', notes, rowsInSource: x.rows.length, head };
  }
  const d = detectDelimiter(text);
  if (d === ',') {
    const { records, unterminated } = readCsv(text);
    if (unterminated) notes.push('A quoted cell is never closed: the rest of the file could not be split into rows and was not used.');
    notes.push('Comma-separated file (the documented format is tab-separated).');
    return { text: records.map(tsvLine).join('\n'), source: 'csv', notes, unterminatedQuote: unterminated };
  }
  if (d === 'semicolon') return { text, source: 'unknown', notes, delimiter: 'semicolon' };
  return { text, source: d === '\t' ? 'tsv' : 'unknown', notes };
}

/** Honest account of which current columns a report lacks. */
export function absentColumns(head) {
  const h = new Set(head ?? []);
  return { correction: CORRECTION_COLUMNS.filter(c => !h.has(c)) };
}
