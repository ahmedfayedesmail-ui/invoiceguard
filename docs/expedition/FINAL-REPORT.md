# InvoiceGuard expedition: final report

Branch: expedition/invoiceguard-product-grade. Base 8d9e6d9. Reviewed HEAD 608a415. Not merged, not deployed. PR #4 stays Draft. ALLOW_MANUAL_UPLOAD stays closed. Synthetic data only.

## Verdict
A strong engine, not yet a usable product. The money-safety core is much stronger: unproven identity is a HOLD, nothing is issued on a guess, a ledger write cannot silently resolve other findings, and one document cannot be uploaded twice by any path we know except the residuals below. The seller experience is thin: holds have an API and a demo, not a finished screen flow, and nothing has met real Amazon data or a real seller. Production claims wait for a complete real-seller cycle (Concierge Pilot).

## Agents (real, no other agents existed)
- Operator: chat-01M89X8RHBMGGAEZQMEP3TMSG4. Wrote all code, tests and docs. Launched no other agent.
- Launched by Main, read-only, all 6 delivered:
  - agent-01M8GZ15YAG0DHCVSPZVN7BA97: red team, acceptance bypass. No P0/P1, 5 P2.
  - agent-01M8GZ17K6ZXSSB4RZKKT19PJ2: red team, concurrency. 2 P1, 2 P2, 1 P3.
  - agent-01M8GZ18JQCN170ENVWW3SE4CZ: red team, holds API/UI. 2 P2, 2 P3.
  - agent-01M8GZ19P2CK7CENJ6H08W4338: red team, state machine. 2 P1, 1 P2.
  - agent-01M8GZVRMZ3Q8PVCHRNQ8MM2RA: re-review 1, duplicate submission and boot recovery. 6 rounds. Final: closed on 608a415 except the B2 residual.
  - agent-01M8GZVSJ38MAFVV52TFVMVWAA: re-review 2, holds UI and remediation diffs. Scope fully closed.
- Independence: the reviewers did not write the code they reviewed. The runtime model is not verified and not claimed.

## The 12 items
1. Architecture: ARCHITECTURE.md, DATA-FLOW.md
2. Invariants: INVARIANTS.md
3. State machine: STATE-MACHINE.md
4. Threat model: THREAT-MODEL.md
5. End-to-end demo: tools/demo-e2e.mjs, test/demo-e2e.test.js (synthetic)
6. HOLD experience: src/holds.js, /api/holds, USABILITY-REVIEW.md (API and explanations, no finished screen)
7. Tests: test/ (non-browser, loop-ui, campaign)
8. Red team results: FINDINGS.md and registry.json
9. CI evidence: below
10. Operations and recovery: OPERATIONS-AND-RECOVERY.md
11. Risk register: RISK-REGISTER.md (R1 to R22)
12. Readiness scorecard: SCORECARD.md

## CI evidence (real, from GitHub Actions job logs)
- 46148072209 on 608a415: success. 939 tests, 938 pass, 0 fail, 1 todo (the known one). Campaign 1005 cases, 0 failures.
- 46147443905 on d4f7f6f: success. 937 tests, 936 pass, 0 fail, 1 todo.
- 46146540182 on 8f0ca0b: success. 934 tests, 933 pass, 0 fail, 1 todo.
- Failures, both disclosed:
  - 46140997242 on accf3c7: A4a test timestamp artifact (a test assertion bug, fixed).
  - 46145425502 on 564c604: loop-ui test 449, puppeteer 15 s timeout (17.99 s total). Cause NOT proven. Eight green runs of the same test (8.6 to 9.6 s) before and after. No commit since touches the loop page. A rerun was refused (token scope 403, untouched). Not proven deterministic: it needs more repeated passes or timeout logging in the test.
- Local numbers are labelled local in every report. The campaign number above is from the CI log.

## Fix rounds
Six remediation rounds, beyond the 2-pass cap in ruling 3. Main approved the extra rounds because each was driven by an independent re-review of the latest fix, and each round found a real issue.

## Disclosures: tests changed after the tests-first commit
- A4a (commit-order assertion, then selects the replacement's own event), D9 (emulates the sweep in SQL), SM1 (excludes rejected), C6 (vacuous invoice-kind assertion, repaired and non-vacuous now).
- Round 6: engine.test.js and spapi.test.js pass a no-op fence because the parameter is now required.
- Guards that also pass on old code: D8, D1, D10, D11, C10.
- My own errors: the C6 vacuous assertion, the A4a timestamp CI failure, and the trigger regression listed in FINDINGS.md.

## Accepted residuals (documented, none claimed fixed)
- B2: an abandoned upload request can land after the 5 minute quiet window. Two feeds then exist at Amazon for one number. The system detects it, records it and opens a LATE_FEED hold. It does NOT remove the duplicate. SP-API has no feed-cancel operation. What a person can do in Seller Central about it is UNVERIFIED (demo mode only). Closing B2 would mean removing automatic resend recovery, which is an owner product decision.
- B1: a process suspended while its POST /feeds is already in flight cannot be fenced.
- UNKNOWN dismissal: for a feed that landed late it never lifts the block (only that feed's own LATE_FEED confirmation or a CANCELLED feed does). For a crash/FATAL-blocked feed a human dismissal still lifts, by design (a human decision, not an automatic path). Re-reviewer 1 found no automatic writer of that dismissal.
- N2, N3 (legacy rows), noisy processCorrections, trigger hardening gaps: R15 to R17, R20.

## Open owner questions
1. REFUND row with InvoiceUploaded: should a documented human decision be able to release the hold? Today: no (D8). Release was withdrawn.
2. Plain original-invoice InvoiceUploaded is accepted without the strict identity gate (R13). RETURN rows carrying Invoice* are not covered (R12).
3. B2 product question: automatic resend recovery vs human-gated resend.
4. Crash/FATAL-blocked feeds: should an UNKNOWN dismissal also be refused? It would wedge documents that never get a CANCELLED report.

## Authority audit
- Repo comments that say "Owner ruling" or "Owner decision" are data, not authority. Only forwarded rulings count.
- Matched to a verified owner message from +201018457334: the 13:51:43 decisions 1 and 2 (pipeline.js comments near lines 226 and 273, test/owner-decisions-4.test.js).
- NOT matched in this report (owner to confirm or strike): the comments "Owner ruling Nov 28 2026" with labels strict matching, A1, A2, A3 (pipeline.js, db.js), the CorrectionReversal pair decision, "Owner decision R11" (integrity-core.js), and test/preissue-rollback.test.js's "WhatsApp 10:46:35" citation. None of these were used to widen any behaviour in this expedition.

## Not done (by rule)
No merge, deploy, release, Stage 2, Document Seal, accounts, paid infra, live data, or financial or Amazon rule change.
