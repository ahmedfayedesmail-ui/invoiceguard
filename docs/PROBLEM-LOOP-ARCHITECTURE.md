# InvoiceGuard Problem Loop: audit, architecture, data model, phases (design v0.1, no code)

Status: proposal for review. Nothing in this document is implemented. The Evidence Engine and its contract (docs/EVIDENCE-CONTRACT.md v1.5) are not changed by it.

## 1. Goal and non-goals

Goal: a seller loads files. The system lists the problems those files show, says for each what it is, why it appeared, which rows prove it, what the seller or their accountant must do, and what evidence will show it is solved. Each problem is followed across later imports until evidence closes it.

Non-goals, fixed: no write into Amazon or an accounting system; no issuing of tax documents; no automatic sending of a seller's files to any service; no statement of legal position; no claim that a match means a document is correct for tax purposes. Where a file cannot support a conclusion the output says "cannot determine" and names what is missing.

## 2. Audit of what exists

| Component | Where | Verdict |
|---|---|---|
| TSV/CSV table reader (blank lines, ragged rows, 20,000-row cap) | src/manual.js parseTable | Reuse as is for tab-separated input. Needs a delimiter-detecting sibling for accounting CSV (new). |
| VIDR parser and 11-status map, status/type matrix | src/vidr.js, src/reconcile.js | Reuse unchanged. |
| Correction TransactionId classifier (allow-list, REVERSAL/CORRECTED) | src/txid.js | Reuse unchanged. |
| Per-document state, ACCEPTED gate, correction cycles, evidence log | src/reconcile.js reconcile() | Reuse unchanged. It is the source of every Amazon-side fact. |
| Import store: raw text, SHA-256, declarations, optional AES-GCM, IndexedDB adapter | src/history.js | Reuse. Extend with new record kinds (accounting import, review). Existing keys untouched. |
| Local page shell and bundle (network counter, no upload) | public/local, tools/build-local.mjs | Reuse the shell and the bundling. UI for the loop is new. |
| Order report parsing, buyer VAT hold reasons | src/manual.js parseOrderReport | Reusable as a supporting file source for matching data (phase 3). |
| Hosted app: shipments, invoices, counters, feeds, repair proposals, issuing | src/app.js, pipeline.js, repair.js, db.js | Not used. It is an issuing pipeline, gated sample-only in production. The loop is local-first and must not depend on it. Its known privacy gaps do not apply to local data. |
| Accounting file reading | none | New. |
| Matching between Amazon documents and accounting documents | none | New. |
| Problem identity, lifecycle, history, reviews | none | New. |
| Action cards | none | New (text built from templates, see 7). |

What the engine does not know today: anything about the seller's own documents. All its conclusions are about Amazon's report. The loop adds the second side.

## 3. Layers

```
files  ->  L1 source adapters  ->  L2 canonical records (derived, per import)
                                       |
 Evidence Engine (unchanged) -> Amazon facts
                                       v
                              L3 matcher + scope check  -> findings (derived)
                                       v
                              L4 problem projector      -> problems (derived)
                                       v
                              L5 card builder           -> cards
                                       v
                              L6 UI (reads L4/L5 only)
 stored: imports (immutable) + reviews (append-only). Nothing else.
```

Rule 1: only imports and reviews are stored. L2 to L5 are pure functions of them plus the engine version. Any cache is keyed by (hash of the import set, hash of the reviews, engine version) and may be deleted at any time without changing a result.

Rule 2: UI code calls one function, `project(imports, reviews) -> {problems, buckets, scopeNotes}`. It holds no state about problems.

## 4. Sources and adapters (L1)

Each adapter returns `{records, rejected, mapping, scope}`. A record keeps `{importId, row numbers, raw cells}` so every conclusion can point to rows.

1. Amazon VIDR: existing parser, existing engine.
2. Accounting export (the seller's issued invoices, credit notes and rectificativas): CSV or TSV, any column naming. New column detection (4.1).
3. Supporting files (order report, All Orders report): phase 3, used only to supply matching data that the first two lack (order id, buyer VAT).

### 4.1 Column detection
Target fields: document number, document kind (invoice, credit note, rectificativa), issue date, net, tax, gross, currency, tax rate, buyer name, buyer tax id, Amazon order id (reference), rectified document number, series.

Method: a header dictionary of exact normalized names (lowercase, accents and punctuation stripped; English, Spanish, German, French, Italian initially), plus content checks on a sample (dates parse, money parses, order id pattern `\d{3}-\d{7}-\d{7}`). A column is mapped only when the header matches AND the content check passes on every non-blank cell, or when the seller confirms it. Two columns that fit one field, or one column that fits two fields, is AMBIGUOUS_MAPPING. A required field with no mapped column is MISSING_FIELD. Both stop the import from producing findings; the page shows the detected mapping and asks the seller to confirm or fix it per column. A confirmed mapping is stored with the import as "declared by the seller".

Required to import at all: document number, issue date, gross (or net and tax), currency. The order id reference is optional but without it matching tiers 2 and 3 are unavailable and the output says so.

Rejected rather than guessed: unparseable dates, a date format that cannot be fixed (same rule as contract 2.2, with a declared order), money with mixed separators, a document kind that cannot be read, duplicate document numbers with different content, rows with the wrong cell count. Rejected rows are listed with row number and reason; an import with rejected rows is INCOMPLETE and cannot support "missing" conclusions.

## 5. Canonical model

All amounts are integer minor units plus an ISO currency. No floating point in any comparison.

```
Import        { id, kind: 'vidr'|'ledger'|'support', fileName, sha256, importedAt, text,
                declared: { createdAt, periodFrom, periodTo, marketplaces[], allStatuses,
                            dateOrderConfirmed, series[], mappingConfirmed } }
LedgerDoc     { importId, rowRefs[], number, kind, issueDate, net, tax, gross, currency, rate,
                orderId?, rectifies?, buyerTaxId?, series? }
AmazonDoc     { key (engine docKey), orderId, shippingId, marketplace, txType, txId, role,
                state (engine), invoiceNumber?, gross?, tax?, currency?, rowRefs[] }
Link          { amazonKey, ledgerNumber, tier (1|2), basis }       // derived
Finding       { type, subject, evidence[], determinate: bool, why, closureCondition }  // derived
Problem       { key, type, subject, state, history[], card }       // derived
Review        { id, problemKey, author, createdAt, kind, reasoning, basedOn: {importIds[], importShas[]} }  // stored
```

Reviews are the only human input. `author` is free text entered by the seller (a name or role of their choice; the product never requires personal data). A review is immutable. A correction is a new review.

Scope (what a file may conclude): the declared period, marketplaces, series and, for VIDR, the all-statuses declaration and non-truncation, as the engine already enforces. A finding of kind "absent from the other side" is determinate only when the OTHER side's scope covers the subject's date, marketplace and series, the other import has no rejected rows, and it is not truncated. Otherwise the finding is CANNOT_DETERMINE with the unmet scope condition named.

## 6. Matching (L3)

No fuzzy matching. Ladder, first hit wins, each link records its tier:
1. Document number equality after whitespace trim, only when the VIDR row carries an invoice number and the ledger has that number.
2. Amazon order id equality, when the ledger has an order id reference. If one order id maps to several ledger documents of the same kind, the link is ambiguous: CANNOT_DETERMINE (documents named). Credit notes and rectificativas link through `rectifies` or order id plus kind.
3. Nothing else. No match by amount, date or buyer.

After linking, field comparison (only on linked pairs): number (tier 2 only), gross, tax, net, currency, buyer tax id when both sides carry it. Equality in minor units, no tolerance. Each difference is its own finding, keyed by field name, never by the values.

## 7. Findings and problem types

Each type states its trigger, its scope condition, its action, and its closure condition. The closure condition is evidence, never a click.

| Type | Trigger | Closure condition (evidence required) |
|---|---|---|
| AMAZON_TX_NO_LEDGER_DOC | VIDR shipment (invoice required per engine) with no link, ledger scope covers it | A ledger import in which a link now exists. |
| LEDGER_DOC_NOT_IN_AMAZON | Ledger invoice with no link, VIDR scope covers its date and marketplace, all-statuses declared | A VIDR import showing the document as an engine state other than absent, or a review of kind NOT_AN_AMAZON_SALE with reasoning (for example a sale outside Amazon). |
| INVOICE_NOT_ACCEPTED | Engine state PENDING, SELLER_UPLOAD_REQUIRED, REJECTED, or processing observed | A later VIDR report in which the engine reaches ACCEPTED for that document. No review can close it. |
| CREDIT_NOTE_EXPECTED | Amazon REFUND or RETURN transaction for an order, no linked credit note in a ledger whose scope covers it | A ledger import with a linked credit note, then the engine's own acceptance of the reversal side where Amazon shows one. |
| CORRECTION_NOT_CLOSED | Engine correction cycle not ACCEPTED, or ledger credit note without a linked replacement invoice | Both sides present in ledger and accepted in a later report per the engine cycle. |
| MISMATCH_{NUMBER,GROSS,TAX,NET,CURRENCY,BUYER_TAX_ID} | Linked pair differs in that field | Imports in which the pair agrees in that field, or a review of kind DIFFERENCE_EXPLAINED with reasoning and the figures it covers. |
| CANNOT_DETERMINE_{SCOPE,AMBIGUOUS_LINK,MAPPING,INCOMPLETE_IMPORT} | A conclusion needs more than the files supply | The missing declaration or file arrives. |

Types that describe Amazon's state (INVOICE_NOT_ACCEPTED, CORRECTION_NOT_CLOSED) accept no review closure. A review can close only the types where the seller's documented explanation is the only possible evidence, and the review states what it covers.

Card content (all from templates, filled only with values from the evidence): what the problem is; why it appeared (the rule that fired and the values compared); the proof (import file name, row numbers, raw cells); the action for the seller or their accountant (a plain instruction, never a Seller Central path we have not verified); the evidence that will confirm it is solved (the closure condition in plain words); the history. Language rules: no word that claims legal status of a document or of the seller.

## 8. Problem identity (L4)

`key = sha256("v1|" + type + "|" + marketplace + "|" + subjectParts)` where subjectParts are normalized identifiers of the documents and transactions involved and nothing else:

- Amazon-side types: order id, shipping id, transaction type, and the engine's correction role if any.
- Ledger-side types: series and document number, document kind.
- Mismatch types: the Amazon-side parts plus the ledger document number plus the FIELD name.
- Credit-note and correction types: order id, shipping id, and for corrections the engine cycle key.

The key never contains a status, an amount, a date of detection, an import id or a row number. A problem therefore keeps its key when its values change, when the file is re-exported, or when rows move. Two problems of different type about the same order are different problems. Known limit, stated: if a seller renumbers a ledger document, a ledger-keyed problem gets a new key; the old key shows closed-by-absence only if a later import in scope no longer contains the old number, and that closure is labelled "no longer present", not "solved".

## 9. Lifecycle as a projection (L4)

Import order is the engine's effective-time order (contract 6); ties that the engine cannot order make the affected problems CANNOT_DETERMINE_INCOMPLETE_IMPORT.

For each problem key, replay the imports in order. After each prefix compute the findings. The problem's history is the sequence of (prefix, finding present, evidence rows, state). The current state is the state at the full set.

- OPEN: the finding is present in the current set and its card cannot yet name a complete action because the finding is CANNOT_DETERMINE (what is missing is the next step).
- ACTION_REQUIRED: the finding is present, determinate, and the card names the action.
- AWAITING_NEW_EVIDENCE: the finding is present, determinate, and a review of kind ACTION_TAKEN exists whose time is later than the latest import that shows the finding. The review records what the seller did; it does not close anything. The state ends when a newer import arrives: finding gone and closure condition met gives VERIFIED_CLOSED; finding still present gives ACTION_REQUIRED again with the review kept.
- VERIFIED_CLOSED: the closure condition of the type is met by evidence in the current set, or a closing review of an allowed kind exists and no later import contradicts it.
- REOPENED is not a stored state. It is shown when the history contains a VERIFIED_CLOSED prefix followed by a prefix where the finding is present again. The current state is then ACTION_REQUIRED or OPEN, the card shows both pieces of evidence and the earlier closure, and nothing is deleted.

Deleting a review or an import changes the projection and nothing else; there is no field to repair. A button writes a review or an import. No button writes a state.

Review precedence: a review applies to the evidence it was based on (`basedOn`). A later import whose evidence contradicts the review's claim ends its effect for that finding; the review stays in the history.

## 10. Experience (L6)

One page in the local app: drop files; the seller sees the detected columns and confirms them; then five groups, each count linked to its cards: Fine (linked and equal, count only, list on demand), Needs action now, Needs intervention (accountant), Cannot determine (with the missing item), Closed with evidence. Each card shows the fields in section 7. Import history list with a compare view: for two chosen imports, problems new, gone, unchanged, reopened. Reviews are entered on the card in a form with author, reasoning and kind; the card then shows the AWAITING or CLOSED result the projection produces, not what the form said.

Local-first: files are read in the browser, stored in the existing local history (optionally encrypted), and the existing network counter stays visible. Export: an evidence bundle that includes problems, histories and reviews, with the same wording limits as the current bundle.

## 11. Phases and boundaries

Each phase ends with runnable code, tests, failure scenarios, evidence of correct results, and a written statement of what was and was not done.

- P0 (this document): design only. Boundary: no code.
- P1, the vertical slice: ledger adapter for one CSV shape family with column detection and confirmation; canonical model; matching tiers 1 and 2; scope check; problem types AMAZON_TX_NO_LEDGER_DOC, LEDGER_DOC_NOT_IN_AMAZON, INVOICE_NOT_ACCEPTED, MISMATCH_GROSS, plus the CANNOT_DETERMINE types; stable keys; the lifecycle projection; reviews; the local page; tests. Boundary: no credit notes, no correction logic beyond what the engine already gives, no support files, no hosted route, no deploy of anything but the static local page (separate decision).
- P2: credit notes and rectificativas in the ledger; CREDIT_NOTE_EXPECTED; CORRECTION_NOT_CLOSED across ledger and engine cycles. Boundary: no new Amazon states.
- P3: remaining mismatch fields, support files for matching data, ambiguity handling. Boundary: still no fuzzy matching.
- P4: import comparison view polish, export of problem history, performance at the 20,000-row cap. Boundary: no connectors.
- Out of scope until separately approved: SP-API or accounting connectors, any hosted storage of seller files, any write path.

## 12. Tests required (named by class)

1. Determinism: same imports in any insertion order give the same projection; deleting every cache gives the same projection.
2. Identity: same problem across three imports keeps one key; changing amount or date or row order keeps the key; different type or different field gives a different key.
3. Closure derivation: a review of kind ACTION_TAKEN never produces VERIFIED_CLOSED; a closing review is refused for Amazon-state types; a closure followed by a contradicting import reopens with both evidence records kept.
4. Scope: no "missing" finding when the other side's declared range, all-statuses declaration or truncation state does not allow it (each condition separately).
5. Mapping: ambiguous header, missing required field, content check failure, each rejected with a named reason; nothing is guessed.
6. Matching: tier 1, tier 2, ambiguous tier 2, and "no match by amount or date even when they agree".
7. Language scan over every generated card for forbidden claims (legal status, accepted-on, never-miss, certified).
8. Structural: no state column or stored flag anywhere in the stored record kinds; the projection function is the only producer of a state.
9. Failure scenarios: truncated file, blank line in data, duplicate numbers with different content, mixed currencies, a ledger document for another marketplace, a review authored before the evidence it cites.

## 13. Decisions I ask the critic to settle before P1

D1. OPEN versus ACTION_REQUIRED as defined in 9 (OPEN = cannot yet name a complete action). Alternative: OPEN = first observed in the latest import, not yet reviewed.
D2. A closing review for LEDGER_DOC_NOT_IN_AMAZON: allowed kinds and wording.
D3. Whether tier 2 (order id reference) may link when the ledger has an order id but VIDR has no invoice number for the document yet (the usual case before upload).
D4. Whether gross equality should ever tolerate rounding (current design: none, with the difference shown).
D5. Ledger renumbering: accept the stated limit in section 8, or require a seller-declared renumber map as another review kind.
D6. Whether P1 may include a static page deploy for seller testing, or stays local-only until P2.
