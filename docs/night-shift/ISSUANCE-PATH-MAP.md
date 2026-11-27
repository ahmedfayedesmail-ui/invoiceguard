# ISSUANCE-PATH-MAP (night mission WP1, Nov 27 2026)
All statements are about the code at 2bfd48b on feat/phase-b-reconciliation-integrity. Counts are local. This is a map of what the code does, not a claim about real Amazon behaviour.

## 1. The only places that create a document number
`allocateNumber` is called in exactly two places (grep of src/):
1. `processReport`, series A, inside one IMMEDIATE transaction (`txImm`), after a re-check for an existing invoice of the shipment. The database also has a unique index `uniq_invoice_per_shipment (seller_id, shipment_key) WHERE kind='invoice'`.
2. `issueRectificativa`, series R (credit notes and replacements), unique index per correction event.
`buildInvoice` is also called once with the number 'PREVIEW' (missing-field check, nothing stored).

## 2. Paths that reach them
| Path | Entry | Gate before issuing | Result |
|---|---|---|---|
| Sync from Amazon report | `/api/sync` -> `processReport` | integrityGate (after the issued-status check, before any number) | held or issued once |
| Manual upload (closed by ALLOW_MANUAL_UPLOAD) | `/api/manual/issue` -> `planUpload` (assessShipment, held list) -> `processReport(shipments)` | planUpload assesses and processReport re-runs the gate | held or issued once. The flag is closed in production |
| Sample run | `sample.js` -> `processReport` | same gate | synthetic only |
| Retry / release buttons | `/api/retry`, `/api/release` | they only set status to detected. The next `processReport` re-runs the gate | an integrity hold comes back (test WP1 retry) |
| Convert to consumer invoice | `/api/b2c` | only for VAT-check holds, VAT>0 required. The gate still runs on the next evaluation | cannot skip integrity |
| Existing invoice reuse | inside `processReport` | the gate runs BEFORE the reuse check, so a new bad copy of a shipment that already has an invoice number is held and recorded, never re-issued | one invoice per shipment |
| Issued shipment seen again | `processReport` | status in submitted/processing/uploaded/ready/sending: ledger-only evaluation, skipped | never re-issued |
| Upload retry / pending uploads | `pollFeeds`, retry of `pending` | re-uploads the stored document, issues no number | no new document |
| Correction credit note (reversal) | `processCorrections` pass 1 -> `issueRectificativa` | built from the STORED original invoice with zeroed lines. Report amounts are not used | unchanged |
| Correction replacement | `processCorrections` pass 2 -> `issueRectificativa` | FOUND BYPASS, fixed in 2bfd48b: buyer name, VAT and address came from the correction row with no gate. Now `integrityGate` runs first | held when rows disagree |
| Manual rectificativa | `/api/rectify` (signed-in user) | edits applied to the stored invoice, no report data | human-initiated, outside the report gate by design |
| Refund repair proposals | `repair.js` -> `issueRectificativa` | human approval and an exact-cent cross-check against the original and the refund total | outside Stage 1 (refund path), see risks |
| Unknown-feed settle | `settleUnknownDocuments` / `unknownSettleCheck` | resends the SAME stored document after a feed-list cross-check | no new number |
| Restore from backup | `restore.js` | replaces the database file, issues nothing | n/a |

## 3. Ordering in processReport (per shipment)
parse -> stale-row check -> unknown-flag hold -> needsInvoice -> existing status check (issued: ledger only) -> detected event -> integrityGate -> notes -> buyer VAT / census checks -> missing fields -> dryRun return -> existing invoice reuse or allocate+insert (txImm) -> upload separately. The gate is before every state change that matters (number allocation, insert, upload).

## 4. Races
- Two evaluations of the same report at the same time: test `WP1: two evaluations ... create exactly what one evaluation creates` passes (same invoices and same uploads as one evaluation). Node runs the database calls synchronously, and number allocation plus insert are in one IMMEDIATE transaction with a unique index behind them.
- Ledger writes are not wrapped in one transaction with the issuing step. The ledger is evaluated before issuing in the same synchronous run, so another evaluation cannot interleave between them in one process. Two PROCESSES on one SQLite file would rely on the unique index only. Production runs one process. Listed as a residual risk.

## 5. Defect found by this audit
Correction replacement used the first row when the rows of the correction contradicted each other (fixed, test/issuance-paths.test.js, pre-fix artefact audit/phase-b/pre-fix-run-7-wp1-correction-gate.spec.txt). No other bypass of the integrity gate was found for report-driven invoice creation.

## 6. Not covered
Refund and credit-note creation from report amounts (repair path) is not Stage 1. External documents (`addExternalDoc`) record a document the seller already issued and issue nothing.
