// Simulated Amazon for demos and tests: serves a VIDR report and accepts invoice uploads.
// Like the real thing, the report lists every shipment with its CURRENT invoice status
// (pendingInvoices=false / all=true behavior): an uploaded shipment stays visible as
// InvoiceUploaded, and a done feed is not what marks it - the report status is.
import { readFileSync } from 'node:fs';
export class MockApi {
  constructor(uploadedIds = []) { this.feeds = new Map(); this.uploaded = new Set(uploadedIds); this.creditDone = new Set(); this.template = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); }
  async requestVidr() { return 'mock-report'; }
  async waitReport() { return 'mock-doc'; }
  async downloadReport() {
    const today = new Date().toISOString().slice(0, 10);
    const [head, ...rows] = this.template.trim().split('\n');
    const cols = head.split('\t'), ix = (n) => cols.indexOf(n);
    const out = rows.map(r => { const c = r.split('\t'); c[ix('shipment-date')] = `${today}T06:00:00Z`;
      if (this.uploaded.has(c[ix('shipping-id')])) c[ix('invoice-status')] = 'InvoiceUploaded';
      return c.join('\t'); });
    // Once something was uploaded, a return arrives for it: the demo then shows the repair flow on the next sync.
    const first = rows.find(r => this.uploaded.has(r.split('\t')[ix('shipping-id')]));
    if (first) { const c = first.split('\t'); c[ix('transaction-type')] = 'REFUND'; c[ix('transaction-id')] = 'RF-DEMO-1'; c[ix('shipment-date')] = `${today}T09:00:00Z`;
      c[ix('invoice-status')] = this.creditDone.has('RF-DEMO-1') ? 'CreditNoteUploaded' : 'CreditNotePending'; out.push(c.join('\t')); }
    return [head, ...out].join('\n');
  }
  async uploadInvoice({ shippingId, documentType, transactionId }) { const id = `mock-feed-${this.feeds.size + 1}`; this.feeds.set(id, shippingId); if (documentType === 'CreditNote' && transactionId) this.creditDone.add(transactionId); else this.uploaded.add(shippingId); return id; }
  async feedStatus() { return { status: 'DONE', resultDocumentId: 'mock-result-doc' }; }
  async downloadFeedResult() { return 'record-status\tmessage\nsuccess\tsimulated processing report: no errors'; }
}
