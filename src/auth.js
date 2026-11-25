import { scrypt, scryptSync, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
export const hashPw = (pw, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(pw, salt, 64).toString('hex') });
export const checkPw = (pw, salt, hash) => { const a = Buffer.from(scryptSync(pw, salt, 64).toString('hex')), b = Buffer.from(hash); return a.length === b.length && timingSafeEqual(a, b); };
const key = (secret) => createHash('sha256').update(secret).digest();
export function encrypt(obj, secret) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(secret), iv); const enc = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]); return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.'); }
export function decrypt(s, secret) { const [iv, tag, enc] = s.split('.').map(x => Buffer.from(x, 'base64')); const d = createDecipheriv('aes-256-gcm', key(secret), iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString()); }
export const newToken = () => randomBytes(32).toString('hex');

// Password hashing runs on libuv's thread pool, never on the request loop, behind a bounded queue.
// scrypt parameters are unchanged (Node defaults), so existing hashes still verify.
const MAX_PARALLEL = Number(process.env.HASH_PARALLEL ?? 2), MAX_QUEUE = Number(process.env.HASH_QUEUE ?? 400);
let running = 0; const waiting = [];
export class Busy extends Error { constructor() { super('The server is busy. Please try again in a few seconds.'); this.busy = true; } }
const derive = (pw, salt) => new Promise((ok, no) => scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k.toString('hex'))));
function slot() { if (running < MAX_PARALLEL) { running++; return Promise.resolve(); } if (waiting.length >= MAX_QUEUE) return Promise.reject(new Busy()); return new Promise(r => waiting.push(r)); }
function release() { const n = waiting.shift(); if (n) n(); else running--; }
async function limited(fn) { await slot(); try { return await fn(); } finally { release(); } }
export const hashPwAsync = (pw, salt = randomBytes(16).toString('hex')) => limited(async () => ({ salt, hash: await derive(pw, salt) }));
export const checkPwAsync = (pw, salt, hash) => limited(async () => { const a = Buffer.from(await derive(pw, salt)), b = Buffer.from(hash); return a.length === b.length && timingSafeEqual(a, b); });
export const hashQueueStats = () => ({ running, queued: waiting.length });
