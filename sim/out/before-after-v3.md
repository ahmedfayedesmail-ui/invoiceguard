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
Open, not explained away: the 8 remaining findings in the non-B2B bucket are not yet audited. The follow-up cohort changed: V2 closedCorrect 141 / closedWrong 38 / stillOpenCorrect 270 / lost 0 -> V3 127 / 36 / 244 / lost 42. Half of the lost items sit on orders whose is-business-order is FALSE (the simulation's follow-up todo counts them as defects, the engine now refuses to judge them). The other half have is-business-order TRUE and their disappearance is NOT yet explained.
