// Simulated Amazon for demos and tests: serves a VIDR report and accepts invoice uploads.
import { readFileSync } from 'node:fs';
export class MockApi {
  constructor() { this.feeds = new Map(); this.uploaded = new Set(); this.template = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); }
  async requestVidr() { return 'mock-report'; }
  async waitReport() { return 'mock-doc'; }
  async downloadReport() {
    const today = new Date().toISOString().slice(0, 10);
    // fresh dates, skip shipments we already "uploaded" so the pending report behaves like Amazon's
    const [head, ...rows] = this.template.trim().split('\n');
    const cols = head.split('\t'), si = cols.indexOf('shipping-id'), di = cols.indexOf('shipment-date');
    return [head, ...rows.filter(r => !this.uploaded.has(r.split('\t')[si])).map(r => { const c = r.split('\t'); c[di] = `${today}T06:00:00Z`; return c.join('\t'); })].join('\n');
  }
  async uploadInvoice({ shippingId }) { const id = `mock-feed-${this.feeds.size + 1}`; this.feeds.set(id, shippingId); this.uploaded.add(shippingId); return id; }
  async feedStatus() { return { status: 'DONE' }; }
}
