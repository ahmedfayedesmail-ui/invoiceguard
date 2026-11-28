import { DatabaseSync } from 'node:sqlite'; import { readFileSync } from 'node:fs';
// Minimal D1 look-alike over node:sqlite: prepare(sql).bind(...).run()/first()/all(); run() returns { meta: { changes } } like D1.
export function d1(file = ':memory:') {
  const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=5000;'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const mk = (sql, args = []) => ({ bind: (...a) => mk(sql, a), run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; }, first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }) });
  return { prepare: (sql) => mk(sql), raw: db };
}
export const H = 3600e3, T0 = Date.parse('2026-11-28T12:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();
export const run = (id, status, conclusion, atMs, event = 'schedule') => ({ id, status, conclusion, event, created_at: iso(atMs), updated_at: iso(atMs) });
export function mocks({ runs = [], artifacts = { default: [{ expired: false, size_in_bytes: 1000 }] }, now = T0 } = {}) {
  const m = { now, runs, sent: [], pings: 0, dispatches: 0, failDispatch: false, failPing: false, failNotify: false };
  m.github = { listRuns: async () => m.runs, listArtifacts: async (id) => artifacts[id] ?? artifacts.default, dispatch: async () => { m.dispatches++; if (m.failDispatch) { const e = new Error('x'); e.status = 500; throw e; } } };
  m.notifier = { send: async (n) => { if (m.failNotify) throw new Error('down'); m.sent.push(n); } };
  m.heartbeat = { ping: async () => { if (m.failPing) throw new Error('down'); m.pings++; } };
  m.clock = () => m.now; return m;
}
export const deps = (m, store, env = { DRY_RUN: 'false' }, extra = {}) => ({ store, github: m.github, clock: m.clock, notifier: m.notifier, heartbeat: m.heartbeat, env, ...extra });
