# Repeatable pilot procedure

Roles: the seller runs everything. The developer only supplies the page and receives the aggregate file.

## 0. Before touching InvoiceGuard: the "before" measurement
The seller does the normal manual investigation of the period (find invoices Amazon shows as missing or rejected, find Amazon invoices missing from the books, find mismatches) and notes:
- total minutes spent (a stopwatch, started and stopped by the seller, not an estimate afterwards if avoidable);
- the list of problems found, kept in the seller's own notes (not given to us).
This is the baseline. If the seller cannot do the manual pass first, the pilot compares against the seller's own estimate and that is recorded as an estimate.

## 1. Security gates (see 05-SECURITY-PREFLIGHT.md). Stop if any fails.

## 2. Preflight (staged, before anything is stored)
Each file is chosen, read in memory and declared. "Check before storing" runs the preflight on that file (and against the other stored file, once there is one). Nothing is written to the browser's storage until the seller presses "Store this file". A FAIL blocks storing. Each WARN must be acknowledged with a tick. "Re-check the stored files" in the pilot card repeats the same check on everything stored, and the aggregate file records its result.
Checks: source type (seller-declared Amazon VAT invoice report; the tool reads the table but cannot verify where the file came from; all statuses), one period of at most 92 days, the accounting export covers the period, same marketplace, the accounting export declared complete, files readable. FAIL stops the pilot. WARN is explained to the seller.

## 3. Import and read
Import the two files. Record the minutes from import to the end of reading the findings ("with InvoiceGuard" time, stopwatch).

## 4. Adjudicate every finding
For each finding the seller checks the real documents and marks one of: CONFIRMED_REAL, FALSE_POSITIVE, COULD_NOT_CONFIRM. These are the seller's statements (SELLER_REPORTED).
Then the seller states how many real problems they found by other means that the tool did not show (missed by the tool). That count is the only false-negative evidence available. Recall cannot be computed from it and is not reported.

## 5. Follow-up import (optional, later)
After the seller acts, a newer Amazon report and accounting export may be imported. A finding is "resolved by a subsequent import" only when the new files show it gone. That is the only machine-verified result. A seller saying "fixed" is recorded as SELLER_REPORTED.

## 6. Export, then delete
Create the aggregate results file (numbers and fixed words only; see 04). The seller reads it, then decides whether to send it. Then the seller may delete the imports or the whole workspace. Deletion is logical (records removed from the browser's storage). Physical erasure from the disk is not guaranteed by any browser.

## 7. Write-up
The assessment is written from the aggregate file plus the seller's own words, with the sample size stated: one seller, one period.

## Scope rule
One pilot is one marketplace and one reporting period (taken from the first Amazon report stored). Follow-up imports must be for the same marketplace and period; otherwise the preflight blocks them. If the stored files cover more than one marketplace or period, the aggregate file refuses to build. Use a separate vault for a different period.

## Whole-dataset rule
The staged check compares the pending file with every stored file, not only the latest one. "Re-check the stored files" and the aggregate use the whole stored dataset: at least one Amazon report and one accounting export must exist, every Amazon report must be in the pilot marketplace and period, every accounting export must be in the pilot marketplace and cover the period, and every file must pass its own checks. If any blocking check fails, the aggregate file is not produced. WARNs stay WARNs and are listed (acknowledged when storing).
