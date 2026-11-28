# Sealed Financial Evidence Timeline — Slice 1

This is an advisory, read-side evidence layer. It records normalized observations from InvoiceGuard's existing SQLite tables. It never changes invoices, shipments, holds, findings, claims, repairs, upload operations, or ACCEPTED/RELEASED decisions.

## Boundary

- A separate SQLite connection is opened with `readOnly: true` and `PRAGMA query_only=ON` for source reads.
- The writer and reader must resolve to the same persistent SQLite database file. Sealing refuses in-memory databases or mismatched connection targets.
- The writer creates and writes only `intel_evidence_chain` and `intel_evidence_head`.
- The evidence chain is protected by SQLite triggers against UPDATE and DELETE. Its head row may be updated by the sealer but cannot be deleted; verification fails closed if a non-empty chain has no matching head. Each coverage statement is itself sealed into the chain; there is no separate mutable coverage cache.
- The sealer checks that the source append-only logs actually have both UPDATE and DELETE protection triggers. If any are missing, coverage is marked `INCOMPLETE` and the missing protection is retained in later coverage statements.
- Each sealing pass uses `BEGIN IMMEDIATE`; concurrent sealers serialize, and `(seller_id, source_ref)` makes retries idempotent.
- A document timeline includes its own invoice records plus related shipment-level evidence (shipment snapshots, integrity history/decisions/findings, and events explicitly keyed to that shipment). It does not merge sibling invoice snapshots into the selected invoice's trajectory.
- Verified bundle comparison reports the first observed divergence between two snapshots for the same seller and document. The result is advisory and does not infer cause or authorize a financial transition.
- Mutable source snapshots are versioned against the latest sealed state per source row. A transition A → B → A is recorded as three distinct observations; an unchanged repeat seal is not duplicated. Each changed snapshot names its predecessor reference.
- Timeline order is the immutable seal-observation sequence. Source `occurredAt` values are retained as evidence metadata; they are not used to rewrite the append order. The sequence is deterministic capture order, not a claim that source timestamps are complete or causally ordered.
- Only allowlisted metadata is exported. Free-form event details, decision reasons, actor identities, invoice errors, finding explanations and raw evidence are represented by SHA-256 digests rather than copied into the bundle. These digests are integrity fingerprints, not anonymization; low-entropy values may be guessable.
- Monetary values are converted to safe integer cents with exact decimal arithmetic. Sub-cent or unsafe values fail the seal; they are never rounded into evidence.
- Financial identifiers are rejected when they exceed the supported field length; they are never silently truncated into a potentially colliding document key.

## What the chain proves—and does not

The chain is **tamper-evident, unsigned**. It detects edits to sealed entries and a changed chain head. It does not authenticate who created the original source row. Someone who controls the database can rewrite the entire database chain or truncate its tail. A checkpoint exported and retained separately by the seller or operator can later detect truncation before that checkpoint.

No signing key is created or stored in this slice. Ed25519 signing and out-of-band public-key distribution are deferred.

## Completeness

The layer never asserts `COMPLETE` merely because a seal succeeded. It reports `UNKNOWN` because the `events` table is mutable and invoices, shipments and findings are current snapshots. Mutable snapshots are versioned per source row, so a return to an earlier value or a row that reappears after a sealed absence is retained as a new observation; disappearance of a previously sealed mutable row is detected on the next seal and changes coverage to `INCOMPLETE`. The historical gap remains `INCOMPLETE` even if the row later reappears. For the append-only logs (`integrity_history`, `integrity_decisions`, and `credit_claim_history`), disappearance of a previously sealed record is also detected on the next seal and changes coverage to `INCOMPLETE`; a source snapshot that changes during sealing likewise produces `INCOMPLETE`. An `INCOMPLETE` state is not cleared automatically. The first seal cannot reconstruct history that predates it, and a missing historical event before the first seal cannot be detected from a mutable source table. SQLite rowids are table-global across sellers, so seller-scoped rowid gaps are deliberately not treated as deletion evidence. A partial timeline must not be described as a complete history.

## Seller-facing integration

The first seller-facing integration is deliberately manual and seller-scoped:

- `POST /api/intel/seal` creates a snapshot only after an authenticated seller explicitly requests it. It refuses to run against an in-memory database.
- `GET /api/intel/timeline?number=<invoice-number>` returns that invoice's observed trajectory plus related shipment-level evidence. It refuses an invalid evidence chain.
- `GET /api/intel/export` downloads the authenticated seller's account-wide JSON evidence bundle. The response also exposes the checkpoint hash in an HTTP header.
- In Documents → Invoices → Evidence, the seller can explicitly seal the account snapshot, inspect the timeline, copy the checkpoint separately, or download the bundle.

The API derives the seller ID only from the authenticated session. A seller ID supplied in the request body is ignored. A seller must have their own non-empty sealed chain before timeline or export reads are available; another seller's shared intel tables do not count as a seal. No automatic schedule exists. No invoice, shipment, hold, finding, claim, repair, upload, ACCEPTED, or RELEASED state is changed by these endpoints. The timeline and labels are advisory only.

Bundle verification requires an embedded checkpoint or an independently supplied checkpoint; an unanchored prefix is never accepted as valid. The verifier also checks that the bundle's top-level coverage summary exactly matches the latest coverage statement sealed inside the chain. The separately retained checkpoint must be kept outside the downloaded bundle (for example, in the seller's own secure records). The JSON bundle's embedded checkpoint alone is not an independent witness against a party who can rewrite the entire database and bundle.

## Operational qualification still required

Before broad use, measure sealing overhead on a representative 20,000-row seller database, test interruption/restart and concurrent production-shaped workloads, and define a seller-facing retention and deletion policy. This slice does not create signing keys, authenticate original Amazon source rows, or prove history before the first seal.
