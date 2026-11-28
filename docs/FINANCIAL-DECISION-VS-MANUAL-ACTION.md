# A fingerprinted financial decision is not a manual action with an audit trail

Two different things exist in InvoiceGuard. They must never be described as the same thing.

## 1. Fingerprinted financial human decision (HUMAN_DECISION)
What: a person releases a HOLD on an automatic path (for example the correction pair review, R11 negative amounts, a stuck claim release).
Properties:
- It is bound to a fingerprint of the exact evidence the person was shown (rows, amounts, original sha, other credits and claims, seller snapshot hash, VIES status, reason text).
- It records user, time, reason and fingerprint (`integrity_decisions`, `integrity_history`).
- If any of that evidence changes, the decision stops counting and a new decision is needed.
- It cannot release a BLOCK or a finding that needs new evidence.
- The system then acts on it by itself (issues the documents), still under the credit cap.

## 2. User-initiated manual action with an audit trail (for example /api/rectify, repair proposals)
What: the seller chooses to create a correction or credit themselves, or approves a repair proposal.
Properties:
- It is the seller's own act, recorded in the audit log (who, what, when).
- It is NOT bound to a fingerprint of reviewed evidence. Nobody confirmed that the data on the screen is the data that was issued except the seller's own look.
- It does not go through the pair review. A manual rectify stays "ready" and is not uploaded while ALLOW_MANUAL_UPLOAD is closed.
- It is still under the shared credit cap, VIES check and rule-pack window, which are checked at issue time.

## Rules for wording and code
- Never write "approved with evidence" or "reviewed" for a manual action. Write "issued by the seller".
- Never count a manual action as a HUMAN_DECISION in any metric, report or PR text.
- A manual action never releases a finding, and a decision never creates a manual action.
- If the owner later wants manual credit notes to need a fingerprinted decision too, that is a financial policy change and needs the owner's decision.
