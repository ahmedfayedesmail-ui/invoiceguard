# RECONCILIATION-ARCHITECTURE (night mission WP4, Nov 27 2026)
Design only. No Stage 2, no production link, nothing here is built in PR #3. Anything about the real content of an Amazon document is an ASSUMPTION until a real, de-identified file confirms it (see docs/AMAZON-ASSUMPTIONS.md). Synthetic fixtures prove the logic, not Amazon.

## 1. The question the model must answer, per shipment
1. What was expected? 2. What happened? 3. What was invoiced? 4. What was accepted or rejected? 5. What amount is unexplained? 6. What evidence supports each answer? 7. What needs a human?
Each answer is a set of FACTS with provenance, never a computed verdict that hides its inputs.

## 2. Sources (each is an input contract)
| Source | Role | Trust level | Key it can offer |
|---|---|---|---|
| VAT Invoice Data Report (VIDR) | what Amazon says each shipment needs, with amounts and invoice status | seller-supplied file, authoritative about its own rows only | shipping-id / transaction-id, order-id, order-item-id |
| Order Report | order-level intent (items, prices, buyer type) | seller-supplied | order-id, order-item-id |
| All Orders Report | order lifecycle (status, cancel, ship dates) | seller-supplied | order-id, order-item-id |
| Issued invoices and credit notes (our own store) | what WE issued | our database, hash-chained audit | invoice number, shipment key, TransactionId |
| Invoice status and feed results (Amazon feed API or a later VIDR) | what Amazon accepted or rejected | accepted only from a LATER Amazon report or feed result with the document number and TransactionId verbatim | feed id, document number, TransactionId |
| Seller documents (own ledger, accountant export) | what the seller booked | declared by the seller, never verified | document number, date, amount |
| Seller declarations | context (declared VAT id, marketplace) | declared, never verified | none |
Rule 0 stays: nothing is inferred. A missing row never means accepted.

## 3. Entities and facts
- `Document`: (source, import hash, row range, parse version). Immutable. The import hash is of the bytes, so the same file twice is one document.
- `Fact`: (document, line, field, raw token, parsed value or UNKNOWN, parse state). UNKNOWN is a value. It is never zero and never dropped.
- `Link`: (fact A, fact B, relation, strength, rule id, explanation). Strength is PROVABLE or CANDIDATE or CONTRADICTED.
- `Finding`: the existing integrity ledger shape (seller, shipment, code, field) with severity BLOCK, HOLD, INFO, extended with `scope` (single document or cross-document). The key stays unchanged so the Stage 1 ledger and fingerprints are untouched.
- `Gap`: an amount that no link explains: (shipment, direction, cents, candidate explanations). Always shown, never netted away.

## 4. Provable and uncertain relationships
PROVABLE (an equality of identifiers that the document itself states, nothing else):
- VIDR row to VIDR shipment: same shipping-id and transaction-type (the key already used).
- Our invoice to a shipment: the invoice row stores the shipment key it was built from.
- Credit note to its original: the rectification record stores the original number.
- Feed result to document: the feed id we stored when we uploaded.
- Accepted status: only when a later report row names the document number and TransactionId verbatim (the existing gateAccepted()).
CANDIDATE (needs a rule and a human can disagree):
- Order Report / All Orders row to a VIDR shipment: equal order-id is provable for the ORDER, but which shipment a given item belongs to is not provable when an order has several shipments and the report has no shipment key. It is a candidate with the item id as evidence.
- Seller bookkeeping line to an invoice: same number is provable, same amount only suggests.
- A refund row to the invoice it reduces: order-id and item agree, the amount equals a part, but the refund may be a partial refund of two invoices.
CONTRADICTED (both sides state something that cannot both be true): shown with both facts, never resolved by picking one.
Never done: matching by amount alone, by date proximity alone, or by a name. Amount is a check on a link, never the link.

## 5. Contradiction classes across documents (each becomes a finding, none auto-resolves)
1. Same shipment, different totals in two reports of different dates (a corrected report, or a change after issuance). Result: HOLD before issue, ledger-only after issue.
2. Invoice issued but a later VIDR shows no invoice status for it (not accepted, not rejected): state stays "issued, no Amazon confirmation yet", never "accepted".
3. Credit note exists but the order report shows no refund, or the reverse.
4. VIDR currency or marketplace differs from the order report for the same order.
5. Two ordinary invoices for one shipment (should be impossible, kept as a detector).
6. Amazon status rejected for a document we show as accepted from an older report: the newer report wins by attempt sequence (the stale-row rule already in processReport).
7. Seller document number or amount differs from ours for the same invoice number.

## 6. The model computes, per shipment, a reconciliation row
`expected` (from VIDR facts, exact cents or UNKNOWN) | `invoiced` (sum of our documents, exact cents) | `credited` | `accepted` (only by the Rule 0 gate) | `rejected` (with Amazon's literal reason) | `unexplained = expected - invoiced + credited - ...` shown only when every input is known, otherwise the row says which inputs are UNKNOWN and the unexplained amount is UNKNOWN, not zero | `evidence` (list of Fact ids) | `needs_human` (list of findings with the question to the human).
All arithmetic is BigInt cents, like Stage 1. A currency mismatch inside one row makes the arithmetic UNKNOWN.

## 7. Human loop
A human may (a) confirm a CANDIDATE link, (b) record that a CONTRADICTION is explained, (c) declare a seller document. Each is a decision with user, time, reason, the fingerprint of the evidence it covers, in the append-only decisions table. A changed fingerprint reopens it. A decision never produces "accepted", and never changes a source document.

## 8. Failure modes and the answer to each
- Partial report (truncated): the gate already marks truncation; unexplained is UNKNOWN.
- Same file twice or overlapping periods: documents are keyed by content hash and rows by shipment key, so duplicates collapse, differences become contradictions.
- Reordered or late reports: ordering by attempt sequence and report request time, never by file name.
- Clock and time zones: dates only as ISO with a zone, as in Stage 1.
- Currency: only the supported list; others make the row UNKNOWN.
- Scale: rows are processed per shipment; a lab prototype (WP6) measures this.

## 9. What would have to be true in real data (ASSUMPTIONS to verify with the first real cycle)
That VIDR rows carry a stable shipping-id across reports; that the Order Report exposes order-item-id on every row; that a later VIDR states the invoice status per document; that credit notes appear with their own TransactionId. None is verified here.

## 10. Build order (proposal, needs Ahmed's go-ahead)
Stage 2 (seal) is a different feature and is not started. This design would be built after it, starting with read-only reconciliation rows for VIDR plus our own documents (all PROVABLE), then Order Report links as CANDIDATE.
