// Backup keeper (PROTOTYPE). Cloudflare Worker cron handler. Reads the age of the last good backup run, dispatches ONE recovery run when it is old, and alerts a person.
// All outside contact goes through injected providers (github, notifier, heartbeat, clock, store), so the logic runs offline in tests. DRY_RUN is the default: nothing is dispatched and nothing is sent unless DRY_RUN is the string "false".
// It never reads APP_URL, ADMIN_TOKEN or BACKUP_PASSPHRASE and never downloads an artifact: it only reads artifact METADATA.
export const DEFAULTS = { dispatchAfterMs: 7 * 3600e3, warnAfterMs: 8 * 3600e3, criticalAfterMs: 13 * 3600e3, cooldownMs: 90 * 60e3, lockMs: 60e3, correlationWaitMs: 15 * 60e3, maxRunMs: 45 * 60e3, notifyRepeatMs: 6 * 3600e3, maxDispatchFailures: 3, minArtifactBytes: 1 };

/** Atomic lock: ONE statement, compare-and-set on lock_until. D1 runs a statement atomically in the single SQLite database behind it, so two overlapping invocations cannot both see changes == 1. */
export async function acquireLock(store, owner, now, lockMs) {
  const r = await store.prepare('UPDATE state SET lock_until = ?, lock_owner = ? WHERE id = 1 AND lock_until < ?').bind(now + lockMs, owner, now).run();
  return (r.meta?.changes ?? r.changes ?? 0) === 1;
}
export const releaseLock = (store, owner) => store.prepare('UPDATE state SET lock_until = 0, lock_owner = NULL WHERE id = 1 AND lock_owner = ?').bind(owner).run();

async function notify(deps, kind, dedupeKey, title, body, { force = false } = {}) {
  const { store, clock, notifier, cfg } = deps; const now = clock();
  const last = await store.prepare('SELECT at FROM notifications WHERE kind = ? AND dedupe_key = ? ORDER BY at DESC LIMIT 1').bind(kind, dedupeKey).first();
  if (!force && last && now - last.at < cfg.notifyRepeatMs) return false;
  await store.prepare('INSERT INTO notifications (kind, dedupe_key, at) VALUES (?, ?, ?)').bind(kind, dedupeKey, now).run();
  try { await notifier.send({ title, body, priority: kind === 'critical_age' || kind === 'workflow_failed' ? 'high' : 'default' }); } catch (e) { deps.log?.('notify_failed', { kind, error: String(e.message ?? e) }); }
  return true;
}
const ageOf = (run, now) => now - Date.parse(run.updated_at ?? run.created_at);

/** One cycle. Returns a plain summary (also useful in tests). Notification texts hold no secrets and no repository data beyond the run number. */
export async function runCycle(deps) {
  const { store, github, clock, heartbeat } = deps; const cfg = { ...DEFAULTS, ...(deps.cfg ?? {}) }; deps.cfg = cfg;
  const dry = deps.env?.DRY_RUN !== 'false'; const now = clock(); const owner = deps.owner ?? `cycle-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const out = { dry, locked: false, action: 'none', alerts: [], ageMs: null };
  if (!(await acquireLock(store, owner, now, cfg.lockMs))) { out.action = 'skipped_locked'; return out; }
  out.locked = true;
  try {
    const st = await store.prepare('SELECT * FROM state WHERE id = 1').first();
    const runs = await github.listRuns(); // newest first: [{id, status, conclusion, event, created_at, updated_at}]
    const active = runs.find(r => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting');
    const lastGood = runs.find(r => r.status === 'completed' && r.conclusion === 'success');
    const lastDone = runs.find(r => r.status === 'completed');
    out.ageMs = lastGood ? now - Date.parse(lastGood.updated_at) : Infinity;
    // 1. Watchdog on a run that is stuck active for too long.
    if (active && ageOf({ updated_at: active.created_at }, now) > cfg.maxRunMs) { if (await notify(deps, 'workflow_timeout', String(active.id), 'Backup run stuck', `Backup workflow run ${active.id} has been active for over ${Math.round(cfg.maxRunMs / 60e3)} min.`)) out.alerts.push('workflow_timeout'); }
    // 2. A failed latest run.
    if (lastDone && lastDone.conclusion !== 'success' && (!lastGood || Date.parse(lastDone.updated_at) > Date.parse(lastGood.updated_at))) { if (await notify(deps, 'workflow_failed', String(lastDone.id), 'Backup run failed', `Backup workflow run ${lastDone.id} ended with ${lastDone.conclusion}.`)) out.alerts.push('workflow_failed'); }
    // 3. The artifact of the last good run must exist, be unexpired and non-empty (metadata only).
    if (lastGood) {
      const arts = await github.listArtifacts(lastGood.id); const ok = arts.some(a => !a.expired && a.size_in_bytes >= cfg.minArtifactBytes);
      if (!ok) { out.artifact = 'missing'; if (await notify(deps, 'missing_artifact', String(lastGood.id), 'Backup artifact missing', `Backup run ${lastGood.id} succeeded but has no usable artifact.`)) out.alerts.push('missing_artifact'); } else out.artifact = 'ok';
    }
    // 4. Run correlation: a dispatch must show up as a workflow_dispatch run created after it.
    if (st.pending_correlation) {
      const hit = runs.find(r => r.event === 'workflow_dispatch' && Date.parse(r.created_at) >= st.pending_since - 5000);
      if (hit) { await store.prepare('UPDATE dispatches SET run_id = ?, outcome = ? WHERE correlation = ?').bind(String(hit.id), 'matched', st.pending_correlation).run(); await store.prepare('UPDATE state SET pending_correlation = NULL, pending_since = NULL, consecutive_dispatch_failures = 0 WHERE id = 1').run(); out.correlation = 'matched'; }
      else if (now - st.pending_since > cfg.correlationWaitMs && !st.pending_correlation.startsWith('dry-')) {
        await store.prepare('UPDATE dispatches SET outcome = ? WHERE correlation = ?').bind('no_run_seen', st.pending_correlation).run();
        await store.prepare('UPDATE state SET pending_correlation = NULL, pending_since = NULL, consecutive_dispatch_failures = consecutive_dispatch_failures + 1 WHERE id = 1').run();
        out.correlation = 'no_run_seen'; if (await notify(deps, 'dispatch_failed', st.pending_correlation, 'Backup dispatch not seen', 'A recovery dispatch was sent but no run appeared.')) out.alerts.push('dispatch_failed');
      }
    }
    // 5. Dispatch decision.
    const stale = out.ageMs >= cfg.dispatchAfterMs; const cooling = now < st.cooldown_until;
    if (stale && active) out.action = 'wait_active_run';
    else if (stale && cooling) out.action = 'wait_cooldown';
    else if (stale && st.consecutive_dispatch_failures >= cfg.maxDispatchFailures) { out.action = 'dispatch_halted'; if (await notify(deps, 'dispatch_failed', 'halted', 'Backup dispatch halted', `${st.consecutive_dispatch_failures} recovery dispatches in a row produced no run. The keeper stopped dispatching.`)) out.alerts.push('dispatch_failed'); }
    else if (stale) {
      const correlation = `${dry ? 'dry-' : ''}${now}-${owner}`;
      // Claim the dispatch in the database BEFORE calling GitHub: cooldown and pending marker are written first, so a crash or a second invocation cannot dispatch twice.
      const claim = await store.prepare('UPDATE state SET cooldown_until = ?, last_dispatch_at = ?, pending_correlation = ?, pending_since = ? WHERE id = 1 AND lock_owner = ? AND cooldown_until <= ?').bind(now + cfg.cooldownMs, now, correlation, now, owner, now).run();
      if ((claim.meta?.changes ?? claim.changes ?? 0) !== 1) out.action = 'wait_cooldown';
      else {
        await store.prepare('INSERT INTO dispatches (correlation, at, dry_run, outcome) VALUES (?, ?, ?, ?)').bind(correlation, now, dry ? 1 : 0, dry ? 'dry_run' : 'sent').run();
        if (dry) { out.action = 'dispatch_dry_run'; }
        else { try { await github.dispatch(); out.action = 'dispatched'; } catch (e) {
          out.action = 'dispatch_error'; await store.prepare('UPDATE dispatches SET outcome = ? WHERE correlation = ?').bind('error', correlation).run();
          await store.prepare('UPDATE state SET pending_correlation = NULL, pending_since = NULL, consecutive_dispatch_failures = consecutive_dispatch_failures + 1 WHERE id = 1').run();
          if (await notify(deps, 'dispatch_failed', 'error', 'Backup dispatch failed', `Dispatching the recovery run failed (${String(e.status ?? 'error')}).`)) out.alerts.push('dispatch_failed'); } }
        if (out.action !== 'dispatch_error' && await notify(deps, 'recovery_dispatch', correlation, 'Backup recovery dispatched', dry ? '(dry run) Last good backup is older than the dispatch threshold; a recovery run would be dispatched.' : 'Last good backup is older than the dispatch threshold; a recovery run was dispatched.', { force: true })) out.alerts.push('recovery_dispatch');
      }
    }
    // 6. Critical age.
    if (out.ageMs >= cfg.criticalAfterMs && (await notify(deps, 'critical_age', 'critical', 'Backup is critically old', `The last good backup is older than ${Math.round(cfg.criticalAfterMs / 3600e3)} h.`))) out.alerts.push('critical_age');
    out.warn = out.ageMs >= cfg.warnAfterMs && out.ageMs < cfg.criticalAfterMs; // logged only, no notification
    // 7. Heartbeat only after a successful cycle.
    try { await heartbeat.ping(); out.heartbeat = 'sent'; } catch (e) { out.heartbeat = 'failed'; if (await notify(deps, 'heartbeat_failed', 'ping', 'Keeper heartbeat failed', 'The keeper finished a cycle but could not ping its heartbeat.')) out.alerts.push('heartbeat_failed'); }
    return out;
  } finally { await releaseLock(store, owner); }
}
// Cloudflare entry. Providers are built from env here and nowhere else; with DRY_RUN unset they are the same classes but dispatch() and send() refuse to run.
export default { async scheduled(_event, env) { const { buildProviders } = await import('./providers.js'); return runCycle({ ...buildProviders(env), env }); } };
