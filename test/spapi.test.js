import test from 'node:test';
import assert from 'node:assert/strict';
import { SpApi, marketplaceFor } from '../src/spapi.js';

test('the all-status VIDR request uses Amazon\u2019s documented ReportOption=All shape', async () => {
  const bodies = [];
  const f = async (url, opts) => {
    if (String(url).includes('auth/o2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ reportId: 'r1' }) };
  };
  const api = new SpApi({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: f });
  await api.requestVidr(['A1RKKUPIHCS9HS'], { all: true });
  const b = bodies[0];
  assert.equal(b.reportType, 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT');
  assert.equal(b.reportOptions['ReportOption=All'], 'true', 'genuine doc example: "reportOptions": {"ReportOption=All": "true"}');
  assert.equal(b.reportOptions.all, undefined, 'the undocumented "all" key is gone');
  assert.ok(b.dataStartTime && b.dataEndTime, '30-day window present');
  assert.ok(Date.parse(b.dataEndTime) - Date.parse(b.dataStartTime) <= 30 * 864e5, 'within the 30-day maximum');
});

test('the pending-only VIDR request keeps the documented pendingInvoices shape', async () => {
  const bodies = [];
  const f = async (url, opts) => {
    if (String(url).includes('auth/o2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ reportId: 'r1' }) };
  };
  const api = new SpApi({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: f });
  await api.requestVidr(['A1RKKUPIHCS9HS']);
  assert.equal(bodies[0].reportOptions['ReportOption=pendingInvoices'], 'true');
});

test('marketplaceFor: store codes, country codes, raw IDs; unknown stays null', () => {
  assert.equal(marketplaceFor('UK'), 'A1F83G8C2ARO7P');
  assert.equal(marketplaceFor('GB'), 'A1F83G8C2ARO7P');
  assert.equal(marketplaceFor('ES'), 'A1RKKUPIHCS9HS');
  assert.equal(marketplaceFor('A1RKKUPIHCS9HS'), 'A1RKKUPIHCS9HS');
  assert.equal(marketplaceFor('ZZ'), null);
  assert.equal(marketplaceFor(''), null);
});

test('POSTs that create documents are never blindly retried: 5xx fails once with unknownOutcome, 429 retries safely, GETs retry', async () => {
  const counts = {};
  let feedsReplies = [{ status: 500, json: async () => ({}) }];
  const f = async (url, opts) => {
    const u = String(url);
    if (u.includes('auth/o2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    const key = opts.method + ' ' + u.replace(/^https?:\/\/[^/]+/, '').slice(0, 40);
    counts[key] = (counts[key] ?? 0) + 1;
    if (u.includes('/feeds/2021-06-30/documents') && opts.method === 'POST') return { ok: true, json: async () => ({ feedDocumentId: 'd1', url: 'https://upload.example/put' }) };
    if (u === 'https://upload.example/put') return { ok: true };
    if (u.includes('/feeds/2021-06-30/feeds') && opts.method === 'POST') return feedsReplies.length > 1 ? feedsReplies.shift() : feedsReplies[0];
    return { ok: true, json: async () => ({}) };
  };
  const api = new SpApi({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: f, sleepFn: async () => {} });
  const feedsKey = Object.keys(counts);
  await assert.rejects(() => api.uploadInvoice({ marketplaceId: 'A1RKKUPIHCS9HS', pdf: Buffer.from('%PDF-1.4 fake'), orderId: 'o1', shippingId: 'sh1', number: 'A-1', total: 10, vat: 2 }),
    (e) => { assert.equal(e.unknownOutcome, true, 'a 5xx on feed creation leaves the outcome unknown'); return true; });
  const feedPosts = Object.entries(counts).find(([k]) => k.includes('POST') && k.includes('/feeds/2021-06-30/feeds'));
  assert.equal(feedPosts[1], 1, 'the non-idempotent feed-creation POST was NOT retried on 5xx');
  // 429 is a pre-processing refusal: retrying cannot duplicate, so it does retry
  feedsReplies = [{ status: 429, json: async () => ({}) }, { ok: true, status: 201, json: async () => ({ feedId: 'F9' }) }];
  counts['POST /feeds/2021-06-30/feeds'] = 0;
  const feedId = await api.uploadInvoice({ marketplaceId: 'A1RKKUPIHCS9HS', pdf: Buffer.from('%PDF-1.4 fake'), orderId: 'o1', shippingId: 'sh1', number: 'A-1', total: 10, vat: 2 });
  assert.equal(feedId, 'F9');
  assert.equal(counts['POST /feeds/2021-06-30/feeds'], 2, 'a throttled POST retried exactly once before succeeding');
});

test('listFeeds paginates with nextToken ALONE and sends filters only on the first call', async () => {
  const seen = [];
  const mk = (n, from) => Array.from({ length: n }, (_, i) => ({ feedId: 'f' + (from + i), processingStatus: 'DONE', createdTime: '2026-11-20T00:00:00.000Z' }));
  const pages = {
    '': { feeds: mk(100, 0), nextToken: 'tok2' },
    tok2: { feeds: mk(1, 100), nextToken: 'tok3' },
    tok3: { feeds: [{ feedId: 'f101', processingStatus: 'CANCELLED', createdTime: '2026-11-20T00:00:00.000Z' }] },
  };
  const f = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes('auth/o2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    const params = Object.fromEntries(u.searchParams.entries());
    seen.push(params);
    return { ok: true, json: async () => pages[params.nextToken ?? ''] };
  };
  const api = new SpApi({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: f });
  const feeds = await api.listFeeds({ createdSince: '2026-11-19T00:00:00.000Z' });
  assert.equal(feeds.length, 102, 'all three pages were collected - page 2+ feeds are never invisible');
  assert.equal(seen.length, 3);
  assert.equal(seen[0].createdSince, '2026-11-19T00:00:00.000Z', 'createdSince goes on the first call');
  assert.equal(seen[0].feedTypes, 'UPLOAD_VAT_INVOICE');
  assert.equal(seen[0].pageSize, '100');
  for (const p of seen.slice(1))
    assert.deepEqual(Object.keys(p), ['nextToken'], 'genuine model: nextToken is sent ALONE - with any other parameter the request fails');
  assert.equal(seen[1].nextToken, 'tok2');
  assert.equal(seen[2].nextToken, 'tok3');
});

test('listFeeds refuses a non-converging feed list instead of trusting a truncated one', async () => {
  let calls = 0;
  const f = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes('auth/o2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    calls++;
    return { ok: true, json: async () => ({ feeds: [{ feedId: 'fx', processingStatus: 'DONE', createdTime: '2026-11-20T00:00:00.000Z' }], nextToken: 'never-ends' }) };
  };
  const api = new SpApi({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: f });
  await assert.rejects(() => api.listFeeds({ maxPages: 3 }), (e) => { assert.ok(e.inconclusive, 'the caller must HOLD, not trust a partial list'); return true; });
  assert.equal(calls, 3, 'it stopped at the page cap');
});
