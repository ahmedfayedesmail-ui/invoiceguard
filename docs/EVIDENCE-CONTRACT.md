# InvoiceGuard Evidence Contract v1.3 (normative; implemented in src/reconcile.js, src/txid.js, src/history.js)

This is the only normative text. The version in the first line is the exported constant `CONTRACT_VERSION` in src/reconcile.js; the evidence log and the bundle print the same label, and a test fails if the two ever differ. Earlier drafts (v1, v1.1, v1.2) are replaced by it, not amended; there are no "amendment" sections. Where code and this text disagree, that is a bug in one of them and the tests in test/reconcile.test.js are the arbiter.

Scope: read-only analysis of Amazon files. No PDF issuance, no editing of invoice records, nothing written to a seller's account. Not tax advice. Not "monitoring": while the browser is closed nothing is watched.

## 0. The rule that overrides everything
**A stage is never inferred.** A stage is shown as reached only when a named piece of evidence says so, and the evidence is displayed with it: source, column, value, report date, document identifier. If the evidence is missing, incomplete or contradictory, the output says `NOT VISIBLE`, `UNKNOWN` or names an exception state. A missing row is never read as success or as failure unless the source is proven complete (section 4), and in this version it is never read as either.

## 1. Sources
| Id | Source | Limit |
|---|---|---|
| V | VAT Invoice Data Report (VIDR), flat file, type `GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT` | The file does not record its version, period, creation time or download date. |
| O | Order Report with buyer tax columns | No invoice status. It can never show Uploaded or Accepted. |
| A | Seller's invoice-system export | NOT in this version. Without it Issued is never visible and MISSING_IN_ACCOUNTING cannot be produced. |
| D | Declaration by the seller on the import screen | A claim by the seller, labelled "declared by the seller, not verified by InvoiceGuard", stored with the import. Not proof. |

## 2. What every import records
`import id`, file name, `sha256 of the raw file` (computed on the device), row count, whether the file was **truncated** (the reader stops after 20,000 rows), earliest and latest order date seen, columns found, and the declaration D: report type, options (ALL / PENDING_ONLY / UNKNOWN), period from and to, marketplace, report creation time, download time, "created after the upload" confirmed yes/no, how the file was obtained. Three times are kept apart for every observation, each with its source: report creation time (declared by the seller), download time (declared by the seller), import time (recorded by InvoiceGuard).

## 3. Matching: the unit and the keys
- The unit is the Amazon document (a shipment, return or refund transaction): `marketplace-id + order-id + shipping-id + transaction-id + transaction-type`. Order id alone never joins anything.
- The item rows (`order-item-id`) of one document are kept as evidence and must agree on status and on invoice number. Different statuses, or two different non-blank numbers, give `UNMATCHED` (reason AMBIGUOUS) and block ACCEPTED.
- **Decision (invoice number): blank is a value.** If some rows of one document carry an invoice number and others are blank, the rows do not agree. The document is `INVOICE_NUMBER_INCOMPLETE`, never ACCEPTED, counted as cannot determine, with the reason shown. This is the conservative rule, adopted without a real file. What would change it: a real VIDR in which Amazon itself leaves the number blank on some rows of one document that is otherwise fully uploaded. Until such a file is seen, the rule stands.
- **No required value is dropped before it is checked.** Nothing is filtered, defaulted or skipped out of a required field between reading the file and the gate. A row with a blank or unreadable order date, a blank key field, a blank order-item-id or a blank invoice-status makes the whole import incomplete (below). A test scans for the pattern and blanks each required column in turn. A row with a blank key field cannot be tied to a document: it is counted on its own line (section 8) and is never counted as a document.
- Transaction types are kept apart: SHIPMENT, REFUND, RETURN. A refund never satisfies a shipment.
- **Correction ids: explicit allow-list (src/txid.js), split on `:`.** `CorrectionReversal:<X>:<id>` with type REFUND is the credit note side. `Correction::<X>:<id>` with type SHIPMENT is the corrected invoice side in the current format (four fields, the second is empty). `Correction:<X>:<id>` with type SHIPMENT is the same in the legacy format (three fields). Anything else that begins with "Correction", or has the wrong type, is `UNKNOWN_TRANSACTION_ID_FORMAT`: counted as cannot determine, never a correction and never an ordinary transaction (the live pipeline also refuses to issue for it). Lower-case `correction:` is not Amazon's word and stays ordinary. The id and type are kept verbatim.
- A correction cycle (same marketplace, order and shipping id; Amazon guide 6.3.4) needs both documents independently ACCEPTED. One accepted gives `PARTIALLY_ACCEPTED` on that side and the cycle is open. A missing side is named. Two documents of the same side in one cycle keep it open (no guessing which pairs with which). Source: https://m.media-amazon.com/images/G/01/B2B/DeveloperGuide/vat_calculation_service__dev_guide_H383rf73k4hsu1TYRH139kk134yzs.pdf section 6.3.4.

## 4. The ACCEPTED gate (one gate, no second route)
`ACCEPTED` is produced by exactly one function, `gateAccepted()`. Every other path from a status string stops short of it. The gate takes the import classification and the truncation flag as arguments. A document passes only if **all** of these hold, and each is stored with how it is known:

| Check | How it is known |
|---|---|
| the file was read in full (not truncated) | from the file |
| the import is complete: every import-level check below passed | from the file and the declarations |
| all-status report | declared by the seller. The file cannot prove it. |
| report type stored (`GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT`) | declared by the seller |
| period no longer than 30 days | checked on the declared dates only |
| **period covers the order date** (the one place the period rule is stated) | from the file: the row's `order-date` (UTC day) against the declared period. Amazon's all-statuses report covers shipments of orders placed within the period ("the report contains shipments for orders that were placed within the date range that you specify", https://developer-docs.amazon/sp-api/docs/report-type-values-invoice-data), so the order date is the right column. Shipment date is not used for the period. |
| marketplace matches the row | declared by the seller against the row |
| report created after the upload | declared by the seller only (the file has no creation time). Never shown as verified. |
| download time stored | declared by the seller |
| SHA-256 stored | computed on the device: the file is unchanged since import. It does not show where the file came from. |
| how the file was obtained stored | declared by the seller |
| document number present (`invoice-number`) | from the file |
| rows of the document agree | from the file |

Import-level checks (an import is `COMPLETE_SCOPE` only if none fails; otherwise `INCOMPLETE_SOURCE`, with a named code): required columns present (`marketplace-id, order-id, order-item-id, shipping-id, transaction-id, transaction-type, invoice-status, invoice-number, order-date`; code MISSING_COLUMNS); every row has a real calendar order date (a valid day, not a prefix pattern: 2026-02-31 is not a date; code MISSING_OR_INVALID_ORDER_DATE, document reasonCode the same); every row has a full key (ROWS_WITHOUT_KEY) and a non-blank order-item-id and invoice-status (MISSING_REQUIRED_VALUE); not truncated (TRUNCATED_FILE); options declared ALL (NOT_ALL_STATUSES); a period declared (NO_RANGE), valid (RANGE_INVALID) and at most 30 days (RANGE_TOO_LONG); no row with an order date outside the declared period (ROWS_OUTSIDE_RANGE). **One bad row makes the whole import incomplete**, so no document in it reaches ACCEPTED, including documents whose own rows are fine.
A document that fails the gate shows `INCOMPLETE_SOURCE`, the raw Amazon string, and the unmet checks by name. Only the ACCEPTED candidate rows (InvoiceUploaded, CreditNoteUploaded) go through the gate. Other statuses from an incomplete import are still shown as what the file says (for example PENDING), because they are not claims of acceptance.
No check is ever displayed as "verified" when it is declared.

### 4.1 Pending-only reports
Amazon's default report option is pending-only (`pendingInvoices`, the default) and it leaves out shipments whose invoice was uploaded successfully ("This report does not contain shipments for which invoices have already been uploaded successfully."). An all-statuses report needs the option `all` plus a period of at most 30 days. A pending-only report therefore cannot show ACCEPTED, and it equally rules out any "missing from Amazon's data" (MISSING_IN_VIDR style) conclusion: absence in a file that filters by design is not absence. Such a conclusion would only be possible from a COMPLETE_SCOPE import, for orders inside its period, and it is not produced in this version.

## 5. Status vocabulary
### 5.0 Our states
`ACCEPTED, PROCESSING, REJECTED, PENDING, PARTIALLY_ACCEPTED, UNMATCHED, INCOMPLETE_SOURCE`, plus `SELLER_UPLOAD_REQUIRED` (NoTaxCalculated; an obligation, counted as an exception), `CREATED_BY_AMAZON` (nothing to upload; strictly apart from every seller-upload state), `UNKNOWN_STATUS` (not one of the 11 strings), `INVOICE_NUMBER_INCOMPLETE` (section 3), `UNKNOWN_TRANSACTION_ID_FORMAT` (section 3) and `INCOMPATIBLE_STATUS_AND_TYPE` (section 5.2). A non-final state never promotes itself to ACCEPTED: only a later report that literally says Uploaded can, and only through the gate.

### 5.1 The 11 statuses (exact strings, no case folding, whitespace trimmed only)
Source of the table: Amazon SP-API "Create and upload invoices", status table, https://developer-docs.amazon/sp-api/docs/create-and-upload-invoices (rows `InvoicePending` to `InvoiceCreatedByAmazon`). The older VCS PDF guide (section 6.1) has 10 of them and does not list `CreditNoteCreatedByAmazon`.

| # | Amazon string (verbatim) | Amazon's action column (quoted) | Our state |
|---|---|---|---|
| 1 | InvoicePending | "The seller must upload an invoice for the shipment." | PENDING |
| 2 | InvoiceProcessing | "No action is required from the seller at this point. Amazon will process the invoice." | PROCESSING |
| 3 | InvoiceUploaded | "No action is required from the seller. Invoice successfully uploaded and is available to the customer on the Your Orders page." | ACCEPTED (only through the gate, section 4) |
| 4 | InvoiceRejected | "Seller must upload the invoice for this shipment again." | REJECTED |
| 5 | CreditNotePending | "Credit Note is now due for this transaction." | PENDING |
| 6 | CreditNoteProcessing | "No action is required from the seller at this point. Amazon will process the credit note." | PROCESSING |
| 7 | CreditNoteUploaded | "No action is required from the seller. Credit Note successfully uploaded and made available to the customer on the Your Orders page." | ACCEPTED (only through the gate, section 4) |
| 8 | CreditNoteRejected | "Seller must upload the Credit Note for this transaction again." | REJECTED |
| 9 | CreditNoteCreatedByAmazon | "Amazon created a credit note for this transaction." / "No action is required from the seller." | CREATED_BY_AMAZON |
| 10 | NoTaxCalculated | "Amazon will not calculate the VAT and the seller must upload the invoice for this transaction. The seller can upload the invoice in Seller Central or with SP-API." | SELLER_UPLOAD_REQUIRED |
| 11 | InvoiceCreatedByAmazon | "Amazon created an invoice for this transaction." / "No action is required from the seller." | CREATED_BY_AMAZON |

The line that establishes the NoTaxCalculated obligation is row 10 above, in Amazon's own words: "Amazon will not calculate the VAT and the seller must upload the invoice for this transaction." The older PDF guide says the same: "Amazon will not calculate the VAT and Seller will be responsible to upload the invoice for this transaction in Seller Central." So NoTaxCalculated drives Expected (an invoice is due), and while no later report shows an upload it is an exception in the headline, not a shrug. Only the two CreatedByAmazon statuses mean the seller owes no upload.

The raw string is stored and shown next to our label. A missing row never means accepted. No known status can be classified UNKNOWN_STATUS (tested for each of the 11).

### 5.2 Status family against transaction type (a matrix, tested cell by cell: 11 statuses by 4 types)
The Invoice* statuses belong with SHIPMENT. The CreditNote* statuses belong with REFUND or RETURN. NoTaxCalculated is not restricted by Amazon's table and is allowed with SHIPMENT, REFUND and RETURN. A transaction type that is not SHIPMENT, REFUND or RETURN fits no status. Any other pairing, for example REFUND + InvoiceUploaded, SHIPMENT + CreditNoteUploaded or RETURN + InvoiceUploaded, is refused as `INCOMPATIBLE_STATUS_AND_TYPE` with a plain explanation. It is never ACCEPTED and never quietly UNMATCHED, and it counts as cannot determine.

## 6. Order of reports and the current state
Reports are ordered by the seller-confirmed creation time, else the declared download time, else the import time; the basis is always shown. The current state comes from the latest report, whatever order the files were imported in. An older report goes to history only. A later report that shows a lower state wins and is flagged: "A later report shows <status> (<state>); we kept the earlier <status> in history. The later report decides the current state." Two reports with the same time and different statuses give UNMATCHED.

## 7. Stages, each from its own report
Every observation keeps its own snapshot of the matched rows. A stage reads only the snapshot of the report it cites, never a column from another report. If its own snapshot cannot support the stage, the stage says so.
- **Expected**: evidenced ONLY by a state that proves an upload or re-upload is owed: InvoicePending, CreditNotePending, InvoiceRejected, CreditNoteRejected and NoTaxCalculated. The first report showing one of them supplies is-business-order, is-amazon-invoiced, invoice-status and shipment-date from its own rows, and the obligation in words (waiting for the seller's upload; re-upload required; the seller must upload the invoice). PROCESSING is shown as `NO NEW UPLOAD REQUIRED`. ACCEPTED and INCOMPLETE_SOURCE are never evidence of Expected, whatever the underlying status was; with nothing else the stage is `NOT VISIBLE`. CREATED_BY_AMAZON is `NOT DUE`. Document id: the key.
- **Issued**: always `NOT VISIBLE in these files` in this version. `invoice-number` in the Amazon report is Amazon's record of an upload, so it is Uploaded evidence, not Issued evidence.
- **Uploaded**: the first report showing Processing, Uploaded or Rejected, with the invoice number printed in that same report (or `NOT VISIBLE in that report`).
- **Accepted**: only for ACCEPTED documents: the first report that showed the status with every check met, with its own number and transaction id verbatim.

### 7.1 Observed is not happened
`InvoiceUploaded` proves that Amazon showed the successful final state in the report we imported. It does not prove when the state changed. Each document records `firstObserved` and `acceptedObserved` with the three times of section 2. Display text: "Observed as InvoiceUploaded in the report dated X (date as declared by the seller)". The words "accepted on", "date accepted" and "accepted at" are never used without independent evidence of the event itself; a test scans for them.

## 8. Headline output
Per-document states use **documents** (rows with a full key) as the denominator. Rows with a blank key field are their own line and never enter it. `exceptions` counts distinct documents, so it can never exceed the document count (tested); one document can appear in more than one line of the breakdown. Exception lines: rejected; NoTaxCalculated with no upload shown; correction cycles not closed; cannot determine. The cannot-determine breakdown is part of the sentence, one number per cause: truncated (partly read) file, missing columns, other incomplete import, unmet check, missing or unreadable order date, invoice number blank on some rows, unmatched, unknown status, unknown correction id format, status that does not fit the transaction type. Also shown: in progress, observed as accepted, created by Amazon. The "in accounting with no acceptance" part needs source A and says so.

## 9. Evidence log for each ACCEPTED document
The imported report (id, name, SHA-256 and what that proves), how it was obtained (declared), the declared options, period, type and marketplace, the three times, the matched rows verbatim, the document number and transaction id verbatim, the status Amazon reported, the history across reports (with row counts), the first-accepted observation with its own snapshot, the checks with their basis, and "not verified automatically: all-status option, report created after the upload, how the file was obtained". Without ACCEPTED there is no log.

## 10. Local storage and copy rules
- IndexedDB per browser profile. Optional PBKDF2 + AES-GCM encryption (passphrase never stored, cannot be recovered). Exportable Evidence Bundle (raw text, hashes, declarations, per-document state, one log per ACCEPTED document). A "delete everything on this device" command. Copy says "history on this device", never "monitoring". Browsers can clear site data, so the export is the durable copy. Tested in real Chrome (test/history-idb.test.js).
- Wording: no compliant, filed, valid, issuance-ready, penalty, fine, "you are covered". Only the state of the loaded files, on the date they were loaded. Fixtures and demos are synthetic. Allowed privacy sentence: "analysed locally in your browser after this page has loaded; the test saw no network request during processing".
- Seller Central instruction: say what the report must contain (all invoice statuses, a period of up to 30 days) and ask for the period and the download day. The menu path is not invented; it is marked pending a seller's screenshot. The text shown to the seller: "Download the VAT Invoice Data Report with all invoice statuses for a period of up to 30 days. Do not use the default pending-only report: it hides invoices Amazon already accepted, so we could not tell what was accepted. Then tell us the period, the day the report was made and the day you downloaded it."

### 10.1 Plain-language text for a partly read file (reserved for the UI)
The 20,000-row cap is InvoiceGuard's own reader limit, not an Amazon figure. It stays; it is not raised. A file that reaches it is INCOMPLETE_SOURCE (TRUNCATED_FILE) and nothing in it is shown as accepted. The message must give a next step, in these words: "Only part of this file was read, so nothing in it can be shown as accepted. Split the download into shorter date ranges, never more than 30 days each, and load them one by one. Each file that is read in full gives a complete result."

## 12. Open questions
1. The Seller Central menu wording for choosing the all-statuses report: unverified, needs a seller's redacted screenshot.
2. Whether `invoice-number` is filled for Processing rows and which column dates a refund: not confirmed. The engine prints `NOT VISIBLE` when blank.
3. Whether the Order Report carries shipping-id or order-item-id with the buyer tax columns: unconfirmed. If not, O can only link to V loosely and never feeds Uploaded or Accepted.
4. Whether `NoTaxCalculated` can appear with REFUND or RETURN: Amazon's table does not restrict it, so it is allowed with all three.

## 11. Worked examples (synthetic data; all run as tests in test/reconcile.test.js)

### 11.1 Positive: one order, Expected, Uploaded, Accepted
Order 405-1111111-0000001, item 111, marketplace A1RKKUPIHCS9HS, shipping id and transaction id S9001, type SHIPMENT. Three all-statuses imports, each declared as type GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT, option ALL, range 2026-11-01 to 2026-11-30 (30 days), created after the upload (seller-confirmed), obtained from Seller Central (declared).

| Report (fixture) | Created (declared) | invoice-status (verbatim) | invoice-number | Our state |
|---|---|---|---|---|
| all-r1-pending.tsv | 2026-11-10 08:00Z | InvoicePending | blank | PENDING |
| all-r2-processing.tsv | 2026-11-12 08:00Z | InvoiceProcessing | A-2026-000123 | PROCESSING |
| all-r3-uploaded.tsv | 2026-11-14 08:00Z | InvoiceUploaded | A-2026-000123 | ACCEPTED |

Stages after all three are loaded:
- Expected: evidence from all-r1-pending.tsv: is-business-order TRUE, is-amazon-invoiced FALSE, invoice-status InvoicePending, shipment-date 2026-11-06T09:00:00Z, seen at 2026-11-10. Document id: the key above.
- Issued: NOT VISIBLE in these files (no seller invoice export is loaded).
- Uploaded: first shown by all-r2-processing.tsv: invoice-status InvoiceProcessing, document id A-2026-000123, seen at 2026-11-12 (the report time, not the upload time).
- Accepted: all-r3-uploaded.tsv, invoice-status InvoiceUploaded, document id A-2026-000123, transaction id S9001, "observed as InvoiceUploaded in the report dated 2026-11-14 (date as declared by the seller)", with the declarations shown as declared by the seller.
The evidence log carries the SHA-256 of all-r3-uploaded.tsv, the matched row, the checks of section 4 (all met; the declared ones are marked declared by the seller), and the history Pending, Processing, Uploaded. Loading only the second report gives PROCESSING. Loading the files in any order gives the same result.

### 11.2 Negative: a pending-only import
fixtures/recon/pending-only.tsv, declared as the default pending-only report (no range). It lists order 405-2222222-0000002 shipment S9102 as InvoiceRejected and order 405-5555555-0000005 shipment S9701 as InvoicePending. Order 405-1111111-0000001 is absent, because Amazon drops accepted orders from this version.
- Import class: INCOMPLETE_SOURCE. Reason shown: "Declared as the pending-only report: it leaves out invoices Amazon already accepted."
- S9102: REJECTED. S9701: PENDING. These are what the file says.
- Order 405-1111111-0000001: no row, and nothing is concluded from that.
- Accepted count: 0. If the same file had a row saying InvoiceUploaded, the document would show INCOMPLETE_SOURCE with the raw string InvoiceUploaded and the unmet precondition "all-status report".
Plain-language text on the page: "This file cannot tell us what Amazon accepted. It is the pending-only report, so invoices Amazon already accepted are not in it. Download the report with all invoice statuses for a date range of up to 30 days, and tell us the range and the day you downloaded it."
