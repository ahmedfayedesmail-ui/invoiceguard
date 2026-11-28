// T9 regression tests: V3 (apply must not destroy WAL rows / keep a torn copy) and V4 (snapshot must be checked against anchors.log).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, appendAudit } from '../src/db.js';
import { backupNow, anchorLog } from '../src/backup.js';
import { validateSnapshot, stageRestore, applyPendingRestore } from '../src/restore.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ig-t9-'));
function issue(db, seller, n) {
  const doc = { number: n, total: 10 };
  db.prepare("INSERT OR IGNORE INTO sellers (id,name) VALUES (?,?)").run(seller, seller);
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json) VALUES (?,?,?,?,?,?,?,?)').run(seller, n, 'k' + n, 'factura', '2026-01-01', 10, 2, JSON.stringify(doc));
  appendAudit(db, seller, 'issued', n, doc);
}
/** live db with `n` invoices for S1; returns paths. Snapshot is a checkpointed copy taken after `n` invoices. */
function fixture(n = 3) {
  const dir = tmp(), live = join(dir, 'live.db'), bdir = join(dir, 'backups');
  const db = openDb(live); for (let i = 1; i <= n; i++) issue(db, 'S1', 'N' + i);
  anchorLog(db, bdir); db.close();
  const snap = join(dir, 'snap.db'); copyFileSync(live, snap);
  return { dir, live, bdir, snap, anchors: join(bdir, 'anchors.log') };
}
const mut = (file, sql) => { const d = new DatabaseSync(file); d.exec(sql); d.close(); };

test('V4: a faithful snapshot validates against the anchor log', () => {
  const f = fixture(); const v = validateSnapshot(f.snap, { anchorsFile: f.anchors });
  assert.equal(v.ok, true); assert.equal(v.anchorsChecked, 1); assert.equal(v.behindAnchor, undefined);
});
test('V4: truncated audit tail (and its invoice) is refused as behind the anchor', () => {
  const f = fixture(); mut(f.snap, "DELETE FROM audit WHERE seq=3; DELETE FROM invoices WHERE number='N3'");
  const v = validateSnapshot(f.snap, { anchorsFile: f.anchors });
  assert.equal(v.ok, false); assert.match(v.reason, /behind the anchor/); assert.equal(v.behindAnchor[0].snapshotEntries, 2);
});
test('V4: truncated tail without anchors would have passed (documents the original defect)', () => {
  const f = fixture(); mut(f.snap, "DELETE FROM audit WHERE seq=3; DELETE FROM invoices WHERE number='N3'");
  assert.equal(validateSnapshot(f.snap).ok, true);
});
test('V4: wiped audit table with invoices present is refused even with the override', () => {
  const f = fixture(); mut(f.snap, 'DELETE FROM audit');
  for (const o of [{ anchorsFile: f.anchors }, { anchorsFile: f.anchors, allowBehindAnchor: true }, {}]) {
    const v = validateSnapshot(f.snap, o); assert.equal(v.ok, false); assert.match(v.reason, /no audit rows/);
  }
});
test('V4: wiped audit AND invoices is refused as behind the anchor', () => {
  const f = fixture(); mut(f.snap, 'DELETE FROM audit; DELETE FROM invoices');
  const v = validateSnapshot(f.snap, { anchorsFile: f.anchors }); assert.equal(v.ok, false); assert.match(v.reason, /behind the anchor/);
});
test('V4: hash mismatch at the anchored seq is refused and the override cannot bypass it', () => {
  const f = fixture(); const a = JSON.parse(readFileSync(f.anchors, 'utf8').trim()); a.head = 'f'.repeat(64);
  writeFileSync(f.anchors, JSON.stringify(a) + '\n');
  for (const o of [{ anchorsFile: f.anchors }, { anchorsFile: f.anchors, allowBehindAnchor: true }]) {
    const v = validateSnapshot(f.snap, o); assert.equal(v.ok, false); assert.match(v.reason, /does not match the anchor/);
  }
});
test('V4: snapshot older than the anchor needs the explicit override and is then reported', () => {
  const f = fixture(2);
  const live = openDb(f.live); issue(live, 'S1', 'N3'); issue(live, 'S1', 'N4'); anchorLog(live, f.bdir); live.close(); // newer anchor (seq 4) than the snapshot (seq 2)
  const refused = validateSnapshot(f.snap, { anchorsFile: f.anchors }); assert.equal(refused.ok, false); assert.match(refused.reason, /behind the anchor/);
  const v = validateSnapshot(f.snap, { anchorsFile: f.anchors, allowBehindAnchor: true });
  assert.equal(v.ok, true); assert.equal(v.behindAnchor.length, 1); assert.equal(v.behindAnchor[0].anchoredEntries, 4); assert.equal(v.behindAnchor[0].snapshotEntries, 2);
});
test('V4: a corrupt anchors.log line is refused rather than ignored', () => {
  const f = fixture(); writeFileSync(f.anchors, 'garbage\n', { flag: 'a' });
  const v = validateSnapshot(f.snap, { anchorsFile: f.anchors }); assert.equal(v.ok, false); assert.match(v.reason, /anchors.log/);
});
test('V4: stageRestore/applyPendingRestore enforce the anchors next to the live db', () => {
  const f = fixture(); mut(f.snap, "DELETE FROM audit WHERE seq=3; DELETE FROM invoices WHERE number='N3'");
  const st = stageRestore(readFileSync(f.snap), f.live); assert.equal(st.ok, false); assert.equal(existsSync(f.live + '.restore-pending'), false);
  const st2 = stageRestore(readFileSync(f.snap), f.live, { allowBehindAnchor: true }); assert.equal(st2.ok, true); assert.equal(st2.behindAnchor.length, 1);
  // pending file staged with override is refused again at boot unless the override is repeated
  assert.equal(applyPendingRestore(f.live, () => {}).applied, false); assert.equal(existsSync(f.live + '.restore-pending'), false);
});

test('V3: a reader holding the WAL (checkpoint busy=1) aborts the apply; pending, WAL and committed rows survive', () => {
  const f = fixture(1);
  const w = new DatabaseSync(f.live); w.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  w.exec("CREATE TABLE IF NOT EXISTS t9 (x)"); 
  const reader = new DatabaseSync(f.live); reader.exec('BEGIN'); reader.prepare('SELECT count(*) FROM t9').get(); // read txn pins the WAL
  for (let i = 0; i < 50; i++) w.exec(`INSERT INTO t9 VALUES (${i})`);                                        // committed rows live only in the WAL
  assert.ok(existsSync(f.live + '-wal'));
  copyFileSync(f.snap, f.live + '.restore-pending');
  const logs = []; const r = applyPendingRestore(f.live, m => logs.push(m));
  assert.equal(r.applied, false); assert.equal(r.aborted, true); assert.match(r.reason, /busy|WAL|exclusively/);
  assert.equal(existsSync(f.live + '.restore-pending'), true, 'pending kept for a retry');
  assert.equal(existsSync(f.live + '-wal'), true, 'WAL not deleted');
  assert.equal(readdirSync(join(f.dir, 'backups')).some(n => n.startsWith('pre-restore-')), false, 'no torn pre-restore copy is left behind');
  reader.exec('COMMIT'); reader.close(); w.close();
  const chk = new DatabaseSync(f.live); assert.equal(chk.prepare('SELECT count(*) c FROM t9').get().c, 50, 'all committed rows survive'); chk.close();
});
test('V3: once the reader is gone the apply succeeds and the kept copy has every committed row and passes integrity_check', () => {
  const f = fixture(1);
  const w = new DatabaseSync(f.live); w.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS t9 (x)');
  for (let i = 0; i < 50; i++) w.exec(`INSERT INTO t9 VALUES (${i})`);
  w.close();
  copyFileSync(f.snap, f.live + '.restore-pending');
  const r = applyPendingRestore(f.live, () => {}); assert.equal(r.applied, true);
  const k = new DatabaseSync(r.kept); assert.equal(k.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(k.prepare('SELECT count(*) c FROM t9').get().c, 50); k.close();
  assert.equal(existsSync(f.live + '.restore-pending'), false);
});
