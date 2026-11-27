# Audit: the 59 (V1 false-confident, scenario amazon_issued_invoices)

All counts local. Forensics only, no fix. V1 to V5 files untouched.

## 1. What the number is
59 findings = 59 distinct Amazon transactions (59 distinct issue keys), in 14 sellers.
Per seller: 21:3, 56:8, 91:0*, 126:6, 161:5, 196:7, 231:3, 266:0*, 301:5, 336:5, 371:5, 406:10, 441:0*, 476:2. (*sellers with scenario amazon_issued_invoices but no finding of this kind.) cases.json has 59 entries.
Family BOOKS_GAP / NUMBER_AT_AMAZON_NOT_IN_BOOKS, state ACTION_REQUIRED. V1 counted them in "FP confident 85" (59 + 11 + 11 + 4) because the harness truth said defects = 0.
They are findings counted per transaction. They are not shipments.

## 2. Where it came from
Engine c3baa5a (origin/sim-base-c3baa5a), harness efa0fc1 (sim/500-seller-stress), seed 0, 500 synthetic sellers. Rows fingerprint 9f268f4d7fc1 reproduced exactly. Command: `tools/audit-v1.sh <dir>` then `python3 tools/audit-v1-cases.py <dir> audit/false-confident-59 audit/duplicates-83`. Two independent runs gave byte-identical cases.json.

## 3. Cases
audit/false-confident-59/cases.json and cases.csv: Amazon transaction id, order id, shipping id, marketplace, invoice number at Amazon, per case.

## 4. Evidence and counter-evidence
- Engine evidence: invoice-status = InvoiceUploaded and the invoice number is not in the accounting file.
- Counter-evidence in the same row: is-amazon-invoiced = TRUE.
- Demonstrated: in all 59 the two fields of one row contradict. The file cannot say which is right, so a confident ACTION_REQUIRED was not supported by it.
- NOT demonstrated: that Amazon really issued the invoice. The harness says amzInv = true, but that is generator metadata, not file evidence. The 59 are "unsupported confident", proven by contradiction, not "proven wrong".

## 5. Causes (two, kept separate)
a) Engine: at c3baa5a src/loop/project.js line 73 the shipment filter uses invoice-status only (`d.state !== 'CREATED_BY_AMAZON'`). is-amazon-invoiced is never read in the loop engine, so a contradicting field was ignored.
b) Data: the V1 harness generated a self-contradicting file (TRUE with InvoiceUploaded). v2 changed it to TRUE with InvoiceCreatedByAmazon and a separate amazon_flag_status_conflict scenario. So the 59 partly measure a harness shape that a real Amazon report may never produce. Whether Amazon can produce it is unverified.

## 6. Counterfactual (not a fix)
Current engine (8665d52) on the same V1 files: 0 findings for these sellers. It reports "Amazon invoice flag could not be read (CONFLICT)" (80 notes across the 14 sellers, which is more than 59 because it also covers rows that gave no finding before). See audit/current-engine-on-v1-files.json. Caveat: a BLANK is-amazon-invoiced still falls back to invoice-status in src/loop/project.js lines 75-79. Not tested by this audit.

## 7. Addendum: is the 59 still emitted on 8665d52, and what locks it
Answer: NO. The current code (8665d52) emits none of the 59 as a confident ACTION_REQUIRED finding. This is a real fix, not an input artefact: the same V1 files, same rows.
- Removed by commit 970ded0 "ws1 fix: read is-amazon-invoiced from the field; field/status conflict and unreadable values are UNDETERMINED, never confident" (src/loop/project.js, plus public/local/loop-engine.js), note wording in 216d8e6. It reached 8665d52 through the merge e3b3bbf.
- What the current code does with those exact rows: TRUE field + InvoiceUploaded status = flag CONFLICT, shown as UNDETERMINED (family INVOICE_AMAZON_STATE) plus the coverage note "Amazon invoice flag could not be read (CONFLICT)". No seller action.
- Locked by test/ws1-confident-false.test.js, "CONFLICT: field TRUE but status InvoiceUploaded is undetermined, never confident" (plus 14 more ws1 tests). Failing-before check, local: that file run against 970ded0^ gives 12 of 15 failing; at 8665d52 all pass (with combined-regression: 29/29 local). Note: the exact V1 population (the 59) is not itself a committed regression test; the shape is. The 500-seller harness (V5) now has this as a different scenario (amazon_flag_status_conflict).

## 8. Live defect found in this area (not fixed): BLANK flag is inferred from invoice-status
src/loop/project.js lines 75-79: `f === 'BLANK' ? (byAmazon ? 'TRUE' : 'FALSE')`.
- Today, on input is-amazon-invoiced EMPTY + invoice-status InvoiceUploaded/Pending: read as FALSE, so it can become a confident seller finding (BOOKS_GAP ACTION_REQUIRED). On EMPTY + InvoiceCreatedByAmazon: read as TRUE, counted as Amazon-issued with no note.
- This is exactly the inference the rule forbids. It is deliberately kept and tested as intended: ws1 test "a blank flag falls back to the status" LOCKS the inference, so that test encodes the defect and would have to be changed with the fix.
- Failing tests written (spec, not in the suite): audit/tests/live-defects.test.js, DEFECT 1a and 1b. Local run: both fail on 8665d52.
- Not known: whether a real Amazon report ever leaves the field blank. Unverified.

## 9. Live defect found in this area (not fixed): the manual Order Report path hardcodes isAmazonInvoiced:false
src/manual.js line 76, in parseOrderReport. Correction to the earlier wording: when the uploaded file HAS an is-amazon-invoiced column it is detected as a VAT Invoice Data Report and the flag is read (src/vidr.js:37; verified locally: TRUE gives skipped "Amazon creates this invoice"). The hardcode applies to the Order Report format, which has no such column.
- Today: every business row of an Order Report is planned as "needs a seller invoice", isAmazonInvoiced=false, with no marker that Amazon's invoice status is unknown. So an order Amazon already invoiced is treated as the seller's to invoice. The same line also hardcodes isBusiness:true; that is a second inference of the same kind and is not covered by a test.
- Failing test written: DEFECT 2 in audit/tests/live-defects.test.js (unknown must not be represented as false). Fails on 8665d52 (local). The spec choice (what unknown should look like) is mine and is open to review.
