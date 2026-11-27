# InvoiceGuard engine v2: architecture proposal (for critical review, nothing here is implemented)

Status: proposal only. No engine code is changed on this branch. Base: integration/all-fixes 4be64e7. Synthetic data only. Nothing is merged, nothing touches main.
Direction: from "does the invoice number match?" to "do we hold a complete, evidence-backed explanation of what happened in this transaction, and do we say plainly what we could not explain and what would change the conclusion?"

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

1. Only imports and seller events are stored; everything else is derived by project() (today's invariant, kept). The graph, the timeline, the explained-mass ledger and the findings are derived views.
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
Confirmed relations are directional facts of the files. Probabilities exist only in rank order of proposals; they are never stored as a score that can be mistaken for confirmation.

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

## 5. Temporal model

Four times on every event: event time (when it happened), record time (when the source recorded it), import time (when the seller loaded the file), as-of time (the report's created time or the export's time).

Four classes, never mixed:
1. Normal delay: event-to-record gap within a documented window. No finding.
2. Missing coverage: the file's period or scope does not reach the event. NOT_OBSERVABLE, named, with the exact boundary (for example books period ends 2026-10-31, report day 2026-12-04).
3. Temporal contradiction: dated facts that cannot all hold under the data contract. Shown as CONTRADICTORY, to review.
4. Proven violation: only where a rule with a stated SOURCE defines the deadline or order and the evidence meets it.
Every temporal rule has an id, version and SOURCE or CONVENTION label. A CONVENTION can create class 2 or 3 outputs. It cannot create class 4. Example: a credit note dated before its invoice is class 3 at most, to review, because document types, local rules and what the date column means vary. "One business day" for invoice issuance is Amazon policy as the seller-facing documentation states it; it is never presented as law.

## 6. Reconciliation engine

### 6.1 Relationship engine (not a forced one-to-one match)
Stages:
1. Candidate generation: for each LedgerDocument and each Shipment, collect candidate pairs from identifying keys (document number, transaction id when present) and from corroborating signals (order reference, date, amount, currency, buyer tax id).
2. Link grading: an identifying key agreeing makes CONFIRMED unless contradicted. Corroborating signals alone make PROPOSED. A key pointing two ways makes CONFLICTING.
3. Components: build the connected components of the candidate graph. Each component is judged as a unit. This is what prevents errors from creating new errors: a swapped pair of documents between two orders is one component with a conflict, not two unrelated mismatches.
4. Cardinality check per component by rule. Document types differ: a consolidated invoice can legitimately cover several shipments in a seller's books; a shipment normally has one invoice at Amazon (my recorded reading of Amazon's documentation says the invoice is due per shipment; re-verify the source before any rule depends on it, until then it is a CONVENTION). A violated rule makes the component CONFLICTING with all members listed. It does not assign blame to one member.
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

### 6.4 Double consumption under n:m
Consumption is conservation: the amount a document can cover versus the amount of the shipments linked to it. A document that covers more than its linked shipments, or shipments covered more than once, is a CONFLICTING component or a PARTIALLY_EXPLAINED amount, depending on whether the document type permits n:1. Without an amount (not comparable) the engine reports the relation anomaly only, and says the conservation check could not run.

## 7. Three-axis finding model

### 7.1 Check domains
B2B_OBLIGATION, LEDGER_INTEGRITY, DATA_RECONCILIATION, COVERAGE, SOURCE. A check belongs to exactly one domain.

### 7.2 Axes
| Axis | Question | Values |
|---|---|---|
| Applicability | Does this domain's rule apply to this subject? | APPLIES, NOT_APPLICABLE, UNDETERMINED, always with rule id and deciding fields |
| Observation | What does the evidence show? | PRESENT, ABSENT_PROVEN, NOT_OBSERVABLE, CONTRADICTORY |
| Actionability | What can the reader do and for whom? | NONE, REVIEW, SELLER_ACTION, WAIT, with priority |
Actionability is set by a policy table per domain and defect type. It is never computed from Observation alone. SELLER_ACTION in B2B_OBLIGATION requires Applicability APPLIES.

### 7.3 Effect on the 49 and the 124
- is-business-order FALSE sets B2B_OBLIGATION NOT_APPLICABLE for the shipment. LEDGER_INTEGRITY and DATA_RECONCILIATION remain APPLIES.
- The 11 DATA_MISMATCH return as DATA_RECONCILIATION, Observation PRESENT, Actionability REVIEW. No B2B accusation.
- The 38 BOOKS_GAP: B2B NOT_APPLICABLE. As reconciliation facts they apply only if the declared scope of the books includes the order's channel and period; then Observation PRESENT, REVIEW, low priority, with the fact, context and date kept. If the scope does not cover them, Applicability UNDETERMINED and the output is a coverage item. Decision 3 in section 15.
- Duplicates (all in LEDGER_INTEGRITY, independent of the business flag):
| Case | Severity | Review priority | Meaning |
|---|---|---|---|
| EXACT_REPEAT, level DOCUMENT | MEDIUM | HIGH | repeated accounting record that needs review |
| SAME_NUMBER_DIFFERENT_CONTENT | HIGH | HIGHEST | conflicting records sharing a number; differing fields listed |
| SUSPECTED_DUPLICATE, level unknown | UNRESOLVED | HIGH | establish what a row is; one question to the seller |
| Repetition at LINE level, header fields agree | NONE | NONE | natural for a line export; counted only in the coverage map |
| LINE level, header fields disagree | HIGH | HIGH | rows of one document disagree on whole-document data |
Never worded as a B2B violation or a confirmed duplicate invoice without the evidence that supports "invoice" (document level and content).

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
6. Independent dataset protocol: generator seeds and defect mixes are frozen and hashed (the hash is committed) before any fix is written against them; they are run once per release; a failure is reported and the dataset stays frozen (it may be replaced only by a new hashed one, with the old result kept). I am the author of both the mutators and the engine, so independence is partial. The step that would make it strong is a second person writing expected results from Amazon's documentation without seeing the engine.
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
9. False-confident count per domain (SELLER_ACTION that is wrong; must be 0 on negative controls).
10. Hold-out result, reported with the dataset hash.
100% is never presented as an engine improvement. The move from 930/1008 to 884/884 was a denominator change: 124 findings left the measured scope (46 true, 78 declaration-dependent).

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
- Orphans and double consumption: see 12.1 item 2. Orphans need coverage; double consumption needs the cardinality rule. Orphans now (they need no Amazon rule), double consumption after the rule is sourced.
- Evidence authority: see item 3. Build the declaration-never-closes part now (already an invariant); the per-field authority table incrementally.
- Transaction story: see item 4.
- Patterns and coverage map: coverage map yes now (the engine already produces notes); patterns not now.
- Mutation testing: see item 6.

### 12.3 My own proposals (section 13)
Evaluated in section 13 together with their dependencies. In short: build mapping (P2) and coverage-to-action (P3) soon, deltas (P4) after the relationship engine, amount homogeneity (P5) before any amount work; do not build the auditor pack, calibration or the large-scale work now beyond measurements.

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
- Problem: customers care about what changed since the last import and whether a closed item came back.
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

| Phase | Content | Depends on | Main risks |
|---|---|---|---|
| 0 | Honest baseline: new mutation harness and metrics run against the current engine; exact recall published | none | the harness mislabels identity; mitigate by testing the harness on known cases first |
| 1 | Finding structure (family, subject, evidence refs, counter-evidence, wouldDisprove, unknowns) and the three axes behind the current engine; old output mapped onto them | 0 | regression in existing tests; mitigate: old and new outputs equal on all fixtures |
| 2 | Relationship statuses and components (CONFIRMED, PROPOSED, CONFLICTING); orphans | 1 | components grow large; UI must never show PROPOSED as confirmed |
| 3 | DATA_RECONCILIATION on non-business orders (the 11), LEDGER_INTEGRITY severity table, the 38 reclassified | 1, 2 | scope judgement for the 38 (decision 3) |
| 4 | Mapping (A1) and coverage to action (A2) | 1 | wrong auto-mapping of financial fields (gate: arithmetic identity or confirmation) |
| 5 | Amount homogeneity (A4), then amount classes and control totals | 2 | false PROVEN_MATCH; market rules |
| 6 | Deltas (A3), then double consumption once the cardinality rule is sourced | 2, 5 | identity across exports; unsourced Amazon rule |
| 7 | Patterns (section 9) | 6 and six or more periods of history | false anomalies; highest risk of the programme |
Each phase ends with: branch, head SHA, test names and counts, what fails before and passes after, what is not done. Mutation and negative-control suites grow with each phase. No merge and no deploy without his review.

## 15. Decisions needed from Ahmed

1. Confirm the three axes with five check domains, and that Applicability per domain replaces the single business-flag verdict.
2. Confirm the duplicate table in 7.3, including NONE for line-level repetition with agreeing headers.
3. For the 38 non-business BOOKS_GAP: reconciliation facts only when the declared scope of the books covers the order; otherwise a coverage item. This is a scope judgement he may read differently.
4. Confirm that pattern detection stays design-only until phase 7.
5. Confirm the metric names and that V1 to V5 stay untouched.
6. The cardinality rule (one invoice per shipment or consolidation allowed): I must not decide this from memory. Which source of truth does he accept, and who verifies it?
7. Can the hold-out dataset be reviewed by a second person, given partial independence?
8. Order of phases; whether to strike A2 to A4 or add others.


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
