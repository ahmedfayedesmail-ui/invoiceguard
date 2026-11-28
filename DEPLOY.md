# Deploying InvoiceGuard at zero cost

Needs: Node 22+ (uses built-in node:sqlite), a persistent disk for the SQLite file, a long-lived process (the hourly sync scheduler runs inside it), HTTPS.

Run locally: `npm install && node src/app.js` (package.json has no start script), open http://localhost:3000.

Environment: PORT, DB_FILE (path on a persistent disk), and a server secret for credential encryption. APP_SECRET is required: the server refuses to store live Amazon credentials until it is set to a long random value. Losing it makes stored Amazon credentials unreadable.

Hosting options to evaluate (free-tier terms change, confirm current limits before relying on any):
- A free VM tier from a major cloud (persistent disk, runs the scheduler 24/7). Best fit.
- A container platform with a free plan and a mounted volume, using the included Dockerfile. Many free plans sleep when idle, which would pause the hourly sync, and some have no persistent disk. Avoid those for production.
- His own always-on machine behind a tunnel, for a private pilot.

Before real sellers: copy the app's same-host snapshots (every 6 hours) off the host, keep HTTPS on, and complete Amazon's Tax Invoicing role approval.

## Current host: Railway (Northflank was evaluated on 2026-11-25 and not used), see README.md and docs/HOSTING_AND_EMAIL.md
Build from the Dockerfile in a Git repo, mount a persistent volume at /data, set APP_SECRET (long random, stored as a secret), and keep COOKIE_SECURE=1. Operator password reset without email: tools/reset_password.mjs.
