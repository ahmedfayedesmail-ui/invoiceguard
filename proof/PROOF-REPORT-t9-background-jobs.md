# Proof report: swarm/t9-background-jobs (background manual issuance)

Branch under test: `swarm/t9-background-jobs` @ `500a9702534ed323d9870bf2da06ece38907905c` (unchanged, no app code edited).
Proof branch: `swarm/t9-proof-report` (child of the SHA above; adds only `proof/`: harness, raw JSON results, UI screenshots, this report).
Governance: nothing merged, nothing deployed, main untouched. Synthetic data only. All numbers below are measured in this run on a 1-vCPU / 2 GB sandbox (Node v22.23.5, node:sqlite, file DB in WAL mode). VIES is stubbed (always valid, 0 ms), so these are CPU-bound worst cases; real VIES latency would add awaits, not CPU.

Harness: `proof/server.mjs` runs the real `createApp` in a child process with an in-process loop-lag and memory sampler (20 ms timer drift, written every 250 ms). Latency probes are real HTTP calls (`GET /api/me`) from a second seller, every 50 ms.

## Verdict
Mergeable on the behaviours proven here, with four honest caveats the owner should weigh (section 7). Biggest one: the event loop still blocks about 0.35 to 0.5 s twice per 10k-row job (parse at start, repair detection at end), so "probe < 500 ms" holds only barely. Max measured: 485 ms by HTTP probe, 524 ms in-server.

## 1. 10,000-row VIDR (`proof/results/s1-10k.json`)
File: 10,000 rows = 9,000 issuable, 500 with blank `is-business-order` (must hold), 500 FALSE (not business).

| Measure | Result |
|---|---|
| POST /api/manual/issue | 202 in 20 ms |
| Preview (inline, unchanged) | 596 ms |
| Total job time | 31.3 s (sync path same input: 32.6 s) |
| Issued / held / skipped | 9,000 issued, 500 held, 0 errors; 500 FALSE rows not business (willIssue 9,000) |
| HTTP probe from another seller during job | 346 probes, p50 48 ms, p95 61 ms, max 485 ms, 0 non-200 |
| In-server loop lag during job | steady 30 to 60 ms; two spikes: 524 ms at job start (+0.5 s, report parse), 342 ms at job end (+31.3 s, repair detection). A 564 ms spike before the job is the inline preview |
| Memory | idle RSS 202 MB, peak RSS 278 MB, peak heap 110 MB, end heap 103 MB |
| Equivalence vs sync path | deep-equal: 9,000 invoices (all columns, full JSON minus timestamps) and 9,500 shipments (all state columns) identical. Held reason breakdown: 500, all the blank-flag reason |
| Uniqueness | no shipment has two invoices |

Also earlier at 1,000 rows: equivalence true (900 issued, 50 held).

## 2. Concurrent sellers (`s2.json`, plus `s2-mid.json`)
3 big sellers upload 3,000 rows at the same instant, a 4th small seller (50 rows) arrives 200 ms later, a 5th seller is the latency probe, and a second process hammers the same SQLite file with short IMMEDIATE write transactions (610 commits).
- All 4 jobs: 202 within 21 to 245 ms; all `done`, 2,700 issued + 150 held each, small seller 45 + 3; 0 errors; progress counters monotonic; 0 poll failures.
- Probe: 464 probes, p50 8 ms, p95 58 ms, p99 136 ms, max 344 ms, 0 over 500 ms, 0 non-200. In-server lag max 268 ms.
- SQLITE_BUSY: 0 in server log, 0 job errors, writer process: 0 busy errors, 0 other errors. Peak RSS 259 MB.
- Tenant isolation: 318 cross-seller job polls (every seller asking for every other seller's job id): all 404, 0 leaks. Sellers 0 and 1 uploaded the same order ids (same tag) and each got only their own 2,700 invoices; invoice JSON seller name matched the owner in all sampled rows; invoice numbers per seller A-2026-000001..2700 (independent counters); no duplicate invoice per shipment, no duplicate numbers.
- Heavier contention (`s2-mid.json`, writer holding the lock about 25% of the time, 3 x 1,000 rows): all done, 0 BUSY, probe max 165 ms.
- Stress limit, not a pass: with an external writer holding the lock about 95% of the time, 3 x 1,000 rows did not finish in 110 s (run aborted by me, so no result file). No BUSY errors appeared in the log, but throughput collapsed. This needs a second writer process; production has one process.
- **Fairness: strict FIFO, not round-robin.** Seller 2 ran 0.9 to 10.5 s, seller 0 ran 10.4 to 21.5 s, seller 1 ran 21.5 to 32.8 s, the 50-row seller finished at 32.8 s: it waited behind about 9,000 rows. Nobody starved or failed, but a small upload can wait the sum of all queued big jobs. Other sellers' normal requests are not delayed (probe above).

## 3 and 4. Kill -9 mid-job, restart, retry (`s3-queued/early/mid/nearend.json`)
Each round: SIGKILL the server at the chosen point, check DB, restart on the same file, read job status, re-upload the same report, then upload it a third time. A second seller's finished job sits in the same DB as a control.

| Kill point | A at kill | Invoices at kill | Restart: job A / job B | Retry 1 | Retry 2 |
|---|---|---|---|---|---|
| queued (right after 202), 1,000 rows | queued, 0 | 0 | error (restart message) | 900 issued, 0 skipped | 0 issued, 900 skipped |
| early, 1,000 rows | issuing 45/900 | 45 | error / error (B was queued) | 855 issued, 45 skipped | 0 / 900 |
| mid, 3,000 rows | issuing 1,378/2,700 | 1,378 | error / error | 1,322 issued, 1,378 skipped | 0 / 2,700 |
| near-end, 3,000 rows | issuing 2,577/2,700 | 2,578 | error / error | 123 issued, 2,577 skipped | 0 / 2,700 |

- Restart message on the job (verbatim start): "The upload was interrupted by a server restart. Invoices already created from it are kept; upload the report again to continue - already-issued orders are recognised and skipped." Status `error`, HTTP 500 in the job record, stored report text dropped (`report_text` NULL) for both the running and the queued job.
- Invoice numbers contiguous with the counter after every kill and after retry. Final counts equal expected (900 / 900 / 2,700 / 2,700), 0 duplicates per shipment, 0 duplicate numbers.
- Unique constraint holds: a direct INSERT of a second invoice for an existing shipment is rejected (`UNIQUE constraint failed: invoices.seller_id, invoices.shipment_key`; indexes `uniq_invoice_per_shipment`, `uniq_rect_per_event`).
- Audit hash chain verifies (`verifyAudit` ok) after the final retry.
- Job ledger after the retries: per round 2 `done` and 2 `error` rows (interrupted A and B stay as `error`; the two retries are `done`); no job lost, none silently retried.
- Control seller's finished job untouched by every restart (done, 90 invoices).
- **Partial state at kill (1 order, seen in 1 of 4 rounds, also once in a 1,000-row dry run):** the near-end kill left 1 invoice (`upload_status=pending`) whose shipment row was not yet `ready`. Cause (read in `src/pipeline.js`): the invoice INSERT and the `ready` mark are separate steps with an async PDF render between. Not a partial invoice set, but one order can be mid-flight. Retry reused that existing invoice (no new number, no duplicate) and marked it ready. Final consistency checks clean.
- Report-snapshot flag: after a kill the VIDR `in_flight` mark stays 1 after restart (`store_pending` 0) until the next successful upload clears it (it was 0 after every retry). Effect: credit-note approvals stay blocked after a crash until the seller re-uploads, and the block message talks about "a sync is running". Safe direction, wording misleading. Not changed.

## 5. What the seller sees (`proof/results/ui/*-trace.json`, `*.png`)
The UI polls `GET /api/manual/jobs/:id` every 1 s. Rendered button/status text sampled every 150 ms from the real page in headless Chrome (3,000-row report, another seller's job queued ahead):
1. Click "Create 2700 invoices": button disabled, text "Creating invoices..." (about 1 s).
2. Queued OR parsing, same text: "Reading the file..." (3 s in the traced run while behind another job). The UI does not tell queued from reading.
3. Running: "Creating invoices... 15 of 2700", then 367, 741, 1108, ... 2611 of 2700 (updates about once per second).
4. Done: button gone, note "Created 2700 invoices. 150 orders are held for review - each one on Overview says why and what to do." and the Ready tab opens.
5. Failed after restart, server back before the next poll (`fast-trace.json`, `fast-3-after-fast-restart.png`): red status "The upload was interrupted by a server restart. Invoices already created from it are kept; upload the report again to continue - already-issued orders are recognised and skipped." Button returns to "Create the invoices"; the preview card stays so the seller can click again.
6. Failed after restart, server still down at the next poll (`restart-trace.json`): red "Failed to fetch", button back to "Create the invoices". Polling stops there. The interruption message is never shown in this case, and reloading the page loses the job id (no resume view). The seller's only path is to upload again, which is safe (section 3/4).
Screenshot caveat: `happy-2/3`, `restart-3/4/5` frames do not show the button area (scroll position missed it); the text traces are the decisive evidence. `fast-3` and `happy-4` show the final states.

## 6. Branch, tests, CI
- Branch SHA tested: 500a9702534ed323d9870bf2da06ece38907905c (`git status` clean apart from `proof/`).
- Full suite, run in 4 chunks of test files (91 files): 241 + 301 + 229 + 206 = **977 tests, 976 pass, 0 fail, 0 cancelled, 0 skipped, 1 TODO** (the TODO is `the business flag must not affect DATA_RECONCILIATION...`, "engine change not made yet", pre-existing). The earlier contention flake did not reproduce in this run. Per-chunk counts in `proof/results/r0*.txt`.
- New `test/manual-jobs.test.js` (3 tests) is included and passes.
- CI: see the message that carried this report for whether a GitHub run could be triggered. `ci.yml` runs on push to main and on pull_request only; a push of a feature branch does not start it. Local suite evidence above stands in for it. The CI-only steps (lxml XSD tests, `tools/campaign.mjs --no-live`) were not run here.

## 7. Caveats the owner should weigh
1. Loop still blocks 0.35 to 0.5 s twice per 10k job (planUpload parse at start, finishManualVidr at end). Max probe 485 ms; the earlier "112 ms" claim was for 3,000 rows. Chunking those two steps is the open backlog item.
2. Strict FIFO: a small seller waits for all queued big jobs (about 32 s here).
3. Restart UX: the loud message reaches the screen only if the server is back before the next 1 s poll; otherwise "Failed to fetch". No job resume after page reload. The API record is always correct.
4. One order can be mid-flight at a crash (invoice pending, shipment not yet ready); retry heals it with no duplicate or burnt number. `in_flight` stays up until the re-upload.
Not tested: real Amazon VIDR files, real VIES latency, multi-instance deploys, Railway restart behaviour, memory beyond 10k rows, jobs over 20k rows (parser cap).

## Reproduce
`node proof/s1-10k.mjs 10000 out.json`, `node proof/s2-concurrent.mjs 3 3000 out.json` (env `W_HOLD`/`W_GAP` set the second writer), `node proof/s3-restart.mjs queued|early|mid|nearend 3000 out.json`, `node proof/s5-ui.mjs happy|restart|fast` (needs `/usr/bin/google-chrome`).
