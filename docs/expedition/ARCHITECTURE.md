# Architecture of the credit-note and correction flow (as it is on this branch)
Plain Node 22, one SQLite file (node:sqlite), no framework. Written by the single operator agent from the code; no independent review yet.

## Modules and ownership of data
- src/vidr.js parses the Amazon VAT Invoice Data Report into shipments plus per-row metadata (rowMeta). Owns nothing in the database.
- src/pipeline.js is the engine: processReport (ingest), reconcileCreditNote / reconcileInvoice (verdicts), processCorrections (credit note then replacement), issueRectificativa (the one issuer), settleUnknownDocuments, pollFeeds.
- src/cn-gate.js is the identity check for a credit-note verdict and the hold writer. src/integrity.js is the ledger (integrity_findings, integrity_history, integrity_decisions).
- src/holds.js is the review queue and the human decision (new). src/repair.js holds reviewed retries for rejected or unknown uploads.
- src/db.js owns the schema and the database-level rules (triggers). Those are the only rules no code path can bypass.

## Where each safety rule lives
Code in a transaction: numbering, one-document-per-event, credit cap, replacement gate, identity check.
Database trigger: open credit-note hold blocks issue and send; an uploaded document is terminal; a release needs a recorded decision; history is append-only.
Not enforced anywhere but code: that a report really belongs to this seller (relies on the authenticated download).

## Flow
report -> parse -> per transaction: identity check (document number, transaction, marketplace, order, shipping, currency, amounts, original number, authenticated sequence) -> pass: apply status; fail: hold, no change -> credit note uploaded -> replacement eligible only then and only with no open hold -> every hold is listed with its explanation and needs a documented decision for exactly that evidence.

## Challenge to the architecture (what I would not change, and why)
- Moving rules into more triggers is cheap for single-row rules (done for two) but wrong for rules that need report evidence: those stay in code inside one BEGIN IMMEDIATE transaction.
- A formal state-machine library is not worth it: the observed transition set is small and now documented plus one enforced rule.
- Not examined in this expedition: the web app auth, PDF rendering, VIES, the Stage 2 / Document Seal designs.
