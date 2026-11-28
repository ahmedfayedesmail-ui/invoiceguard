# Usability review (self review, NOT independent; one browser test on synthetic data)

Question: can a person who is not a developer understand and act on a stopped item?

Before this expedition: no. HOLD and BLOCK findings existed only in the ledger and in tests (F-UX-1).

Now (Documents > Holds): an item shows a severity line, what happened in plain words, why, what the system knows, what it does not know, what is allowed, what stays blocked, the evidence, the next step, the decision history and the ledger history. A decision needs a reason of 10+ characters and is stored against the evidence fingerprint on screen. After the decision the screen says nothing was sent or changed automatically.

Verified: holds-ui.test.js drives it in headless Chrome (open item visible, BLOCK has no form, short reason refused, decision recorded with the signed-in user, closed items and history visible, hostile text in evidence is not rendered as HTML).

Not verified and open:
- No real person has used it. Wording was written by us. A test with a real seller is needed.
- The screen is in English only like the rest of the app. Spanish and German reviewers would need translation.
- No notification when a hold opens; the item is seen only when the Holds tab is opened.
- Evidence is shown as key and value lines. A side by side view of the report row and our document would be easier to compare.
- Mobile layout not reviewed.
- Only credit-note holds have specific wording; other holds show their stored explanation and a generic next step.

Honest assessment: the exception path is now usable end to end on synthetic data. The product is still a strong engine with a first usable reviewer screen, not a finished experience, and it has not met a real Amazon report.
