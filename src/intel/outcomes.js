/** Advisory evidence classifications. These labels never authorize a financial transition. */
export const INTEL_OUTCOMES = Object.freeze([
  'PROVEN',
  'UNRESOLVED',
  'CONTRADICTED',
  'INCOMPLETE',
  'MANUAL_AUTHORIZATION'
]);

export function classifyEvidenceOutcome({
  completeness = 'UNKNOWN',
  proven = false,
  contradicted = false,
  manualAuthorization = false
} = {}) {
  let outcome;
  if (manualAuthorization) outcome = 'MANUAL_AUTHORIZATION';
  else if (completeness !== 'COMPLETE') outcome = 'INCOMPLETE';
  else if (contradicted) outcome = 'CONTRADICTED';
  else if (proven) outcome = 'PROVEN';
  else outcome = 'UNRESOLVED';

  const meanings = {
    PROVEN: 'The available evidence supports this statement.',
    UNRESOLVED: 'The available evidence does not decide this statement.',
    CONTRADICTED: 'The available evidence contains a conflict.',
    INCOMPLETE: 'The evidence history has a known or unresolved coverage gap.',
    MANUAL_AUTHORIZATION: 'A recorded human authorization exists; it is not an Amazon fact.'
  };
  return Object.freeze({ outcome, meaning: meanings[outcome], authority: 'ADVISORY_ONLY', changesFinancialState: false });
}
