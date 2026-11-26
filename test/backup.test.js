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
