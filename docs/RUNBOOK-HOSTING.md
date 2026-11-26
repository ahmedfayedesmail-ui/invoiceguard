# Hosting migration runbook (W5)

Purpose: move InvoiceGuard off Railway the same day the trial credit runs
out or free limits are hit, at zero cost, without losing seller data.
Facts below were re-verified on 2026-11-26; re-verify before acting, free
tiers change without notice.

## What must move

- The app: stateless Node server, `Dockerfile` at repo root
  (`CMD ["node","src/app.js"]`). Any Docker host works.
- The state: ONE SQLite file (`DB_FILE`, on Railway it lives on the
  volume mounted at `/data`). Everything else rebuilds from it.
- Required env on the new host:
  - `APP_SECRET` (session cookies; rotate only if you accept logging
    everyone out)
  - `ADMIN_TOKEN` (the /admin routes)
  - `OPERATOR_NAME` and `OPERATOR_EMAILS` (public pages stay 404-hidden
    until OPERATOR_NAME is set)
  - `DB_FILE` (path to the SQLite file on the new host's disk)
  - `PORT` if the host requires a specific one
  - `COOKIE_SECURE=1` behind HTTPS
- The public URL changes (we are on a railway.app subdomain). Every place
  the old URL appears must be updated; see "URL change checklist".

## Candidate free hosts (verified 2026-11-26)

1. **Render free web service** - https://render.com/docs/free
   - Free, no card required. Custom domains + managed TLS included.
   - Catches: spins down after 15 min idle (about 1 minute cold start on
     the next visit); **no persistent disk on the free plan**, so the
     SQLite file must be snapshotted off-box (see step 2/6); monthly
     bandwidth/pipeline-minute caps apply.
   - Verdict: fastest zero-card fallback, acceptable for a pilot with
     low traffic; cold starts are the cost.

2. **Fly.io Free plan** - https://docs.fly.io/about/free-plan
   - $1 one-time credit without a card (expires after 7 days); $5/month
     of usage **only after adding a credit card**.
   - Verdict: viable technically (Machines + volumes fit us perfectly),
     but the card requirement conflicts with the standing zero-cost /
     no-personal-accounts rule. Needs Ahmed's explicit go-ahead first.

3. **Oracle Cloud Always Free** (Ampere A1 ARM VM) -
   https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
   - Genuinely always-free VM, big enough to run us for years.
   - Verdict: signup demands phone verification and identity data -
     blocked by the standing rules. Do NOT attempt without Ahmed.

4. **Cloudflare Workers + D1** - free tier, no card, but the app is a
   long-lived Node server; it would need a real port to the Workers
   runtime and the D1 API. Multi-day project, not a same-day fallback.

Decision for the runbook: **Render free** is the primary fallback;
Fly.io only if Ahmed approves a card on file; Oracle is off-limits.

## Migration steps (target: same day)

1. Pull the current database:
   `curl -s $OLD/admin/db-snapshot -H "Authorization: Bearer $ADMIN_TOKEN" -o backup-$(date +%F).db`
   (admin token in the vault; never commit the snapshot - it contains PII)
2. Create the Render web service: New -> Web Service -> from the GitHub
   repo, Docker runtime, plan **Free**. Region closest to EU users.
3. Set env: `APP_SECRET`, `ADMIN_TOKEN`, `OPERATOR_NAME`,
   `OPERATOR_EMAILS`, `COOKIE_SECURE=1`, `DB_FILE=/var/data/app.db`
   Real-data gates (round-8): `ALLOW_MANUAL_UPLOAD=1` opens sellers uploading
   their own order reports, `ALLOW_LIVE_CONNECT=1` opens direct Amazon
   connections. BOTH stay unset while the pilot is sample-data-only (that is
   what the homepage and FAQ promise); set them only when the real-data gate
   decision is made.
   HARD DEPLOYMENT INVARIANT: exactly ONE app process may run against the
   SQLite file at any time. The dedupe and claim guards assume it (the
   per-seller sync lock is in-memory; the database indexes back it up, but
   the check-then-act guards serialize only inside one process). Never run a
   second replica, a overlapping deploy, or a local copy against the same
   file. On Railway this means a single replica with no rolling overlap.
   (pick any writable path; free plan has no disk, so the file lives in
   the container and is rebuilt from the snapshot on each cold start -
   see step 6).
4. First deploy: let it build from the repo Dockerfile.
5. Seed the database: `POST` the snapshot bytes to a one-off admin route
   or, simpler, run the service once with the snapshot baked into the
   image layer via a build arg - then DELETE it from the image history.
   Simplest reliable path: start fresh, then re-upload the dogfood order
   reports through the UI; seller accounts = signups must be redone
   (acceptable in an emergency, not acceptable as a plan - hence step 6).
6. Because the free plan has no disk: add a scheduled job (this agent's
   recurring sweep) that pulls `/admin/db-snapshot` to the offline
   archive after any day with writes, so a cold start can restore from
   the latest snapshot instead of starting empty.
7. Smoke-test the new host: `node tools/campaign.mjs --live <new-url>`
   equivalent checks - landing 200, /api/sample/run ok, login works,
   OPERATOR pages visible.
8. URL change checklist (update every appearance):
   - X profile @InvoiceGuardEU bio + pinned post
   - Quora profile bio + edit the live answers' footer link (answers 1-3)
   - Reddit profile (after verification completes)
   - Proton signature invoiceguardapp@proton.me
   - This repo: README + any docs referencing the old URL
   - The recurring sweep's health-check URL
9. Announce the move on X (one post, no drama: "new home, same tool").

## Standing constraints (from Ahmed, do not cross)

- Zero cost: no card on file, no paid tier, ever, without his say-so.
- No phone-verification flows; stop and report if a host demands one.
- No accounts carrying his name, country or personal email.
- The anonymity rule applies to the new host's account details too.

## Backups and audit anchoring (updated 2026-11-26, round 2)

What exists today, stated precisely:

- **Automatic snapshots**: the app itself runs a backup on boot and every 6 hours (`src/backup.js`, disable with `BACKUPS_OFF=1`). Each snapshot first checkpoints the WAL into the main file, then copies that single crash-consistent file into `<db dir>/backups/`, keeping the newest 14. `npm run backup` runs the same code by hand.
- **Restore test**: `npm run restore-check` restores the newest snapshot into a scratch file and verifies SQLite integrity, table counts and every audit chain. Run it after any deploy that touches data code. A backup that was never restored is a hope, not a backup.
- **Audit anchoring**: `npm run audit-anchor` prints every seller's audit-chain head AND appends it to `backups/anchors.log`, a file outside the database, so a rewritten chain shows as a mismatch without trusting the database.
- **What this is NOT yet**: the snapshots and the anchors log live on the same Railway volume as the database, so a volume loss takes both. There is no free off-host storage in this deployment; until there is, the operator downloads a snapshot off the host regularly (see the admin db-snapshot step above). That is the honest residual risk.
- The snapshots contain personal data: never commit or publish them.

## Off-server backups, restore drill and recovery (round 25)

- **Off-server copy**: `.github/workflows/backup.yml` runs every 12 hours. It pulls `/admin/db-snapshot` with the operator token, runs the restore drill, encrypts the snapshot (AES-256, PBKDF2) and keeps it as a workflow artifact for 30 days. Repository secrets needed: `APP_URL`, `ADMIN_TOKEN`, `BACKUP_PASSPHRASE` (24+ random characters, also kept by the operator: without it the copies are unreadable). A failed run emails the repository owner. Decrypt: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in FILE.enc -out snapshot.db`.
- **Restore drill**: `npm run restore-drill -- snapshot.db` validates the snapshot (SQLite integrity, tables, every audit chain), copies it to a fresh location, boots the real app on it and checks it answers. Exit code 1 on any failure. Run after every schema change and whenever you doubt a backup.
- **Restore into production**: `curl -X POST $APP/admin/db-restore -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary @snapshot.db` validates and STAGES the snapshot (nothing live changes). Then redeploy or restart the service. At boot the staged file is re-validated, the current database is kept as `backups/pre-restore-*.db`, and the snapshot replaces it. Everything written after the snapshot is lost, so tell affected sellers.
- **Seller account recovery**: no email service yet, so each account gets 8 one-time recovery codes at signup (shown once, stored as hashes). `POST /api/recover` {email, code, next} resets the password, ends all sessions and keeps two-step sign-in on. Sellers make new codes in Account security (needs the password). A seller with no code and no email path is recovered by the operator with `RESET_EMAIL` / `RESET_PASSWORD` (see `src/reset.js`) after the operator is satisfied the request is genuine.
