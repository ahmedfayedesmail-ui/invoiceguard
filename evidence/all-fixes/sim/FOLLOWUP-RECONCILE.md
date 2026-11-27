# Follow-up decline: main engine (35bb98a) vs integration/all-fixes, case by case (seed 0, same 500 sellers)
Definition of "lost": a todo item (one injected problem tracked in round 2) with NO issue of its own families for its order or number in round 2. declareOnly items are never counted as lost in the aggregate's follow-up line; they are counted here only where stated.
Files (one row per case): out/followup-49-cases-v5.json|csv (49 items whose round-2 state differs) and out/followup-lost-cases-v5.json|csv (all 106 lost items on the fixed engine, with lostOnMain / lostOnFixed). Each row: seller, order id, document number, scenario, kind, cohort, is-business-order value read from the round-2 Amazon file, shipment date, engine result before (main 35bb98a), engine result after (06e5496), reason.

## 49 changed items (565 items in total)
- All 49 have is-business-order FALSE in the round-2 file. 0 of 49 are on a TRUE order. 35 sellers.
- Before (main): 28 ACTION_REQUIRED, 17 VERIFIED_CLOSED, 4 MANUALLY_REPORTED_RESOLUTION. After: no issue.
- Reason, the same for every case and checked per row: main judges every shipment, the fixed engine judges only shipments whose flag is TRUE.
- By cohort: 46 through_report_day + 3 monthly_export. By kind: fixSome 22, fixCurrency 11, fixBooks 10, declareOnly 4, fixAllButStaleReport 2.

## 49 vs 42
- The aggregate follow-up line (lost 0 -> 42) covers the through_report_day cohort (402 sellers) and does not count declareOnly items: 46 - 4 = 42.
- 49 counts all cohorts and all kinds: 46 + 3 monthly_export. The 42 and the 49 are the same cases with different denominators.

## Lost 57 -> 106 (definition above, declareOnly included): item by item
- Lost on main: 57 = 53 (non-declareOnly) + 4 (declareOnly). All 57 are in monthly_export.
  - 46 of the 53: the round-2 books declare period 2026-10-02 to 2026-10-31, which ends before the round-2 report day (2026-12-04). The engine's rule gives an UNDETERMINED coverage note, never a finding (project.js, books gap coverage check).
  - 7 of the 53 (sellers 180 x5, 365 x1, 375 x1): round 2 has zero issues and every Amazon invoice matched by number (23/23, 131/131, 31/31, read from the round-2 projection). That round 1 held these only as coverage notes is by design and was not checked per item.
  - 4 declareOnly: the seller declared a resolution; no issue is raised in round 2.
- Lost on the fixed engine: 106 = the 57 + the 49 changed items (all FALSE-flag orders).
- Without declareOnly (the aggregate's convention): 53 -> 98 (98 = 56 monthly_export + 42 through_report_day).
- The sim's follow-up list still counts non-business orders as defects to follow. The engine now refuses to judge them. The simulator expectation was NOT changed; it needs a reviewed decision.
