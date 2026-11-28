// Proof harness for swarm/t9-background-jobs. Synthetic data only. Real server in a child process, real HTTP.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HEAD = ['order-id','order-item-id','shipping-id','fulfilled-by','order-date','marketplace-id','recipient-name','buyer-name','ship-country','shipment-date','billing-name','bill-address-1','bill-city','bill-postal-code','bill-country','ship-from-country','sku','product-name','quantity-purchased','currency','item-vat-incl-amount','item-vat-amount','item-vat-excl-amount','item-vat-rate','shipping-vat-incl-amount','shipping-vat-amount','shipping-vat-excl-amount','shipping-vat-rate','transaction-id','transaction-type','is-amazon-invoiced','invoice-status','is-business-order','seller-vat-number','buyer-vat-number','buyer-company-name','buyer-tax-registration-type','citation-es'];
export const rowOf = (i, over = {}, tag = '405') => { const id = String(i);
  const r = {'order-id':`${tag}-${id}-7710365`,'order-item-id':'','shipping-id':'S'+tag+id,'fulfilled-by':'MFN','order-date':'','marketplace-id':'ES','recipient-name':'','buyer-name':'','ship-country':'ES','shipment-date':'2026-11-24T08:00:00Z','billing-name':'Buyer SL '+id,'bill-address-1':'Calle Mayor 12','bill-city':'Valencia','bill-postal-code':'46001','bill-country':'ES','ship-from-country':'ES',sku:'SKU-A','product-name':'Cable HDMI 2.1 2m','quantity-purchased':'2',currency:'EUR','item-vat-incl-amount':'48.40','item-vat-amount':'8.40','item-vat-excl-amount':'40.00','item-vat-rate':'0.21','shipping-vat-incl-amount':'6.05','shipping-vat-amount':'1.05','shipping-vat-excl-amount':'5.00','shipping-vat-rate':'0.21','transaction-id':'S'+tag+id,'transaction-type':'SHIPMENT','is-amazon-invoiced':'FALSE','invoice-status':'InvoicePending','is-business-order':'TRUE','seller-vat-number':'ESB11111119','buyer-vat-number':'ESB12345674','buyer-company-name':'Buyer SL '+id,'buyer-tax-registration-type':'VAT','citation-es':'',...over};
  return HEAD.map(h => r[h]).join('\t'); };
// mix: ~90% issuable, 5% unknown business flag (held), 5% FALSE flag (skipped/not B2B)
export const vidrOf = (n, start = 1000000, tag = '405', mix = true) => [HEAD.join('\t'), ...Array.from({ length: n }, (_, i) => rowOf(start + i, mix && i % 20 === 7 ? { 'is-business-order': '' } : mix && i % 20 === 13 ? { 'is-business-order': 'FALSE' } : {}, tag))].join('\n');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function startServer({ dbFile, port, env = {}, log }) {
  const p = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'proof/server.mjs')], { env: { ...process.env, DB_FILE: dbFile, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  p.getLog = () => out; return new Promise((ok, bad) => { const t0 = Date.now(); const iv = setInterval(() => { if (out.includes('UP ')) { clearInterval(iv); ok(p); } else if (p.exitCode !== null || Date.now() - t0 > 20000) { clearInterval(iv); bad(new Error('server did not start: ' + out)); } }, 50); });
}
export function client(base) { let cookie = '';
  const call = async (p, body) => { const t0 = performance.now(); try { const r = await fetch(base + '/api/' + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, ms: performance.now() - t0, body: await r.json().catch(() => null) }; } catch (e) { return { status: 0, ms: performance.now() - t0, err: String(e.cause?.code ?? e.message), body: null }; } };
  return call; }
export async function signup(base, email) { const call = client(base);
  await call('signup', { email, password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda ' + email, nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { manual: true }); return call; }
export const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
export function readSamples(file) { if (!existsSync(file)) return []; return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
// HTTP probe: GET /api/me every `ms` for as long as stop() is false; records client-observed latency.
export function startProbe(call, ms = 50) { const lat = []; let run = true; const done = (async () => { while (run) { const r = await call('me'); lat.push({ t: Date.now(), ms: r.ms, status: r.status }); await sleep(ms); } })(); return { stop: async () => { run = false; await done; return lat; } }; }
export const rss = pid => { try { return +readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1] / 1024; } catch { return null; } };
