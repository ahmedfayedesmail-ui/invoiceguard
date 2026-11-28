# Decision Card and Pencil Marks: UX flow and API contract (design, prototype only)

Status: design plus a static prototype (`prototype/decision-card/index.html`, synthetic data, no network). No production UI, route or data path is changed. Nothing here is part of Stage 1. It needs the owner's decision before any build.

## Who it is for
A seller who is not an accountant. They see plain words, amounts and documents. They never see codes, hashes, UTC times or the word "undefined". The words "tax advice", "certified", "valid", "filed" and "accepted" do not appear.

## Character: ink and pencil
InvoiceGuard already works like a ledger: documents are written in ink and cannot be changed, and a reserved credit is only a pencil mark until a document exists. The interface says exactly that, because it is how the system really behaves.
- Ink: a document that exists. Dashed border and "would be created": a document that does not exist yet.
- A yellow highlight marks only what changes, the way a proofreader would.
- A reservation is shown as a pencil mark. A person may erase a pencil mark. Nobody can erase ink.
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
1. List: invoice number, reserved amount, age in words ("2 days ago"), and either "can be erased by you" or "has ink, cannot be erased".
2. Detail: four checks shown as a list, each with a plain sentence: no credit note exists for this event; no upload is waiting or in progress; reserved more than 15 minutes ago; nothing is running on it right now. Any failed check hides the erase form completely.
3. Erase: reason (10+ characters), button "Erase the pencil mark". After it, the old approval of the correction does not count and a new Decision Card is needed.

## API contract (proposal, JSON, authenticated seller session)
All amounts are strings with two decimals. All times are ISO with offset; the client formats them for the seller. Every response carries `fingerprint` where a decision is possible.
- `GET /api/reviews` -> `{ items: [{ key, kind: "correction_pair", buyer, invoiceNumber, status: "open", fingerprint }] }`
- `GET /api/reviews/:key` -> `{ key, fingerprint, original: {number, total, lines[]}, credit: {total, lines[]}, replacement: {total, lines[], changes[]}, sums: {alreadyCredited, creditableBalance, thisCredit}, warnings[], canDecide: bool, whyCannotDecide? }`
- `POST /api/reviews/:key/decision` body `{ fingerprint, reason }` -> `200 { decidedBy, decidedAt }`. Errors: `409 evidence_changed` (fingerprint no longer current: reload the card), `422 reason_too_short`, `422 needs_new_evidence`, `403` not the seller's session. The server records user, time, reason, fingerprint (existing `releaseIntegrity`).
- `GET /api/claims/stuck` -> `{ items: [{ key, invoiceNumber, amount, reservedAt, checks: [{id, text, ok}], canErase, fingerprint? }] }`
- `POST /api/claims/:key/erase` body `{ fingerprint, reason }` -> `200` or `409 evidence_changed`, `409 document_exists`, `409 too_recent`, `422 reason_too_short`. Maps to `releaseStuckClaim` on branch `feat/stuck-claim-recovery`.
Security: the browser never sends amounts or document content as truth. It sends only the fingerprint it saw and a reason. The server recomputes everything inside one transaction. No endpoint accepts a document number to create. CSRF protection and the seller session follow the existing app routes.

## States and errors in seller words
- evidence changed: "This changed while you were looking. Please read the card again."
- document exists: "A credit note already exists, so this cannot be erased."
- too recent: "This was reserved a moment ago and may still be in progress."
- offline or server error: "Nothing was saved." (never a stamp).

## Accessibility
Keyboard operable lists (Enter opens), labels tied to fields, colour is never the only signal (text labels on every status), contrast from the existing palette, the layout stacks to one column under 820 px.

## What the prototype proves and does not
It shows the flow, the wording and the look with synthetic data and checks the disabled/enabled rules in the page script. It does not prove usability with real sellers: that needs real users and is untested.
