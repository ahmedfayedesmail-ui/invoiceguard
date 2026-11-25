import { openDb, logEvent, verifyAudit } from '/downloads/invoicetool/src/db.js';
import * as F from '/downloads/invoicetool/src/features.js';
import { unlinkSync } from 'node:fs';
const db = openDb('/tmp/big.db'); const sid = 'S1';
db.exec("CREATE TABLE IF NOT EXISTS audit (x)"); 
const t0 = performance.now(); db.exec('BEGIN');
const ins = db.prepare('INSERT INTO shipments (seller_id,key,order_id,shipping_id,buyer_vat,buyer,country,total,vat,shipment_date,due_at,status,reason,raw,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for (let i = 0; i < 20000; i++) ins.run(sid, 'k' + i, 'o' + i, 's' + i, 'DE123456789', 'Buyer ' + i, 'DE', 100, 21, `2026-0${1 + i % 9}-1${i % 9}`, '2026-12-01', ['uploaded', 'held', 'detected'][i % 3], null, '{}', 'x');
db.exec('COMMIT'); console.log('insert 20k shipments ms', (performance.now() - t0).toFixed(0));
console.log('events/audit exports:', Object.keys(F).filter(k => /audit|radar|alerts/i.test(k)).join(','));
for (const [n, f] of [['radar', () => F.radar(db, { id: sid, country: 'ES', marketplace_ids: '["ES"]' })], ['listAlerts', () => F.listAlerts(db, { id: sid })]]) { try { const t = performance.now(); f(); console.log(n, 'ms', (performance.now() - t).toFixed(1)); } catch (e) { console.log(n, 'err', e.message.slice(0, 80)); } }
const t1 = performance.now(); db.prepare("SELECT count(*) total, sum(status='uploaded') u FROM shipments WHERE seller_id=?").get(sid); console.log('kpi query ms', (performance.now() - t1).toFixed(1));
const t2 = performance.now(); db.prepare('SELECT key FROM shipments WHERE seller_id=? ORDER BY shipment_date DESC, key LIMIT 500').all(sid); console.log('list 500 ms', (performance.now() - t2).toFixed(1));
for (let i = 0; i < 5000; i++) logEvent(db, sid, 'x', { i });
const t3 = performance.now(); try { verifyAudit(db, sid); } catch (e) { console.log(e.message); } console.log('verifyAudit(empty chain) ms', (performance.now() - t3).toFixed(1));
