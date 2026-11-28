# Document upload state machine (invoices.upload_status)

Source: traced on commit 8d9e6d9 by a temporary SQLite trigger across the full non-browser suite (864 tests, 863 pass, 1 todo, run local 2026-11-28). The trace code is not committed. Counts below are occurrences in that run, not production frequencies.

## States
pending (issued locally, not sent) | ready (manual pack) | sending (claim taken, call in flight) | submitted (Amazon feed created) | processing (Amazon says it is processing) | unknown (outcome of a send not known) | rejected | uploaded (Amazon-confirmed, from a later report).

## Observed transitions (invoice and credit note combined, nonzero only)
INSERT->pending 1083, INSERT->uploaded 21, INSERT->unknown 13, INSERT->submitted 1, INSERT->rejected 1, INSERT->NULL status 2.
pending->sending 1064, pending->ready 21, pending->rejected 1.
sending->submitted 1072, sending->unknown 23, sending->pending 9, sending->processing 3, sending->rejected 1.
submitted->processing 85, submitted->rejected 34, submitted->uploaded 30, submitted->unknown 6, submitted->sending 2.
processing->uploaded 9, processing->rejected 3, processing->unknown 1, processing->submitted 1, processing->processing 7.
unknown->sending 12, unknown->uploaded 1, unknown->submitted 1, unknown->processing 1.
rejected->sending 29, rejected->uploaded 2, rejected->submitted 1.
ready->uploaded 3.
uploaded->sending 2, uploaded->pending 1 (see finding F-SM-1).

## Findings
- F-SM-1 (P1 class, FIXED in this branch): nothing stopped an Amazon-confirmed document from going back to sending or pending. The three observed cases were all in tests that force the state to build a scenario (H4, H7, N4), so no production path was shown to do it. But the only protection was code discipline. Fix: trigger invoice_uploaded_is_terminal (src/db.js) aborts any change away from 'uploaded'. Tests SM1-SM4 (test/state-machine.test.js), including two connections to one file. The three tests that forced the state now drop the trigger explicitly in their setup (commented).
- F-SM-2 (open, owner/engineering review): transitions that look odd and were each observed: processing->submitted, rejected->submitted, unknown->submitted, submitted->sending, rejected->uploaded. They come from real paths (retry claim after a feed reset, a later report accepting a locally rejected document). I did not forbid them: no Amazon documentation read in this expedition says whether each is impossible, and forbidding a legitimate path would strand a real document. They are listed so a reviewer can decide with Amazon evidence.
- F-SM-3 (limitation): the table is observed, not proven complete. A path no test reaches is not in it.

Ruling 5: see EVIDENCE-BOUND-TRANSITIONS.md. No financial-document state change without proven meaning, identity, recency and outcome certainty; unknown upload outcomes are never resent automatically; B2 is not closed.
