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
