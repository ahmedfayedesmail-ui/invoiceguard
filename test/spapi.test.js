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
