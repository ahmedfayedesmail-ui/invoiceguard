# InvoiceGuard engine v2: architecture proposal (for critical review, nothing here is implemented)

Status: proposal only. No engine code is changed on this branch. Base: integration/all-fixes 4be64e7. Synthetic data only. Nothing is merged, nothing touches main.
Direction: from "does the invoice number match?" to "do we hold a complete, evidence-backed explanation of what happened in this transaction, and do we say plainly what we could not explain and what would change the conclusion?"

Revision 2 (after review). Eight changes, each answered where it belongs:
1. Actionability policy table written in full: section 7.4.
2. Stable finding identity and deltas without a persisted ledger: section 4.4 (principle 1 stands, with stated limits).
3. Double consumption demoted to a relation observation and moved to phase C: sections 6.4, 14.
4. Tax period as a first-class time, and the correction chain (credit notes, rectificativas): sections 5.5 and 6.5.
5. Phases reordered so the first behaviour change is visible: section 14.
6. Independence from method (mechanical expectations and a dumb reference checker): section 10.
7. The customer-facing quality claim: section 11.2.
8. CONFIRMED defined without treating missing fields as agreement: section 3.3.

Reading guide
- Section 1: the problem, with the numbers that prove it.
- Sections 2 to 11: the architecture (domain model, provenance, time, reconciliation, three axes, findings, patterns, mutation testing, metrics).
- Section 12: a critical evaluation of every proposal, including the ones Ahmed and I put forward and my own. This is the section to attack. Section 11 holds the metrics.
- Section 13: my additional ideas, kept to the few that earn their place. Section 14: phases, dependencies, risks. Section 15: decisions needed.
- Appendices A to C: evidence for the 7 items, auto mapping, the 20,001 rows.

Notation: "I" is the operator. A claim about Amazon's rules is marked SOURCE or CONVENTION. A CONVENTION is something the engine assumes and must be able to disclose; it is never shown as law or as Amazon policy.

## 1. The problem

The engine has one verdict per order: judged or not judged. The is-business-order flag decides it. "Not judged" silently means two different things: "the seller owes nothing here" and "there is nothing here worth detecting". They are not the same.

Evidence from the current branch:
- 49 follow-up items were lost because their orders carry is-business-order FALSE (evidence/all-fixes/out/followup-49-cases-v5.json). 38 were BOOKS_GAP, 11 were DATA_MISMATCH. The 11 are objective differences between Amazon's record and the books (a total, a currency, a date). Whether a B2B invoice is owed does not change that two records disagree. The engine now says nothing about them. The no-accusation fix was right. The loss of visibility was not intended.
- 124 duplicate findings left ACTION_REQUIRED (46 true against ground truth, 78 declaration-dependent). Keeping them as information is right, but "information" is currently one flat OPEN state with no weight.
- Recall 93.3% (751/805) counts a defect as found if any issue exists on its order or number, in any state and any family. It checks neither type nor identity nor evidence.
- Of the 53 follow-up items that were already "lost" on main, 46 are coverage limits and 7 are items that are matched by number (Appendix A). None is an engine failure. The metric that called them lost cannot tell a missing finding from a healthy record.

Root cause: one axis where three are needed, keyed to one rule (B2B), and a measurement that does not test what a finding says.

## 2. Design principles

1. Only imports and seller events are stored; everything else is derived by project() (today's invariant, kept). The graph, the timeline, the explained-mass ledger and the findings are derived views. Stable identity across imports is achieved without storing findings (section 4.4).
2. Applicability belongs to a check domain, not to an order.
3. A link is confirmed only by evidence that identifies the pair. Similarity makes a proposed link at most.
4. A story is told only over confirmed links. Proposed links are shown as proposals, conflicting links as conflicts.
5. No amount is explained by guessing. Tolerances exist only where a documented rounding rule exists.
6. A declaration is a claim. It annotates; it never closes, never changes Applicability, never counts as evidence.
7. Every conclusion states what would disprove it and what is not known.
8. If the engine cannot decide, it says so by name. UNDETERMINED is a first-class output, not a failure.

## 3. Domain model

### 3.1 Nodes (all with a stable id, never derived from status, amount, date, file name or row)
- Subject nodes: Order, Shipment (Amazon transaction), AmazonInvoiceRecord (what Amazon says about an invoice for a shipment), CreditNoteRecord (Amazon side), LedgerDocument (a document in the seller's books, built from one or more rows according to documentLevel), LedgerRow (raw row), Payment (reserved, no data today).
- Source nodes: Import (file, hash, kind, declared scope, declared period, as-of time), Declaration (a seller event).
- A LedgerDocument keeps the LedgerRow ids it was built from. If documentLevel is unknown, a document cannot be built; rows stay rows and the repetition is a question (section 7.3).

### 3.2 Events
Events are statements dated in the world: ShipmentOccurred, InvoiceIssuedAtAmazon, InvoiceRecordedInBooks, CreditNoteIssued, ReportCreated, ExportCreated, DeclarationMade. Each carries four times (section 5) and a source reference.

### 3.3 Relations (edges)
Each edge has: type, endpoints, status, evidence refs, the rule that made it, and the time it was established.

Types: SHIPMENT_OF (shipment to order), DOCUMENTS (document to shipment, the invoice relation), CREDITS (credit note to document), BUILT_FROM (document to rows), DECLARES_ON (declaration to subject).

Status, mutually exclusive:
- CONFIRMED: an identifying key agrees and nothing contradicts it. Today: the same document number on Amazon's record and on exactly one ledger document, not shared with another shipment, within a declared scope.
- PROPOSED: corroborating signals exist but no identifying key (for example the same order reference and a close date and equal amount, with different document numbers). A proposal is shown as a proposal. It is never promoted by the engine to confirmed. Only an identifying key arriving in a later import can promote it.
- CONFLICTING: two sources assert incompatible relations (the number points to one order in Amazon's report and to another in the books; one number on two shipments).
Absence of a field is not agreement. Corroborating fields are recorded per field as AGREES, DISAGREES or ABSENT, and ABSENT is never counted as agreement and never as contradiction. A books row with no order reference is therefore CONFIRMED by its document number exactly as today: the number is the identifying key; the missing order reference simply adds no corroboration and is shown as ABSENT. A field that DISAGREES on a confirmed pair does not unconfirm it: it produces a DATA_MISMATCH observation (or a CONFLICTING relation when the order reference points to another shipment). Confirmed relations are directional facts of the files. Probabilities exist only in rank order of proposals; they are never stored as a score that can be mistaken for confirmation.

### 3.4 Cardinality
The model allows 1:1, 1:n and n:1 between documents and shipments. It does not assume one invoice per order. Whether an n:1 or 1:n is allowed is decided per document type by a rule (section 6.1), not by the matcher. A relation set that breaks its rule is a CONFLICT component, shown with all its members, not a pile of single mismatches.

### 3.5 The story of an order
For any order the engine can print: its shipments, the documents on each, the credit notes, the ledger documents and rows, the declarations, with each relation's status and source and each node's times. A sentence in the story is only generated over confirmed relations. A sentence that depends on a proposed link is printed as "possible: ..." in a separate list. If an order has any proposed or conflicting relation, the story says "not fully established" at the top.

## 4. Evidence and provenance

### 4.1 Field level
Every value the engine uses has a provenance record: (import id, row, column, raw text, parsed value, parse rule, parse confidence class). Every inference (a link, a classification, an applicability decision, a derived total) records: the rule id and version, the provenance records it used, and the time computed. An inference with no provenance records cannot be shown.

### 4.2 Authority, per claim type (no global ranking)
| Claim | Authoritative source | Limits |
|---|---|---|
| What Amazon recorded about an order, shipment, invoice status, business flag | Amazon report | as of the report's created time; a stale report is superseded by a newer report of the same scope only |
| What the seller recorded as a document, date, total | Seller books export | as of export time and declared scope; partial exports prove presence, not absence |
| Whether a document is a whole document or one line of one | The file's own structure first; the seller's declaration only as a claim that the structure can contradict | a declaration contradicted by structure is shown as a conflict |
| Scope, period, report day | Declared by the seller at import, checked against file content | a declaration outside the file's evidence lowers coverage |
| That something has been resolved | Only a later import that shows it | a declaration never counts |
Conflicts between two sources that are each authoritative for different claims are not conflicts of authority: both stand, and a CONTRADICTORY observation records the disagreement. Recency decides only between two exports of one source and scope. There is no majority rule.

### 4.3 Declarations
Stored as events with author, time and text. Shown next to the finding they relate to as "declared by the seller", with their time, and counted separately in every metric. A finding's closing history therefore has two separate lines: closed by evidence (file, time) and declared by the seller (time). They never merge.

### 4.4 Stable finding identity and deltas (principle 1 kept, with limits)
Finding identity is not a function of the current data. Today it is `key = sha256(KEY_VERSION, sellerProfileId, family, identity)` (src/loop/project.js, issueKey), where identity is the subject's own identifier (an order and transaction, a document number, a ledger identity, a source descriptor). It contains no status, amount, date, file name, row or import id, so a new import cannot change it. "Resolved" and "reopened" are also already derived without a stored ledger: project() replays the ordered imports one prefix at a time (imports 1..k for each k), records per key whether the finding was PRESENT, CLOSED or not evaluated at each step, and builds episodes from that history (an `episodes` list and a `reopened` flag exist today). A delta between two imports is therefore a comparison of two prefix states, not a stored record.
Conditions that keep this honest, which the design makes explicit:
1. Retention: replay needs every import kept. If a seller deletes an import, history changes. Verified behaviour today (evidence/import-deletion/characterize.mjs and result-at-4be64e7.json, run on the 4be64e7 engine, one Amazon report with two shipments and two books exports where the second closes the gap found by the first):
   - deleteImport exists, refuses without an explicit confirmation, and a deletionImpact preview is computed first from the data (issues that would disappear, issues that would change).
   - Deleting the closing export (books2): the finding goes from VERIFIED_CLOSED back to ACTION_REQUIRED with reopened false and a history that shows no trace of the deleted closure.
   - Deleting the export that first showed the finding (books1): the finding disappears completely from the projection, including its closed history. The preview warned beforehand (BOOKS_GAP 1 disappearing), but after the deletion nothing in the result says a history ever existed.
   - Deleting the Amazon report: the finding disappears and a coverage note says no Amazon report is loaded.
   - No marker of incomplete history exists anywhere in the result after any of the three deletions.
   So the earlier proposal was not describing existing behaviour. What exists is the pre-deletion preview. What the design adds, and what is not implemented: deleting an import is recorded as an event, and every finding whose history passed through that import is marked "history incomplete", so a finding can neither silently disappear nor silently revert from resolved to open. Own defect, phase 0, before phase A (the three cases above are its failing-before tests). Expected after the fix: findings are never silently resolved or removed, each carries the marker, and the delete event is listed.
2. Identity continuity: the key includes family, so a finding that moves family when more evidence arrives (for example an unmatched document that becomes a proposed link) is a different key. The model adds a successor relation (key A is succeeded by key B, with the evidence for the succession) so the delta shows "changed" rather than "resolved and new". The successor relation is derived, never stored.
3. Identity changes with the subject: a renumbered document or a corrected order id is a new subject. The engine shows two findings and says the identity changed; it never merges them on similarity.
4. Versioning: any change to how identity is built bumps KEY_VERSION, and deltas across versions are not computed (they are marked not comparable).
5. Cost: prefix replay reads imports k times. The cost grows with the number of imports and rows; a limit on the replayed history window must be stated and measured (appendix C records current timings). If the measurement shows the cost is too high, the fallback is a persisted per-import snapshot of finding keys and states. That is an exception to principle 1 and would be recorded as a cache that can always be rebuilt by replay, never as a source of truth. It is not needed until the measurement says so.

## 5. Temporal model

Four times on every event: event time (when it happened), record time (when the source recorded it), import time (when the seller loaded the file), as-of time (the report's created time or the export's time).

Four classes, never mixed:
1. Normal delay: event-to-record gap within a documented window. No finding.
2. Missing coverage: the file's period or scope does not reach the event. NOT_OBSERVABLE, named, with the exact boundary (for example books period ends 2026-10-31, report day 2026-12-04).
3. Temporal contradiction: dated facts that cannot all hold under the data contract. Shown as CONTRADICTORY, to review.
4. Proven violation: only where a rule with a stated SOURCE defines the deadline or order and the evidence meets it.
Every temporal rule has an id, version and SOURCE or CONVENTION label. A CONVENTION can create class 2 or 3 outputs. It cannot create class 4. Example: a credit note dated before its invoice is class 3 at most, to review, because document types, local rules and what the date column means vary. "One business day" for invoice issuance is Amazon policy as the seller-facing documentation states it; it is never presented as law.

### 5.5 Tax period (a fifth time, first-class)
For a VAT product the time that decides money is the return period a document belongs to. The model adds PeriodAssignment as a derived fact on every document and every correction, with its own provenance and rules.
- Inputs: the seller-declared filing frequency and period boundaries (monthly or quarterly; declared at onboarding, shown to the seller), and the document's candidate dates: issue date, operation date (the supply date, where the books state it), shipment date (Amazon).
- Output: a period for each candidate date. If all candidates fall in one period: PERIOD_ASSIGNED with the rule used. If they straddle a boundary: PERIOD_AMBIGUOUS, listing each candidate period and which date gave it. The engine does not pick one.
- Rules are registered with SOURCE or CONVENTION. The only rule proposed as a default is a CONVENTION: "the period is the calendar period containing the document's operation date, falling back to the issue date when no operation date exists". I do not state tax-point rules for any country as fact; each country rule that would decide a period needs a verified SOURCE before it can be used, and until then the engine reports candidates and ambiguity only.
- What it can conclude: which period each date falls in; that a document and its correction fall in different periods; that a period boundary separates dates that should coincide under the stated convention.
- What it cannot conclude: which return a document or correction legally belongs to, whether a correction goes to the current or an amended return, or whether a return was filed correctly. It says so, and never produces a filing instruction.
- Period matters for coverage too: the books' declared period must cover the document's candidate periods before an absence is concluded.
- A period-related finding is REVIEW only (policy rows T1 and T3 in 7.4).

## 6. Reconciliation engine

### 6.1 Relationship engine (not a forced one-to-one match)
Stages:
1. Candidate generation: for each LedgerDocument and each Shipment, collect candidate pairs from identifying keys (document number, transaction id when present) and from corroborating signals (order reference, date, amount, currency, buyer tax id).
2. Link grading: an identifying key agreeing makes CONFIRMED unless contradicted. Corroborating signals alone make PROPOSED. A key pointing two ways makes CONFLICTING.
3. Components: build the connected components of the candidate graph. Each component is judged as a unit. This is what prevents errors from creating new errors: a swapped pair of documents between two orders is one component with a conflict, not two unrelated mismatches.
4. Cardinality check per component by rule. Document types differ: a consolidated invoice can legitimately cover several shipments in a seller's books; a shipment normally has one invoice at Amazon (my recorded reading of Amazon's documentation says the invoice is due per shipment; re-verify the source before any rule depends on it, until then it is a CONVENTION). A multiplicity the data shows is reported as an observation (6.4). Only where a sourced rule says it is not permitted does the component become CONFLICTING with a violation claim. Either way all members are listed and no blame is assigned to one member.
5. Orphans per component: a shipment with no document, a document with no shipment, only where coverage lets absence be concluded (otherwise NOT_OBSERVABLE).
This replaces the matcher's decision "unique number or unmatched" with a graded relation that keeps the reason.

### 6.2 Amounts: explain, classify, never guess
Applies only inside a component whose relations allow comparison. Every amount difference is assigned to exactly one class:
- PROVEN_MATCH: both sides are the same quantity (homogeneous), values equal under the documented rounding rule, evidence cited.
- PARTIALLY_EXPLAINED: a part of the difference is attributed to a named cause with evidence (a VAT rate difference shown in the rows; a line missing from one side), the rest remains.
- UNEXPLAINED: comparable, differs, no attributable cause.
- NOT_COMPARABLE: data missing or not homogeneous (item amount versus invoice total; different currency with no stated rate; period mismatch; a column not mapped). The reason is named. It is not a difference.
Per component and per control cell the engine reports: signed difference, absolute difference (sum of |d| over items), explained part, residual, and the count of items in each class. Two opposing errors cannot hide in a clean total because the absolute sum and the item-level classes are always shown. Zero residual is reported as "all attributed to named causes" only if every cause has evidence.
Explained mass is a diagnostic of a file pair, never a product accuracy number. No catch-all class counts as explained. Tolerances: only the documented rounding rule of the document's jurisdiction; unknown jurisdictions get no tolerance and any difference is shown.

### 6.3 Control totals
Used to locate: per market, currency, period, document type, status. They narrow where to look. They are never proof of integrity. Cells that are not homogeneous are NOT_COMPARABLE.

### 6.4 Relation multiplicity: observation first, violation only with a source
No rule is needed to observe it. When a document is related to more than one shipment, or a shipment to more than one document, the engine reports a relation observation: "this document is related to 3 shipments; whether that is permitted is not established". It is class 3 at most (a contradiction to review), REVIEW, never SELLER_ACTION. It ships with the relationship engine (phase C), not after a sourced rule.
A claim that this is a violation, or any SELLER_ACTION that depends on it, needs a sourced cardinality rule per document type. Until one is verified it stays a CONVENTION-free observation. Conservation of amount (a document covering more or less than its linked shipments) is computed only where amounts are homogeneous, and is PARTIALLY_EXPLAINED or UNEXPLAINED, never a violation by itself.

### 6.5 Correction chain: credit notes and rectificativas
Model: a CorrectionRecord (credit note at Amazon, credit note or rectifying invoice in the books) is a node with a CORRECTS relation to an original document. The relation has the same status vocabulary as any other (CONFIRMED by an explicit reference to the original's number, PROPOSED by order and amount similarity, CONFLICTING when it references two things).
Correction kinds, where the data states them (otherwise the kind is UNKNOWN and nothing below is concluded): full cancellation, partial correction by difference, substitution (a correcting document that replaces the original). The names of the Spanish forms of rectification and their exact rules need a verified SOURCE before the engine relies on them; until then they are CONVENTION labels shown as such.
Effect on the original document's state, derived and never stored: ORIGINAL_STANDS (no confirmed correction), CORRECTED (confirmed corrections with a computed effective amount = original plus the signed corrections), CANCELLED (a confirmed full cancellation), SUPERSEDED (a confirmed substitution). The effective amount exists only if the chain is complete (see below). Comparisons with Amazon use the effective amount only when it exists; otherwise they use the original amount and say so.
What the engine can conclude with a complete confirmed chain: the effective amount; that corrections sum to more than the original (an over-credit, provable arithmetic); that a correction's currency differs from its original's; that a correction is dated before its original (class 3 contradiction, never a violation); that a correction falls in a different tax period from its original (observation).
What it can and cannot conclude when the chain is incomplete: it can conclude that a correction references a number not in the loaded data (a dangling reference, a coverage question about which file would hold the original); it can conclude the original's amount comparison is NOT_COMPARABLE because a correction may exist that is not loaded; it cannot conclude the effective amount, that the original stands, or that nothing was corrected. Absence of a correction in a partial or period-limited export is not evidence that none exists.
Correction without any referencing number: PROPOSED link at most; never closes or alters the original's state. A seller declaration that "this was cancelled" is an annotation and never changes ORIGINAL_STANDS.
This chain is a prerequisite for any amount check on documents that have corrections, and it is where Applicability for B2B interacts with periods (a credit note issued in a later period for an original in an earlier one).

## 7. Three-axis finding model

### 7.1 Check domains
B2B_OBLIGATION, LEDGER_INTEGRITY, DATA_RECONCILIATION, COVERAGE, SOURCE. A check belongs to exactly one domain.

### 7.2 Axes
| Axis | Question | Values |
|---|---|---|
| Applicability | Does this domain's rule apply to this subject? | APPLIES, NOT_APPLICABLE, UNDETERMINED, always with rule id and deciding fields |
| Observation | What does the evidence show? | PRESENT, ABSENT_PROVEN, NOT_OBSERVABLE, CONTRADICTORY |
| Materiality | Is the amount at stake large enough, for this seller, to ask them to act? | MATERIAL, IMMATERIAL, UNDETERMINED, NOT_APPLICABLE (see 7.2a) |
| Actionability | What can the reader do and for whom? | NONE, REVIEW, SELLER_ACTION, WAIT, with priority |
### 7.2a Materiality: a fourth dimension, separate from proof and from obligation
Three different questions: is it proven (Observation), is the seller obliged (Applicability, B2B domain only), does it matter enough to ask for attention (Materiality). A one-cent difference between the books and Amazon is fully proven and immaterial. Without this dimension it would be SELLER_ACTION at high priority, and a list full of such items is not read, which destroys the value of every real finding in it.
Inputs, all declared or read, none invented:
1. A threshold the SELLER declares at onboarding, with the declarations that already exist for the books (documentLevel, amazonScope, period): one absolute amount per currency. It is declared, never verified, and stored as a seller declaration. The tool offers no default and no suggested value. A relative threshold is not offered in this proposal (decision 10).
2. The currency of both amounts. A threshold in one currency never applies to an amount in another, and no conversion is made without a stated rate.
3. The tax relevance class of the field:
   - AMOUNT_TAX: total, net, VAT amount. Governed by the threshold: absolute difference at or above it is MATERIAL, below it IMMATERIAL.
   - IDENTIFYING: tax id, currency, document number. A mismatch is not scaled by an amount; it is MATERIAL by kind, because a wrong currency or tax id changes the meaning of every amount around it (P?, Ahmed to decide).
   - TIMING: a date field. MATERIAL only if the candidate tax periods (5.5) differ between the two values, otherwise IMMATERIAL (P?). Candidate periods only, no return assignment.
   - ARITHMETIC: rounding within a documented per-row tolerance is not a materiality question; it belongs to the homogeneity check (A4) and never produces a finding.
4. For a document missing on one side (R4), the amount at stake is the document's total, against the same threshold.
Rules: where the seller has not declared a threshold for that currency, Materiality is UNDETERMINED, the amount is shown, the item is never escalated to SELLER_ACTION on amount grounds, and the coverage map says "no materiality threshold declared for EUR". IMMATERIAL items are not hidden: they leave the findings list and appear in one summary line per currency with count, sum of absolute differences and the largest single one, so many small items cannot vanish one by one. Materiality is NOT_APPLICABLE in the B2B_OBLIGATION domain: a missing invoice is a yes or no, and the amount is shown for context only. Materiality never changes Observation, only Actionability and priority. Proposed: it never lowers a LEDGER_INTEGRITY finding, because those are about the record itself (decision 10).
Actionability is set by the policy table in 7.4, per domain and defect type. It is never computed from Observation alone. SELLER_ACTION in B2B_OBLIGATION requires Applicability APPLIES.

### 7.3 Effect on the 49 and the 124
- is-business-order FALSE sets B2B_OBLIGATION NOT_APPLICABLE for the shipment. LEDGER_INTEGRITY and DATA_RECONCILIATION remain APPLIES.
- The 11 DATA_MISMATCH return as DATA_RECONCILIATION, Observation PRESENT, Actionability SELLER_ACTION (row R1), worded as an accounting discrepancy between the books and Amazon's record and never as a tax or B2B obligation. The flag does not change the action. Materiality does, in this order: threshold declared and difference at or above it gives SELLER_ACTION; below it, IMMATERIAL (summary line only); no threshold declared gives REVIEW with the amount shown and Materiality UNDETERMINED. For business orders that today get SELLER_ACTION unconditionally this is a behaviour change, flagged in R1.
- The 38 BOOKS_GAP: B2B NOT_APPLICABLE. As reconciliation facts they apply when the declared scope of the books includes the document's channel and period (a declaration about the books, independent of the business flag). Then Observation PRESENT and the row is R4, decided by Materiality on the document total as in R1 (SELLER_ACTION when declared and material, REVIEW when undetermined, summary line when immaterial), worded as "Amazon shows document N for order O dated D and your books do not contain it", never as an obligation to issue an invoice, with the fact, context and date kept. If the scope does not cover them, Applicability is UNDETERMINED and the output is a coverage item (row R6). Decision 3 in section 15.
- Duplicates (all in LEDGER_INTEGRITY, independent of the business flag):
| Case | Severity | Review priority | Meaning |
|---|---|---|---|
| EXACT_REPEAT, level DOCUMENT | MEDIUM | HIGH | repeated accounting record that needs review |
| SAME_NUMBER_DIFFERENT_CONTENT | HIGH | HIGHEST | conflicting records sharing a number; differing fields listed |
| SUSPECTED_DUPLICATE, level unknown | UNRESOLVED | HIGH | establish what a row is; one question to the seller |
| Repetition at LINE level, header fields agree | NONE | NONE | natural for a line export; counted only in the coverage map |
| LINE level, header fields disagree | HIGH | HIGH | rows of one document disagree on whole-document data |
Never worded as a B2B violation or a confirmed duplicate invoice without the evidence that supports "invoice" (document level and content).

### 7.4 The Actionability policy table (full)
How to read it. Rows are defect types, grouped by check domain. Columns: the Applicability precondition; the Observation state that triggers the row; the Actionability and priority; the certainty of the row.
Certainty codes: R = recorded ruling by Ahmed (source named); E = existing engine behaviour kept unchanged; P = my proposal, needs his confirmation; P? = my proposal and I am not sure, so it is flagged for him to decide.
Actionability meanings: NONE (nothing is shown as a finding; the case appears only in counts and the coverage map); REVIEW (a person should look; no deadline; never described as a violation); SELLER_ACTION (a concrete step the seller can take); WAIT (time or a later file resolves it).
General rules that override any row: (a) SELLER_ACTION in B2B_OBLIGATION needs Applicability APPLIES; (b) NOT_OBSERVABLE never produces a finding, only a coverage item with the file or range that would settle it; (c) a manual declaration changes no cell of this table; (d) nothing is worded as a violation unless a SOURCE-labelled rule supports the word; (e) is-business-order is read only by the B2B_OBLIGATION rows. No row in any other domain may take its Actionability from the business flag. Reconciliation wording names the accounting discrepancy and never a tax or B2B obligation. Where two cases in a domain differ in action, the difference comes from whether the discrepancy is provable (comparable, covered, homogeneous) and from the priority bands below, never from the flag. Materiality (7.2a) is the only other input to action level in the reconciliation domain, and it comes from a seller declaration, never a built-in number.

B2B_OBLIGATION (precondition for every row: is-business-order TRUE read from the field, is-amazon-invoiced FALSE read from the field, shipment in scope)
| # | Defect type | Observation | Actionability | Priority | Certainty |
|---|---|---|---|---|---|
| B1 | Amazon shows the seller invoice as rejected or needing seller action (INVOICE_AMAZON_STATE) | PRESENT | SELLER_ACTION | high | E |
| B2 | No invoice at Amazon for the shipment after the Amazon-policy window (policy, not law) | PRESENT | SELLER_ACTION | high | E |
| B3 | Same, inside the window, or Amazon marks it processing | PRESENT but early | WAIT | low | E |
| B4 | is-business-order FALSE | B2B not applicable | NONE (deliberate; reason recorded; the same shipment still goes through the other domains) | none | R (15:36 and 17:42) |
| B5 | is-business-order blank, unreadable or conflicting between rows | Applicability UNDETERMINED | REVIEW, one item per affected seller file naming the field | low | P? |
| B6 | is-amazon-invoiced TRUE (Amazon issued the invoice) | B2B seller duty not applicable | NONE (deliberate) | none | E |
| B7 | is-amazon-invoiced contradicts invoice-status (WS1 conflict) | CONTRADICTORY | REVIEW; nothing concluded, no action | normal | E |

DATA_RECONCILIATION (Amazon records versus the seller's books; precondition: shipment matched or matchable, comparable quantities, coverage sufficient)
| # | Defect type | Observation | Actionability | Priority | Certainty |
|---|---|---|---|---|---|
| R1 | DATA_MISMATCH, a comparable field differs (total, currency, date, tax id), any order, comparable and covered | PRESENT | By materiality 7.2a: SELLER_ACTION if MATERIAL; REVIEW with the amount shown if UNDETERMINED (no declared threshold); NONE as a finding, one summary line per currency, if IMMATERIAL; wording: accounting discrepancy, not an obligation | high for AMOUNT_TAX and IDENTIFYING when MATERIAL, normal for TIMING; none if immaterial | The flag plays no part (R, 17:42 and 7.3). Materiality and the UNDETERMINED fallback are P. Changing business orders from unconditional SELLER_ACTION (E) is P? |
| R2 | (merged into R1: the same defect has the same action whatever the business flag; they differ only by materiality) | | | | |
| R3 | DATA_MISMATCH, field not comparable (not homogeneous, missing column, different currency without rate) | NOT_COMPARABLE | NONE as a finding; listed in the coverage map with the reason | none | P |
| R4 | Amazon shows a document number the books do not carry (BOOKS_GAP NUMBER_AT_AMAZON_NOT_IN_BOOKS), any order, the declared books scope and period cover the document | PRESENT | By materiality on the document total: SELLER_ACTION if MATERIAL (check whether it belongs in the books and export it if so; never an issuance duty); REVIEW if UNDETERMINED; summary line if IMMATERIAL | high when material, low when undetermined | E for business orders today (unconditional SELLER_ACTION; changed by materiality, P?); the 38: R (17:42: fact, context, date, no issuance duty) and P for the materiality rule |
| R5 | (re-decided against materiality: R4 and R5 stay one row. What separates the 38 from business orders is not the flag and not provability, it is the amount, and materiality carries that identically for both) | | | | |
| R6 | Same, scope or period does not cover the shipment | NOT_OBSERVABLE | WAIT with the settle-it instruction (the export through the report day) | none | R (17:42 item 4) |
| R7 | A shipment with no document on either side | nothing to compare | NONE (deliberate; for a business order the missing seller invoice is B2 in the B2B domain) | none | P |
| R8 | Books document with no Amazon shipment (UNMATCHED_DOCUMENT NO_CANDIDATE), Amazon scope covers it | PRESENT (orphan) | REVIEW | normal | P |
| R9 | Same, Amazon report range or scope does not cover the document's date | NOT_OBSERVABLE | WAIT, settle-it instruction | none | P |
| R10 | Document linked only by corroborating signals (PROPOSED_LINK_UNCONFIRMED) | PROPOSED | REVIEW, the seller confirms or corrects; never SELLER_ACTION; never promoted by the engine | low | E |
| R11 | One number matching several candidates (MULTIPLE_CANDIDATES) | CONFLICTING | REVIEW | normal | E |
| R12 | One document related to several shipments, or one shipment to several documents | PRESENT (relation observation) | REVIEW, wording "whether permitted is not established" | normal | P (per review of 17:51) |
| R13 | One document number on two Amazon shipments | CONTRADICTORY | REVIEW | high | P? |
| R14 | A books document whose number points to another order than the Amazon shipment it matches (wrong-order link) | CONFLICTING | REVIEW | normal | P? (today only a note on 13 sellers; promotion needs the diagnosis of the 20 missed) |

LEDGER_INTEGRITY (the seller's file against itself; independent of the business flag)
| # | Defect type | Observation | Actionability | Priority | Certainty |
|---|---|---|---|---|---|
| L1 | EXACT_REPEAT, documentLevel DOCUMENT | PRESENT | REVIEW (repeated accounting record that needs review) | high | R (17:42), severity MEDIUM |
| L2 | SAME_NUMBER_DIFFERENT_CONTENT, level DOCUMENT or conflict in document-level fields | PRESENT | REVIEW (conflicting records sharing a number; differing fields listed) | highest | R, severity HIGH |
| L3 | SUSPECTED_DUPLICATE, level unknown | UNRESOLVED | REVIEW (establish what one row is; one question to the seller) | high | R |
| L4 | Repetition at LINE level, header fields agree | none | NONE (deliberate; only a count in the coverage map) | none | R |
| L5 | LINE level, document-level fields disagree across lines | PRESENT | REVIEW | high | E |
| L6 | Declared documentLevel contradicted by the file's structure | CONTRADICTORY | REVIEW | normal | P |
| L7 | Net plus VAT does not equal gross inside one document (arithmetic, homogeneous) | PRESENT | REVIEW | normal | P (not built; phase F) |
| L8 | Correction chain: dangling reference, over-credit, currency difference, correction before original | PRESENT or CONTRADICTORY | REVIEW (never "violation") | normal | P |
| L9 | Numbering gap unexplained after the series model | PRESENT | REVIEW, never SELLER_ACTION | low | P? (phase H) |

COVERAGE, SOURCE and PERIOD
| # | Defect type | Observation | Actionability | Priority | Certainty |
|---|---|---|---|---|---|
| C1 | Books period or amazonScope does not reach the check | NOT_OBSERVABLE | WAIT with the settle-it instruction | none | R |
| C2 | Partial export (declared incomplete): absence cannot be concluded, presence can | NOT_OBSERVABLE (absence only) | WAIT | none | E |
| C3 | A financial column mapping is ambiguous and unconfirmed | blocks dependent checks | SELLER_ACTION (confirm the mapping) | high | P |
| S1 | Amazon report refused: unreadable, malformed, range over 30 days, stale for the scope | SOURCE problem | SELLER_ACTION (load a usable report) | high | E |
| S2 | File over the supported row limit (20,000) | refused at preflight | SELLER_ACTION (split the file) | high | E |
| T1 | Candidate dates fall in different tax periods | PERIOD_AMBIGUOUS | REVIEW | normal | P |
| T2 | Temporal contradiction (a correction dated before its original) | CONTRADICTORY | REVIEW; never a violation without a SOURCE rule | normal | P |
| T3 | A correction falls in a different tax period from its original | observation | REVIEW | low | P |

Cases where the policy deliberately says NONE: B4, B6, R3, R7, L4. Each stays visible in counts and in the coverage map with its reason, so "not shown" never means "not looked at".
Rows still uncertain, for Ahmed to decide: B5, R1 priority bands, materiality (threshold input, field classes, UNDETERMINED fallback), R13, R14, L9. The seller-facing priority labels (high, normal, low) are a proposal with no external source.
Resolved after review and re-decided after the materiality objection: R1 versus R2 and R4 versus R5 are no longer different rows. My first merge used provability as the only difference, which was wrong: provability is not materiality. Principle 2 says Applicability belongs to the check domain, so reconciliation Actionability cannot depend on the business flag; the flag is read only in the B2B rows.

## 8. Falsifiable findings

```
Finding {
  id, stable key
  domain, checkId, ruleIds[] (with versions and SOURCE/CONVENTION)
  subject { orderId?, shipmentId?, documentNumber?, ledgerKey?, componentId? }
  family, classification (the type the finding claims)
  applicability{}, observation{}, actionability{}, severity
  evidence[]        each: provenance record, authority, four times
  counterEvidence[] what was searched that could argue against it, and the result
  wouldDisprove[]   concrete conditions: "a books row with number N and order O in an export covering P"
  unknowns[]        what cannot be established and which file or column would settle it
  closesWhen[]      evidence conditions only
  reopensWhen[]     evidence conditions only
  annotations[]     seller declarations, shown beside, never inputs
}
```
The four questions an accountant can use: what supports it; what was examined against it; what would disprove it; what is not known. Closing and reopening are evidence conditions on later imports. The structure also serves as the oracle for mutation tests (section 10): family, subject and evidence fields are what the test compares.

## 9. Pattern detection (design only; ships last)

What it is: findings about a seller over several periods that no single record shows. What it must not be: a source of SELLER_ACTION, or anything based on a count too small to mean something.

Principles:
- Numbering. A number gap is not proof of missing documents. The model first infers series: a series is a prefix plus a counter, per document type and year and branch, with reset rules. 1200 to 1241 is evidence of "41 numbers not present in this export" and is classified by evidence: numbers present in another series or file; voided or cancelled numbers (when the books mark them); numbers excluded by the export's filters (declared scope); numbers belonging to a different document type; or unexplained. Only the last class is an anomaly, and it is reported as an unexplained gap in a named series with the numbers listed, not as missing invoices.
- Seasonality and structure: baselines per market, currency and accounting system, with a minimum number of comparable periods (proposed: at least 6) and a stated interval. Below the minimum the engine reports "not enough history" and nothing else. Holiday volumes, a new market, a currency switch and a change of accounting system reset or split the baseline; the change itself is detected and shown.
- Each anomaly record contains: what is anomalous, against which baseline, why it is flagged (rule and numbers), the supporting evidence (which periods and rows), and the alternative explanations the engine checked.
- Patterns are shown after the mutation tests for each pattern type exist, with a measured false-positive rate on healthy synthetic histories.

## 10. Semantic mutation testing

Purpose: independent proof that a finding says the right thing about the right record, not that something fired nearby.

Components:
1. Mutators, in a separate module that does not import engine code. Each takes a clean synthetic seller (real file formats) and injects one defect of a known type on a known identity, and emits the expected result: family, subject identity, evidence fields (file, row, column), classification, and the three axes where the policy fixes them.
2. The oracle compares exactly those: right family, right identity, right evidence reference, right classification and axes. A finding on the same order with a different family is a miss and also a misclassification. A second finding on a different identity is a false finding.
3. Negative controls: clean sellers, non-applicable orders, LINE-level exports, partial exports, expected output is the exact expected set (usually nothing) and no SELLER_ACTION.
4. Collateral-damage test: run the engine on a seller before and after a mutation. Every record not touched by the mutation must have an identical result (findings, axes, relations). This is the test that detecting a defect does not corrupt healthy records.
5. Metamorphic tests: permute rows, reorder columns, translate headers, change number and date formats, split a file in two: results identical up to the permutation.
6. Independence from method, since no second reviewer exists:
   a. Expected results are generated mechanically from the injection specification, not written by hand. The specification is data: defect type, target identity chosen by position in the generated seller, field changed, and the mutation function. A lookup from defect type to the expected family, axes and evidence fields produces the expected result. That lookup is the policy table in 7.4, a single artifact reviewed by Ahmed, so the expectations cannot carry assumptions that are not visible there.
   b. A deliberately dumb reference checker of a few hundred lines that does not import any engine code and implements only the simplest provable checks: set difference of document numbers between the Amazon rows and the books rows, whole-row equality for exact repeats, field equality on number-matched pairs, counting of business-flag values, and a period-covers-date test. No linking by similarity, no coverage semantics beyond that test, no states. It runs on the hold-out and its output is compared to the engine's. Every disagreement is investigated and classified as an engine bug, a reference bug, or a documented difference of scope. The classification list is committed.
   c. What this gives: two implementations written differently that must agree on the provable checks; mechanical expectations that hide nothing; a measured disagreement rate that is itself reported.
   d. What it still does not give: independence of the specification. Both implementations encode my reading of the data contract and of Amazon's report format, so a shared misreading passes. It does not test the hard cases (links by corroboration, coverage semantics, corrections). It uses synthetic files only, so it cannot show agreement with real Amazon exports. Real independence needs one of: a real de-identified cycle (the evidence bar already set in the product strategy), or a person. Neither exists yet and the document does not pretend otherwise.
7. Independent dataset protocol: generator seeds and defect mixes are frozen and hashed (the hash is committed) before any fix is written against them; they are run once per release; a failure is reported and the dataset stays frozen (it may be replaced only by a new hashed one, with the old result kept). I am the author of both the mutators and the engine, so independence is partial; point 6 above states how the method reduces that and where it stops.
7. What passing does not mean: it does not mean recall on real data is guaranteed. Synthetic defects are the ones we thought of. Real exports will contain cases nobody injected. The suite proves consistency of the engine with its own stated rules and catches regressions. It does not prove the rules match Amazon.

## 11. Metrics (V1 to V5 unchanged; new metrics are new versions alongside)

1. Exact defect-level recall = injected defects for which a finding has the injected family, the injected identity and evidence naming the injected field or row, over injected defects in scope. Exclusions named.
2. Detection recall (any signal) = injected defects with any issue on the identity, any state. This is the old 93.3% (751/805), renamed and always printed beside the exact one.
3. Classification accuracy = findings whose axes match the policy table / findings on injected defects.
4. B2B compliance precision = true B2B_OBLIGATION findings with SELLER_ACTION over all of them. Computed only in that domain.
5. Ledger integrity precision and recall; data reconciliation precision and recall; each separate.
6. Coverage and undetermined rate = items NOT_OBSERVABLE or UNDETERMINED over items in scope, by cause.
7. Amount classification counts: PROVEN_MATCH, PARTIALLY_EXPLAINED, UNEXPLAINED, NOT_COMPARABLE, with absolute and signed differences, where computable.
8. Collateral-damage count: records whose result changed without being mutated (must be 0).
9a. Materiality counts: items MATERIAL, IMMATERIAL (with sum of absolute differences per currency) and UNDETERMINED, by field class. SELLER_ACTION items per seller per report is tracked as a noise measure, never as a quality score.
9. False-confident count per domain (SELLER_ACTION that is wrong; must be 0 on negative controls).
10. Hold-out result, reported with the dataset hash.
100% is never presented as an engine improvement. The move from 930/1008 to 884/884 was a denominator change: 124 findings left the measured scope (46 true, 78 declaration-dependent).

### 11.2 The customer-facing quality claim
The customer's question is "how good is this on my files?". The claim is about their files, not about the engine's accuracy in general.
The one number: Checked share = shipments in scope for which every applicable check reached a decided state (ABSENT_PROVEN or PRESENT), divided by shipments in scope. It is always printed with its remainder, in this form: "We checked 412 of 500 shipments in your report end to end. 31 have findings (by domain). 52 could not be fully checked (by reason: books period ends 2026-10-31: 38; mapping unconfirmed: 9; other: 5). 5 are not subject to the B2B check and were still checked for ledger and reconciliation." Not applicable counts are shown, not hidden in the denominator.
Population: the shipments in the Amazon report the seller loaded, within the declared scope, nothing else. Definitions of "in scope" and "decided" are printed with the number.
What the engine will not claim: that unchecked shipments are fine; that the checked share is accuracy or recall; that a clean result means the seller's filing is correct or compliant; any statement about acceptance by Amazon or any tax authority; any production accuracy figure until a complete real-seller cycle exists. Per-defect-type exact recall from the mutation suite is published only as "on our synthetic suite, type T: a of b", never as a customer promise.
Why this number: it states what was done and what was not, it cannot be raised by relabelling findings (moving a case to NOT_OBSERVABLE lowers it), and it is falsifiable by the seller (they can name a shipment and see its checks).

## 12. Critical evaluation of every proposal

Format per item: what could fail; assumptions that may be wrong; false positives it would produce; data it needs; what must exist first; whether it deserves building now.

### 12.1 Ahmed's six
1. Financial reconciliation (explain, four classes, absolute and residual).
- Could fail: classification by one wrong homogeneity assumption makes a false PROVEN_MATCH. The worst error is a quantity that looks the same and is not (item amount incl. VAT versus invoice total).
- Wrong assumptions: that report amounts and invoice totals share a definition; that rounding is per document everywhere; that a currency column is always the document currency.
- False positives: shipping, gift wrap, promotion discounts, VAT-rate mixes in one document appear as UNEXPLAINED differences.
- Data: per-line net, VAT, gross in the books; the report's item amounts; the market's VAT rate set.
- First: amount homogeneity model (P5) and the relationship engine, because amounts are compared inside components.
- Now? Build the classification scaffold and NOT_COMPARABLE first. Do not build "explained mass" as a headline until homogeneity is established for at least one market.
2. Relationship engine (1:1, 1:n, n:1; confirmed, proposed, conflicting).
- Could fail: components can grow large through a shared document number and make one conflict huge; proposed links can be mistaken for confirmed in the UI.
- Wrong assumptions: that cardinality can be set per document type with confidence; my recorded reading that Amazon wants one invoice per shipment (re-verify source).
- False positives: legitimate consolidated invoices flagged as conflicts if the rule is too strict; order splits across documents flagged as orphans.
- Data: transaction id and order reference in the books (not always present); document type.
- First: the node and relation vocabulary and the status field. This is the foundation everything else rests on.
- Now? Yes, the first thing to build, but with CONFIRMED only from identifying keys, and PROPOSED never promoted by the engine.
3. Provenance at field and inference level.
- Could fail: cost and complexity; provenance records that are present but wrong (a pointer to the wrong row).
- Wrong assumptions: that authority can be fixed per claim type once (it can change when real Amazon exports differ).
- False positives: none directly; the risk is false confidence from precise-looking provenance.
- Data: row and column references from the readers (partly present today).
- First: a uniform reader output with cell references.
- Now? Yes, at field level for the values that findings cite. Inference-level for linking and applicability. Not for every parsed cell.
4. Transaction graph.
- Could fail: becomes a database nobody can verify; a graph story reads as authoritative and hides that links are proposals.
- Wrong assumptions: that all node types have data (payments do not today).
- False positives: a story over a false CONFIRMED link spreads the error to everything attached.
- Data: stable identifiers for shipments and documents.
- First: relationship statuses and the derived-view rule (no persistent graph store).
- Now? As a derived view of orders with confirmed relations only. No payment nodes yet.
5. Pattern detection.
- Could fail: false anomalies from small samples, seasonality, a change of accounting system, series resets.
- Wrong assumptions: that numbering is monotone and gap-free (it is not across branches, document types, cancellations).
- False positives: the highest-risk item in this document; every cause in section 9 produces false positives.
- Data: at least six comparable periods and a series model that does not exist.
- First: reliable single-period findings and delta tracking across imports (P4).
- Now? No. Design stays in this document; implementation last, after mutation tests exist for it.
6. Semantic mutation testing.
- Could fail: expected results that share the same author and assumptions as the engine pass trivially; mutations that are too clean.
- Wrong assumptions: that injected defects look like real ones.
- False positives: the harness itself can report false misses if identity matching is by string while the engine normalizes identities.
- Data: none new; needs the finding structure (family, subject, evidence refs) to compare.
- First: the Finding structure, or at least its identity and evidence fields.
- Now? Yes, immediately after the finding structure, and against the current engine first, to publish the honest baseline of exact recall.

### 12.2 The ten ideas in the earlier brief (several overlap with the six)
- Control totals as a locating layer: could mislead by a false sense of coverage; needs homogeneity first. Not now beyond a diagnostic table per market and currency.
- Temporal evidence: could fail by turning conventions into rulings; assumptions on date fields; false positives from timezone and export-time differences. Build the four-class output and the rule registry; no class 4 rules until sourced.
- Falsifiable findings: could fail by being decorative (wouldDisprove written but not testable). Make wouldDisprove a machine-checkable condition, tested by constructing the disproving file in a test. Build now.
- Three-axis model: could fail by producing combinatorial confusion in the UI; keep the policy table small and explicit. Build now.
- Residual explained not zeroed: see 12.1 item 1. Gaming risk if "explained" has a catch-all. Not as a headline now.
- Orphans and double consumption: see 12.1 item 2. Orphans need coverage; double consumption needs the cardinality rule. Orphans and the relation-multiplicity observation now (they need no Amazon rule); only a claim of violation waits for a sourced rule.
- Evidence authority: see item 3. Build the declaration-never-closes part now (already an invariant); the per-field authority table incrementally.
- Transaction story: see item 4.
- Patterns and coverage map: coverage map yes now (the engine already produces notes); patterns not now.
- Mutation testing: see item 6.

### 12.3 My own proposals (section 13)
Evaluated in section 13 together with their dependencies. A3 (delta) no longer conflicts with principle 1: see 4.4. In short: build mapping (P2) and coverage-to-action (P3) soon, deltas (P4) after the relationship engine, amount homogeneity (P5) before any amount work; do not build the auditor pack, calibration or the large-scale work now beyond measurements.

## 13. Additional ideas (kept to those that add customer value)

Each: problem, value, risks and assumptions, independent proof.

### A1. Value-profile column mapping with explained choices (the European languages)
- Problem: automatic mapping is 0 of 280 for de, fr, it, nl, pl in the simulation, 212 of 495 overall. The reasons are number, issue date and operation date columns not recognized (Appendix B): the header dictionary has no entries for those languages.
- Value: onboarding without manual steps in every market, each choice shown with its reason, a confirmation asked only when truly ambiguous.
- Risks: a wrong guess of gross, net or VAT corrupts everything later. Financial fields need two independent signals (header or value shape plus the arithmetic identity net plus VAT equals gross) or a confirmation. Never guessed.
- Proof: held-out files per dialect with an answer key; correct mapping rate, wrong-auto rate (must be 0), confirmation-asked rate; metamorphic tests (translated headers give the same result).

### A2. "What would settle it": coverage to action
- Problem: for month-only books the detection recall (any signal, old definition) is 76 of 143 (53.1%); 53 of the 67 misses are "Amazon invoice missing from the books" that the engine correctly will not conclude because the books end at 2026-10-31 and the report runs to 2026-12-04. The engine states the limit but not the cheapest way out.
- Value: for each unknown, name the single export that would make the check decidable ("export your books through 2026-12-04: N checks become decidable"). Blind spots become a step. It makes the coverage map actionable.
- Risks: must not imply that more data will produce findings; it says only that the check becomes decidable.
- Proof: simulate the second export; the number of NOT_OBSERVABLE items that become decided must equal the prediction exactly.

### A3. Period-over-period delta with reopen detection
- Problem: customers care about what changed since the last import and whether a closed item came back. Identity and replay are specified in 4.4: stable key from subject identity, deltas from prefix replay, with retention, successor, renumbering, versioning and cost limits stated there.
- Value: a monthly routine (new, resolved by evidence, reopened, unchanged), which is the recurring value and what makes the product hard to replace.
- Risks: stable identity across exports; a renumbered series can look like mass change.
- Proof: two-period mutation tests with known resolve and reopen events; exact transition table.

### A4. Amount homogeneity model (prerequisite, not a feature)
- Problem: item-level report amounts versus invoice totals, shipping and gift wrap, multiple VAT rates, per-line versus per-document rounding.
- Value: stops plausible-but-wrong differences before they reach the customer.
- Risks: market-specific rules and incomplete rule sets; unknown means NOT_COMPARABLE.
- Proof: synthetic documents with several rates and rounding policies; no false difference when arithmetic is consistent; every injected real difference found with the exact field.

### A5. Not building now (and why)
- Auditor pack (reproducible case file): worth it only after findings carry evidence and wouldDisprove in machine form; building it earlier freezes a format that will change.
- Confidence calibration by defect type: needs the exact-recall baseline first; sparse types give meaningless intervals.
- Scale work beyond measurement: first record projection time at 5k, 10k and 20k rows (Appendix C); optimise only if the measurement shows a problem. Measured so far: 2.2 to 6.0 seconds at 3,000 to 5,000 rows.
- Payment nodes and tax-authority integrations: no data, no source of truth.

## 14. Phases, dependencies, risks (nothing starts before approval)

Phase 0 (the import-deletion defect) comes first and fixes the existing engine. The first phase that adds capability is phase A, and its improvement is visible and provable: the 11 DATA_MISMATCH on non-business orders come back as reconciliation items with REVIEW, with no B2B accusation. It needs no relationship engine and no new data model, only the axes added as fields on today's findings.

| Phase | Content | Depends on | Visible result and proof | Main risks |
|---|---|---|---|---|
| 0 | Import-deletion defect (4.4), its own defect with its own failing-before test: a recorded delete event, a permanent incomplete-history marker on every finding whose history passed through the deleted import, no path that silently turns CLOSED into open or removes a finding. The characterization script becomes the test | none | The three cases in evidence/import-deletion fail today and pass after | history must be sound before phase A adds axes onto findings |
| A | Axes (domain, applicability, observation, materiality, actionability) as fields on current findings, policy table 7.4 as data; seller materiality declaration (no default); restore the 11 DATA_MISMATCH as DATA_RECONCILIATION R1 decided by materiality; duplicate severity and priority; the 38 BOOKS_GAP as R4/R6 items | none | The 11 listed by seller, order, field: absent before, present after as accounting-discrepancy SELLER_ACTION; negative control: no B2B_OBLIGATION finding on any non-business order and no wording of a tax obligation; first test of the phase: the import-deletion behaviour (4.4); old tests keep passing as projections | the R4 action level for the 38; priority labels have no external source |
| B | Mutation harness with mechanical expectations, negative controls, collateral-damage test, dumb reference checker; baseline exact recall of the CURRENT engine and of phase A, published | A (the policy table is the lookup) | An honest exact-recall number per defect type, and a list of reference-checker disagreements | harness identity matching; shared misreading (stated in section 10) |
| C | Relationship statuses and components, orphans, relation multiplicity observation (R12, R13), wrong-order promotion if the diagnosis of the 20 supports it | A | Components shown for swapped pairs as one conflict; the 20 diagnosed first | component size; PROPOSED shown as confirmed |
| D | Tax period assignment and the correction chain | C | PERIOD_AMBIGUOUS and chain observations on synthetic corrections | unsourced tax rules: only candidates and ambiguity until a SOURCE exists |
| E | Mapping by value profile (A1) and coverage to action (A2) | A | Auto-mapping rate for de, fr, it, nl, pl with wrong-auto at 0; settle-it prediction equals outcome | wrong financial mapping |
| F | Amount homogeneity (A4), amount classes, control totals | C, D | No false difference on consistent documents | false PROVEN_MATCH |
| G | Deltas via replay (4.4), successor relation, retention event; measure replay cost first | C | Two-period transition table exact on mutation tests | history rewritten by import deletion; cost |
| H | Patterns | G, six or more periods of history, series model | After mutation tests for each pattern type exist | false anomalies |
Phase B can start in parallel with A once the policy table is agreed, because exact recall can be computed on today's findings (family, subtype, subject identity and mismatch field names exist already).
Each phase ends with: branch, head SHA, test names and counts, what fails before and passes after, what is not done. No merge and no deploy without his review.

## 15. Decisions needed from Ahmed

1. The policy table in 7.4, row by row. The business flag no longer affects any action outside the B2B domain. Uncertain rows: B5, the R1 priority bands, the R4 action level for the 38, R13, R14, L9.
2. Confirm the three axes with five check domains, and Applicability per domain replacing the single business-flag verdict.
3. The 38 non-business BOOKS_GAP as R4/R6 (SELLER_ACTION worded about the books when the declared scope covers the document; a coverage item otherwise).
4. The deltas decision in 4.4: replay without a persisted ledger now, and a rebuildable snapshot cache only if the measured cost requires it. Does he accept that exception in advance?
5. Tax period: accept that the engine reports candidate periods and ambiguity only, and states no return assignment, until a verified SOURCE exists per country. Who verifies the country rules?
6. The cardinality rule for any claim of violation (one invoice per shipment or consolidation allowed): I will not decide it from memory.
7. The customer-facing claim in 11.2 (Checked share with its remainder).
8. Independence: accept the method in section 10 and its stated limit, or require a real de-identified cycle before any production claim (the strategy already requires one).
9. Phase order (phase 0, the import-deletion fix, first), and whether phase B starts in parallel with A.
10. Materiality (7.2a): confirm the dimension; that the seller declares one absolute threshold per currency at onboarding with no default; the field classes AMOUNT_TAX, IDENTIFYING, TIMING; the UNDETERMINED fallback (REVIEW, amount shown, no escalation); the summary line for immaterial items; that business orders move from unconditional SELLER_ACTION; and that materiality never lowers a ledger-integrity finding.

## Appendix A. The 7 items proven per Order ID and Document Number

The earlier statement about 7 lost follow-up items (sellers 180 x5, 365, 375) rested on seller-level totals. Per item, in evidence/all-fixes/out/lost7-proof-per-item.json, with the round-2 files only:
- The Amazon row for the order carries the document number, and exactly one books row (row number given) carries that number.
- The engine reports no issue for that order or number, and its match count equals the Amazon invoice count (seller 180: 20 of 20, seller 365: 120 of 120, seller 375: 31 of 31).
- Control: remove only that one books row and rerun on the same files. The match count drops by exactly one (19, 119, 30) and the engine states a coverage limit (the books period 2026-10-02 to 2026-10-31 ends before the report day 2026-12-04).
Items: 180: 679-7236031-2000014 / FA-2026-0002, 232-7236043-2000098 / FA-2026-0014, 619-7236049-2000141 / FA-2026-0020, 161-7236046-2000119 / FA-2026-0017, 179-7236050-2000148 / FA-2026-0021; 365: 130-1185256-2000522 / A74; 375: 564-6335423-2000162 / F000023.
What this shows: these 7 are matched by number, so "no issue" is the correct engine state. What it does not show: why they were counted as lost. The follow-up expectation counted a todo as lost when no issue existed for it, including when the problem had been fixed and everything matched. That is a flaw of the follow-up metric, not of the engine. Round 1 for these items held no stored issue for the same reason as before (a coverage note is not stored as an issue) and I did not check that item by item.
Correction: in an earlier report I wrote the seller-180 count as 23 of 23 and 131 of 131 for 365. The per-item run with round-2 files only gives 20/20 and 120/120 (the earlier figures came from the store that also held round 1). The per-item file is the source.

## Appendix B. Auto mapping by language (V5 results)
Recognized without manual choice: en 65/65, en-th 44/45, en-us 50/51, es 53/55; de 0/55, fr 0/54, it 0/58, nl 0/54, pl 0/58. Top reasons for the zero languages: number column MISSING, issue date MISSING, operation date ABSENT in fr, pl, nl; operation date ABSENT, VAT ABSENT, order reference ABSENT in de, it. Meaning: the column-name dictionary has no entries for those languages. Source: evidence/all-fixes/out/results-v5.jsonl, field mapping.

## Appendix C. The 20,001 rows
Sellers 77 and 388 (scenario truncated_over_20000_rows) have 20,001 data rows. The supported limit is 20,000 (LEDGER_MAX_ROWS in src/loop/ledger.js and VIDR_MAX_ROWS in src/loop/pilot.js). Preflight fails with VIDR_ROWS and LEDGER_ROWS, the harness records outcome truncated_preflight_only and stops, so no projection runs and no timing exists. It is a deliberate refusal tested for, not a measurement gap hidden in a total. The projection timing that does exist: 2.2 to 6.0 seconds for sellers with 3,000 to 5,000 rows (sellers 30, 250, 400). Nothing is measured between 5,000 and 20,000 rows (P7).
