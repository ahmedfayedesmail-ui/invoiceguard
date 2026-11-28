import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/intel/canonical.js';
import { classifyEvidenceOutcome } from '../src/intel/outcomes.js';
import { findFirstDivergence, trajectoryDigest } from '../src/intel/timeline.js';

test('canonical evidence JSON sorts object keys and refuses floats and undefined',()=>{
  assert.equal(canonicalize({z:1,a:{b:2}}),'{"a":{"b":2},"z":1}');
  assert.throws(()=>canonicalize({amount:1.25}),/safe integers/);
  assert.throws(()=>canonicalize({missing:undefined}),/undefined/);
});

test('document trajectory ignores unrelated seller-global sequence gaps',()=>{
  const baseline=[
    {sequence:1,kind:'invoice_snapshot',documentKey:'INV-1',payload:{status:'ready'}},
    {sequence:4,kind:'integrity_transition',documentKey:'INV-1',payload:{status:'HOLD'}}
  ];
  const sameTrajectory=[
    {sequence:1,kind:'invoice_snapshot',documentKey:'INV-1',payload:{status:'ready'}},
    {sequence:9,kind:'integrity_transition',documentKey:'INV-1',payload:{status:'HOLD'}}
  ];
  assert.equal(findFirstDivergence(baseline,sameTrajectory),null);
  const changed=[...sameTrajectory.slice(0,1),{...sameTrajectory[1],payload:{status:'RELEASED'}}];
  assert.equal(findFirstDivergence(baseline,changed).index,1);
  assert.match(trajectoryDigest(baseline),/^[a-f0-9]{64}$/);
});

test('outcome labels remain advisory and cannot change a financial state',()=>{
  const incomplete=classifyEvidenceOutcome({completeness:'UNKNOWN',proven:true});
  assert.equal(incomplete.outcome,'INCOMPLETE');
  assert.equal(incomplete.authority,'ADVISORY_ONLY');
  assert.equal(incomplete.changesFinancialState,false);
  const manual=classifyEvidenceOutcome({completeness:'INCOMPLETE',manualAuthorization:true});
  assert.equal(manual.outcome,'MANUAL_AUTHORIZATION');
  assert.equal(manual.changesFinancialState,false);
});
