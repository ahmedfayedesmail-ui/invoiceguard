# Phase A status (branch feat/engine-v2-phase-a)

All counts in the reports are local runs. No CI run exists on this branch.

## Materiality: Implemented as isolated logic - Engine integration deferred
`src/loop/materiality.js` is tested as a pure unit (`test/phase-a-materiality.test.js`). It feeds no finding, no result and no customer-facing claim.
Reason: the engine compares only currency and buyer tax id today. Amazon's report states the item price, not the invoice total, and net and VAT are not read. Materiality stays unwired until a real, equivalent financial comparison exists. Phase A is not functionally complete.

## Business flag and DATA_RECONCILIATION: deferred architectural work, not solved
Non-business shipments (is-business-order FALSE) are not linked to the books and not reconciled. The spec `the business flag must not affect DATA_RECONCILIATION` in `test/phase-a-materiality.test.js` is an incomplete TODO and is never reported as a passing test. Fixing it changes every current number and needs its own decision.

## Coverage metric (new, independent; feeds no finding)
One model over ALL unique transactions in the loaded Amazon reports (one shipment counts once however many item rows it has):
transactions total = scope + undetermined + outside the check. The invariant is a test.
- scope: shipments determined to need a seller invoice (is-amazon-invoiced FALSE and is-business-order readable). Business and non-business are subsets of it.
  - business: entered, linked to a document in the books by invoice number (any Amazon status), not linked; plus, apart, how many of the linked are also shown as accepted by Amazon (this equals the Summary's "Matched by invoice number")
  - non-business: count, status NOT_EVALUATED because of the current check rule, never "unmatched"
- undetermined (own count, own reasons, in no scope figure): business-order blank, neither TRUE nor FALSE, or conflicting between rows; the is-amazon-invoiced field unreadable or contradicting the status
- outside the check: invoices created by Amazon; corrections and non-shipment rows
The page shows the block "What this check covered" above the Summary, the export carries the same numbers and words (`coverage`), and the words never present the business-only figure as covering every shipment.
Regression: `test/golden/engine-output-before-coverage.json` holds hashes of the engine output taken BEFORE coverage existed, for four synthetic scenarios. The 500-seller simulation (sim/v3-forensics harness) was re-run on this branch and its aggregate is identical to the published V5 aggregate apart from the timing line.

## Row integrity (branch fix/blank-flag-unknown): closed by Ahmed at 4aaefd8, policy "option A"
Invalid VIDR rows (wrong cell count, missing required cell, header without the required columns, or a short line that exactly completes the row before it) are quarantined and never used. No automatic reassembly or repair, no refusal of a whole file over one bad row. Valid rows are kept. The seller sees the count, the line numbers and a warning (invalidRowsCount, invalidRows, warning on manual/preview and manual/issue), never cell content.
Results: CI run 46053834813 on 4aaefd8: 646 tests, 645 pass, 0 fail, 1 todo; campaign 1005 cases, 10488 assertions, 0 failures. Local: 630 non-browser tests, 629 pass, 1 todo; V5 identical to the pinned fingerprint.
Documented cost: a valid row directly followed by a stray short line that would exactly complete it is quarantined with it.
Closing this item does not approve the pull request.
Open and unrelated to this item: (1) the DATA_RECONCILIATION business-flag todo above; (2) is-invoice-corrected, where src/vidr.js bool() reads a blank as false, untested and unfixed; (3) the loop reader parseTable keeps its own strict count and is unchanged. Closed: the manual-journey clock assertion and the sign-in timing failure (a test defect).
