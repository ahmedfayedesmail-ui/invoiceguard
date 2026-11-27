# Per-case audit of the confident findings on non-business orders (V2 engine = main 35bb98a, seed 0)
Source: `B2BDUMP=/tmp/b2b97.jsonl node sim/audit-b2b-dump.mjs 500 /tmp/x.jsonl 0` (a copy of sim/run.mjs plus one dump hook; run against main's project.js). Per finding: seller, finding id, family/subtype, order id, the is-business-order values, the raw VIDR rows. File: sim/out/audit-b2b-97.json.

Result: 85 confident (ACTION_REQUIRED) findings, 58 sellers, every one on an order whose is-business-order is FALSE in every row (so the engine judged a shipment that vidr.js needsInvoice() would not treat as needing a seller invoice).
By family/subtype: BOOKS_GAP NUMBER_AT_AMAZON_NOT_IN_BOOKS 49; INVOICE_AMAZON_STATE ACTION_REQUIRED 15; DATA_MISMATCH FIELDS_DIFFER 11; BOOKS_GAP NOT_IN_BOOKS 6; INVOICE_AMAZON_STATE REJECTED 4.
Root cause (code): src/loop/project.js built the owed set A from invoice-status and issuer only; is-business-order is read by src/vidr.js (isBusiness, needsInvoice) but never by the loop engine.
NOT DONE: the headline figure was 97, this file attributes 85. The other 12 are not attributed in this file (the sim's bucket "unscored non-B2B" matches by order id OR document number, so some are books-side findings); they are not explained yet. The 8 findings still in that bucket after the fix are not audited either.
