DRAFT. Not approved. Not for merge. No deploy. Main is untouched (35bb98a).

Closing phase A (row integrity) is not approval of this PR. The PR is Draft with 63 commits and 224 files (+65,755 / -918) and needs independent review before any merge. Most of that size is simulation, tests, evidence and audit files. The production code diff is small, see "Where to look".

Branch: fix/blank-flag-unknown. Last code commit: 4aaefd8. Commits after it change documentation only.

## What this PR does
A blank, unreadable or conflicting is-amazon-invoiced or is-business-order is UNKNOWN in every path. It is never issued, never skipped as a consumer order, and never a confident finding. It goes to UNDETERMINED, HELD or ISSUER_UNDETERMINED.
- Flag readers: all 14 read sites are inventoried (docs/FLAG-READERS-INVENTORY.md) and each has a test.
- Issuer: CREATED_BY_AMAZON needs an explicit TRUE on every row. Per-document old and new states: audit/blank-flag/issuer-state-changes.txt.
- Issuing needs a VIDR. The Order Report is preview-only.
- Row integrity (phase A, final policy "option A"): a VIDR row is complete when its cell count equals the header, or is smaller with only the optional citation-en and citation-es missing. Any other row is invalid and quarantined. A short unreadable line directly after an accepted row is paired with it only when the join is exact, and both are quarantined. Rows are never repaired, never guessed, never turned into shipments, hold cards or invoices. Valid rows in the same file are kept.
- Visibility: manual/preview and manual/issue return invalidRowsCount, invalidRows (max 50, each {line, reason, cells, expected}, no cell content) and a warning (string, or null for a clean file). The upload page shows the warning above the counts and in the note after issuing.

## Where to look
- Production code: `git diff 35bb98a..4aaefd8 -- src public` . src: app.js, manual.js, pipeline.js, reconcile.js, vidr.js, loop/cards.js, loop/coverage.js, loop/materiality.js, loop/project.js, loop/store.js (10 files, +341 / -93). public/ adds 4 files (upload page warning and rebuilt bundles): 14 files, +759 / -303 for src and public together.
- Phase A row integrity: src/vidr.js (checkTsv, parseVidr), src/manual.js (planUpload), src/pipeline.js, src/app.js.
- Tests: test/row-integrity.test.js (10), test/row-integrity-last-cells.test.js (10), test/manual-invalid-rows-api.test.js (5), test/security-clock.test.js (2).
- Bulk, not production: sim/, evidence/, audit/, tools/.

## What is proven, and where it ran
CI, run 46053834813 on 4aaefd8, every step success. CI tests a temporary merge of the commit with main at 35bb98a, which is PR testing and not a merge.
- 646 tests, 645 pass, 0 fail, 1 todo (the DATA_RECONCILIATION spec below). Includes the 16 browser tests.
- Campaign inside CI: 1005 cases, 10488 assertions, 0 failures.
Local on the operator's machine, same commit:
- Non-browser 630 tests, 629 pass, 0 fail, 1 todo. Browser: vault-ui 6/6, loop-ui 2/2, local-engine 7/7, history-idb 1/1.
- V5 (500 synthetic sellers) from a clean checkout: rowsSha256 989762af..., aggregateSha256 b33e101e..., identical to the pinned fingerprint (sim/out/pinned-baseline/, README lists them). V5 does not exercise blank or conflicting flags and carries no document states. It shows the 500-seller results did not move. It does not prove the unknown-flag fixes.
Tests-first: failing artefacts are in audit/blank-flag/pre-fix-run-*.txt. Which tests failed before each fix, and the guards that passed before, are stated in the commit messages and in those files.
Sign-in test: one local failure (401 expected, 200 got) was a test defect, not an authentication defect. The test read the clock fresh for every code, so a 30 s step boundary between enable and login produced a legitimately fresh code. An injected clock reproduces it deterministically and the test now freezes the clock. src/security.js is unchanged.
Manual journey: the invoice-issue-window assertion is restored under a fixed clock (2026-11-24 10:30Z). Moving the clock one day later makes it fail, so it can fail. Closed.

## What is not proven
- Everything here is synthetic. No real seller data and no real Amazon acceptance cycle. Production claims wait for a complete real-seller cycle.
- "decided-findings precision" is not accuracy. The 59 are Unsupported Confident Findings (findings the file could not support), not proof that Amazon issued invoices. They map to 11 sellers of the 14 in the fixture.
- An unquoted TSV cannot tell a short complete row from a truncated one by cell count alone. The pair rule only quarantines. Documented cost: a valid row directly followed by a stray short line that would exactly complete it is quarantined with it. This needs an already damaged file, and the rule fired zero times across the suite and the campaign.

## Open issues (independent of phase A; passing CI does not close them)
1. DATA_RECONCILIATION and the business flag. Non-business shipments (is-business-order FALSE) are held out before linking, so a currency difference on them is not found. The spec is test/phase-a-materiality.test.js:64, declared TODO, never counted as a pass. Engine change not made.
2. is-invoice-corrected. src/vidr.js:14 bool() reads anything but TRUE as false, so a blank is read as false (used at src/vidr.js:68). Different field, no test, not fixed.
Known limits, stated and unchanged:
3. The problem loop reads tables with parseTable, a different reader. It counts ragged rows with a strict cell count and marks the import incomplete. It does not use the VIDR pair rule.
4. Materiality (src/loop/materiality.js) is isolated logic and feeds no finding (docs/PHASE-A-STATUS.md).
Closed in this round: the manual-journey clock assertion; the sign-in timing failure (test defect, see above).

## Not in this PR
Programme stages after phase A are untouched: European ledger import, partial exports, document integrity, accounting validation, split shipments. Policy options B (rejoin rows) and C (refuse a file over one bad row) were rejected and are not implemented.

## Evidence index
- audit/blank-flag/ (pre-fix and post-fix runs, mutation-checks.txt, issuer-state-changes.txt)
- docs/FLAG-READERS-INVENTORY.md, docs/PHASE-A-STATUS.md
- CI: https://github.com/ahmedfayedesmail-ui/invoiceguard/actions/runs/46053834813
