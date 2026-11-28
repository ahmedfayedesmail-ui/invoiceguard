// N6: operator override (ALLOW_BEHIND_ANCHOR), loud warning when anchors.log is absent, collision-proof pre-restore filename. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, appendAudit } from '../src/db.js';
import { anchorLog } from '../src/backup.js';
import { validateSnapshot, stageRestore, applyPendingRestore } from '../src/restore.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ig-n6-'));
function issue(db, seller, n) {
  const doc = { number: n, total: 10 };
  db.prepare("INSERT OR IGNORE INTO sellers (id,name) VALUES (?,?)").run(seller, seller);
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json) VALUES (?,?,?,?,?,?,?,?)').run(seller, n, 'k' + n, 'factura', '2026-01-01', 10, 2, JSON.stringify(doc));
  appendAudit(db, seller, 'issued', n, doc);
}
function fixture(n = 3) {
  const dir = tmp(), live = join(dir, 'live.db'), bdir = join(dir, 'backups');
  const db = openDb(live); for (let i = 1; i <= n; i++) issue(db, 'S1', 'N' + i);
  anchorLog(db, bdir); db.close();
  const snap = join(dir, 'snap.db'); copyFileSync(live, snap);
  return { dir, live, bdir, snap, anchors: join(bdir, 'anchors.log') };
}
/** live db has moved on (seq 4 anchored) while the snapshot is older (seq 2): a legitimate older backup in a disaster. */
function olderBackup() {
  const f = fixture(2); const live = openDb(f.live); issue(live, 'S1', 'N3'); issue(live, 'S1', 'N4'); anchorLog(live, f.bdir); live.close(); return f;
}
const withEnv = (v, fn) => { const old = process.env.ALLOW_BEHIND_ANCHOR; if (v === undefined) delete process.env.ALLOW_BEHIND_ANCHOR; else process.env.ALLOW_BEHIND_ANCHOR = v; try { return fn(); } finally { if (old === undefined) delete process.env.ALLOW_BEHIND_ANCHOR; else process.env.ALLOW_BEHIND_ANCHOR = old; } };

test('N6: with no override a legitimate older backup is refused, and the refusal names ALLOW_BEHIND_ANCHOR (operator path)', () => {
  withEnv(undefined, () => {
    const f = olderBackup(); const st = stageRestore(readFileSync(f.snap), f.live);
    assert.equal(st.ok, false); assert.match(st.reason, /ALLOW_BEHIND_ANCHOR/);
  });
});
test('N6: ALLOW_BEHIND_ANCHOR=1 lets the app call sites (no opts) stage AND apply an older backup, loudly', () => {
  withEnv('1', () => {
    const f = olderBackup(); const warn = [], logs = [];
    const st = stageRestore(readFileSync(f.snap), f.live, { log: m => warn.push(m) });
    assert.equal(st.ok, true); assert.equal(st.staged, true); assert.equal(st.behindAnchor.length, 1);
    assert.ok(st.warnings.some(w => /OVERRIDE ACTIVE/.test(w) && /seller S1/.test(w)), 'stage result carries the override warning');
    assert.ok(warn.some(m => /restore staging WARNING: OVERRIDE ACTIVE/.test(m)), 'stage logs the override loudly');
    const r = applyPendingRestore(f.live, m => logs.push(m));
    assert.equal(r.applied, true); assert.equal(r.behindAnchor.length, 1); assert.ok(r.warnings.some(w => /OVERRIDE ACTIVE/.test(w)));
    assert.ok(logs.some(m => /restore apply WARNING: OVERRIDE ACTIVE/.test(m)) && logs.some(m => /OVERRIDE: snapshot is BEHIND/.test(m)));
  });
});
test('N6: only the exact value 1 enables the override; a hash mismatch still cannot be overridden', () => {
  for (const v of ['0', 'true', 'yes', '']) withEnv(v, () => { const f = olderBackup(); assert.equal(stageRestore(readFileSync(f.snap), f.live).ok, false, JSON.stringify(v)); });
  withEnv('1', () => {
    const f = fixture(3); const live = openDb(f.live); live.exec("UPDATE audit SET hash='deadbeef' WHERE seq=3"); live.close(); // not a chain-valid snapshot, and anchored head differs
    const snap = readFileSync(f.live); assert.equal(stageRestore(snap, f.live).ok, false);
  });
});
test('N6: explicit opts.allowBehindAnchor=false beats the environment', () => {
  withEnv('1', () => { const f = olderBackup(); assert.equal(stageRestore(readFileSync(f.snap), f.live, { allowBehindAnchor: false }).ok, false); });
});

test('N6: absent anchors.log is a loud warning on validate, stage and apply (and absent from a normal restore)', () => {
  withEnv(undefined, () => {
    const f = fixture(2); rmSync(f.anchors);
    const v = validateSnapshot(f.snap, { anchorsFile: f.anchors });
    assert.equal(v.ok, true); assert.equal(v.anchorsFilePresent, false); assert.match(v.warnings[0], /NOT checked against any anchor/);
    assert.match(validateSnapshot(f.snap, {}).warnings[0], /no anchors file given/);
    const warn = [], logs = [];
    const st = stageRestore(readFileSync(f.snap), f.live, { log: m => warn.push(m) });
    assert.equal(st.ok, true); assert.match(st.warnings[0], /anchors\.log was not found/); assert.ok(warn.some(m => /restore staging WARNING/.test(m)));
    const r = applyPendingRestore(f.live, m => logs.push(m));
    assert.equal(r.applied, true); assert.match(r.warnings[0], /NOT checked/); assert.ok(logs.some(m => /restore apply WARNING: anchors\.log was not found/.test(m)));
    const g = fixture(2); const ok = validateSnapshot(g.snap, { anchorsFile: g.anchors });
    assert.equal(ok.ok, true); assert.equal(ok.warnings, undefined, 'no warning when anchors.log is present and satisfied');
  });
});

test('N6: two applies in the same minute (even second) keep distinct pre-restore files', () => {
  withEnv(undefined, () => {
    const f = fixture(2);
    for (let i = 0; i < 3; i++) { copyFileSync(f.snap, f.live + '.restore-pending'); assert.equal(applyPendingRestore(f.live, () => {}).applied, true); }
    const kept = readdirSync(f.bdir).filter(n => n.startsWith('pre-restore-'));
    assert.equal(kept.length, 3, 'no kept copy was overwritten: ' + kept.join(','));
    for (const n of kept) assert.match(n, /^pre-restore-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}\.db$/);
  });
});
