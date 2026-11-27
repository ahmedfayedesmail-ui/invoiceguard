# NIGHT-SHIFT-EXECUTION-REPORT (Nov 27 23:05 to Nov 28 07:00 Cairo)  DRAFT, finalized at the end of the shift
Counts are local unless a CI run is named. Everything is synthetic. main (35bb98a), PR #2 (7b9f8df) and PR #3 (Draft, base fix/blank-flag-unknown) were not touched. Nothing was deployed. Stage 2 was not started.

## Commits on feat/phase-b-reconciliation-integrity (PR #3 content, Stage 1 only)
| SHA | What | CI run | Conclusion |
|---|---|---|---|
| b36bd29 | state at the start of the night | 46066474982 | success (711 tests) |
| d0a47b7 | WP0: one evidence entry per physical line for every finding | 46068529194 | success |
| 2bfd48b | WP1: correction replacement goes through the integrity gate | 46068796567 | FAILURE: one browser test timeout (see risks 8), passed on the rerun inside the same run |
| 814b94f | WP1 guard tests (retry/release, concurrent evaluation) | 46068894740 | success |
| 71d52ae | WP2 lab and precision limit AMOUNT_OUT_OF_RANGE | 46069251751 | success |
| 7380abf | WP3 database hardening | 46069866165 | success |
| 5c6b681 | WP2: rows with disagreeing repeated header columns are quarantined | 46070907097 | success |

## Branch research/invoiceguard-reconciliation-lab (NOT for PR #3)
d1074b7 prototype, 869b4b3 perf script. 13 tests. Not approved for integration.

## Bugs found and fixed (each with a test that failed first; artefacts in audit/phase-b/)
1. WP0 merged multi-line evidence (pre-fix-run-6-wp0-per-line.spec.txt, 4 failing).
2. Correction replacement issued from the first row when correction rows contradicted (pre-fix-run-7, 1 failing + 1 guard). This was a real bypass of the gate. That run was done in the same checkout with the source change stashed, not in a separate worktree.
3. Gate read exact cents but invoice builder used floats: 149382714704938.26 issued as 149382714704938.28 (pre-fix-run-8, 1 failing).
4. DB accepted invalid decision rows, evidence overwritten, ledger write not atomic (pre-fix-run-9, 4 of 7 failing).
5. A TSV header repeating a column name let the LAST column win silently (buyer, currency or date could change the invoice). Now quarantined when cells disagree (pre-fix-run-10, 1 failing). Counts after this fix (local): non-browser 725 tests, 723 pass, 0 fail, 2 todo; browser 7+2+1+6 pass; campaign 1005 cases, 0 failures; bundle current.
Stash disclosure: pre-fix runs 7 to 9 used git stash in the main checkout; one stash pop hit an old unrelated stash and conflicted on two files; I restored them to HEAD, nothing from it was committed (checked with git show --stat). Later pre-fix runs use a worktree. The old stash entry is still present.
Guards that passed on the old code (no defect): retry/release cannot bypass the gate; concurrent evaluation creates one invoice set.

## Test counts at 7380abf (local)
Non-browser 723 tests, 721 pass, 0 fail, 2 todo (Phase A DATA_RECONCILIATION todo, R11 todo). Browser files 6, 2, 7 and 1 pass (vault-ui, loop-ui, local-engine, history-idb). Campaign 1005 cases, 0 failures. V5 fingerprints match (rowsSha256 989762af..., aggregateSha256 b33e101e...). Bundles current.

## Deliverables
ISSUANCE-PATH-MAP.md, FINANCIAL-ADVERSARIAL-TEST-REPORT.md, RECONCILIATION-ARCHITECTURE.md, COMPETITIVE-INTELLIGENCE.md, RECONCILIATION-LAB-REPORT.md, STAGE-1-REMAINING-RISKS.md, this file. Design doc sections 15 to 18 added to docs/PHASE-B-DESIGN.md.

## Performance (WP7, local, lab/perf/perf-night.mjs; raw output night-docs/perf-night-output.json)
One shipment with 5000 rows: parse 150 ms, assess 96 ms, RSS 118 MB. 500 shipments: first processReport 1.9 s, re-evaluation 69 ms each time. 2000 shipments (714 held): first 6.0 s, re-evaluation 187 ms, RSS 164 MB, SQLite file 12.2 MB. Measured problem: history rows grow by one per open finding per evaluation (714 findings, 4 reruns, +2856 rows). Not changed (reviewed policy), see risks 5. Browser bundle public/local/engine.js is 2,975,167 bytes (2,954,633 at Phase A 7b9f8df, 2,973,791 at b36bd29), 558,518 gzipped. Browser compatibility was tested in Chrome (puppeteer) only; no other browser was run.

## Next-phase recommendations
Get one real de-identified VIDR and a later status report before tuning any tolerance. Decide R11 and the date upper bound. Decide the history coalescing. Then Stage 2 (seal) with Ahmed's explicit go-ahead.
