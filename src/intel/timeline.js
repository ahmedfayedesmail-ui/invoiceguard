import { canonicalize, sha256Hex } from './canonical.js';

function bodyOf(entry) {
  if (entry && typeof entry.canonicalJson === 'string') return JSON.parse(entry.canonicalJson);
  if (entry && typeof entry.canonical_json === 'string') return JSON.parse(entry.canonical_json);
  if (entry && entry.body && typeof entry.body === 'object') return entry.body;
  if (entry && typeof entry === 'object') return entry;
  throw new TypeError('An evidence entry must contain a canonical body.');
}

export function normalizeEvidenceTimeline(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('Timeline entries must be an array.');
  const ordered = entries.map(entry => {
    const body = bodyOf(entry);
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new TypeError('Timeline entry has an invalid sequence.');
    return { sourceSequence: body.sequence, body };
  }).sort((a, b) => a.sourceSequence - b.sourceSequence);
  // Re-number locally after filtering to one document. Seller-global sequence numbers
  // shift when unrelated documents are sealed and must not create false divergences.
  return ordered.map(({ body }, index) => ({
    sequence: index + 1,
    kind: String(body.kind ?? 'unknown'),
    sourceTable: String(body.sourceTable ?? 'unknown'),
    documentKey: body.documentKey == null ? null : String(body.documentKey),
    previousSourceRef: body.previousSourceRef ?? null,
    occurredAt: body.payload?.occurredAt ?? body.payload?.at ?? body.payload?.issuedAt ?? null,
    payload: body.payload ?? {}
  }));
}

/** Digest of the observed document trajectory; source row IDs and seal timestamps are excluded. */
export function trajectoryDigest(entries = []) {
  return sha256Hex(canonicalize(normalizeEvidenceTimeline(entries)));
}

/** Finds the first differing observed event; it does not infer a cause or make a financial decision. */
export function findFirstDivergence(baselineEntries = [], comparisonEntries = []) {
  const baseline = normalizeEvidenceTimeline(baselineEntries);
  const comparison = normalizeEvidenceTimeline(comparisonEntries);
  const shared = Math.min(baseline.length, comparison.length);
  for (let index = 0; index < shared; index += 1) {
    if (canonicalize(baseline[index]) !== canonicalize(comparison[index])) {
      return {
        index,
        baselineSequence: baseline[index].sequence,
        comparisonSequence: comparison[index].sequence,
        reason: 'trajectory-diverged'
      };
    }
  }
  if (baseline.length !== comparison.length) {
    return {
      index: shared,
      baselineSequence: baseline[shared]?.sequence ?? null,
      comparisonSequence: comparison[shared]?.sequence ?? null,
      reason: 'trajectory-length-diverged'
    };
  }
  return null;
}
