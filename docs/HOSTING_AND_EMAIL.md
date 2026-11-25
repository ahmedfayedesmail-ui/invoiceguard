# Hosting and email decision (checked 2026-11-25)

## Host: Northflank Sandbox (recommended), conditional on two checks at signup
Official page: https://northflank.com/pricing . Sandbox plan: Free, "No card needed", always on, no sleeping, up to $20/month of resources, 2 services, 2 jobs, 1 database, free TLS on a code.run domain. Persistent disk costs $0.11657 per GiB per month, billed against the allowance.
Fit: 0.5 vCPU / 1 GB plan is $12/month and a 1 to 2 GB volume is about $0.12 to $0.23, so it fits inside $20.
NOT verified (the pricing table cell for volumes on the free plan did not render): that a persistent volume can be attached on Sandbox. First action after signup is to create the service with a volume. If that asks for a card, stop.
Other hosts, rejected: Render free (no persistent disk, data lost on restart, sleeps after 15 min, outbound mail ports blocked), Koyeb free (no volumes, sleeps, card hold), Railway and Fly.io (trial, then card), Oracle Always Free (best specs, but card at signup and prepaid or virtual cards are refused), Google Cloud (card).
Capacity: about half of one core. Measured on 1 core: 1,020 new signups/min with p95 0.3 s. On 0.5 vCPU expect roughly half the password-hashing rate (about 15 to 20 logins or signups per second), so 1,000 brand-new signups per minute is at the edge; returning users (cookie, no login) and normal pages are far cheaper.
Never sleeps, so the hourly sync scheduler runs. Data lives on the volume; restarts keep it. No automatic backups on this tier: copy the SQLite file out regularly (open item).

## Email: not for v1
Free tiers exist: Resend 3,000/month and 100/day (no card), Brevo 300/day (no card, account approval). Both need a sending domain you own and can edit DNS for. Resend refuses to send to anyone but the account owner until a domain is verified; Brevo wants the visible sender domain authenticated. We have no domain, so v1 uses in-app notifications only.
What this gates: email verification at signup, password reset by email, seller alert emails. All three wait for a domain (about 10 USD a year) plus Resend free (preferred) or Brevo free. Until then: password reset is an operator action (tools/reset_password.mjs), and alerts are in the app (dashboard banner and Radar).
