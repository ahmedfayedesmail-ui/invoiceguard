// swarm/t9-date-reader: the shared date reader's contract (owner ruling 2026-11-28):
// read every verified documented shape; NEVER guess an ambiguous numeric date; an impossible date is unreadable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAmazonDate } from '../src/date-reader.js';

test('reader: ISO date and zoned ISO date-time are read, day and instant exact', () => {
  assert.deepEqual(readAmazonDate('2026-11-24'), { ok: true, kind: 'iso', order: 'ISO', day: '2026-11-24', ms: Date.UTC(2026, 10, 24), hasTime: false });
  const r = readAmazonDate('2026-11-24T08:00:00Z');
  assert.equal(r.ok, true); assert.equal(r.day, '2026-11-24'); assert.equal(r.ms, Date.parse('2026-11-24T08:00:00Z')); assert.equal(r.hasTime, true);
  assert.equal(readAmazonDate('2026-11-24T08:00:00+01:00').ok, true);
});

test('reader: the documented DD/MM/YYYY is read; a one-reading month-first value is read (the other reading is not a real day, so nothing is guessed)', () => {
  assert.deepEqual(readAmazonDate('17/05/2018'), { ok: true, kind: 'slash', order: 'DAY_FIRST', day: '2018-05-17', ms: Date.UTC(2018, 4, 17), hasTime: false });
  const r = readAmazonDate('11/24/2026'); // month 24 is not a real month: the only real reading is 24 November
  assert.equal(r.ok, true); assert.equal(r.order, 'MONTH_FIRST'); assert.equal(r.day, '2026-11-24');
});

test('reader: Amazon\'s published flat-file sample form (M/D/YYYY H:MM, unpadded, zone-less) is read: the day is known, the instant is not', () => {
  const r = readAmazonDate('2/26/2019 20:14');
  assert.equal(r.ok, true); assert.equal(r.kind, 'slash'); assert.equal(r.order, 'MONTH_FIRST'); assert.equal(r.day, '2019-02-26'); assert.equal(r.hasTime, true);
  assert.equal(r.ms, null, 'a zone-less clock time proves the day but never the instant');
});

test('reader: an ambiguous numeric date (both readings real calendar days) is never read: both readings are named', () => {
  for (const [v, df, mf] of [['05/11/2026', '2026-11-05', '2026-05-11'], ['11/05/2026', '2026-05-11', '2026-11-05'], ['01/01/2026', '2026-01-01', '2026-01-01'], ['12/12/2026', '2026-12-12', '2026-12-12']]) {
    const r = readAmazonDate(v);
    assert.equal(r.ok, false, v); assert.equal(r.kind, 'ambiguous', v); assert.equal(r.dayFirst, df, v); assert.equal(r.monthFirst, mf, v);
  }
  const withTime = readAmazonDate('2/2/2019 20:14');
  assert.equal(withTime.ok, false); assert.equal(withTime.kind, 'ambiguous');
});

test('reader: an impossible date is unreadable, in every documented shape', () => {
  for (const v of ['31/02/2018', '32/01/2018', '00/11/2026', '13/13/2026', '2026-02-30', '2026-13-01', '2026-11-27T99:99:99Z', '2/26/2019 25:14']) {
    const r = readAmazonDate(v); assert.equal(r.ok, false, v); assert.equal(r.kind, 'impossible', v);
  }
});

test('reader: anything outside the documented shapes is unrecognized (never prefix-matched, never guessed)', () => {
  for (const v of ['yesterday', '1', '2026-11-24T08:00:00', '24.11.2026', '17/5/2026', '17/11/26', '17-11-2026', '17/11/2026 garbage', '17/11/2026T10:00', ' 17/11/2026x', '2026-11-27Tgarbage']) {
    const r = readAmazonDate(v); assert.equal(r.ok, false, v); assert.equal(r.kind, 'unrecognized', v);
  }
  assert.equal(readAmazonDate('').kind, 'blank'); assert.equal(readAmazonDate('   ').kind, 'blank'); assert.equal(readAmazonDate(null).kind, 'blank'); assert.equal(readAmazonDate(undefined).kind, 'blank');
});
