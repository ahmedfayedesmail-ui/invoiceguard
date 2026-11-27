// Amazon correction transaction ids: an explicit allow-list, not a prefix match.
// A prefix match would swallow any id that merely starts with the word, and a swallowed id looks handled. Anything that begins with
// "Correction" but is not one of the known shapes is UNKNOWN: it is never treated as a correction and never as an ordinary transaction.
//   CorrectionReversal:<X>:<id>   type REFUND    seller must upload a Credit Note              (guide 6.3.4)
//   Correction::<X>:<id>          type SHIPMENT  seller must upload the corrected Invoice      (current format; note the empty field)
//   Correction:<X>:<id>           type SHIPMENT  the same, legacy format as printed in the guide
// Source: VCS developer guide 6.3.4, https://m.media-amazon.com/images/G/01/B2B/DeveloperGuide/vat_calculation_service__dev_guide_H383rf73k4hsu1TYRH139kk134yzs.pdf
// The id is never rewritten: callers keep it verbatim.
export function classifyTransactionId(id, type) {
  const s = String(id ?? ''), t = String(type ?? '');
  if (!/^Correction/.test(s)) return { role: null, format: null, unknown: false };
  const p = s.split(':'), full = (...i) => i.every(k => p[k] !== undefined && p[k] !== '');
  if (p[0] === 'CorrectionReversal' && p.length === 3 && full(1, 2)) return t === 'REFUND' ? { role: 'REVERSAL', format: 'reversal', unknown: false } : { role: null, format: null, unknown: true, why: `CorrectionReversal id with transaction type ${JSON.stringify(t)} (expected REFUND)` };
  if (p[0] === 'Correction' && p.length === 4 && p[1] === '' && full(2, 3)) return t === 'SHIPMENT' ? { role: 'CORRECTED', format: 'current', unknown: false } : { role: null, format: null, unknown: true, why: `Correction id with transaction type ${JSON.stringify(t)} (expected SHIPMENT)` };
  if (p[0] === 'Correction' && p.length === 3 && full(1, 2)) return t === 'SHIPMENT' ? { role: 'CORRECTED', format: 'legacy', unknown: false } : { role: null, format: null, unknown: true, why: `Correction id with transaction type ${JSON.stringify(t)} (expected SHIPMENT)` };
  return { role: null, format: null, unknown: true, why: 'the id starts with "Correction" but matches none of the known shapes' };
}
