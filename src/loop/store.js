// Local store for the problem loop. It keeps ONLY: imports (raw text, hash, declarations, confirmed mapping profile), the local profile id, and seller events.
// There is no state, no issue and no link in here. Everything else is computed by project() from these records.
import { project, LOOP_VERSION, KEY_VERSION } from './project.js';
import { sha256 } from './sha256.js';
import { profileProblems, readDelimited, PARSER_VERSION } from './ledger.js';
import { parseTable } from '../manual.js';
import { eventShapeProblem, declarationProblem, DECLARATION_TYPES } from './events.js';

const isoDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export const DELETION_EXPORT_NOTICE = 'This export contains a record of the files you deleted: their names, their fingerprints (SHA-256), the time of each deletion and which problems each one touched. It does not contain what was inside those files. Anyone who receives this export can read those names and times.';
export const RESTORE_WARNING = 'A restore puts your workspace back exactly as it was when the backup was made. Files you deleted after that backup come back with it, and the records of those deletions are not in it, so they will not be shown as deleted.';
export const PENDING_GRACE_MS = 5 * 60 * 1000; // a PENDING deletion record whose file is still present is discarded after this
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

/** A seller statement is orphaned when the problem it is about is gone, or (a link decision) when taking it away changes nothing in the results. */
const sig = (r) => JSON.stringify(r.issues.map(i => [i.key, i.state, i.fingerprint]).sort());
function orphanedEvents(events, after, imports, pid, deletions = []) {
  const keys = new Set(after.issues.map(i => i.key)), base = sig(after);
  return events.filter(e => e.type === 'LINK_DECISION' ? sig(project({ imports, events: events.filter(x => x !== e), sellerProfileId: pid, deletions })) === base : !keys.has(e.issueKey));
}
export function createLoopStore(adapter, { now = () => new Date().toISOString(), offsetMinutes = () => -new Date().getTimezoneOffset() } = {}) {
  const key = (k, id) => `loop:${k}:${id}`;
  const list = async (k) => { const out = []; for (const x of (await adapter.list()).filter(x => String(x).startsWith(`loop:${k}:`)).sort()) out.push(await adapter.get(x)); return out; };
  let seq = 0;
  const pruneOrphans = async () => { const imports = await list('import'), events = await list('event'), pid = await api.profileId(), deletions = (await list('deletion')).filter(d => (d.status ?? 'COMMITTED') === 'COMMITTED'), after = project({ imports, events, sellerProfileId: pid, deletions }); let n = 0; for (const e of orphanedEvents(events, after, imports, pid, deletions)) { await adapter.del(key('event', e.id)); n++; } return n; };
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
    /** The permanent record of deleted imports: which file, when, why, and which problems it touched. It never holds file content. */
    async deletions() { return list('deletion'); },
    async committedDeletions() { return (await list('deletion')).filter(d => (d.status ?? 'COMMITTED') === 'COMMITTED'); },
    /** Settles every PENDING deletion record by looking at whether its file is really gone. File gone: the record is completed (COMMITTED), once, under its own id. File present and the attempt older than the grace period: the deletion never happened, the record is discarded and the data is untouched. File present and the attempt is recent: left alone, because another tab may be mid-deletion; it counts as no deletion. Idempotent. */
    async recoverDeletions() {
      const out = { committed: [], discarded: [], pending: [] };
      for (const rec of (await list('deletion')).filter(d => d.status === 'PENDING')) {
        if (!(await adapter.get(key('import', rec.import.id)))) { await adapter.put(key('deletion', rec.id), { ...rec, status: 'COMMITTED', committedAt: now() }); out.committed.push(rec.id); }
        else if (Date.parse(now()) - Date.parse(rec.attemptedAt ?? rec.deletedAt) > PENDING_GRACE_MS) { await adapter.del(key('deletion', rec.id)); out.discarded.push(rec.id); }
        else out.pending.push(rec.id);
      }
      if (out.committed.length) await pruneOrphans();
      return out;
    },
    async project() { await this.recoverDeletions(); return project({ imports: await this.imports(), events: await this.events(), sellerProfileId: await this.profileId(), deletions: await this.committedDeletions() }); },
    /** Records what the seller said. It checks the event against the current projection and refuses what the problem does not accept. It never writes a state. */
    async addEvent(e) {
      const ev = { ...e, createdAt: e.createdAt ?? now() }, bad = eventShapeProblem(ev); if (bad) throw new Refused([bad]);
      const r = await this.project();
      if (ev.type === 'LINK_DECISION') {
        const hit = r.issues.find(i => i.family === 'UNMATCHED_DOCUMENT' && i.subtype === 'PROPOSED_LINK_UNCONFIRMED' && i.subject?.ledgerKey === ev.ledgerKey && i.finding?.evidence?.candidate?.amazonId === ev.amazonId);
        if (!hit) throw new Refused(['There is no open proposal for that pair of documents, so there is nothing to confirm or reject.']);
      } else {
        const issue = r.issues.find(i => i.key === ev.issueKey); if (!issue) throw new Refused(['That problem is not in the current results.']);
        if (issue.placeholder) throw new Refused(['The history of that problem is incomplete because a file was deleted, so no new statement can be attached to it.']);
        if (issue.state === 'VERIFIED_CLOSED') throw new Refused(['That problem is already closed by evidence.']);
        if (DECLARATION_TYPES.includes(ev.type)) { const d = declarationProblem(ev, issue.family, issue.subtype); if (d) throw new Refused([d]); ev.basedOnFingerprint = issue.fingerprint; }
        else ev.basedOnFingerprint = issue.fingerprint;
      }
      ev.id = `ev-${ev.createdAt.replace(/\D/g, '')}-${seq++}`; await adapter.put(key('event', ev.id), ev); return ev.id;
    },
    /** Evidence bundle: inputs, events, and the projection with what each closure rests on. No field adds declared resolutions to evidence-closed ones. */
    async bundle() {
      const r = await this.project(), imports = await this.imports(), events = await this.events(), deletions = await this.committedDeletions();
      const b = r.buckets;
      return { bundleVersion: 1, kind: 'problem-loop', loopVersion: LOOP_VERSION, keyVersion: KEY_VERSION, sellerProfileId: r.sellerProfileId, createdAt: now(),
        matchedByInvoiceNumberMeaning: 'Matched by invoice number means an Amazon transaction and an accounting document carry the same document number. For each such pair the currency and the buyer tax id are compared where both sides state them exactly, and all differences of a pair are shown in one problem. The invoice total (the Amazon report states the item price, not the invoice total), net and VAT amounts, dates, line items and tax rates are not compared in this version.',
        note: 'State of the loaded files on the dates they were loaded. Anything marked declared was said by the seller and is not confirmed by a file. No statement here is about the legal position of any document.',
        imports: imports.map(i => ({ id: i.id, kind: i.kind, fileName: i.fileName, sha256: i.sha256, importedAt: i.importedAt, declared: i.declared, profile: i.profile ?? null, text: i.text })),
        events, deletions, deletionRecordNotice: DELETION_EXPORT_NOTICE, headline: { verifiedClosedByEvidence: b.closedWithEvidence, manuallyReportedResolutionDeclaredBySeller: b.reportedResolvedBySeller, needsActionNow: b.needsActionNow, needsHumanReading: b.needsHumanReading, awaitingNewEvidence: b.awaitingNewEvidence, cannotDetermine: b.cannotDetermine, inProgressAtAmazon: b.inProgressAtAmazon, matchedByInvoiceNumber: b.matchedByInvoiceNumber },
        issues: r.issues.map(i => ({ key: i.key, family: i.family, subtype: i.subtype, state: i.state, closureBasis: i.outcome, episodes: i.episodes, history: i.history, events: i.events, declaration: i.declaration, lapsedDeclarations: i.lapsedDeclarations, closure: i.closure, historyIncomplete: i.historyIncomplete ?? false, priorRecordedState: i.priorRecordedState ?? null, deletedImports: i.deletedImports ?? [], recordedBeforeDeletion: i.recordedBeforeDeletion ?? null, card: i.card })),
        coverageNotes: r.coverageNotes, rejectedEvents: r.rejectedEvents.map(x => ({ reason: x.reason, type: x.event.type })), notCheckedInThisVersion: r.notCheckedInThisVersion };
    },
    async deleteEverything() { await adapter.clear(); },

    // ---- P3: lifecycle. Deletion removes stored records (logical deletion); see docs/LOCAL-DATA-SECURITY-THREAT-MODEL.md for what that does and does not guarantee. ----
    async settings() { return { retention: { mode: 'KEEP' }, autoLockMinutes: 15, ...(await adapter.get('loop:settings') ?? {}) }; },
    async setSettings(next) {
      const cur = await this.settings(), s = { ...cur, ...next }, r = s.retention ?? { mode: 'KEEP' };
      if (!['KEEP', 'AFTER_DAYS'].includes(r.mode) || (r.mode === 'AFTER_DAYS' && !(Number.isInteger(r.days) && r.days >= 30 && r.days <= 3650))) throw new Refused(['Retention is either "keep until I delete" or a whole number of days between 30 and 3650.']);
      if (r.mode === 'AFTER_DAYS' && r.confirmedAt === undefined) throw new Refused(['Turning on automatic deletion needs your explicit confirmation of what it deletes.']);
      if (!(Number.isInteger(s.autoLockMinutes) && s.autoLockMinutes >= 0 && s.autoLockMinutes <= 240)) throw new Refused(['Auto-lock is 0 (off) to 240 minutes.']);
      await adapter.put('loop:settings', s); return s;
    },
    /** What deleting this import would do, computed from the data, nothing is changed. */
    async deletionImpact(importId) {
      const imports = await this.imports(), events = await this.events(), deletions = await this.committedDeletions(), target = imports.find(i => i.id === importId); if (!target) throw new Refused(['That import is not stored.']);
      const pid = await this.profileId(), before = project({ imports, events, sellerProfileId: pid, deletions }), rest = imports.filter(i => i.id !== importId), after = project({ imports: rest, events, sellerProfileId: pid, deletions });
      const ak = new Map(after.issues.map(i => [i.key, i]));
      const touched = before.issues.filter(i => !i.placeholder && (i.history.some(h => h.import === importId) || !ak.has(i.key) || ak.get(i.key).state !== i.state || ak.get(i.key).fingerprint !== i.fingerprint));
      const gone = before.issues.filter(i => !ak.has(i.key)), changed = before.issues.filter(i => ak.has(i.key) && (ak.get(i.key).state !== i.state || ak.get(i.key).fingerprint !== i.fingerprint));
      const tally = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
      const record = { import: { id: target.id, kind: target.kind, fileName: target.fileName ?? null, importedAt: target.importedAt, sha256: target.sha256 },
        affected: touched.map(i => ({ key: i.key, family: i.family, subtype: i.subtype, subject: i.subject, recordedState: i.state, recordedEpisodes: i.episodes.map(e => ({ from: e.from, fromFile: e.fromFile, to: e.to })), recordedHistory: i.history.map(h => ({ import: h.import, file: h.file, status: h.status, note: h.note })) })) };
      return { import: record.import, issuesDisappearing: tally(gone, i => i.family), issuesChanging: changed.length, findingsMarkedHistoryIncomplete: touched.length, importsRemaining: rest.length, record,
        removes: ['the stored file text and its declarations and mapping profile'], keeps: ['a permanent record of this deletion: file name, kind, hash, time, reason and the problems it touched (never the file content)', 'every problem that existed because of this file, shown as HISTORY_INCOMPLETE with what was recorded before', 'the seller statements attached to those problems', 'all other imports', 'any copy you downloaded (evidence bundle or backup) outside this page'] };
    },
    /** Records the deletion permanently, deletes the import, then the seller statements that no longer attach to anything. Needs {confirmed:true}. The record is written first: an interruption leaves a record for a file that is still there, never a lost trace. */
    async deleteImport(importId, { confirmed = false, reason = 'SELLER_DELETED' } = {}) {
      if (confirmed !== true) throw new Refused(['Deleting needs your confirmation after you have seen what it removes.']); if (!adapter.del) throw new Refused(['This storage cannot delete single records.']);
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw new Refused(['The reason for a deletion is a short text of at most 200 characters.']);
      await this.recoverDeletions();
      const impact = await this.deletionImpact(importId), at = now(), prior = (await list('deletion')).find(d => d.status === 'PENDING' && d.import.id === importId);
      const rec = { id: prior?.id ?? `del-${at.replace(/\D/g, '').slice(0, 14)}-${impact.import.sha256.slice(0, 6)}-${seq++}`, status: 'PENDING', attemptedAt: at, deletedAt: at, utcOffsetMinutes: offsetMinutes(), reason: reason.trim(), ...impact.record };
      await adapter.put(key('deletion', rec.id), rec);
      try { await adapter.del(key('import', importId)); if (await adapter.get(key('import', importId))) throw new Error('The file is still stored after the delete.'); }
      catch (e) { try { await adapter.del(key('deletion', rec.id)); } catch { /* the process may be gone: recovery settles it */ } throw e; }
      await adapter.put(key('deletion', rec.id), { ...rec, status: 'COMMITTED', committedAt: now() });
      const removed = await pruneOrphans();
      return { ...impact, deleted: true, deletionId: rec.id, eventsDeleted: removed };
    },
    /** Imports older than the retention days. Only ever acts when the seller turned retention on and confirmed. */
    async retentionPreview(asOf = now()) { const s = await this.settings(); if (s.retention.mode !== 'AFTER_DAYS') return { enabled: false, due: [] }; const cut = Date.parse(asOf) - s.retention.days * 86400000; return { enabled: true, days: s.retention.days, due: (await this.imports()).filter(i => Date.parse(i.importedAt) < cut).map(i => ({ id: i.id, kind: i.kind, fileName: i.fileName, importedAt: i.importedAt })) }; },
    async applyRetention(asOf = now()) { const p = await this.retentionPreview(asOf), done = []; for (const i of p.due) { await this.deleteImport(i.id, { confirmed: true, reason: 'RETENTION_POLICY' }); done.push(i.id); } return { enabled: p.enabled, deleted: done }; },
  };
  return api;
}
