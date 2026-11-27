// P4 pilot machinery: preflight (no values leave it, only counts and fixed words) and the measurement record with an aggregate-only export.
// Seller-entered numbers are labelled SELLER_REPORTED. Only a later file that shows a problem gone is machine-verified (VERIFIED_CLOSED).
import { REPORT_TYPE } from '../reconcile.js';
import { parseTable } from '../manual.js';
import { readLedger, LEDGER_MAX_ROWS } from './ledger.js';
import { vidrDoorProblems, ledgerDoorProblems } from './store.js';

const isoDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
export const PILOT_MAX_DAYS = 92;
const c = (id, status, detail) => ({ id, status, detail });

/** Checks source type, period, completeness and compatibility of ONE Amazon VIDR report and ONE accounting export, before import. Output has no file values. */
export function preflight({ vidrText, vidrDeclared = {}, ledgerText, profile, ledgerDeclared = {}, maxDays = PILOT_MAX_DAYS }) {
  const checks = [], vd = vidrDeclared, ld = ledgerDeclared;
  // 1 source type
  const t = parseTable(String(vidrText ?? ''));
  checks.push(t.unsupported || !t.rows?.length ? c('SOURCE_TYPE', 'FAIL', 'The Amazon file is not a readable VAT invoice (VIDR) report, or it has no data rows.')
    : vd.reportType !== REPORT_TYPE ? c('SOURCE_TYPE', 'FAIL', 'It was not declared that this is the Amazon VAT invoice data report.') : c('SOURCE_TYPE', 'PASS', `Amazon VAT invoice report with ${t.rows.length} data rows.`));
  checks.push(vd.options === 'ALL' ? c('REPORT_OPTIONS', 'PASS', 'Declared: all statuses.') : c('REPORT_OPTIONS', 'FAIL', 'The pilot needs the all-status report; pending-only or undeclared hides problems.'));
  // 2 period
  let per;
  if (!isoDay(vd.rangeFrom) || !isoDay(vd.rangeTo) || vd.rangeFrom > vd.rangeTo) per = c('PERIOD', 'FAIL', 'The Amazon report period is missing or reversed.');
  else if (days(vd.rangeFrom, vd.rangeTo) > maxDays) per = c('PERIOD', 'FAIL', `The period is ${days(vd.rangeFrom, vd.rangeTo)} days; the pilot is bounded to ${maxDays}.`);
  else per = c('PERIOD', 'PASS', `One period of ${days(vd.rangeFrom, vd.rangeTo)} days.`);
  checks.push(per);
  checks.push(isoDay(ld.periodFrom) && isoDay(ld.periodTo) && isoDay(vd.rangeFrom) && isoDay(vd.rangeTo) && ld.periodFrom <= vd.rangeFrom && ld.periodTo >= vd.rangeTo ? c('PERIOD_COVERAGE', 'PASS', 'The accounting export period covers the Amazon report period.') : c('PERIOD_COVERAGE', 'FAIL', 'The accounting export period is missing or does not cover the Amazon report period.'));
  checks.push(vd.marketplace && vd.marketplace === ld.marketplace ? c('MARKETPLACE', 'PASS', 'Both files are declared for the same marketplace.') : c('MARKETPLACE', 'FAIL', 'The marketplace is missing or differs between the two files.'));
  // 3 completeness
  checks.push(ld.complete === true ? c('LEDGER_COMPLETE', 'PASS', 'Declared by the seller as a complete export of the period (not verified by this tool).') : c('LEDGER_COMPLETE', 'FAIL', 'The accounting export is not declared complete; missing-invoice findings would not be reliable.'));
  checks.push(vd.createdAfterUploadConfirmed === true && vd.createdAt ? c('REPORT_FRESH', 'PASS', 'Declared as created after the uploads, with its creation time.') : c('REPORT_FRESH', 'WARN', 'Not declared as created after the uploads; closure by evidence will not be possible.'));
  checks.push(ld.amazonScope?.mode === 'UNKNOWN' ? c('AMAZON_SCOPE', 'WARN', 'It is not declared which accounting documents are Amazon sales.') : ['ALL', 'CHANNEL'].includes(ld.amazonScope?.mode) ? c('AMAZON_SCOPE', 'PASS', `Amazon scope declared (${ld.amazonScope.mode}).`) : c('AMAZON_SCOPE', 'FAIL', 'The Amazon scope of the accounting export is missing.'));
  // 4 compatibility
  const vp = vidrDoorProblems(String(vidrText ?? ''), vd), lp = ledgerDoorProblems(String(ledgerText ?? ''), profile, ld);
  checks.push(vp.length || lp.length ? c('COMPATIBILITY', 'FAIL', `${vp.length + lp.length} requirement(s) of the import door are not met (the door lists them when you import).`) : c('COMPATIBILITY', 'PASS', 'Both files pass the import door.'));
  if (!lp.length) { const r = readLedger(String(ledgerText ?? ''), profile, {}); const n = r.documents?.length ?? 0, rej = r.rejected?.length ?? 0;
    checks.push(!r.ok ? c('LEDGER_ROWS', 'FAIL', 'The accounting export could not be read with this column mapping.') : n + rej > LEDGER_MAX_ROWS ? c('LEDGER_ROWS', 'FAIL', `More than ${LEDGER_MAX_ROWS} rows.`) : rej ? c('LEDGER_ROWS', 'WARN', `${n} documents read, ${rej} rows rejected by the parser.`) : c('LEDGER_ROWS', 'PASS', `${n} documents read, 0 rejected.`)); }
  return { ready: !checks.some(x => x.status === 'FAIL'), checks, note: 'Counts and fixed wording only. Declarations are the seller\'s, not verified.' };
}

export const ADJUDICATIONS = Object.freeze(['CONFIRMED_REAL', 'FALSE_POSITIVE', 'COULD_NOT_CONFIRM']);
const num = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : NaN);
const KEY = 'loop:pilot';

/** Measurement record. Holds only numbers, issue keys (hashes) and fixed words. Lives in the same vault as everything else. */
export function createPilotRecord(adapter, { now = () => new Date().toISOString() } = {}) {
  const read = async () => (await adapter.get(KEY)) ?? { v: 1, times: {}, adjudications: {}, missedBySeller: 0 };
  const save = (r) => adapter.put(KEY, r);
  return {
    read,
    async setTimes({ manualMinutesBefore, toolMinutesWith }) { const a = num(manualMinutesBefore), b = num(toolMinutesWith); if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('Minutes must be numbers, zero or more.'); const r = await read(); r.times = { manualMinutesBefore: a, toolMinutesWith: b, basis: 'SELLER_REPORTED', at: now() }; await save(r); },
    async adjudicate(issueKey, outcome) { if (!ADJUDICATIONS.includes(outcome)) throw new Error('Unknown outcome.'); if (!/^[0-9a-f]{64}$/.test(String(issueKey))) throw new Error('Unknown finding.'); const r = await read(); r.adjudications[issueKey] = outcome; await save(r); },
    async setMissed(n) { const m = num(n); if (m === null || Number.isNaN(m) || !Number.isInteger(m)) throw new Error('Missed findings must be a whole number, zero or more.'); const r = await read(); r.missedBySeller = m; await save(r); },
  };
}

const STR_OK = new Set(['SELLER_REPORTED', 'MACHINE_VERIFIED_BY_LATER_FILE', 'aggregate-only', 'pilot-1']);
/** Throws if the object holds any string that is not a fixed word or a known enum. This is the guard behind the export. */
export function assertAggregateOnly(o, allowed = new Set()) {
  const walk = (x, path) => { if (x === null || typeof x === 'number' || typeof x === 'boolean') return; if (typeof x === 'string') { if (!(STR_OK.has(x) || allowed.has(x))) throw new Error(`Aggregate export refused: free text at ${path}`); return; }
    if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${path}[${i}]`)); for (const [k, v] of Object.entries(x)) { if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new Error(`Aggregate export refused: odd key at ${path}`); walk(v, `${path}.${k}`); } };
  walk(o, '$'); return true;
}

/** Aggregate metrics only: no order ids, no document numbers, no dates, no file names, no hashes. */
export function aggregateMetrics({ projection, record, imports = [] }) {
  const issues = projection.issues, adj = record.adjudications ?? {}, keys = new Set(issues.map(i => i.key));
  const by = (f) => issues.reduce((m, i) => { const k = f(i); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const mine = Object.entries(adj).filter(([k]) => keys.has(k)).map(([, v]) => v), n = (v) => mine.filter(x => x === v).length;
  const real = n('CONFIRMED_REAL'), fp = n('FALSE_POSITIVE'), cnc = n('COULD_NOT_CONFIRM'), judged = real + fp;
  const confirmedGaps = issues.filter(i => adj[i.key] === 'CONFIRMED_REAL' && ['BOOKS_GAP', 'UNMATCHED_DOCUMENT'].includes(i.family)).length;
  const t = record.times ?? {};
  const out = { pilotExportVersion: 'pilot-1', kind: 'aggregate-only',
    findings: { total: issues.length, byFamily: by(i => i.family), byState: by(i => i.state) },
    sellerAdjudication: { basis: 'SELLER_REPORTED', confirmedReal: real, falsePositive: fp, couldNotConfirm: cnc, notYetReviewed: issues.length - mine.length, precisionAmongReviewed: judged ? { value: Math.round(real / judged * 1000) / 1000, reviewed: judged } : null,
      confirmedMissingInvoiceOrAccountingGap: confirmedGaps, missedBySeller: record.missedBySeller ?? 0, recallComputable: false },
    cannotDetermine: (projection.buckets?.cannotDetermine ?? 0) + (projection.buckets?.needsHumanReading ?? 0),
    resolvedBySubsequentImports: { basis: 'MACHINE_VERIFIED_BY_LATER_FILE', count: projection.buckets?.closedWithEvidence ?? 0 },
    sellerReportedResolved: { basis: 'SELLER_REPORTED', count: projection.buckets?.reportedResolvedBySeller ?? 0 },
    time: t.basis ? { basis: 'SELLER_REPORTED', manualMinutesBefore: t.manualMinutesBefore, toolMinutesWith: t.toolMinutesWith, minutesSaved: Math.round((t.manualMinutesBefore - t.toolMinutesWith) * 10) / 10 } : null,
    imports: { amazonReports: imports.filter(i => i.kind === 'vidr').length, accountingExports: imports.filter(i => i.kind === 'ledger').length },
    sampleSize: { sellers: 1, note: 'one seller, one period; no market-wide claim' } };
  out.sampleSize.note = 'SELLER_REPORTED'; // fixed word; the human wording lives in the documents
  const allowed = new Set([...Object.keys(out.findings.byFamily), ...Object.keys(out.findings.byState)]);
  assertAggregateOnly(out, allowed); return out;
}
