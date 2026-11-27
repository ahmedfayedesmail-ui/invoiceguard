# InvoiceGuard Problem Loop: audit, architecture, data model, phases (design v0.2, no code)

Status: proposal for review, merged with the critic's independent design. Nothing here is implemented. The Evidence Engine and docs/EVIDENCE-CONTRACT.md v1.5 are not changed by it.

## 0. What changed from v0.1, and where this document disagrees with the critic

Adopted from the critic (changes to v0.1):
- A1. Issue types become 8 issue families (section 7), keyed by closure condition and subject, so a change of sub-type does not create a new problem. v0.1 keyed by type and by field.
- A2. Identity key follows his issue_family formula, with a temporary identity for documents without a reliable identifier (section 8).
- A3. State machine: OPEN is "exception proven, no safe action yet"; "cannot determine" leaves the lifecycle and becomes a coverage note (section 9). v0.1 put cannot-determine inside OPEN.
- A4. Fifth outcome MANUALLY_REPORTED_RESOLUTION (section 9.2). v0.1 let a closing review produce VERIFIED_CLOSED. That is withdrawn: a review can never produce VERIFIED_CLOSED.
- A5. PROCESSING is not an exception (v0.1 listed it under INVOICE_NOT_ACCEPTED). It is shown as "in progress, no action" with no card.
- A6. An order-id match is a proposed link, not a confirmed link (section 6). v0.1 linked on order id alone.
- A7. Mapping profiles: versioned, saved, previewed, confirmed; FinancialDocument, DocumentLine, AmazonTransaction, DocumentLink entities (section 5).
- A8. Mismatch is one issue per linked pair with a field list, not one issue per field (v0.1 keyed by field).
- A9. First slice is his loop on ordinary invoices only (section 11). Credit notes and correction pairs after it.
- A10. Boundary against src/repair.js and src/pipeline.js stated as a rule with a test (section 2.1).
- A11. His six success criteria become the acceptance criteria of each phase (section 12).

Disagreements, kept visible:
- X1. Storage. He lists issues, issue_evidence, issue_episodes, documents, document_links as tables. I keep as stored truth only: imports, raw and normalized records tagged by parser version, mapping profiles, and seller events. Documents, auto links, issues, episodes and evidence are derived and may be cached, because a stored issue row is a second copy of a conclusion and can disagree with the files. Reason in section 3.
- X2. Human review as closure. His UNMATCHED_DOCUMENT closure allows "a documented human review with supporting evidence". I allow a review to move the problem only to MANUALLY_REPORTED_RESOLUTION. Supporting evidence counts toward VERIFIED_CLOSED only when it is a file the engine reads and a closure predicate evaluates. Reason in section 9.2.
- X3. Ledger-side absence. His 12 types have no type for "a document in the books that Amazon does not show", which Ahmed listed. I keep it, as a sub-type of UNMATCHED_DOCUMENT (no candidate), not as a separate family.
- X4. Slice scope. I add SOURCE_INCOMPLETE and UNMATCHED_DOCUMENT to his first slice. Without them the slice would state absence from partial files.
- X5. Seller identity in the key. He includes seller_id. A local-first store has no account. Section 8 proposes a local profile id and states the limit.

## 1. Goal and non-goals

Goal: a seller loads files. The system lists the problems those files show, says for each what it is, why it appeared, which rows prove it, what the seller or their accountant must do, and what evidence will show it is solved. Each problem is followed across later imports until evidence closes it.

Non-goals, fixed: no write into Amazon or an accounting system; no issuing of tax documents; no automatic sending of a seller's files to any service; no statement of legal position; no claim that a match means a document is correct for tax purposes. Where files cannot support a conclusion the output says "cannot determine" and names what is missing. Nothing is created as a problem merely because a file is incomplete.

## 2. Audit of what exists

| Component | Where | Verdict |
|---|---|---|
| TSV table reader (blank lines, ragged rows, 20,000-row cap) | src/manual.js parseTable | Reuse. A delimiter-detecting sibling for accounting CSV is new. |
| VIDR parser, 11-status map, status/type matrix | src/vidr.js, src/reconcile.js | Reuse unchanged. |
| Correction TransactionId classifier | src/txid.js | Reuse unchanged. |
| Per-document state, ACCEPTED gate, correction cycles, evidence log | src/reconcile.js | Reuse unchanged. Source of every Amazon-side fact. |
| Import store: raw text, SHA-256, declarations, optional AES-GCM, adapters | src/history.js | Reuse. Add record kinds. Existing keys untouched. |
| Local page shell and bundle with network counter | public/local, tools/build-local.mjs | Reuse the shell. Loop UI is new. |
| Order report parsing | src/manual.js parseOrderReport | Reusable later as a supporting source. |
| Hosted issuing and repair path | src/repair.js, src/pipeline.js, src/app.js, src/db.js | Not used. See 2.1. |
| Accounting file reading, matching, issue identity, lifecycle, seller events, cards | none | New. |

The engine today only knows Amazon's report. The loop adds the seller's own documents as the second side.

### 2.1 Boundary: repair.js and pipeline.js
repair.js and pipeline.js keep stored, editable states (invoices.upload_status, repair proposals, counters). They are an issuing path. The loop never reads them, never writes them, never imports them, and does not use a stored state as evidence. A migration of anything from that path into the loop needs its own design document and its own approval. Enforced by a structural test: no module of the loop imports src/repair.js, src/pipeline.js, src/db.js or src/app.js, and a scan finds no stored `state`, `status` or `closed` field in any loop record kind.

## 3. Layers and what is stored

```
files -> L1 source adapters + mapping profile -> L2 normalized records / FinancialDocuments (derived)
Evidence Engine (unchanged) -> AmazonTransactions
                                  -> L3 matcher + coverage check -> findings (derived)
                                  -> L4 issue projector          -> issues, episodes (derived)
                                  -> L5 card builder             -> cards
                                  -> L6 UI (reads L4/L5 only)
```

Stored, append-only, never rewritten:
1. SourceImport: raw text, sha256, parser version, mapping profile id and version, declared coverage, date and decimal declarations.
2. SourceRecord: per row raw cells, normalized values tagged with the parser version that produced them, validation errors. A new parser version appends new normalized values; the raw row and earlier normalization stay.
3. MappingProfile: versioned, with the seller's confirmations.
4. SellerEvent: ACTION_STARTED, RESOLUTION_DECLARED, LINK_DECISION, DIFFERENCE_EXPLAINED, IDENTITY_ALIAS. Each has author (free text chosen by the seller), time, issue key or link reference, reasoning, and the evidence it was based on (import ids, sha256, row hashes).

Derived, never the source of truth: FinancialDocument, DocumentLine, AmazonTransaction view, automatic DocumentLink, findings, issues, episodes, evidence lists, current state. A cache of these is allowed only keyed by (set hash of imports, set hash of events, engine version, parser version) and a test requires cache rebuild to equal fresh computation. Reason for X1: the first time a stored issue row says closed and a new import says otherwise, the product contradicts its own files. A derived value cannot.

The local store is the existing key-value adapter (IndexedDB or memory). Table names in the critic's proposal are logical record kinds here. No hosted database holds seller files.

## 4. Sources and adapters (L1)

Each adapter returns `{records, rejected, mapping, coverage}`. Every record keeps import id, row numbers and raw cells.

1. Amazon VIDR: existing parser and engine.
2. Accounting export (invoices first; credit notes and rectificativas later): CSV or TSV, any column naming.
3. Supporting files (order report, All Orders report): later phase.

### 4.1 Mapping profiles and column detection
Target fields: document kind, document number or stable source id, series, issue date, operation date, currency, net, vat, gross, rate, issuer tax id, buyer tax id, buyer name, Amazon order id reference, original document reference.

Method: header dictionary of exact normalized names (lowercase, accents and punctuation stripped; English, Spanish, German, French, Italian first) plus content checks on the cells. A column is mapped only when header and content agree on every non-blank cell, or when the seller confirms it. Two columns for one field, one column for two fields, or an unknown column with no confirmation is AMBIGUOUS_MAPPING. A required field with no column is MISSING_FIELD. The page shows a preview of detected columns, the seller confirms or fixes each, and the result is saved as a versioned MappingProfile reused for later files with the same header set (a changed header set is a new profile and asks again).

Values: amounts become integer minor units; the decimal separator, thousands separator and date order are read from the profile's declaration, never guessed globally; a value that cannot be read under the declaration is rejected with row, column and reason. A document is never classified as a credit note because its amount is negative; kind comes from a mapped kind column or the seller's confirmation.

Required for an accounting invoice to be importable: kind, number or stable source id, issue date, currency. For financial comparison: gross, or net and vat. For automatic matching: seller identity and a linking reference. Without the reference the document imports and appears as UNMATCHED_DOCUMENT candidate-free, never silently dropped.

## 5. Canonical model

```
SourceImport      { id, sellerProfileId, sourceType, sourceSystem, fileName, sha256, importedAt, parserVersion,
                    mappingProfileId, mappingVersion, declared: { coverage, completeness, dateOrder, decimal } }
SourceRecord      { importId, row, raw, normalized{parserVersion}, errors[] }
FinancialDocument { kind, number, series, issueDate, operationDate, currency, net, vat, gross,
                    issuerTaxId, buyerTaxId, originalRef, orderRef, sourceRecord }   // derived
DocumentLine      { sku, asin, description, qty, amounts, rate }                      // later phase (partial refunds)
AmazonTransaction { marketplace, txType, txId (verbatim), orderId, shippingId, role, engineState, rows }  // derived
DocumentLink      { document, transaction, level: PROPOSED|CONFIRMED, method, evidenceRefs[], decidedBy? } // derived, or from SellerEvent
Finding           { family, subtype, subject, evidence[], safeAction?, closurePredicate }   // derived
Issue             { key, family, subject, episodes[], state, outcome }                      // derived
```

Coverage (what a source may conclude): declared period, marketplaces, series, document kinds, and for VIDR the all-statuses declaration and non-truncation, as the engine already enforces. Rule, in the critic's words kept: presence in a partial file may prove presence; absence proves absence only when the source is complete, covers the relevant scope and covers the document kinds in question. An import with rejected rows, truncation, or an ambiguous mapping is not complete for any absence conclusion.

## 6. Matching

No fuzzy matching. Ladder, each link records its method and level:
1. Document number equality (trim whitespace only) against the VIDR invoice number: CONFIRMED.
2. Amazon order id equality with the ledger order reference, one candidate on each side: PROPOSED. An order id match alone does not confirm a link. The seller confirms the proposal with a LINK_DECISION event (bulk confirmation of a listed set is one event naming each pair). A confirmed decision is a human declaration of identity, displayed as declared: a link that exists only by LINK_DECISION lets later findings run on it, marks them "declared link", and any closure that depends on it is MANUALLY_REPORTED_RESOLUTION, never VERIFIED_CLOSED.
3. Several candidates: UNMATCHED_DOCUMENT (multiple candidates), naming them.
4. No match by amount, date or buyer, ever.

Findings that need a link run on CONFIRMED links only. A subject with only a PROPOSED link is not reported as missing in books or as mismatched; it is reported as UNMATCHED_DOCUMENT with the candidate named and the action "confirm or reject this link".

Field comparison on a confirmed pair: number (when linked by order id), gross, net, vat, currency, buyer tax id when both sides carry it. Equality in minor units, no tolerance in P1 to P3.

## 7. Issue families

Eight families. The sub-type may change between imports without changing the issue. Each row: trigger, proof, safe action, closure predicate (evidence only).

| Family (critic's types it holds) | Sub-types | Closure predicate |
|---|---|---|
| SOURCE_INCOMPLETE (SOURCE_INCOMPLETE) | unreadable, truncated, rejected rows, ambiguous mapping, scope not declared, blank line in data | A complete replacement import for the same scope, or the declaration the contract allows. |
| UNMATCHED_DOCUMENT (UNMATCHED_DOCUMENT; v0.1 LEDGER_DOC_NOT_IN_AMAZON, AMBIGUOUS_LINK) | no candidate (needs all-status VIDR covering the date and marketplace), proposed link unconfirmed, multiple candidates | A later import that supplies a number-equal link (closed with evidence). A seller's LINK_DECISION alone gives MANUALLY_REPORTED_RESOLUTION (9.2). |
| DUPLICATE_DOCUMENT (DUPLICATE_DOCUMENT) | same identity twice with different content, true duplicate | A corrected source in which one document holds the identity. |
| INVOICE_AMAZON_STATE (INVOICE_ACTION_REQUIRED, INVOICE_REJECTED) | action required (InvoicePending, NoTaxCalculated), rejected (with Amazon's description verbatim) | A newer all-status report where the engine reaches ACCEPTED for the subject through its gate. Reviews cannot close it. PROCESSING is not a sub-type. |
| BOOKS_GAP (INVOICE_MISSING_IN_BOOKS, INVOICE_ACCEPTED_NOT_IN_BOOKS, CREDIT_NOTE_MISSING_IN_BOOKS) | invoice not in books, accepted at Amazon but not in books, credit note not in books (later phase) | A later accounting import covering the scope with a number-equal link to the transaction (a declared link gives MANUALLY_REPORTED_RESOLUTION only). The card differs by what Amazon shows (create and record, or record). |
| DATA_MISMATCH (INVOICE_DATA_MISMATCH, CREDIT_NOTE_DATA_MISMATCH) | field list: number, gross, net, vat, currency, buyer tax id | A later accounting document on the same confirmed link whose compared values agree. One issue per pair. |
| CORRECTION_PAIR_OPEN (CORRECTION_PAIR_OPEN, CREDIT_NOTE_ACTION_REQUIRED for correction roles) | reversal side open, corrected side open, both | Both sides ACCEPTED independently through the engine cycle. Later phase. |
| CREDIT_NOTE_AMAZON_STATE (CREDIT_NOTE_ACTION_REQUIRED) | CreditNotePending, CreditNoteRejected | A newer report where the engine reaches ACCEPTED for it. Later phase. |

Why families and not twelve types (A1): INVOICE_ACTION_REQUIRED becoming INVOICE_REJECTED is the same subject and the same closure condition, so one issue. INVOICE_MISSING_IN_BOOKS and INVOICE_ACCEPTED_NOT_IN_BOOKS differ in the action (create and record, or only record) but close on the same evidence, so one issue with two cards by sub-type. A books gap and an Amazon-state problem on the same transaction are two issues, because different people close them with different evidence.

Not exceptions: PROCESSING (Amazon states no new action; shown in an "in progress" count with no card and no invented age threshold), a transaction Amazon invoices itself, and any incompleteness of a file beyond the single SOURCE_INCOMPLETE issue for that import. Cannot-determine is a coverage note attached to the subject ("absence not concluded because the books file declares no period"), counted separately, never an exception.

Card content, from templates filled only with evidence values: what the problem is; why it appeared (the rule and the values compared); proof (file name, row numbers, raw cells); the safe action for the seller or accountant (plain instruction, no Seller Central path we have not verified); the evidence that will confirm it is solved; history. No wording that states the legal position of a document or of the seller.

## 8. Issue identity

`issue_key = sha256(keyVersion + sellerProfileId + issueFamily + subjectIdentity)`

subjectIdentity, Amazon side: marketplace, transaction type, transaction id verbatim, order id, shipping id, document role. Ledger side: source system plus source document id, or the composite issuer tax id, kind, series, number. Mismatch: the Amazon subject plus the ledger composite. Nothing else enters: no status, sub-type, amount, row number, file name, import date, description or order of display.

Temporary identity: a document without a reliable identifier (no number or source id, or a number that is not unique and cannot be told apart) is not given a permanent key. It receives a temporary key `tmp|importSha|rowHash`, marked TEMPORARY, shown as "unidentified document in file X", never as a named document. When reliable evidence later determines identity, an alias record (from temporary key, to permanent key, evidence) is written as derived or as a SellerEvent IDENTITY_ALIAS, the projection follows aliases, and the issue keeps its episodes and events. Stated limit: a temporary key is import-specific, so the same unidentified row in a re-exported file is a new temporary issue until aliased. That is the cost of not inventing an identity.

keyVersion: changing the formula orphans all history, so a version change requires a published alias table old key to new key, tested over the fixtures. sellerProfileId (X5): a random local profile id created on first use and stored with the history. The key is therefore stable on a device and across imports, and is not portable between two devices unless the profile id is exported with the bundle (the bundle carries it).

## 9. Lifecycle as a projection

Imports replay in engine effective-time order (contract 6). Ties the engine cannot order make the affected subjects SOURCE_INCOMPLETE. For each issue key, replay every prefix of imports and compute the findings. An episode is a maximal run of prefixes where the finding is present. History is the sequence of episodes with evidence; nothing is deleted.

States (derived):
- OPEN: the engine found an exception with enough evidence, and no safe action can yet be produced (for example several candidates need a human reading). The card says what is known and what is missing.
- ACTION_REQUIRED: classified, and a safe action exists.
- AWAITING_NEW_EVIDENCE: a SellerEvent ACTION_STARTED exists later than the latest import that shows the finding. It proves the statement made, and nothing about Amazon or the books.
- VERIFIED_CLOSED: the family's closure predicate is met by imported evidence. Only the projection sets it.
- MANUALLY_REPORTED_RESOLUTION: see 9.2.
Reopening is not a state. If a VERIFIED_CLOSED episode is followed by a prefix where the finding is present, a new episode begins, the state is ACTION_REQUIRED or OPEN, and the card shows both episodes with their evidence.

Rules: no button writes a state. The seller's controls write SellerEvents or imports. A new import re-evaluates every issue. If the finding persists after ACTION_STARTED the issue returns to ACTION_REQUIRED and the event stays in the history.

### 9.1 Order of evidence
Events order by their time; imports by effective time. A SellerEvent applies to the evidence recorded in `basedOn`. If a later import changes the rows that evidence names, the event no longer applies to the current evidence, stays in the history, and is shown as such.

### 9.2 MANUALLY_REPORTED_RESOLUTION (fifth outcome)
Used when a RESOLUTION_DECLARED event exists for an issue whose closure predicate is not met by evidence, and the family allows a declared resolution (UNMATCHED_DOCUMENT no candidate, for example "not an Amazon sale"; DATA_MISMATCH with DIFFERENCE_EXPLAINED; SOURCE_INCOMPLETE where the contract allows a declaration). It means: the seller states this is resolved, here is the reasoning. It never means verified. Families that describe Amazon's state (INVOICE_AMAZON_STATE, CREDIT_NOTE_AMAZON_STATE, CORRECTION_PAIR_OPEN) accept no declared resolution at all.
Lapse: the declaration covers the rows it names. If a later import changes those rows, it lapses and the issue returns to ACTION_REQUIRED with the declaration kept.
X2 stated: a human review with supporting evidence closes with evidence only when the supporting file is something the engine reads and a predicate evaluates. A note typed by a person, or a screenshot, is a declaration.
UI: a separate count and separate wording ("reported resolved by you, not confirmed by files"), never added to "closed with evidence". Bundle: each issue carries `closureBasis` = `evidence` | `declaration` | null; the bundle headline lists verifiedClosed and manuallyReportedResolution as two separate numbers and no field sums them; each declaration is exported with author, time, reasoning, and the evidence it was based on.

## 10. Experience

One local page: drop files; the seller sees detected columns and confirms them; then groups, each linked to its cards: Fine (count; list on demand), In progress at Amazon (count, no card), Needs action now, Needs a human reading (OPEN), Cannot determine (coverage notes with the missing item), Reported resolved by you (declared), Closed with evidence. Import history with a compare view for two imports: issues new, gone, unchanged, reopened. Forms on the card write ACTION_STARTED, RESOLUTION_DECLARED, LINK_DECISION; the card then shows the state the projection produces. A visible line states which families this version does not check ("credit notes and correction pairs are not checked in this version"), so an empty list is never read as "all clear". Local-first with the existing network counter. Export: evidence bundle with issues, episodes, events, closureBasis and the same wording limits.

## 11. Phases and boundaries

Each phase ends with runnable code, tests, failure scenarios, evidence that results are right, and a statement of what was and was not done. No phase changes the Evidence Engine or its contract.

- P0: this document.
- P1, the critic's loop on ordinary invoices, read-only: all-status VIDR and an accounting invoice export; mapping profile with preview and confirmation; canonical model; matching (number confirmed, order id proposed); families SOURCE_INCOMPLETE, UNMATCHED_DOCUMENT, INVOICE_AMAZON_STATE, BOOKS_GAP; keys; derived lifecycle; SellerEvents ACTION_STARTED, RESOLUTION_DECLARED, LINK_DECISION; page; the loop end to end through "seller starts action, uploads a newer report, system closes only on evidence". Boundary: no credit notes, no corrections, no mismatch, no support files, no hosted route.
- P2: DATA_MISMATCH and DUPLICATE_DOCUMENT; DIFFERENCE_EXPLAINED.
- P3: credit notes and rectificativas: BOOKS_GAP and mismatch for credit notes, CREDIT_NOTE_AMAZON_STATE, DocumentLine for partial refunds.
- P4: CORRECTION_PAIR_OPEN across books and engine cycles; comparison and export polish; performance at the 20,000-row cap.
- Out of scope until separately approved: connectors, hosted storage of seller files, any write path.

## 12. Acceptance criteria (the critic's six) and tests by class

Each phase is judged on: found from real sources; cause explained without guessing; clear next step; learned whether the action worked; false closure prevented; understandable without reading files. Fixtures are synthetic and labelled so; the first and last criteria are only partly provable until a real redacted VIDR and a real accounting export exist, and the phase report says so.

Test classes:
1. Determinism: any insertion order, same projection; cache deleted, same projection; cache equals fresh computation.
2. Identity: one key across three imports with changed status, amount, date, row order, file name; different family or subject gives a different key; temporary key then alias keeps episodes.
3. Closure: ACTION_STARTED never gives VERIFIED_CLOSED; a declaration never gives it; Amazon-state families refuse declarations; closure then contradiction opens a new episode with both evidence sets.
4. Coverage: no absence finding unless each of period, marketplace, kinds, completeness holds, tested one condition at a time; processing creates no issue; incomplete file creates one SOURCE_INCOMPLETE and nothing else.
5. Mapping: ambiguous, missing, content mismatch, unreadable value, each named; nothing guessed; negative amount does not make a credit note.
6. Matching: number confirmed; order id proposed only; proposed link never produces a books-gap or mismatch finding; several candidates; no match by amount or date.
7. Language scan over every card and the bundle for forbidden claims.
8. Structural: no loop module imports repair, pipeline, db or app; no stored state field.
9. Failure scenarios: truncated file, blank line, duplicate numbers, mixed currencies, other marketplace, an event dated before the evidence it cites.

## 13. Decisions and their status

D1 OPEN versus ACTION_REQUIRED: settled by the critic's definition, adopted (9). Cannot-determine leaves the lifecycle.
D2 Which declarations may close: settled that none closes with evidence; remaining open: the list of declaration kinds per family and their wording.
D3 Order id linking before VIDR carries an invoice number: settled that it is a proposal and needs the seller's confirmation (6). Remaining open: whether agreement of gross and currency may ever replace the confirmation. Recommendation: no.
D4 Amount tolerance: open. Recommendation: none in P1 to P3, difference shown with its size; line-level rounding rules decided with DocumentLine in P3.
D5 Renumbering: partly settled by the temporary identity and alias rule; remaining open: whether a seller-declared IDENTITY_ALIAS is allowed. Recommendation: yes, displayed as declared, both numbers present in imports.
D6 Static page deploy in P1: open. Settled only that P1 is read-only and local. Recommendation: no deploy until Main decides, and any deploy carries the "not checked in this version" line.
Open question O1: after an INVOICE_REJECTED, if the replacement is uploaded under a different TransactionId, the subject identity changes. The closure predicate "same transaction" cannot be applied until a real file shows what Amazon does. Not guessed; P1 closes only when the same subject reaches ACCEPTED.
