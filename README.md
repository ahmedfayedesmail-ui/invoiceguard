# InvoiceGuard

[![CI](https://github.com/ahmedfayedesmail-ui/invoiceguard/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmedfayedesmail-ui/invoiceguard/actions/workflows/ci.yml)

Invoice helper for Amazon sellers who sell across EU countries. It watches shipments, checks that each invoice has what the rules ask for, issues the invoice as a PDF, and holds anything it is not sure about instead of guessing.

**Status: v1 pilot.** Amazon connection is in demo mode only (simulated, nothing is uploaded to Amazon, VAT checks in demo data are not live lookups). Nothing here is tax advice. Always confirm with your own adviser.

Live pilot (private): https://invoiceguard-production-b715c82a.up.railway.app

## What it does
- Detects shipments and creates the matching invoice, with sequential numbering and a tamper-evident audit log.
- Checks buyer VAT numbers against VIES when asked, and holds shipments that need a human decision (name mismatch, unregistered buyer, missing data).
- Shows a plain-English dashboard: what was invoiced, what is held and why.
- Keeps country rules as living data. Every rule has a source, a verified date and a status (`verified`, `secondary`, `unverified`). A rule that is unverified or past its review date blocks issuing instead of being assumed. See `rules/` and `docs/`.
- Corrections (credit notes) and KSeF (Poland) test-environment payloads. KSeF checks so far are against the TEST environment only, which is not production verification. See `docs/KSEF_TEST_NOTES.md`.

## Run it locally
Needs Node 22 or newer.

```
npm ci
npm test            # all tests should pass
node src/app.js     # http://localhost:3000  (public landing page; the app is at /app)
```
Public pages: `/` (landing), `/privacy`, `/contact`. Set `OPERATOR_NAME`, `CONTACT_EMAIL` and `OPERATOR_COUNTRY` for them.

Environment variables:

| Name | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DB_FILE` | SQLite file path (default `invoiceguard.db`) |
| `APP_SECRET` | Long random value that encrypts stored Amazon credentials. Required for live credentials |
| `COOKIE_SECURE=1` | Mark the session cookie Secure (use behind HTTPS) |
| `NO_RULE_CHECK=1` | Skip the daily rule-source check (tests, offline use) |
| `RESET_EMAIL`, `RESET_PASSWORD` | One-time operator password reset applied at boot, see below |

## Deployment (Railway, no card)
The repo ships a `Dockerfile`. On Railway:
1. New project, deploy from this GitHub repo (Railway's GitHub app limited to this repo).
2. Variables: `APP_SECRET` (random), `COOKIE_SECURE=1`, `PORT=8080`, `DB_FILE=/data/invoiceguard.db`.
3. Attach a volume mounted at `/data`. The Dockerfile must not contain a `VOLUME` line (Railway rejects it).
4. Generate a public domain targeting port 8080.

The app keeps its data in one SQLite file, so it needs a persistent volume and a single always-running instance. On Railway's Free plan services sleep when idle and have a small monthly credit; see `docs/HOSTING_AND_EMAIL.md`.

## Password reset without a shell
There is no email channel yet. To reset an account after confirming the person's identity yourself: set `RESET_EMAIL` and `RESET_PASSWORD` (12+ characters) on the host and restart. The reset runs once at boot, signs the account out everywhere, and is remembered, so a later restart does not overwrite a password the person changed. Remove both variables afterwards.

## Security
Origin checks on all writes, HttpOnly + SameSite + Secure cookies, security headers, request size limits, per-account login lockout, 12-character passwords with history, optional two-step sign-in (authenticator app), buyer data removed from order records 30 days after shipment. Amazon checklist: `docs/SP-API-SECURITY-CHECKLIST.md`, no secrets in logs. Details and known limits: `docs/SECURITY.md`. Performance numbers: `docs/PERFORMANCE.md`.

## Known limits
- Live Amazon connection is untested against a real seller account.
- Poland and Netherlands rule packs are held until primary legal texts are read. France's 2027 rules are held as a safety measure.
- Defect-rate figures in the UI are our own estimate.

## Connect with Amazon (public app)
Off by default. After Amazon approves the app, set `SPAPI_APP_ID`, `SPAPI_CLIENT_ID`, `SPAPI_CLIENT_SECRET` and `SPAPI_REDIRECT_URI` (https URL of `/oauth/amazon/redirect`; `SPAPI_BETA=1` while the app is a Draft). Register `/oauth/amazon/login` as the OAuth Login URI and the redirect URL as the OAuth Redirect URI. Tested only against a simulated Amazon.

## Upload route (the product today)

InvoiceGuard is not connected to Amazon. The seller downloads an order report from Seller Central, uploads it here, and downloads a pack of invoices to upload to Amazon themselves.

- **Accepted files** (tab-delimited text, detected by their header): the Order Report with the buyer tax columns switched on, and the VAT Invoice Data Report.
- **Refused:** the All Orders report. It has no buyer name, address or VAT number.
- **Verified vs not.** Column names come from Amazon's developer documentation (report type pages). They have NOT been checked against a real downloaded file yet. Every column we cannot verify is optional, and a missing required value holds the order with a reason. See `docs/PILOT-SELLER-STEPS.md` for how a pilot seller sends us only the header line.
- **Holds (never guessed):** missing billing address (unless the seller ticks "use the delivery address"), promotion discounts, a VAT rate that does not read cleanly from price and tax, rows of one order that disagree, a buyer VAT number without a country, a failed VIES or name check.
- **VAT amounts** come from the report exactly as Amazon states them. They are reliable only if the seller is in Amazon's VAT Calculation Service, so the seller ticks that before invoices are created.
- **Pack** (`GET /api/pack`): PDFs, `manifest.csv`, `HOW-TO-UPLOAD.txt`. The upload steps are worded generically because Seller Central menu names differ and we could not verify the current one from Amazon's own pages.
- **Statuses:** invoices are `ready` until the seller presses "I uploaded these" (`POST /api/invoices/mark`). The app cannot know whether Amazon accepted them.
- The SP-API/OAuth code is dormant: it needs SPAPI_* variables and has no visible UI unless they are set.
- Public pages (`/`, `/privacy`, `/contact`) are served only when OPERATOR_NAME and CONTACT_EMAIL are set. Until then `/` redirects to `/app`.
