import { spawn } from 'node:child_process';
import { client } from './lib.mjs';
import { vidrReport } from './gen.mjs';
const PORT = 4398, DB = '/tmp/probe-cap.db';
const call = client(PORT);
for (const s of ['', '-wal', '-shm']) { try { (await import('node:fs')).rmSync(DB + s); } catch {} }
const srv = spawn(process.execPath, ['server.mjs'], { cwd: '/home/sandbox/ig-http-audit', env: { ...process.env, APP_ROOT: '/home/sandbox/ig-http-audit/../invoiceguard', DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
for (let i = 0; i < 60; i++) { const r = await call('GET', '/api/me'); if (r.status) break; await new Promise(r2 => setTimeout(r2, 100)); }
const r = await call('POST', '/api/signup', { body: { email: 'p@audit.example', password: 'Audit-Pass-2026!' } });
const cookie = (r.headers['set-cookie'] ?? [''])[0].split(';')[0];
await call('POST', '/api/seller', { cookie, body: { name: 'P S.L.', nif: 'B12345674', address: 'Calle 1', country: 'ES', marketplaces: ['ES'] } });
await call('POST', '/api/amazon/connect', { cookie, body: { manual: true } });
const bodyOf = (targetUnits, char, seed) => { let padTo = targetUnits - 300; let text = vidrReport(5, 4, seed, { padTo, padChar: char }); for (let i = 0; i < 8; i++) { const u = JSON.stringify({ text }).length; if (u === targetUnits) break; padTo += Math.round((targetUnits - u) / (char.length > 1 ? 2 : 1)); text = vidrReport(5, 4, seed, { padTo, padChar: char }); } return text; };
for (const [name, units, ch] of [['arabic_4M', 4000000, '\u0627'], ['arabic_5_5M', 5500000, '\u0627'], ['arabic_5_9M', 5900000, '\u0627'], ['arabic_5_99M', 5990000, '\u0627'], ['arabic_6M', 6000000, '\u0627'], ['emoji_5_5M_units', 5500000, '\u{1F600}'], ['emoji_5_99M_units', 5990000, '\u{1F600}']]) {
  const text = bodyOf(units, ch, 30 + units % 7);
  const res = await call('POST', '/api/manual/preview', { cookie, body: { text }, timeout: 120000 });
  console.log(JSON.stringify({ name, units: JSON.stringify({ text }).length, bytes: Buffer.byteLength(JSON.stringify({ text })), status: res.status, ms: Math.round(res.ms) }));
}
srv.kill('SIGTERM');
