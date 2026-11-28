# Operations and recovery (local)
Setup: Node 22, `npm ci`. Test: `ls test/*.test.js | grep -v -E "vault-ui|loop-ui|local-engine|history-idb" | xargs node --test --test-force-exit --no-warnings` (about 100 s). Campaign: `node tools/campaign.mjs --no-live`. Demo (synthetic): `npm run demo`. After editing bundled sources: `node tools/build-local.mjs`.
Diagnose a stuck correction: GET /api/holds (what is held and why), GET /api/repairs (reviewed retries), the events table (stale_report_verdict_skipped, credit_note_hold, credit_note_verdict_not_applied, issue_blocked_by_credit_note_hold).
A hold: read the explanation, compare the report row with our stored credit note, then POST /api/holds/decide with the item's key, code, fingerprint and a reason of 10+ characters. The decision lifts the block only. The next matching report is evaluated again from scratch; changed evidence changes the fingerprint and needs a new decision.
Backup and restore: tools/backup.mjs, tools/restore-check.mjs, tools/restore-drill.mjs (existing). The production backup workflow is untouched. There is no backup-age watcher or alerting in the code: backup age is not monitored automatically, so the operator checks it by hand. A restore proof is a separate human-run drill: HTTP 200 or a present artifact is not a restore proof.
Not verified here: a real reboot recovery, a second PID namespace, live Amazon.

## Trigger migration note (re-review 2, P3)
openDb upgrades the invoice_uploaded_is_terminal trigger when an older definition is stored. If the upgrade hits a locked database it is skipped silently and retried at the next open (next boot or next process start). Until then an older database keeps the older rule: a seller-declared rejection of an uploaded invoice is refused there. Check with: SELECT sql FROM sqlite_master WHERE name='invoice_uploaded_is_terminal' (it must contain NOT IN ('uploaded','rejected')).

## Unknown upload outcome (ruling 5)
Nothing resends an unknown outcome automatically. Check the document and the feed in Seller Central, then in Repairs record who checked, when, what you found, the feed id and status, tick the residual risk box and authorize ONE retry. The authorization is used by the next resend only. A late-landed document is confirmed in its own LATE_FEED hold instead. B2 is not closed.
