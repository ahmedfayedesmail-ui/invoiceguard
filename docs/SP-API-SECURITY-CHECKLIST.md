# SP-API pre-submission security checklist
Source: Amazon "Key Security Control Guidance" (developer-docs.amazon.com/sp-api/lang-US/docs/guidance-to-address-key-security-controls-in-sp-api-integration), read 25 Nov 2026.
Amazon's own 14 registration questions appear only inside the registration form and were not read. Re-check this list against them.
Status: DONE (in code, tested), PROCESS (a task for the operator, not code), OPEN (not done), ASK (needs Amazon's or a lawyer's answer).

| Control | Status | Note |
|---|---|---|
| Password at least 12 chars, mixed case, number, symbol, not part of the name | DONE | signup and change. Existing accounts keep old passwords until changed |
| Password history of last 10 | DONE | /api/password |
| Maximum password age 365 days | PARTLY | account page tells the user to change it. Sign-in is not blocked. Decide if Amazon wants a forced change |
| Minimum password age 1 day | OPEN | not enforced |
| Multifactor authentication (TOTP) | DONE, optional | Amazon says "for all accounts". Today each user chooses. To comply we must make it required for accounts that touch Amazon data |
| Lock account after 10 or fewer failed logins | DONE | 8 per IP and email, 10 per account, 15 minute window |
| Encrypt SP-API credentials at rest, AES-128 or better | DONE | AES-256-GCM. Key comes from APP_SECRET, a host variable, not a key-management service. ASK whether that meets "secure key management" |
| Encrypt in transit, TLS 1.2+ | DONE | Railway HTTPS. Not independently tested |
| Delete buyer PII 30 days after delivery | DONE for order records | shipments table and VIES names. We only know the shipment date, not delivery |
| Issued invoices contain buyer name and address | ASK | Tax rules may require keeping invoices for years. Amazon's guide allows keeping data where the law requires it. We have NOT decided this. Ask Amazon at the architecture meeting and the seller's accountant. Do not claim full PII deletion until answered |
| Non-PII kept at most 18 months | OPEN | rule data and invoice totals need a retention decision (same legal question) |
| Security logs kept 12 months minimum | DONE in the database, PARTLY | sign-in, failed sign-in, lockout, password and two-step events kept 13 months. They live in the same database as the data, so an attacker with database access could alter them. An off-site copy is OPEN |
| Bi-weekly log review | PROCESS | calendar task for the operator |
| Monthly vulnerability scan, anti-malware updates | PROCESS | needs a tool and an owner |
| Quarterly access review, device inventory, backup restore test | PROCESS | same-host snapshots run on boot and every 6 hours; an off-host backup and a restore test are OPEN |
| Annual key rotation (encryption key) | DONE, manual | set APP_SECRET_PREVIOUS to the old value and APP_SECRET to a new one, restart, then remove APP_SECRET_PREVIOUS. Boot log warns after 335 days. Amazon API key (client secret) rotation is done in Amazon's portal and then in our settings: OPEN to document |
| Annual penetration test and third-party assessment | OPEN | costs money. Ask Amazon what a small provider needs |
| Security training for approved users | PROCESS | |
| Incident notice to security@amazon.com in 24 hours | PROCESS | write an incident plan |
| Disable leavers within 24 hours | PROCESS | single operator today |
| Never store PII on personal devices or public cloud links | PROCESS | operator rule |
| Public OAuth login and redirect endpoints | BUILT, untested against Amazon | /oauth/amazon/login, /oauth/amazon/redirect. Tested with a simulated Amazon only. Off until SPAPI_APP_ID, SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REDIRECT_URI are set after approval |
| Logo and public website with company details | PARTLY | pages built, held until operator details arrive |

## Status note
The product currently runs on the manual upload route. No Amazon credentials are collected or stored on that route, and the SP-API/OAuth code is switched off. This checklist applies only if direct Amazon access is switched on later.
