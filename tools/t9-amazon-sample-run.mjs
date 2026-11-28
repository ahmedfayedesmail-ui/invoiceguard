// swarm/t9-date-reader, mission requirement (5): run Amazon's published flat-file shape end to end
// and report EXACT counts. Two inputs, both on the 102-column schema Amazon publishes today
// (fixtures/vidr-amazon-format.tsv, built from the published column list):
//   A) dates in the documented DD/MM/YYYY form ("17/05/2018", report-type page) — the fixture as committed;
//   B) dates in the form of Amazon's published flat-file SAMPLE linked from create-and-upload-invoices:
//      month/day/year with a zone-less time ("2/26/2019 20:14"), converted to tabs.
// Synthetic data only. No network, no Amazon account.
import { readFileSync } from 'node:fs';
import { planUpload } from '../src/manual.js';
import { processReport } from '../src/pipeline.js';
import { openDb } from '../src/db.js';

const VIDR = readFileSync(new URL('../fixtures/vidr-amazon-format.tsv', import.meta.url), 'utf8');

// Convert the date cells to the published sample's exact form: M/D/YYYY H:MM (unpadded, zone-less).
const toSampleForm = (text) => {
  const lines = text.replace(/\r?\n$/, '').split('\n'), head = lines[0].split('\t'); // never .trim(): trailing tabs of the last row are cells
  const cols = ['order-date', 'shipment-date'].map(c => head.indexOf(c));
  const conv = (v) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); if (!m) return v; return `${+m[2]}/${+m[1]}/${m[3]} 20:14`; };
  return [lines[0], ...lines.slice(1).map(l => { const c = l.split('\t'); for (const i of cols) c[i] = conv(c[i]); return c.join('\t'); })].join('\n') + '\n';
};

const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });

const runOne = async (label, text) => {
  console.log(`\n=== ${label} ===`);
  const plan = planUpload(text);
  console.log(`planUpload: ok=${plan.ok} rows=${plan.rows} ready=${plan.shipments.length} held=${plan.held.length} skipped=${plan.skipped.length} unsupported=${plan.unsupported.length}`);
  for (const h of plan.held) console.log(`  HELD ${h.orderId}: ${h.reason}`);
  for (const s of plan.skipped) console.log(`  SKIPPED ${s.orderId}: ${s.why}`);
  const db = openDb();
  const out = await processReport(db, SELLER, text, { api, validate: vies, now: new Date('2026-11-25T13:00:00Z') });
  const invoices = db.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c;
  console.log(`processReport: detected=${out.detected} uploaded=${out.uploaded} held=${out.held.length} skipped=${out.skipped} deferred=${out.deferred.length} invoices_issued=${invoices}`);
  for (const inv of db.prepare("SELECT number, json_extract(json, '$.operationDate') op, json_extract(json, '$.issueDate') iss FROM invoices WHERE kind='invoice'").all()) console.log(`  ISSUED ${inv.number}: operationDate=${inv.op} issueDate=${inv.iss}`);
  for (const h of out.held) console.log(`  HELD ${h.orderId}: ${h.reason}`);
};

await runOne('A) Amazon published column schema, documented DD/MM/YYYY dates (fixtures/vidr-amazon-format.tsv, as committed)', VIDR);
await runOne('B) Same file, dates converted to the published flat-file sample form M/D/YYYY H:MM ("2/26/2019 20:14"), tabs', toSampleForm(VIDR));
// C) ambiguous dates (both readings real calendar days): every row held, nothing issued, both readings named.
const ambiguous = VIDR.replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, '05/11/2026');
await runOne('C) Same file, every date made ambiguous (05/11/2026: 5 Nov or 11 May?)', ambiguous);
