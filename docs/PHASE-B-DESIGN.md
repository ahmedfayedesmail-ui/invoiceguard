# Phase B design: Reconciliation and Invoice Integrity

Status: DESIGN FOR REVIEW. Stage 1 is the only stage being built until this document is reviewed. All counts anywhere in this branch are local unless a CI run is named. Synthetic data only. No external service.

## 0. Branch strategy (stacked)
- Branch: `feat/phase-b-reconciliation-integrity`, based on `7b9f8df` (head of `fix/blank-flag-unknown`, Phase A, PR #2).
- Phase B depends on PR #2 being merged first. A Phase B PR targets `fix/blank-flag-unknown`, not `main`, so its diff never repeats PR #2. When PR #2 merges, the Phase B PR is retargeted to `main` (the diff stays the same).
- Review the Phase B diff as `git diff 7b9f8df..HEAD`. PR #2, `main` and deployments are not touched. No merge.
- The GitHub token used here cannot create or edit pull requests (403), so the PR is opened by Ahmed with base `fix/blank-flag-unknown`.

## 1. What is wrong today (read from the code at 7b9f8df)
1. `num()` in `src/vidr.js` turns any unreadable amount into 0 and `parseFloat` accepts "12abc" as 12. A missing, an invalid and a real zero amount look the same.
2. A shipment takes its currency, buyer VAT, billing data, countries and dates from its FIRST row. Rows that disagree are not noticed.
3. Quantity blank or 0 becomes 1.
4. Nothing checks the amounts against each other, and a repeated item row is counted twice.
5. An issued invoice is not checked against its source again before export, and the PDF is not tied to the data.
6. Invoice amounts are summed with floating point and rounded after each step (`r2`).

## 2. Architecture and flow
```
VIDR text
  -> checkTsv (Phase A row integrity: invalid rows quarantined)
  -> parseVidr  (adds provenance: physical line and RAW tokens per row, nothing interpreted)
  -> assessShipment(s)            pure, no database: findings[]
  -> integrityGate(db, seller, s) ledger write + decision lookup
       no open finding   -> existing path (flags, VIES, rules, issue)
       open finding      -> shipment status 'held', reason in plain words, nothing issued, no number burned
  -> issue  -> (stage 2) seal -> pack/export verifies the seal first
```
Both the API and the manual upload end in `processReport`, so the gate sits there. The manual preview calls `assessShipment` too, so the seller sees the same holds before issuing.

Stages (each with tests before and after):
1. Numeric model, rule catalog R1 to R10, exception ledger tables, gate wiring, decision recording. (Being built.)
2. Document seal (data, source, PDF).
3. Exception and cycle API and the dashboard card.
4. The three known issues (corrected flag, loop reader versus VIDR reader, DATA_RECONCILIATION and the business flag) and report drift.
Nothing past stage 1 starts before review.

## 3. Numeric model (no floating point, no guessing)
Each amount token is parsed exactly to one of three states:
- MISSING: blank.
- INVALID: not a plain decimal, or ambiguous, or more than two decimals. Examples: `8,4x`, `N/A`, `5.0.0`, `=1+1`, full-width digits, `1,234` (one separator followed by three digits: thousands or decimals, not decidable), `8.405`.
- VALID: an exact integer number of cents (`BigInt`), including a real zero. `0.00` is VALID and is not the same as blank.
Rules for reading a token: optional sign, ASCII digits, at most one decimal separator (`.` or `,`) with 1 or 2 digits after it; if both `.` and `,` appear, the rightmost is the decimal separator and the other must group by exactly three digits. Nothing else is accepted. The rate column is parsed exactly as a decimal fraction (`0.21`); a rate above 1 is not compared, its unit is not provable.
Open assumption, stated and tested: all marketplaces in scope use two decimals (EUR, GBP, PLN, SEK). If a currency with another minor unit appears the amount is INVALID (more than two decimals) and held, never rounded.
The existing invoice builder still sums floats with `r2`. It only ever receives amounts the gate has proven valid with at most two decimals. Moving the builder to integer cents is listed in stage 2 (it changes the seal's canonical form).

What the checks assume about the source, and what they do not:
- Each part (item, shipping, gift-wrap, item-promo, shipping-promo, gift-promo) carries three amounts named incl, vat and excl. The check `incl = excl + vat` is applied PER PART, on the row, as the field names state it. It is NOT applied to the shipment total, because discounts, shipping and promotions are separate parts with their own rows of amounts. No claim is made about how Amazon rounds beyond that. The check allows a difference of 1 cent per part (2 cents when quantity is above 1 and the part is the item), which is an assumption and is disclosed in the finding.
- A difference is never "fixed". The finding says which numbers disagree and that nothing was guessed.

## 4. Rule catalog (stage 1)
Severity: BLOCK = the file contradicts itself, nothing is issued, no decision can change that, only a corrected file can. HOLD = not issued until the cause is removed. HOLD has a resolution: NEW_EVIDENCE (only a corrected or new file resolves it; a person cannot approve it) or HUMAN_DECISION (a person who can check outside evidence may release it with a recorded decision). Any check that cannot be decided from the file is HOLD, never BLOCK. A case missing essential evidence is never HUMAN_DECISION.

| Rule | Detects | Reason it matters | Severity | Resolution |
|---|---|---|---|---|
| R1 AMOUNT_UNREADABLE | an amount cell that is INVALID | an invoice cannot be built from a number we cannot read | HOLD | NEW_EVIDENCE |
| R2 AMOUNT_INCOMPLETE | a part with some of incl, vat, excl blank (the item part must always be complete) | the missing number would have to be guessed | HOLD | NEW_EVIDENCE |
| R3 AMOUNT_INCONSISTENT | incl differs from excl plus vat on one part (beyond 1 cent) | the row contradicts itself, which number is right is not decidable | HOLD | NEW_EVIDENCE |
| R4 AMOUNT_RATE_MISMATCH | vat differs from excl times the stated rate, rate between 0 and 1 | same, against the rate in the same row | HOLD | NEW_EVIDENCE |
| R5 QUANTITY_UNREADABLE | quantity not a whole number of one or more | the old code turned it into 1 | HOLD | NEW_EVIDENCE |
| R6 NONPOSITIVE_TOTAL | summed incl total of the shipment is zero or negative | not a normal invoice; a refund is a credit note, not a shipment invoice | HOLD | NEW_EVIDENCE |
| R7 DATE_UNREADABLE | a shipment date that is not a complete ISO date | the due time and the operation date depend on it; day and month order is never guessed | HOLD | NEW_EVIDENCE |
| R8 DATE_ORDER | order date later than shipment date | may be time zone noise, may be wrong data | HOLD | HUMAN_DECISION |
| R9 SHIPMENT_FIELD_CONFLICT | rows of one shipment give different values for currency, buyer VAT, billing name or address, countries, shipment date, seller VAT, marketplace, order id, company, registration type, invoice status | the old code silently kept the first row | BLOCK | none |
| R10a DUPLICATE_ITEM_ROW (same item id) | one non-blank order-item-id on two rows of a shipment | the same item may be counted twice, a person cannot tell from the file | HOLD | NEW_EVIDENCE |
| R10b DUPLICATE_ITEM_ROW (identical, no id) | two rows identical in every cell with a blank order-item-id | two identical units are legitimate, a double row is not; the seller can check the order | HOLD | HUMAN_DECISION |
| I1 SPLIT_SHIPMENT | one order with more than one shipment | information only, never merged, never held (no verified Amazon rule) | INFO | none |
Duplicate criterion, stated: the SKU alone is never a signal. Not flagged: the same SKU on two rows with different non-blank item ids (even with identical amounts), the same SKU with a blank id but different quantity or amounts, two different SKUs. Flagged only by R10a or R10b. The tests include these false-positive cases.

## 5. Exception ledger (data model)
`integrity_findings` (one row per seller, shipment key, code and field):
`seller_id, shipment_key, code, field, severity, resolution, status (OPEN, NOTED, RESOLVED, RELEASED), fingerprint, evidence (JSON), explanation, action, first_seen, last_seen, seen_count, reopened_count, resolved_at`
`integrity_decisions` (append-only history): `seller_id, shipment_key, code, field, fingerprint, decided_by, reason, decided_at`
`integrity_history` (append-only): `seller_id, shipment_key, code, field, event (OPENED, RECHECKED_SAME, CHANGED, RESOLVED, REOPENED, RELEASED), fingerprint, at`
- Idempotent and one history policy: a re-evaluation of the same data never inserts a second finding row. It updates `last_seen`, increments `seen_count` and writes ONE `RECHECKED_SAME` history row per evaluation, so every re-check is visible as its own event and `seen_count` equals the number of evaluations. `OPENED`, `CHANGED`, `RESOLVED`, `REOPENED` and `RELEASED` are written once per transition.
- Fingerprint = SHA-256 of the code, field, line numbers and the exact raw values (the raw value is hashed, never stored).
- A decision names the fingerprint. It covers exactly that evidence. If the data changes, the fingerprint changes, the finding is OPEN again and the old decision stays in history but no longer applies.
- Resolved then reappears: the row goes RESOLVED to OPEN, `reopened_count` is incremented, a REOPENED history row is written. A RELEASED decision is not revived by a reappearance with the same fingerprint after a RESOLVED in between: the person decides again.
- A decision needs a user (a seller account id), a reason of at least 10 characters, and a time, and is refused for BLOCK and for NEW_EVIDENCE.
- Sensitive data: evidence holds line numbers, field names, exact numbers and countries or currencies. Names, addresses and VAT numbers appear only as "value 1, value 2" placeholders. The test dumps the whole table and looks for them.
- Reprocessing is safe: a release does not issue anything by itself; the next processing of the file passes the gate and issues through the existing path, protected by the unique index on one invoice per shipment.

## 6. Document seal (stage 2, specified now)
What is sealed, three things: (1) the invoice data, serialized canonically (UTF-8, keys sorted, amounts as fixed two-decimal strings, no insignificant whitespace); (2) the source: SHA-256 of the exact source rows (physical line numbers and the row text) the invoice was built from, stored with the line numbers, not the rows; (3) the final PDF: SHA-256 of the PDF bytes. The PDF must be rendered deterministically (fixed metadata dates, no random identifier) so a re-render at export equals the sealed hash; if that cannot be made exact the PDF bytes are stored at issue time instead.
Mechanism: HMAC-SHA256 over (canonical data hash, source hash, PDF hash, previous seal of the same seller), keyed with a secret held OUTSIDE the database (the environment secret the app already needs), chained per seller like the existing audit log, and anchored by the existing audit-anchor tool.
Limits, stated plainly:
- A plain SHA-256 stored next to the data proves nothing against someone who can edit the database: they recompute both. That is why the seal is keyed and chained.
- With the database but without the key, an attacker cannot forge or re-chain a seal. With both, they can. A leaked key means all seals are suspect from the leak, so keys are versioned and the version is stored.
- It is not a legal time stamp and not a qualified signature. It proves "this is what this system issued", not that the source report was authentic.
- Export verifies the seal first. Any change to the data, the source link or the PDF blocks export of that document and raises a finding. Nothing is exported "anyway".

## 7. Failure modes
| Failure | Behaviour |
|---|---|
| File with a rule violation | shipment held, nothing issued, no number burned, other shipments in the file unaffected |
| Gate throws | the shipment is held with a "could not be checked" reason; it is never issued by default |
| Decision for old evidence | refused (fingerprint) |
| Two processes handle the same file | the unique index and the existing atomic claim stay the backstop; finding upserts are idempotent |
| Currency with other decimals | INVALID, held |
| Report lacks a column | not checked is reported as `notChecked`, never as a pass |

## 8. Threat model
Assets: invoice amounts, documents and the decision to issue. Adversaries: a seller or Amazon report with hostile or broken data (formula-like cells, HTML, huge values, unicode digits); an operator error; someone with database write access. Covered here: hostile cells are never evaluated or echoed; nothing is issued from uncertain data; decisions are bound to evidence and attributed. Seal (stage 2) covers database tampering as stated above. Not covered: a compromised application host with the key, a real Amazon account compromise, legal validity of the documents, the truth of the source report.

## 9. Migration strategy
New tables are created with `CREATE TABLE IF NOT EXISTS` in `openDb`; no existing table changes in stage 1. Existing shipments and invoices are not re-evaluated retroactively and nothing already issued is changed. The gate applies from the moment of deployment (no deployment is made from this branch). Rolling back means ignoring the tables.

## 10. Test strategy
Tests first, with the failing run committed as an artefact in `audit/phase-b/`, then the fix, then the post-fix run. Normal, edge and adversarial cases per rule. Real paths: `processReport` and `planUpload`, the same code the API runs. False-positive tests for the duplicate rule. Float traps for the arithmetic. Idempotency, re-open and decision-history tests. A TODO is never a pass; characterisation guards are labelled as guards. The full suite, the 1005-case campaign and V5 are re-run before every push; V5 must stay identical to the pinned fingerprint or every difference is documented.

## 11. Decisions after Ahmed's review of this document (Nov 27, 21:53). These override anything above that differs.
1. Currency. Two decimals only for the current VIDR currencies EUR, GBP, PLN and SEK (ISO 4217 minor units). It is a fixed list (`SUPPORTED_CURRENCIES`), not a general rule. Any other currency, or a blank one, is `CURRENCY_UNSUPPORTED`: HOLD, NEW_EVIDENCE, until its minor units are verified and the list is widened on purpose.
2. Dates. Accepted: `YYYY-MM-DD`, and an ISO date-time with an explicit time zone (`Z` or `+hh:mm`). Everything else (24/11/2026, 11/24/2026, a time without zone, 2026-02-30) is `DATE_UNREADABLE`: HOLD. No DMY or MDY parsing until a source-specific format is documented and tested. Amazon's VIDR column documentation does not state these formats, so none is assumed.
3. Amounts. `1,234` and `1.234` are both ambiguous (thousands separator or three decimals) and are INVALID, never read as 1234 or 1.234. No reading is accepted until the source format is known and proven.
4. Rounding. The tolerance (1 cent, 2 cents for an item line with quantity above 1) is an UNPROVEN HYPOTHESIS, not a verified fact about Amazon's rounding. It never passes silently: a difference inside it is recorded as the INFO finding `ROUNDING_DIFFERENCE` with the three amounts, the difference and the tolerance, and the text says the tolerance is unproven. It does not hold the shipment. Above the tolerance it is `AMOUNT_INCONSISTENT` (HOLD). Open: real files are needed to replace the hypothesis with evidence.
5. Transaction types. `NONPOSITIVE_TOTAL` applies to shipments only. VIDR also carries returns and refunds, whose amounts are legitimately negative. Any non-SHIPMENT type is `TRANSACTION_TYPE_UNSUPPORTED`: HOLD with resolution UNSUPPORTED_PATH (nothing releases it, because the credit note path is not built), and its amounts are not judged. Today the pipeline still skips non-shipments before the gate (existing behaviour, unchanged); the rule applies wherever the gate sees one.

## 12. Stage 1 review fixes (Nov 27, 22:16). These override anything above that differs.
1. Rounding visibility. INFO findings (`ROUNDING_DIFFERENCE`, `SPLIT_SHIPMENT`) are saved in the ledger with status NOTED (never OPEN, never blocking, resolved when the cause goes away) and are returned to the user: `notes` in the processReport result and in the manual preview. They do not hold the shipment.
2. Shipment date is REQUIRED. The due time and the invoice date are computed from it, so a blank cell is `DATE_MISSING` (HOLD, new evidence) and nothing is issued. The order date is not required for issuance and is reported as not checked when blank.
3. Human decisions are atomic. `releaseIntegrity` runs in one immediate transaction: validation, the decision row, a status update conditional on the finding still being OPEN with the exact fingerprint (and HUMAN_DECISION, not BLOCK), and the history row. Any failure rolls all of it back. A database trigger also refuses `RELEASED` on a finding that has no recorded decision for its fingerprint, so the state cannot exist by any other write.
4. Transaction types. REFUND, RETURN and other non-shipment rows are never issued as ordinary invoices. They are still skipped before the gate (existing behaviour), but they are no longer silent: `unsupported` in the processReport result and in the preview names each one with its type and the reason. The credit note path is outside Stage 1.
5. History policy: see section 5, every re-check is its own event.

## 13. Second review fixes (Nov 27, 22:26)
1. Multi-row findings. The ledger key is (seller, shipment, code, field). Rows of one shipment that share a code and a field are AGGREGATED into one finding before the ledger sees them: `evidence.lines` lists every physical line, and for ROUNDING_DIFFERENCE `evidence.rows` holds one entry per line with its own three amounts, difference and tolerance; the explanation names every line, so every note shows in the result and the preview. Aggregation already merged same-part rows in e199658 (no key collision happened); what was lost was every row's values after the first, which this fixes. A test asserts the key is unique over a shipment with 12 rows and every kind of finding.
2. Append-only is enforced by SQLite triggers: `integrity_decisions` and `integrity_history` refuse UPDATE and DELETE. The only way to change a recorded decision is a deliberate schema change (dropping the trigger), which is a visible migration and not something the application does. This is a governance guard against application bugs and accidental edits, not against someone with full database access, who can drop the trigger; the seal (stage 2, not started) addresses that threat.

## 14. Multi-row aggregation of every finding (Nov 27, 22:47, from the review of PR #3)
`add()` in integrity-core.js merged findings with the same code and field but kept the evidence and explanation of the first row only, so AMOUNT_INCONSISTENT, AMOUNT_RATE_MISMATCH and every other merged finding lost the other rows' amounts. Now every finding carries `evidence.rows`: one entry per physical line with its `lines`, its exact amounts or reason (decimal strings, never raw tokens, never personal values), and the stored and returned explanation names every line. The ledger key (code, field) is unchanged. ROUNDING_DIFFERENCE keeps its own aggregation with `evidence.rows[].line` (singular); that older shape is left as is. Tests go through processReport and the preview and assert every line in the ledger, the held reason and the preview, a re-run, and that no raw token reaches the ledger or the events.

## 15. One evidence entry per physical line, for every finding (night mission WP0, Nov 27 23:06)
`add()` now builds `evidence.rows` with exactly one entry per physical line, even when one call covers several lines. Shared evidence (given once) stays at the top of the finding; a per-line function supplies what belongs to one line: the value that line carries for SHIPMENT_FIELD_CONFLICT (a plain value for non-personal fields, "value n" or "(blank)" for personal ones), its own gross for NONPOSITIVE_TOTAL, its currency, its transaction type, and for duplicates the other lines it shares an item id or an identical row with (the raw item id is not stored). SPLIT_SHIPMENT, which bypasses add(), and ROUNDING_DIFFERENCE use the same shape (`lines: [n]` per entry; rounding also keeps its older `line`). The fingerprint is built from code, field, lines and raw values only, so it did not change and no ledger record was reopened by this change.

## 16. The correction replacement goes through the same gate (night mission WP1, Nov 27 23:12)
`processCorrections` builds the replacement invoice of a billing-data correction from the buyer name, VAT number and address of the correction row. If the rows of that correction contradicted each other, the first row was used (found by a probe, reproduced by test/issuance-paths.test.js). The replacement is now held by `integrityGate` before anything is issued, with the same ledger and the same BLOCK. Credit notes (reversals) are built from the stored original invoice, not from the report amounts, and are unchanged. The refund/repair path is outside Stage 1 and is listed in the risks document.

## 17. Precision limit (night mission WP2, Nov 27 23:16)
The gate reads exact cents, the invoice builder adds in floating point. The lab showed that a gross of 149382714704938.26 was issued and uploaded as 149382714704938.28. Any cell above 999,999,999.99 is now held as AMOUNT_OUT_OF_RANGE (HOLD/NEW_EVIDENCE). This is a precision limit, not a business rule. Known gap left for a decision: a negative item/shipping amount in a shipment with a positive total is consistent and still issued (proposal R11, a todo test).
