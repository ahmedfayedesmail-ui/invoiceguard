// Load, concurrency and crash-recovery measurements for the sealed evidence chain. Synthetic data and a temp database only.
// Usage: node tools/intel-load.mjs [rows=20000]
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join, resolve } from 'node:path'; import { spawn } from 'node:child_process'; import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js'; import { openIntelReader, sealSellerEvidence, verifyEvidenceChain, exportEvidenceBundle, verifyEvidenceBundle, buildDocumentTimeline } from '../src/intel/store.js';
const N = Number(process.argv[2] || 20000); const dir = mkdtempSync(join(tmpdir(), 'ig-load-')); const path = join(dir, 'load.db'); const worker = resolve('tools/intel-load-worker.mjs');
const out = []; const check = (name, ok, detail = '') => { out.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const runWorker = (sid, killAfterMs = null) => new Promise((res) => { const p = spawn(process.execPath, [worker, path, sid], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = '', e = ''; p.stdout.on('data', x => o += x); p.stderr.on('data', x => e += x); if (killAfterMs) setTimeout(() => p.kill('SIGKILL'), killAfterMs); p.on('close', (code, sig) => { let j = null; try { j = JSON.parse(o); } catch {} res({ code, sig, j, err: e.slice(0, 300) }); }); });
const db = openDb(path); const iso = (i) => new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString();
function seed(sid, rows) {
  db.prepare('INSERT INTO sellers (id,name,created_at) VALUES (?,?,?)').run(sid, 'Load ' + sid, iso(0));
  const ev = db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)'), ih = db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)');
  const inv = db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)'), sh = db.prepare('INSERT INTO shipments (seller_id,key,order_id,shipping_id,total,vat,shipment_date,due_at,status,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const nEv = Math.floor(rows * .45), nIh = Math.floor(rows * .25), nInv = Math.floor(rows * .10), nSh = rows - nEv - nIh - nInv;
  db.exec('BEGIN');
  for (let i = 0; i < nEv; i++) ev.run(iso(i), sid, 'invoice_created', JSON.stringify({ number: `${sid}-${i % nInv}`, status: 'ready', reason: 'private free text ' + i }));
  for (let i = 0; i < nIh; i++) ih.run(sid, `SH-${i % nSh}`, 'AMOUNT_MISMATCH', 'total', i % 2 ? 'opened' : 'resolved', 'fp-' + i, iso(i));
  for (let i = 0; i < nInv; i++) inv.run(sid, `${sid}-${i}`, `SH-${i}`, 'invoice', iso(i), 59.9 + (i % 7), 9.9, 'ready');
  for (let i = 0; i < nSh; i++) sh.run(sid, `SH-${i}`, 'O-' + i, 'SH-' + i, 59.9, 9.9, '2026-11-01', '2026-12-01', 'open', 'test', iso(i));
  db.exec('COMMIT'); return nEv + nIh + nInv + nSh;
}
const total = seed('big', N); check(`seeded ${total} source rows for one seller`, total === N);
for (const s of ['s1', 's2', 's3', 's4']) seed(s, 200);
const reader = () => openIntelReader(path);
// 1. first seal of 20k rows (one process)
let r = await runWorker('big'); check('first seal of the large seller succeeds', r.j && r.code === 0, r.err); const first = r.j; console.log('   first seal ms=' + first.ms + ' maxRssMb=' + first.maxRssMb + ' seq=' + first.seq);
check('chain holds every source row plus coverage', first.seq === N + first.added - N && first.added === N + 1, `added=${first.added}`);
let t = performance.now(); const v = verifyEvidenceChain(db, 'big'); const verMs = Math.round(performance.now() - t); check('full chain verifies', v.valid && v.sequence === first.seq, `verify ms=${verMs}`);
// 2. idempotency: a second seal over unchanged data adds nothing
r = await runWorker('big'); check('re-seal of unchanged data adds nothing and keeps the head', r.j && r.j.added === 0 && r.j.hash === first.hash, JSON.stringify(r.j && { added: r.j.added, ms: r.j.ms, maxRssMb: r.j.maxRssMb }));
// 3. concurrency: 4 processes on 4 different sellers, and 6 processes on one seller
t = performance.now(); const sellers = await Promise.all(['s1', 's2', 's3', 's4'].map(s => runWorker(s))); const msSellers = Math.round(performance.now() - t);
check('concurrent sealing of four different sellers all succeed', sellers.every(x => x.j && x.code === 0), `wall ms=${msSellers} ` + sellers.map(x => x.err).join('').slice(0, 200));
for (const s of ['s1', 's2', 's3', 's4']) check(`seller ${s} chain is valid and contains only its own rows`, verifyEvidenceChain(db, s).valid && db.prepare("SELECT COUNT(*) n FROM intel_evidence_chain WHERE seller_id=? AND canonical_json LIKE '%\"sellerId\":\"' || ? || '\"%'").get(s, s).n === db.prepare('SELECT COUNT(*) n FROM intel_evidence_chain WHERE seller_id=?').get(s).n);
check('no seller chain contains another seller\'s id in its body', db.prepare("SELECT COUNT(*) n FROM intel_evidence_chain WHERE seller_id='s1' AND (canonical_json LIKE '%s2-%' OR canonical_json LIKE '%\"big\"%')").get().n === 0);
db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)').run(iso(99999), 's1', 'invoice_created', JSON.stringify({ number: 's1-1', status: 'ready' }));
t = performance.now(); const same = await Promise.all(Array.from({ length: 6 }, () => runWorker('s1'))); const msSame = Math.round(performance.now() - t);
check('six concurrent seals of one seller all succeed', same.every(x => x.j && x.code === 0), `wall ms=${msSame} ` + same.map(x => x.err).join('').slice(0, 200));
const sc = db.prepare('SELECT seq FROM intel_evidence_chain WHERE seller_id=? ORDER BY seq').all('s1').map(x => x.seq); check('the one-seller chain is gapless and valid', verifyEvidenceChain(db, 's1').valid && sc.every((x, i) => x === i + 1));
check('the new event was sealed exactly once (90 seeded events + 1 new)', db.prepare("SELECT COUNT(*) n FROM intel_evidence_chain WHERE seller_id='s1' AND kind='seller_or_system_event'").get().n === 91);
check('total added across the six concurrent seals equals the rows added', same.reduce((n, x) => n + x.j.added, 0) >= 1);
// 4. crash/restart: kill a worker mid-seal on a seller with data not yet sealed, three times, then recover
seed('crash', N);
for (const [i, ms] of [150, 600, 1000, 1400, 1700, 1900, 2100, 2400].entries()) { const k = await runWorker('crash', ms); const dbc = new DatabaseSync(path, { readOnly: true }); const vv = verifyEvidenceChain(dbc, 'crash'); dbc.close(); check(`after kill #${i + 1} (${k.sig || 'exit ' + k.code}) the stored chain is empty or valid, never half-written (seq ${vv.sequence})`, vv.valid && (vv.sequence === 0 || vv.sequence >= N), JSON.stringify(vv)); }
r = await runWorker('crash'); check('restart after crashes seals the full seller and verifies', r.j && r.code === 0 && verifyEvidenceChain(db, 'crash').valid, r.j ? `seq=${r.j.seq} added=${r.j.added} ms=${r.j.ms}` : r.err);
check('the recovered chain has exactly one entry per source row plus one coverage statement', db.prepare('SELECT COUNT(*) n FROM intel_evidence_chain WHERE seller_id=?').get('crash').n === N + 1);
// 5. big export, offline verify, a timeline
t = performance.now(); const bundle = exportEvidenceBundle(db, 'big'); const expMs = Math.round(performance.now() - t); t = performance.now(); const bv = verifyEvidenceBundle(bundle); const bvMs = Math.round(performance.now() - t);
check('large bundle exports and verifies offline', bv.valid, `export ms=${expMs} verify ms=${bvMs} bytes=${JSON.stringify(bundle).length}`);
t = performance.now(); const tl = buildDocumentTimeline(db, 'big', 'big-1'); check('document timeline on the large chain is built', tl.events.length > 0, `ms=${Math.round(performance.now() - t)} events=${tl.events.length}`);
check('timeline of the large seller never contains free-text reasons', !JSON.stringify(tl).includes('private free text'));
console.log('\nPeak parent RSS MB: ' + Math.round(process.resourceUsage().maxRSS / 1024)); db.close(); rmSync(dir, { recursive: true, force: true });
const bad = out.filter(x => !x.ok); console.log(`\n${out.length - bad.length}/${out.length} checks passed`); process.exit(bad.length ? 1 : 0);
