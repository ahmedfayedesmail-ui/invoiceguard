# Audit: the 83 (V1 false-confident, scenario line_level_ledger_declared_document_wrongly)

All counts local. Forensics only, no fix. V1 to V5 files untouched.

## 1. What the number is
83 findings = 83 distinct document numbers, built from 213 ledger rows, in 14 sellers.
Per seller: 24:9, 59:3, 94:11, 129:4, 164:6, 199:4, 234:11, 269:7, 304:9, 339:3, 374:4, 409:3, 444:6, 479:3.
Family DUPLICATE_DOCUMENT / EXACT_REPEAT, state ACTION_REQUIRED. Counted by document number. Not shipments, not transactions (each document links to its transaction ids in cases.json).

## 2. Where it came from
Same as the 59: engine c3baa5a, harness efa0fc1, seed 0, fingerprint 9f268f4d7fc1, `tools/audit-v1.sh`.
The other "83" Ahmed noticed, matchedByInvoiceNumber = 83 in a Follow-up state, is a different number: V1 seller 31 (follow_up_seller_declares_resolved) has buckets.matchedByInvoiceNumber = 83. It is unrelated, a coincidence of value.

## 3. Cases
audit/duplicates-83/cases.json and cases.csv: document number, Amazon transaction ids, order ids, shipping ids, marketplace, per case.

## 4. Evidence and counter-evidence
- Engine evidence: in all 83 the rows of a document are byte-identical (number, date, currency, total, net, VAT, order), and the seller declared in the import that one row is one whole document. Under that declaration, repeated identical rows are a duplicate.
- Counter-evidence IN THE FILES: none. 
- The generator's hidden metadata says each document has 2 lines (36 documents) or 3 lines (47). That is the only proof that the declaration was wrong, and it is harness metadata, not file evidence.
- Verdict: wrongness is NOT demonstrable from the files. By the audit rule these are not yet "cases of proven error". The finding is that the engine believed a seller declaration, and the harness penalised it for believing it. Nothing was removed from the count.

## 5. Causes (two, kept separate)
a) Engine, by design: it trusts the seller's documentLevel declaration (programme item 4 would derive the level from evidence).
b) Harness V1: multi-line documents were emitted as identical rows. v2 gives each line a different amount, so a real multi-line ledger would not look like this.
Whether a real ledger can produce byte-identical lines of one document is unverified.

## 6. Counterfactual (not a fix)
Current engine (8665d52) on the same V1 files: DUPLICATE_DOCUMENT/EXACT_REPEAT x83, state OPEN (not ACTION_REQUIRED). The finding still exists but is no longer confident. See audit/current-engine-on-v1-files.json.

## 7. Addendum: why the current engine says OPEN, and what locks it
- ACTION_REQUIRED became OPEN because of a RULING, not evidence: commit 06e5496 "Ledger Data Quality for ALL duplicates (business and non-business): information only, never ACTION_REQUIRED for duplication alone" (src/loop/project.js line 171 area: `ldq = true`, safeAction false, section LEDGER_DATA_QUALITY, label "Repeated accounting record candidate"). Related: 3bcf30c.
- The subtype is still EXACT_REPEAT, and it still rests on the seller's declaration. Nothing in the engine now tests whether the declaration is true.
- Locked by test/combined-regression.test.js "combined 3" (non-business), "combined 5" (changed to the ruling) and "combined 14" (added). Failing-before check, local: that file run against 06e5496^ fails tests 5 and 14; at 8665d52 all pass.
- Not locked: that a seller-declared DOCUMENT level with identical rows is never confident. The ruling covers all duplicates by policy, so the 83 are safe now, but via the policy, not via document integrity.

## 8. What would settle whether the 83 are wrong (programme item 4, document integrity)
For the 83 to be provably wrong, the files would have to show that the repeated rows are lines of ONE document, not copies. Any one of these present in the file would do:
- a line, item or position column that differs between the rows (line number, SKU, ASIN, description) while document number and header totals repeat;
- row amounts that sum to the document total once, so total = sum of rows, while each row repeats the same total (header total repeated per line);
- Amazon-side evidence for the same order: the VIDR shows one transaction with N items, or N transactions whose totals add to the document total;
- a seller-declared level that contradicts such a column (declaration DOCUMENT, file shows a line column).
Today none of these is present in the 83: rows are byte-identical across every column the export has. So the files can show "identical rows" only; whether it is a duplicate or a multi-line document is genuinely undeterminable from them.
Is confidence defensible when it rests solely on the seller's documentLevel declaration? No, not for a confident action against the seller: a declaration is the seller's own statement and can be wrong (here it was, per generator metadata). It is defensible only as a labelled candidate that says it rests on the declaration, which is what the current card does (information only, "not called a duplicate invoice until the rows and the document level are confirmed"). Classification: programme item 4 (derive the level from file evidence; a conflict lowers confidence or blocks), not an open error count. Hence 83 = "not demonstrably wrong from the files; confidence rested on the seller's declaration" and stays a finding of design, not a measured error.
