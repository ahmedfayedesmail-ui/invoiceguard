# Amazon interaction assumptions - inventory and status

Every assumption the code makes about how Amazon behaves, where it comes from, how it is
enforced, and what is still unproven against a real seller account. Genuine documentation
means developer-docs.amazon.com and the official model files in
github.com/amzn/selling-partner-api-models. Round-7 audit, 2026-11-26.

## Feeds (UPLOAD_VAT_INVOICE uploads)

| # | Assumption | Source / status | Enforcement |
|---|------------|-----------------|-------------|
| F1 | CANCELLED means the feed never started processing; Amazon provably holds nothing, so a same-document retry is safe without classification | Feeds use-case guide, verbatim: "cancelled before it started processing... start again at Step 1". VERIFIED | `pollFeeds` CANCELLED branch -> `rejected` + reviewed retry proposal. Tests: record-key retry, interrupted correction retry, replacement-waits pair test |
| F2 | FATAL means "some, none, or all of the operations within the feed might have completed successfully" - it is never proof Amazon holds nothing, and never alone justifies a resend | Feeds use-case guide, verbatim. VERIFIED | `pollFeeds` FATAL branch -> `unknown` + human hold, no retry proposal; resend only through the settle path (fresh report still due + feed-list cross-check). Test: 'a FATAL feed is never treated as never-processed...' |
| F3 | A FATAL feed sometimes (not always) produces a processing report; its format can differ | Feeds use-case guide: "In some (but not all) cases Amazon generates a feed processing report". VERIFIED | When `resultFeedDocumentId` is present the report is downloaded and logged as evidence; it is never parsed for verdicts. Test asserts the fetch |
| F4 | getFeed/getFeeds only serve feeds created within the last 90 days - an orphan feed does NOT age out of the cross-check list | Feeds API reference (getFeed). VERIFIED | Human-resolution path: `unknown_hold_dismissed` event ( Repairs > dismiss ) clears the settle cross-check; hold texts name it. Misleading "ages out" comment removed. Tests: orphan dismissal flow, long-downtime test |
| F5 | getFeeds paginates: a returned nextToken must be sent ALONE ("Specifying nextToken with any other parameters will cause the request to fail"); filters belong to the first call only | Official model feeds_2021-06-30.json. VERIFIED | `listFeeds` sends nextToken alone, collects every page; page 2+ feeds are never invisible. Tests: 102 results over 3 pages, parameter shape per page |
| F6 | A feed list that does not converge (pagination never ends) must not be trusted | Conservative design (no Amazon doc needed) | `listFeeds` throws `inconclusive` after 10 pages; the settle cross-check treats a failed list as a HOLD, never as clear. Test: non-converging pagination rejects |
| F7 | Feed processing can take up to 8 hours | Feeds use-case guide. VERIFIED | No timeout-based resend anywhere; `submitted`/`processing` simply wait for the next poll |
| F8 | createFeed has no idempotency key: a network drop, timeout or 5xx after the last retry leaves the outcome UNKNOWN (Amazon may hold the document) | Absence in the official model; Feeds guide. VERIFIED | `uploadInvoice` flags non-4xx failures `unknownOutcome`; every caller marks `unknown` + hold instead of retrying. Tests: crash-window recovery on first upload, retry, correction retry |
| F9 | A 4xx on createFeed is a definite refusal - Amazon never accepted the feed | HTTP semantics of the SP-API error model; not an explicit Amazon statement for every 4xx. CONSERVATIVE | Definite refusals restore `rejected`, keeping the reviewed retry available. Test: 'a definitely refused retry...' |
| F10 | Upload throttle: at most 1 invoice per 3 seconds | create-and-upload-invoices doc. VERIFIED | `uploadInvoice` enforces a 3 s gap (`lastUpload`) |
| F11 | TotalAmount / TotalVATAmount must match the document totals at 2 decimals or the upload is rejected | create-and-upload-invoices doc. VERIFIED | Totals computed in cents, `toFixed(2)` on the feed options; campaign cases cover rounding |
| F12 | Feed option metadata accepts only a limited character set | SP-API feedOptions constraint. VERIFIED | `uploadInvoice` rejects invalid characters before sending |

## Reports (GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT, "VIDR")

| # | Assumption | Source / status | Enforcement |
|---|------------|-----------------|-------------|
| R1 | An all-status report request needs `reportOptions: {"ReportOption=All": "true"}` with `dataStartTime`/`dataEndTime` on day boundaries, spanning at most 30 days | create-and-upload-invoices doc example. VERIFIED | `requestVidr` builds exactly this shape. Tests in spapi.test.js |
| R2 | The pending-only shape is `{"ReportOption=pendingInvoices": "true"}` | Same doc. VERIFIED | Test in spapi.test.js |
| R3 | A FRESH report still listing an event as due (InvoicePending / CreditNotePending) is strong evidence Amazon holds nothing - but it can lag a feed that just entered processing, so the report alone NEVER clears a resend | Lag is a conservative assumption, not an Amazon statement. CONSERVATIVE | Every resend of an `unknown` document passes `unknownSettleCheck`: fresh report due + feed-list orphan cross-check anchored on the attempt start time. Tests: orphan block, FATAL/CANCELLED orphan asymmetry, long downtime |
| R4 | Report rows' `invoice-status` vocabulary: InvoicePending, InvoiceUploaded, InvoiceProcessing, InvoiceRejected, CreditNotePending, CreditNoteUploaded, CreditNoteProcessing, CreditNoteRejected, CreditNoteCreatedByAmazon | create-and-upload-invoices doc. VERIFIED for the listed values; new values would surface via the W12 unknown-type event | `processReport` / reconcile map each status; `invoice-status-description` column parsed when present |
| R5 | Amazon's transaction-type vocabulary is SHIPMENT / RETURN / REFUND; both RETURN and REFUND can put a credit note due | create-and-upload-invoices doc. VERIFIED | `detectRepairs` handles both; unknown types are logged (W12), never dropped silently |
| R6 | Billing-data corrections arrive as a CorrectionReversal REFUND + Correction:: SHIPMENT pair carrying transaction IDs; amounts unchanged | VIDR format documentation. VERIFIED for format; real-account pair timing UNPROVEN | `processCorrections` issues the pair and keeps it together: the replacement waits for the credit note's confirmed acceptance |
| R7 | Amazon expects the invoice within 24 hours of shipment | Amazon VCS policy. VERIFIED as policy | Drives sync cadence and landing copy ("Amazon policy", never "the law") |
| R8 | A report ends up DONE / FATAL / CANCELLED; a non-DONE terminal state fails the sync visibly | Reports API reference. VERIFIED | `waitReport` throws on CANCELLED/FATAL and after 60 x 15 s |
| R9 | The settle window must anchor on the moment the upload attempt STARTED, not on when the crash was discovered | Own design; closes the long-downtime hole found in round-7 review | `sending_at` column written before every Amazon call (first upload, both rectificativa paths, manual retry); `unknownSettleCheck` anchors on it with event-time fallback for pre-migration rows. Test: 2-hour downtime still blocks on the original feed |

## Identity, dedup, retention

| # | Assumption | Source / status | Enforcement |
|---|------------|-----------------|-------------|
| D1 | One financial document per (seller, number); a retry reuses the SAME number and the SAME Amazon TransactionId - never a second document | Amazon: the prescribed retry is the same document; rectificativa rules. VERIFIED | Unique document numbers; `issueRectificativa` reuse branch; cumulative-credit guard. Campaign 1005 cases |
| D2 | One repair proposal per (seller, event key); re-proposals re-open decided proposals but never duplicate open ones | Own design | `repairs` primary key + `INSERT OR IGNORE` / re-open logic. Tests |
| D3 | Local SQLite is the record of what was sent; a crash between Amazon accepting and the local write is always recoverable at boot | Own design | `sending` marker + `sending_at` BEFORE every Amazon call; `recoverUncertainUploads` + `recoverStuckRepairs` at boot. Tests simulate the exact interruption windows |
| D4 | Amazon keeps report and feed history long enough for next-sync reconciliation (feeds: 90 days, F4; reports: assumed similar, NOT verified) | Feeds verified; report retention UNVERIFIED | Nothing depends on reports older than the 30-day request window; the daily sync always re-requests |

## Unproven against a real Amazon seller account (pilot flags)

- U1 Real feed lifecycle timing, real FATAL frequency, and whether real FATAL feeds carry `resultFeedDocumentId`. Mock-covered only.
- U2 Real VIDR column variations across marketplaces and locales (the parser targets the documented English header set).
- U3 Real CorrectionReversal / Correction:: pair timing (same report vs split across reports).
- U4 The Amazon Tax Invoicing developer role is not yet approved: every production claim stays held until one complete real-seller cycle (real report -> invoice -> upload -> acceptance -> return -> credit note -> acceptance).
- U5 VCS upload acceptance criteria beyond the documented metadata (real-account rejection reasons may teach more).

## Concurrency and crash atomicity (round-8 audit, independent reviewer)

| # | Assumption | Status | Enforcement |
|---|------------|--------|-------------|
| C1 | Two executions can overlap (manual "Sync now" + hourly scheduler, retried request, sync + repair approval). The database, not the read-then-write order, decides who talks to Amazon | Verified real by reviewer reproduction | Atomic claim: every Amazon call is gated by `UPDATE ... SET upload_status='sending', sending_at=? ... AND upload_status IN (...)` - the loser changes 0 rows and skips. Unique indexes: one invoice per shipment, one correction document per Amazon event. Per-seller sync lock in the app layer. Tests simulate the interleaving across the awaits |
| C2 | A crash between a status write and its Repairs proposal must leave neither behind - a rejected/unknown document without its review is never revisited | Verified real by reviewer | Status write + proposal run in one SQLite transaction everywhere (pollFeeds CANCELLED/FATAL, reconcile verdicts, all unknown-outcome handlers). Test: fault-injected mid-transaction crash rolls back both, next poll completes them |
| C3 | One failing feed must never abort polling of the rest | Verified real by reviewer | Per-feed try/catch in pollFeeds: 404 (feed aged out of Amazon's 90-day feed API) gets the FATAL unknown+hold discipline; transient errors skip only that feed and are counted. Tests for both |
| C4 | A dryRun preview issues nothing | Verified real by reviewer | dryRun returns before issuance: no row, no audit entry, no burned number. Test asserts all three |
| C5 | Report amounts can be locale-formatted | Reviewer nitpick, handled conservatively | vidr num(): rightmost of '.'/',' is the decimal separator; tests for "1,234.56" and "1.234,56" |
| C6 | The upload throttle must also count failed attempts | Reviewer nitpick | `lastUpload` stamped before createFeed, not only on success |

C7. Feed processing reports (round-10, revised 10c): reports are downloaded and LOGGED as
evidence for the human reviewer, but NO automatic resend decision is ever taken from report
text - the real format is unproven against a live seller account and keyword matching lost to
realistic layouts in reviewer reproduction. A known-feed resend block lifts only on the feed
being CANCELLED (provably never processed) or on human dismissal after checking Seller Central.
The live-Amazon gate (ALLOW_LIVE_CONNECT) is enforced at oauth start, the OAuth callback, the
apiFor choke point (checked before the client cache), the /oauth/amazon/login and
/oauth/amazon/continue flow entries, sync entry and the hourly scheduler - mock-verified.

C8. VIDR beats feed (round-11, critic round-9): the invoice-status column is Amazon's
DOCUMENT-level statement; the feed status is FEED-level. When the report has stated
InvoiceProcessing/CreditNoteProcessing for a document (vidr_processing_at), a conflicting feed
state (FATAL, CANCELLED, aged-out 404) is logged as a feed_conflict event for a human - the
document never regresses toward resend (no unknown+hold, no rejected+retry). Without that current
verdict the feed discipline is unchanged: FATAL/404 means unknown + human hold, CANCELLED means
rejected + reviewed retry. The verdict timestamp is cleared at the ATOMIC CLAIM of every fresh
upload attempt (round-12, critic round-10: clearing on upload SUCCESS could wipe a verdict that a
concurrent sync stamped while the Amazon call was in flight), so a verdict from a previous cycle
can never protect a retry's feed, while a verdict stamped DURING the call is respected: the
success handler lands the document in 'processing' (or keeps the state the verdict set) instead of
regressing it to 'submitted'. feed_conflict events are deduplicated per document+feed+status -
repeats only bump the event's count.
