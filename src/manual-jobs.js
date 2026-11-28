// Background manual-issue jobs (api-load F1). Before this, POST /api/manual/issue ran the whole
// report inline: parse + per-shipment issuance are synchronous CPU on the one Node loop, so a
// single 10k-row upload froze every seller for over a minute (measured 68 s loop-blocked). Now the
// route only validates cheap things, enqueues a job and answers 202; a single in-process worker
// runs the EXACT same steps in time-bounded chunks, yielding the event loop between chunks.
// Why in-process setImmediate chunks and not a child process: the pipeline holds per-shipment
// idempotency inside one SQLite connection's IMMEDIATE transactions (round-8/round-10 claims); a
// second process would need its own connection and re-introduce cross-process races the current
// design closes in-process. processReport already interleaves with other requests at every awaited
// VIES call, so yielding between chunks adds no new race class.
import { randomUUID } from 'node:crypto';
import { planUpload } from './manual.js';
import { upsertShipment, processReport } from './pipeline.js';
import { logEvent, nextReportGen, currentAttemptSeq } from './db.js';
import { beginManualVidr, finishManualVidr, clearReportInFlight } from './repair.js';

export function migrateJobs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS manual_jobs (id TEXT PRIMARY KEY, seller_id TEXT, status TEXT, phase TEXT, total INTEGER, processed INTEGER, report_text TEXT, result TEXT, created_at TEXT, updated_at TEXT)`);
  // Boot recovery: a job left queued/running died with the process. Issued invoices are already
  // safe (issuance is per-shipment idempotent), so the seller uploads the report again and the
  // already-issued orders are recognised and skipped - the same crash story as the old inline path.
  db.prepare("UPDATE manual_jobs SET status='error', report_text=NULL, result=?, updated_at=? WHERE status IN ('queued','running')")
    .run(JSON.stringify({ httpStatus: 500, body: { error: 'The upload was interrupted by a server restart. Invoices already created from it are kept; upload the report again to continue - already-issued orders are recognised and skipped.' } }), new Date().toISOString());
}

export function enqueueJob(db, seller, text) {
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO manual_jobs (id, seller_id, status, phase, total, processed, report_text, result, created_at, updated_at) VALUES (?,?,?,?,0,0,?,NULL,?,?)')
    .run(id, seller.id, 'queued', 'queued', text, now, now);
  return id;
}

export function getJob(db, seller, id) {
  const j = db.prepare('SELECT * FROM manual_jobs WHERE id=? AND seller_id=?').get(id, seller.id);
  if (!j) return null;
  const result = j.result ? JSON.parse(j.result) : null;
  return { id: j.id, status: j.status, phase: j.phase, processed: j.processed, total: j.total, httpStatus: result?.httpStatus ?? null, result: result?.body ?? null, error: result?.body?.error ?? null, createdAt: j.created_at, updatedAt: j.updated_at };
}

/** The exact processing the inline /api/manual/issue route ran (same steps, same order, same
 *  payloads). Returns the HTTP-style { status, body } the route returned. `pace` (optional) =
 *  { ms, onProgress }: yield the event loop whenever more than `ms` elapsed since the last yield,
 *  so one big report never monopolises the loop; without it the function is fully synchronous
 *  between awaits - the pre-existing inline behaviour. */
export async function runManualIssue(db, seller, mText, { validate, pace = null } = {}) {
  const plan = planUpload(mText);
  if (!plan.ok) return { status: 400, body: { error: plan.error, format: plan.format ?? null } };
  const bad = plan.invalidRows ?? []; // quarantined rows: line numbers and counts only, never cell content
  const invalidRows = bad.slice(0, 50).map(x => ({ line: x.line, reason: x.reason, cells: x.cells, expected: x.expected }));
  const warning = bad.length ? `${bad.length} ${bad.length === 1 ? 'line' : 'lines'} of your file could not be read and ${bad.length === 1 ? 'was' : 'were'} not used (a line break inside a cell splits a row). No invoice was made from ${bad.length === 1 ? 'it' : 'them'}. Download the report again and check ${bad.length === 1 ? 'that line' : 'those lines'}: ${bad.slice(0, 10).map(x => x.line).join(', ')}${bad.length > 10 ? ' and more' : ''}.` : null;
  const view = { invalidRowsCount: bad.length, invalidRows, warning, format: plan.format, formatName: plan.formatName, rows: plan.rows, truncated: plan.truncated, willIssue: plan.shipments.length, held: plan.held.map(h => ({ orderId: h.orderId, reason: h.reason })).slice(0, 100), heldCount: plan.held.length, skippedCount: plan.skipped.length, skipped: plan.skipped.slice(0, 20),
    sample: plan.shipments.slice(0, 20).map(x => ({ orderId: x.orderId, buyer: x.buyerCompany, buyerVat: x.buyerVat, currency: x.currency, total: x.incl, vat: x.vat })) };
  // Round-22 (critic round-19): for a VIDR the protection is recorded and the report stored the moment it is accepted, BEFORE the first await (processReport); in_flight stays up through processing. An Order Report carries no refund evidence: it never touches the stored VIDR snapshot or any block (P2).
  const isVidr = plan.format === 'vidr';
  const stamp = { gen: isVidr ? nextReportGen(db, seller.id) : null, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString() };
  if (isVidr) { try { beginManualVidr(db, seller, mText, stamp); } catch (e) { console.error('manual report store', e); return { status: 500, body: { error: 'The report could not be stored, so nothing was issued and credit-note approvals stay blocked. Upload the report again.' } }; } }
  try {
    const prev = (key) => db.prepare('SELECT status, reason FROM shipments WHERE seller_id=? AND key=?').get(seller.id, key);
    let hn = 0, lastH = Date.now();
    for (const h of plan.held) {
      if (pace && hn && Date.now() - lastH >= pace.ms) { lastH = Date.now(); pace.onProgress?.('holding', hn, plan.held.length); await new Promise(r => setImmediate(r)); }
      hn++;
      const st = h.s ?? { key: `ORDER:${h.orderId}`, orderId: h.orderId, shippingId: h.orderId, buyerVat: null, buyerCompany: null, shipCountry: null, incl: null, vat: null, shipmentDate: null, orderDate: null, manual: true };
      const pv = prev(st.key); const alreadyHeld = pv?.status === 'held' && pv?.reason === h.reason;
      if (!pv) logEvent(db, seller.id, 'detected', { key: st.key, orderId: st.orderId });
      if (!alreadyHeld && !['ready', 'uploaded', 'submitted'].includes(pv?.status)) { upsertShipment(db, seller.id, st, 'held', h.reason); logEvent(db, seller.id, 'held', { key: st.key, reason: h.reason }); }
    }
    const out = await processReport(db, seller, '', { api: { manual: true, uploadInvoice: async () => 'manual' }, validate, shipments: plan.shipments, pace: pace && { ms: pace.ms, onProgress: (n, total) => pace.onProgress?.('issuing', n, total) } });
    logEvent(db, seller.id, 'report_uploaded', { format: plan.format, rows: plan.rows, issued: out.uploaded, held: out.held.length + plan.held.length });
    let repairsProposed = 0;
    if (isVidr) {
      // Round-23 (critic round-20): by now the invoices are recorded and the report is stored; if proposal detection fails, say exactly that (never the generic "nothing was changed"). Approvals stay protected by the freshness check against the stored report.
      try { repairsProposed = finishManualVidr(db, seller, mText, stamp); } // quiet only when the report has no refund rows; database errors are loud
      catch (e) { console.error('manual repair detection', e); return { status: 500, body: { error: 'The invoices from this upload were recorded and the report itself is stored, but the credit-note suggestions could not be checked this time. Nothing is lost: credit-note approvals stay protected by the freshness check. Upload the report again to refresh the suggestions.', issued: out.uploaded, reportStored: true, suggestionsFailed: true } }; }
    }
    return { status: 200, body: { ...view, heldReasons: out.held.map(h => h.reason), issued: out.uploaded, skippedAlready: out.skipped, heldNow: out.held.length + plan.held.length, deferred: out.deferred.length, errors: out.errors.length, repairsProposed } };
  } finally { if (isVidr) clearReportInFlight(db, seller.id); } // the report is already stored: success or failure, approval revalidates against it
}

/** Single in-process FIFO worker: one job at a time (memory stays at one parsed report, matching
 *  today's effective serialization), but the loop yields between time-bounded chunks so concurrent
 *  requests are served while a big upload processes. */
export function startJobWorker(db, { validate, paceMs = 50 } = {}) {
  let running = false;
  const mark = (id, fields) => db.prepare(`UPDATE manual_jobs SET ${Object.keys(fields).map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...Object.values(fields), new Date().toISOString(), id);
  async function runJob(job) {
    mark(job.id, { status: 'running', phase: 'parsing' });
    const seller = db.prepare('SELECT * FROM sellers WHERE id=?').get(job.seller_id);
    const pace = { ms: paceMs, onProgress: (phase, n, total) => mark(job.id, { phase, processed: n, total }) };
    let r;
    try { r = await runManualIssue(db, seller, job.report_text, { validate, pace }); }
    catch (e) { console.error('manual job failed', job.id, e); r = { status: 500, body: { error: e.message } }; }
    mark(job.id, { status: r.status === 200 ? 'done' : 'error', phase: r.status === 200 ? 'done' : 'error', processed: r.body?.issued ?? 0, total: r.body?.willIssue ?? 0, report_text: null, result: JSON.stringify({ httpStatus: r.status, body: r.body }) });
  }
  function kick() {
    if (running) return;
    const job = db.prepare("SELECT * FROM manual_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
    if (!job) return;
    running = true;
    // Defer the first chunk: the POST /api/manual/issue response goes out BEFORE any job CPU runs.
    setImmediate(() => runJob(job).catch(e => console.error('manual job worker', e)).finally(() => { running = false; setImmediate(kick); }));
  }
  return { kick };
}
