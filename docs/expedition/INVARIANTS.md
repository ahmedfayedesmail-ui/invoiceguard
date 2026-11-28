# Financial and identity invariants (what the code enforces today, and where)
Each line names the enforcing place and the test that would fail if it broke. "DB" = a SQLite trigger or constraint, so no code path can bypass it.
1. Unique, gapless document numbers per seller: allocateNumber inside the issuing transaction (src/db.js). Test: round9 N1/N3.
2. One correction document per Amazon event key: idempotency by recordKey in issueRectificativa (src/pipeline.js). Test: round8/9 suites.
3. A replacement invoice needs a credit note Amazon CONFIRMED (status uploaded from a later report), proven against identity: document number, transaction, marketplace, order, shipping, currency, amounts, original number, report sequence (src/cn-gate.js). Tests: credit-note-strict-match, credit-note-hold-guards (I1-I8).
4. An open credit-note hold blocks issuing and sending for the whole pair. DB: triggers cn_hold_blocks_issue and cn_hold_blocks_send. Tests H1-H7, A4a/A4b (two OS processes).
5. A human decision never covers different evidence: hold fingerprint over the evidence snapshot (src/cn-gate.js). Tests F1-F3.
6. An Amazon-confirmed document never changes status again. DB: trigger invoice_uploaded_is_terminal. Tests SM1-SM4. (new)
7. No Math.abs on amounts in the identity gate; sign or amount difference = HOLD. Tests S9c, I3.
8. Credit total of one original never exceeds the original (credit cap inside the issuing transaction). Tests: stage 1 suites.
9. A claim is released automatically only by the Definite Pre-Issue Failure Rollback (src/pipeline.js rollbackPreIssueClaim). Tests: stuck-claim branch, not in this branch's scope.
NOT enforced by the database (code only): invariants 1 to 3 and 8 live in code inside transactions. A SQL trigger for 3 would need the evidence tables; not done.
