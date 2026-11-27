# RECONCILIATION-LAB-REPORT (night mission WP6, Nov 27 2026)
Branch: research/invoiceguard-reconciliation-lab, commit d1074b7, created from 7380abf (the Phase B head after WP3). It adds two files only: lab/reconcile/reconcile-lab.js and test/reconcile-lab.test.js (plus lab/perf/perf-night.mjs, WP7). It is not connected to issuance, the app, the database or the bundle, and it must not be merged into PR #3. Not approved for integration.  CI for 7380abf (the base) finished with success (run 46069866165).

## What it is
A pure, deterministic prototype of docs RECONCILIATION-ARCHITECTURE.md for synthetic input: VIDR rows, order rows, our invoices and credit notes, and later Amazon status rows. Input contracts are documented at the top of the module and every amount is a raw string parsed with the Stage 1 parser (exact BigInt cents, so unreadable stays UNKNOWN and never zero).

## What it does
- Links: PROVABLE (same shipment key, invoice stores its shipment key, status that matches the document number AND the TransactionId verbatim, order item matching exactly one shipment), CANDIDATE (status with number only, order item in several shipments, order without an item match), none (order not in the VIDR). Every link carries the rule that made it.
- Per shipment: expected, invoiced, credited, accepted (ACCEPTED only with a verbatim status; otherwise NOT_CONFIRMED or REJECTED), unexplained (exact cents, UNKNOWN, or NOT_INVOICED), the evidence (document, line), the findings and what needs a human.
- Contradictions: currency differs, item amount differs between order report and VIDR, two ordinary invoices (BLOCK), rejection, unexplained amount. Both sides are shown and neither is chosen.
- Reproducible: the output carries a digest (SHA-256 of the output). The digest covers the order of the evidence lists, so two input orders give the same content but not necessarily the same digest; the test compares a normalized form and says so.

## Tests (local): 13 tests, 13 pass, 0 fail
Clean path; number without TransactionId is a candidate; no status is never accepted; unknown never zero; not invoiced; unexplained with sign; credit note explains; double invoice BLOCK; rejection; candidate versus provable order links; contradictions; failure inputs; reproducibility and order independence; a 300-world random property.
The tests passed on the first run, so I ran three manual mutations (accept any TransactionId, ignore unreadable amounts, disable the double-invoice rule): each made at least one test fail (1, 2 and 1 failures). Three mutations are not a full mutation test.

## Failure cases it does not solve
Partial refunds across two invoices, an item split across shipments with different prices, several statuses for one document in one report (the last by attempt sequence is not implemented), amounts in several currencies in one document (UNKNOWN), and anything that depends on the real content of an Amazon report. It models one gross column per row, not the item, shipping, gift wrap and promo parts.

## Recommendation
Do not build it before Stage 2 and before at least one real de-identified VIDR and a later report exist. The first useful piece is the all-PROVABLE VIDR to our-documents view.
