# Every reader of is-amazon-invoiced and is-business-order (at dc24429)
Rule: TRUE or FALSE is read as written. Blank, unreadable or disagreeing values are UNKNOWN. Unknown is never inferred from invoice-status, company name or VAT number. Unknown is shown as undetermined or held, never issued, never skipped as consumer, never a confident finding. All test counts local. Found by grep over src, web, tools for the two column names, isAmazonInvoiced, isBusiness and the flag helpers.

| # | site | blank | conflict / unreadable | explicit TRUE / FALSE | test |
|---|---|---|---|---|---|
| 1 | src/loop/project.js amazonFlag, flagged | UNDETERMINED, note "(BLANK)", not Amazon-created | UNDETERMINED (rows disagree, field vs status disagree, unreadable) | read as written | blank-flag-unknown (loop), ws1 (15 tests), v1-59-regression |
| 2 | src/loop/project.js businessFlag, bflag | UNDETERMINED with note | UNDETERMINED | TRUE eligible, FALSE not judged | wsb2b-business-order (16), combined-regression |
| 3 | src/loop/project.js ledger-side hold-out (heldOutNum, heldOutOrder) | after this fix: books documents of the shipment are not judged | same | business FALSE: not judged | wsb2b 66, 84; test/flag-readers-inventory.test.js (5 loop cases). NEW DEFECT found by this inventory and fixed here: with the Amazon flag blank, unreadable or conflicting (the conflict case existed since e3b3bbf), the matching books document became a confident ACTION_REQUIRED UNMATCHED_DOCUMENT |
| 4 | src/loop/project.js stats and coverage (reads 1 and 2) | counted once as undetermined, in no scope figure | same | scope / outside scope | phase-a-coverage, blank-flag-unknown, flag-readers-inventory |
| 5 | src/vidr.js parseVidr (both columns) | null | null | true / false (case and spaces ignored) | blank-flag-unknown, blank-business-flag |
| 6 | src/vidr.js needsInvoice | false | false | needs a TRUE business flag and a FALSE Amazon flag | same |
| 7 | src/manual.js VIDR plan | held with reason | held | skipped or planned as written | same |
| 8 | src/manual.js Order Report | absent column: held; blank column: held | held | read as written, recorded as REPORT; a seller declaration fills only an absent or blank column, recorded as SELLER_DECLARATION | blank-flag-unknown, blank-business-flag (wording), manual.test |
| 9 | src/pipeline.js processReport | held, nothing uploaded | held | as written | blank-flag-unknown, blank-business-flag |
| 10 | src/app.js manual route (declaration option) | n/a | non-boolean declarations ignored | boolean declarations passed on | flag-readers-inventory (string "true" ignored), manual.test journey |
| 11 | web/engine-entry.js analyze (browser) | pass-through of the declaration option | | | NO direct test of the pass-through (planUpload under it is tested). Browser files run: local-engine 7/7 |
| 12 | public/local/engine.js, loop-engine.js (generated bundles) | rebuilt at the fix SHA | | | browser tests only; NO automatic check that a bundle matches its source |
| 13 | src/reconcile.js stages().expected | displays the columns, decides from invoice-status ALONE | decides from invoice-status alone | decides from invoice-status alone | NO TEST of blank or conflict. OPEN DEFECT, not fixed: 2 failing specs in audit/tests/live-defects.test.js (TRUE with InvoicePending is explained as "seller must upload"; blank with InvoiceCreatedByAmazon as "Amazon made this document"). No caller of stages() found in src or web, only in tests |
| - | tools/campaign.mjs, tools/make-*-fixtures.mjs, sim harness | write the columns to build files, do not read them | | | not readers |
| - | src/vidr.js bool() for is-invoice-corrected | a different field; blank is false | | | out of scope here, not tested for blank |
