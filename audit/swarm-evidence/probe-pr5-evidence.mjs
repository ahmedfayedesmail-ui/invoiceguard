// Read-only repro probes for PR #5 sealed evidence (run against a PR #5 checkout: PR5_DIR=/path/to/pr5 node --no-warnings this.mjs). Uses temp DBs and synthetic data only.
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const R=(process.env.PR5_DIR||process.cwd());const {pathToFileURL}=await import('node:url');const imp=f=>import(pathToFileURL(R+'/'+f).href);
const {openDb}=await imp('src/db.js');
const { openIntelReader, sealSellerEvidence, verifyEvidenceChain, exportEvidenceBundle, verifyEvidenceBundle, buildDocumentTimeline, getEvidenceCoverage } = await imp('src/intel/store.js');
const mk=()=>{const dir=mkdtempSync(join(tmpdir(),'p-'));const path=join(dir,'s.db');const db=openDb(path);db.prepare('INSERT INTO sellers (id,name,created_at) VALUES (?,?,?)').run('S','S','2026-11-28T10:00:00Z');return{db,path,dir}};
const seal=(db,path)=>{const r=openIntelReader(path);try{return sealSellerEvidence({writerDb:db,readerDb:r,sellerId:'S'})}finally{r.close()}};
const addInv=(db,n)=>db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)').run('S',n,'SH1','invoice','2026-11-28T10:00:00Z',10,1.5,'ready');
const addEv=(db,i)=>db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)').run('2026-11-28T10:'+String(i).padStart(2,'0')+':00Z','S','ev',JSON.stringify({invoiceNumber:"INV1",code:i}));
// P1 retained checkpoint vs legitimate growth
{const {db,path}=mk();addInv(db,'INV1');const a=seal(db,path);const cp=a.head;
 addEv(db,1);const b=seal(db,path);const bundle=exportEvidenceBundle(db,'S');
 const v=verifyEvidenceBundle(bundle,{checkpoint:cp});
 console.log('P1 old retained checkpoint seq',cp.sequence,'new chain seq',b.head.sequence,'->',JSON.stringify(v));
 const c=verifyEvidenceChain(db,'S',cp);console.log('P1b verifyEvidenceChain with older checkpoint',JSON.stringify(c));}
// P2 event order inside a single seal
{const {db,path}=mk();addInv(db,'INV1');for(let i=1;i<=12;i++)addEv(db,i);seal(db,path);
 const t=buildDocumentTimeline(db,'S','INV1');console.log('P2 event n order in timeline:',t.events.filter(e=>e.kind==='seller_or_system_event').map(e=>e.payload.references.code).join(','));}
// P3 rowid reuse: delete newest event then insert a different one
{const {db,path}=mk();addInv(db,'INV1');addEv(db,1);addEv(db,2);seal(db,path);
 db.prepare('DELETE FROM events WHERE rowid=(SELECT max(rowid) FROM events)').run();addEv(db,99);
 const r=seal(db,path);console.log('P3 after delete+insert(reused rowid) coverage:',r.coverage.status,'missingMutable',r.coverage.missingMutableSnapshots.length,'reasons',JSON.stringify(r.coverage.reasons));
 console.log('   rowids now',JSON.stringify(db.prepare('SELECT rowid,detail FROM events').all()));}
// P4 VACUUM renumbering rowids
{const {db,path}=mk();addInv(db,'INV1');for(let i=1;i<=3;i++)db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run('S','SH1','C','f','opened','fp'+i,'2026-11-28T10:0'+i+':00Z');
 seal(db,path);db.exec('DELETE FROM integrity_history WHERE 0');
 // create a rowid hole then vacuum is only observable if rows were deleted; append-only trigger blocks delete, so test events instead
 addEv(db,1);addEv(db,2);addEv(db,3);const s1=seal(db,path);
 console.log('P4 (append-only logs cannot be deleted so VACUUM renumbering needs a gap; events only) status',s1.coverage.status);
 db.exec('DROP TABLE IF EXISTS tmp');}
// P5 epistemic: tamper -> coverage label
{const {db,path}=mk();addInv(db,'INV1');seal(db,path);
 db.exec('DROP TRIGGER intel_chain_no_update');db.exec("UPDATE intel_evidence_chain SET canonical_json=canonical_json||' ' WHERE seq=1");
 console.log('P5 tampered chain coverage label:',JSON.stringify(getEvidenceCoverage(db,'S')));}
