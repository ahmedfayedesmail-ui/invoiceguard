// Minimal SP-API client (EU). Auth is LWA only: no AWS SigV4 needed. fetchImpl is injectable for tests.
import { gunzipSync } from 'node:zlib';
export const ENDPOINT = { EU: 'https://sellingpartnerapi-eu.amazon.com', NA: 'https://sellingpartnerapi-na.amazon.com' };
// Store codes -> marketplace IDs, from https://developer-docs.amazon.com/sp-api/docs/marketplace-ids (checked 2026-11-26).
export const MARKETPLACE = { ES: 'A1RKKUPIHCS9HS', FR: 'A13V1IB3VIYZZH', DE: 'A1PA6795UKMFR9', IT: 'APJ6JRA9NG5V4', NL: 'A1805IZSGTT6HS', BE: 'AMEN7PMS3EDWL', PL: 'A1C3SOZRARQ6R3', SE: 'A2NODRKZP88ZB9', IE: 'A28R8C7NBKEWEA', GB: 'A1F83G8C2ARO7P' };

/**
 * Resolve the upload target for a report row. The VIDR `marketplace-id` column carries Amazon's
 * store codes (IE, ES, UK, FR, ...), per the VIDR column reference - NOT the A1... IDs - while the
 * Order Report path stores a country code derived from the sales channel. Accept a store code, a
 * country code (UK is Amazon's code for GB), or a raw marketplace ID. Unknown: null, and the caller
 * holds instead of guessing (the buyer's address country is NOT the store the order was placed on).
 */
export function marketplaceFor(codeOrId) {
  if (!codeOrId) return null;
  const m = String(codeOrId).trim().toUpperCase();
  if (Object.values(MARKETPLACE).includes(m)) return m;
  if (m === 'UK') return MARKETPLACE.GB;
  return MARKETPLACE[m] ?? null;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class SpApi {
  constructor({ clientId, clientSecret, refreshToken, region = 'EU', fetchImpl = fetch, sleepFn = sleep }) {
    Object.assign(this, { clientId, clientSecret, refreshToken, base: ENDPOINT[region], f: fetchImpl, sleep: sleepFn, token: null, exp: 0, lastUpload: 0 });
  }
  async accessToken() {
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    const res = await this.f('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId, client_secret: this.clientSecret }) });
    const j = await res.json();
    if (!res.ok) throw new Error(`LWA token error: ${j.error ?? res.status}`);
    this.token = j.access_token; this.exp = Date.now() + j.expires_in * 1000; return this.token;
  }
  async call(method, path, body, attempt = 0) {
    // Retry discipline: only safe calls retry automatically. GETs are reads. A 429 is Amazon rejecting
    // the request BEFORE processing it, so a retried POST cannot duplicate anything. A 5xx or a network
    // drop on a POST leaves the outcome UNKNOWN (Amazon may have processed it): the feeds API offers no
    // idempotency key (create-and-upload-invoices doc, checked 2026-11-26), so a blind second POST
    // /feeds could double-submit the document. No automatic retry there - the caller reconciles first.
    let res;
    try { res = await this.f(this.base + path, { method, headers: { 'x-amz-access-token': await this.accessToken(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { if (method === 'GET' && attempt < 4) { await this.sleep(1000 * 2 ** attempt); return this.call(method, path, body, attempt + 1); } throw e; }
    const safeToRetry = res.status === 429 || (res.status >= 500 && method === 'GET');
    if (safeToRetry && attempt < 4) { await this.sleep(1000 * 2 ** attempt); return this.call(method, path, body, attempt + 1); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`SP-API ${method} ${path} -> ${res.status} ${JSON.stringify(j.errors ?? j)}`); if (method !== 'GET' && res.status >= 500) e.unknownOutcome = true; throw e; }
    return j;
  }

  // ---- reports: pull the VAT invoice data report (pending invoices only) ----
  async requestVidr(marketplaceIds, { pendingOnly = true, all = false, from } = {}) {
    // all=true asks for every invoice status (InvoiceProcessing/Uploaded/Rejected, CreditNote*), not only
    // what is due; Amazon then wants a date window of at most 30 days (create-and-upload-invoices doc).
    const body = { reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', marketplaceIds };
    if (all) {
      // Genuine SP-API doc (developer-docs.amazon.com/sp-api/docs/create-and-upload-invoices): the option
      // key is literally "ReportOption=All", the window maxes at 30 days, and dataStartTime/dataEndTime
      // must sit on day boundaries of the report period. TODO(first live seller): confirm Amazon accepts
      // this exact request shape - until then it is covered by mock tests only.
      const end = new Date(); end.setUTCHours(0, 0, 0, 0); // whole days only: both ends on day boundaries
      const start = from ? new Date(from) : new Date(end.getTime() - 29 * 864e5);
      start.setUTCHours(0, 0, 0, 0);
      body.dataStartTime = start.toISOString(); body.dataEndTime = end.toISOString();
      body.reportOptions = { 'ReportOption=All': 'true' };
    }
    else if (pendingOnly) body.reportOptions = { 'ReportOption=pendingInvoices': 'true' };
    const r = await this.call('POST', '/reports/2021-06-30/reports', body);
    return r.reportId;
  }
  async waitReport(reportId, { tries = 60, everyMs = 15000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const r = await this.call('GET', `/reports/2021-06-30/reports/${reportId}`);
      if (r.processingStatus === 'DONE') return r.reportDocumentId;
      if (['CANCELLED', 'FATAL'].includes(r.processingStatus)) throw new Error(`Report ${reportId} ${r.processingStatus}`);
      await this.sleep(everyMs);
    }
    throw new Error(`Report ${reportId} timed out`);
  }
  async downloadReport(documentId) {
    const d = await this.call('GET', `/reports/2021-06-30/documents/${documentId}`);
    const res = await this.f(d.url); let buf = Buffer.from(await res.arrayBuffer());
    if (d.compressionAlgorithm === 'GZIP') buf = gunzipSync(buf);
    return buf.toString('utf8');
  }

  // ---- feeds: upload a PDF invoice (or credit note) against a shipment ----
  async uploadInvoice({ marketplaceId, pdf, orderId, shippingId, number, total, vat, documentType = 'Invoice', transactionId }) {
    const wait = this.lastUpload + 3000 - Date.now(); if (wait > 0) await this.sleep(wait); // Amazon throttle: 1 invoice per 3 s
    const doc = await this.call('POST', '/feeds/2021-06-30/documents', { contentType: 'application/pdf' });
    const put = await this.f(doc.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
    if (!put.ok) throw new Error(`Feed document upload failed: ${put.status}`);
    const opts = { 'metadata:InvoiceNumber': number, 'metadata:DocumentType': documentType, 'metadata:TotalAmount': total.toFixed(2), 'metadata:TotalVATAmount': vat.toFixed(2) };
    if (shippingId) opts['metadata:ShippingId'] = shippingId; else opts['metadata:OrderId'] = orderId;
    if (transactionId && (documentType === 'CreditNote' || String(transactionId).startsWith('Correction'))) opts['metadata:TransactionId'] = transactionId;
    for (const [k, v] of Object.entries(opts)) if (/[^A-Za-z0-9,\/\\ _;:#\-.]/.test(String(v).replace(/\./g, ''))) throw new Error(`Invalid character in feed option ${k}`);
    let feed;
    try {
      feed = await this.call('POST', '/feeds/2021-06-30/feeds', { feedType: 'UPLOAD_VAT_INVOICE', marketplaceIds: [marketplaceId], inputFeedDocumentId: doc.feedDocumentId, feedOptions: opts });
    } catch (e) {
      // A 4xx is a definite refusal (Amazon never accepted the feed). Anything else - network drop,
      // timeout, or a 5xx after the last retry - leaves the outcome UNKNOWN: Amazon may hold the
      // document. Callers must not blind-resend; they reconcile through the next VAT report first.
      if (!/-> 4\d\d/.test(e.message)) e.unknownOutcome = true;
      throw e;
    }
    this.lastUpload = Date.now();
    return feed.feedId;
  }
  async feedStatus(feedId) { const r = await this.call('GET', `/feeds/2021-06-30/feeds/${feedId}`); return { status: r.processingStatus, resultDocumentId: r.resultFeedDocumentId }; }

  // The feed list is the cross-check for interrupted uploads (unknownSettleCheck): a feed Amazon
  // created that we never recorded is the orphan that blocks a blind resend. A GET - safe to retry.
  async listFeeds({ createdSince, feedType = 'UPLOAD_VAT_INVOICE' } = {}) {
    const q = new URLSearchParams({ feedTypes: feedType, pageSize: '100' });
    if (createdSince) q.set('createdSince', createdSince);
    const r = await this.call('GET', `/feeds/2021-06-30/feeds?${q.toString()}`);
    return (r.feeds ?? []).map(f => ({ feedId: f.feedId, status: f.processingStatus, createdTime: f.createdTime }));
  }
  // Feed result documents live under the FEEDS documents endpoint, not the reports one.
  async downloadFeedResult(documentId) {
    const d = await this.call('GET', `/feeds/2021-06-30/documents/${documentId}`);
    const res = await this.f(d.url); let buf = Buffer.from(await res.arrayBuffer());
    if (d.compressionAlgorithm === 'GZIP') buf = gunzipSync(buf);
    return buf.toString('utf8');
  }
}
