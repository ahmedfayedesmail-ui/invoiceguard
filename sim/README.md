# 500-seller stress test (simulation only)

Synthetic only. No real seller data, no deploy, no production code touched.

Run (about 45 s, deterministic: same seed gives the same results apart from timings):

    node sim/run.mjs 500 sim/out/results.jsonl && python3 sim/aggregate.py sim/out/results.jsonl

Layout
- `gen.mjs`, `scenarios.mjs`: build sellers and the expected problems. They import nothing from `src/`, so the expected results do not depend on the engine.
- `run.mjs`: loads each seller's files through the real engine (`detectLedgerMapping`, `preflight`, `createLoopStore`, `project`) and compares to the injected problems. Matching is by order id or document number.
- `aggregate.py`, `analyze.py`: totals and drill-down.
- `out/results.jsonl`: raw result per seller. `out/aggregate.txt`: totals. `out/failing-ids.json`: seller ids per failure category.

Metric definitions (denominators are always stated)
- Recall = detected injected problems / injected in-scope problems (normal cohort, excluding sellers whose own declaration is wrong).
- Precision = 1 - confident false findings / confident findings (state ACTION_REQUIRED). Example from the baseline: 59 false of 926 confident = 93.6%.
- Out-of-contract problems (invoice totals, credit notes) are counted separately and are never counted as detected.
- Cohort `monthly_export`: the books export ends at the end of the period, not on the report day. Reported separately because the engine refuses to conclude absence there.

Limits
- Expected results are my reading of the engine contract, built by construction. They can hide errors where reading and engine agree but a real Amazon file differs.
- The harness asks the engine's reader once to learn whether localized document-type words are rejected, then models a seller who sets the document type by hand.
