// Local store for the problem loop. It keeps ONLY: imports (raw text, hash, declarations, confirmed mapping profile), the local profile id, and seller events.
// There is no state, no issue and no link in here. Everything else is computed by project() from these records.
import { project, LOOP_VERSION, KEY_VERSION } from './project.js';
import { sha256 } from './sha256.js';
import { profileProblems, readDelimited, PARSER_VERSION } from './ledger.js';
import { parseTable } from '../manual.js';
import { eventShapeProblem, declarationProblem } from './events.js';

const isoDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export class Refused extends Error { constructor(reasons) { super(reasons.join(' ')); this.code = 'REFUSED'; this.reasons = reasons; } }
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

/** Scope is required at the door. An import that cannot state its scope is refused, not stored, so every stored import has a scope descriptor. */
export function vidrDoorProblems(text, d = {}) {
  const p = []; for (const k of ['marketplace']) if (!String(d[k] ?? '').trim()) p.push(`Missing: ${k}.`);
  if (!isoDay(d.rangeFrom) || !isoDay(d.rangeTo)) p.push('Missing: the date range of the report (from and to, as YYYY-MM-DD).');
  if (!['ALL', 'PENDING_ONLY'].includes(d.options)) p.push('Missing: which report options were used (all statuses, or pending only).');
  const t = parseTable(text); if (t.unsupported || !t.rows.length) p.push(t.unsupported ?? 'The file has no data rows.');
  return p;
}
export function ledgerDoorProblems(text, profile, d = {}) {
  const p = []; if (!String(d.sourceSystem ?? '').trim()) p.push('Missing: the name of the accounting system.');
  if (!String(d.marketplace ?? '').trim()) p.push('Missing: the Amazon marketplace this export is declared for.');
  if (d.exportedAt !== undefined && d.exportedAt !== '' && Number.isNaN(Date.parse(d.exportedAt))) p.push('The export time is not a readable date and time.');
  if (!isoDay(d.periodFrom) || !isoDay(d.periodTo)) p.push('Missing: the period of the export (from and to, as YYYY-MM-DD).');
  if (!Array.isArray(d.documentKinds) || !d.documentKinds.length || d.documentKinds.some(k => !['invoice', 'credit_note'].includes(k))) p.push('Missing: which document kinds the export contains.');
  if (typeof d.complete !== 'boolean') p.push('Missing: whether this is a complete export of that period (yes or no).');
  const m = d.amazonScope?.mode; if (!['ALL', 'CHANNEL', 'UNKNOWN'].includes(m)) p.push('Missing: whether these documents are Amazon sales (all of them, only those in a channel column, or not declared).');
  if (m === 'CHANNEL' && (!(d.amazonScope.channelValues ?? []).length || !profile?.columns?.channel)) p.push('A channel-based Amazon declaration needs the channel column mapped and the channel values that mean Amazon.');
  const t = readDelimited(text, profile?.delimiter ?? null); if (!t.ok) p.push(t.error); else p.push(...profileProblems(profile, t.head));
  return p;
}

export function createLoopStore(adapter, { now = () => new Date().toISOString() } = {}) {
  const key = (k, id) => `loop:${k}:${id}`;
  const list = async (k) => { const out = []; for (const x of (await adapter.list()).filter(x => String(x).startsWith(`loop:${k}:`)).sort()) out.push(await adapter.get(x)); return out; };
  let seq = 0;
  const api = {
    async profileId() { let p = await adapter.get('loop:profile'); if (!p) { p = { id: 'p-' + hex(8), createdAt: now() }; await adapter.put('loop:profile', p); } return p.id; },
    async addVidr({ text, declared, fileName = null }) {
      const p = vidrDoorProblems(text, declared); if (p.length) throw new Refused(p);
      const sha = sha256(text), rec = { id: `imp-${now().replace(/\D/g, '').slice(0, 14)}-${sha.slice(0, 6)}-${seq++}`, kind: 'vidr', fileName, text, sha256: sha, declared, importedAt: now() };
      await adapter.put(key('import', rec.id), rec); return rec.id;
    },
    async addLedger({ text, profile, declared, fileName = null }) {
      const p = ledgerDoorProblems(text, profile, declared); if (p.length) throw new Refused(p);
      const sha = sha256(text), rec = { id: `imp-${now().replace(/\D/g, '').slice(0, 14)}-${sha.slice(0, 6)}-${seq++}`, kind: 'ledger', fileName, text, sha256: sha, declared, profile: { ...profile, savedWith: PARSER_VERSION }, importedAt: now() };
      await adapter.put(key('import', rec.id), rec); return rec.id;
    },
    async imports() { return list('import'); },
    async events() { return list('event'); },
    async project() { return project({ imports: await this.imports(), events: await this.events(), sellerProfileId: await this.profileId() }); },
    /** Records what the seller said. It checks the event against the current projection and refuses what the problem does not accept. It never writes a state. */
    async addEvent(e) {
      const ev = { ...e, createdAt: e.createdAt ?? now() }, bad = eventShapeProblem(ev); if (bad) throw new Refused([bad]);
      const r = await this.project();
      if (ev.type === 'LINK_DECISION') {
        const hit = r.issues.find(i => i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'PROPOSED_LINK_UNCONFIRMED' && i.subject?.ledgerKey === ev.ledgerKey && i.finding?.evidence?.candidate?.amazonId === ev.amazonId);
        if (!hit) throw new Refused(['There is no open proposal for that pair of documents, so there is nothing to confirm or reject.']);
      } else {
        const issue = r.issues.find(i => i.key === ev.issueKey); if (!issue) throw new Refused(['That problem is not in the current results.']);
        if (issue.state === 'VERIFIED_CLOSED') throw new Refused(['That problem is already closed by evidence.']);
        if (ev.type === 'RESOLUTION_DECLARED') { const d = declarationProblem(ev, issue.family, issue.subtype); if (d) throw new Refused([d]); ev.basedOnFingerprint = issue.fingerprint; }
        else ev.basedOnFingerprint = issue.fingerprint;
      }
      ev.id = `ev-${ev.createdAt.replace(/\D/g, '')}-${seq++}`; await adapter.put(key('event', ev.id), ev); return ev.id;
    },
    /** Evidence bundle: inputs, events, and the projection with what each closure rests on. No field adds declared resolutions to evidence-closed ones. */
    async bundle() {
      const r = await this.project(), imports = await this.imports(), events = await this.events();
      const b = r.buckets;
      return { bundleVersion: 1, kind: 'problem-loop', loopVersion: LOOP_VERSION, keyVersion: KEY_VERSION, sellerProfileId: r.sellerProfileId, createdAt: now(),
        matchedByInvoiceNumberMeaning: 'Matched by invoice number means an Amazon transaction and an accounting document carry the same document number and no problem of the kinds checked in this version was found. Amounts, taxes and differences are not examined in this version.',
        note: 'State of the loaded files on the dates they were loaded. Anything marked declared was said by the seller and is not confirmed by a file. No statement here is about the legal position of any document.',
        imports: imports.map(i => ({ id: i.id, kind: i.kind, fileName: i.fileName, sha256: i.sha256, importedAt: i.importedAt, declared: i.declared, profile: i.profile ?? null, text: i.text })),
        events, headline: { verifiedClosedByEvidence: b.closedWithEvidence, manuallyReportedResolutionDeclaredBySeller: b.reportedResolvedBySeller, needsActionNow: b.needsActionNow, needsHumanReading: b.needsHumanReading, awaitingNewEvidence: b.awaitingNewEvidence, cannotDetermine: b.cannotDetermine, inProgressAtAmazon: b.inProgressAtAmazon, matchedByInvoiceNumber: b.matchedByInvoiceNumber },
        issues: r.issues.map(i => ({ key: i.key, family: i.family, subtype: i.subtype, state: i.state, closureBasis: i.outcome, episodes: i.episodes, history: i.history, events: i.events, declaration: i.declaration, lapsedDeclarations: i.lapsedDeclarations, closure: i.closure, card: i.card })),
        coverageNotes: r.coverageNotes, rejectedEvents: r.rejectedEvents.map(x => ({ reason: x.reason, type: x.event.type })), notCheckedInThisVersion: r.notCheckedInThisVersion };
    },
    async deleteEverything() { await adapter.clear(); },
  };
  return api;
}
