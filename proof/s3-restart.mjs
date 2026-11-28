// Kill -9 the real server at a chosen point of a manual job, restart on the same DB file, verify recovery, then retry (S3 + S4).
import { startServer, vidrOf, sleep, client, signup } from './lib.mjs';
import { rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, verifyAudit } from '../src/db.js';
const POINT = process.argv[2], ROWS = +(process.argv[3] ?? 3000), OUT = process.argv[4] ?? `/tmp/s3-${POINT}.json`;
const FRACTION = { queued: -1, early: 0.05, mid: 0.5, nearend: 0.95 }[POINT];
const dbFile = `/tmp/p3-${POINT}.db`; for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
const port = 4110 + Object.keys({ queued: 1, early: 1, mid: 1, nearend: 1 }).indexOf(POINT);
let srv = await startServer({ dbFile, port }); const base = `http://127.0.0.1:${port}`;
const call = await signup(base, 'p3@x.es'); const other = await signup(base, 'p3-other@x.es');
const text = vidrOf(ROWS), textB = vidrOf(500, 2000000, '888'), otherText = vidrOf(100, 1000000, '999');
const expectIssue = Math.round(ROWS * 0.9), expectHeld = Math.round(ROWS * 0.05);
// the other seller finishes a small job BEFORE the crash: it must be untouched by the restart
const o = await other('manual/issue', { text: otherText, attest: true }); for (;;) { const j = await other('manual/jobs/' + o.body.jobId); if (j.body.status === 'done') break; await sleep(100); }
const a = await call('manual/issue', { text, attest: true }); const jobA = a.body.jobId; let jobB = null; let atKill = null;
if (POINT === 'queued') { atKill = { phase: 'queued-or-just-accepted' }; }
else { const b = await call('manual/issue', { text: textB, attest: true }); jobB = b.body.jobId; // B waits in the FIFO behind A
  for (;;) { const j = await call('manual/jobs/' + jobA); atKill = { phase: j.body.phase, processed: j.body.processed, total: j.body.total, status: j.body.status }; if (atKill.phase === 'issuing' && atKill.total && atKill.processed >= FRACTION * atKill.total) break; if (['done', 'error'].includes(atKill.status)) break; await sleep(POINT === 'nearend' ? 20 : 50); } }
srv.kill('SIGKILL'); await sleep(800);
const snap = (db) => { const sid = db.prepare("SELECT id FROM sellers WHERE name LIKE '%p3@x.es'").get().id;
  const inv = db.prepare("SELECT count(*) c, count(DISTINCT shipment_key) k FROM invoices WHERE seller_id=? AND kind='invoice'").get(sid);
  const ready = db.prepare("SELECT count(*) c FROM shipments WHERE seller_id=? AND status IN ('ready','uploaded','submitted')").get(sid).c;
  const invNoShip = db.prepare("SELECT count(*) c FROM invoices i WHERE seller_id=? AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.seller_id=i.seller_id AND s.key=i.shipment_key AND s.status IN ('ready','uploaded','submitted'))").get(sid).c;
  const shipNoInv = db.prepare("SELECT count(*) c FROM shipments s WHERE seller_id=? AND status IN ('ready','uploaded','submitted') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.seller_id=s.seller_id AND i.shipment_key=s.key AND i.kind='invoice')").get(sid).c;
  const nums = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number").all(sid).map(x => +x.number.split('-').pop()); let contiguous = nums.every((n, i) => n === i + 1);
  const ctr = db.prepare('SELECT n FROM counters WHERE seller_id=?').get(sid)?.n ?? 0;
  return { sid, invoices: inv.c, distinctShipments: inv.k, shipmentsIssued: ready, invoicesWithoutIssuedShipment: invNoShip, issuedShipmentsWithoutInvoice: shipNoInv, numbersContiguous: contiguous, counter: ctr, counterMatchesInvoices: ctr === inv.c, heldRows: db.prepare("SELECT count(*) c FROM shipments WHERE seller_id=? AND status='held'").get(sid).c, orphanInvoiceShipmentStatus: db.prepare("SELECT s.status st, i.upload_status ust FROM invoices i LEFT JOIN shipments s ON s.seller_id=i.seller_id AND s.key=i.shipment_key WHERE i.seller_id=? AND i.kind='invoice' AND (s.status IS NULL OR s.status NOT IN ('ready','uploaded','submitted'))").all(sid), snapshotFlags: db.prepare('SELECT in_flight, store_pending FROM report_snapshots WHERE seller_id=?').get(sid) ?? null }; };
const raw = new DatabaseSync(dbFile, { readOnly: true }); const afterKill = snap(raw);
const ledgerKill = raw.prepare("SELECT j.id, j.status, j.phase, j.processed, j.total, (j.report_text IS NOT NULL) hasText FROM manual_jobs j WHERE j.seller_id=?").all(afterKill.sid).map(j => ({ job: j.id === jobA ? 'A(big)' : j.id === jobB ? 'B(queued)' : j.id.slice(0, 6), status: j.status, phase: j.phase, processed: j.processed, total: j.total, reportTextStored: !!j.hasText }));
raw.close();
// restart on the same file
srv = await startServer({ dbFile, port }); const call2 = client(base); // old cookie lost: log in again
const lg = await call2('login', { email: 'p3@x.es', password: 'Long-Enough-Pw-42!' }); const lg2 = client(base); const loginOk = lg.status === 200;
const ja = await call2('manual/jobs/' + jobA); const jb = jobB ? await call2('manual/jobs/' + jobB) : null;
const bootLog = srv.getLog().split('\n').filter(l => !/ExperimentalWarning|trace-warnings|^UP /.test(l) && l.trim());
const rawb = new DatabaseSync(dbFile, { readOnly: true }); const afterRestart = snap(rawb);
const ledgerRestart = rawb.prepare("SELECT id, status, phase, (report_text IS NOT NULL) hasText, result FROM manual_jobs WHERE seller_id=?").all(afterRestart.sid).map(j => ({ job: j.id === jobA ? 'A(big)' : j.id === jobB ? 'B(queued)' : j.id.slice(0, 6), status: j.status, reportTextStored: !!j.hasText, errorText: (JSON.parse(j.result ?? 'null')?.body?.error ?? '').slice(0, 130) }));
const snapState = rawb.prepare('SELECT in_flight, store_pending FROM report_snapshots WHERE seller_id=?').get(afterRestart.sid); rawb.close();
// the other seller's finished job is untouched
const oLogin = client(base); const ol = await oLogin('login', { email: 'p3-other@x.es', password: 'Long-Enough-Pw-42!' }); const oj = await oLogin('manual/jobs/' + o.body.jobId);
// retry the same report (S4)
const t0 = Date.now(); const r = await call2('manual/issue', { text, attest: true }); let done; for (;;) { const j = await call2('manual/jobs/' + r.body.jobId); if (['done', 'error'].includes(j.body.status)) { done = j.body; break; } await sleep(100); if (Date.now() - t0 > 100000) break; }
const afterRetry = snap(new DatabaseSync(dbFile, { readOnly: true }));
const r2 = await call2('manual/issue', { text, attest: true }); let done2; for (;;) { const j = await call2('manual/jobs/' + r2.body.jobId); if (['done', 'error'].includes(j.body.status)) { done2 = j.body; break; } await sleep(100); if (Date.now() - t0 > 115000) break; }
const dbf = new DatabaseSync(dbFile, { readOnly: true }); const afterRetry2 = snap(dbf);
const ledgerFinal = dbf.prepare("SELECT status, count(*) c FROM manual_jobs WHERE seller_id=? GROUP BY 1").all(afterRetry2.sid);
const dupShip = dbf.prepare("SELECT count(*) c FROM (SELECT shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' GROUP BY 1 HAVING count(*)>1)").get(afterRetry2.sid).c;
const dupNum = dbf.prepare("SELECT count(*) c FROM (SELECT number FROM invoices WHERE seller_id=? GROUP BY 1 HAVING count(*)>1)").get(afterRetry2.sid).c;
const idx = dbf.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%' AND tbl_name='invoices'").all().map(x => x.name);
// unique constraint holds: try to insert a duplicate invoice for an existing shipment directly
let dupInsert = 'not attempted'; { const w = openDb(dbFile); try { const row = w.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' LIMIT 1").get(afterRetry2.sid); w.prepare("INSERT INTO invoices (seller_id, number, shipment_key, kind, issued_at, total, vat, json) VALUES (?,?,?,?,?,?,?,?)").run(afterRetry2.sid, 'A-2026-DUPTEST', row.shipment_key, 'invoice', new Date().toISOString(), 1, 0, '{}'); dupInsert = 'INSERTED (constraint missing!)'; } catch (e) { dupInsert = 'rejected: ' + e.message.slice(0, 90); } }
const audit = verifyAudit(openDb(dbFile), afterRetry2.sid);
const otherCount = new DatabaseSync(dbFile, { readOnly: true }).prepare("SELECT count(*) c FROM invoices i JOIN sellers s ON s.id=i.seller_id WHERE s.name LIKE '%p3-other@x.es' AND kind='invoice'").get().c;
srv.kill('SIGKILL');
const res = { killPoint: POINT, rows: ROWS, expectedIssuable: expectIssue, expectedHeld: expectHeld, killedWith: 'SIGKILL (no shutdown hooks)', jobAatKill: atKill, afterKill, ledgerAfterKill: ledgerKill,
  restart: { loginOk, jobA: { status: ja.body?.status, httpStatus: ja.body?.httpStatus, error: ja.body?.error?.slice(0, 140) }, jobB: jb && { status: jb.body?.status, error: jb.body?.error?.slice(0, 140) }, serverBootLogLines: bootLog.slice(0, 5), ledger: ledgerRestart, reportSnapshotFlags: snapState, afterRestartCounts: afterRestart },
  otherSellerUntouched: { jobStatus: oj.body?.status, issued: oj.body?.result?.issued, invoicesInDb: otherCount },
  retry1: { status: done?.status, issued: done?.result?.issued, skippedAlready: done?.result?.skippedAlready, held: done?.result?.heldNow, errors: done?.result?.errors, counts: afterRetry, issuedPlusSkipped: (done?.result?.issued ?? 0) + (done?.result?.skippedAlready ?? 0) },
  retry2_sameReportAgain: { issued: done2?.result?.issued, skippedAlready: done2?.result?.skippedAlready, counts: afterRetry2 },
  final: { invoices: afterRetry2.invoices, equalsExpected: afterRetry2.invoices === expectIssue, duplicatePerShipment: dupShip, duplicateNumbers: dupNum, uniqueIndexesOnInvoices: idx, directDuplicateInsert: dupInsert, ledgerFinalByStatus: ledgerFinal, auditChain: audit } };
writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1)); process.exit(0);
