// Worker process: runs a first-upload pass whose Amazon call takes `slow` ms (first document only).
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db.js'; import { processReport } from '../../src/pipeline.js';
const [file, slow] = process.argv.slice(2); const db = openDb(file); let first = null;
const api = { async uploadInvoice(a) { if (!first) { first = a.number; await new Promise(r => setTimeout(r, Number(slow))); } return 'w-' + a.number; }, async feedStatus() { return { status: 'DONE' }; }, async listFeeds() { return []; } };
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
await processReport(db, seller, readFileSync(new URL('../../fixtures/vidr.tsv', import.meta.url), 'utf8'), { api, validate: async v => ({ status: 'valid', vat: v }), now: new Date('2026-11-24T12:00:00Z') });
console.log(JSON.stringify({ done: true, first })); db.close();
