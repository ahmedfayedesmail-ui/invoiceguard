# Usable HOLD flow (seller experience)

Scope: a seller-experience change on top of the ruling-5 state model. No validation, one-shot authorization, evidence binding or financial state-machine rule was changed.

## What a seller sees in Holds (one inbox)
Each card has: what is held (document number, order, total when known), why in plain words, what resolves it and who can do it (You / Amazon evidence / No one), the matching form (if any), what stays blocked, and the residual risk. A summary row counts items waiting for you, waiting for new Amazon evidence, and not releasable.

- Every HOLD/BLOCK code has a plain title and at least one resolution (`HOLD_GUIDE` in `src/holds.js`; test HF1 scans `src/` for codes so a new code without guidance fails).
- Unknown upload outcomes (authorize one retry) and LATE_FEED items (confirm this feed) are shown in the same inbox with their existing forms. Repairs links to Holds.
- Notes: saved with author and time, shown as history, plain text only. A note never changes any state.
- An authorization is a seller's recorded decision, never an Amazon fact.

## Tests
`test/hold-flow.test.js` (10) and `test/hold-flow-ui.test.js` (real browser: see, read, note, act, new state; hostile text; no release form on REFUND/BLOCK; unknown-outcome form refuses invalid input, one-shot works).

## Limitations
English only (Spanish later). Not covered by a real-seller run. B2 is not closed. LATE_FEED form is exercised by API test, the browser test covers the authorize-retry form.
