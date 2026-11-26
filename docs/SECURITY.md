# Security notes (InvoiceGuard v1 prototype)

What is in place
- Passwords: scrypt with per-user salt, async on a bounded queue. Same work for unknown emails (no account enumeration by timing).
- Login throttle: 8 wrong tries per IP+email and 30 per account per 15 minutes, then 429.
- Sessions: random token, HttpOnly, SameSite=Strict, Secure over HTTPS (or COOKIE_SECURE=1), 14-day expiry, purged on a timer, deleted on logout.
- CSRF: cross-site Origin on any non-GET request is refused (403), on top of SameSite=Strict.
- Headers: nosniff, no-referrer, X-Frame-Options DENY, CSP (default-src self, frame-ancestors none, base-uri none, form-action self, object-src none).
- Inputs: body caps (64 KB, 8 MB for PDF upload, PDFs up to 5 MB), non-object JSON refused (400), internal errors never leak their text (500 generic, detail in the server log), rule-pack refusals are 422.
- Fuzzed every API route with junk bodies: no 5xx.
- Tamper-evident hash chain over issued documents (detects edits after issue; not a Verifactu record).
- Overload guard: 503 above 400 requests in flight.

Known gaps (honest)
- CSP allows inline script because the UI is a single file.
- No email verification or password reset (needs an email channel; open decision).
- Single SQLite file, one box. Automatic same-host snapshots run on boot and every 6 hours; an off-host copy is still open.
- Per-account throttle test does not isolate the per-account counter.
- Hosted demo is a browser simulation and does not run this server.
Not tax or legal advice. Test-environment checks (KSeF TEST) are not production verification.

Final gate fuzz (2026-11-25): every API route with junk bodies against a seller with a connected, synced demo store. Found and fixed 500s on release and retry without a shipment key. Network-bound routes (rules/check, watch/run, vat/check) were tested for 5xx only with a few bodies.
