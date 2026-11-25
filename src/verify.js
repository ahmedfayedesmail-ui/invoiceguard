/** Pre-issuance verification of the buyer's fiscal data. Runs before any invoice number is used. */
const FORMS = /\b(s\.?l\.?u?|s\.?a\.?u?|s\.?l\.?l|gmbh|ag|kg|ug|ltd|limited|llc|inc|srl|spa|s\.r\.l|bv|b\.v|nv|n\.v|sarl|sas|eurl|sp\.? z o\.?o|co|company|the)\b\.?/g;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(FORMS, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Loose company-name comparison: ignores legal forms, accents and word order. */
export function nameMatches(a, b) {
  const x = new Set(norm(a).split(' ').filter(Boolean)), y = new Set(norm(b).split(' ').filter(Boolean));
  if (!x.size || !y.size) return true; // nothing to compare
  const inter = [...x].filter(t => y.has(t)).length;
  return inter / Math.min(x.size, y.size) >= 0.6;
}
const L = 'TRWAGMYFPDXBNJZSQVHLCKE';
/** Spanish tax ID structure and control character (DNI, NIE, CIF). Offline: proves the number is well formed, not that it is registered. */
export function spanishNifValid(raw) {
  const v = String(raw ?? '').replace(/^ES/i, '').replace(/[\s.\-]/g, '').toUpperCase();
  if (/^\d{8}[A-Z]$/.test(v)) return L[+v.slice(0, 8) % 23] === v[8];
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) return L[+('XYZ'.indexOf(v[0]) + v.slice(1, 8)) % 23] === v[8];
  if (/^[KLM]\d{7}[A-Z]$/.test(v)) return L[+v.slice(1, 8) % 23] !== undefined; // special individual forms: structure only
  const m = v.match(/^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/); if (!m) return false;
  const d = m[2].split('').map(Number); let s = 0;
  d.forEach((n, i) => { if (i % 2 === 0) { const t = n * 2; s += Math.floor(t / 10) + t % 10; } else s += n; });
  const c = (10 - s % 10) % 10, digit = String(c), letter = 'JABCDEFGHI'[c];
  if ('PQRSNW'.includes(m[1])) return m[3] === letter; if ('ABEH'.includes(m[1])) return m[3] === digit; return m[3] === digit || m[3] === letter;
}

export function ensureVerifyTables(db) { db.exec('CREATE TABLE IF NOT EXISTS overrides (seller_id TEXT, key TEXT, check_id TEXT, by_who TEXT, at TEXT, PRIMARY KEY (seller_id, key, check_id))'); }
export const hasOverride = (db, sellerId, key, id) => { ensureVerifyTables(db); return !!db.prepare('SELECT 1 FROM overrides WHERE seller_id=? AND key=? AND check_id=?').get(sellerId, key, id); };
export function addOverride(db, sellerId, key, id, who) { ensureVerifyTables(db); db.prepare('INSERT OR REPLACE INTO overrides VALUES (?,?,?,?,?)').run(sellerId, key, id, who, new Date().toISOString()); }

/**
 * Checks on a B2B buyer. Returns { hold?: {id, reason, overridable}, defer?: reason, notes: [] }.
 * - Spanish NIF structure (hard, offline).
 * - VIES registered name vs the name on the order (hold on a clear mismatch, release possible).
 * - AEAT census name+NIF check through `census(nif, name)` when the seller has configured it: { status: 'match'|'mismatch'|'unavailable' }.
 *   The official AEAT service needs the seller's own electronic certificate, so without it the check is reported as not run, never as passed.
 */
export async function verifyBuyer(db, seller, s, vies, { census = null } = {}) {
  const notes = [], vat = (s.buyerVat ?? '').toUpperCase(), name = s.buyerCompany || s.billing?.name;
  if (!vat) return { notes };
  if (vat.startsWith('ES')) {
    if (!spanishNifValid(vat)) return { hold: { id: 'nif_checksum', reason: `Buyer NIF ${vat} fails the Spanish control-character check`, overridable: false }, notes };
    notes.push('NIF structure ok');
    if (census) {
      let r; try { r = await census(vat.slice(2), name); } catch { r = { status: 'unavailable' }; }
      if (r.status === 'mismatch' && !hasOverride(db, seller.id, s.key, 'census')) return { hold: { id: 'census', reason: `AEAT census: NIF ${vat} does not match the buyer name "${name}"`, overridable: true }, notes };
      if (r.status === 'unavailable') return { defer: 'AEAT census check unavailable, will retry', notes };
      if (r.status === 'match') notes.push('AEAT census name+NIF match');
    } else notes.push('AEAT census check not run (certificate not configured)');
  }
  if (vies?.status === 'valid' && vies.name && !nameMatches(name, vies.name) && !hasOverride(db, seller.id, s.key, 'vies_name'))
    return { hold: { id: 'vies_name', reason: `VIES registers ${vat} to "${vies.name}", which does not match the buyer name "${name}"`, overridable: true }, notes };
  if (vies?.status === 'valid') notes.push('VIES valid');
  return { notes };
}
