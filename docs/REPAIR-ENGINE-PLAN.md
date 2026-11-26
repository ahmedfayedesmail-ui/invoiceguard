# Repair Engine — staged plan

Mission (from product direction, Nov 26 2026): when a correction event happens
after an invoice is issued, InvoiceGuard repairs it end to end instead of
leaving the seller to do it by hand.

Honesty gates (standing):
- One business day = Amazon policy (VCS docs), never "the law".
- Correction uploads are excluded from Amazon's Invoice Defect Rate per
  Amazon docs. Sell corrections as legality / sanity / customer experience,
  never as IDR protection.
- No promise of Amazon acceptance. No tax advice.
- Review-first pilot: a human reviews every repair before upload, until
  per-marketplace validation says otherwise.

## Correction events (detection)
1. Return / refund after issuance (VIDR contains refund/return records).
2. Wrong buyer data (buyer name/address/VAT ID changed or corrected).
3. Amazon correction request (defect / re-upload request).
4. Seller-initiated correction (typo, wrong price) via manual entry.

## Stages

### Stage 1 — Detection + repair proposal (no upload)
- Parse VIDR for refund/return records that reference an issued invoice.
- Parse VIDR for changed buyer identity fields on already-invoiced orders.
- For each match, build a repair proposal: void the original, issue a
  chained rectificativa (corrective invoice) referencing the original
  number, with corrected data; re-validate buyer VAT ID on VIES when the
  VAT ID changed.
- Show proposals in the UI as a review queue with reasons, nothing leaves
  the system. Export pack marks repairs clearly (rectificativa chain in
  manifest.csv).
- Tests: fixtures with a return, a buyer-data change, and a no-op VIDR.

### Stage 2 — Upload closure (manual-export product)
- Generate the corrected upload file with strict TransactionId discipline
  (new IDs for the corrective documents, original IDs untouched).
- Read the Amazon processing report after the seller uploads; parse
  acceptance / rejection per record.
- On rejection: surface the Amazon error in plain English, allow
  fix-and-retry with a new TransactionId, keep the chain intact.
- End-to-end closure state per correction: detected -> proposed ->
  exported -> uploaded -> accepted (or failed with reason).

### Stage 3 — Adjacent engines (later)
- Deadline Sentinel: countdown per shipment scoped by verified
  marketplace/feed; Amazon policy wording.
- Compliance Memory: remember per-seller corrections, recurring failure
  modes, and marketplace quirks.

## Data model sketch
- correction_events: id, order_id, shipment_id, kind (return | buyer_data |
  amazon_request | manual), detected_at, source (vidr | manual), payload.
- repairs: id, correction_event_id, original_invoice_id, rectificativa_id,
  state (proposed | exported | uploaded | accepted | rejected | closed),
  amazon_report_ref, timestamps.
- Rectificativa numbering: separate sequence per seller, chained to the
  original invoice number (recorded in the PDF and manifest).

## Out of scope for now
- Automatic upload (no SP-API write in the pilot; seller uploads by hand).
- IDR claims in copy.
