# Worst-case register — InvoiceGuard

Ahmed's directive (2026-11-26): plan for the worst cases, not just the happy
path ("لازم نحط اسوأ الاحتمالات"). Living document: review at every sprint
boundary and after any incident. Columns: likelihood, blast radius if it
happens, how we would notice early, mitigation now, fallback if it hits.

## Catastrophic scenarios

### W1. Amazon never grants the Tax Invoicing role (SP-API production)
- Likelihood: medium-high. Precedent: GoRoute waiting since Sept 2026.
- Blast radius: no automatic upload to real Seller Central; "production"
  claims impossible; pilot stays manual-export.
- Detection: application status checks; Amazon developer communications.
- Mitigation now: the product already works as a manual-export pack
  (PDFs + manifest + HOW-TO) and demo mode; marketing speaks about the
  pilot only (honesty gate, already active). The Repair Engine, Sentinel
  and Memory all deliver value in manual mode.
- Fallback: manual pack IS the product until approval; position as
  "your invoices, checked and built, you press upload". Reapply / escalate
  via Amazon channels periodically; never build promises on the approval.

### W2. A rectificativa mapping is legally wrong for a country
- Likelihood: medium (ES best understood; other EU countries less validated).
- Blast radius: a seller files a wrong correction document; tax exposure;
  trust destroyed; possible liability.
- Detection: tax-professional review per country; gestor/seller feedback;
  rule re-check cron; per-marketplace validation before enabling a country.
- Mitigation now: country rule packs gate every correction method
  (readiness() refuses unsupported modes and amount changes); review-first
  pilot (a human approves every repair); copy says "built to the regulation",
  never "certified" or "legally valid" (honesty gate). Repair Engine rolls
  out ES-first; other countries stay read-only until validated.
- Fallback: disable corrections for the affected country (rule pack flag),
  notify affected sellers with plain guidance to their gestor, publish the
  correction of our own mapping.

### W3. A repair proposal damages a seller's invoice record
- Likelihood: low-medium. Blast radius: broken gapless numbering, a wrong
  credit note uploaded, reconciliation mismatch at the seller's accountant.
- Detection: hash-chained audit log (verifyAudit), per-order evidence trail,
  seller-facing invoice list vs Amazon's document list, tests on every
  repair path (idempotency, no double issue).
- Mitigation now: review-first (nothing auto-issues); one proposal per
  correction event (primary key); the approval screen shows exactly what
  will be issued (original number, amounts, TransactionId) before the
  click; numbering counters are transactional; every step writes an audit
  entry.
- Fallback: reverse path = issue the inverse rectificativa and record the
  incident in the audit log; the chain shows what happened and when.

### W4. Quora or X suspends the account
- Likelihood: medium (new brand accounts with links are fragile).
- Blast radius: a distribution channel lost, posted content gone.
- Detection: login challenge, suspension notice, engagement dropping to 0.
- Mitigation now: platform warm-up cadence rules; answers add real value
  with disclosure, not link drops; all content archived in the repo and
  /tmp/dr so a fresh start loses nothing; channels diversified (Quora, X,
  Reddit, Discord, Skool, TikTok) so no single suspension kills reach.
- Fallback: appeal once, cleanly; if refused, rebuild on remaining channels
  and repost the archive gradually under a warmed-up replacement account.

### W5. Railway trial credit runs out / free limits hit
- Likelihood: high eventually (trial $5 credit, ~30 days from Nov 25).
- Blast radius: site down; every public link (Quora, X bio, sample) dies.
- Detection: recurring sweep checks remaining credit via the Railway API;
  alert threshold at 7 days / $1.50 remaining.
- Mitigation now: Dockerfile + stateless app = portable; SQLite file is the
  only state; keep a migration runbook (below). Zero-cost requirement means
  the fallback host must be free.
- Fallback: free-tier alternatives researched and kept current in the
  runbook (e.g. Oracle Cloud free tier VM, Fly.io free allowance,
  Cloudflare Workers + D1 with a small adapter). Estimated migration time
  target: same day. Domain is a railway.app subdomain, so links change -
  mitigate by announcing the new URL everywhere it appears.

### W6. Data loss (seller invoice records)
- Likelihood: low (verified 2026-11-26: signup/counter data survives
  redeploys, so the Railway volume persists). Blast radius: catastrophic -
  a seller's issued invoice record is their compliance history.
- Detection: post-deploy smoke check of admin counters; audit verification.
- Mitigation now: hash-chained audit log makes tampering or partial loss
  detectable; add an admin DB-snapshot export (encrypted, pulled to the
  offline archive on a schedule).
- Fallback: restore from the latest snapshot; sellers can re-upload order
  reports to rebuild invoices (audit chain proves provenance).

### W7. VIES outage or wrong VAT validation
- Likelihood: medium (VIES goes down regularly, country services patchy).
- Blast radius: invoices held unnecessarily, or worse, issued on a stale
  "valid" answer.
- Detection: validation error rate in stats; sudden hold spikes.
- Mitigation now: hold-don't-guess policy (a failed check holds, never
  guesses); cached answers carry age; Recheck re-asks VIES fresh after the
  buyer fixes data; overrides are logged and attributable.
- Fallback: extended outage banner + queue drains automatically when VIES
  returns; nothing is issued on unverified data.

### W8. A competitor copies the leap
- Likelihood: medium over time; low short term (data-model rewrite).
- Blast radius: differentiator erodes; "nobody else does this" dies.
- Detection: growth research re-checks live competitor pages before every
  public push (standing rule); seller chatter.
- Mitigation now: claims stay dated and sourced ("verified across live
  competitor pages, November 2026"); keep shipping (Sentinel, Memory,
  Verifactu architecture) so the loop, not any single feature, is the moat;
  protocol edge-case knowledge compounds.
- Fallback: shift claim to "first" + depth (rejection handling, correction
  windows, per-country rule packs) and out-execute.

### W9. Legal/tax liability from sellers relying on the tool
- Likelihood: low-medium. Blast radius: claims against the product; since
  there is no registered entity, this lands on a person - unacceptable.
- Detection: any seller message implying reliance ("your tool said...").
- Mitigation now: "not legal or tax advice" disclaimers on rules, packs and
  reports; gestor-review prompts; no country goes live without verified
  rules; honesty gates block capability overstatement everywhere.
- Fallback: take the implicated feature down the same day, correct the
  copy, tell affected users plainly.

### W10. Anonymity breach
- Likelihood: low. Blast radius: violates the founder's hard rule.
- Detection: any public surface (site, posts, profiles, email headers,
  repository metadata) carrying his name, country or personal email.
- Mitigation now: InvoiceGuard identity only; X location "European Union";
  Proton-only contact; git commits under the brand account; pre-publish
  checks; no personal data in any account.
- Fallback: remove the leak immediately, rotate what it touched, audit how
  it escaped, add a check so that class cannot recur.

### W11. Abuse: the tool used to fabricate invoices
- Likelihood: low. Blast radius: platform misuse, legal exposure, Amazon
  blacklisting the document pattern.
- Detection: anomalous volumes, reports without plausible Amazon structure,
  buyer complaints.
- Mitigation now: the tool builds invoices from order reports, not from
  thin air; attestations before issue; rate limits; manual holds.
- Fallback: suspend the abusive account; cooperate with Amazon if asked.

### W12. Amazon changes the correction protocol or VIDR format
- Likelihood: medium over a year. Blast radius: detection silently stops
  matching; repairs queue dries up while sellers think they are covered.
- Detection: rule/source re-check cron; parser coverage metrics (unknown
  transaction types counted, never silently dropped); SP-API changelog
  watch.
- Mitigation now: parser keeps raw rows; unknown transaction-types surface
  in the ingest health endpoint; detection rules live in one module with
  fixtures.
- Fallback: ship a parser/rules update; until then the affected events show
  as "needs manual review" instead of pretending coverage.

## Cross-cutting mitigations already in the build
- Review-first repairs, idempotent event keys, hash-chained audit log,
  hold-don't-guess validation, rule-pack gates, disclaimers, archived
  content, portable deployment, recurring health sweep.
- Honesty gates (updated by this register): no "never miss the deadline"
  claim until the per-order evidence trail ships; corrections sold as
  legality/sanity/CX, never IDR protection; one-business-day = Amazon
  policy; "built to the regulation", never "certified"; competitor
  uniqueness claims dated and re-verified before each push.
