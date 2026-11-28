// T9 (VAT squad F1-F3): intra-EU exempt goods wording, intra-EU detection, and the buyer-VAT hold. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vatNote, intraEUShape, isIntraEUExempt, EU27 } from '../src/invoice.js';
import { missingFields } from '../src/rules.js';

const base = (o = {}) => ({ vat: 0, excl: 100, buyerVat: 'DE811128135', shipCountry: 'DE', shipFromCountry: 'ES', citation: null, billing: { country: 'DE', postal: '10178' }, ...o });

test('F1: ES->DE fallback says art. 25 / art. 138 and never reverse charge or sujeto pasivo', () => {
  const n = vatNote(base(), 'ES');
  assert.equal(n.source, 'fallback_verify_with_accountant');
  assert.match(n.text, /art\. 25/); assert.match(n.text, /art\. 138/);
  assert.doesNotMatch(n.text, /sujeto pasivo|reverse charge|autoliquidaci|Inversi/i);
});
test('F1: no locale note uses reverse-charge wording', () => {
  for (const c of ['DE', 'FR', 'IT', 'NL', 'PL', 'SE', 'IE', 'BE', 'PT']) {
    const n = vatNote(base({ shipCountry: c, buyerVat: c + '123456789', billing: { country: c, postal: '1' } }), 'ES');
    assert.ok(n, c); assert.match(n.text, /138/, c);
    assert.doesNotMatch(n.text, /reverse charge|autoliquida|inversione contabile|verlegd|odwrotne|omv.nd skattskyldighet|Reverse/i, c);
  }
});
test('F1: Amazon citation is still preferred and keeps source amazon', () => {
  const n = vatNote(base({ citation: 'Entrega intracomunitaria exenta, art. 25 Ley 37/1992 del IVA.' }), 'ES');
  assert.equal(n.source, 'amazon'); assert.match(n.text, /art\. 25/);
});

test('F2: GB, CH, NO buyers do not get the intra-EU note', () => {
  for (const c of ['GB', 'CH', 'NO']) {
    const s = base({ shipCountry: c, buyerVat: c + '123456789', billing: { country: c, postal: '1' } });
    assert.equal(intraEUShape(s), false, c); assert.equal(isIntraEUExempt(s), false, c); assert.equal(vatNote(s, 'ES'), null, c);
  }
});
test('F2: ES mainland -> Canary Islands / Ceuta / Melilla is not intra-EU (and ES->ES never is)', () => {
  for (const postal of ['35001', '38001', '51001', '52001']) {
    const s = base({ shipCountry: 'ES', shipFromCountry: 'ES', buyerVat: 'ESB11111119', billing: { country: 'ES', postal } });
    assert.equal(isIntraEUExempt(s), false, postal); assert.equal(vatNote(s, 'ES'), null, postal);
  }
  // a non-ES seller shipping into the Canary Islands: country codes differ but the territory is outside the EU VAT area
  assert.equal(isIntraEUExempt(base({ shipCountry: 'ES', shipFromCountry: 'DE', buyerVat: 'ESB11111119', billing: { country: 'ES', postal: '35001' } })), false);
  assert.equal(isIntraEUExempt(base({ shipCountry: 'ES', shipFromCountry: 'DE', buyerVat: 'ESB11111119', billing: { country: 'ES', postal: '28001' } })), true);
});
test('F2: buyer VAT prefix must equal the ship country; EL is accepted for GR', () => {
  assert.equal(isIntraEUExempt(base({ buyerVat: 'FR12345678901' })), false);
  assert.equal(isIntraEUExempt(base({ shipCountry: 'GR', buyerVat: 'EL123456789', billing: { country: 'GR', postal: '10431' } })), true);
  assert.equal(isIntraEUExempt(base({ buyerVat: null })), false);
});
test('F2: VIES status is honoured when present (valid ok; invalid / unavailable not)', () => {
  assert.equal(isIntraEUExempt(base({ __vies: { status: 'valid' } })), true);
  assert.equal(isIntraEUExempt(base({ __vies: { status: 'invalid' } })), false);
  assert.equal(isIntraEUExempt(base({ __vies: { status: 'unavailable' } })), false);
  assert.equal(isIntraEUExempt(base()), true);
});
test('F2: EU27 has 27 members and excludes GB, CH, NO', () => {
  assert.equal(EU27.size, 27); for (const c of ['GB', 'CH', 'NO', 'XI']) assert.equal(EU27.has(c), false);
});
test('F2: positive VAT or zero amount is never intra-EU exempt', () => {
  assert.equal(isIntraEUExempt(base({ vat: 21 })), false); assert.equal(isIntraEUExempt(base({ excl: 0 })), false);
});

const sellerDoc = (o = {}) => ({ number: 'A-1', issueDate: '2026-11-24', seller: { name: 'S', nif: 'B11111111', address: 'x' }, buyer: { name: 'B', address: ['a'] }, buyerCountry: 'US', lines: [{ description: 'd', unitExcl: 100, rate: 0 }], totals: { excl: 100, vat: 0, incl: 100 }, vatNote: { text: 'Exportación exenta' }, ...o });
test('F3: 0-VAT B2C export with no buyer VAT is not held with the intra-EU reason', () => {
  const doc = sellerDoc();
  assert.ok(!missingFields(doc, 'ES').some(x => /intra-EU/.test(x)));
  const s = base({ shipCountry: 'US', buyerVat: null, billing: { country: 'US', postal: '10001' } });
  assert.ok(!missingFields(doc, 'ES', undefined, { shipment: s }).some(x => /intra-EU/.test(x)));
});
test('F3: zero-value document and free replacement are not held with the intra-EU reason', () => {
  const z = sellerDoc({ buyerCountry: 'DE', totals: { excl: 0, vat: 0, incl: 0 } });
  assert.ok(!missingFields(z, 'ES').some(x => /intra-EU/.test(x)));
  const s = base({ excl: 0, buyerVat: null });
  assert.ok(!missingFields(z, 'ES', undefined, { shipment: s }).some(x => /intra-EU/.test(x)));
});
test('F3: a real intra-EU exempt shape without buyer VAT is still held', () => {
  const doc = sellerDoc({ buyerCountry: 'DE' });
  assert.ok(missingFields(doc, 'ES').some(x => /buyer\.vat .*intra-EU/.test(x)));
  assert.ok(missingFields(doc, 'ES', undefined, { shipment: base({ buyerVat: null }) }).some(x => /buyer\.vat .*intra-EU/.test(x)));
  assert.ok(!missingFields({ ...doc, buyer: { ...doc.buyer, vat: 'DE811128135' } }, 'ES').some(x => /intra-EU/.test(x)));
});
test('F3: GB buyer / Canary Islands shipment with no VAT number is not held with the intra-EU reason', () => {
  const gb = sellerDoc({ buyerCountry: 'GB' });
  assert.ok(!missingFields(gb, 'ES').some(x => /intra-EU/.test(x)));
  const can = base({ shipCountry: 'ES', shipFromCountry: 'DE', buyerVat: null, billing: { country: 'ES', postal: '35001' } });
  assert.ok(!missingFields(sellerDoc({ buyerCountry: 'ES' }), 'DE', undefined, { shipment: can }).some(x => /intra-EU/.test(x)));
});
