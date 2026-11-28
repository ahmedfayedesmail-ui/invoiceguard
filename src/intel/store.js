import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256Hex } from './canonical.js';
import { normalizeEvidenceTimeline, trajectoryDigest } from './timeline.js';

const ZERO = '0'.repeat(64);
const APPEND_ONLY = ['integrity_history', 'integrity_decisions', 'credit_claim_history'];
const MUTABLE_SOURCES = ['events', 'invoices', 'shipments', 'integrity_findings'];

export function openIntelReader(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') throw new TypeError('A file-backed SQLite database is required.');
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  if (db.prepare('PRAGMA query_only').get().query_only !== 1) { db.close(); throw new Error('Could not establish query_only reader.'); }
  return db;
}
function exists(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function triggerExists(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)); }
export function ensureIntelTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intel_evidence_chain (
      seller_id TEXT NOT NULL, seq INTEGER NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL,
      kind TEXT NOT NULL, source_ref TEXT NOT NULL, document_key TEXT, canonical_json TEXT NOT NULL, sealed_at TEXT NOT NULL,
      PRIMARY KEY(seller_id, seq), UNIQUE(seller_id, source_ref)
    );
    CREATE TABLE IF NOT EXISTS intel_evidence_head (seller_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hash TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS intel_chain_no_update BEFORE UPDATE ON intel_evidence_chain
      BEGIN SELECT RAISE(ABORT, 'intel evidence chain is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS intel_chain_no_delete BEFORE DELETE ON intel_evidence_chain
      BEGIN SELECT RAISE(ABORT, 'intel evidence chain is append-only'); END;
  `);
}
const digest = value => sha256Hex(String(value ?? ''));
const safeText = (value, max=180) => value == null ? null : String(value).slice(0,max);
function cents(value, field) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n*100);
  if (!Number.isSafeInteger(c)) throw new RangeError(`Unsafe money value at ${field}`);
  return c;
}
function parseDetail(raw) {
  try { const value=JSON.parse(raw ?? '{}'); return value && typeof value==='object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function makeRecord(kind, table, key, documentKey, payload) {
  const payloadHash = digest(canonicalize(payload));
  return {kind,sourceTable:table,sourceKey:String(key),sourceRef:`${table}:${key}:${payloadHash}`,
    documentKey:documentKey==null?null:String(documentKey),payload};
}
function snapshotSources(reader, sellerId) {
  const out=[];
  const read=(table,sql,map)=>{
    if(!exists(reader,table)) return;
    for(const row of reader.prepare(sql).all(sellerId)){
      const item=map(row);
      out.push(makeRecord(item.kind,table,item.key,item.documentKey,item.payload));
    }
  };
  read('events','SELECT rowid AS k, ts, type, detail FROM events WHERE seller_id=? ORDER BY rowid',r=>{
    const d=parseDetail(r.detail), refs={};
    for(const k of ['number','invoiceNumber','originalNumber','feedId','status','result','kind','key','code','field','shipmentKey']){
      const v=d[k];
      if((typeof v==='string' && v.length<=180)||(typeof v==='number'&&Number.isSafeInteger(v))) refs[k]=v;
    }
    return {kind:'seller_or_system_event',key:r.k,documentKey:refs.invoiceNumber??refs.number??refs.originalNumber??refs.shipmentKey??null,
      payload:{occurredAt:safeText(r.ts,64),eventType:safeText(r.type,100),detailDigest:digest(r.detail),references:refs}};
  });
  read('integrity_history','SELECT rowid AS k, shipment_key, code, field, event, fingerprint, at FROM integrity_history WHERE seller_id=? ORDER BY rowid',r=>({
    kind:'integrity_transition',key:r.k,documentKey:r.shipment_key,
    payload:{shipmentKey:safeText(r.shipment_key),code:safeText(r.code,120),field:safeText(r.field,120),transition:safeText(r.event,80),
      fingerprint:safeText(r.fingerprint,128),occurredAt:safeText(r.at,64)}
  }));
  read('integrity_decisions','SELECT rowid AS k, shipment_key, code, field, fingerprint, decided_by, reason, decided_at FROM integrity_decisions WHERE seller_id=? ORDER BY rowid',r=>({
    kind:'recorded_integrity_decision',key:r.k,documentKey:r.shipment_key,
    payload:{shipmentKey:safeText(r.shipment_key),code:safeText(r.code,120),field:safeText(r.field,120),fingerprint:safeText(r.fingerprint,128),
      actorDigest:digest(r.decided_by),reasonDigest:digest(r.reason),occurredAt:safeText(r.decided_at,64)}
  }));
  read('credit_claim_history','SELECT id AS k, reversal_key, original_number, amount, event, claim_id, actor, reason, fingerprint, at FROM credit_claim_history WHERE seller_id=? ORDER BY id',r=>({
    kind:'credit_claim_transition',key:r.k,documentKey:r.original_number,
    payload:{reversalKey:safeText(r.reversal_key),originalNumber:safeText(r.original_number),amountCents:cents(r.amount,'credit_claim_history.amount'),
      event:safeText(r.event,80),claimId:safeText(r.claim_id),actorDigest:digest(r.actor),reasonDigest:digest(r.reason),
      fingerprint:safeText(r.fingerprint,128),occurredAt:safeText(r.at,64)}
  }));
  read('invoices','SELECT number, shipment_key, kind, rectifies, issued_at, total, vat, feed_id, upload_status, uploaded_at, error FROM invoices WHERE seller_id=? ORDER BY number',r=>({
    kind:'invoice_snapshot',key:r.number,documentKey:r.number,
    payload:{invoiceNumber:safeText(r.number),shipmentKey:safeText(r.shipment_key),kind:safeText(r.kind,40),rectifies:safeText(r.rectifies),
      issuedAt:safeText(r.issued_at,64),totalCents:cents(r.total,'invoices.total'),vatCents:cents(r.vat,'invoices.vat'),feedId:safeText(r.feed_id),
      uploadStatus:safeText(r.upload_status,50),uploadedAt:safeText(r.uploaded_at,64),errorDigest:digest(r.error)}
  }));
  read('shipments','SELECT key, order_id, shipping_id, total, vat, shipment_date, due_at, status, reason, updated_at FROM shipments WHERE seller_id=? ORDER BY key',r=>({
    kind:'shipment_snapshot',key:r.key,documentKey:r.key,
    payload:{shipmentKey:safeText(r.key),orderId:safeText(r.order_id),shippingId:safeText(r.shipping_id),totalCents:cents(r.total,'shipments.total'),
      vatCents:cents(r.vat,'shipments.vat'),shipmentDate:safeText(r.shipment_date,64),dueAt:safeText(r.due_at,64),
      status:safeText(r.status,50),reasonDigest:digest(r.reason),updatedAt:safeText(r.updated_at,64)}
  }));
  read('integrity_findings','SELECT rowid AS k, shipment_key, code, field, severity, resolution, status, fingerprint, evidence, explanation, first_seen, last_seen, seen_count, reopened_count, resolved_at FROM integrity_findings WHERE seller_id=? ORDER BY rowid',r=>({
    kind:'integrity_finding_snapshot',key:r.k,documentKey:r.shipment_key,
    payload:{shipmentKey:safeText(r.shipment_key),code:safeText(r.code,120),field:safeText(r.field,120),severity:safeText(r.severity,40),
      resolution:safeText(r.resolution,80),status:safeText(r.status,40),fingerprint:safeText(r.fingerprint,128),
      evidenceDigest:digest(r.evidence),explanationDigest:digest(r.explanation),firstSeen:safeText(r.first_seen,64),lastSeen:safeText(r.last_seen,64),
      seenCount:Number.isSafeInteger(r.seen_count)?r.seen_count:null,reopenedCount:Number.isSafeInteger(r.reopened_count)?r.reopened_count:null,
      resolvedAt:safeText(r.resolved_at,64)}
  }));
  return out.sort((a,b)=>a.sourceTable.localeCompare(b.sourceTable)||a.sourceKey.localeCompare(b.sourceKey)||a.sourceRef.localeCompare(b.sourceRef));
}
function sourceCoverage(reader, sourceCount, {missingPreviouslySealed=[], sourceChangedDuringSeal=false, previousCoverage=null}={}) {
  const protectedLogs = APPEND_ONLY.map(table=>({
    table, updateBlocked:triggerExists(reader,table+'_no_update'), deleteBlocked:triggerExists(reader,table+'_no_delete')
  }));
  const missingProtection = protectedLogs.filter(x=>!x.updateBlocked||!x.deleteBlocked).map(x=>x.table);
  const inheritedMissing = Array.isArray(previousCoverage?.missingPreviouslySealed) ? previousCoverage.missingPreviouslySealed : [];
  const missing = [...new Set([...inheritedMissing,...missingPreviouslySealed])].sort();
  const changed = sourceChangedDuringSeal || previousCoverage?.sourceChangedDuringSeal === true;
  const inheritedIncomplete = previousCoverage?.status === 'INCOMPLETE';
  const reasons = [];
  if (missing.length) reasons.push('A previously sealed append-only source record is no longer present.');
  if (changed) reasons.push('A source snapshot changed during sealing; the run cannot claim a stable observation.');
  if (inheritedIncomplete && !reasons.length) reasons.push('A previous seal recorded an unresolved completeness gap; it is not cleared automatically.');
  return {schema:'invoiceguard.intel-coverage.v1',status:missing.length||changed||inheritedIncomplete?'INCOMPLETE':'UNKNOWN',
    observedRecords:sourceCount,appendOnlyLogProtection:protectedLogs,unprotectedAppendLogs:missingProtection,
    missingPreviouslySealed:missing,sourceChangedDuringSeal:changed,reasons,mutableSources:MUTABLE_SOURCES,
    note:'Coverage begins with rows visible to this sealing process. Mutable events and current invoice, shipment and finding snapshots cannot prove pre-seal history.'};
}
function latestCoverageFromRows(rows) {
  for(let i=rows.length-1;i>=0;i--){
    if(rows[i].kind!=='coverage_statement') continue;
    try { return JSON.parse(rows[i].canonical_json).payload; } catch { return {status:'INCOMPLETE',reasons:['A previous coverage statement is unreadable.']}; }
  }
  return null;
}
function rowsFor(db,sellerId) {
  return db.prepare('SELECT seq,prev_hash,entry_hash,kind,source_ref,document_key,canonical_json FROM intel_evidence_chain WHERE seller_id=? ORDER BY seq').all(sellerId);
}
function verifyRows(rows,sellerId,head=null) {
  let prev=ZERO;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],seq=i+1;
    if(row.seq!==seq) return {valid:false,brokenAt:seq,reason:'sequence-gap'};
    if(row.prev_hash!==prev) return {valid:false,brokenAt:seq,rexport function sealSellerEvidence({writerDb,readerDb,sellerId,now=()=>new Date().toISOString()}) {
  if(!writerDb||!readerDb||writerDb===readerDb)throw new TypeError('Separate writer and read-only reader connections are required.');
  if(readerDb.prepare('PRAGMA query_only').get().query_only!==1)throw new Error('Reader must enforce PRAGMA query_only=ON.');
  if(typeof sellerId!=='string'||!sellerId.trim()||sellerId.length>200)throw new TypeError('A valid seller id is required.');
  ensureIntelTables(writerDb);
  const precheck=verifyEvidenceChain(writerDb,sellerId);
  if(!precheck.valid)throw new Error('Refusing to append to a broken evidence chain: '+precheck.reason);
  const priorRows=rowsFor(writerDb,sellerId);
  const previousCoverage=latestCoverageFromRows(priorRows);
  readerDb.exec('BEGIN'); let source;
  try{source=snapshotSources(readerDb,sellerId);readerDb.exec('COMMIT');}
  catch(e){try{readerDb.exec('ROLLBACK');}catch{}throw e;}
  const sourceRefs=new Set(source.map(x=>x.sourceRef));
  const missingPreviouslySealed=priorRows.filter(row=>{
    if(!APPEND_ONLY.includes(JSON.parse(row.canonical_json).sourceTable)) return false;
    return !sourceRefs.has(row.source_ref);
  }).map(row=>row.source_ref);
  let coverage=sourceCoverage(readerDb,source.length,{missingPreviouslySealed,previousCoverage});
  source.push(makeRecord('coverage_statement','intel_coverage',digest(canonicalize(coverage)),null,coverage));
  let added=0,current;
  writerDb.exec('BEGIN IMMEDIATE');
  try{
    const existing=new Set(rowsFor(writerDb,sellerId).map(r=>r.source_ref));
    current=writerDb.prepare('SELECT seq,hash FROM intel_evidence_head WHERE seller_id=?').get(sellerId)??{seq:0,hash:ZERO};
    const insert=writerDb.prepare('INSERT INTO intel_evidence_chain(seller_id,seq,prev_hash,entry_hash,kind,source_ref,document_key,canonical_json,sealed_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const item of source){
      if(existing.has(item.sourceRef))continue;
      const sequence=current.seq+1;
      const body={schema:'invoiceguard.sealed-financial-evidence.v1',sellerId,sequence,previousHash:current.hash,kind:item.kind,
        sourceTable:item.sourceTable,sourceKey:item.sourceKey,sourceRef:item.sourceRef,documentKey:item.documentKey,payload:item.payload};
      const json=canonicalize(body),hash=digest(json);
      insert.run(sellerId,sequence,current.hash,hash,item.kind,item.sourceRef,item.documentKey,json,now());
      current={seq:sequence,hash};added++;
    }
    writerDb.prepare('INSERT INTO intel_evidence_head(seller_id,seq,hash,updated_at) VALUES(?,?,?,?) ON CONFLICT(seller_id) DO UPDATE SET seq=excluded.seq,hash=excluded.hash,updated_at=excluded.updated_at')
      .run(sellerId,current.seq,current.hash,now());
    writerDb.exec('COMMIT');
  }catch(e){try{writerDb.exec('ROLLBACK');}catch{}throw e;}

  // Take a second consistent source snapshot. Any mid-seal change is an explicit gap, never a false COMPLETE.
  readerDb.exec('BEGIN'); let afterSource;
  try{afterSource=snapshotSources(readerDb,sellerId);readerDb.exec('COMMIT');}
  catch(e){try{readerDb.exec('ROLLBACK');}catch{}throw e;}
  const beforeRefs=source.filter(x=>x.sourceTable!=='intel_coverage').map(x=>x.sourceRef).sort();
  const afterRefs=afterSource.map(x=>x.sourceRef).sort();
  const sourceChangedDuringSeal=canonicalize(beforeRefs)!==canonicalize(afterRefs);
  const afterRefSet=new Set(afterRefs);
  const allSealedRows=rowsFor(writerDb,sellerId);
  const missingAfter=allSealedRows.filter(row=>{
    const body=JSON.parse(row.canonical_json);
    return APPEND_ONLY.includes(body.sourceTable)&&!afterRefSet.has(row.source_ref);
  }).map(row=>row.source_ref);
  const finalCoverage=sourceCoverage(readerDb,afterSource.length,{
    missingPreviouslySealed:missingAfter,sourceChangedDuringSeal,previousCoverage:coverage
  });
  let coverageAdded=0;
  if(canonicalize(finalCoverage)!==canonicalize(coverage)){
    const item=makeRecord('coverage_statement','intel_coverage',digest(canonicalize(finalCoverage)),null,finalCoverage);
    writerDb.exec('BEGIN IMMEDIATE');
    try{
      const existsNow=writerDb.prepare('SELECT 1 FROM intel_evidence_chain WHERE seller_id=? AND source_ref=?').get(sellerId,item.sourceRef);
      if(!existsNow){
        const head=writerDb.prepare('SELECT seq,hash FROM intel_evidence_head WHERE seller_id=?').get(sellerId)??{seq:0,hash:ZERO};
        const sequence=head.seq+1;
        const body={schema:'invoiceguard.sealed-financial-evidence.v1',sellerId,sequence,previousHash:head.hash,kind:item.kind,
          sourceTable:item.sourceTable,sourceKey:item.sourceKey,sourceRef:item.sourceRef,documentKey:item.documentKey,payload:item.payload};
        const json=canonicalize(body),hash=digest(json);
        writerDb.prepare('INSERT INTO intel_evidence_chain(seller_id,seq,prev_hash,entry_hash,kind,source_ref,document_key,canonical_json,sealed_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(sellerId,sequence,head.hash,hash,item.kind,item.sourceRef,item.documentKey,json,now());
        writerDb.prepare('UPDATE intel_evidence_head SET seq=?,hash=?,updated_at=? WHERE seller_id=?').run(sequence,hash,now(),sellerId);
        coverageAdded=1;
      }
      writerDb.exec('COMMIT');
    }catch(e){try{writerDb.exec('ROLLBACK');}catch{}throw e;}
    coverage=finalCoverage;
  }
  const verification=verifyEvidenceChain(writerDb,sellerId);
  if(!verification.valid)throw new Error('Evidence chain did not verify after sealing: '+verification.reason);
  return {added:added+coverageAdded,head:{sellerId,sequence:verification.sequence,hash:verification.hash},verification,coverage,sourceCount:afterSource.length};
}json,sealed_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const item of source){
      if(existing.has(item.sourceRef))continue;
      const sequence=current.seq+1;
      const body={schema:'invoiceguard.sealed-financial-evidence.v1',sellerId,sequence,previousHash:current.hash,kind:item.kind,
        sourceTable:item.sourceTable,sourceKey:item.sourceKey,sourceRef:item.sourceRef,documentKey:item.documentKey,payload:item.payload};
      const json=canonicalize(body),hash=digest(json);
      insert.run(sellerId,sequence,current.hash,hash,item.kind,item.sourceRef,item.documentKey,json,now());
      current={seq:sequence,hash};added++;
    }
    writerDb.prepare('INSERT INTO intel_evidence_head(seller_id,seq,hash,updated_at) VALUES(?,?,?,?) ON CONFLICT(seller_id) DO UPDATE SET seq=excluded.seq,hash=excluded.hash,updated_at=excluded.updated_at')
      .run(sellerId,current.seq,current.hash,now());
    writerDb.exec('COMMIT');
  }catch(e){try{writerDb.exec('ROLLBACK');}catch{}throw e;}
  const verification=verifyEvidenceChain(writerDb,sellerId);
  if(!verification.valid)throw new Error('Evidence chain did not verify after sealing: '+verification.reason);
  return {added,head:{sellerId,sequence:current.seq,hash:current.hash},verification,coverage,sourceCount:source.length-1};
}
export function getEvidenceCoverage(db,sellerId) {
  const v=verifyEvidenceChain(db,sellerId);
  if(!v.valid)return {status:'INCOMPLETE',reason:v.reason,brokenAt:v.brokenAt};
  const rows=rowsFor(db,sellerId);
  for(let i=rows.length-1;i>=0;i--){
    if(rows[i].kind==='coverage_statement'){
      try{return JSON.parse(rows[i].canonical_json).payload;}catch{return {status:'INCOMPLETE',reason:'coverage-statement-invalid'};}
    }
  }
  return {status:'UNKNOWN',note:'No coverage statement has been sealed.'};
}
export function buildDocumentTimeline(db,sellerId,documentKey) {
  const chain=rowsFor(db,sellerId).filter(r=>r.document_key===String(documentKey));
  const entries=chain.map(r=>({canonicalJson:r.canonical_json}));
  const events=normalizeEvidenceTimeline(entries);
  return {documentKey:String(documentKey),events,trajectoryDigest:trajectoryDigest(entries),completeness:getEvidenceCoverage(db,sellerId)};
}
export function exportEvidenceBundle(db,sellerId) {
  const verification=verifyEvidenceChain(db,sellerId);
  if(!verification.valid)throw new Error('Cannot export a broken evidence chain.');
  const rows=rowsFor(db,sellerId),checkpoint={sellerId,sequence:verification.sequence,hash:verification.hash};
  return {schema:'invoiceguard.sealed-financial-evidence.v1',sellerId,
    description:'Tamper-evident unsigned hash chain. It does not authenticate the source or the person who created source records.',
    chain:rows.map(r=>({sequence:r.seq,previousHash:r.prev_hash,hash:r.entry_hash,kind:r.kind,sourceRef:r.source_ref,documentKey:r.document_key,canonicalJson:r.canonical_json})),
    checkpoint,coverage:getEvidenceCoverage(db,sellerId),
    limitations:['An unsigned chain does not authenticate a source or operator.','A database controller can rewrite the chain or truncate its tail unless an earlier checkpoint is retained elsewhere.','Current snapshots do not reconstruct states that existed before the first seal.']};
}
export function verifyEvidenceBundle(bundle,{checkpoint=null}={}) {
  if(!bundle||bundle.schema!=='invoiceguard.sealed-financial-evidence.v1'||!Array.isArray(bundle.chain)||typeof bundle.sellerId!=='string')
    return {valid:false,reason:'bundle-schema-invalid',brokenAt:1};
  let prev=ZERO;
  for(let i=0;i<bundle.chain.length;i++){
    const row=bundle.chain[i],seq=i+1;
    if(row.sequence!==seq||row.previousHash!==prev)return {valid:false,reason:'sequence-or-link-mismatch',brokenAt:seq};
    let body;try{body=JSON.parse(row.canonicalJson);}catch{return {valid:false,reason:'canonical-json-invalid',brokenAt:seq};}
    if(body.sellerId!==bundle.sellerId||body.sequence!==seq||body.previousHash!==prev||body.kind!==row.kind||
      body.sourceRef!==row.sourceRef||body.documentKey!==row.documentKey||canonicalize(body)!==row.canonicalJson||digest(row.canonicalJson)!==row.hash)
      return {valid:false,reason:'entry-hash-mismatch',brokenAt:seq};
    prev=row.hash;
  }
  const cp=checkpoint??bundle.checkpoint;
  if(cp&&(cp.sellerId!==bundle.sellerId||cp.sequence!==bundle.chain.length||cp.hash!==prev))
    return {valid:false,reason:'external-checkpoint-mismatch',brokenAt:bundle.chain.length||1};
  return {valid:true,sequence:bundle.chain.length,hash:prev,coverageStatus:bundle.coverage?.status??'UNKNOWN'};
}
