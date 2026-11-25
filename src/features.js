import { deflateRawSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { PACKS, ruleState } from './rules.js';
import { addOverride, hasOverride } from './verify.js';
import { logEvent } from './db.js';
import { renderPdfCached as renderPdf } from './pdf.js';
import { COUNTRY_LANG } from './lang.js';

export function ensureFeatureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS alerts (seller_id TEXT, key TEXT, level TEXT, at TEXT, PRIMARY KEY (seller_id, key, level));
  CREATE TABLE IF NOT EXISTS vat_watch (seller_id TEXT, vat TEXT, label TEXT, added_at TEXT, last_status TEXT, last_name TEXT, last_checked TEXT, PRIMARY KEY (seller_id, vat));
  CREATE TABLE IF NOT EXISTS vat_watch_log (seller_id TEXT, vat TEXT, at TEXT, status TEXT, name TEXT, change TEXT);
  CREATE TABLE IF NOT EXISTS ext_docs (seller_id TEXT, id TEXT, name TEXT, doc_date TEXT, pdf BLOB, added_at TEXT, PRIMARY KEY (seller_id, id));
  CREATE TABLE IF NOT EXISTS explainer (seller_id TEXT PRIMARY KEY, token TEXT, reviewed_by TEXT, reviewed_at TEXT, text_version INTEGER)`);
}

// ---------- 1. Business-order radar ----------
export const URGENT_HOURS = 12;
/** Open business shipments with time left to Amazon's 24 h upload window (own SLA estimate, see pipeline DUE_HOURS). Nothing here uploads anything. */
export function radar(db, seller, now = new Date(), limit = Infinity) {
  const rows = db.prepare("SELECT key, order_id, buyer, country, total, shipment_date, due_at, status, reason FROM shipments WHERE seller_id=? AND status NOT IN ('submitted','uploaded') ORDER BY due_at").all(seller.id);
  const items = rows.map(r => {
    const hoursLeft = r.due_at ? Math.round((new Date(r.due_at) - now) / 36e5 * 10) / 10 : null;
    const level = hoursLeft == null ? 'unknown' : hoursLeft < 0 ? 'overdue' : hoursLeft <= URGENT_HOURS ? 'urgent' : 'ok';
    return { key: r.key, orderId: r.order_id, buyer: r.buyer, country: r.country, total: r.total, dueAt: r.due_at, hoursLeft, level, status: r.status, reason: r.reason };
  });
  const counts = { overdue: items.filter(i => i.level === 'overdue').length, urgent: items.filter(i => i.level === 'urgent').length, ok: items.filter(i => i.level === 'ok').length }, total = items.length;
  return { items: total > limit ? items.slice(0, limit) : items, total, counts, urgentHours: URGENT_HOURS }; // counts are exact; a long list is cut to the soonest deadlines first
}
/** Records each (shipment, level) alert once. Delivery today is in-app plus the event log: no email or chat channel is configured. */
export function radarAlerts(db, seller, now = new Date()) {
  ensureFeatureTables(db); const fresh = [];
  for (const i of radar(db, seller, now).items) {
    if (!['urgent', 'overdue'].includes(i.level)) continue;
    const r = db.prepare('INSERT OR IGNORE INTO alerts VALUES (?,?,?,?)').run(seller.id, i.key, i.level, now.toISOString());
    if (r.changes) { fresh.push(i); logEvent(db, seller.id, 'radar_alert', { key: i.key, level: i.level, hoursLeft: i.hoursLeft }); }
  }
  return fresh;
}
export const listAlerts = (db, seller, limit = 50) => { ensureFeatureTables(db); return db.prepare('SELECT key, level, at FROM alerts WHERE seller_id=? ORDER BY at DESC LIMIT ?').all(seller.id, limit); };

// ---------- 2. Setup wizard ----------
const ruleView = (db, pack, r, now) => { const st = ruleState(db, pack, r, now); return { id: r.id, text: r.text, status: r.status, state: st.state, reasons: st.reasons, source: r.source.url, verifiedOn: st.verifiedOn }; };
const MARKET_COUNTRIES = ['ES', 'DE', 'FR', 'IT', 'NL', 'PL', 'GB', 'CH'];
/**
 * answers: { country, hasVatId: bool|null, marketplaces: [cc], vcsMode: 'own'|'amazon'|null }
 * Everything stated comes from a pack rule and carries its status. Unanswered or uncovered points become questions, never assumptions.
 */
export function wizard(db, answers = {}, now = new Date(), packs = PACKS) {
  const out = { sections: [], questions: [], covered: false };
  const c = String(answers.country ?? '').toUpperCase(), pack = packs[c];
  if (!c) { out.questions.push('Which country are you established or VAT-registered in as the issuer of your invoices?'); return out; }
  const sec = (title, items) => items.length && out.sections.push({ title, items });
  const rules = (p, topics) => (p?.rules ?? []).filter(r => topics.includes(r.topic)).map(r => ruleView(db, p, r, now));
  if (!pack) out.questions.push(`There is no rule pack for ${c}. Without one this tool will hold your invoices instead of guessing.`);
  else {
    const rd = { issue: pack.rules.some(r => r.topic === 'content' && r.machine?.required && r.status === 'verified'), correct: pack.rules.some(r => r.topic === 'correction' && r.machine?.methods && r.status === 'verified') };
    out.covered = rd.issue;
    sec(`Your issuing country: ${pack.name}`, [{ text: rd.issue ? 'Invoice content is verified for this country, so this tool can issue invoices.' : 'Invoice content is NOT verified for this country yet. This tool holds your invoices instead of issuing them.', status: rd.issue ? 'verified' : 'unverified' },
      { text: rd.correct ? 'Corrections are verified for this country (see the rule below for what is covered).' : 'Corrections are NOT verified for this country yet. Correction requests are held.', status: rd.correct ? 'verified' : 'unverified' }]);
    sec('Rules that apply to you', rules(pack, ['content', 'deadline', 'correction', 'format', 'numbering']));
  }
  sec('Amazon', rules(packs.AMAZON, ['submission', 'correction']));
  if (answers.vcsMode === 'own') sec('Your setting: you upload your own invoices', [{ text: 'You chose "I will upload my own invoices". This is the setting the upload rule (AMZ-SELF-INVOICE) requires. The seller invoices you issue are uploaded for you.', status: 'verified' }]);
  else if (answers.vcsMode === 'amazon') sec('Your setting: Amazon calculates and issues', [{ text: 'Uploads from this tool will be rejected by Amazon with error 79509 until you switch the VAT Calculation Service to "I will upload my own invoices" (AMZ-SELF-INVOICE). This tool will not try to bypass that.', status: 'verified' }]);
  else out.questions.push('In Seller Central, is your VAT Calculation Service set to "I will upload my own invoices"? (Amazon rejects uploads otherwise.)');
  if (answers.hasVatId === false) sec('No VAT ID', [{ text: 'Every supported content rule requires your tax number or VAT ID on the invoice, so this tool cannot issue a compliant invoice without one. Whether you must register is not something this tool decides: ask a tax adviser.', status: 'verified' }]);
  else if (answers.hasVatId == null) out.questions.push('Do you hold a tax number or VAT ID in your issuing country?');
  const others = (answers.marketplaces ?? []).map(x => String(x).toUpperCase()).filter(x => MARKET_COUNTRIES.includes(x) && x !== c);
  for (const m of others) {
    const p = packs[m]; if (!p) { out.questions.push(`No rule pack for buyers in ${m}: language and format rules for those invoices are unknown.`); continue; }
    sec(`Selling into ${p.name}`, rules(p, ['language', 'format']));
  }
  if (others.length) out.questions.push('Which countries are you VAT-registered in? Registration duties in other countries are not covered by this tool: ask a tax adviser.');
  return out;
}

// ---------- 3. Buyer-country routing ----------
/** Checks an issued or previewed invoice against the buyer country's pack. Warnings only: they never change the document. */
export function buyerCountryCheck(doc, sellerCountry = 'ES', packs = PACKS) {
  const bc = String(doc.buyerCountry ?? '').toUpperCase(), out = [];
  if (!bc || bc === sellerCountry) return out;
  const pack = packs[bc];
  if (!pack) return [{ level: 'unknown', ruleId: null, text: `No rule pack for buyer country ${bc}: its language and format rules are unknown.`, status: 'unverified', source: null }];
  for (const r of pack.rules) {
    const m = r.machine ?? {}, base = { ruleId: r.id, status: r.status, source: r.source.url };
    if (r.topic === 'language') {
      const need = m.frenchRequiredFor ?? m.polishRequiredFor;
      if (need) { const lang = m.defaultLang; const has = (doc.langs ?? []).includes(lang); out.push({ ...base, level: has || doc.buyer?.vat ? 'info' : 'warn', text: has ? `${pack.name}: the local language is required for ${need.join(', ')}. This invoice includes it.` : `${pack.name}: the local language is required for ${need.join(', ')}. This invoice does not include it${doc.buyer?.vat ? ', and the buyer has a VAT ID (business), so the rule may not apply' : ' and the buyer has no VAT ID'}.` }); }
      else if (m.taxAmountsInEuro && doc.currency && doc.currency !== 'EUR') out.push({ ...base, level: 'warn', text: `${pack.name}: tax base and VAT must be in euro. This invoice is in ${doc.currency}.` });
      else out.push({ ...base, level: 'info', text: `${pack.name}: invoice language is not prescribed for tax; a translation can be demanded.` });
    }
    if (r.topic === 'format') out.push({ ...base, level: 'info', text: `${pack.name}: ${r.text}` });
  }
  return out;
}

// ---------- 4. Export ----------
const csvq = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const dosTime = (d) => ({ t: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), d: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() });
/** Minimal ZIP writer (deflate). files: [{name, data: Buffer}] */
export function zip(files, date = new Date()) {
  const { t, d } = dosTime(date), parts = [], central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data), comp = deflateRawSync(data), crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(t, 10); lh.writeUInt16LE(d, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(t, 12); ch.writeUInt16LE(d, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
/** Bundle for the accountant: PDFs, an invoice list, and totals by buyer country and VAT rate. from/to are inclusive issue dates (YYYY-MM-DD). */
export async function buildExport(db, seller, from, to, now = new Date()) {
  ensureFeatureTables(db);
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || from > to || isNaN(new Date(from)) || isNaN(new Date(to))) throw new Error('Enter a valid date range (from and to as YYYY-MM-DD, from not after to).');
  const rows = db.prepare("SELECT number, kind, rectifies, issued_at, total, vat, shipment_key, upload_status, json FROM invoices WHERE seller_id=? AND substr(issued_at,1,10) BETWEEN ? AND ? ORDER BY number").all(seller.id, from, to);
  const files = [], list = ['number,type,rectifies,issue_date,buyer_name,buyer_vat,buyer_country,net,vat,total,currency,amazon_upload'], tot = new Map();
  for (const r of rows) {
    const d = JSON.parse(r.json); files.push({ name: `invoices/${safe(r.number)}.pdf`, data: await renderPdf(d) });
    list.push([r.number, r.kind, r.rectifies, d.issueDate ?? r.issued_at.slice(0, 10), d.buyer?.name, d.buyer?.vat, d.buyerCountry, d.totals?.excl, d.totals?.vat, d.totals?.incl, d.currency, r.upload_status].map(csvq).join(','));
    for (const l of d.lines ?? []) { const k = `${d.buyerCountry ?? ''}|${d.currency}|${l.rate}`, t = tot.get(k) ?? { n: 0, v: 0 }; t.n += l.excl; t.v += l.vat; tot.set(k, t); }
  }
  const sum = ['buyer_country,currency,vat_rate,net,vat', ...[...tot].sort().map(([k, v]) => { const [c, cur, rate] = k.split('|'); return [c, cur, rate, (Math.round(v.n * 100) / 100).toFixed(2), (Math.round(v.v * 100) / 100).toFixed(2)].map(csvq).join(','); })];
  const ext = db.prepare('SELECT id, name, doc_date, pdf FROM ext_docs WHERE seller_id=? AND doc_date BETWEEN ? AND ? ORDER BY doc_date, id').all(seller.id, from, to);
  for (const e of ext) files.push({ name: `amazon-issued/${safe(e.id)}-${safe(e.name)}`, data: Buffer.from(e.pdf) });
  files.push({ name: 'invoices.csv', data: list.join('\n') }, { name: 'totals-by-country-and-rate.csv', data: sum.join('\n') },
    { name: 'README.txt', data: `InvoiceGuard export for ${seller.name}\nIssue dates ${from} to ${to}. Generated ${now.toISOString()}.\n${rows.length} documents issued by this tool; ${ext.length} Amazon-issued files you uploaded yourself (not checked or edited by this tool).\nCredit notes and corrections appear with their own numbers and negative amounts. Totals are plain sums of the invoice lines. This is a record export, not a VAT return and not tax advice.\n` });
  return { zip: zip(files, now), count: rows.length, external: ext.length };
}
export function addExternalDoc(db, seller, { name, date, pdfBase64 }) {
  ensureFeatureTables(db);
  if (!DATE.test(date ?? '')) throw new Error('Date must be YYYY-MM-DD');
  const pdf = Buffer.from(String(pdfBase64 ?? ''), 'base64'); if (pdf.length < 8 || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('File must be a PDF');
  if (pdf.length > 5e6) throw new Error('PDF is larger than 5 MB');
  const id = randomBytes(4).toString('hex'); db.prepare('INSERT INTO ext_docs VALUES (?,?,?,?,?,?)').run(seller.id, id, safe(name || 'document.pdf'), date, pdf, new Date().toISOString()); return { id };
}

// ---------- 5. Buyer data hygiene ----------
const MSG = {
  en: (o) => ({ subject: `Your invoice for order ${o}: please confirm your company details`, body: `Hello,\n\nTo issue a correct invoice for order ${o} we need your company details exactly as registered:\n- Legal company name\n- VAT ID\n- Billing address\n\nPlease reply with these details.\n\nThank you.` }),
  es: (o) => ({ subject: `Su factura del pedido ${o}: confirme los datos de su empresa`, body: `Hola,\n\nPara emitir una factura correcta del pedido ${o} necesitamos los datos de su empresa tal como constan en el registro:\n- Razón social\n- NIF/IVA\n- Dirección de facturación\n\nPor favor, responda con estos datos.\n\nGracias.` }),
  de: (o) => ({ subject: `Ihre Rechnung zur Bestellung ${o}: bitte Firmendaten bestätigen`, body: `Guten Tag,\n\num eine korrekte Rechnung zur Bestellung ${o} auszustellen, benötigen wir Ihre Firmendaten genau wie eingetragen:\n- Vollständiger Firmenname\n- USt-IdNr.\n- Rechnungsadresse\n\nBitte antworten Sie mit diesen Angaben.\n\nVielen Dank.` }),
  fr: (o) => ({ subject: `Votre facture pour la commande ${o} : merci de confirmer les données de votre société`, body: `Bonjour,\n\nPour établir une facture correcte pour la commande ${o}, nous avons besoin des données de votre société telles qu'enregistrées :\n- Raison sociale\n- N° de TVA\n- Adresse de facturation\n\nMerci de répondre avec ces informations.\n\nCordialement.` }),
  it: (o) => ({ subject: `La sua fattura per l'ordine ${o}: confermi i dati della società`, body: `Buongiorno,\n\nPer emettere una fattura corretta per l'ordine ${o} ci servono i dati della sua società così come registrati:\n- Ragione sociale\n- Partita IVA\n- Indirizzo di fatturazione\n\nLa preghiamo di rispondere con questi dati.\n\nGrazie.` }),
  nl: (o) => ({ subject: `Uw factuur voor bestelling ${o}: bevestig uw bedrijfsgegevens`, body: `Goedendag,\n\nOm een juiste factuur voor bestelling ${o} uit te kunnen reiken hebben wij uw bedrijfsgegevens nodig zoals geregistreerd:\n- Volledige bedrijfsnaam\n- btw-nummer\n- Factuuradres\n\nWilt u met deze gegevens antwoorden?\n\nBedankt.` }),
};
/** Draft message that only asks for data. Returns the buyer-country language when we have a template (else English) plus English. It never gives tax advice. */
export function buyerMessage(orderId, buyerCountry) {
  const l = COUNTRY_LANG[String(buyerCountry ?? '').toUpperCase()], lang = MSG[l] ? l : 'en';
  return { lang, local: MSG[lang](orderId), english: MSG.en(orderId), note: 'Draft only. Nothing is sent. Check Amazon\'s buyer-seller messaging rules before you send it.' };
}
/**
 * Convert a held B2B shipment to an invoice without a buyer VAT ID. Allowed only when VAT was already charged in Amazon's data (vat > 0):
 * if no VAT was charged, the tax treatment would have to change, which this tool never decides.
 */
export function convertToConsumerInvoice(db, seller, key, who) {
  const row = db.prepare("SELECT raw, reason, status FROM shipments WHERE seller_id=? AND key=?").get(seller.id, key);
  if (!row || row.status !== 'held') throw new Error('No held shipment with that key');
  if (!/VAT invalid|VIES registers|AEAT census|control-character/.test(row.reason ?? '')) throw new Error('Only a hold caused by the buyer VAT check can be converted.');
  const s = JSON.parse(row.raw);
  if (!(s.vat > 0)) throw new Error('Amazon charged no VAT on this shipment (the VAT-ID treatment applied). Changing it needs a tax decision this tool does not make. Ask your accountant or get the right VAT ID from the buyer.');
  addOverride(db, seller.id, key, 'b2c', who); logEvent(db, seller.id, 'converted_without_buyer_vat', { key, who });
  db.prepare("UPDATE shipments SET status='detected', reason=NULL WHERE seller_id=? AND key=?").run(seller.id, key);
  return { ok: true };
}
export const isConverted = (db, sellerId, key) => hasOverride(db, sellerId, key, 'b2c');

// ---------- 7. VAT-number and presence watch ----------
const MS_DAYS = 864e5, VAT_CC = { GR: 'EL' };
export function watchAdd(db, seller, vat, label) {
  ensureFeatureTables(db); const v = String(vat ?? '').replace(/[\s.\-_]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(v)) throw new Error('Enter a VAT number with its country prefix, e.g. DE123456789');
  db.prepare('INSERT OR IGNORE INTO vat_watch (seller_id, vat, label, added_at) VALUES (?,?,?,?)').run(seller.id, v, String(label ?? '').slice(0, 80), new Date().toISOString()); return { vat: v };
}
export const watchRemove = (db, seller, vat) => { ensureFeatureTables(db); db.prepare('DELETE FROM vat_watch WHERE seller_id=? AND vat=?').run(seller.id, String(vat)); };
/** Re-checks every watched number (at most once per 25 days unless force). Report only: a change is logged and shown, nothing else is done. */
export async function watchRun(db, seller, validate, { now = new Date(), force = false } = {}) {
  ensureFeatureTables(db); const changes = [];
  for (const w of db.prepare('SELECT * FROM vat_watch WHERE seller_id=?').all(seller.id)) {
    if (!force && w.last_checked && now - new Date(w.last_checked) < 25 * MS_DAYS) continue;
    const v = await validate(w.vat);
    if (v.status === 'unavailable') { db.prepare('INSERT INTO vat_watch_log VALUES (?,?,?,?,?,?)').run(seller.id, w.vat, now.toISOString(), 'unavailable', null, 'VIES could not be reached; status unchanged'); continue; }
    let change = null;
    if (w.last_status && w.last_status !== v.status) change = `Status changed from ${w.last_status} to ${v.status}${v.reason ? ` (${v.reason})` : ''}`;
    else if (w.last_name && v.name && w.last_name !== v.name) change = `Registered name changed from "${w.last_name}" to "${v.name}"`;
    else if (!w.last_status && v.status !== 'valid') change = `Not valid in VIES${v.reason ? ` (${v.reason})` : ''}`;
    db.prepare('UPDATE vat_watch SET last_status=?, last_name=?, last_checked=? WHERE seller_id=? AND vat=?').run(v.status, v.name ?? w.last_name ?? null, now.toISOString(), seller.id, w.vat);
    db.prepare('INSERT INTO vat_watch_log VALUES (?,?,?,?,?,?)').run(seller.id, w.vat, now.toISOString(), v.status, v.name ?? null, change);
    if (change) { changes.push({ vat: w.vat, change }); logEvent(db, seller.id, 'vat_watch_change', { vat: w.vat, change }); }
  }
  return changes;
}
/** Countries goods were shipped from or to, per the sync data, compared with the VAT numbers the seller listed. It cannot know registrations that were never entered. */
export function presence(db, seller) {
  ensureFeatureTables(db);
  const from = new Map(), to = new Map();
  for (const r of db.prepare('SELECT raw FROM shipments WHERE seller_id=?').all(seller.id)) { const s = JSON.parse(r.raw); if (s.shipFromCountry) from.set(s.shipFromCountry, (from.get(s.shipFromCountry) ?? 0) + 1); if (s.shipCountry) to.set(s.shipCountry, (to.get(s.shipCountry) ?? 0) + 1); }
  const listed = new Set(db.prepare('SELECT vat FROM vat_watch WHERE seller_id=?').all(seller.id).map(w => w.vat.slice(0, 2)));
  const rows = [...new Set([...from.keys()])].sort().map(c => ({ country: c, shipments: from.get(c), vatListed: listed.has(VAT_CC[c] ?? c) }));
  return { shippedFrom: rows, shippedTo: [...to].sort().map(([country, n]) => ({ country, shipments: n })), note: 'Report only. This tool does not decide whether you must be registered anywhere. It only shows where shipments left from, so you can check with your tax adviser.' };
}
export function watchReport(db, seller) {
  ensureFeatureTables(db);
  return { numbers: db.prepare('SELECT vat, label, last_status, last_name, last_checked FROM vat_watch WHERE seller_id=? ORDER BY vat').all(seller.id), log: db.prepare('SELECT vat, at, status, change FROM vat_watch_log WHERE seller_id=? ORDER BY at DESC LIMIT 30').all(seller.id), presence: presence(db, seller) };
}

// ---------- 9. Marketplace-vs-seller explainer ----------
export const EXPLAINER_VERSION = 1;
export const EXPLAINER_TEXT = (sellerName) => ({
  title: 'Who issued your invoice?',
  paragraphs: [`The invoice you received for your Amazon purchase was issued by the seller ${sellerName}, the business that sold you the goods. It was not issued by Amazon.`,
    'Amazon is the online marketplace where the order was placed. Questions about the content of the invoice, such as company name, address or VAT ID, go to the seller named on it.',
    'This page explains who issued the document. It is not tax advice and does not say how any tax is treated for you. Your own tax adviser can tell you that.'] });
export function explainerState(db, seller) {
  ensureFeatureTables(db); let r = db.prepare('SELECT * FROM explainer WHERE seller_id=?').get(seller.id);
  if (!r) { db.prepare('INSERT INTO explainer VALUES (?,?,?,?,?)').run(seller.id, randomBytes(12).toString('hex'), null, null, null); r = db.prepare('SELECT * FROM explainer WHERE seller_id=?').get(seller.id); }
  return { token: r.token, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, published: r.reviewed_by != null && r.text_version === EXPLAINER_VERSION, draft: EXPLAINER_TEXT(seller.name) };
}
export function explainerReview(db, seller, who) { explainerState(db, seller); db.prepare('UPDATE explainer SET reviewed_by=?, reviewed_at=?, text_version=? WHERE seller_id=?').run(String(who), new Date().toISOString(), EXPLAINER_VERSION, seller.id); return explainerState(db, seller); }
export const explainerUnpublish = (db, seller) => { explainerState(db, seller); db.prepare('UPDATE explainer SET reviewed_by=NULL, reviewed_at=NULL, text_version=NULL WHERE seller_id=?').run(seller.id); };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Public page by unguessable token. Only served after the seller recorded a review of the exact wording version; shows nothing but the seller's business name. */
export function explainerPage(db, token) {
  ensureFeatureTables(db); const r = db.prepare('SELECT e.*, s.name FROM explainer e JOIN sellers s ON s.id=e.seller_id WHERE e.token=?').get(String(token));
  if (!r || !r.reviewed_by || r.text_version !== EXPLAINER_VERSION) return null;
  const t = EXPLAINER_TEXT(r.name);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)}</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;color:#1a1a1a"><h1>${esc(t.title)}</h1>${t.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}</body>`;
}
