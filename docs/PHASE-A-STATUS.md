# Phase A status (branch feat/engine-v2-phase-a)

All counts in the reports are local runs. No CI run exists on this branch.

## Materiality: Implemented as isolated logic - Engine integration deferred
`src/loop/materiality.js` is tested as a pure unit (`test/phase-a-materiality.test.js`). It feeds no finding, no result and no customer-facing claim.
Reason: the engine compares only currency and buyer tax id today. Amazon's report states the item price, not the invoice total, and net and VAT are not read. Materiality stays unwired until a real, equivalent financial comparison exists. Phase A is not functionally complete.

## Business flag and DATA_RECONCILIATION: deferred architectural work, not solved
Non-business transactions (is-business-order FALSE) are not linked to the books and not reconciled. The spec `the business flag must not affect DATA_RECONCILIATION` in `test/phase-a-materiality.test.js` is an incomplete TODO and is never reported as a passing test. Fixing it changes every current number and needs its own decision.

## Coverage metric (new, independent; feeds no finding)
One model over ALL unique transactions in the loaded Amazon reports. KEY: the count is by Amazon transaction (marketplace, transaction type, transaction id, order id and shipping id together), NOT by shipment. A shipment with several transactions counts once per transaction. No figure is a count of shipments until a shipment key is proven; this is the same question as programme item six (split shipments). A test with one shipping id and two transaction ids pins this (count 2).
transactions total = scope + undetermined + outside the check. The invariant is a test.
- scope: transactions determined to need a seller invoice (is-amazon-invoiced FALSE and is-business-order readable). Business and non-business are subsets of it.
  - business: entered, linked to a document in the books by invoice number (any Amazon status), not linked; plus, apart, how many of the linked are also shown as accepted by Amazon (this equals the Summary's "Matched by invoice number")
  - non-business: count, status NOT_EVALUATED because of the current check rule, never "unmatched"
- undetermined (own count, own reasons, in no scope figure): business-order blank, neither TRUE nor FALSE, or conflicting between rows; the is-amazon-invoiced field unreadable or contradicting the status
- outside the check: invoices created by Amazon; corrections and non-shipment rows
The page shows the block "What this check covered" above the Summary, the export carries the same numbers and words (`coverage`), and the words never present the business-only figure as covering every shipment.
Regression: `test/golden/engine-output-before-coverage.json` holds hashes of the engine output taken BEFORE coverage existed, for four synthetic scenarios. The 500-seller simulation (sim/v3-forensics harness) was re-run on this branch and its aggregate is identical to the published V5 aggregate apart from the timing line.
