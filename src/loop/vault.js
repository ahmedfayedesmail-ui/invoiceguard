// Encrypted local vault for the problem loop (P3). Pure module on the platform's Web Crypto API (global `crypto.subtle`: browsers and Node).
// No custom cryptography: PBKDF2-HMAC-SHA256 (password stretching), HKDF-SHA256 (key separation), AES-256-GCM (authenticated encryption), HMAC-SHA256 (opaque record ids, manifest).
//
// Key hierarchy
//   password --PBKDF2(salt, iterations)--> KEK (AES-GCM, wrap only) --decrypts--> master secret (32 random bytes)
//   recovery key (32 random bytes, shown once) --HKDF--> recovery KEK --decrypts--> the same master secret
//   master secret --imported as a NON-EXTRACTABLE HKDF key-->  record key (AES-GCM) and id key (HMAC); the raw bytes are zeroed right after import.
// The password and the master secret are never stored. Only the two wrapped copies of the master secret are.
//
// Record envelope (version 1): { e: 1, iv, ct } with a fresh random 96-bit IV per write. The authenticated data binds the record to
// vault id + storage key + envelope version, so a record moved to another key, another vault or another version fails to decrypt.
// The plaintext inside is { k: logicalKey, v: value }. The storage key is `e1:<kind>:<HMAC(logicalKey)>`: the kind prefix is visible, the logical key (which holds import ids and hashes) is not.
export const VAULT_VERSION = 1, ENVELOPE_VERSION = 1, META_KEY = 'vault:meta', MIGRATION_KEY = 'vault:migration', KDF_ITERATIONS = 600000;
export class VaultLocked extends Error { constructor() { super('The vault is locked.'); this.code = 'VAULT_LOCKED'; } }
export class VaultError extends Error { constructor(msg, code = 'VAULT_ERROR') { super(msg); this.code = code; } }

const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { throw new VaultError('A stored value is not valid base64.', 'CORRUPT'); } };
const b64u = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const S = () => crypto.subtle;

const kdfBits = async (password, salt, iterations) => S().deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, await S().importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const recoveryKek = async (recBytes, salt) => S().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('ig/recovery/v1') }, await S().importKey('raw', recBytes, 'HKDF', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const gcm = async (key, iv, aad, data) => new Uint8Array(await S().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, data));
const ungcm = async (key, iv, aad, data) => new Uint8Array(await S().decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, data));

/** Recovery key as 13 groups of 4 base32 characters (52 characters, 256 bits). Shown once; stored nowhere. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const recoveryToText = (u8) => { let bits = '', out = ''; for (const x of u8) bits += x.toString(2).padStart(8, '0'); bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out.match(/.{1,4}/g).join('-'); };
export const recoveryFromText = (t) => { const s = String(t).replace(/[\s-]/g, '').toUpperCase(); let bits = ''; for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new VaultError('The recovery key has a character that is not allowed.', 'BAD_RECOVERY'); bits += i.toString(2).padStart(5, '0'); } const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2); if (bits.length < 256) throw new VaultError('The recovery key is too short.', 'BAD_RECOVERY'); return out; };

const wrapAad = (vaultId, who) => `ig|v${VAULT_VERSION}|wrap|${vaultId}|${who}`;
const recAad = (vaultId, sk) => `ig|v${ENVELOPE_VERSION}|rec|${vaultId}|${sk}`;
const kindOf = (logical) => { const i = String(logical).lastIndexOf(':'); return i > 0 ? String(logical).slice(0, i) : String(logical); };

/** Everything the vault needs to know about the raw store: put/get/list/del/clear (async, string keys, JSON-able values). */
export function createVault(raw, { iterations = KDF_ITERATIONS, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), onLock = () => {} } = {}) {
  let session = null, timer = null, autoMs = 0, vaultIdCache = null; // session = { encKey, idKey, vaultId }
  const needMeta = async () => { const m = await raw.get(META_KEY); if (!m) throw new VaultError('No vault exists here yet.', 'NO_VAULT'); if (m.v !== VAULT_VERSION) throw new VaultError('This vault was written by a newer version and cannot be opened here.', 'UNSUPPORTED_VERSION'); return m; };
  const openSession = async (rawSecret, vaultId) => {
    const hk = await S().importKey('raw', rawSecret, 'HKDF', false, ['deriveKey']); rawSecret.fill(0);
    const derive = (info, alg, usages) => S().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(vaultId), info: te.encode(info) }, hk, alg, false, usages);
    return { vaultId, encKey: await derive('ig/record/v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']), idKey: await derive('ig/id/v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']) };
  };
  const arm = () => { if (timer) clearTimer(timer); timer = null; if (session && autoMs > 0) timer = setTimer(() => api.lock('inactivity'), autoMs); };
  const live = () => { if (!session) throw new VaultLocked(); arm(); return session; };
  const storageKey = async (s, logical) => `e${ENVELOPE_VERSION}:${kindOf(logical)}:${b64u(new Uint8Array(await S().sign('HMAC', s.idKey, te.encode(logical))))}`;
  const seal = async (s, sk, logical, value) => { const iv = rand(12); return { e: ENVELOPE_VERSION, iv: b64(iv), ct: b64(await gcm(s.encKey, iv, recAad(s.vaultId, sk), te.encode(JSON.stringify({ k: logical, v: value })))) }; };
  const open = async (s, sk, env) => {
    if (!env || env.e !== ENVELOPE_VERSION || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new VaultError('A stored record is not a valid encrypted record.', 'CORRUPT');
    let pt; try { pt = JSON.parse(td.decode(await ungcm(s.encKey, unb64(env.iv), recAad(s.vaultId, sk), unb64(env.ct)))); } catch (e) { if (e instanceof VaultError) throw e; throw new VaultError('A stored record failed its integrity check (changed, damaged or moved).', 'CORRUPT'); }
    return pt;
  };
  const isEnv = (k) => String(k).startsWith(`e${ENVELOPE_VERSION}:`);
  const names = new Map(); // storage key -> logical key, filled as records are opened in this session (keys only, never values)

  const api = {
    /** Does a vault exist in this raw store? */
    async exists() { return !!(await raw.get(META_KEY)); },
    get unlocked() { return !!session; },
    /** Creates the vault. Returns the recovery key text ONCE. Nothing about the password or the master secret is stored. */
    async create(password) {
      if (typeof password !== 'string' || password.length < 10) throw new VaultError('Choose a password of at least 10 characters.', 'WEAK_PASSWORD');
      if (await raw.get(META_KEY)) throw new VaultError('A vault already exists here.', 'EXISTS');
      const vaultId = 'v-' + b64u(rand(12)), secret = rand(32), recBytes = rand(32), salt = rand(16), recSalt = rand(16), iv1 = rand(12), iv2 = rand(12);
      const kek = await kdfBits(password, salt, iterations), rk = await recoveryKek(recBytes, recSalt);
      const meta = { v: VAULT_VERSION, vaultId, createdAt: new Date(now()).toISOString(), kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations, salt: b64(salt) },
        pw: { iv: b64(iv1), ct: b64(await gcm(kek, iv1, wrapAad(vaultId, 'pw'), secret)) }, rec: { salt: b64(recSalt), iv: b64(iv2), ct: b64(await gcm(rk, iv2, wrapAad(vaultId, 'rec'), secret)) } };
      await raw.put(META_KEY, meta); session = await openSession(secret, vaultId); arm();
      return { recoveryKey: recoveryToText(recBytes), vaultId };
    },
    /** Unlocks with the password (or the recovery key). A wrong secret and a damaged vault give the same answer. */
    async unlock(password) {
      const m = await needMeta(); let secret;
      try { secret = await ungcm(await kdfBits(String(password), unb64(m.kdf.salt), m.kdf.iterations), unb64(m.pw.iv), wrapAad(m.vaultId, 'pw'), unb64(m.pw.ct)); } catch { throw new VaultError('That password does not open this vault.', 'WRONG_PASSWORD'); }
      session = await openSession(secret, m.vaultId); arm(); return true;
    },
    async unlockWithRecoveryKey(text) {
      const m = await needMeta(); let secret;
      try { secret = await ungcm(await recoveryKek(recoveryFromText(text), unb64(m.rec.salt)), unb64(m.rec.iv), wrapAad(m.vaultId, 'rec'), unb64(m.rec.ct)); } catch (e) { if (e.code === 'BAD_RECOVERY') throw e; throw new VaultError('That recovery key does not open this vault.', 'WRONG_RECOVERY'); }
      session = await openSession(secret, m.vaultId); arm(); return true;
    },
    /** Sets a new password. Needs the vault unlocked AND the current password (re-checked). Records are not rewritten: only the wrapper changes. */
    async changePassword(current, next) {
      if (!session) throw new VaultLocked(); if (typeof next !== 'string' || next.length < 10) throw new VaultError('Choose a password of at least 10 characters.', 'WEAK_PASSWORD');
      const m = await needMeta(); let secret; try { secret = await ungcm(await kdfBits(String(current), unb64(m.kdf.salt), m.kdf.iterations), unb64(m.pw.iv), wrapAad(m.vaultId, 'pw'), unb64(m.pw.ct)); } catch { throw new VaultError('The current password is not right.', 'WRONG_PASSWORD'); }
      const salt = rand(16), iv = rand(12); await raw.put(META_KEY, { ...m, kdf: { ...m.kdf, salt: b64(salt) }, pw: { iv: b64(iv), ct: b64(await gcm(await kdfBits(next, salt, m.kdf.iterations), iv, wrapAad(m.vaultId, 'pw'), secret)) } }); secret.fill(0);
    },
    /** Manual lock, or the inactivity timer. Drops every key reference; nothing is written, so active work is not corrupted (a write in flight finishes or fails closed). */
    lock(reason = 'manual') { session = null; names.clear(); if (timer) clearTimer(timer); timer = null; try { onLock(reason); } catch { /* a listener must not keep the vault open */ } },
    /** 0 turns the inactivity lock off. Any vault operation counts as activity; the page also calls touch() on user input. */
    setAutoLock(ms) { autoMs = Math.max(0, Number(ms) || 0); arm(); }, touch() { if (session) arm(); },
    get autoLockMs() { return autoMs; },
    /** The adapter the loop store uses. Same put/get/list/clear surface; fails closed while locked or when anything does not verify. */
    adapter: {
      async put(logical, value) { const s = live(), sk = await storageKey(s, logical); await raw.put(sk, await seal(s, sk, logical, value)); names.set(sk, logical); },
      async get(logical) { const s = live(), sk = await storageKey(s, logical), env = await raw.get(sk); if (!env) return null; const pt = await open(s, sk, env); if (pt.k !== logical) throw new VaultError('A stored record does not belong to this key.', 'CORRUPT'); return pt.v; },
      async del(logical) { const s = live(), sk = await storageKey(s, logical); await raw.del(sk); names.delete(sk); },
      /** Logical keys. Opens each unseen record once (to learn its key) and so also verifies it: a damaged record makes list() fail rather than vanish. */
      async list() { const s = live(), out = []; for (const sk of (await raw.list()).filter(isEnv)) { if (!names.has(sk)) { const pt = await open(s, sk, await raw.get(sk)); names.set(sk, pt.k); } out.push(names.get(sk)); } return out; },
      /** Removes every encrypted record AND the vault metadata (the wrapped master secrets): what is left cannot be opened by anything. Legacy plaintext is handled by the migration module. */
      async clear() { live(); await api.destroy(); },
    },
    /** Whole-workspace deletion: encrypted records, vault metadata and the migration marker are removed; the session is dropped. */
    async destroy() { for (const k of await raw.list()) if (isEnv(k) || k === META_KEY || k === MIGRATION_KEY) await raw.del(k); session = null; names.clear(); if (timer) clearTimer(timer); timer = null; },
    /** Encrypted backup: the wrapped keys plus every record envelope exactly as stored, and a manifest MAC over the sorted list. Nothing readable. */
    async exportBackup() {
      const s = live(), m = await needMeta(), keys = (await raw.list()).filter(isEnv).sort(), records = [];
      for (const k of keys) { const env = await raw.get(k); await open(s, k, env); records.push({ sk: k, env }); } // refuses to back up something that does not verify
      const body = { backupVersion: 1, createdAt: new Date(now()).toISOString(), meta: m, count: records.length };
      const mac = b64(new Uint8Array(await S().sign('HMAC', s.idKey, te.encode(JSON.stringify([body.backupVersion, m.vaultId, records.map(r => [r.sk, r.env.iv, r.env.ct])])))));
      return { ...body, records, manifestMac: mac };
    },
    /** Restores a backup into an EMPTY raw store after checking it: the password opens it, every record verifies, the count and manifest match. Writes records first and the metadata last, so an interrupted restore leaves no half-vault that opens. */
    async restoreBackup(backup, password, { replace = false } = {}) {
      if (!backup || backup.backupVersion !== 1 || !backup.meta || !Array.isArray(backup.records)) throw new VaultError('This is not an InvoiceGuard backup.', 'BAD_BACKUP');
      if (session) throw new VaultError('Lock the current vault before restoring.', 'BUSY');
      if (!replace && (await raw.get(META_KEY) || (await raw.list()).some(isEnv))) throw new VaultError('This workspace already holds data. Delete it first, or confirm that the backup replaces it.', 'NOT_EMPTY');
      const m = backup.meta; if (m.v !== VAULT_VERSION) throw new VaultError('The backup was written by another version.', 'UNSUPPORTED_VERSION');
      let secret; try { secret = await ungcm(await kdfBits(String(password), unb64(m.kdf.salt), m.kdf.iterations), unb64(m.pw.iv), wrapAad(m.vaultId, 'pw'), unb64(m.pw.ct)); } catch { throw new VaultError('That password does not open this backup.', 'WRONG_PASSWORD'); }
      const s = await openSession(secret, m.vaultId);
      if (backup.count !== backup.records.length) throw new VaultError('The backup is incomplete: the record count does not match.', 'CORRUPT');
      const mac = b64(new Uint8Array(await S().sign('HMAC', s.idKey, te.encode(JSON.stringify([backup.backupVersion, m.vaultId, backup.records.map(r => [r.sk, r.env?.iv, r.env?.ct])])))));
      if (mac !== backup.manifestMac) throw new VaultError('The backup was changed or is incomplete (the manifest does not match).', 'CORRUPT');
      for (const r of backup.records) { if (!isEnv(r.sk)) throw new VaultError('The backup holds an unexpected record.', 'CORRUPT'); const pt = await open(s, r.sk, r.env); if (r.sk !== await storageKey(s, pt.k)) throw new VaultError('A record in the backup does not belong to its key.', 'CORRUPT'); }
      if (replace) await api.destroy();
      for (const r of backup.records) await raw.put(r.sk, r.env);
      await raw.put(META_KEY, m); return { records: backup.records.length, vaultId: m.vaultId };
    },
    /** For migration and tests only: the raw store is exposed read-only through these two calls so callers can see what is persisted. */
    raw,
  };
  void vaultIdCache;
  return api;
}

/** Wraps any adapter {put,get,list,clear} so it also has del(). The memory and IndexedDB adapters get it here. */
export const withDelete = (a, del) => ({ ...a, del: del ?? (async () => { throw new VaultError('This storage cannot delete one record.'); }) });
