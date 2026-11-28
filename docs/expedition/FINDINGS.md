# Wave 1 findings (single operator agent, not independent). Severity: P0 unauthorized financial result, P1 product-breaking or unsafe gap, P2 weakness.
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| F-SM-1 | P1 | Nothing stopped an Amazon-confirmed document from being re-queued or re-sent | transition trace, docs/expedition/STATE-MACHINE.md | Fixed: DB trigger, tests SM1-SM4 |
| F-UX-1 | P1 | HOLD and BLOCK findings (correction pair review, credit-note holds) were written to the ledger but no HTTP route listed them or recorded the human decision; releaseIntegrity was called only from tests. A reviewer had no way in the app to see or decide what the system was holding | grep -rn releaseIntegrity src: definition only; no route in src/app.js | Fixed for listing and decision: /api/holds, /api/holds/decide, explanation fields. NOT done: a screen in public/index.html (API only) |
| F-SM-2 | open | Odd observed transitions not proven impossible | STATE-MACHINE.md | Needs Amazon evidence, owner decision |
| F-ID-1 | P2 | Seller identity is not part of the report identity check (seller-vat-number is not used as proof) | src/cn-gate.js header comment | Open, needs real report |
| F-LIM-1 | info | Real Amazon refund rows, column shapes and sign convention remain unseen | n/a | External dependency |

## Wave 3 reviewer findings and remediation pass 1 (independent reviewers, target acc7c50)
- Reviewer 4 (agent-01M8GZ19P2CK7CENJ6H08W4338, state machine) F1 P1: Rejected verdict after Uploaded threw out of processReport. Fixed: reconcileInvoice opens an UPLOADED_THEN_REJECTED HOLD, never flips the status, never throws (test R2).
- Reviewer 4 F2 P1: /api/invoices/reject on an uploaded invoice failed with a generic 500 (manual mode lets the seller mark uploaded). Fixed: the trigger allows uploaded->rejected only (the seller's declaration); every other way back stays blocked (test R1). Product note: in manual mode "uploaded" is a seller declaration, not Amazon confirmation.
- Reviewer 4 F3 P2: status writes in upload catch paths had no uploaded guard. Fixed: `AND upload_status<>'uploaded'` on all unknown/pending/rejected writes in pipeline.js.
- Reviewer 4 doc gaps (undocumented sending->uploaded via reconcile; boot migration submitted->ready for feed_id 'manual'): to be added to STATE-MACHINE.md.
- Reviewer 3 (agent-01M8GZ18JQCN170ENVWW3SE4CZ, holds API) no P0/P1. P2-1 fingerprint omits why text/extra evidence (stale detail), P2-2 explainFinding wording is report-specific and nothing consumes RELEASED for shipment HOLDs, P3-1 writeLedger resolves other OPEN findings on same key, P3-2 listHolds LIMIT 200: pass 2.
