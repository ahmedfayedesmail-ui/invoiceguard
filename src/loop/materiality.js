// STATUS: Implemented as isolated logic - Engine integration deferred.
// This module feeds no finding, no result and no customer-facing claim. It stays unwired until the engine makes a real, equivalent financial comparison.
// Amazon's report states the item price, which is not the invoice total: it must never be compared against a total, a net or a VAT figure from the seller's books.
// Materiality: is the amount at stake large enough, for THIS seller, to ask them to act? A dimension separate from proof (Observation) and from obligation (Applicability).
// Inputs: a threshold the seller declares (one absolute amount per currency, no default), the currency, and the tax relevance class of the field. Never invented, never converted.

/** Seller declaration, decimal text per currency -> minor units. Anything else is refused. There is no default. */
export function declareThresholds(decl) {
  const out = {};
  for (const [cur, v] of Object.entries(decl ?? {})) {
    if (!/^[A-Z]{3}$/.test(cur)) throw new Error(`A materiality threshold needs a three-letter upper-case currency code, not "${cur}".`);
    if (typeof v !== 'string' || !/^\d+(\.\d{1,2})?$/.test(v.trim()) || Number(v) <= 0) throw new Error(`The materiality threshold for ${cur} must be a positive amount with at most two decimals.`);
    const [w, f = ''] = v.trim().split('.'); out[cur] = Number(w) * 100 + Number((f + '00').slice(0, 2));
  }
  return out;
}
const undetermined = (reason, extra = {}) => ({ status: 'UNDETERMINED', reason, ...extra });
/** @returns {{status:'MATERIAL'|'IMMATERIAL'|'UNDETERMINED'|'NOT_APPLICABLE', reason:string, amountMinor?:number, currency?:string, thresholdMinor?:number}} */
export function assessMateriality({ domain, fieldClass, difference = null, thresholds = {}, periodChanges = null }) {
  if (domain !== 'DATA_RECONCILIATION') return { status: 'NOT_APPLICABLE', reason: `materiality does not apply to ${domain}` };
  if (fieldClass === 'IDENTIFYING') return { status: 'MATERIAL', reason: 'a difference in an identity field (tax id, currency, number) is material by its nature' };
  if (fieldClass === 'TIMING') return periodChanges === true ? { status: 'MATERIAL', reason: 'the date difference changes the candidate tax period' } : periodChanges === false ? { status: 'IMMATERIAL', reason: 'the date difference stays inside the same candidate tax period' } : undetermined('the candidate tax period could not be compared');
  if (fieldClass !== 'AMOUNT_TAX') return undetermined(`unknown field class ${fieldClass}`);
  if (!difference || !Number.isInteger(difference.minor) || !/^[A-Z]{3}$/.test(difference.currency ?? '')) return undetermined('no comparable amount difference');
  const { minor, currency } = difference, th = thresholds[currency];
  if (!Number.isInteger(th)) return undetermined(`no materiality threshold declared for ${currency}`, { amountMinor: minor, currency });
  return Math.abs(minor) >= th ? { status: 'MATERIAL', reason: `the difference is at or above the threshold you declared for ${currency}`, amountMinor: minor, currency, thresholdMinor: th } : { status: 'IMMATERIAL', reason: `the difference is below the threshold you declared for ${currency}`, amountMinor: minor, currency, thresholdMinor: th };
}
/** Row rule for the reconciliation domain (policy table R1 and R4). */
export function actionabilityFromMateriality(m) {
  if (m.status === 'MATERIAL') return { actionability: 'SELLER_ACTION', summaryOnly: false };
  if (m.status === 'IMMATERIAL') return { actionability: 'NONE', summaryOnly: true };
  if (m.status === 'UNDETERMINED') return { actionability: 'REVIEW', summaryOnly: false };
  return { actionability: 'UNCHANGED', summaryOnly: false };
}
/** Immaterial differences never disappear: one line per currency. */
export function summarizeImmaterial(items) {
  const by = new Map(); for (const { currency, minor } of items) { const a = Math.abs(minor), c = by.get(currency) ?? { currency, count: 0, sumAbsMinor: 0, largestAbsMinor: 0 }; c.count++; c.sumAbsMinor += a; c.largestAbsMinor = Math.max(c.largestAbsMinor, a); by.set(currency, c); }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
