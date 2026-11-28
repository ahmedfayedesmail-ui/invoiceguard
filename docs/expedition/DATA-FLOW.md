# Data flow (synthetic and real alike)

1. Seller report (Amazon order or VIDR report, uploaded by the seller, or fetched in a connected mode that is closed in the pilot).
2. parse (vidr.js): rows become shipments. Unknown flags or missing fields hold the shipment out.
3. Gates (rules.js, integrity.js, verify.js): each shipment ends as ready, held, or blocked. Uncertain data is a HOLD, never a guess and never an invoice.
4. Issue (invoice.js, pipeline.js): a numbered document is stored with its JSON and PDF. Numbers come from one allocator inside a transaction.
5. Upload state (invoices.upload_status): pending, ready, sending, submitted, processing, unknown, rejected, uploaded. The database refuses uploaded to anything but rejected (declared by the seller).
6. Later Amazon reports (reconcileInvoice, reconcileCreditNote): they only confirm or contradict. A contradiction opens a HOLD in the ledger and changes nothing else.
7. Ledger (integrity_findings, integrity_history, integrity_decisions): append-only decisions, each bound to the fingerprint of the evidence.
8. Reviewer (Documents > Holds, /api/holds, /api/holds/decide): a person sees what happened, the evidence, what is known and not known, what is allowed and blocked. A decision does not issue, send or release anything by itself; the next report is evaluated again.
9. Audit (appendAudit, events): hash-chained record of every state change.

Trust boundaries: report files and Amazon rows are untrusted data. Evidence is shown as text only. No personal data leaves the service. Seller scope applies to every query (seller_id).
