import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EU27, intraEUShape } from './invoice.js';

/**
 * Country rule packs are living data (rules/*.json). Every rule carries its official source, a verified_on date and a review interval.
 * A rule that gates issuing (gate: true) holds new documents when it is unverified, overdue for review, or its source no longer contains the text it depends on.
 * Softer drift (the page changed, or could not be fetched) is flagged to the operator but does not stop work.
 */
export function loadPacks(dir = new URL('../rules/', import.meta.url)) {
  const packs = {};
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) { const p = JSON.parse(readFileSync(new URL(f, dir), 'utf8')); packs[p.country] = p; }
  return packs;
}
export const PACKS = loadPacks();
const asOf = (now) => process.env.RULES_ASOF ? new Date(process.env.RULES_ASOF) : (now ?? new Date());

export function ensureRuleTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rule_state (rule_id TEXT PRIMARY KEY, source_hash TEXT, baseline_hash TEXT, anchors_missing TEXT, fetch_status TEXT, checked_at TEXT, reviewed_on TEXT, reviewed_by TEXT, review_note TEXT)`);
}

/** Effective state of one rule: 'ok' | 'flag' | 'hold', with plain-language reasons. */
export function ruleState(db, pack, rule, now = new Date()) {
  ensureRuleTables(db);
  const st = db.prepare('SELECT * FROM rule_state WHERE rule_id=?').get(rule.id) ?? {};
  const verifiedOn = st.reviewed_on ?? rule.verified_on, every = rule.review_every_days ?? pack.review_every_days ?? 90;
  const ageDays = Math.floor((asOf(now) - new Date(verifiedOn)) / 864e5);
  const missing = st.anchors_missing ? JSON.parse(st.anchors_missing) : [];
  const hard = [], soft = [];
  if (rule.status === 'secondary' && !st.reviewed_on) hard.push('Confirmed only from secondary sources. Read the official text before relying on it.');
  else if (rule.status !== 'verified' && !st.reviewed_on) hard.push('Not verified yet: the source has not been read.');
  if (ageDays > every) hard.push(`Not re-verified for ${ageDays} days (limit ${every}).`);
  if (rule.valid_until) {
    const left = Math.floor((new Date(rule.valid_until + 'T23:59:59Z') - asOf(now)) / 864e5);
    if (left < 0) hard.push(`Safety hold: our verification of this rule ran to ${rule.valid_until}. The law may still apply, but we have not yet read the replacing source, so we do not guess.`);
    else if (left <= 45) soft.push(`This rule must be re-verified by ${rule.valid_until} (${left} days left). Read the replacing source before then.`);
  }
  if (missing.length) hard.push('The official source no longer contains text this rule depends on.');
  if (st.baseline_hash && st.source_hash && st.baseline_hash !== st.source_hash) soft.push('The source page changed since it was last reviewed.');
  if (st.fetch_status && st.fetch_status !== 'ok') soft.push('The source could not be fetched at the last check.');
  const state = rule.gate && hard.length ? 'hold' : (hard.length || soft.length ? 'flag' : 'ok');
  return { id: rule.id, country: pack.country, topic: rule.topic, gate: !!rule.gate, state, reasons: [...hard, ...soft], verifiedOn, ageDays, every, checkedAt: st.checked_at ?? null, missing, canReview: !missing.length && rule.status === 'verified' || !!st.reviewed_on };
}

export function allRuleStates(db, now = new Date(), packs = PACKS, { operator = false } = {}) {
  // canReview lets someone mark a source re-read; that decision belongs to the operator only,
  // so the flag is stripped for ordinary sellers (a user click must never un-gate a stale rule).
  return Object.values(packs).map(p => ({ country: p.country, name: p.name, coverage: p.coverage, marketplaceId: p.marketplace_id, rules: p.rules.map(r => { const st = ruleState(db, p, r, now); return { ...r, ...st, canReview: operator && st.canReview }; }) }));
}

/** Packs that govern a document: the issuer's country, the EU base, and Amazon. */
export function governingPacks(sellerCountry = 'ES', packs = PACKS) { return ['EU', 'AMAZON', sellerCountry].map(c => packs[c]).filter(Boolean); }

/**
 * Can this issuer country's pack support the action at all? Never fall back to another country's rules.
 * issue: needs a verified content rule with machine.required. correct: needs a verified correction rule with machine.methods.
 */
export function readiness(country, scope = 'issue', packs = PACKS) {
  const pack = packs[country]; if (!pack) return { ok: false, reason: `No rule pack exists for ${country}. Nothing is issued until one is written and sourced.` };
  if (scope === 'issue') { const r = pack.rules.find(x => x.topic === 'content' && x.machine?.required && x.status === 'verified'); return r ? { ok: true, rule: r.id } : { ok: false, reason: `The ${country} pack has no verified invoice-content rule yet, so invoices are held instead of guessed.` }; }
  const r = pack.rules.find(x => x.topic === 'correction' && x.machine?.methods && x.status === 'verified');
  return r ? { ok: true, rule: r.id, methods: r.machine.methods, amountChanges: r.machine.amountChanges !== false } : { ok: false, reason: `The ${country} pack has no verified correction rule yet, so corrections are held instead of guessed.` };
}

/** Seller details that some country rules require. Nothing is defaulted: a missing value holds invoices. */
export const PROFILE_FIELDS = ['registrationNo', 'paymentTermsDays', 'discountTerms', 'latePenaltyRate', 'recoveryIndemnity'];
export function cleanProfile(p = {}) {
  const out = {}, err = [];
  const str = (k, max = 200) => { const v = p[k]; if (v == null || String(v).trim() === '') return; const t = String(v).trim(); if (t.length > max) err.push(`${k} is too long`); else out[k] = t; };
  str('registrationNo', 40); str('discountTerms'); str('latePenaltyRate', 120); str('recoveryIndemnity', 120);
  if (p.paymentTermsDays != null && String(p.paymentTermsDays).trim() !== '') { const n = Number(p.paymentTermsDays); if (!Number.isInteger(n) || n < 0 || n > 365) err.push('paymentTermsDays must be a whole number of days from 0 to 365'); else out.paymentTermsDays = n; }
  return { profile: out, errors: err };
}
export function sellerProfile(seller) { try { return JSON.parse(seller?.profile || '{}') || {}; } catch { return {}; } }

/** Holds from gate rules. scope 'issue' for new invoices, 'correct' adds correction gates. */
export function gate(db, sellerCountry, scope = 'issue', now = new Date(), packs = PACKS) {
  const wanted = scope === 'correct' ? () => true : (r) => r.topic !== 'correction';
  const holds = [];
  for (const p of governingPacks(sellerCountry, packs)) for (const r of p.rules) {
    if (!r.gate || !wanted(r)) continue;
    const s = ruleState(db, p, r, now); if (s.state === 'hold') holds.push({ id: r.id, why: s.reasons[0], source: r.source.url });
  }
  return { ok: !holds.length, holds };
}
export const gateReason = (g) => `Rule pack on hold: ${g.holds.map(h => `${h.id} (${h.why})`).join('; ')}. Review it in the Rules tab.`;

const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
/** Check an invoice document against the issuer country's content rule. Returns a list of missing items. */
export function missingFields(doc, sellerCountry = 'ES', packs = PACKS, { shipment = null } = {}) {
  const rule = packs[sellerCountry]?.rules.find(r => r.id.endsWith('-INV-CONTENT') && r.machine); if (!rule) return [];
  const m = rule.machine, out = [];
  for (const k of m.required) { const v = get(doc, k); if (v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'string' && !v.trim())) out.push(k); }
  for (const [i, l] of (doc.lines ?? []).entries()) for (const k of m.lineRequired ?? []) if (l[k] == null || l[k] === '') out.push(`lines[${i}].${k}`);
  // Only a document that has the shape of an intra-EU exempt supply of goods needs a buyer VAT number. With the shipment at hand its ship-from/ship-to countries decide; otherwise the document's own buyer country. Exports, zero-value documents and free replacements never match.
  const intraShape = shipment ? intraEUShape(shipment) : (doc.totals?.vat === 0 && doc.totals?.excl > 0 && EU27.has(doc.buyerCountry) && EU27.has(sellerCountry) && doc.buyerCountry !== sellerCountry);
  const exemptIntra = m.buyerVatRequiredWhenExemptIntraEU && intraShape && !doc.buyer?.vat;
  if (exemptIntra) out.push('buyer.vat (required for exempt intra-EU supplies)');
  for (const k of m.requiredWhenBuyerCountry?.[doc.buyerCountry] ?? []) { const v = get(doc, k); if (v == null || String(v).trim() === '') out.push(k); }
  if (m.exemptNoteRequired && doc.totals?.vat === 0 && doc.totals?.excl > 0 && !doc.vatNote?.text && !doc.vatNote) out.push('vatNote (reference to the exemption)');
  return out;
}

/** Legal issue deadline for a B2B invoice: the last day before day N of the month after the operation. */
export function legalDeadline(operationDate, sellerCountry = 'ES', packs = PACKS) {
  const d = new Date(operationDate); if (isNaN(d)) return null;
  const rule = packs[sellerCountry]?.rules.find(r => r.machine?.beforeDayOfNextMonth && r.topic === 'deadline');
  const last = rule ? rule.machine.beforeDayOfNextMonth - 1 : 15;
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, last));
  return { date: out.toISOString().slice(0, 10), rule: rule?.id ?? 'EU-INTRA-15TH' };
}

/** Rectificativa window (Spain: four years). */
export function correctionWindowOk(originalDate, sellerCountry, now = new Date(), packs = PACKS) {
  const rule = packs[sellerCountry]?.rules.find(r => r.machine?.maxYears); if (!rule) return { ok: true };
  const limit = new Date(originalDate); limit.setUTCFullYear(limit.getUTCFullYear() + rule.machine.maxYears);
  return { ok: asOf(now) <= limit, rule: rule.id, limit: limit.toISOString().slice(0, 10) };
}

// ---- source monitoring ----
const ENT = { aacute:'á', eacute:'é', iacute:'í', oacute:'ó', uacute:'ú', ntilde:'ñ', uuml:'ü', ouml:'ö', auml:'ä', amp:'&', quot:'"', apos:"'", nbsp:' ', ccedil:'ç', egrave:'è', agrave:'à', ordm:'º', ordf:'ª' };
const decode = (t) => t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const norm = (t) => decode(String(t).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().toLowerCase();
// PDFs keep their text compressed, so the page text cannot be searched for anchors. Such a source is watched by a fingerprint of its bytes only (change detection), and its rules carry no anchors.
async function readPage(res) { const buf = typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), 'utf8'); if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf-fingerprint:' + createHash('sha256').update(buf).digest('hex'); return norm(buf.toString('utf8')); }
export async function checkSources(db, { fetchImpl = fetch, now = new Date(), packs = PACKS, only } = {}) {
  ensureRuleTables(db); const cache = new Map(), out = [];
  // Fetch each distinct source once, 8 at a time with a 10 s limit, so a check finishes in seconds instead of minutes.
  const urls = [...new Set(Object.values(packs).flatMap(p => p.rules).filter(r => (!only || r.id === only) && !(r.status === 'unverified' && !r.anchors)).map(r => r.source.url))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => { while (next < urls.length) { const url = urls[next++]; const page = { status: 'ok', text: '' };
    try { const res = await fetchImpl(url, { headers: { 'user-agent': 'InvoiceGuard-rulecheck/1.0' }, signal: AbortSignal.timeout(10000) }); if (!res.ok) page.status = 'http_' + res.status; else page.text = await readPage(res); } catch { page.status = 'unreachable'; }
    cache.set(url, page); } }));
  for (const p of Object.values(packs)) for (const r of p.rules) {
    if (only && r.id !== only) continue;
    if (r.status === 'unverified' && !r.anchors) continue;
    let page = cache.get(r.source.url);
    if (!page) {
      page = { status: 'ok', text: '' };
      try { const res = await fetchImpl(r.source.url, { headers: { 'user-agent': 'InvoiceGuard-rulecheck/1.0' }, signal: AbortSignal.timeout(20000) }); if (!res.ok) page.status = 'http_' + res.status; else page.text = await readPage(res); }
      catch (e) { page.status = 'unreachable'; }
      cache.set(r.source.url, page);
    }
    const prev = db.prepare('SELECT * FROM rule_state WHERE rule_id=?').get(r.id);
    const hash = page.status === 'ok' ? createHash('sha256').update(page.text).digest('hex') : prev?.source_hash ?? null;
    const missing = page.status === 'ok' ? (r.anchors ?? []).filter(a => !page.text.includes(a.toLowerCase())) : (prev?.anchors_missing ? JSON.parse(prev.anchors_missing) : []);
    db.prepare(`INSERT INTO rule_state (rule_id, source_hash, baseline_hash, anchors_missing, fetch_status, checked_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(rule_id) DO UPDATE SET source_hash=excluded.source_hash, anchors_missing=excluded.anchors_missing, fetch_status=excluded.fetch_status, checked_at=excluded.checked_at, baseline_hash=COALESCE(rule_state.baseline_hash, excluded.baseline_hash)`)
      .run(r.id, hash, hash, JSON.stringify(missing), page.status, now.toISOString());
    out.push({ id: r.id, fetch: page.status, missing });
  }
  return out;
}
/** An operator confirms they re-read the source. Cannot clear a rule whose source lost its anchor text: that needs a pack update. */
export function reviewRule(db, ruleId, who, note, now = new Date(), packs = PACKS) {
  ensureRuleTables(db);
  const rule = Object.values(packs).flatMap(p => p.rules).find(r => r.id === ruleId); if (!rule) throw new Error('Unknown rule');
  const st = db.prepare('SELECT * FROM rule_state WHERE rule_id=?').get(ruleId);
  if (st?.anchors_missing && JSON.parse(st.anchors_missing).length) throw new Error('The source no longer contains text this rule depends on. The rule pack must be updated before it can be marked reviewed.');
  if (rule.status !== 'verified') throw new Error('This rule has never been verified. It needs to be written and sourced in the pack first.');
  db.prepare(`INSERT INTO rule_state (rule_id, baseline_hash, reviewed_on, reviewed_by, review_note) VALUES (?,?,?,?,?)
    ON CONFLICT(rule_id) DO UPDATE SET baseline_hash=COALESCE(rule_state.source_hash, rule_state.baseline_hash), reviewed_on=excluded.reviewed_on, reviewed_by=excluded.reviewed_by, review_note=excluded.review_note`)
    .run(ruleId, st?.source_hash ?? null, now.toISOString().slice(0, 10), who, note ?? null);
}
