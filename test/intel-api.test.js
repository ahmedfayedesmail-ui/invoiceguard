import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function persistentSetup(t) {
  const dir=mkdtempSync(join(tmpdir(),'invoiceguard-intel-api-'));
  const dbPath=join(dir,'seller.db');
  const db=openDb(dbPath);
  const env={...process.env,DB_FILE:dbPath};
  const {server}=createApp({db,secret:'intel-api-test-secret',env});
  await new Promise(resolve=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  const call=async(path,body,options={})=>{
    const method=options.method??(body===undefined?'GET':'POST');
    const headers={cookie,origin:base,...(body===undefined?{}:{'content-type':'application/json'}),...(options.headers??{})};
    const response=await fetch(base+'/api/'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const setCookie=response.headers.get('set-cookie');
    if(setCookie)cookie=setCookie.split(';')[0];
    const contentType=response.headers.get('content-type')??'';
    const result=contentType.includes('json')?await response.json():await response.text();
    return {status:response.status,body:result,headers:response.headers};
  };
  t.after(async()=>{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
    db.close();
    rmSync(dir,{recursive:true,force:true});
  });
  assert.equal((await call('signup',{email:'intel-seller@example.test',password:'Long-Enough-Pw-42!'})).status,200);
  assert.equal((await call('seller',{name:'Evidence Seller S.L.',nif:'ESB11111119',address:'Calle Test 1',marketplaces:['ES']})).status,200);
  const sellerId=db.prepare('SELECT seller_id FROM users WHERE email=?').get('intel-seller@example.test').seller_id;
  db.prepare('INSERT INTO shipments (seller_id,key,order_id,shipping_id,total,vat,shipment_date,due_at,status,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(sellerId,'SHIP-INTEL-1','ORDER-INTEL-1','SHIP-INTEL-1',59.90,9.90,'2026-11-28','2026-12-28','open','test fixture','2026-11-28T10:01:00.000Z');
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)')
    .run(sellerId,'A-2026-000001','SHIP-INTEL-1','invoice','2026-11-28T10:00:00.000Z',59.90,9.90,'ready');
  db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)')
    .run(sellerId,'SHIP-INTEL-1','AMOUNT_MISMATCH','total','opened','fp-intel-api','2026-11-28T10:02:00.000Z');
  db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)')
    .run('2026-11-28T10:03:00.000Z',sellerId,'invoice_created',JSON.stringify({number:'A-2026-000001',shipmentKey:'SHIP-INTEL-1'}));
  return {db,call,sellerId};
}

test('authenticated seller can explicitly seal, view and export advisory evidence without changing financial rows',async t=>{
  const {db,call,sellerId}=await persistentSetup(t);
  const invoicesBefore=db.prepare('SELECT * FROM invoices WHERE seller_id=?').all(sellerId);
  const shipmentsBefore=db.prepare('SELECT * FROM shipments WHERE seller_id=?').all(sellerId);
  const first=await call('intel/seal',{sellerId:'attacker-selected-seller'});
  assert.equal(first.status,200);
  assert.equal(first.body.head.sellerId,sellerId,'the authenticated seller scope overrides any submitted seller ID');
  assert.equal(first.body.coverage.status,'UNKNOWN');
  assert.equal(first.body.authority,'ADVISORY_ONLY');
  assert.equal(first.body.changesFinancialState,false);

  const timeline=await call('intel/timeline?number=A-2026-000001');
  assert.equal(timeline.status,200);
  assert.deepEqual(timeline.body.relatedShipmentKeys,['SHIP-INTEL-1']);
  assert.ok(timeline.body.events.some(event=>event.kind==='invoice_snapshot'));
  assert.ok(timeline.body.events.some(event=>event.kind==='integrity_transition'));
  assert.ok(timeline.body.events.some(event=>event.kind==='shipment_snapshot'));
  assert.equal(timeline.body.checkpoint.hash,first.body.head.hash);
  assert.equal(timeline.body.authority,'ADVISORY_ONLY');

  const bundle=await call('intel/export');
  assert.equal(bundle.status,200);
  assert.equal(bundle.headers.get('content-type').includes('application/json'),true);
  assert.equal(bundle.headers.get('x-invoiceguard-checkpoint'),bundle.body.checkpoint.hash);
  assert.equal(bundle.body.description.includes('does not authenticate'),true);

  const repeat=await call('intel/seal',{});
  assert.equal(repeat.status,200);
  assert.equal(repeat.body.added,0,'repeat seal is idempotent when the source snapshot has not changed');
  assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE seller_id=?').all(sellerId),invoicesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM shipments WHERE seller_id=?').all(sellerId),shipmentsBefore);
});

test('evidence endpoints remain behind seller authentication and memory databases fail closed',async t=>{
  const memory=createApp({secret:'intel-memory-test-secret'});
  await new Promise(resolve=>memory.server.listen(0,resolve));
  const base=`http://127.0.0.1:${memory.server.address().port}`;
  try{
    const unauth=await fetch(base+'/api/intel/seal',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(unauth.status,401);
    const signup=await fetch(base+'/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'memory-seller@example.test',password:'Long-Enough-Pw-42!'})});
    assert.equal(signup.status,200);
    const cookie=signup.headers.get('set-cookie').split(';')[0];
    const seller=await fetch(base+'/api/seller',{method:'POST',headers:{'content-type':'application/json',cookie,origin:base},body:JSON.stringify({name:'Memory Seller S.L.',nif:'ESB11111119',address:'Calle Test 2',marketplaces:['ES']})});
    assert.equal(seller.status,200);
    const result=await fetch(base+'/api/intel/seal',{method:'POST',headers:{'content-type':'application/json',cookie,origin:base},body:'{}'});
    assert.equal(result.status,503);
    assert.equal((await result.json()).code,'PERSISTENT_DATABASE_REQUIRED');
  }finally{
    memory.server.closeAllConnections?.();
    await new Promise(resolve=>memory.server.close(resolve));
    memory.db.close();
  }
});
