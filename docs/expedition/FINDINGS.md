# Wave 1 findings (single operator agent, not independent). Severity: P0 unauthorized financial result, P1 product-breaking or unsafe gap, P2 weakness.
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| F-SM-1 | P1 | Nothing stopped an Amazon-confirmed document from being re-queued or re-sent | transition trace, docs/expedition/STATE-MACHINE.md | Fixed: DB trigger, tests SM1-SM4 |
| F-UX-1 | P1 | HOLD and BLOCK findings (correction pair review, credit-note holds) were written to the ledger but no HTTP route listed them or recorded the human decision; releaseIntegrity was called only from tests. A reviewer had no way in the app to see or decide what the system was holding | grep -rn releaseIntegrity src: definition only; no route in src/app.js | Fixed for listing and decision: /api/holds, /api/holds/decide, explanation fields. NOT done: a screen in public/index.html (API only) |
| F-SM-2 | open | Odd observed transitions not proven impossible | STATE-MACHINE.md | Needs Amazon evidence, owner decision |
| F-ID-1 | P2 | Seller identity is not part of the report identity check (seller-vat-number is not used as proof) | src/cn-gate.js header comment | Open, needs real report |
| F-LIM-1 | info | Real Amazon refund rows, column shapes and sign convention remain unseen | n/a | External dependency |
