import { startServer, signup, vidrOf, startProbe, readSamples, sleep, pct, ROOT } from './lib.mjs';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { runManualIssue } from '../src/manual-jobs.js';
import assert from 'node:assert/strict';
const N = +(process.argv[2] ?? 10000), OUT = process.argv[3] ?? '/tmp/s1.json';
const dbFile = '/tmp/p1.db'; for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
const samples = '/tmp/p1-samples.jsonl';
const srv = await startServer({ dbFile, port: 4101, env: { SAMPLES_FILE: samples } });
const base = 'http://127.0.0.1:4101'; const call = await signup(base, 'p1@x.es');
const probeCall = await signup(base, 'p1-probe@x.es'); // a second seller whose requests measure what everyone else sees
const text = vidrOf(N);
const pv = await call('manual/preview', { text }); // preview is inline (documented: ~0.7s @10k)
const probe = startProbe(probeCall, 50);
await sleep(300);
const tPost = Date.now(); const r = await call('manual/issue', { text, attest: true }); const postMs = r.ms;
let done, polls = [], progress = [];
for (;;) { const j = await call('manual/jobs/' + r.body.jobId); polls.push(j.ms); if (progress.at(-1)?.phase !== j.body.phase || progress.at(-1)?.processed !== j.body.processed) progress.push({ t: Date.now() - tPost, phase: j.body.phase, processed: j.body.processed, total: j.body.total, status: j.body.status });
  if (['done', 'error'].includes(j.body.status)) { done = j.body; break; } await sleep(100); }
const jobMs = Date.now() - tPost; await sleep(300); const lat = await probe.stop();
const during = lat.filter(x => x.t >= tPost && x.t <= tPost + jobMs);
const sm = readSamples(samples).filter(s => s.t >= tPost - 500 && s.t <= tPost + jobMs + 500);
const base0 = readSamples(samples).filter(s => s.t < tPost - 100);
const spikes = sm.filter(s => s.lagMaxMs > 100).map(s => ({ atMsAfterPost: s.t - tPost, lagMs: s.lagMaxMs })); const probeSpikes = during.filter(x => x.ms > 100).map(x => ({ atMsAfterPost: x.t - tPost, ms: Math.round(x.ms) }));
const res = { spikes, probeSpikes, rows: N, previewMs: Math.round(pv.ms), postStatus: r.status, postMs: Math.round(postMs), totalJobMs: jobMs, jobStatus: done.status, issued: done.result.issued, heldNow: done.result.heldNow, skippedAlready: done.result.skippedAlready, willIssue: done.result.willIssue, errors: done.result.errors,
  httpProbeOtherSeller: { n: during.length, p50: Math.round(pct(during.map(x => x.ms), .5)), p95: Math.round(pct(during.map(x => x.ms), .95)), max: Math.round(Math.max(...during.map(x => x.ms))), non200: during.filter(x => x.status !== 200).length },
  statusPollMaxMs: Math.round(Math.max(...polls)), inServerLoopLagMaxMs: Math.max(...sm.map(s => s.lagMaxMs)),
  memory: { idleRssMB: base0.at(-1)?.rssMB, peakRssMB: Math.max(...sm.map(s => s.rssMB)), peakHeapMB: Math.max(...sm.map(s => s.heapMB)), endRssMB: sm.at(-1)?.rssMB, endHeapMB: sm.at(-1)?.heapMB }, progressSteps: progress.length, progressSample: progress.filter((_, i) => i % Math.max(1, Math.ceil(progress.length / 6)) === 0 || i === progress.length - 1) };
srv.kill('SIGTERM'); await sleep(500);
// Equivalence: same report through the synchronous path (runManualIssue without pace) on a fresh DB.
const dbB = openDb(); 
{ const { createApp } = await import('../src/app.js'); const { server } = createApp({ db: dbB, secret: 'x', validate: async v => ({ status: 'valid', vat: v }), env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r)); const b = `http://127.0.0.1:${server.address().port}`; await signup(b, 'p1-sync@x.es'); server.close(); }
const sellerB = dbB.prepare("SELECT * FROM sellers WHERE name LIKE '%p1-sync@x.es'").get();
const t0 = Date.now(); const direct = await runManualIssue(dbB, sellerB, text, { validate: async v => ({ status: 'valid', vat: v }) }); res.syncPathMs = Date.now() - t0;
const dbA = new DatabaseSync(dbFile, { readOnly: true });
const sellerAid = dbA.prepare("SELECT s.id FROM sellers s WHERE s.name LIKE '%p1@x.es'").get().id;
const q = (db, id) => ({ inv: db.prepare("SELECT number, shipment_key, kind, total, vat, upload_status, json FROM invoices WHERE seller_id=? ORDER BY number").all(id), ship: db.prepare('SELECT key, order_id, shipping_id, buyer_vat, country, total, vat, status, reason FROM shipments WHERE seller_id=? ORDER BY key').all(id) });
const strip = j => JSON.stringify(JSON.parse(j), (k, v) => /date|At$|^at$|issued|ts|time/i.test(k) ? undefined : v);
const A = q(dbA, sellerAid), B = q(dbB, sellerB.id);
const norm = o => ({ ship: o.ship, inv: o.inv.map(i => ({ ...i, json: strip(i.json).replaceAll(/p1(-sync)?@x\.es/g, 'E') })) });
let eq = true, msg = ''; try { assert.deepEqual(norm(A), norm(B)); } catch (e) { eq = false; msg = e.message.slice(0, 600); }
res.equivalence = { syncIssued: direct.body.issued, syncHeld: direct.body.heldNow, syncSkipped: direct.body.skippedAlready, invoicesAsync: A.inv.length, invoicesSync: B.inv.length, shipmentsAsync: A.ship.length, shipmentsSync: B.ship.length, deepEqualInvoicesAndShipments: eq, diff: msg, compared: 'all invoice columns (number, shipment_key, kind, total, vat, upload_status, full json minus date/time keys and the seller-name email label) and shipment columns key/order_id/shipping_id/buyer_vat/country/total/vat/status/reason' };
res.heldBreakdown = Object.entries(A.ship.filter(s => s.status === 'held').reduce((m, s) => (m[s.reason?.slice(0, 70)] = (m[s.reason?.slice(0, 70)] ?? 0) + 1, m), {}));
res.uniqueInvoicesPerShipment = dbA.prepare("SELECT count(*) c FROM (SELECT shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' GROUP BY 1 HAVING count(*)>1)").get(sellerAid).c === 0;
writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1)); process.exit(0);
