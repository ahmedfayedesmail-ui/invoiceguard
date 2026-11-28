# Why pinned baseline 06e5496450ee differs from the other seven (Nov 28 2026, local comparison, nothing in sim/out/pinned-baseline was changed)
Compared sim/out/pinned-baseline/06e5496450ee/results.jsonl.gz with the V5 re-run at 5c6b681 (/tmp/v5-5c6b681, same harness 287b17e), row by row over all 500 sellers, ignoring the three timing fields the fingerprint already ignores.
Result: exactly two kinds of difference and nothing else.
1. A new counter key `historyIncomplete` (value 0 in every row) inside `buckets`: 482 rows.
2. The same new key inside `round2.states`: 108 rows (the rows that have a round2 block).
Every other field (outcome, defects, eval, stats, issue counts, notes, per-family counts, all bucket values that existed before) is identical, row by row.
Cause: commit 3b1821a (2026-11-27 18:09, "deleting an import leaves a permanent record and marks every touched finding HISTORY_INCOMPLETE") added the historyIncomplete state to the counters. 06e5496 (17:24) is an ancestor of the later baselines and 3b1821a is NOT an ancestor of 06e5496, so that baseline predates the new counter. The seven later baselines (from fb67ad9 on) are byte-identical to each other and to 5c6b681 and 53b208b.
Verdict: 06e5496450ee is a stale baseline (an older counter schema), not a sign of changed behaviour: the new key is always 0 in this harness (no import deletions are simulated). Proposed, NOT done: leave it in place and add this note; retiring it is the owner's call. The pinned baselines were not touched.
