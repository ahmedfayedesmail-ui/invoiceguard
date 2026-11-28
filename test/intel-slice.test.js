import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import {
  openIntelReader, sealSellerEvidence, verifyEvidenceChain, getEvidenceCoverage,
  exportEvidenceBundle, verifyEvidenceBundle, buildDocumentTimeline
} from '../src/intel/store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'invoiceguard-intel-'));
  const path = join(dir, 'seller.db');
  const db = openDb(path);
  db.prepare('INSERT INTO sellers (id,name,created_at) VALUES (?,?,?)').run('seller-A','Test Seller','2026-11-28T10:00:00.000Z');
  db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)')
    .run('2026-11-28T10:01:00.000Z','seller-A','invoice_created',JSON.stringify({number:'A-2026-000001',status:'ready',reason:'private free text'}));
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)')
    .run('seller-A','A-2026-000001','SHIP-1','invoice','2026-11-28T10:00:00.000Z',59.90,9.90,'ready');
  t.after(()=>{ try{db.close()}catch{}; rmSync(dir,{recursive:true,force:true}); });
  return {db,path};
}
function runWorker(path,sellerId) {
  return new Promise((resolvePromise,reject)=>{
    const p=spawn(process.execPath,[resolve('test/intel-seal-worker.mjs'),path,sellerId],{stdio:['ignore','pipe','pipe']});
    let out='',err=''; p.stdout.on('data',x=>out+=x); p.stderr.on('data',x=>err+=x);
    p.on('error',reject); p.on('close',code=>code===0?resolvePromise(JSON.parse(out)):reject(new Error(err||('worker exited '+code))));
  });
}

test('seal is deterministic and idempotent; bundle verifies; financial tables remain unchanged', t => {
  const {db,path}=fixture(t), reader=openIntelReader(path); t.after(()=>reader.close());
  const before=db.prepare('SELECT * FROM invoices WHERE seller_id=?').all('seller-A');
  const a=sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  assert.ok(a.added>=3);
  assert.equal(a.coverage.status,'UNKNOWN');
  assert.equal(verifyEvidenceChain(db,'seller-A').valid,true);
  assert.equal(getEvidenceCoverage(db,'seller-A').status,'UNKNOWN');
  const bundle=exportEvidenceBundle(db,'seller-A');
  assert.equal(verifyEvidenceBundle(bundle).valid,true);
  assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE seller_id=?').all('seller-A'),before);
  const b=sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  assert.equal(b.added,0,'identical source snapshots must not create duplicate chain entries');
  assert.deepEqual(b.head,a.head);
  assert.equal(bundle.chain.some(x=>x.kind==='coverage_statement'),true);
  assert.equal(bundle.chain.some(x=>x.canonicalJson.includes('private free text')),false,'free text is represented by a digest');
});

test('reader is read-only and sealed chain rows cannot be updated or deleted', t => {
  const {db,path}=fixture(t), reader=openIntelReader(path); t.after(()=>reader.close());
  assert.throws(()=>reader.exec("INSERT INTO events (ts,seller_id,type,detail) VALUES ('x','seller-A','x','{}')"),/readonly|query.only/i);
  sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  assert.throws(()=>db.exec("UPDATE intel_evidence_chain SET kind='forged' WHERE seller_id='seller-A'"),/append-only/i);
  assert.throws(()=>db.exec("DELETE FROM intel_evidence_chain WHERE seller_id='seller-A'"),/append-only/i);
});

test('a changed invoice snapshot is appended to its document timeline', t => {
  const {db,path}=fixture(t), reader=openIntelReader(path); t.after(()=>reader.close());
  sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  db.prepare("UPDATE invoices SET upload_status='uploaded', feed_id='feed-1' WHERE seller_id=? AND number=?").run('seller-A','A-2026-000001');
  const later=sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  assert.ok(later.added>=1);
  const timeline=buildDocumentTimeline(db,'seller-A','A-2026-000001');
  assert.ok(timeline.events.length>=2);
  assert.match(timeline.trajectoryDigest,/^[a-f0-9]{64}$/);
});

test('external checkpoint detects a truncated export and a modified entry', t => {
  const {db,path}=fixture(t), reader=openIntelReader(path); t.after(()=>reader.close());
  sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  const bundle=exportEvidenceBundle(db,'seller-A');
  const short={...bundle,chain:bundle.chain.slice(0,-1)};
  assert.equal(verifyEvidenceBundle(short,{checkpoint:bundle.checkpoint}).valid,false);
  const modified={...bundle,chain:bundle.chain.map(x=>({...x}))};
  modified.chain[0].canonicalJson=modified.chain[0].canonicalJson.replace('seller-A','seller-B');
  assert.equal(verifyEvidenceBundle(modified).valid,false);
});

test('deletion of a previously sealed append-only source row is marked INCOMPLETE', t => {
  const {db,path}=fixture(t), reader=openIntelReader(path); t.after(()=>reader.close());
  db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)')
    .run('seller-A','SHIP-1','AMOUNT_MISMATCH','total','opened','fingerprint-1','2026-11-28T10:02:00.000Z');
  sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  db.exec('DROP TRIGGER integrity_history_no_delete');
  db.prepare('DELETE FROM integrity_history WHERE seller_id=? AND shipment_key=?').run('seller-A','SHIP-1');
  const result=sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  assert.equal(result.coverage.status,'INCOMPLETE');
  assert.ok(result.coverage.missingPreviouslySealed.length>=1);
  assert.equal(getEvidenceCoverage(db,'seller-A').status,'INCOMPLETE');
});

test('a corrupted prior chain is refused rather than silently extended', t => {
  const {db,path}=fixture(t), reader=openIntelReader(path); t.after(()=>reader.close());
  sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'});
  db.exec('DROP TRIGGER intel_chain_no_update');
  db.prepare("UPDATE intel_evidence_chain SET entry_hash=? WHERE seller_id=? AND seq=1")
    .run('f'.repeat(64),'seller-A');
  assert.equal(verifyEvidenceChain(db,'seller-A').valid,false);
  assert.throws(
    () => sealSellerEvidence({writerDb:db,readerDb:reader,sellerId:'seller-A'}),
    /Refusing to append to a broken evidence chain/
  );
});

test('two independent processes sealing one seller produce one ordered chain', async t => {
  const {db,path}=fixture(t);
  db.close();
  const results=await Promise.all([runWorker(path,'seller-A'),runWorker(path,'seller-A')]);
  const check=new DatabaseSync(path,{readOnly:true,timeout:5000});
  t.after(()=>check.close());
  const head=check.prepare('SELECT seq,hash FROM intel_evidence_head WHERE seller_id=?').get('seller-A');
  const rows=check.prepare('SELECT seq FROM intel_evidence_chain WHERE seller_id=? ORDER BY seq').all('seller-A');
  assert.equal(rows.length,head.seq);
  assert.deepEqual(rows.map(x=>x.seq),Array.from({length:rows.length},(_,i)=>i+1));
  assert.equal(results.reduce((n,x)=>n+x.added,0),rows.length);
  assert.equal(verifyEvidenceChain(check,'seller-A').valid,true);
});
