# Phase A status (branch feat/engine-v2-phase-a)

All counts in the reports are local runs. No CI run exists on this branch.

## Materiality: Implemented as isolated logic - Engine integration deferred
`src/loop/materiality.js` is tested as a pure unit (`test/phase-a-materiality.test.js`). It feeds no finding, no result and no customer-facing claim.
Reason: the engine compares only currency and buyer tax id today. Amazon's report states the item price, not the invoice total, and net and VAT are not read. Materiality stays unwired until a real, equivalent financial comparison exists. Phase A is not functionally complete.

## Business flag and DATA_RECONCILIATION: deferred architectural work, not solved
Non-business shipments (is-business-order FALSE) are not linked to the books and not reconciled. The spec `the business flag must not affect DATA_RECONCILIATION` in `test/phase-a-materiality.test.js` is an incomplete TODO and is never reported as a passing test. Fixing it changes every current number and needs its own decision.

## Coverage metric (new, independent)
`project().coverage` states what the check looked at and what it did not, counting unique shipments, never rows:
- business shipments: entered, matched, not matched (matched = linked to a document in the books by its invoice number)
- non-business shipments: count, status NOT_EVALUATED because of the current check rule, never "unmatched"
- blank, unreadable or conflicting flag: counted apart as undetermined, in no denominator
- outside the check: Amazon-created invoices, corrections and non-shipment rows
It feeds no finding. `test/golden/engine-output-before-coverage.json` holds hashes of the engine output taken BEFORE the change; the test proves issues, buckets, stats, notes and imports are byte-identical for four synthetic scenarios (this is not the 500-seller V5 run).
