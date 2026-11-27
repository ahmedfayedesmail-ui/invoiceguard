"""Totals for a sim run. Every ratio prints its numerator, denominator and formula. usage: python3 sim/aggregate.py results.jsonl"""
import json, sys, collections, statistics as st
rows = [json.loads(l) for l in open(sys.argv[1])]
C = collections.Counter
def pct(a, b): return f"{a}/{b} = {100*a/b:.1f}%" if b else f"{a}/{b} = n/a"
print('sellers', len(rows)); print('outcomes', dict(C(r['outcome'] for r in rows)))
print('crashes', [r['seller'] for r in rows if 'crash' in r])
# 1. confident findings, one bucket each
conf = [r['conf'] for r in rows if r.get('conf')]
def S(path):
    return sum(c[path[0]][path[1]] for c in conf)
ct, ctrue, cfalse = S(('commercial','total')), S(('commercial','true')), S(('commercial','false'))
dd, ce, un = S(('commercial','declarationDependent')), S(('commercial','conflictingEvidence')), S(('commercial','unscoredNonB2B'))
print('\nCONFIDENT COMMERCIAL findings (state ACTION_REQUIRED, family other than SOURCE_INCOMPLETE):', ct)
print('  = true', ctrue, '+ false', cfalse, '+ declaration-dependent', dd, '+ on conflicting evidence', ce, '+ unscored non-B2B', un, '  (sum check:', ctrue+cfalse+dd+ce+un, ')')
print('  precision, strict   = true / total                            =', pct(ctrue, ct))
print('  precision, scored   = true / (true + false)                   =', pct(ctrue, ctrue+cfalse), ' (leaves out declaration-dependent, conflicting-evidence, non-B2B)')
print('  false-confident rate on conflicting evidence = ', pct(ce, ce), '(every confident finding there is wrong by definition)')
st_t, st_e, st_u = S(('source','total')), S(('source','expected')), S(('source','unexpected'))
print('CONFIDENT SOURCE_INCOMPLETE findings (the file was refused or is unusable):', st_t, '= expected', st_e, '+ unexpected', st_u, '. These are data-quality results, not commercial claims, and are not in the precision above.')
by = C()
for r in rows:
    c = r.get('conf')
    if c:
        by[(r['scenario'], 'true')] += c['commercial']['true']; by[(r['scenario'], 'false')] += c['commercial']['false']; by[(r['scenario'], 'declDep')] += c['commercial']['declarationDependent']; by[(r['scenario'], 'conflict')] += c['commercial']['conflictingEvidence']; by[(r['scenario'], 'srcUnexpected')] += c['source']['unexpected']
print('per scenario, non-zero false / declaration-dependent / conflict / unexpected-source:')
for (sc, k), v in sorted(by.items()):
    if v and k != 'true': print('  ', sc, k, v)
# 2. recall: only in-scope injected defects, normal cohort
ev = [r for r in rows if r.get('eval') and r.get('cohort') != 'monthly_export']
D = sum(r['eval']['defects'] for r in ev); det = sum(r['eval']['detected'] for r in ev)
print('\nRECALL in scope, books exported through the report day:', pct(det, D), 'injected problems found / injected problems')
print('  missed by type', dict(C(t for r in ev for t in r['eval']['missed'])))
mo = [r for r in rows if r.get('eval') and r.get('cohort') == 'monthly_export']
print('RECALL month-only books cohort:', pct(sum(r['eval']['detected'] for r in mo), sum(r['eval']['defects'] for r in mo)), ' coverage notes shown:', sum(sum(n['count'] for n in r.get('covNotes', [])) for r in mo))
print('misclassified (found, wrong family):', sum(len(r['eval']['misclassified']) for r in ev))
# 3. onboarding
m = [r for r in rows if r.get('mapping') and 'error' not in r['mapping']]
print('\nONBOARDING no manual column or format choice:', pct(sum(1 for r in m if r['mapping']['auto']), len(m)))
print('  by dialect', {d: pct(sum(1 for r in m if r['dialect'] == d and r['mapping']['auto']), sum(1 for r in m if r['dialect'] == d)) for d in sorted(set(r['dialect'] for r in m))})
# 4. preflight and speed
pf = [r for r in rows if 'preflight' in r]
print('\nPREFLIGHT ready:', pct(sum(1 for r in pf if r['preflight'].get('ready')), len(pf)), ' blocked-as-expected:', sum(1 for r in pf if r['expectPreflightBlock'] and not r['preflight'].get('ready')), ' passed but expected block:', sum(1 for r in pf if r['expectPreflightBlock'] and r['preflight'].get('ready')))
print('preflight passed, then the Amazon file was refused (SOURCE_INCOMPLETE confident, not expected):', [r['seller'] for r in rows if r.get('conf') and r['conf']['source']['unexpected'] and r.get('preflight', {}).get('ready')])
pm = sorted(r['projectMs'] for r in rows if 'projectMs' in r and r['txs'] < 1000)
print('projection ms (<1000 rows) p50', pm[len(pm)//2], 'p95', pm[int(len(pm)*.95)], 'max', pm[-1], '| big', [(r['seller'], r['txs'], r.get('projectMs')) for r in rows if r['txs'] > 2000])
print('out of contract sellers', pct(sum(1 for r in rows if r.get('ooc')), len(rows)))
# 5. follow-up
t = C()
for r in rows:
    if r.get('round2') and r.get('cohort') != 'monthly_export':
        for k, v in r['round2'].items():
            if isinstance(v, int): t[k] += v
print('\nFOLLOW-UP (through-report-day cohort):', dict(t))
