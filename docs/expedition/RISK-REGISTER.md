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
| R11 | Independent review: 4 reviewers launched, reports pending | In progress (Wave 3) |
No P0 known. P1 findings F-UX-1 and F-SM-1 fixed.
| R12 | RETURN row carrying an Invoice* status is not covered by the owner decision on REFUND rows | Owner decision |
| R13 | Plain original-invoice InvoiceUploaded is accepted without the strict identity gate (gate is wired for correction documents only) | Owner decision |
| R14 | Claim ownership is heartbeat plus timeout, not a lease with fencing at Amazon: a process stalled longer than the grace between two beats could still lose its claim; the late result is then recorded and held, not prevented | Accepted, detected and held |
| R15 | N2 (future sending_at) and N3 (NULL sending_at within the grace) from re-review 1 not changed; a row with no readable claim time is recovered at once | Accepted, documented |
| R16 | processCorrections gives one sync error entry per sync for a pending correction with an open hold (noisy, not wedged) | Open, minor |
| R17 | Trigger hardening gaps: INSERT OR REPLACE, DELETE and kind swap on invoices are not covered by the terminal-state trigger (no live code path) | Open, minor |
| R18 | Repo comments labelled "Owner ruling" were not all matched against forwarded rulings | Open, listed for the owner |
| R19 | Duplicate feed if a process is suspended while its POST /feeds is in flight, or an abandoned request lands after the quiet period: Amazon holds two feeds for one number. Detected (LATE_FEED hold). Detected only: what a person can do in Seller Central about the duplicate is unverified (SP-API has no feed-cancel operation). No idempotency key exists | Accepted physical limit, owner awareness |
| R20 | N2 future sending_at and N3 NULL sending_at inside the grace (legacy rows only) | Deferred, low likelihood |
