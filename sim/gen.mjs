// 500-seller simulation: SYNTHETIC data generator with ground truth built by construction (never by calling the engine).
export const rng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
export const MKTS = [['ES', 'A1RKKUPIHCS9HS', 'EUR', 'Amazon.es'], ['DE', 'A1PA6795UKMFR9', 'EUR', 'Amazon.de'], ['FR', 'A13V1IB3VIYZZH', 'EUR', 'Amazon.fr'], ['IT', 'APJ6JRA9NG5V4', 'EUR', 'Amazon.it'], ['NL', 'A1805IZSGTT6HS', 'EUR', 'Amazon.nl'], ['PL', 'A1C3SOZRARQ6R3', 'PLN', 'Amazon.pl'], ['SE', 'A2NODRKZP88ZB9', 'SEK', 'Amazon.se'], ['BE', 'AMEN7PMS3EDWL', 'EUR', 'Amazon.com.be']];
export const DIALECTS = [
  { id: 'es', h: ['Nº factura', 'Tipo', 'Fecha factura', 'Fecha operación', 'Divisa', 'Total', 'Base imponible', 'IVA', 'Pedido Amazon', 'Canal', 'NIF cliente'], inv: 'Factura', cn: 'Abono', delim: ';', dec: ',', date: 'DMY', sep: '/' },
  { id: 'de', h: ['Rechnungsnummer', 'Belegart', 'Rechnungsdatum', 'Leistungsdatum', 'Währung', 'Brutto', 'Netto', 'USt', 'Amazon Bestellnummer', 'Kanal', 'USt-IdNr. Kunde'], inv: 'Rechnung', cn: 'Gutschrift', delim: ';', dec: ',', date: 'DMY', sep: '.' },
  { id: 'en', h: ['Invoice Number', 'Document Type', 'Invoice Date', 'Order Date', 'Currency', 'Gross', 'Net', 'VAT', 'Amazon Order ID', 'Channel', 'Buyer VAT'], inv: 'Invoice', cn: 'Credit Note', delim: ',', dec: '.', date: 'ISO', sep: '-' },
  { id: 'fr', h: ['N° facture', 'Type', 'Date facture', 'Date opération', 'Devise', 'Total TTC', 'Total HT', 'TVA', 'Commande Amazon', 'Canal', 'N° TVA client'], inv: 'Facture', cn: 'Avoir', delim: ';', dec: ',', date: 'DMY', sep: '/' },
  { id: 'it', h: ['Numero fattura', 'Tipo documento', 'Data fattura', 'Data operazione', 'Valuta', 'Totale', 'Imponibile', 'IVA', 'Ordine Amazon', 'Canale', 'Partita IVA cliente'], inv: 'Fattura', cn: 'Nota di credito', delim: ';', dec: ',', date: 'DMY', sep: '/' },
  { id: 'pl', h: ['Numer faktury', 'Typ', 'Data wystawienia', 'Data sprzedaży', 'Waluta', 'Brutto', 'Netto', 'VAT', 'Zamówienie Amazon', 'Kanał', 'NIP nabywcy'], inv: 'Faktura', cn: 'Korekta', delim: ';', dec: ',', date: 'ISO', sep: '-' },
  { id: 'nl', h: ['Factuurnummer', 'Soort', 'Factuurdatum', 'Leverdatum', 'Valuta', 'Totaal', 'Netto', 'BTW', 'Amazon bestelling', 'Kanaal', 'BTW-nummer klant'], inv: 'Factuur', cn: 'Creditnota', delim: ';', dec: ',', date: 'DMY', sep: '-' },
  { id: 'en-us', h: ['Invoice No', 'Type', 'Date', 'Sale Date', 'Currency', 'Total', 'Net Amount', 'Tax', 'Order ID', 'Sales Channel', 'Customer VAT'], inv: 'Invoice', cn: 'Credit Memo', delim: '\t', dec: '.', date: 'ISO', sep: '-' },
  { id: 'en-th', h: ['Document Number', 'Doc Type', 'Issue Date', 'Operation Date', 'Currency', 'Gross Amount', 'Net Amount', 'VAT Amount', 'Order Reference', 'Source', 'Buyer Tax ID'], inv: 'Invoice', cn: 'Credit Note', delim: ',', dec: '.', date: 'ISO', sep: '-', thousands: ',' },
];
const SERIES = [(i, y) => `FA-${y}-${String(i).padStart(4, '0')}`, (i, y) => `RE${y}/${String(i).padStart(3, '0')}`, (i) => `INV-${String(100000 + i)}`, (i, y) => `${y}/ES/${String(i).padStart(5, '0')}`, (i) => `A${i}`, (i, y) => `${y}-${i}`, (i) => `F${String(i).padStart(6, '0')}`];
const VAT = { ES: 'ESB', DE: 'DE', FR: 'FR', IT: 'IT', NL: 'NL', PL: 'PL', SE: 'SE', BE: 'BE' };
export const H = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-number', 'invoice-status', 'invoice-status-description', 'is-amazon-invoiced', 'order-date', 'shipment-date', 'is-business-order', 'buyer-vat-number', 'currency', 'item-vat-incl-amount'];
const pad = (n, w = 2) => String(n).padStart(w, '0');
export function baseSeller(i, R, opts = {}) {
  const [cc, mk, cur, chanName] = MKTS[Math.floor(R() * MKTS.length)], dia = DIALECTS[Math.floor(R() * DIALECTS.length)], ser = SERIES[Math.floor(R() * SERIES.length)];
  const n = opts.n ?? Math.max(6, Math.min(400, Math.round(Math.exp(3.3 + 1.0 * (Math.sqrt(-2 * Math.log(R() + 1e-9)) * Math.cos(2 * Math.PI * R()))))));
  const period = opts.period ?? ['2026-10-02', '2026-10-31'], y = 2026, startDay = Date.parse(period[0]), span = Math.max(1, Math.round((Date.parse(period[1]) - startDay) / 86400000));
  const txs = []; let orderN = 1000000 + Math.floor(R() * 8000000);
  for (let k = 1; k <= n; k++) {
    const od = startDay + Math.floor(R() * span) * 86400000, sd = od + 86400000, amt = Math.round((8 + R() * 400) * 100) / 100;
    const bvat = R() < 0.9 ? `${VAT[cc]}${Math.floor(100000000 + R() * 899999999)}` : '';
    txs.push({ k, order: `${pad(Math.floor(R() * 900) + 100, 3)}-${String(orderN++).padStart(7, '0')}-${String(2000000 + k * 7 + Math.floor(R() * 5)).padStart(7, '0')}`, ship: `S${String(Math.floor(R() * 1e9)).padStart(9, '0')}`, num: ser(k, y), status: 'InvoiceUploaded', desc: '', amzInv: false, bvat, cur, amt, od, sd,
      books: true, bnum: null, bcur: cur, bbvat: bvat, bchan: chanName, lines: 1, bamt: amt, kind: 'inv', bdate: sd + 86400000 });
  }
  return { i, cc, mk, cur, chanName, dia, n, period, txs, extraDocs: [], defects: [], ooc: [], notes: {}, opts: {} };
}
const dmy = (t, d) => { const x = new Date(t), Y = x.getUTCFullYear(), M = pad(x.getUTCMonth() + 1), D = pad(x.getUTCDate()); return d.date === 'ISO' ? `${Y}-${M}-${D}` : `${D}${d.sep}${M}${d.sep}${Y}`; };
export const iso = (t) => new Date(t).toISOString().slice(0, 10);
export function vidrText(s, { delim = '\t', rows = s.txs } = {}) {
  const out = [H.join(delim)];
  for (const t of rows.filter(x => !x.hideAmazon)) { const x = new Date(t.od); out.push([s.mk, t.order, String(1000 + t.k), t.ship, t.ship, 'SHIPMENT', t.status === 'InvoiceUploaded' || t.status === 'InvoiceRejected' || t.status === 'InvoiceProcessing' ? t.num : '', t.status, t.desc, t.amzInv ? 'TRUE' : 'FALSE', `${pad(x.getUTCDate())}/${pad(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`, new Date(t.sd).toISOString().replace('.000Z', 'Z'), t.bvat ? 'TRUE' : 'FALSE', t.bvat, t.cur, t.amt.toFixed(2)].join(delim)); }
  return out.join('\n') + '\n';
}
const money = (v, d, thou) => { let s = Math.abs(v).toFixed(2); if (thou) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/\.(\d\d)$/, '.$1'); if (d.dec === ',') s = s.replace(/\./g, '#').replace(/,/g, '.').replace('#', ','); return (v < 0 ? '-' : '') + s; };
const q = (v, d, quote) => (quote || String(v).includes(d.delim) ? `"${v}"` : String(v));
export function ledgerFile(s, { skipKind = false, skipChannel = false, skipOrder = false, skipBuyer = true, bom = false, crlf = false, quote = false, rows = null } = {}) {
  const d = s.dia, docs = []; const rowsT = rows ?? s.txs;
  for (const t of rowsT) if (t.books) for (let l = 0; l < t.lines; l++) docs.push({ num: t.bnum ?? t.num, kind: t.kind, date: t.bdate, op: t.od, cur: t.bcur, amt: t.bamt / t.lines, order: t.bOrder ?? t.order, chan: t.bchan, bvat: t.bbvat });
  for (const e of s.extraDocs) docs.push(e);
  const head = d.h.filter((_, i) => !((i === 1 && skipKind) || (i === 9 && skipChannel) || (i === 8 && skipOrder) || (i === 10 && skipBuyer)));
  const lines = [head.map(h => q(h, d, quote)).join(d.delim)];
  for (const x of docs) { const g = x.amt, net = g / 1.21, cells = [x.num, x.kind === 'cn' ? d.cn : d.inv, dmy(x.date, d), dmy(x.op, d), x.cur, money(x.kind === 'cn' ? -g : g, d, d.thousands), money(net, d, d.thousands), money(g - net, d, d.thousands), x.order ?? '', x.chan ?? '', x.bvat ?? ''];
    lines.push(cells.filter((_, i) => !((i === 1 && skipKind) || (i === 9 && skipChannel) || (i === 8 && skipOrder) || (i === 10 && skipBuyer))).map(c => q(c, d, quote)).join(d.delim)); }
  return (bom ? '\uFEFF' : '') + lines.join(crlf ? '\r\n' : '\n') + '\n';
}
