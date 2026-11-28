# Sealed Financial Evidence Timeline — Slice 1

This is an advisory, read-side evidence layer. It records normalized observations from InvoiceGuard's existing SQLite tables. It never changes invoices, shipments, holds, findings, claims, repairs, upload operations, or ACCEPTED/RELEASED decisions.

## Boundary

- A separate SQLite connection is opened with `readOnly: true` and `PRAGMA query_only=ON` for source reads.
- The writer creates and writes only `intel_evidence_chain` and `intel_evidence_head`.
- The evidence chain is protected by SQLite triggers against UPDATE and DELETE. Each coverage statement is itself sealed into the chain; there is no separate mutable coverage cache.
- Each sealing pass uses `BEGIN IMMEDIATE`; concurrent sealers serialize, and `(seller_id, source_ref)` makes retries idempotent.
- Only allowlisted metadata is exported. Free-form event details, decision reasons, actor identities, invoice errors, finding explanations and raw evidence are represented by SHA-256 digests rather than copied into the bundle. These digests are integrity fingerprints, not anonymization; low-entropy values may be guessable.
- Monetary values are converted to safe integer cents with exact decimal arithmetic. Sub-cent or unsafe values fail the seal; they are never rounded into evidence.
- Financial identifiers are rejected when they exceed the supported field length; they are never silently truncated into a potentially colliding document key.

## What the chain proves—and does not

The chain is **tamper-evident, unsigned**. It detects edits to sealed entries and a changed chain head. It does not authenticate who created the original source row. Someone who controls the database can rewrite the entire database chain or truncate its tail. A checkpoint exported and retained separately by the seller or operator can later detect truncation before that checkpoint.

No signing key is created or stored in this slice. Ed25519 signing and out-of-band public-key distribution are deferred.

## Completeness

The layer never asserts `COMPLETE` merely because a seal succeeded. It reports `UNKNOWN` because the `events` table is mutable and invoices, shipments and findings are current snapshots. For the append-only logs (`integrity_history`, `integrity_decisions`, and `credit_claim_history`), disappearance of a previously sealed record is detected on the next seal and changes coverage to `INCOMPLETE`; a source snapshot that changes during sealing also produces `INCOMPLETE`. An `INCOMPLETE` state is not cleared automatically. The first seal cannot reconstruct history that predates it, and a missing historical event before the first seal cannot be detected from a mutable source table. SQLite rowids are table-global across sellers, so seller-scoped rowid gaps are deliberately not treated as deletion evidence. A partial timeline must not be described as a complete history.

## Usage (not wired into app startup)

```js
import { openDb } from '../db.js';
import { openIntelReader, sealSellerEvidence, exportEvidenceBundle } from './intel/store.js';

const db = openDb(process.env.DB_FILE);
const reader = openIntelReader(process.env.DB_FILE);
try {
  const result = sealSellerEvidence({ writerDb: db, readerDb: reader, sellerId });
  const bundle = exportEvidenceBundle(db, sellerId); // persist as a seller download
} finally {
  reader.close();
  db.close();
}
```

This first implementation is intentionally not wired to a route, scheduler, or UI. Runtime integration, seller download path, checkpoint retention workflow, and performance qualification remain separate work.
The automated tests also prove that a corrupted pre-existing chain is refused for further appends, while integrity verification and the source financial tables remain separate.

Outcome labels preserve coverage, contradiction, and manual-authorization facts separately. A manual authorization never masks incomplete or contradictory evidence, and no outcome label can authorize a financial state transition.
