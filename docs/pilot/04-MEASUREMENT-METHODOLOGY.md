# Measurement methodology

## What is measured and where it comes from
| Metric | Source | Label |
|---|---|---|
| Manual investigation minutes (before) | Seller stopwatch | SELLER_REPORTED |
| Minutes with InvoiceGuard | Seller stopwatch | SELLER_REPORTED |
| Findings (total, by family, by state) | The engine, from the files | computed |
| Confirmed real / false positive / could not confirm | Seller checks each finding | SELLER_REPORTED |
| Confirmed missing invoice or accounting gap | Confirmed-real findings of the families "books gap" and "unmatched document" | SELLER_REPORTED |
| Missed by the tool (false negatives) | Seller count of real problems found another way | SELLER_REPORTED |
| Cannot Determine cases | The engine (cannot determine + needs human reading buckets) | computed |
| Resolved by subsequent imports | A later file shows the finding gone | MACHINE_VERIFIED_BY_LATER_FILE |
| Seller says resolved | Seller statement | SELLER_REPORTED |
| Findings that could not be independently confirmed | "could not confirm" plus not yet reviewed | SELLER_REPORTED / count |

## Rules
- Precision among reviewed = confirmed real / (confirmed real + false positive). Shown with the number reviewed. Not extrapolated.
- Recall is not computed. Only a count of missed problems is reported, and it depends on the seller having found them.
- Time saved = before minus with, both by the same seller on the same period. One seller proves nothing about other sellers.
- Both times must be entered. An empty box is never treated as zero; with a missing time the time result is shown as unavailable and no minutes saved is computed.
- The scope (number of marketplaces and periods, period length) is derived from the stored files and written into the aggregate. Nothing in the file claims a number of sellers.
- A seller declaration is never presented as verified. Declared things (complete export, report created after upload) stay "declared".
- If numbers are poor, they are reported as poor. A pilot that shows no measurable value is reported as such.
- The aggregate file holds no order ids, document numbers, dates, file names, hashes or free text. The export refuses to build if any free text is present (tested).

## What the pilot can and cannot show
It can show whether, for the one marketplace and period stored in the vault, the tool found real problems, how many were false alarms, and whether it was faster than the manual pass. It cannot show market-wide accuracy, Amazon acceptance, or compliance.
