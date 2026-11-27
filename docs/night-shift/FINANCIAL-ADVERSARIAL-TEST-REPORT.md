# FINANCIAL-ADVERSARIAL-TEST-REPORT (night mission WP2, Nov 27 2026)
All counts are local (this machine) unless a CI run is named. Synthetic data only. Test file: test/financial-adversarial.test.js (12 tests and 1 todo), plus test/issuance-paths.test.js (4) and test/db-governance.test.js (7). Generators use a fixed seed (20261127 for the lab, 7 for the lab-branch prototype), so every run sees the same cases.

## Method
Property style where a rule can be stated over many inputs, named cases where a single input is the point. Every defect found became a permanent test, written before the fix and run against the unfixed code (artefacts in audit/phase-b/).

## Coverage against the mission list
| Area | How it is covered | Where |
|---|---|---|
| Contradictory amounts | gross not equal net plus VAT, VAT sign flipped, rate mismatch | gate tests (65) + probe in this lab |
| Missing and ambiguous amounts | blank cells, "1,234", "1.234" are never read as numbers | parseAmount properties (6000 random tokens, 4000 round trips) |
| Separators | grouped and ungrouped, both decimal marks, up to 24 digits round-trip exactly to the cent | round-trip property |
| Negatives | negative-zero is inconsistent (held); NONPOSITIVE_TOTAL; a negative item with a positive total is NOT held (open gap, todo test R11) | named tests |
| Huge amounts | a gross above 999,999,999.99 per cell is held (AMOUNT_OUT_OF_RANGE); at or under it the issued total equals the file to the cent (60 random cases) | fidelity property |
| Repeated item ids, SKU and quantity | R10 duplicates, quantity 0, 1.5, 1e2, 007 held; SKU never a duplicate signal | gate tests + combination property |
| Conflicting metadata | field conflicts BLOCK, one entry per line, personal values never stored | gate + WP0 tests |
| Multiple currencies | mixed currency in a shipment BLOCK, unsupported currency HOLD, lowercase eur accepted as EUR (observation) | gate tests |
| Date problems | 2026-02-30, year 0001, 25/11/2026 held; far-future date 2099-01-01 is NOT held (observation, see risks) | probe |
| Wrong VAT rates | rate 0.5 held; a rate written as 21 (percent) is not provable and is noted, not held | probe |
| Repeated imports, corrected files, reappearing findings | idempotence (3 reruns same ledger and invoices), corrected file resolves and issues once, bad copy later reopens and is recorded | lab tests |
| Concurrent evaluation, repeated issuance | two evaluations at once create what one creates (in-process and two SQLite connections) | issuance-paths + db-governance |
| Hostile input | formula, script tag, SQL text, __proto__, NUL bytes, 5000 characters, bidi override in personal fields: no crash, nothing raw stored | lab test |
| Combinations | 60 random combinations of 1 to 3 injected defects over 2 to 4 rows | combination property |

## Defects found by the lab, all fixed with a test that failed first
1. Correction replacement used the first row when correction rows contradicted (issuance-paths test, fixed 2bfd48b).
2. Huge amounts: the gate reads exact cents but the invoice builder uses floating point: 149382714704938.26 was issued as 149382714704938.28 (fixed 71d52ae, AMOUNT_OUT_OF_RANGE).
3. The database accepted invalid decision rows; evidence was overwritten on change; the ledger write was not atomic (fixed 7380abf).
4. WP0: merged evidence entries for multi-line findings (fixed d0a47b7).
The test I wrote first for "a human decision does not authorize changed evidence" passed on the unfixed code (guard, not a failing-first test).

## Known gaps, not fixed (they need a decision, they are not defects of the approved rules)
- R11: a negative item, shipping or gift-wrap amount in a shipment with a positive total is arithmetically consistent and is issued. Todo test documents the wish.
- Far-future shipment dates are accepted (the rule set only checks that a date is a real ISO date and order against shipment date).
- A VAT rate written as a percent (21) is not compared (its unit is not provable).
- Precision limit 999,999,999.99 per cell is a precision limit, not a business limit.

## What this lab cannot show
It uses the synthetic fixture shape. It cannot show how real Amazon files behave, or that the rounding tolerance matches Amazon after the June 2026 shipment-level change (see COMPETITIVE-INTELLIGENCE.md section 1).
