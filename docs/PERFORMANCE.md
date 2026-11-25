# Performance, measured 2026-11-25 (load test of the real server)
Machine: 1 vCPU, 2 GB RAM. The load generator ran on the same CPU, so these numbers are conservative. VIES was replaced by a stub with a fixed 120 ms delay (the real VIES is slower and rate limited). Amazon was the built-in simulator. Tools: perf-tools/ (server.mjs, load.mjs, run.sh). Example: perf-tools/run.sh 4500 10 8 50 dashboard,sync,pdf,login

## Before -> after (40 concurrent connections)
| Endpoint | Before | After |
|---|---|---|
| Sync (no new shipments) | 478 req/s | 1,426 req/s |
| Invoice PDF | 175 req/s | 4,299 req/s (cached) |
| Dashboard | ~1,570 req/s | ~1,830 req/s |
| Login (scrypt) | 32 req/s, froze the whole server for up to 1.7 s | 33 req/s, longest pause 0.1 s |
| VIES calls for 770 syncs | 1,552 | 2 |

## "1000 users per minute"
Open-loop test: 17 new visitors per second (1,020 per minute), each doing login, profile, dashboard, sync, dashboard, PDF (6 calls).
- 1,020 visits/min: 258 of 258 completed, 0 errors, a visit takes 45 ms (p50), 52 ms (p95), event-loop pause 2 ms.
- 1,680 visits/min: 0 errors, but visits queue behind logins: p50 2.5 s, p95 4.2 s.
- 300 and 1,500 concurrent connections, mixed traffic: 0 errors. Reads stay fast (me: 4,600 req/s at 1,500 connections). The slow tail (p99 8 to 14 s) is logins waiting for a turn.
- First sync for 40 new sellers at once (invoice creation, PDF, audit chain): 80 invoices in 1.1 s, about 70 invoices/s, 0 errors.

## What breaks first
Password hashing. scrypt costs about 30 ms of CPU per login or signup, so one core does about 33 per second whatever we do. We did not weaken it. Sessions last 14 days, so real users log in once, not every visit. Next step if logins ever become the limit: more CPU cores (HASH_PARALLEL) or a second process.

## What changed (root cause)
- Password hashing moved off the request loop onto the thread pool, behind a bounded queue (503 "busy" when full). Same scrypt settings, old hashes still verify. Same work for unknown emails (no timing hint).
- Login throttle: 8 wrong tries per address+email per 15 minutes, then 429. (Behind a proxy the address is the proxy's: set it up to pass the client address before relying on the per-address part.)
- Signup race fixed: two signups with the same email now give a clean 409, not a 500.
- VIES: answers cached (valid 6 h, not-registered 10 min, outages never cached), identical lookups merged, at most 6 in parallel. A buyer who fixes their VAT number is re-checked fresh, and the "check VAT" and watch buttons never use the cache. The audit trail keeps VIES's own timestamp.
- Invoice PDFs cached by document hash (64 MB cap, identical renders merged).
- SQLite: WAL mode, busy timeout, prepared-statement reuse, indexes on events, shipments, invoices, checks and sessions. One query for the session lookup. Expired sessions are purged hourly.
- Dashboard: counts come from SQL (exact) and the lists are cut to the latest 500, with a plain "Showing your latest 500 of N" note. Radar list cut to 500, counts exact.
- Overload guard: above 400 requests in flight the server answers 503 with Retry-After instead of hanging. Request and header timeouts set.
Not tested: real VIES, real Amazon, more than one core, a database with millions of rows.

## Final gate, 2026-11-25 (current build, 1 vCPU, load generator on the same CPU)
- Closed-loop, 40 connections: page 10,370 req/s, /api/me 10,020, dashboard 3,185, rules 1,433, radar 4,887, sync 1,566, invoice PDF 6,722 (all 0 errors). Login (scrypt) 38/s with p50 1.25 s at 40 concurrent. Mixed traffic 574 req/s, p95 124 ms, p99 1.7 s (logins). Server memory about 219 MB.
- Open-loop, new visitors each doing signup, seller setup, connect, sync, dashboard, PDF (6 calls): 1,020 visits/min: 256 of 256 completed, 0 errors, p50 48 ms, p95 301 ms, p99 425 ms. 1,680 visits/min: 329 of 329 completed, 0 errors, but p50 2.2 s and p95 4.2 s because signups queue on password hashing.
- Meaning: 1,000 new visitors per minute is handled without errors or hangs on one core; the limit is password hashing at roughly 30 to 40 per second per core. More cores scale it. Real VIES is slower than the 120 ms stub used here.
- Rule-source check now runs in parallel: 44 rules checked in 20 s here (was several minutes); 14 sources unreachable from this machine, which the app reports as unreachable and does not treat as a pass.
