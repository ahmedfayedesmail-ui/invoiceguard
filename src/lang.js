import { PACKS } from './rules.js';

/** Invoice label languages. Spanish text is the key; every other language maps those keys. All are Latin-1 safe for the built-in PDF font. Polish needs an embedded font and is not offered yet. */
export const LANGS = { es: 'Spanish', en: 'English', de: 'German', fr: 'French', it: 'Italian', nl: 'Dutch' };
const K = ['FACTURA RECTIFICATIVA', 'FACTURA', 'Nº:', 'Fecha:', 'Fecha de operación:', 'EMISOR', 'CLIENTE', 'RECTIFICA A', 'Descripción', 'Cant.', 'P. unit.', 'IVA %', 'Base', 'Cuota', 'Base imponible', 'IVA', 'TOTAL', 'Pedido Amazon:', 'Motivo:', 'sustitución', 'diferencias'];
const T = {
  en: ['CORRECTED INVOICE', 'INVOICE', 'No.:', 'Date:', 'Operation date:', 'SUPPLIER', 'CUSTOMER', 'CORRECTS', 'Description', 'Qty', 'Unit price', 'VAT %', 'Net', 'VAT', 'Net total', 'VAT', 'TOTAL', 'Amazon order:', 'Reason:', 'by substitution', 'by differences'],
  de: ['BERICHTIGTE RECHNUNG', 'RECHNUNG', 'Nr.:', 'Datum:', 'Leistungsdatum:', 'AUSSTELLER', 'KUNDE', 'BERICHTIGT RECHNUNG', 'Beschreibung', 'Menge', 'Einzelpreis', 'USt %', 'Netto', 'USt', 'Nettobetrag', 'USt', 'GESAMT', 'Amazon-Bestellung:', 'Grund:', 'durch Ersatz', 'durch Differenzen'],
  fr: ['FACTURE RECTIFICATIVE', 'FACTURE', 'N°:', 'Date:', 'Date de l\'opération:', 'ÉMETTEUR', 'CLIENT', 'RECTIFIE', 'Description', 'Qté', 'Prix unit.', 'TVA %', 'Base', 'TVA', 'Total HT', 'TVA', 'TOTAL', 'Commande Amazon:', 'Motif:', 'par substitution', 'par différences'],
  it: ['FATTURA RETTIFICATIVA', 'FATTURA', 'N.:', 'Data:', 'Data dell\'operazione:', 'EMITTENTE', 'CLIENTE', 'RETTIFICA', 'Descrizione', 'Q.tà', 'Prezzo unit.', 'IVA %', 'Imponibile', 'IVA', 'Imponibile totale', 'IVA', 'TOTALE', 'Ordine Amazon:', 'Motivo:', 'per sostituzione', 'per differenze'],
  nl: ['CORRECTIEFACTUUR', 'FACTUUR', 'Nr.:', 'Datum:', 'Datum van de handeling:', 'LEVERANCIER', 'KLANT', 'CORRIGEERT', 'Omschrijving', 'Aantal', 'Stukprijs', 'BTW %', 'Netto', 'BTW', 'Totaal excl. BTW', 'BTW', 'TOTAAL', 'Amazon-bestelling:', 'Reden:', 'door vervanging', 'door verschillen'],
};
export const LABELS = { es: Object.fromEntries(K.map(k => [k, k])), ...Object.fromEntries(Object.entries(T).map(([l, v]) => [l, Object.fromEntries(K.map((k, i) => [k, v[i]]))])) };
const REF = { es: (n, d, m) => `Factura ${n} de fecha ${d}. Tipo: por ${m}.`, en: (n, d, m) => `Invoice ${n} dated ${d}. Type: ${m}.`, de: (n, d, m) => `Rechnung ${n} vom ${d}. Art: ${m}.`, fr: (n, d, m) => `Facture ${n} du ${d}. Type: ${m}.`, it: (n, d, m) => `Fattura ${n} del ${d}. Tipo: ${m}.`, nl: (n, d, m) => `Factuur ${n} van ${d}. Type: ${m}.` };
export const refLine = (lang, n, d, mode) => REF[lang](n, d, lang === 'es' ? (mode === 'substitution' ? 'sustitución' : 'diferencias') : LABELS[lang][mode === 'substitution' ? 'sustitución' : 'diferencias']);

/** Main language of a buyer's country. Countries with several official languages (BE, CH) are left out on purpose: no guess. */
export const COUNTRY_LANG = { ES: 'es', DE: 'de', AT: 'de', FR: 'fr', IT: 'it', NL: 'nl', GB: 'en', IE: 'en' };
export const SETTINGS = ['auto', 'both', ...Object.keys(LANGS)];

/** The issuing country's pack records its default invoice language. Fallback: Spanish, the demo market. */
export function issuerLang(sellerCountry = 'ES', packs = PACKS) {
  const l = packs[sellerCountry]?.rules.find(r => r.topic === 'language')?.machine?.defaultLang;
  return LANGS[l] ? l : (sellerCountry === 'ES' || !packs[sellerCountry] ? 'es' : 'en');
}
/**
 * setting: 'auto' = issuer language, plus the buyer's country language when it differs (keeps a version the issuer's tax authority can read);
 * 'both' = issuer language + English; or one fixed language code.
 */
export function resolveLangs(setting = 'auto', sellerCountry = 'ES', buyerCountry, packs = PACKS) {
  const home = issuerLang(sellerCountry, packs);
  if (LANGS[setting]) return [setting];
  if (setting === 'both') return home === 'en' ? ['en'] : [home, 'en'];
  const b = COUNTRY_LANG[String(buyerCountry ?? '').toUpperCase()];
  return b && b !== home ? [home, b] : [home];
}
export const legacyLangs = (inv) => inv.langs ?? (inv.lang === 'both' ? ['es', 'en'] : [LANGS[inv.lang] ? inv.lang : 'es']);
