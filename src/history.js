// Local history (contract section 6). History on THIS device only. It is not monitoring: while the browser is closed nothing is watched.
// Pure module: storage goes through an adapter (IndexedDB in the browser, memory in tests). Optional encryption uses Web Crypto
// (PBKDF2 -> AES-GCM). The passphrase is never stored and cannot be recovered. Browsers may clear site data on their own,
// so the Evidence Bundle export is the durable copy.
import { reconcile, evidenceLog, CONTRACT_LABEL } from './reconcile.js';

export const memoryAdapter = () => { const m = new Map(); return { async put(k, v) { m.set(k, v); }, async get(k) { return m.get(k) ?? null; }, async list() { return [...m.keys()]; }, async del(k) { m.delete(k); }, async clear() { m.clear(); } }; };

/** IndexedDB adapter (browser only). One object store, string keys. */
export const indexedDbAdapter = (name) => {
  if (!name) throw new Error('indexedDbAdapter needs an explicit database name');
  const open = () => new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', mode), out = fn(t.objectStore('kv')); t.oncomplete = () => { db.close(); res(out.result); }; t.onerror = () => { db.close(); rej(t.error); }; }); };
  return { put: (k, v) => tx('readwrite', s => s.put(v, k)), get: async (k) => (await tx('readonly', s => s.get(k))) ?? null, list: () => tx('readonly', s => s.getAllKeys()), del: (k) => tx('readwrite', s => s.delete(k)), clear: () => tx('readwrite', s => s.clear()) };
};

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => { let s = ''; u8.forEach(x => s += String.fromCharCode(x)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function keyFrom(pass, salt) { const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
export async function sha256Hex(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join(''); }

export function createHistory(adapter, { passphrase = null } = {}) {
  const seal = async (obj) => {
    const json = JSON.stringify(obj); if (!passphrase) return { enc: false, data: json };
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), key = await keyFrom(passphrase, salt);
    return { enc: true, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(json)))) };
  };
  const open = async (rec) => {
    if (!rec) return null; if (!rec.enc) return JSON.parse(rec.data);
    if (!passphrase) throw new Error('This history is encrypted: a passphrase is needed.');
    try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, await keyFrom(passphrase, unb64(rec.salt)), unb64(rec.data)))); } catch { throw new Error('Wrong passphrase, or the stored data was changed.'); }
  };
  return {
    /** Store one import: the raw text, its hash, and what the seller declared. */
    async addImport(imp) { const sha256 = imp.sha256 ?? await sha256Hex(imp.text); const rec = { ...imp, sha256, importedAt: imp.importedAt ?? new Date().toISOString() }; await adapter.put('import:' + rec.id, await seal(rec)); return rec; },
    async imports() { const out = []; for (const k of (await adapter.list()).filter(k => String(k).startsWith('import:')).sort()) out.push(await open(await adapter.get(k))); return out; },
    async reconcile() { const imports = await this.imports(); return { imports, result: reconcile(imports) }; },
    /** Exportable Evidence Bundle: imports (with raw text and hashes), the declarations, the result, and one evidence log per ACCEPTED document. */
    async evidenceBundle() {
      const { imports, result } = await this.reconcile();
      return { bundleVersion: 1, contract: CONTRACT_LABEL, createdAt: new Date().toISOString(), note: 'State of the files as loaded, on the dates they were loaded. Settings marked declared were declared by the seller and not verified by InvoiceGuard.',
        imports: imports.map(i => ({ id: i.id, fileName: i.fileName ?? null, sha256: i.sha256, importedAt: i.importedAt, declared: i.declared, text: i.text })), importSummaries: result.imports, headline: result.headline, documents: result.docs.map(d => ({ key: d.key, state: d.state, rawStatus: d.rawStatus, explanation: d.explanation, history: d.history, anomalies: d.anomalies })),
        evidenceLogs: result.docs.map(d => evidenceLog(d, imports, result.imports)).filter(x => x !== null) };
    },
    /** Deletes everything this page stored on this device. */
    async deleteEverything() { await adapter.clear(); },
  };
}
