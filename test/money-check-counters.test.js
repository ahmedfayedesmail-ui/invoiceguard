// Money Check counters: aggregate-only, anonymous, OFF by default. Written before the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketOf, outcomeOf, buildEvent, createCounters, EVENTS, BUCKETS, OUTCOMES } from '../public/local/counters.js';

const cfg = (extra = {}) => ({ mode: 'log', endpoint: '', ...extra });

test('bucketOf: 0 / 1-29 / 30-49 / 50-199 / 200+ EUR, boundaries, never the exact value', () => {
  const t = [[0, '0'], [0.4, '0'], [0.5, '1-29'], [1, '1-29'], [29.49, '1-29'], [29.5, '30-49'], [30, '30-49'], [49.49, '30-49'], [49.5, '50-199'], [199.49, '50-199'], [199.5, '200+'], [200, '200+'], [99999, '200+']];
  for (const [v, b] of t) assert.equal(bucketOf(v), b, String(v));
  for (const bad of [NaN, -1, Infinity, null, undefined, '12', {}]) assert.equal(bucketOf(bad), '0', 'unusable input falls to the lowest bucket, never leaks');
  assert.deepEqual([...BUCKETS], ['0', '1-29', '30-49', '50-199', '200+']);
});

test('outcomeOf: coarse flag only', () => {
  assert.equal(outcomeOf({ ok: false }), 'unreadable');
  assert.equal(outcomeOf({ ok: true, ready: [1], held: [] }), 'all_ready');
  assert.equal(outcomeOf({ ok: true, ready: [1], held: [2] }), 'some_held');
  assert.equal(outcomeOf({ ok: true, ready: [], held: [2] }), 'none_ready');
  assert.equal(outcomeOf({ ok: true, ready: [], held: [] }), 'none_ready');
  assert.deepEqual([...OUTCOMES].sort(), ['all_ready', 'none_ready', 'some_held', 'unreadable']);
});

test('buildEvent: exact allow-list of events and payload keys', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), ['check_completed', 'check_started', 'checkout_click', 'page_view']);
  assert.deepEqual(buildEvent('page_view'), { v: 1, e: 'page_view' });
  assert.deepEqual(buildEvent('check_started'), { v: 1, e: 'check_started' });
  assert.deepEqual(buildEvent('checkout_click'), { v: 1, e: 'checkout_click' });
  assert.deepEqual(buildEvent('check_completed', { bucket: '30-49', outcome: 'some_held' }), { v: 1, e: 'check_completed', bucket: '30-49', outcome: 'some_held' });
  assert.equal(buildEvent('nope'), null);
  assert.equal(buildEvent('check_completed', { bucket: '41.20', outcome: 'some_held' }), null, 'exact value rejected');
  assert.equal(buildEvent('check_completed', { bucket: '0', outcome: 'DE123' }), null);
  assert.equal(buildEvent('check_completed', {}), null);
});

test('buildEvent: hostile extra fields never survive (names, rows, exact values, ids)', () => {
  const hostile = { bucket: '50-199', outcome: 'all_ready', fileName: 'seller-Müller.tsv', rows: [{ order: '028-1234567-1234567' }], total: 123.45, buyerVat: 'DE123456789', sellerId: 'A1B2C3', id: 'x', ts: 1 };
  const ev = buildEvent('check_completed', hostile);
  assert.deepEqual(Object.keys(ev).sort(), ['bucket', 'e', 'outcome', 'v']);
  const pv = buildEvent('page_view', hostile); assert.deepEqual(pv, { v: 1, e: 'page_view' });
  assert.ok(!/Müller|028-|123\.45|DE123|A1B2/.test(JSON.stringify([ev, pv])));
});

test('flag defaults to disabled: no config, empty config, unknown mode all send nothing', () => {
  for (const c of [undefined, null, {}, { mode: '' }, { mode: 'on' }, { mode: 'ENDPOINT' }]) {
    const sent = [], logged = [];
    const k = createCounters(c, { send: (u, b) => sent.push([u, b]), log: (x) => logged.push(x) });
    assert.equal(k.mode, 'off');
    k.track('page_view'); k.track('check_started'); k.track('check_completed', { bucket: '0', outcome: 'all_ready' }); k.track('checkout_click');
    assert.equal(sent.length, 0); assert.equal(logged.length, 0);
  }
});

test('log mode: events go to the local log only, never to the network', () => {
  const sent = [], logged = [];
  const k = createCounters(cfg({ endpoint: 'https://example.invalid/c' }), { send: (u, b) => sent.push([u, b]), log: (x) => logged.push(x) });
  assert.equal(k.mode, 'log');
  k.track('page_view'); k.track('check_completed', { bucket: '200+', outcome: 'some_held' });
  assert.equal(sent.length, 0);
  assert.deepEqual(logged, [{ v: 1, e: 'page_view' }, { v: 1, e: 'check_completed', bucket: '200+', outcome: 'some_held' }]);
  assert.deepEqual(k.log, logged);
});

test('endpoint mode is dormant without an https endpoint; with one it sends only the allow-listed payload, once per call', () => {
  for (const ep of ['', undefined, 'http://example.invalid/c', 'javascript:alert(1)', '//x.invalid/c']) {
    const sent = []; const k = createCounters({ mode: 'endpoint', endpoint: ep }, { send: (u, b) => sent.push([u, b]), log: () => {} });
    assert.equal(k.mode, 'off'); k.track('page_view'); assert.equal(sent.length, 0);
  }
  const sent = []; const k = createCounters({ mode: 'endpoint', endpoint: 'https://example.invalid/c' }, { send: (u, b) => sent.push([u, b]), log: () => {} });
  assert.equal(k.mode, 'endpoint');
  k.track('check_completed', { bucket: '1-29', outcome: 'all_ready', fileName: 'a.tsv' });
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'https://example.invalid/c');
  assert.deepEqual(JSON.parse(sent[0][1]), { v: 1, e: 'check_completed', bucket: '1-29', outcome: 'all_ready' });
  k.track('bogus'); assert.equal(sent.length, 1);
});

test('consent gate is OFF by default and nothing beyond the aggregates exists behind it', () => {
  const k = createCounters(cfg(), { send: () => {}, log: () => {} });
  assert.equal(k.consent.extra, false);
  assert.equal(k.trackExtra('anything', { a: 1 }), false, 'no extra measurement without consent');
  assert.equal(k.log.length, 0);
  k.consent.extra = true; // even with consent there is no extra event defined yet
  assert.equal(k.trackExtra('anything', { a: 1 }), false);
});

test('anonymous: payloads carry no id, no time, no session token; the module touches no storage, cookie or id source', () => {
  const src = readFileSync(new URL('../public/local/counters.js', import.meta.url), 'utf8');
  for (const bad of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /Math\.random/, /crypto\./, /Date\.now|new Date/, /navigator\.(userAgent|language|sendBeacon)/, /screen\./, /location\./, /document\.referrer/])
    assert.ok(!bad.test(src), 'forbidden: ' + bad);
  assert.match(src, /credentials:\s*'omit'/); assert.match(src, /referrerPolicy:\s*'no-referrer'/);
});

test('the page states plainly what is counted, and ships with counters off', () => {
  const html = readFileSync(new URL('../public/local/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="counted"/);
  for (const w of ['page was opened', 'check was started', 'check finished', 'size band', 'checkout button', 'never']) assert.ok(html.includes(w), 'statement mentions: ' + w);
  assert.match(html, /name="ig-counters" content="off"/);
});
