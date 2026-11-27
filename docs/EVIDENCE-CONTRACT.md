# InvoiceGuard Evidence Contract (draft v1, not yet implemented)

Purpose: define what InvoiceGuard may claim about each invoice stage, and from which evidence. Read-only analysis. No PDF issuance, no editing of invoice records. Not tax advice. Not "monitoring": nothing is watched while the browser is closed.

## 0. Rule that overrides everything

**A stage is never inferred.** A stage is shown as reached only when a named piece of evidence says so, and the evidence is displayed with it (source file, column, value, report date, document identifier). If the evidence is missing, incomplete or contradictory, the stage shows `NOT VISIBLE`, `UNKNOWN` or an exception state. It never shows a guess, and absence of a row is never read as success or as failure unless the source is proven complete (section 3).

## 1. Sources (first version)

| Id | Source | What it is | Known limit |
|---|---|---|---|
| V | VAT Invoice Data Report (VIDR), flat file | Amazon's per-shipment, return and refund tax data with an invoice status | Two versions exist (section 3). The file itself does not record which version it is, its date range or its download date. |
| O | Order Report (buyer tax columns on) | Order and buyer data | Has no invoice status. Cannot show Uploaded or Accepted. |
| A | Seller's invoice-system export | NOT in version 1 | Without it, Issued is never visible. |
| D | Declaration by the seller on the import screen | Report version, date range, download date, marketplace | A claim by the seller, labelled as such, stored with the import. It is not proof. |

Source for the version facts: Amazon SP-API report type values (`GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT`) and the VCS guide section 6.2.1: https://developer-docs.amazon/sp-api/docs/report-type-values-invoice-data , https://developer-docs.amazon/sp-api/docs/vcs-best-practices . The SP-API options are `pendingInvoices` (default) and `all`. The exact Seller Central screen wording for choosing them is UNVERIFIED (section 3.3).

## 2. Join key

Never join on order-id alone. A shipment line is identified by the tuple:
`marketplace-id + order-id + order-item-id + shipping-id + transaction-id + transaction-type`.
- Transaction types are kept apart: SHIPMENT, REFUND, RETURN, and correction transactions (transaction-id prefixed `Correction::` or `CorrectionReversal`). A refund never satisfies a shipment, and the reverse.
- Match levels: `EXACT` (all fields present and equal), `PARTIAL` (a field is missing in one source), `NONE`.
- Only EXACT joins feed a stage. PARTIAL gives `AMBIGUOUS`; NONE gives `UNMATCHED`. Two candidates for one key give `AMBIGUOUS`. No tie-breaking by amount, date or name.
- Order Report v1 has no shipping-id or transaction-id, so it can only be linked to V at `order-id + order-item-id + marketplace`. A link at that level is shown as PARTIAL and never feeds Uploaded or Accepted.

## 3. Report completeness

### 3.1 Why it matters
Pending-only VIDR (the default) lists only shipments whose invoice is still pending or was rejected. After a successful upload the order disappears from it. So **a pending-only VIDR can never show Accepted, and a missing row in it proves nothing.** Only the all-statuses version, over a stated date range (the API limits it to 30 days), can show shipments of every invoice status.

### 3.2 What every import records
`import_id`, `sha256 of the file` (hash computed locally), `file name`, `download date` (seller declared, defaults to today and is labelled), `report version declared` (ALL | PENDING_ONLY | DON'T KNOW), `date range declared` (from, to), `marketplace declared`, `columns found`, `row count`, `earliest and latest order-date / shipment-date seen in the file`, `parsed at`.
Import completeness class:
- `COMPLETE_SCOPE`: declared ALL, date range given, and every shipment/order date in the file falls inside that range. Scope applies only to shipments dated inside the range.
- `INCOMPLETE_SOURCE`: anything else (PENDING_ONLY, DON'T KNOW, no range, dates outside the range, required columns missing: `invoice-status`, `transaction-id`, `shipping-id`, `order-item-id`, `marketplace-id`).
An `INCOMPLETE_SOURCE` import can show what is in the file, but yields no Accepted and no "missing from Amazon" conclusion.
The file's own content can contradict a declaration (for example a declared ALL file that contains only InvoicePending rows). Then the import is `INCOMPLETE_SOURCE` with the contradiction shown. It is never upgraded by content.

### 3.3 What the page asks the seller to select
Wording for the UI (the SP-API option names are verified; the Seller Central menu path and labels are not, and the page says so until Seller 1 sends a redacted screenshot):
"Download the VAT Invoice Data Report with all invoice statuses for a date range of up to 30 days. Do not use the default pending-only report: it hides invoices Amazon already accepted, so we could not tell what was accepted. Then tell us the date range and the day you downloaded it."
The page never invents a Seller Central path.

## 4. Evidence per stage

For every stage the output carries: `state`, `evidence_source`, `evidence_field(s) and value(s)`, `evidence_date`, `document_identifier`, `as_of` (the import it came from), `explanation`.

### Expected
- Meaning: Amazon data says an invoice is due for this shipment line.
- Evidence: V row for the join key with `transaction-type` SHIPMENT (invoice due) or REFUND/RETURN (credit note due), `is-business-order` TRUE, `is-amazon-invoiced` FALSE, and an invoice-status other than `NoTaxCalculated`. NoTaxCalculated is shown as "no tax data from Amazon", not as Expected.
- Date: `shipment-date` (refund/return rows: the transaction date column if present, else NOT VISIBLE).
- Document identifier: none exists yet. Shown as the join key.
- Not evidence: Order Report alone. It gives an order, not a due invoice, so O-only lines show `ORDER SEEN, DUE-STATUS UNKNOWN`.

### Issued
- Meaning: the seller's own system created an invoice document.
- Evidence (v1): **none. Always `NOT VISIBLE in these files`.** Neither V nor O is the seller's accounting record. The VIDR column `invoice-number` is Amazon's echo of what the seller uploaded, so it is Uploaded evidence, not Issued evidence.
- Becomes visible only when source A (seller invoice export) exists: invoice number, issue date, buyer, total, tied to the join key. Until then `MISSING_IN_ACCOUNTING` cannot be produced either.

### Uploaded
- Meaning: Amazon holds an upload for this line.
- Evidence: V row, EXACT join, `invoice-status` in {InvoiceProcessing, InvoiceUploaded, InvoiceRejected, CreditNoteProcessing, CreditNoteUploaded, CreditNoteRejected} per the VCS guide status table (https://m.media-amazon.com/images/G/01/B2B/DeveloperGuide/vat_calculation_service__dev_guide_H383rf73k4hsu1TYRH139kk134yzs.pdf, section 6.1), and `invoice-number` if present.
- Date: the report's own date columns if present, else the download date as `seen at`, never as upload date.
- Document identifier: `invoice-number` column. If absent, `NOT VISIBLE`.
- Not evidence: absence of a pending row. In pending-only V that absence is ambiguous (accepted, or not due, or outside 90 days).

### Accepted
- Meaning: Amazon finished processing and found no error.
- Evidence: V row, EXACT join, `invoice-status` = InvoiceUploaded (or CreditNoteUploaded for credit notes), from an import with class `COMPLETE_SCOPE`, and the shipment date inside the declared range.
- Date: import `download date`. Shown as "state of the file loaded on <date>", never as the acceptance date.
- Document identifier: `invoice-number` plus transaction-id, verbatim.
- Never from: an upload screenshot, a pending-only file, a PARTIAL join, a row outside the range, or any later row that disagrees (a newer import with a different status replaces the state and the history keeps both).

## 5. Status vocabulary (engine output per line)

| Status | When (evidence needed) | Seller-facing explanation |
|---|---|---|
| MATCHED | EXACT join between two sources and fields agree (v1: V line and O line agree on buyer VAT, currency, totals) | "The two files agree on this shipment." |
| PENDING_AT_AMAZON | V EXACT, status InvoicePending or InvoiceProcessing | "Amazon is waiting for the invoice, or is still processing the one it received." |
| REJECTED | V EXACT, status InvoiceRejected or CreditNoteRejected, with the description column if present | "Amazon found an error in the upload and wants a new invoice for this shipment." |
| ACCEPTED | per the Accepted rule above | "In the file you loaded on <date>, Amazon showed this invoice as processed with no error." |
| INCOMPLETE_SOURCE | import class INCOMPLETE_SOURCE (or a required column is missing) | "This file cannot tell us what Amazon accepted. Download the all-statuses report for a date range (how: ...)." |
| UNMATCHED | NONE join in a source that should contain the line | "We found this line in one file and no matching line in the other." |
| AMBIGUOUS | PARTIAL join, or two candidates | "More than one line could match, or an identifier is missing. We did not guess." |
| MISSING_IN_VIDR | O line (an order) with no V line, only when V is COMPLETE_SCOPE and the order is inside the range and shipped | "The order is in your order report, but not in Amazon's invoice data for this period." |
| MISSING_IN_ACCOUNTING | needs source A, not producible in v1 | (reserved) "Amazon expects an invoice and your accounting export has none." |

Priority when more than one applies: INCOMPLETE_SOURCE and AMBIGUOUS and UNMATCHED stop the line from reaching a state. Evidence for Expected may still be shown. Every line also stores `reasons[]` with the evidence used.

## 6. Local storage (data stays on the seller's device)

- IndexedDB, per browser profile. Optional encryption: passphrase-derived key (PBKDF2 + AES-GCM, Web Crypto). The passphrase is never stored and cannot be recovered.
- Exportable Evidence Bundle (one JSON file plus the import hashes) containing: imports (metadata, hashes), per-line states with evidence, the contract version used.
- A clear "Delete everything on this device" command.
- Copy rule: this is "history on this device", never "monitoring". While the browser is closed nothing is watched, and the page says so.
- Honest limit: the browser can clear site data on its own (low disk, privacy settings, Safari's inactivity rule). The Evidence Bundle export is the durable copy.

## 7. Claim rules for all copy

- Fixtures in tests and demos are synthetic. Never "real files".
- Allowed: "analysed locally in your browser after the page has loaded; the test saw no network request during processing". Not allowed: "impossible for data to leave", "nothing is ever sent".
- "Amazon policy" for the one-business-day rule, never "the law". No promise of acceptance. No "never miss a deadline". VIES is off locally, and the page says why.

## 8. Open questions

1. Seller Central wording for choosing the all-statuses report is unverified. Needs Seller 1's redacted screenshot. Until then the page says "the report options named by Amazon's API" and shows the API names.
2. Which VIDR columns carry a refund/return date, and whether `invoice-number` is filled for Processing rows: not confirmed from docs. Rule above shows NOT VISIBLE when blank.
3. Whether the Order Report (Seller Central) carries shipping-id or order-item-id with the buyer tax columns: unconfirmed. If not, O can only be PARTIAL to V.
