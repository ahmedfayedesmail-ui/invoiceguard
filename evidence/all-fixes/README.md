# Evidence for integration/all-fixes (synthetic data only, no real seller, no deploy)
Everything here is reproducible from this branch: `node evidence/all-fixes/sim/run-v4.mjs 500 /tmp/r.jsonl 0 && python3 evidence/all-fixes/sim/aggregate.py /tmp/r.jsonl` gives out/aggregate-v5.txt (checked identical, apart from timings). Seed 0, same 500 sellers as V1 to V4. V1, V2 and V3 results stay unedited on sim/v3-forensics; V3 and V4 aggregates are copied here for comparison.
Independence caveat: the ground truth and denominators are unchanged, but the data comes from the same simulator the fixes were developed against. This is a regression check, not an independent validation.

## Runs
- V3 (WS1 + B2B): out/aggregate-v3.txt. V4 (all fixes, Ledger Data Quality only on non-business orders, engine 3bcf30c): out/aggregate-v4.txt. V5 (all fixes, Ledger Data Quality for ALL duplicates, engine 06e5496): out/aggregate-v5.txt, results-v5.jsonl.

## What moved between V4 and V5 (confident commercial findings, state ACTION_REQUIRED)
- Total 1,008 -> 884 (-124). true 930 -> 884 (-46). declaration-dependent 78 -> 0 (-78). false 0 -> 0. conflicting 0. non-B2B 0.
- The 124 are all DUPLICATE_DOCUMENT findings on business orders, now state OPEN in Ledger Data Quality: 78 SAME_NUMBER_DIFFERENT_CONTENT in scenario multi_line_declared_DOCUMENT (were declaration-dependent), 24 SAME_NUMBER_DIFFERENT_CONTENT in duplicate_different_content and 22 EXACT_REPEAT in duplicate_same_content (were true). Per-finding rows: out/duplicates-moved-v5.json (seller, document number, ledger key, subtype, documentLevel, rows, business flag, before, after).
- Ledger Data Quality items 16 -> 213 (+197 = the 124 above + 73 SUSPECTED_DUPLICATE that were already OPEN). 213 = 134 DOCUMENT-level + 79 unknown-level SUSPECTED; none counts in commercial precision or false findings.
- Strict precision 930/1008 = 92.3% (V4) -> 884/884 = 100.0% (V5). Denominator changes: the 78 left the bucket and the 46 true left both numerator and denominator. This is a definition change, not better accuracy, and not product accuracy. Decided-findings precision 930/930 -> 884/884, same note.
- Recall in scope stays 751/805 = 93.3%, but the metric counts an injected problem as found when ANY issue exists for its order or number, whatever its state. So the 46 injected duplicates still count as found while no longer raising an action.
- Follow-up line unchanged: closedCorrect 127, closedWrong 36, stillOpenCorrect 244, lost 42.
- out/before-after-v4.md describes V4 (3bcf30c) and is superseded by this file for the numbers above.
