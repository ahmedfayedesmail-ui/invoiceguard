# Local data security: threat model and architecture (P3)

Scope: the problem-loop page (`/local/loop`, built from `src/loop/*`). Synthetic data only until a controlled real-data phase is approved. This document says what the design protects against and, with equal weight, what it does not.

## 1. Data surfaces (inspected in the code, not assumed)

| Surface | What is in it | Where | Before P3 | After P3 |
|---|---|---|---|---|
| IndexedDB database `invoiceguard-loop`, object store `kv` | `loop:import:<id>` (raw file text, sha256, declarations, confirmed mapping profile), `loop:event:<id>` (seller statements with free-text reasoning and author), `loop:profile` (random local profile id), `loop:settings` | `src/loop/store.js` through `indexedDbAdapter` | **Plaintext objects** | Only `vault:meta` (plaintext: KDF parameters, salts, wrapped keys, vault id) and `e1:<kind>:<HMAC>` encrypted envelopes |
| Parsed and normalized records, links, issues, findings, evidence, lifecycle states | Computed by `project()` from the stored imports and events on every render | Memory only | Never persisted (invariant of the loop: only imports and seller events are stored) | Unchanged. Present in memory while the page is open and the vault unlocked |
| Mapping profiles | Column names of the seller's accounting export | Inside the import record | Plaintext | Encrypted with the import |
| Seller identifiers (buyer VAT ids, invoice numbers, amounts) | Inside the raw file text of the import | Inside the import record | Plaintext | Encrypted with the import |
| Downloaded evidence bundle (JSON) | Imports with raw text, declarations, issues | A file the seller chooses to download | Plaintext | **Still plaintext, by the seller's explicit action.** The encrypted backup is the protected export |
| Backups | New in P3 | A file the seller downloads | none | Encrypted JSON (records exactly as stored, wrapped keys, manifest MAC) |
| Browser storage other than IndexedDB | localStorage, sessionStorage, Cache Storage, service workers, cookies | none used by the loop page (verified by searching `src`, `web`, `public`; the browser test also reads the real IndexedDB) | n/a | n/a |
| Logs and errors | Server logs; page messages | The loop page makes no network request (CSP `connect-src 'none'`), has no logging code, and refusal messages are built from fixed texts and field names, not values | no values in messages | tested: error messages never contain seller values or secrets |
| Legacy page `/local` (`page.js`, `engine.js`) | Analyse-only page: reads a file in memory, shows results, offers a sample PDF | Nothing persisted. `src/history.js` (`createHistory`, optional-passphrase store) is a library used only by tests; no shipped browser file reaches it | n/a | Proven by test: after analysing files in Chrome there are 0 IndexedDB databases, 0 localStorage/sessionStorage entries, 0 caches, 0 cookies; static scan of the page, its bundle and html |
| Server side (`src/app.js`, SQLite for the Amazon integration) | The public site and the Amazon pipeline, separate from the loop page | server | n/a | The loop page sends nothing to it; `ENABLE_LOOP_PAGE` keeps the page off in production |

Data lifecycle: file chosen in the browser, read as text in memory, declared by the seller, stored as an encrypted record, read back and decrypted in memory on each render, projected, shown. It leaves the device only if the seller downloads a bundle or a backup. Deletion: section 6.

## 2. Assets

1. Raw seller documents (invoice numbers, buyer VAT ids, amounts, dates, order ids).
2. The seller's statements (names, free-text reasoning).
3. The vault password, the recovery key, the master secret (key material).
4. The integrity of the evidence: a record must not be silently altered, moved or removed.

## 3. Threats and trust boundaries

In scope (the design defends):
- T1. Someone reads the browser profile on disk, a copied profile, a stolen device with the browser closed, or a disk image: sees only ciphertext and the vault metadata.
- T2. Someone with write access to the stored data changes, swaps, truncates or replays records or backups: edits and swaps are detected (authenticated encryption, record binding, manifest MAC) and never returned as data. Truncation and replay are not covered the same way: the checks detect edits, not tail removal, unless an off-box anchor exists.
- T3. Someone guesses the password offline against a copied profile: slowed by PBKDF2-HMAC-SHA256 at 600000 iterations. Strength still depends on the password.
- T4. A forgotten tab left open: auto-lock (default 15 minutes, 0-240, configurable) drops the key references.
- T5. Accidental network use by our own code: none in the engine; CSP `connect-src 'none'`; tested at unit and browser level.
- T6. Partial failure (quota, crash, interruption) during migration, write or delete: no silent loss (section 5).

Out of scope (the design does NOT defend):
- O1. Malware or a malicious browser extension on the device. They can read the page while it is unlocked, and can log the password as it is typed.
- O2. Malicious script in the same origin (XSS, a compromised dependency or deployment). The page has no third-party scripts and a strict CSP, but any code running in the origin can use the unlocked key.
- O3. Anyone using the unlocked session (shoulder surfing, walk-up access).
- O4. A weak or reused password.
- O5. Memory forensics of a running browser. JavaScript cannot erase memory it does not control: locking drops references and zeroes the raw secret bytes we hold, but copies in browser internals, swap or crash dumps are outside our control.
- O6. Browser-managed storage internals (section 6).
- O7. A plaintext evidence bundle the seller downloads, or the original files on the seller's own disk.

## 4. Architecture (encryption at rest)

Primitives, all from the platform Web Crypto API; nothing custom:
- PBKDF2-HMAC-SHA256, 600000 iterations, 16-byte random salt, from the password to a key-encryption key. Iterations and algorithm are stored in the vault metadata (versioned, so they can be raised later without breaking old vaults).
- A random 256-bit master secret, created once. It is stored only wrapped (AES-256-GCM) twice: under the password key, and under a recovery key.
- HKDF-SHA256 from the master secret, with the vault id as salt, to two separate non-extractable keys: an AES-256-GCM record key and an HMAC-SHA256 id key. The raw secret bytes are zeroed right after import.
- Records: AES-256-GCM, fresh random 96-bit IV per write, authenticated data = format version + vault id + storage key. A record moved to another key, another vault or another version fails authentication. Storage keys are `e1:<kind>:<HMAC of the logical key>`: import ids and hashes are not visible; only the record kind (import or event) and the count are.
- The password and the unwrapped master secret are never persisted or logged. Wrong password and damaged vault give the same answer. Everything fails closed: while locked every read and write throws `VaultLocked`; a record that does not verify makes the read or the listing fail rather than disappear.
- IV safety: random 96-bit IVs under one key are safe for far fewer than 2^32 writes per key (NIST SP 800-38D); a vault here holds hundreds to thousands of records. The test writes 2000 times and asserts no IV or ciphertext repeats.

Recovery without escrow: at creation the vault shows a 52-character recovery key once. It is stored nowhere. Password or recovery key opens the vault; lose both and the data cannot be recovered by anyone, including us, because no key leaves the device. Changing the password re-wraps only the key.

## 5. Migration, integrity, failure handling

- Legacy plaintext `loop:*` records are detected on unlock. They are copied into the vault, read back, compared (canonical JSON) and counted before anything is removed. Only then are the originals deleted, one by one. Unreadable or conflicting records are reported and kept.
- Every step is idempotent. Interrupted copy: originals intact. Interrupted delete: originals and the verified copy both exist; a rerun finishes. A storage quota error at any write aborts with the originals untouched. Tested.
- Envelope version `1` and vault version `1` are checked; a newer version is refused, not guessed.

## 6. Deletion, retention, and what "deleted" means

Three different things, stated precisely:
1. **Logical deletion** (what the app does for one import): the record and everything computed from it is removed from the database; the seller statements that no longer attach to any problem are removed with it. Nothing derived is stored elsewhere, because results are computed, not stored. Exception, by design since the import-deletion-history fix: a small permanent deletion record stays (file name, kind, hash, time, reason, and for each problem the file touched its identifiers and the history that was recorded). It never holds file content, amounts or rows. It exists so a later reader can tell that a history was truncated; those problems are listed as HISTORY_INCOMPLETE and never silently resolved, reopened or removed. Deleting the whole workspace removes the record too.
2. **Cryptographic erasure** (whole workspace): deleting the vault metadata (the wrapped master secrets) and all records. Any ciphertext copy that survives somewhere can then be opened only with the old metadata AND the password or recovery key. Per-import cryptographic erasure was investigated and **not adopted**: a per-import key would have to be stored beside its record, so deleting the record deletes both and gains nothing beyond what logical deletion already does; a key held separately would only help if only one of them were recoverable from storage remnants, which cannot be assumed.
3. **Physical erasure**: not provided and not claimed. IndexedDB lives in the browser's own files (LevelDB or SQLite) and the operating system's disk. A deleted value can remain in free space or journal files until the browser compacts them and the OS reuses the blocks. We cannot force that. Because stored values are ciphertext, remnants of encrypted records are unreadable without the key; remnants of the plaintext written by the pre-P3 page (before migration) are not, which is why the migration removes the plaintext only after verification and why real files must not be loaded before this vault is in place.

The seller sees, before confirming, what each deletion removes and keeps (computed impact). Retention is **off by default (keep until the seller deletes)**. Automatic deletion is a setting that needs an explicit confirmation, a limit between 30 and 3650 days, and applies at unlock to imports older than the limit; it never runs unless enabled. Downloaded bundles and backups are outside the app's reach and are not deleted by any of this.

## 7. What stays exposed while the vault is unlocked

Decrypted records and the projection are in page memory; the page displays them; the unlocked key is usable by any code in the origin. Locking removes the references; it does not make memory forensics impossible.

## 8. Browser storage limits

- Browsers may clear site data under storage pressure or by user action; the encrypted backup is the durable copy.
- `navigator.storage.persist()` is a request the browser may refuse.
- Private-browsing sessions can discard the database on close.
- Deletion cannot be verified at the disk level (section 6).

## 9. Known limitations and residual risks

- The legacy `/local` page persists nothing (verified by browser test and static scan, see section 11). The older `src/history.js` store, which could write plaintext, is not shipped to any page; a test fails if any browser file references it. Earlier wording in this document that called the page a plaintext store was wrong and is corrected here.
- The plaintext evidence bundle exists by design for hand-off; a seller who downloads it holds unprotected data.
- PBKDF2 is memory-light; Argon2 is not in Web Crypto. The iteration count is the available defence and is versioned for increases.
- A weak password weakens T3. The page requires 10 characters; it does not measure strength.
- The window between "delete import" and "delete orphaned statements" is not atomic: an interruption leaves orphaned statements (never a lost or half-deleted import).
- No independent security audit has been done. This is an engineering design with adversarial tests, not a certification.

## 10. Performance (measured, synthetic data, `node tools/bench-vault.mjs <rows>`)

Node 22 on the build machine, Web Crypto in-process. Rows = Amazon rows plus the same number of accounting rows. Browser timings differ; the shape does not.

| Rows | File sizes (Amazon / accounting) | Create vault | Unlock | Import, plain | Import, vault | Read all, vault | Projection (engine, same either way) | Backup | Restore | Backup size |
|---|---|---|---|---|---|---|---|---|---|---|
| 500 | 75 KB / 45 KB | 112 ms | 108 ms | 59 ms | 17 ms | 11 ms | 205 ms plain, 163 ms vault | 20 ms | 119 ms | 174 KB |
| 5000 | 762 KB / 454 KB | 113 ms | 107 ms | 145 ms | 161 ms | 137 ms | 5.15 s plain, 5.14 s vault | 159 ms | 250 ms | 1.7 MB |

Reading: encryption and decryption overhead is a few milliseconds per hundred KB and is small next to the engine. Create and unlock cost about 0.1 s each (the 600000-iteration key stretch, intended). The dominant cost at 5000 rows is the existing projection (about 5 s per render), which is not changed by P3 and grows faster than linearly (0.2 s at 500 rows, 5.1 s at 5000). That is a scalability limit of the P1/P2 engine for large single imports, recorded here as a known limit and not fixed in P3. Heap stayed under 100 MB at 5000 rows.

## 11. Where each guarantee is tested

- `test/vault.test.js`: wrong password, modified ciphertext/IV/truncation/version, record moved between keys or vaults, IV uniqueness over 2000 writes, locked vault (manual and timer), no plaintext in storage, recovery key, password change, backup tampering (flip, truncation, count rewrite), whole-workspace deletion, storage failure on write, error messages without values.
- `test/vault-lifecycle.test.js`: P1/P2 results identical on plain and vault storage, migration (clean, interrupted delete, quota failure, unreadable and conflicting records), import deletion with impact and orphaned statements, whole-workspace deletion, retention (off by default, explicit confirmation), backup/restore of a real store, no network API called, static scan for network, logging and other storage APIs.
- `test/vault-ui.test.js` (headless Chrome): the real IndexedDB read back with no seller plaintext and only opaque keys, requests intercepted (none beyond the page and its scripts, fetch blocked by CSP), lock empties the page, wrong password stays locked, reload stays locked, inactivity auto-lock, migration of planted legacy plaintext in the real IndexedDB, delete one import with its impact text, encrypted backup, workspace deletion leaving zero keys, restore giving the same summary, tampered backup refused and writing nothing.
- `test/loop-ui.test.js`: the P1/P2 end-to-end flows now run through the vault.
