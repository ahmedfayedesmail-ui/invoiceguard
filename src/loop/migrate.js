// P3 migration: plaintext records written by the earlier page (`loop:*` keys, readable objects) are moved into the encrypted vault.
// Rules: the plaintext is kept until every record is copied, read back from the vault, compared and counted; nothing unreadable or in conflict is deleted;
// every step is idempotent so an interruption at any point leaves either the original or a verified copy (usually both) and a rerun finishes the job.
import { MIGRATION_KEY } from './vault.js';
const canon = (v) => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
export class MigrationError extends Error { constructor(msg, report) { super(msg); this.code = 'MIGRATION'; this.report = report; } }
export const legacyKeys = async (raw) => (await raw.list()).filter(k => String(k).startsWith('loop:'));

/** Needs an UNLOCKED vault. Returns a report {found, migrated, removed, kept: [{reason,count}]}. Throws MigrationError (with the report) when it stops; the originals are then intact. */
export async function migrateLegacy(vault, { now = () => new Date().toISOString() } = {}) {
  const raw = vault.raw, keys = await legacyKeys(raw), report = { found: keys.length, migrated: 0, removed: 0, unreadable: [], conflicts: [] };
  if (!keys.length) return report;
  const plain = new Map();
  for (const k of keys) { const v = await raw.get(k); if (v && typeof v === 'object' && !Array.isArray(v)) plain.set(k, v); else report.unreadable.push(k); }
  try {
    await raw.put(MIGRATION_KEY, { state: 'copying', found: keys.length, at: now() });
    for (const [k, v] of plain) {
      const have = await vault.adapter.get(k);
      if (have !== null && canon(have) !== canon(v)) { report.conflicts.push(k); continue; } // never overwrite a different encrypted record with old data, and never delete the old one
      if (have === null) await vault.adapter.put(k, v);
    }
    // verify: read back every copied record from the vault and compare; count what the vault holds
    const inVault = new Set(await vault.adapter.list());
    for (const [k, v] of plain) { if (report.conflicts.includes(k)) continue; if (!inVault.has(k) || canon(await vault.adapter.get(k)) !== canon(v)) throw new MigrationError('A record did not read back identically from the vault. Nothing was removed.', report); report.migrated++; }
    await raw.put(MIGRATION_KEY, { state: 'verified', migrated: report.migrated, at: now() });
    for (const [k] of plain) { if (report.conflicts.includes(k)) continue; await raw.del(k); report.removed++; }
    await raw.put(MIGRATION_KEY, { state: report.unreadable.length || report.conflicts.length ? 'partial' : 'done', migrated: report.migrated, removed: report.removed, unreadable: report.unreadable.length, conflicts: report.conflicts.length, at: now() });
    return report;
  } catch (e) { if (e instanceof MigrationError) throw e; throw new MigrationError('The migration stopped (' + (e?.name ?? 'error') + '). The original data is still in place; run it again.', report); }
}
