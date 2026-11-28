// Stage 1 round 2, decision 2: real cross-process concurrency. 8 Node processes, 20 rounds, ONE SQLite file. In each round every process works a DIFFERENT approved CorrectionReversal event on the SAME original. Proves: documents + open claims never exceed the creditable balance, SQLITE_BUSY (if any) fails closed, numbering stays unique. No production change unless this finds a defect.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js'; import { processReport, processCorrections } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const ROUNDS = 20, PROCS = 8;
const orig = (r) => { const x = [...base]; x[ix('order-id')] = `405-3318842-77${String(10000 + r).slice(1)}`; x[ix('shipping-id')] = `S9${String(100 + r)}`; x[ix('transaction-id')] = x[ix('shipping-id')]; return x; };
const reversal = (r, w) => { const x = orig(r); x[ix('transaction-type')] = 'REFUND'; x[ix('transaction-id')] = `CorrectionReversal:R${r}W${w}:1`; AMT.forEach(n => { x[ix(n)] = x[ix(n)] ? '-' + x[ix(n)] : ''; }); x[ix('invoice-status')] = 'CreditNotePending'; return x.join('\t'); };
const replacement = (r, w) => { const x = orig(r); x[ix('transaction-id')] = `Correction::R${r}W${w}:2`; x[ix('billing-name')] = `Name ${r}-${w} SL`; return x.join('\t'); };
const pairRows = (r, w) => [reversal(r, w), replacement(r, w)];
const race = async (busyMs) => {
  const dir = mkdtempSync(join(tmpdir(), 'xproc-')); const file = join(dir, 'db.sqlite');
  const db = openDb(file); const api = { uploadInvoice: async () => 'f', feedStatus: async () => ({ status: 'DONE' }) }; const validate = async v => ({ status: 'valid', vat: v });
  const origs = Array.from({ length: ROUNDS }, (_, r) => orig(r).join('\t'));
  await processReport(db, seller, [head, ...origs].join('\n'), { api, validate, now: new Date('2026-11-24T12:00:00Z') });
  const nOrig = db.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c; assert.equal(nOrig, ROUNDS, 'setup: one invoice per round');
  // the approved evidence of a reversal includes every replacement row that shares its shipping-id, so each worker's report carries its OWN reversal plus all replacement rows, exactly like the staged report
  // stage every pair review in one process, approve them all as a person would, then let 8 processes race
  const all = []; for (let r = 0; r < ROUNDS; r++) for (let w = 0; w < PROCS; w++) all.push(...pairRows(r, w));
  await processCorrections(db, seller, [head, ...all].join('\n'), { api, validate }); const approvedN = approveAll(db, seller.id); assert.equal(approvedN, ROUNDS * PROCS, 'every pair review approved');
  const t0 = Date.now() + 1500; const procs = [];
  for (let w = 0; w < PROCS; w++) {
    const cfgPath = join(dir, `cfg${w}.json`); writeFileSync(cfgPath, JSON.stringify({ seller, worker: w, busyMs, rounds: ROUNDS, t0, stepMs: 400, reports: Array.from({ length: ROUNDS }, (_, r) => [head, reversal(r, w), ...Array.from({ length: PROCS }, (_, k) => replacement(r, k))].join('\n')) }));
    procs.push(new Promise(res => { const p = spawn('node', ['--no-warnings', new URL('./helpers/xproc-worker.mjs', import.meta.url).pathname, file, cfgPath]); let o = '', e = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d); p.on('close', code => res({ code, o, e })); }));
  }
  const res = await Promise.all(procs); const logs = res.map(r => { const m = r.o.match(/RESULT (.*)/); return m ? JSON.parse(m[1]) : { crashed: true, code: r.code, e: r.e.slice(0, 300) }; });
  const busy = logs.reduce((a, l) => a + (l.busy ?? 0), 0), other = logs.flatMap(l => l.otherErrors ?? []);
  console.log(`XPROC busy_timeout=${busyMs ?? 'default 5000'} processes=${PROCS} rounds=${ROUNDS} SQLITE_BUSY=${busy} otherErrors=${other.length} ${JSON.stringify(other.slice(0, 3))}`);
  assert.ok(logs.every(l => !l.crashed), 'no worker crashed: ' + JSON.stringify(logs.filter(l => l.crashed)));
  const chk = openDb(file); let issuedTotal = 0;
  for (const o of chk.prepare("SELECT number, total FROM invoices WHERE kind='invoice'").all()) {
    const notes = chk.prepare("SELECT total FROM invoices WHERE seller_id=? AND rectifies=? AND kind='rectificativa' AND upload_status<>'rejected' AND total<0").all(seller.id, o.number);
    const claims = chk.prepare("SELECT amount FROM credit_claims c WHERE seller_id=? AND original_number=? AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.seller_id=c.seller_id AND i.shipment_key=c.reversal_key AND i.kind='rectificativa')").all(seller.id, o.number);
    const sum = notes.reduce((a, n) => a + Math.abs(n.total), 0) + claims.reduce((a, c) => a + Math.abs(c.amount), 0);
    assert.ok(Math.round(sum * 100) <= Math.round(Math.abs(o.total) * 100), `original ${o.number}: credited+claimed ${sum} exceeds ${o.total}`); issuedTotal += notes.length;
  }
  const nums = chk.prepare("SELECT number FROM invoices WHERE kind='rectificativa'").all().map(r => r.number); assert.equal(new Set(nums).size, nums.length, 'document numbers unique');
  assert.ok(issuedTotal >= 1, 'the race issued at least one credit note overall (otherwise the test proves nothing)');
  assert.deepEqual(other.filter(m => !/held|exceed|more than|balance|concurrent|already|reserv/i.test(m)), [], 'every error is a closed refusal');
  rmSync(dir, { recursive: true, force: true });
  return { busy, issuedTotal };
};
test('8 processes x 20 rounds on one SQLite file (default busy_timeout): credits + claims never exceed the original', { timeout: 110000 }, async () => { await race(undefined); });
test('same race with busy_timeout=1 ms to PROVOKE SQLITE_BUSY: every busy case fails closed, no overcredit, no crash', { timeout: 110000 }, async () => { const { busy } = await race(1); console.log('XPROC provoked SQLITE_BUSY cases logged: ' + busy); });
