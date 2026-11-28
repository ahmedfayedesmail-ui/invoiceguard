# Decision Card and Pencil Marks: UX flow and API contract (design, prototype only)

Status: design plus a static prototype (`prototype/decision-card/index.html`, synthetic data, no network). No production UI, route or data path is changed. Nothing here is part of Stage 1. It needs the owner's decision before any build.

## Who it is for
A seller who is not an accountant. They see plain words, amounts and documents. They never see codes, hashes, UTC times or the word "undefined". The words "tax advice", "certified", "valid", "filed" and "accepted" do not appear.

## Character: ink and pencil
InvoiceGuard already works like a ledger: documents are written in ink and cannot be changed, and a reserved credit is only a pencil mark until a document exists. The interface says exactly that, because it is how the system really behaves.
- Ink: a document that exists. Dashed border and "would be created": a document that does not exist yet.
- A yellow highlight marks only what changes, the way a proofreader would.
- A reservation is shown as a pencil mark. A person may review a reservation (pencil) and release it when the checks hold. A reservation that belongs to a document (ink) is never listed for release.
- Approving is signing: a short reason, the name, and a stamp "Decision signed". The stamp is shown only after the server accepted the decision.
This is a design language for InvoiceGuard, not a generic dashboard table.

## Flow 1: Decision Card (CORRECTION_PAIR_REVIEW)
1. List: one row per open pair review: buyer name, invoice number, "needs your decision".
2. Card: the question "Should this correction go ahead?", then three documents side by side (original in ink, credit note and new invoice dashed). Under them the sums: already credited, left to credit, what this correction credits.
3. Material difference since the card was first shown (seller data, VIES answer, reason text, any row) shows a warning box and the changed item highlighted. The old decision no longer counts; the card is new.
4. Decide: reason (at least 10 characters), "Approve this correction" or "Not now". Approve stays disabled until the reason is long enough.
5. Result: the stamp. Nothing is created in the browser. Creation happens in the next sync, as today.
Never offered: a button for a finding that needs new evidence (partial reversal, over balance, BLOCK). Those show "A corrected report from Amazon is needed" and no approve button.

## Flow 2: Pencil marks (stuck claims)
1. List: invoice number, reserved amount, age in words ("2 days ago"), and either "eligible for human review" or, in a separate "already in ink" section, a note that the document counts the amount.
2. Detail: four checks shown as a list, each with a plain sentence: no credit note exists for this event; no upload is waiting or in progress; reserved more than 15 minutes ago; nothing is running on it right now. Any failed check hides the release form completely.
3. Release: reason (10+ characters), button "Release reservation". After it, the old approval of the correction does not count and a new Decision Card is needed.

## API contract (proposal, JSON, authenticated seller session)
All amounts are strings with two decimals. All times are ISO with offset; the client formats them for the seller. Every response carries `fingerprint` where a decision is possible.
- `GET /api/reviews` -> `{ items: [{ key, kind: "correction_pair", buyer, invoiceNumber, status: "open", fingerprint }] }`
- `GET /api/reviews/:key` -> `{ key, fingerprint, original: {number, total, lines[]}, credit: {total, lines[]}, replacement: {total, lines[], changes[]}, sums: {alreadyCredited, creditableBalance, thisCredit}, warnings[], canDecide: bool, whyCannotDecide? }`
- `POST /api/reviews/:key/decision` body `{ fingerprint, reason }` -> `200 { decidedBy, decidedAt }`. Errors: `409 evidence_changed` (fingerprint no longer current: reload the card), `422 reason_too_short`, `422 needs_new_evidence`, `403` not the seller's session. The server records user, time, reason, fingerprint (existing `releaseIntegrity`).
- `GET /api/claims/stuck` -> `{ items: [{ key, invoiceNumber, amount, reservedAt, checks: [{id, text, ok}], eligibleForReview, fingerprint? }] }`
- `POST /api/claims/:key/release` body `{ fingerprint, reason }` -> `200` or `409 evidence_changed`, `409 document_exists`, `409 too_recent`, `422 reason_too_short`. Maps to `releaseStuckClaim` on branch `feat/stuck-claim-recovery`.
Security: the browser never sends amounts or document content as truth. It sends only the fingerprint it saw and a reason. The server recomputes everything inside one transaction. No endpoint accepts a document number to create. CSRF protection and the seller session follow the existing app routes.

## States and errors in seller words
- evidence changed: "This changed while you were looking. Please read the card again."
- document exists: "A credit note already exists, so this cannot be released."
- too recent: "This was reserved a moment ago and may still be in progress."
- offline or server error: "Nothing was saved." (never a stamp).

## Accessibility
Keyboard operable lists (Enter opens), labels tied to fields, colour is never the only signal (text labels on every status), contrast from the existing palette, the layout stacks to one column under 820 px.

## What the prototype proves and does not
It shows the flow, the wording and the look with synthetic data and checks the disabled/enabled rules in the page script. It does not prove usability with real sellers: that needs real users and is untested.

## Round 3 changes (owner review, Nov 28 2026)
- Amounts on every card are computed from the synthetic fixture rows (gen-data.mjs, data.js) and checked by data.check.test.js: lines plus VAT equal the total on every document, the credit note is the exact negative of the original, the new invoice repeats the amounts. The earlier "111.00 + 31.00 = 121.00" mismatch was hand-typed data and cannot recur.
- The card shows the sequence: credit note first, then Amazon confirms it accepted it, then the new invoice.
- All buyer data is compared field by field (name, VAT number, address, postal code, city, country), changed fields highlighted.
- Reserved amounts: reservations a person may review are separate from reservations that belong to a document ("in ink", not listed for release). Label: "Eligible for human review". Primary action: "Release reservation", with the note that it cancels the earlier approval and a new approval is needed.
- No financial rule, computed result or approval condition was changed.
