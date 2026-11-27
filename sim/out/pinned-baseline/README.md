# Pinned V5 baseline (500 sellers, synthetic only)

Reproduce any row of the table from a CLEAN checkout of the named engine SHA (harness pinned at 287b17e, the commit that published V5):

    tools/repro-v5.sh <engine-sha> <out-dir>

Each directory holds: aggregate.txt (aggregate without its wall-clock "projection ms" line), fingerprint.json, provenance.txt, run.log, results.jsonl.gz (raw per-seller rows), aggregate.full.txt.gz.
Fingerprint = sha256 over every seller row (sorted by seller) with totalMs, heapMB and projectMs removed, and sha256 of the aggregate without the timing line.

| engine SHA | what it is | rowsSha256 | aggregateSha256 |
|---|---|---|---|
| 06e5496450ee | integration/all-fixes commit the published V5 was run on | ffd6cdab... | b33e101e... |
| fb67ad993d0e | Phase 0 close | 989762af... | b33e101e... |
| 8665d523629a | Phase A head at the time of acceptance | 989762af... | b33e101e... |
| 23d7e0f0c6c0 | Phase A head after the coverage key fix | 989762af... | b33e101e... |

Result: the aggregate is identical for all four, and identical to the published sim/out/aggregate-v5.txt (apart from the timing line). The raw rows of the three newer SHAs are identical. The raw rows of 06e5496 differ from them in ONE way: Phase 0 added the key `historyIncomplete: 0` to each seller's `buckets`. After removing only that key, the 500 rows are identical (checked, 0 differences). No result value moved.
The golden hashes over four synthetic scenarios (test/golden) remain a separate guard and are not offered as a substitute for this run.

## Added for the blank-flag fix
- 982e3bd6ec94 (fix/blank-flag-unknown): rowsSha256 989762af..., aggregateSha256 b33e101e..., identical to 23d7e0f0c6c0 and 8665d523629a. Run with tools/repro-v5.sh from a clean checkout. The V5 harness has no scenario with a blank is-amazon-invoiced, so identity shows there is no collateral change, not that the blank fix works (the new tests do that).
- dc244293cfca (fix/blank-flag-unknown, second round): rowsSha256 989762af..., aggregateSha256 b33e101e..., identical to 982e3bd6ec94, 23d7e0f0c6c0 and 8665d523629a. Same caveat: the V5 harness has no blank-flag scenario, so the identity shows no collateral change only.
