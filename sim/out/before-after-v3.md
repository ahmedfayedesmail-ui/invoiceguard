# V3 before / after (seed 0, 500 synthetic sellers). V1 and V2 files untouched.
Before = V2 (engine at main 35bb98a), results.jsonl / aggregate.txt. After = V3 (engine = WS1 fix + WS-B2B fix, integration branch integration/v3-combined 51affd3, for measurement only, not for merge), results-v3.jsonl / aggregate-v3.txt.
Command: node sim/run.mjs 500 sim/out/results-v3.jsonl 0 ; python3 sim/aggregate.py sim/out/results-v3.jsonl

| Bucket of confident commercial findings | V2 | V3 |
|---|---|---|
| total | 1,135 | 1,018 |
| true (matches injected defect) | 930 | 930 |
| false | 0 | 0 |
| declaration-dependent (not decidable) | 80 | 80 |
| on conflicting evidence (the 28) | 28 | 0 |
| non-B2B bucket ("unscored non-B2B") | 97 | 8 |

Formulas: strict = true/total: 930/1135 = 81.9% -> 930/1018 = 91.4%. Decided-findings precision (true / (true + false + conflicting)): 930/958 = 97.1% -> 930/930 = 100%. This excludes the declaration-dependent (80) and the remaining non-B2B bucket (8). It is NOT accuracy and is NOT quotable alone.
Recall in scope: 751/805 = 93.3% in both (unchanged). Missed: 34 number differs, 20 other-order links (both unchanged, WS2).
Follow-up cohort, V2 -> V3: closedCorrect 141 -> 127, closedWrong 38 -> 36, stillOpenCorrect 270 -> 244, lost 0 -> 42.
Explained (checked item by item, 565 follow-up todo items compared between the main engine and the B2B engine on the same seed): exactly 49 items differ, and all 49 are on orders whose is-business-order is FALSE (the simulation's follow-up list counts them as defects, the engine now refuses to judge them). 0 differing items are on TRUE orders. Items that are empty on TRUE orders are empty on main too (books gap hedged by a month-only coverage note), so they are not a regression. The simulation's follow-up expectation for non-business orders is NOT changed here: it needs a reviewed decision.
Still open: the 8 remaining findings in the non-B2B bucket are not yet audited; the per-case audit of the original 97 is not yet written.
