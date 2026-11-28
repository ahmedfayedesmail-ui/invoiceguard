# Backup keeper (PROTOTYPE, design only)

Status: prototype on branch `ops/backup-keeper-design`. Not deployed. No account exists, no GitHub App exists, nothing here contacts GitHub, ntfy or Healthchecks. `DRY_RUN` is the default.

## What it does
A Cloudflare Worker with a cron trigger (example: every 15 min) and a D1 database. Each cycle:
1. Takes an atomic lock in D1.
2. Reads the runs of the backup workflow and their artifact METADATA (never the artifact itself).
3. If the last good run is older than 7 h and nothing is queued or running and the cooldown is over, it records the dispatch in D1 first, then dispatches ONE `workflow_dispatch`.
4. Matches the dispatch to the run that appears (correlation). No run within 15 min = alert. 3 misses in a row = the keeper halts and says so.
5. Alerts through ntfy on: recovery dispatch, dispatch failure, workflow failure or timeout, missing/expired/empty artifact, backup older than 13 h (critical, repeated at most every 6 h), heartbeat ping failure. A warn state (8 h) is logged only. A healthy cycle sends nothing.
6. Pings Healthchecks only after a cycle that finished (a skipped or crashed cycle does not ping). Healthchecks itself alerts when the pings stop, which covers the case where the Worker or cron is dead.

Thresholds: dispatch 7 h, warn 8 h, critical 13 h (`DEFAULTS` in `worker.js`).

## Files
- `worker.js` cycle logic (providers injected), `providers.js` real providers (inert, GitHub App token minting is deliberately not implemented until the owner creates the App), `schema.sql` D1 schema, `wrangler.toml.example`, `test/` 31 tests, `cpu-measure.mjs`.
- Run: `node --test --test-force-exit --no-warnings ops/backup-keeper/test/keeper.test.js` (Node 22+, no dependencies).

## Setup (when the owner decides to go live; nothing here is done)
1. Owner creates a GitHub App with Repository permissions Actions: Read and write (needed to read runs/artifacts metadata and to dispatch) and Metadata: Read-only (default), installs it on the `invoiceguard` repository only. No personal access token, no fine-grained PAT. The Worker mints a short-lived installation token each cycle from the App private key.
2. Owner creates a Cloudflare account (free plan), a D1 database, applies `schema.sql`, sets secrets with `wrangler secret put`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `NTFY_TOPIC` (long random string, the topic is the only access control), `HEALTHCHECKS_URL`.
3. Leave `DRY_RUN = "true"` for the first days. Read the `dispatches` table. Only then set it to the string `false`.
4. Wiring `providers.js` to the App token is an open task and needs review before any live use.

## Security
- Never reads or stores `APP_URL`, `ADMIN_TOKEN`, `BACKUP_PASSPHRASE`; never downloads an artifact (a test checks the source for those names and for artifact download URLs).
- Notifications contain only the run number and a generic sentence (a test checks for URLs, tokens, repo name).
- Least privilege: App on one repo; Actions:write is the smallest permission that allows `workflow_dispatch`.
- The ntfy topic and the Healthchecks URL are secrets of the Worker, not in the repo.

## Consistency model (why not KV)
Workers KV is eventually consistent, so it cannot be a lock. D1 is one SQLite database behind a single writer; one UPDATE statement is atomic. The lock is `UPDATE state SET lock_until=?, lock_owner=? WHERE id=1 AND lock_until < ?` and the caller proceeds only if exactly one row changed. The dispatch itself is claimed with a second conditional UPDATE (cooldown) BEFORE GitHub is called, so a crash after the claim at worst skips a dispatch for one cooldown, and never double-dispatches.
What is proven here: the SQL compare-and-set under 6 real OS processes on one SQLite file (L3), and the logic with mocks. What is NOT proven: D1's own behavior under concurrent Worker isolates. That follows from D1's documented single-database model, and must be confirmed with a real D1 test before going live. The mutation check: removing the lock condition makes L1, L3 and H2 fail. L2 and D1 pass even then (one connection serializes awaits), so L3 is the real evidence. Removing only the cooldown condition fails no test, because the lock already covers it (second line of defense).

## Residual race with GitHub's own schedule (NOT closed)
The production workflow has no `concurrency` group and must not be modified. The keeper skips dispatch when it SEES a queued or running run, but a native scheduled run can start between the keeper's read and its dispatch, or a run can be delayed so it is not yet visible. Then two backup runs overlap. The keeper does not and cannot guarantee that no two runs execute at once. Impact depends on how the backup writes its artifact (not analyzed here).

## Cost
Target: free. Cloudflare Workers free plan: 5 cron triggers per account, 10 ms CPU per cron invocation (https://developers.cloudflare.com/workers/platform/limits/). D1 free tier covers a few hundred rows. ntfy.sh and Healthchecks have free tiers. GitHub Actions minutes: one extra backup run per recovery.
CPU: `node cpu-measure.mjs` gives node CPU per cycle (mocks, in-memory SQLite): p50 0.13 ms, p95 0.17 ms, max 1.8 ms over 200 cycles. This is an indicator only. Network waits are not CPU, but JSON parsing of real GitHub responses, TLS and JWT signing (RSA) are, and none of those run here. The real number must be measured inside Cloudflare (Workers metrics) in DRY_RUN before going live. If it exceeds 10 ms and a paid plan is the only fix, stop and ask the owner.

## Known limits
- Only the keeper's own failure modes are covered by Healthchecks; a wrong threshold or a wrong workflow file name is not.
- Artifact check is metadata (exists, not expired, size above 0). It does not prove the backup restores. Restore proof stays a separate, human-run test.
- Dry-run dispatch markers never become "no run seen" failures.
