// Expedition re-review 1 (in-flight duplicate-submission class): upload claim ownership.
// The IN-FLIGHT order, on both document kinds: a claim is taken, the upload call is still running, THEN a sweep / another run acts, THEN the late result arrives.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js'; import { processReport, processCorrections, issueRectificativa, settleUnknownDocuments } from '../src/pipeline.js'; import { decideRepair } from '../src/repair.js'; import { recoverUncertainUploads } from '../src/repair.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const [head0, ...body] = text.trim().split('\n'); const cols = head0.split('\t'); const X = ['invoice-number', 'original-vat-invoice-number']; const ix = n => cols.includes(n) ? cols.indexOf(n) : cols.length + X.indexOf(n);
const H = head0 + '\t' + X.join('\t'); const base = body[0].split('\t'); const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const pad = (r) => { while (r.length < cols.length + X.length) r.push(''); return r; };
const rv = () => { const r = pad([...base]); r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r; };
const rp = () => { const f = pad([...base]); f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f; };
const rep = () => [H + '\tinvoice-correction-details', rv().join('\t') + '\tReason A', rp().join('\t') + '\tReason A'].join('\n');
const KEY = 'REFUND:CorrectionReversal:X:1';
const okApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });
/** an api whose upload call stays open until release(feedId) */
const hangApi = () => { let rel; const gate = new Promise(r => { rel = r; }); return { calls: [], first: null, release: (f) => rel(f), uploadInvoice: async function (a) { this.calls.push(a); if (this.first) return 'other-' + this.calls.length; this.first = a.number; return gate; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] }; };
const waitFor = async (fn) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition not reached'); };
const ev = (db, t) => db.prepare('SELECT detail FROM events WHERE type=?').all(t).map(r => JSON.parse(r.detail));
const kinds = {
  invoice: { number: (db) => db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get().number,
    async setup() { const db = openDb(); return { db }; },
    start(db, api) { return processReport(db, seller, text, { api, validate: vies, now: NOW }); } },
  creditnote: { number: (db) => db.prepare("SELECT number FROM invoices WHERE kind='rectificativa' AND shipment_key=?").get(KEY).number,
    async setup() { const api = okApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, rep(), { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep(), { api, validate: vies });
      db.prepare("UPDATE invoices SET upload_status='pending', feed_id=NULL WHERE kind='rectificativa' AND shipment_key=?").run(KEY); return { db }; },
    start(db, api) { const orig = db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get().number; return issueRectificativa(db, seller, orig, { recordKey: KEY, allowUnknownRetry: true }, { api, validate: vies }).catch(e => ({ error: e.message })); } },
};
for (const [name, K] of Object.entries(kinds)) {
  const row = (db, api) => db.prepare('SELECT upload_status, feed_id, blocked_feed_id, claim_token, claim_heartbeat FROM invoices WHERE number=?').get(api.first);
  test(`C1 [${name}] a sweep during the IN-FLIGHT upload (even with no grace) does not take the live claim; the result lands once`, async () => {
    const { db } = await K.setup(); const api = hangApi(); const p = K.start(db, api);
    await waitFor(() => api.calls.length >= 1 && db.prepare("SELECT 1 FROM invoices WHERE upload_status='sending' AND number=?").get(api.first));
    assert.equal(recoverUncertainUploads(db, { minAgeMs: 0 }), 0, 'the sweep leaves a live claim alone'); assert.equal(row(db, api).upload_status, 'sending');
    api.release('feed-1'); await p; const r = row(db, api); assert.equal(r.feed_id, 'feed-1'); assert.ok(['submitted', 'processing'].includes(r.upload_status)); assert.equal(api.calls.filter(c => c.number === api.first).length, 1, 'one upload of this document only');
  });
  test(`C2 [${name}] a late result from a claim that lost the row never overwrites the new owner; it opens a hold and an event`, async () => {
    const { db } = await K.setup(); const api = hangApi(); const p = K.start(db, api);
    await waitFor(() => api.calls.length >= 1 && db.prepare("SELECT 1 FROM invoices WHERE upload_status='sending' AND number=?").get(api.first));
    // another owner takes the row while the first call is still open (what a swept + re-claimed document looks like)
    db.prepare("UPDATE invoices SET claim_token='other-owner', upload_status='submitted', feed_id='feed-NEW' WHERE number=?").run(api.first);
    api.release('feed-LATE'); await p; const r = row(db, api);
    assert.equal(r.feed_id, 'feed-NEW', 'the new owner keeps the row'); assert.equal(r.claim_token, 'other-owner');
    assert.equal(ev(db, 'late_upload_result').length, 1, 'the late feed is recorded'); assert.equal(ev(db, 'late_upload_result')[0].lateFeedId, 'feed-LATE');
    assert.equal(db.prepare("SELECT count(*) c FROM repairs WHERE event_key LIKE 'LATE_FEED:%'").get().c, 1, 'a human hold is open for the late feed');
  });
  test(`C3 [${name}] an upload call that never answers becomes an unknown outcome within the timeout, never a claim that outlives the grace`, async () => {
    process.env.IG_UPLOAD_TIMEOUT_MS = '150'; try {
      const { db } = await K.setup(); const api = hangApi(); await K.start(db, api);
      const r = row(db, api); assert.equal(r.upload_status, 'unknown'); assert.equal(r.feed_id, null); assert.equal(ev(db, 'upload_unknown_outcome').length >= 1, true);
    } finally { delete process.env.IG_UPLOAD_TIMEOUT_MS; }
  });
}
test('C4 cross-process ownership proof: a claim with a fresh heartbeat is never swept, a stale one is', async () => {
  const { db } = await kinds.invoice.setup(); await processReport(db, seller, text, { api: okApi(), validate: vies, now: NOW }); const n = kinds.invoice.number(db);
  const old = new Date(Date.now() - 3600e3).toISOString();
  db.prepare("UPDATE invoices SET upload_status='sending', sending_at=?, claim_token='dead-or-foreign', claim_heartbeat=? WHERE number=?").run(old, new Date().toISOString(), n);
  assert.equal(recoverUncertainUploads(db, { minAgeMs: 600e3 }), 0, 'fresh heartbeat = live owner'); assert.equal(db.prepare('SELECT upload_status s FROM invoices WHERE number=?').get(n).s, 'sending');
  db.prepare('UPDATE invoices SET claim_heartbeat=? WHERE number=?').run(old, n);
  assert.equal(recoverUncertainUploads(db, { minAgeMs: 600e3 }), 1, 'stale heartbeat and old claim = dead owner'); assert.equal(db.prepare('SELECT upload_status s FROM invoices WHERE number=?').get(n).s, 'unknown');
});
test('C5 REAL second process: a sweep with a short grace in process B never takes the claim of a live upload in process A; the document is submitted once', async () => {
  const { spawn } = await import('node:child_process'); const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'own-')), 'o.db'); const db = openDb(file); db.close();
  const w = spawn('node', ['--no-warnings', new URL('./helpers/slow-upload-worker.mjs', import.meta.url).pathname, file, '3500']); let out = ''; w.stdout.on('data', d => { out += d; }); w.stderr.on('data', d => { out += d; });
  const b = openDb(file); await waitFor(() => b.prepare("SELECT 1 FROM invoices WHERE upload_status='sending'").get()); await new Promise(r => setTimeout(r, 1200));
  const swept = recoverUncertainUploads(b, { minAgeMs: 500 }); assert.equal(swept, 0, 'the live owner is protected by its heartbeat');
  await new Promise(r => w.on('close', r)); const done = JSON.parse(out.trim().split('\n').pop()); assert.ok(done.done, out);
  const st = b.prepare('SELECT upload_status s, feed_id f FROM invoices WHERE number=?').get(done.first); assert.ok(['submitted', 'processing'].includes(st.s)); assert.equal(st.f, 'w-' + done.first); b.close();
});

// Re-review 1 round 3 (P1): the timeout abandons the call; it must neither be resendable nor land unseen.
for (const [name, K] of Object.entries(kinds)) {
  test(`C6 [${name}] timeout, resend attempt, abandoned request lands later => still ONE submission, the late feed is recorded and blocks, the call was aborted`, async () => {
    process.env.IG_UPLOAD_TIMEOUT_MS = '120'; try {
      const { db } = await K.setup(); let sig = null, landed = null; const calls = [];
      const api = { calls, async uploadInvoice(a) { calls.push(a.number); if (calls.length === 1) { sig = a.signal; await new Promise(r => setTimeout(r, 500)); landed = 'abandoned-feed'; return landed; } return 'resent-' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
      await K.start(db, api); const first = calls[0];
      assert.equal(db.prepare('SELECT upload_status s FROM invoices WHERE number=?').get(first).s, 'unknown'); assert.equal(sig.aborted, true, 'the request was aborted, not just abandoned');
      const t = [head0 + '\tinvoice-correction-details'].length; const rep1 = name === 'invoice' ? text : [H, rv().join('\t')].join('\n');
      await settleUnknownDocuments(db, seller, rep1, { api, validate: vies }); assert.equal(calls.filter(n => n === first).length, 1, 'no resend inside the quiet period');
      await waitFor(() => landed); await new Promise(r => setTimeout(r, 50));
      const r = db.prepare('SELECT upload_status s, blocked_feed_id b FROM invoices WHERE number=?').get(first); assert.equal(r.b, 'abandoned-feed', 'the abandoned request landed: its feed blocks any resend'); assert.equal(ev(db, 'late_upload_result').length, 1);
      assert.equal(db.prepare("SELECT count(*) c FROM repairs WHERE event_key LIKE 'LATE_FEED:%'").get().c, 1);
    } finally { delete process.env.IG_UPLOAD_TIMEOUT_MS; }
  });
}
test('C7 dismissing a LATE_FEED hold never unlocks the resend block of the document', async () => {
  process.env.IG_UPLOAD_TIMEOUT_MS = '100'; try {
    const { db } = await kinds.invoice.setup(); const calls = []; const api = { calls, async uploadInvoice(a) { calls.push(a.number); if (calls.length === 1) { await new Promise(r => setTimeout(r, 300)); return 'abandoned-feed'; } return 'x'; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
    await kinds.invoice.start(db, api); await new Promise(r => setTimeout(r, 400));
    const k = db.prepare("SELECT event_key k FROM repairs WHERE event_key LIKE 'LATE_FEED:%'").get().k; decideRepair(db, seller.id, k, 'dismissed');
    assert.equal(db.prepare("SELECT count(*) c FROM events WHERE type='unknown_hold_dismissed'").get().c, 0);
  } finally { delete process.env.IG_UPLOAD_TIMEOUT_MS; }
});
