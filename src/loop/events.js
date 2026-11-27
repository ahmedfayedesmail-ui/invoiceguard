// Seller events: the only human input. Append-only. An event never writes a state; the projection reads it as evidence of what was said.
export const EVENT_TYPES = ['ACTION_STARTED', 'RESOLUTION_DECLARED', 'LINK_DECISION'];
/** D2 allowlist. RESOLUTION_DECLARED is accepted only here, and only ever yields MANUALLY_REPORTED_RESOLUTION. */
export const DECLARATION_ALLOWED = Object.freeze({
  UNMATCHED_DOCUMENT: { kinds: ['NOT_AN_AMAZON_SALE'], subtypes: ['NO_CANDIDATE'] },
  BOOKS_GAP: { kinds: ['RESOLUTION_DECLARED'], subtypes: null },
});
export const NO_DECLARATION = Object.freeze(['INVOICE_AMAZON_STATE', 'SOURCE_INCOMPLETE', 'CREDIT_NOTE_AMAZON_STATE', 'CORRECTION_PAIR_OPEN']);
const blank = (v) => !String(v ?? '').trim();
/** Shape check only (who, when, why). Whether the event fits an issue is decided against the projection. Returns a plain reason or null. */
export function eventShapeProblem(e) {
  if (!e || !EVENT_TYPES.includes(e.type)) return 'Unknown event type.';
  if (blank(e.author)) return 'An event needs an author (any name or role the seller chooses).';
  if (blank(e.reasoning)) return 'An event needs the seller\'s reasoning, in words.';
  if (Number.isNaN(Date.parse(e.createdAt))) return 'An event needs a time.';
  if (e.type === 'LINK_DECISION') { if (blank(e.ledgerKey) || blank(e.amazonId) || !['CONFIRM', 'REJECT'].includes(e.decision)) return 'A link decision names the accounting document, the Amazon transaction and CONFIRM or REJECT.'; }
  else if (blank(e.issueKey)) return 'An event names the problem it is about.';
  if (e.type === 'RESOLUTION_DECLARED' && blank(e.kind)) return 'A declared resolution needs its kind.';
  return null;
}
/** Does this issue accept this declaration? Returns a plain reason or null. */
export function declarationProblem(e, family, subtype) {
  if (NO_DECLARATION.includes(family)) return 'Amazon\'s own state and the state of a file cannot be declared resolved. Only a newer file can change them.';
  const rule = DECLARATION_ALLOWED[family]; if (!rule) return 'This kind of problem does not accept a declaration.';
  if (!rule.kinds.includes(e.kind)) return `This kind of problem accepts only: ${rule.kinds.join(', ')}.`;
  if (rule.subtypes && !rule.subtypes.includes(subtype)) return `This declaration applies only to problems of kind: ${rule.subtypes.join(', ')}.`;
  return null;
}
