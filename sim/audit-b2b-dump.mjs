// Runs the REAL engine (store, project, preflight, detectLedgerMapping) on N synthetic sellers and scores it against injected ground truth.
// usage: node sim/run.mjs [count] [outfile] [from]
import { writeFileSync, appendFileSync } from 'node:fs';
import { createLoopStore, Refused } from '../src/loop/store.js';
import { detectLedgerMapping, readLedger } from '../src/loop/ledger.js';
import { memoryAdapter } from '../src/history.js';
import { preflight } from '../src/loop/pilot.js';
import { VDECL } from '../tools/make-loop-fixtures.mjs';
import { rng, baseSeller, vidrText, ledgerFile } from './gen.mjs';
import { expand } from './scenarios.mjs';

const COUNT = Number(process.argv[2] || 500), OUT = process.argv[3] || '/tmp/sim-results.jsonl', FROM = Number(process.argv[4] || 0);
const FIELD_ORDER = ['number', 'kind', 'issueDate', 'operationDate', 'currency', 'gross', 'net', 'vat', 'orderRef', 'channel', 'buyerTaxId'];
const BIG = { 30: 3000, 250: 3000, 400: 5000 }, TRUNC = new Set([77, 388]);
const ms = (t) => Math.round(performance.now() - t);
let clockN = 0;

function vdecl(s, extra = {}, created = '2026-11-27T09:00:00Z') { return { ...VDECL(created, s.period[0], s.period[1]), marketplace: s.mk, ...extra }; }
function ldecl(s, o, extra = {}, exported = '2026-11-27T10:00:00Z') { return { exportedAt: exported, sourceSystem: 'sim-books-' + s.dia.id, marketplace: s.mk, periodFrom: s.period[0], periodTo: s.monthly ? s.period[1] : (exported || '').slice(0, 10), documentKinds: ['invoice'], complete: true, documentLevel: 'DOCUMENT', amazonScope: o.skipChannel ? { mode: 'ALL' } : { mode: 'CHANNEL', channelValues: [s.chanName] }, ...extra }; }

/** What a careful seller does in the page: take the reader's proposal, then choose by hand what it could not detect. Counts how much hand work was needed. */
function buildProfile(s, o, text) {
  const m = detectLedgerMapping(text); if (!m.ok) return { ok: false, error: m.error, manual: -1 };
  const truthHeaders = {}, skip = { kind: o.skipKind, channel: o.skipChannel, orderRef: o.skipOrder, buyerTaxId: o.skipBuyer };
  FIELD_ORDER.forEach((f, i) => { if (!skip[f]) truthHeaders[f] = s.dia.h[i]; });
  const p = { ...m.proposedProfile, columns: { ...m.proposedProfile.columns } }; let manual = 0, wrong = 0; const why = [];
  for (const [f, h] of Object.entries(truthHeaders)) { if (p.columns[f] === undefined) { p.columns[f] = h; manual++; why.push(f + ':' + (m.fields[f]?.status ?? '?')); } else if (p.columns[f] !== h) { wrong++; p.columns[f] = h; why.push(f + ':WRONG'); } }
  for (const f of Object.keys(p.columns)) if (!truthHeaders[f]) { delete p.columns[f]; wrong++; }
  if (!p.dateOrder) { p.dateOrder = s.dia.date; manual++; why.push('dateOrder'); } else if (p.dateOrder !== s.dia.date && !(s.dia.date === 'ISO' && p.dateOrder === 'ISO')) { why.push('dateOrder:WRONG'); wrong++; p.dateOrder = s.dia.date; }
  if (!p.decimal || p.decimal !== s.dia.dec) { if (p.decimal) { wrong++; why.push('decimal:WRONG'); } else { manual++; why.push('decimal'); } p.decimal = s.dia.dec; }
  p.thousands = s.dia.thousands ?? ''; p.constantKind = o.skipKind ? 'invoice' : null; p.unknownColumnsAcknowledged = true; p.confirmed = true;
  const probe = readLedger(text, p, { amazonScope: { mode: 'ALL' } });
  if (probe.rejected?.some(r => r.reasons.some(x => x.startsWith('UNREADABLE_KIND')))) { // localized document-type words the reader does not know
    const hasCn = s.extraDocs.some(d => d.kind === 'cn');
    if (hasCn) return { ok: false, error: 'KIND_UNREADABLE_WITH_CREDIT_NOTES (seller cannot map localized kind words; credit notes present)', manual: -2, why, kindImpossible: true };
    delete p.columns.kind; p.constantKind = 'invoice'; manual++; why.push('kind:LOCALIZED_WORDS_USED_CONSTANT');
  }
  return { ok: true, profile: p, manual, wrong, why, auto: manual === 0 && wrong === 0 };
}

/** Every confident (ACTION_REQUIRED) issue goes into exactly one bucket, so the precision denominator is always the sum of the buckets. */
function classifyConfident(s, proj, defects, expectedSource) {
  const c = { commercial: { total: 0, true: 0, false: 0, declarationDependent: 0, conflictingEvidence: 0, unscoredNonB2B: 0 }, source: { total: 0, expected: 0, unexpected: 0 } };
  for (const i of proj.issues) { if (i.state !== 'ACTION_REQUIRED') continue;
    if (i.family === 'SOURCE_INCOMPLETE') { c.source.total++; c.source[expectedSource ? 'expected' : 'unexpected']++; continue; }
    c.commercial.total++;
    if (s.notes.conflictingEvidence) { c.commercial.conflictingEvidence++; continue; }
    if (s.notes.declarationDependent && i.family === 'DUPLICATE_DOCUMENT') { c.commercial.declarationDependent++; continue; }
    const m = defects.filter(d => d.order === i.subject?.orderId || d.num === i.subject?.number);
    if (m.some(d => !d.optional && d.fams.includes(i.family))) c.commercial.true++; else if (m.some(d => d.optional)) c.commercial.unscoredNonB2B++; else c.commercial.false++; }
  return c;
}
function evaluate(s, proj, defects, { skipStaleCheck = false } = {}) {
  const issues = proj.issues, byOrder = new Map(), byNum = new Map();
  for (const i of issues) { for (const k of [i.subject?.orderId, i.subject?.orderRef]) if (k) (byOrder.get(k) ?? byOrder.set(k, []).get(k)).push(i); if (i.subject?.number) (byNum.get(i.subject.number) ?? byNum.set(i.subject.number, []).get(i.subject.number)).push(i); }
  const matched = new Set(), res = { defects: defects.filter(d => !d.optional).length, detected: 0, missed: [], misclassified: [], fpConfident: [], fpHedged: [], infoOnly: 0 };
  for (const d of defects) { const f = [...(byOrder.get(d.order) ?? []), ...(byNum.get(d.num) ?? [])]; f.forEach(x => matched.add(x)); if (d.optional) continue;
    if (!f.length) res.missed.push(d.type); else if (f.some(x => d.fams.includes(x.family))) res.detected++; else res.misclassified.push({ type: d.type, got: [...new Set(f.map(x => x.family + '/' + x.subtype + '/' + x.state))] }); }
  for (const i of issues) { if (matched.has(i)) continue; const info = { family: i.family, subtype: i.subtype, state: i.state }; if (i.state === 'AWAITING_NEW_EVIDENCE') res.infoOnly++; else if (i.state === 'ACTION_REQUIRED') res.fpConfident.push(info); else res.fpHedged.push(info); }
  // matched issues on a defect-bearing item whose family is outside the allowed set and confident = also confident-wrong extras
  res.extraConfident = [...matched].filter(i => i.state === 'ACTION_REQUIRED' && !defects.some(d => (d.order === i.subject?.orderId || d.num === i.subject?.number) && d.fams.includes(i.family))).map(i => ({ family: i.family, subtype: i.subtype }));
  return res;
}

async function runSeller(i, sc) {
  const R = rng(i * 7919 + 13), res = { seller: i, scenario: sc.id }, t0 = performance.now();
  const trunc = TRUNC.has(i); if (trunc) res.scenario = 'truncated_over_20000_rows';
  const s = baseSeller(i, R, { n: trunc ? 20001 : BIG[i] });
  s.monthly = (i * 13 + Math.floor(i / 35)) % 5 === 0 && !BIG[i] && !trunc; res.cohort = s.monthly ? 'monthly_export' : 'through_report_day';
  res.market = s.cc; res.dialect = s.dia.id; res.txs = s.n;
  const needs = sc.needs ?? {}, o = { skipKind: R() < 0.2, skipChannel: !needs.channel && R() < 0.3, skipOrder: !needs.order && R() < 0.3, skipBuyer: true, bom: R() < 0.2, crlf: R() < 0.2, quote: R() < 0.15 };
  if (BIG[i] || trunc) { Object.assign(o, { skipChannel: false, skipOrder: false }); }
  const scOut = trunc ? {} : (sc.run(s, R) ?? {}); Object.assign(o, { skipBuyer: scOut.skipBuyer ?? true });
  if (sc.id === 'credit_notes_in_books') o.skipKind = false;
  if (BIG[i] && !s.notes.noRealDefects) { // add realistic defects at scale so the answer is checkable
    const k = Math.floor(s.n / 50); for (let j = 0; j < k; j++) { const t = s.txs[j * 37 % s.n]; if (t.books) { t.books = false; s.defects.push({ type: 'amazon_invoice_missing_from_books', order: t.order, num: t.num, fams: ['BOOKS_GAP'] }); } } }
  if (s.cur !== 'EUR' && s.dia.dec === ',' && false) {}
  { const before = s.defects.length; s.dropped = []; s.defects = s.defects.filter(d => { const t = s.txs.find(x => x.order === d.order); const keep = !t || t.bvat || t.hideAmazon || d.fams.includes('D') || d.fams.includes('U'); if (!keep) { s.dropped.push(d); d.optional = true; } return true; }); res.droppedNonB2B = before - s.defects.length; }
  res.defects = s.defects.filter(d => !d.optional).length; res.ooc = s.ooc.length; res.notes = s.notes;
  // files
  let vText = vidrText(s, { rows: scOut.vidrRows ? scOut.vidrRows(s.txs) : s.txs }), lText = ledgerFile(s, o);
  const mv = scOut.malformed;
  if (mv !== undefined) { res.malformed = mv; const lines = lText.split('\n');
    if (mv === 0) lText = vText; else if (mv === 1) lText = ''; else if (mv === 2) vText = vText.split('\n')[0] + '\n'; else if (mv === 3) vText = Array.from({ length: 40 }, (_, j) => String.fromCharCode(...Array.from({ length: 30 }, (_, k) => (j * 31 + k * 17) % 255))).join('\n');
    else if (mv === 4) lText = lines.map((l, j) => (j % 10 === 5 ? l.split(s.dia.delim).slice(0, 4).join(s.dia.delim) : l)).join('\n'); else if (mv === 5) vText = vText.replace(/\t/g, ','); else if (mv === 6) lText = lines.map((l, j) => (j === 3 ? l.replace(/^/, '"') : l)).join('\n'); else if (mv === 7) lText = lines.slice(0, 5).concat([lines[0]], lines.slice(5)).join('\n'); }
  if (process.env.DUMP == String(i)) { writeFileSync('/tmp/dump-v.tsv', vText); writeFileSync('/tmp/dump-l.csv', lText); writeFileSync('/tmp/dump-meta.json', JSON.stringify({ period: s.period, mk: s.mk, hidden: s.txs.filter(t => t.hideAmazon).map(t => ({ num: t.num, order: t.order, bdate: t.bdate, od: t.od })) })); }
  res.vBytes = vText.length; res.lBytes = lText.length; res.lRows = lText.split('\n').length - 1;
  const vd = vdecl(s, scOut.vidrDecl), ld0 = ldecl(s, o, scOut.ledgerDecl);
  // mapping + preflight
  let pr = buildProfile(s, o, lText); res.mapping = pr.ok ? { auto: pr.auto, manual: pr.manual, wrong: pr.wrong, why: pr.why } : { error: pr.error };
  if (!pr.ok) { res.outcome = pr.kindImpossible ? 'blocked_kind_words' : 'blocked_mapping'; res.blockedBy = 'mapping: ' + String(pr.error).slice(0, 80); finish(res, t0, s, scOut); return res; }
  let pf; try { pf = preflight({ vidrText: vText, vidrDeclared: vd, ledgerText: lText, profile: pr.profile, ledgerDeclared: ld0 }); res.preflight = { ready: pf.ready, fail: pf.checks.filter(x => x.status === 'FAIL').map(x => x.id), warn: pf.checks.filter(x => x.status === 'WARN').map(x => x.id) }; } catch (e) { res.preflight = { crash: String(e.message).slice(0, 120) }; }
  if (trunc) { res.outcome = 'truncated_preflight_only'; finish(res, t0, s, scOut); return res; }
  const store = createLoopStore(memoryAdapter(), { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (clockN++) * 1000).toISOString() });
  try { await store.addVidr({ text: vText, declared: vd, fileName: 'vidr.tsv' }); await store.addLedger({ text: lText, profile: pr.profile, declared: ld0, fileName: 'books.csv' }); }
  catch (e) { res.outcome = e instanceof Refused ? 'refused_at_door' : 'crash_on_import'; res.blockedBy = String(e.message).slice(0, 140); finish(res, t0, s, scOut); return res; }
  try { const t = performance.now(); const proj = await store.project(); res.projectMs = ms(t); res.issueCount = proj.issues.length; res.buckets = proj.buckets; res.stats = proj.stats;
    const ledgerRead = readLedger(lText, pr.profile, { amazonScope: ld0.amazonScope }); res.ledgerRead = { docs: ledgerRead.documents?.length, rejected: ledgerRead.rejected?.length, truncated: ledgerRead.truncated };
    res.byFamily = {}; for (const x of proj.issues) { const k = x.family + '/' + x.subtype + '/' + x.state; res.byFamily[k] = (res.byFamily[k] ?? 0) + 1; }
    res.eval = evaluate(s, proj, s.defects); res.conf = classifyConfident(s, proj, s.defects, !!(s.notes.pilotLimit || s.notes.malformedVariant !== undefined)); res.nonB2bFlagged = s.dropped.filter(d => proj.issues.some(x => (x.subject?.orderId === d.order || x.subject?.number === d.num) && x.state === 'ACTION_REQUIRED')).length; res.nonB2bDropped = s.dropped.length; res.covNotes = (proj.coverageNotes ?? []).map(n => ({ reason: String(n.reason).slice(0, 220), count: n.count })); { const sd = proj.issues.find(x => x.subtype === 'DEFECTS'); if (sd) res.defectsText = String(JSON.stringify(sd)).replace(/^.*?"defects"/, '"defects"').slice(0, 600); }
    if (process.env.B2BDUMP) { const vl = vText.split('\n'), hdr = vl[0].split('\t'), oc = hdr.indexOf('order-id'), bc = hdr.indexOf('is-business-order'); for (const x of proj.issues.filter(y => y.state === 'ACTION_REQUIRED' && y.family !== 'SOURCE_INCOMPLETE')) { const rows = vl.filter(l => x.subject?.orderId && l.split('\t')[oc] === x.subject.orderId); const flags = rows.map(l => l.split('\t')[bc]); if (flags.length && flags.every(f => f !== 'TRUE')) appendFileSync(process.env.B2BDUMP, JSON.stringify({ seller: i, scenario: res.scenario, finding_id: x.key ?? x.id, family: x.family, subtype: x.subtype, state: x.state, order_id: x.subject.orderId, is_business_order_values: flags, header: hdr.join(','), raw_rows: rows }) + '\n'); } }
    if (process.env.FORENSIC && s.notes.conflictingEvidence) { const bad = proj.issues.filter(x => x.state === 'ACTION_REQUIRED' && x.family !== 'SOURCE_INCOMPLETE'), vl = vText.split('\n'), hdr = vl[0].split('\t'), oc = hdr.indexOf('order-id'); appendFileSync(process.env.FORENSIC, JSON.stringify({ seller: i, scenario: res.scenario, header: vl[0], findings: bad.map(x => ({ key: x.key ?? x.id, family: x.family, subtype: x.subtype, status: x.status, subject: x.subject, evidence: x.evidence, note: x.note ?? null, rawRows: vl.filter(l => l.split('\t')[oc] === x.subject?.orderId) })), books_rows: lText.split('\n').length - 1 }) + '\n'); }
    if (res.eval.missed.length) { const got = new Set(proj.issues.flatMap(x => [x.subject?.orderId, x.subject?.number])); res.missedDetail = s.defects.filter(d => !got.has(d.order) && !got.has(d.num)).map(d => { const t = s.txs.find(x => x.order === d.order) ?? {}; return { type: d.type, order: d.order, num: d.num, bnum: t.bnum, bOrder: t.bOrder, books: t.books, hide: !!t.hideAmazon, status: t.status, chan: t.bchan }; }); }
    res.silentLoss = (mv === 4 || mv === 6 || mv === 7) ? { expectedRows: s.txs.length, readDocs: ledgerRead.documents?.length ?? 0, anyDefectShown: !!(proj.coverageNotes?.length) } : undefined;
    // ---- round 2
    if (scOut.round2 && s.defects.length) await round2(s, o, scOut, store, pr, vd, ld0, res, vText);
  } catch (e) { res.outcome = 'crash_in_projection'; res.crash = String(e.stack ?? e).slice(0, 300); finish(res, t0, s, scOut); return res; }
  res.outcome = pf?.ready ? 'analysed_preflight_pass' : 'analysed_preflight_blocked'; finish(res, t0, s, scOut); return res;
}

async function round2(s, o, scOut, store, pr, vd, ld0, res, vText1) {
  const kind = scOut.round2; const fixed = new Set(); const defs = s.defects;
  const todo = defs.map((d, j) => ({ d, fix: kind === 'fixBooks' ? j % 2 === 0 : kind === 'fixCurrency' ? j % 2 === 0 : kind === 'fixSome' ? !!d.fixedInRound2 : kind === 'staleExport' || kind === 'fixAllButStaleReport' ? true : false }));
  if (kind !== 'declareOnly') for (const { d, fix } of todo) { if (!fix) continue; const t = s.txs.find(x => x.order === d.order); if (!t) continue; if (d.type.includes('missing_from_books')) t.books = true; if (d.type === 'currency_differs') t.bcur = t.cur; fixed.add(d.order); }
  const stale = kind === 'fixAllButStaleReport';
  const v2 = vidrText(s), l2 = ledgerFile(s, o), vd2 = vdecl(s, {}, stale ? '2026-11-20T09:00:00Z' : '2026-12-04T09:00:00Z'), ld2 = ldecl(s, o, scOut.ledgerDecl, '2026-12-04T10:00:00Z');
  try {
    if (kind === 'declareOnly') { const p0 = await store.project(); for (const x of p0.issues.filter(i => i.family === 'BOOKS_GAP')) { try { await store.addEvent({ type: 'RESOLUTION_DECLARED', kind: 'RESOLUTION_DECLARED', issueKey: x.key, author: 'seller', reasoning: 'I issued and uploaded it' }); } catch (e) { res.declareRefused = (res.declareRefused ?? 0) + 1; } } }
    else { await store.addVidr({ text: v2, declared: vd2, fileName: 'vidr2.tsv' }); await store.addLedger({ text: l2, profile: pr.profile, declared: ld2, fileName: 'books2.csv' }); }
    const p2 = await store.project(); const r2 = { closedCorrect: 0, closedWrong: 0, stillOpenCorrect: 0, stillOpenWrong: 0, lost: 0, declaredAsClosedWrong: 0, declaredStates: {} };
    for (const { d, fix } of todo) { const iss = p2.issues.filter(x => x.subject?.orderId === d.order || x.subject?.number === d.num).filter(x => d.fams.includes(x.family)); const st = iss.map(x => x.state);
      const shouldClose = fix && kind !== 'fixAllButStaleReport' && kind !== 'declareOnly';
      if (kind === 'declareOnly') { for (const x of st) r2.declaredStates[x] = (r2.declaredStates[x] ?? 0) + 1; if (st.includes('VERIFIED_CLOSED')) r2.declaredAsClosedWrong++; continue; }
      if (!iss.length) { r2.lost++; continue; }
      const closed = st.every(x => x === 'VERIFIED_CLOSED');
      if (shouldClose) closed ? r2.closedCorrect++ : r2.stillOpenWrong++; else closed ? r2.closedWrong++ : r2.stillOpenCorrect++; }
    r2.kind = kind; r2.states = Object.fromEntries(Object.entries(p2.buckets)); res.round2 = r2;
  } catch (e) { res.round2 = { kind, error: (e instanceof Refused ? 'refused: ' : 'crash: ') + String(e.message).slice(0, 160) }; }
}
function finish(res, t0, s, scOut) { res.totalMs = ms(t0); res.heapMB = Math.round(process.memoryUsage().heapUsed / 1048576); res.expectPreflightBlock = !!scOut.expectPreflightBlock; }

const sc = expand(500); writeFileSync(OUT, '');
for (let i = FROM; i < Math.min(COUNT + FROM, 500); i++) { let r; try { r = await runSeller(i, sc[i]); } catch (e) { r = { seller: i, scenario: sc[i].id, outcome: 'harness_crash', crash: String(e.stack).slice(0, 300) }; } appendFileSync(OUT, JSON.stringify(r) + '\n'); }
console.log('done', COUNT);
