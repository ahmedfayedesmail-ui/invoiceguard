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

/** The established pilot scope: one marketplace and one period, taken from the earliest stored Amazon report. */
export function pilotScope(imports = []) {
  const v = imports.filter(i => i.kind === 'vidr'), keys = new Set(v.map(i => `${i.declared?.marketplace}|${i.declared?.rangeFrom}|${i.declared?.rangeTo}`));
  const first = [...v].sort((x, y) => String(x.importedAt).localeCompare(String(y.importedAt)))[0];
  return { first: first ? { marketplace: first.declared?.marketplace, rangeFrom: first.declared?.rangeFrom, rangeTo: first.declared?.rangeTo } : null,
    distinctPeriods: new Set(v.map(i => `${i.declared?.rangeFrom}|${i.declared?.rangeTo}`)).size, distinctMarketplaces: new Set(v.map(i => i.declared?.marketplace)).size, distinctScopes: keys.size };
}

/** Checks the Amazon report and the accounting export BEFORE anything is stored. Either side may be absent (one file at a time): checks that need both then wait.
 *  `scope` is the established pilot scope (from files already stored), if any. Output has no file values. The source type rests on the seller's declaration. */
export function preflight({ vidrText, vidrDeclared, ledgerText, profile, ledgerDeclared, scope = null, maxDays = PILOT_MAX_DAYS }) {
  const checks = [], vd = vidrDeclared, ld = ledgerDeclared, hasV = vd !== undefined && vd !== null, hasL = ld !== undefined && ld !== null;
  if (hasV) {
    const t = parseTable(String(vidrText ?? ''));
    checks.push(t.unsupported || !t.rows?.length ? c('SOURCE_TYPE', 'FAIL', 'The Amazon file is not a readable tab-delimited table with data rows.')
      : vd.reportType !== REPORT_TYPE ? c('SOURCE_TYPE', 'FAIL', 'It was not declared that this is the Amazon VAT invoice data report.')
      : c('SOURCE_TYPE', 'PASS', `Seller-declared as the Amazon VAT invoice report. The table was read (${t.rows.length} data rows); the origin of the file cannot be verified by this tool.`));
    checks.push(vd.options === 'ALL' ? c('REPORT_OPTIONS', 'PASS', 'Declared by the seller: all statuses.') : c('REPORT_OPTIONS', 'FAIL', 'The pilot needs the all-status report; pending-only or undeclared hides problems.'));
    if (!isoDay(vd.rangeFrom) || !isoDay(vd.rangeTo) || vd.rangeFrom > vd.rangeTo) checks.push(c('PERIOD', 'FAIL', 'The Amazon report period is missing or reversed.'));
    else if (days(vd.rangeFrom, vd.rangeTo) > maxDays) checks.push(c('PERIOD', 'FAIL', `The period is ${days(vd.rangeFrom, vd.rangeTo)} days; the pilot is bounded to ${maxDays}.`));
    else checks.push(c('PERIOD', 'PASS', `Declared period of ${days(vd.rangeFrom, vd.rangeTo)} days.`));
    checks.push(vd.createdAfterUploadConfirmed === true && vd.createdAt ? c('REPORT_FRESH', 'PASS', 'Declared as created after the uploads, with its creation time.') : c('REPORT_FRESH', 'WARN', 'Not declared as created after the uploads; closure by evidence will not be possible for this file.'));
  }
  if (hasL) {
    checks.push(ld.complete === true ? c('LEDGER_COMPLETE', 'PASS', 'Declared by the seller as a complete export of the period (not verified by this tool).') : c('LEDGER_COMPLETE', 'FAIL', 'The accounting export is not declared complete; missing-invoice findings would not be reliable.'));
    checks.push(ld.amazonScope?.mode === 'UNKNOWN' ? c('AMAZON_SCOPE', 'WARN', 'It is not declared which accounting documents are Amazon sales.') : ['ALL', 'CHANNEL'].includes(ld.amazonScope?.mode) ? c('AMAZON_SCOPE', 'PASS', `Amazon scope declared (${ld.amazonScope.mode}).`) : c('AMAZON_SCOPE', 'FAIL', 'The Amazon scope of the accounting export is missing.'));
    if (!isoDay(ld.periodFrom) || !isoDay(ld.periodTo) || ld.periodFrom > ld.periodTo) checks.push(c('LEDGER_PERIOD', 'FAIL', 'The accounting export period is missing or reversed.'));
  }
  if (hasV && hasL) {
    checks.push(isoDay(ld.periodFrom) && isoDay(ld.periodTo) && isoDay(vd.rangeFrom) && isoDay(vd.rangeTo) && ld.periodFrom <= vd.rangeFrom && ld.periodTo >= vd.rangeTo ? c('PERIOD_COVERAGE', 'PASS', 'The accounting export period covers the Amazon report period.') : c('PERIOD_COVERAGE', 'FAIL', 'The accounting export period is missing or does not cover the Amazon report period.'));
    checks.push(vd.marketplace && vd.marketplace === ld.marketplace ? c('MARKETPLACE', 'PASS', 'Both files are declared for the same marketplace.') : c('MARKETPLACE', 'FAIL', 'The marketplace is missing or differs between the two files.'));
  }
  const mk = hasV ? vd.marketplace : ld?.marketplace, from = hasV ? vd.rangeFrom : ld?.periodFrom, to = hasV ? vd.rangeTo : ld?.periodTo;
  if (scope?.first) checks.push(mk === scope.first.marketplace && (hasV ? from === scope.first.rangeFrom && to === scope.first.rangeTo : ld.periodFrom <= scope.first.rangeFrom && ld.periodTo >= scope.first.rangeTo)
    ? c('PILOT_SCOPE', 'PASS', 'Same marketplace and period as the files already stored for this pilot.') : c('PILOT_SCOPE', 'FAIL', 'This file is for a different marketplace or period than the files already stored. One pilot is one marketplace and one period: delete the stored files first, or use a separate vault.'));
  if (hasV) { const vp = vidrDoorProblems(String(vidrText ?? ''), vd); if (vp.length) checks.push(c('COMPATIBILITY', 'FAIL', `${vp.length} requirement(s) of the import door are not met.`)); }
  if (hasL) { const lp = ledgerDoorProblems(String(ledgerText ?? ''), profile, ld); checks.push(lp.length ? c('COMPATIBILITY', 'FAIL', `${lp.length} requirement(s) of the import door are not met.`) : c('COMPATIBILITY', 'PASS', 'The accounting export passes the import door.'));
    if (!lp.length) { const r = readLedger(String(ledgerText ?? ''), profile, {}); const n = r.documents?.length ?? 0, rej = r.rejected?.length ?? 0;
      checks.push(!r.ok ? c('LEDGER_ROWS', 'FAIL', 'The accounting export could not be read with this column mapping.') : n + rej > LEDGER_MAX_ROWS ? c('LEDGER_ROWS', 'FAIL', `More than ${LEDGER_MAX_ROWS} rows.`) : rej ? c('LEDGER_ROWS', 'WARN', `${n} documents read, ${rej} rows rejected by the parser.`) : c('LEDGER_ROWS', 'PASS', `${n} documents read, 0 rejected.`)); } }
  if (!(hasV && hasL)) checks.push(c('PAIR', 'NOTE', 'Only one of the two files is being checked now. The checks that compare both files run when the second file is loaded.'));
  return { ready: !checks.some(x => x.status === 'FAIL'), checks, warnings: checks.filter(x => x.status === 'WARN').map(x => x.id), note: 'Counts and fixed wording only. Everything about the source is declared by the seller, not verified.' };
}

/** Preflight of what is already stored (latest of each kind), for the whole pilot dataset. */
export function preflightStored(imports) {
  const v = [...imports].reverse().find(i => i.kind === 'vidr'), l = [...imports].reverse().find(i => i.kind === 'ledger'), sc = pilotScope(imports);
  const r = preflight({ vidrText: v?.text, vidrDeclared: v?.declared, ledgerText: l?.text, profile: l?.profile, ledgerDeclared: l?.declared });
  if (sc.distinctScopes > 1) { r.checks.push(c('PILOT_SCOPE', 'FAIL', `The stored Amazon reports cover ${sc.distinctScopes} different marketplace/period combinations. One pilot is one marketplace and one period.`)); r.ready = false; }
  return r;
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
    async setTimes({ manualMinutesBefore, toolMinutesWith }) { const a = num(manualMinutesBefore), b = num(toolMinutesWith); if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) throw new Error('Both times are required: enter a number of minutes, zero or more, for each. An empty box is not zero.'); const r = await read(); r.times = { manualMinutesBefore: a, toolMinutesWith: b, basis: 'SELLER_REPORTED', at: now() }; await save(r); },
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
  const sc = pilotScope(imports); if (sc.distinctScopes > 1) throw new Error('The stored files cover more than one marketplace or period, so they are not one pilot. Delete the extra files before creating a pilot result.');
  const pf = preflightStored(imports);
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
    time: t.basis && Number.isFinite(t.manualMinutesBefore) && Number.isFinite(t.toolMinutesWith) ? { basis: 'SELLER_REPORTED', manualMinutesBefore: t.manualMinutesBefore, toolMinutesWith: t.toolMinutesWith, minutesSaved: Math.round((t.manualMinutesBefore - t.toolMinutesWith) * 10) / 10 } : null,
    imports: { amazonReports: imports.filter(i => i.kind === 'vidr').length, accountingExports: imports.filter(i => i.kind === 'ledger').length },
    pilotScope: { distinctMarketplaces: sc.distinctMarketplaces, distinctPeriods: sc.distinctPeriods, periodDays: sc.first && isoDay(sc.first.rangeFrom) && isoDay(sc.first.rangeTo) ? days(sc.first.rangeFrom, sc.first.rangeTo) : null },
    preflightOnThisData: { ready: pf.ready, fail: pf.checks.filter(x => x.status === 'FAIL').length, warn: pf.checks.filter(x => x.status === 'WARN').length } };
  const allowed = new Set([...Object.keys(out.findings.byFamily), ...Object.keys(out.findings.byState)]);
  assertAggregateOnly(out, allowed); return out;
}
