# Threat model (credit-note and correction flow), written by the implementing agent, NOT independent
Assets: issued fiscal documents and their numbering; Amazon-visible state; evidence ledger; backups.
Actors: a stale or replayed Amazon report; a wrong-seller or malformed report; two concurrent processes (sync and approval); a crash mid-send; a reviewer reusing an old decision; a UI that overstates.
| Threat | Control now | Residual |
|---|---|---|
| Foreign or wrong row marks our credit note accepted | identity gate before ANY status change (Processing, Rejected, Uploaded) | real Amazon column shapes unseen; missing invoice-number column = HOLD |
| Stale report overrides newer state | attempt_seq and report-order guards | relies on authenticated report sequence |
| Replacement issued around a hold or race | DB triggers inside the writing transaction | an already-issued replacement is not auto-cancelled (by design) |
| Accepted document re-sent or revived | terminal-state trigger (new) | none known in code; paths unproven in production |
| Old human decision reused | evidence-snapshot fingerprint | none known |
| Crash between claim and send | sending claim + boot recovery to unknown + human hold | no real reboot test |
| Backup missing or stale | watcher alerts at 8 h and 13 h; keeper prototype (separate branch) | restore not proven by the watcher |
| UI states more than the system knows | not reviewed in this wave | see W2 plan |
Out of scope here: auth/session security of the web app (see docs/LOCAL-DATA-SECURITY-THREAT-MODEL.md), Stage 2, Document Seal.
