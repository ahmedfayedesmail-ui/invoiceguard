# swarm-evidence audit of PR #5 (read-only) at d1466ff6f2e446d5be6d7db527e4d4cdbcc6e8be

Scope: src/intel/{canonical,outcomes,timeline,store,index}.js, src/app.js intel routes, docs/SEALED-FINANCIAL-EVIDENCE.md.
No PR #5 file was changed. Repro: `PR5_DIR=<pr5 checkout> node --no-warnings audit/swarm-evidence/probe-pr5-evidence.mjs` (synthetic temp DBs).
Existing PR #5 intel tests re-run by this squad: `node --test test/intel-*.test.js` = 30 tests, 30 pass, 0 fail.

## F1 (verified, repro P1) - a retained checkpoint stops verifying as soon as the chain legitimately grows
- store.js:282-284: `if(checkpoint&&(checkpoint.sellerId!==sellerId||checkpoint.sequence!==rows.length||checkpoint.hash!==result.hash))`
- store.js:574-577: `cp.sequence!==bundle.chain.length||cp.hash!==prev)` -> `external-checkpoint-mismatch`
- Severity: High (functional; breaks the documented purpose). Confidence: high (executed).
- Impact: docs say a separately retained checkpoint "can later detect truncation". Equality on length/hash means an older checkpoint (seq 2) fails against a later honest chain (seq 4) with the same reason code as tampering. Operators will see false tamper alarms after every seal, or stop checking.
- Fix (backlog, PR #5 diff): verify that entry `checkpoint.sequence` exists in the chain with entry_hash == checkpoint.hash (prefix anchoring); treat chain shorter than checkpoint as truncation; distinct reasons `chain-truncated-before-checkpoint` vs `checkpoint-not-in-chain`.
- Test: seal, keep checkpoint, add rows, seal, assert verify(bundle,{checkpoint:old}) valid; truncate tail below checkpoint, assert invalid with truncation reason.

## F2 (verified, repro P2) - events sealed in one pass are ordered by string rowid, not insertion order
- store.js:164-168: `a.sourceKey.localeCompare(b.sourceKey)||` (keys are rowids/ids converted to text)
- Severity: Medium. Confidence: high (executed). 12 events sealed in one pass appear as 1,10,11,12,2,...,9 in the document timeline.
- Impact: timeline sequence (the documented authoritative order) reverses e.g. rowid 9 and 10 (hold then release). Also localeCompare is ICU/locale dependent, so two environments can produce different order and trajectoryDigest for the same data (false divergence in compareDocumentEvidenceBundles).
- Fix (backlog): sort by sourceTable (codepoint compare) then numeric key when the key is an integer, else codepoint compare; no localeCompare.
- Test: seed 12 events, seal once, assert timeline order is 1..12; assert digest identical under LC_ALL=C and tr_TR.

## F3 (verified, repro P3) - deleted-and-replaced events row (rowid reuse) is not flagged
- store.js:117: `read('events','SELECT rowid AS k, ts, type, detail FROM events WHERE seller_id=? ORDER BY rowid'`
- Severity: Medium-Low. Confidence: high (executed): delete newest event, insert a different one; SQLite reuses the rowid; seal reports coverage UNKNOWN with zero missingMutableSnapshots; it records it as a version change of the same row.
- Impact: a replaced event looks like an edit of the same event, not a deletion plus a new event. Both versions are retained, but the coverage gap signal is lost. Events has no AUTOINCREMENT/INTEGER PRIMARY KEY (src/db.js:19) so rowids are not stable identities (VACUUM may also renumber; /admin/db-snapshot uses VACUUM INTO at src/app.js:281, effect on rowids UNVERIFIED).
- Fix (backlog): key events by a content-independent stable id (add an INTEGER PRIMARY KEY AUTOINCREMENT in a migration, outside PR #5) or record max rowid watermark and flag a lower max on the next seal.
- Test: the P3 scenario must yield INCOMPLETE.

## F4 (verified by reading, low) - tampered chain reported as coverage INCOMPLETE
- store.js:436: `if(!v.valid)return {status:'INCOMPLETE',reason:v.reason,brokenAt:v.brokenAt};`
- Severity: Low. Confidence: high (executed P5). A hash-mismatch (tamper) and a coverage gap share one status; consumers keying on status cannot tell tamper from gap. Proposal: status 'INTEGRITY_FAILED' or return valid:false explicitly.

## F5 (verified by reading, design) - PROVEN is unreachable
- outcomes.js:57-60 `else if (completeness !== 'COMPLETE') outcome = 'INCOMPLETE';` while store.js:235 only ever emits 'UNKNOWN' or 'INCOMPLETE'. classifyEvidenceOutcome has no caller in src/ or public/ (grep). Also UNKNOWN is collapsed into INCOMPLETE, whose meaning text says "known or unresolved coverage gap". Severity: Low (dead/advisory code). Proposal: add UNKNOWN as its own outcome or document the collapse; add a test that no input yields PROVEN unless completeness==='COMPLETE'.

## F6 (verified by reading, cosmetic) - duplicated condition
- store.js:261: `(body.previousSourceRef!==null&&body.previousSourceRef!==undefined&&typeof body.previousSourceRef!=='string')||(body.previousSourceRef!==null&&...` same clause twice. No behavior effect; copy/paste residue.

## Unverified / needs follow-up
- U1: store.js:289-308 vs 534-541 export reads (verify, rowsFor, getEvidenceCoverage) are not in one transaction; a concurrent seal from another process between them could yield a bundle whose chain length != checkpoint. Not reproduced (needs two processes). Confidence: medium-low.
- U2: trajectoryDigest (timeline.js:110) claims source row IDs are excluded, but previousSourceRef (`table:key:hash`) is included and contains rowid keys for events/integrity_findings; digests may differ between a DB and a restored copy with renumbered rowids. Not reproduced.
- U3: Source-change detection (store.js:366-392) not exercised under a real concurrent writer; PR #5's own load tool (tools/intel-load.mjs) was not run by this squad.
- U4: unsigned chain, first-seal UNKNOWN coverage, production-scale qualification are known open items from PR #5 review; not re-qualified here.

## Checked and found sound (no defect found)
canonicalize rejects floats/undefined/non-plain objects (canonical.js:12-24); cents() uses BigInt, refuses sub-cent and unsafe values (store.js:65-95); chain verify rejects gaps, prev-hash, header and hash mismatch and missing head (store.js:250-276); append-only triggers verified by exact SQL shape (store.js:17-33); seller_id derived from session only in the three routes (app.js diff lines 26-87); A->B->A versioning and reappear-after-absence handled (store.js:171-199).
