# Remaining-risk register (class: Fixed / Safely blocked / External dependency / Owner decision)
| ID | Risk | Class |
|---|---|---|
| R1 | Real Amazon rows never seen: identity check may HOLD on real column shapes (missing invoice-number column, sequence) | External dependency (a real de-identified report) |
| R2 | Refund sign convention unknown | Safely blocked: any sign or amount difference = HOLD |
| R3 | An already-issued replacement is not cancelled when a later report contradicts the credit note | Owner decision (policy), currently safe: hold + human |
| R4 | Odd observed state transitions not proven impossible (F-SM-2) | Owner decision with Amazon evidence |
| R5 | No screen for the holds queue (API only) | Open, product gap, not a safety gap |
| R6 | No CI on the expedition branch (needs a PR) | Awaiting owner action |
| R7 | Race proof is timed rounds plus DB triggers, not exhaustive | Accepted limitation |
| R8 | Seller identity is not part of the report identity check | External dependency |
| R9 | Backup watcher cannot prove restorability; keeper is a prototype, not deployed | Awaiting owner (GitHub App, Cloudflare) |
| R10 | Stuck-claim branch not integrated, no real reboot test | Owner decision (revisit after Stage 1 review) |
| R11 | Independent review not done yet at the time of writing | In progress (Wave 3) |
No P0 known. P1 findings F-UX-1 and F-SM-1 fixed.
