// Coverage statement: the words that say what the check covered and what it did not. It reads only the coverage numbers.
const UND = { BUSINESS_FLAG_BLANK: 'the business-order field is blank', BUSINESS_FLAG_CONFLICT: 'the rows of one shipment disagree about the business-order field', BUSINESS_FLAG_UNREADABLE: 'the business-order field is neither TRUE nor FALSE', AMAZON_INVOICED_FLAG_UNREADABLE_OR_CONFLICTING: 'who issues the invoice is blank, could not be read, or the fields that say so disagree' };
const list = (by, words) => Object.entries(by).filter(([, n]) => n > 0).map(([k, n]) => `${n} where ${words[k] ?? k}`).join('; ');
export function coverageStatement(c) {
  if (!c || !c.transactionsTotal) return ['No Amazon report is loaded, so nothing has been checked yet.'];
  const s = c.scope, b = s.business, out = [];
  out.push(`Scope: ${s.count} unique shipments that you must invoice yourself (Amazon did not create the invoice, and the business-order field could be read).`);
  if (s.count > 0) out.push(`${b.matched} of ${b.entered} business shipments are linked to a document in your books by invoice number, whatever Amazon's status; ${b.notMatched} are not linked. ${b.matchedAndAccepted ?? 0} of the linked ones are also shown as accepted by Amazon (the figure in the Summary below). ` + (s.nonBusiness.count > 0 ? `This figure covers business shipments only, not all ${s.count} shipments in scope.` : `This figure covers all ${s.count} shipments in scope.`));
  if (s.nonBusiness.count > 0) out.push(`${s.nonBusiness.count} shipments in scope were NOT EVALUATED: they are marked as non-business orders, and they were not checked against your books because of the current check rule. That is not a result for them either way.`);
  if (c.undetermined.count > 0) out.push(`${c.undetermined.count} could not be classified, so they are in none of the figures above: ${list(c.undetermined.byReason, UND)}.`);
  if (c.outsideScope.count > 0) out.push(`${c.outsideScope.count} are outside the check: ${c.outsideScope.byReason.AMAZON_INVOICED ?? 0} invoices created by Amazon, ${c.outsideScope.byReason.NOT_ORDINARY_INVOICE ?? 0} corrections or non-shipment rows.`);
  out.push(`Total: ${c.transactionsTotal} unique transactions = ${s.count} in scope + ${c.undetermined.count} undetermined + ${c.outsideScope.count} outside the check.`);
  return out;
}
