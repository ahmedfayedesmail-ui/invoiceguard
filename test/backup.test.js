import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupNow } from '../src/backup.js';

test('a busy database is reported honestly and no stale snapshot is copied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-bak-'));
  const dbFile = join(dir, 'x.db');
  const a = new DatabaseSync(dbFile);
  a.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  const b = new DatabaseSync(dbFile);
  b.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES (2);'); // held write transaction blocks the checkpoint
  const r = backupNow(dbFile, join(dir, 'backups'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /busy/);
  assert.equal(readdirSync(join(dir, 'backups')).filter(f => f.endsWith('.db')).length, 0, 'no stale snapshot was copied');
  b.exec('ROLLBACK'); b.close();
  const r2 = backupNow(dbFile, join(dir, 'backups'));
  assert.equal(r2.ok, true, 'the next run after the lock clears backs up normally');
  a.close();
}, { timeout: 30000 });

test('swarm-backend B2: rotation keeps the newest N invoiceguard backups and ignores pre-restore safety copies', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ig-bak-')), dbFile = join(dir, 'x.db'), bdir = join(dir, 'backups');
  const a = new DatabaseSync(dbFile); a.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);'); a.close();
  const { mkdirSync } = await import('node:fs'); mkdirSync(bdir);
  for (let i = 1; i <= 14; i++) writeFileSync(join(bdir, `invoiceguard-2026-11-${String(i).padStart(2, '0')}-00-00.db`), 'x');
  for (let i = 1; i <= 3; i++) writeFileSync(join(bdir, `pre-restore-2026-0${i}-01-00-00.db`), 'x');
  const r = backupNow(dbFile, bdir, { keep: 14 });
  assert.equal(r.ok, true);
  const names = readdirSync(bdir).filter(f => f.endsWith('.db'));
  assert.equal(names.filter(f => f.startsWith('invoiceguard-')).length, 14, 'all 14 retention slots belong to real backups');
  assert.equal(names.filter(f => f.startsWith('pre-restore-')).length, 3, 'pre-restore copies are never rotated by the backup job');
});

test('swarm-backend B1: a snapshot is a valid database holding the committed rows, and no temp file is left behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-bak-')), dbFile = join(dir, 'x.db');
  const a = new DatabaseSync(dbFile); a.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);');
  const r = backupNow(dbFile, join(dir, 'backups')); a.close();
  assert.equal(r.ok, true);
  const s = new DatabaseSync(r.dest);
  assert.equal(s.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(s.prepare('SELECT count(*) c FROM t').get().c, 2); s.close();
  assert.deepEqual(readdirSync(join(dir, 'backups')).filter(f => f.startsWith('.inprogress')), []);
});
