// Simulated Amazon for demos and tests: serves a VIDR report and accepts invoice uploads.
// Like the real thing, the report lists every shipment with its CURRENT invoice status
// (pendingInvoices=false / all=true behavior): an uploaded shipment stays visible as
// InvoiceUploaded, and a done feed is not what marks it - the report status is.
import { readFileSync } from 'node:fs';
export class MockApi {
  constructor(uploadedIds = [], creditIds = []) { this.feeds = new Map(); this.uploaded = new Set(uploadedIds); this.creditDone = new Set(creditIds); this.template = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); }
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
    const ups = rows.filter(r => this.uploaded.has(r.split('\t')[ix('shipping-id')]));
    if (ups[0]) { const c = ups[0].split('\t'); c[ix('transaction-type')] = 'REFUND'; c[ix('transaction-id')] = 'RF-DEMO-1'; c[ix('shipment-date')] = `${today}T09:00:00Z`;
      c[ix('invoice-status')] = this.creditDone.has('RF-DEMO-1') ? 'CreditNoteUploaded' : 'CreditNotePending'; out.push(c.join('\t')); }
    // A second uploaded shipment comes back as a partial RETURN (Amazon's other return transaction
    // type), so the demo dogfoods the RETURN path too: half the item amounts, shipping kept.
    if (ups[1]) { const c = ups[1].split('\t'); c[ix('transaction-type')] = 'RETURN'; c[ix('transaction-id')] = 'RT-DEMO-1'; c[ix('shipment-date')] = `${today}T10:00:00Z`;
      for (const n of ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount']) { const v = parseFloat(c[ix(n)]) / 2; c[ix(n)] = (-Math.round(v * 100) / 100).toFixed(2); }
      for (const n of ['shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount', 'gift-wrap-vat-incl-amount', 'gift-wrap-vat-amount', 'gift-wrap-vat-excl-amount']) { if (ix(n) >= 0) c[ix(n)] = '0'; }
      c[ix('invoice-status')] = this.creditDone.has('RT-DEMO-1') ? 'CreditNoteUploaded' : 'CreditNotePending'; out.push(c.join('\t')); }
    return [head, ...out].join('\n');
  }
  async uploadInvoice({ shippingId, documentType, transactionId }) { const id = `mock-feed-${this.feeds.size + 1}`; this.feeds.set(id, { shippingId, createdTime: new Date().toISOString(), status: 'DONE' }); if (documentType === 'CreditNote' && transactionId) this.creditDone.add(transactionId); else this.uploaded.add(shippingId); return id; }
  async listFeeds({ createdSince } = {}) { return [...this.feeds.entries()].filter(([, f]) => !createdSince || f.createdTime >= createdSince).map(([feedId, f]) => ({ feedId, status: f.status, createdTime: f.createdTime, resultDocumentId: f.resultDocumentId ?? null })); }
  async feedStatus() { return { status: 'DONE', resultDocumentId: 'mock-result-doc' }; }
  async downloadFeedResult() { return 'record-status\tmessage\nsuccess\tsimulated processing report: no errors'; }
}
