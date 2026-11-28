// Ruling 5 independent review: the keyed LATE_FEED confirmation is a human retry authorization. Decision 3 asks for ONE retry, recorded (who checked, when, result), never stacked.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js'; import { processReport } from '../src/pipeline.js'; import { decideRepair } from '../src/repair.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'selRV', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const ev = (db, t) => db.prepare('SELECT detail FROM events WHERE type=?').all(t).map(r => JSON.parse(r.detail));
async function lateDoc(secondUnknown) {
  process.env.IG_UPLOAD_TIMEOUT_MS = '100'; try {
    const db = openDb(); const calls = [];
    const api = { calls, async uploadInvoice(a) { calls.push(a.number); if (calls.length === 1 || a.number !== calls[0]) { if (a.number !== calls[0]) return 'o-' + a.number; await new Promise(r => setTimeout(r, 300)); return 'feedA'; } if (secondUnknown && a.number === calls[0]) { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; } return 'resent-' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
    await processReport(db, seller, text, { api, validate: vies, now: NOW }); await new Promise(r => setTimeout(r, 400)); db.prepare("DELETE FROM events WHERE type='upload_timeout_abandoned'").run();
    const first = calls[0]; return { db, api, calls: { get length() { return calls.filter(n => n === first).length; } }, sync: () => processReport(db, seller, text, { api, validate: vies, now: NOW }) };
  } finally { delete process.env.IG_UPLOAD_TIMEOUT_MS; }
}
test('RV-1 LATE_FEED confirmation must record who checked, when and the result (decision 3); a bare confirmation is refused and resends nothing', async () => {
  const d = await lateDoc(false); const k = d.db.prepare("SELECT event_key k FROM repairs WHERE event_key LIKE 'LATE_FEED:%'").get().k;
  assert.throws(() => decideRepair(d.db, seller.id, k, 'dismissed'), /Seller Central|who checked|record/i);
  await d.sync(); assert.equal(d.calls.length, 1, 'no resend without a recorded confirmation');
  decideRepair(d.db, seller.id, k, 'dismissed', { checkedBy: 'Reviewer A', checkedAt: new Date().toISOString(), result: 'feed_failed', reason: 'Checked feedA in Seller Central: processing failed', acknowledgeRisk: true }, 'owner@x.test');
  const rec = ev(d.db, 'late_feed_acknowledged')[0]; assert.equal(rec.checkedBy, 'Reviewer A'); assert.equal(rec.result, 'feed_failed'); assert.ok(rec.checkedAt && rec.authorizedBy);
});
test('RV-2 a LATE_FEED confirmation is ONE-SHOT: after the resend ends unknown again, nothing resends until a new human decision', async () => {
  const d = await lateDoc(true); const k = d.db.prepare("SELECT event_key k FROM repairs WHERE event_key LIKE 'LATE_FEED:%'").get().k;
  decideRepair(d.db, seller.id, k, 'dismissed', { checkedBy: 'Reviewer A', checkedAt: new Date().toISOString(), result: 'feed_failed', reason: 'Checked feedA in Seller Central: processing failed', acknowledgeRisk: true }, 'owner@x.test');
  await d.sync(); assert.equal(d.calls.length, 2, 'the confirmed retry went out once');
  for (let i = 0; i < 3; i++) await d.sync();
  assert.equal(d.calls.length, 2, 'the second unknown outcome is not resent automatically');
});
