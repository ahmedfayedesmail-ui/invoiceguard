import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { buildFa3 } from '../src/ksef.js';
const inv = { sellerNip:'5260250995', sellerName:'Test Seller', sellerAddr1:'ul. Testowa 1', sellerAddr2:'00-001 Warszawa', buyerName:'Buyer GmbH', buyerCountry:'DE', buyerVatId:'DE123456789', number:'FV/1', date:'2026-11-25', currency:'EUR', vatRate:23, lines:[{desc:'Item', qty:2, unitNet:50}] };
const check = (kind, f) => spawnSync('python3', ['tools/validate_xsd.py', kind, f], {encoding:'utf8'});
test('FA3 built XML is schema-valid', () => {
  writeFileSync('/tmp/_fa3.xml', buildFa3(inv));
  const r = check('fa3', '/tmp/_fa3.xml'); assert.equal(r.status, 0, r.stdout);
});
test('FA(3) correction (KOR) is schema-valid and refuses incomplete references', () => {
  const k = { ...inv, number:'FV/1/K', corrects:{ number:'FV/1', date:'2026-11-25', reason:'Corrected buyer name', ksefNumber:'4937754299-20261125-4F7C9C000000-37' } };
  writeFileSync('/tmp/_kor.xml', buildFa3(k)); assert.equal(check('fa3', '/tmp/_kor.xml').status, 0, check('fa3', '/tmp/_kor.xml').stdout);
  writeFileSync('/tmp/_kor2.xml', buildFa3({ ...k, corrects:{ ...k.corrects, ksefNumber:undefined } })); assert.equal(check('fa3', '/tmp/_kor2.xml').status, 0);
  assert.throws(() => buildFa3({ ...k, corrects:{ ...k.corrects, reason:'' } }));
  assert.throws(() => buildFa3({ ...k, corrects:{ ...k.corrects, ksefNumber:'bad' } }));
});
test('FA3 builder refuses unknown rate and missing data', () => {
  assert.throws(() => buildFa3({ ...inv, vatRate: 19 }));
  assert.throws(() => buildFa3({ ...inv, number: '' }));
});
test('validator rejects broken FA3 and accepts no unknown element', () => {
  writeFileSync('/tmp/_bad.xml', buildFa3(inv).replace('<P_15>','<Bogus>1</Bogus><P_15>'));
  assert.notEqual(check('fa3', '/tmp/_bad.xml').status, 0);
});
test('FatturaPA sample is schema-valid, broken one is rejected', () => {
  assert.equal(check('fatturapa', 'fixtures/xml/fatturapa-valid-sample.xml').status, 0);
  writeFileSync('/tmp/_b.xml', (await_read()).replace('<Divisa>EUR','<Divisa>EURO'));
  assert.notEqual(check('fatturapa', '/tmp/_b.xml').status, 0);
});
import { readFileSync } from 'node:fs';
function await_read(){ return readFileSync('fixtures/xml/fatturapa-valid-sample.xml','utf8'); }
test('FA3 amount correction: before/after rows, difference totals, schema-valid', () => {
  const before = [{desc:'Widget',qty:2,unitNet:100}];
  const x = buildFa3({...inv, number:'FK/1', lines:[{desc:'Widget',qty:2,unitNet:120}], vatRate:23, corrects:{number:'FV/1',date:'2026-11-20',reason:'Price fix',before}});
  assert.match(x, /<StanPrzed>1<\/StanPrzed>/);
  assert.match(x, /<P_13_1>40\.00</); assert.match(x, /<P_14_1>9\.20</); assert.match(x, /<P_15>49\.20</);
  writeFileSync('/tmp/_amt.xml', x);
  assert.equal(check('fa3', '/tmp/_amt.xml').status, 0);
  assert.throws(() => buildFa3({...inv, lines:before, corrects:{number:'FV/1',date:'2026-11-20',reason:'x',before:[],effect:2}}));
  assert.throws(() => buildFa3({...inv, lines:before, corrects:{number:'FV/1',date:'2026-11-20',reason:'x',before,effect:3}}));
});
test('FA3 multi-rate: per-rate totals and per-rate correction differences', () => {
  const L1=[{desc:'A',qty:2,unitNet:100,rate:23},{desc:'B',qty:1,unitNet:50,rate:8}];
  const L2=[{desc:'A',qty:2,unitNet:120,rate:23},{desc:'B',qty:1,unitNet:40,rate:8}];
  const o = buildFa3({...inv, number:'X/1', lines:L1});
  assert.match(o, /<P_13_1>200\.00</); assert.match(o, /<P_14_2>4\.00</); assert.match(o, /<P_15>300\.00</);
  const k = buildFa3({...inv, number:'K/1', lines:L2, corrects:{number:'X/1',date:'2026-11-20',reason:'r',before:L1}});
  assert.match(k, /<P_13_2>-10\.00</); assert.match(k, /<P_14_2>-0\.80</); assert.match(k, /<P_15>38\.40</);
  assert.throws(() => buildFa3({...inv, number:'X/2', lines:[{desc:'A',qty:1,unitNet:1,rate:19}]}));
});
