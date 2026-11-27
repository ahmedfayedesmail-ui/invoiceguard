import json,sys,collections,statistics as st
rows=[json.loads(l) for l in open(sys.argv[1])]
C=collections.Counter
print('N',len(rows)); print('outcomes',C(r['outcome'] for r in rows))
print('crash',[(r['seller'],r.get('crash','')[:150]) for r in rows if 'crash' in r])
print('blocked',C((r['scenario'],r.get('blockedBy','')[:70]) for r in rows if r['outcome'] in('refused_at_door','blocked_mapping','blocked_kind_words','crash_on_import')))
m=[r['mapping'] for r in rows if 'mapping' in r and 'error' not in r['mapping']]
print('mapping auto',sum(x['auto'] for x in m),'/',len(m),'wrong',sum(1 for x in m if x['wrong']),'median manual',st.median(x['manual'] for x in m))
fc=C(w.split(':')[0]+':'+w.split(':',1)[-1] for x in m for w in x['why']); print('manual fields',fc.most_common(14))
ev=[r for r in rows if r.get('eval') and not (r.get('notes') or {}).get('sellerDeclarationError') and r.get('cohort')!='monthly_export']
mo=[r for r in rows if r.get('eval') and r.get('cohort')=='monthly_export']
print('MONTHLY cohort',len(mo),'defects',sum(r['eval']['defects'] for r in mo),'detected',sum(r['eval']['detected'] for r in mo),'covNotes',sum(sum(n['count'] for n in r.get('covNotes',[])) for r in mo))
D=sum(r['eval']['defects'] for r in ev);det=sum(r['eval']['detected'] for r in ev)
print('defects',D,'detected',det,'recall',det/D if D else 0)
print('missed by type',C(t for r in ev for t in r['eval']['missed']))
print('misclassified',[(r['seller'],r['eval']['misclassified']) for r in ev if r['eval']['misclassified']][:10])
fpc=[(r['seller'],r['scenario'],x['family'],x['subtype']) for r in ev for x in r['eval']['fpConfident']]
print('FP confident',len(fpc),C((a[1],a[2],a[3]) for a in fpc))
print('FP hedged',C((r['scenario'],x['subtype'],x['state']) for r in ev for x in r['eval']['fpHedged']))
print('extra confident',C((r['scenario'],str(x)) for r in ev for x in r['eval']['extraConfident']))
cf=C();
for r in ev: 
  if r['eval']['fpConfident']: cf[r['seller']]+=1
tot_conf=sum(sum(v for k,v in r['byFamily'].items() if k.endswith('ACTION_REQUIRED')) for r in ev if 'byFamily' in r)
print('confident issues total',tot_conf,'precision',1-len(fpc)/tot_conf if tot_conf else 0)
nd=[r for r in ev if r['eval']['defects']==0]
print('sellers w/o defects',len(nd),'with confident finding',sum(1 for r in nd if r['eval']['fpConfident']))
pf=[r for r in rows if 'preflight' in r]
print('preflight',C((r['preflight'].get('ready'),tuple(r['preflight'].get('fail',[])),tuple(r['preflight'].get('warn',[]))) for r in pf).most_common(12))
print('expectBlock but ready',[r['seller'] for r in pf if r['expectPreflightBlock'] and r['preflight'].get('ready')])
print('fail unexpected',[(r['seller'],r['scenario'],r['preflight']['fail']) for r in pf if not r['expectPreflightBlock'] and not r['preflight'].get('ready')][:15])
pm=sorted(r['projectMs'] for r in rows if 'projectMs' in r); print('proj ms p50',pm[len(pm)//2],'p95',pm[int(len(pm)*.95)],'max',pm[-1])
print('big',[(r['seller'],r['txs'],r.get('projectMs'),r['totalMs'],r['heapMB']) for r in rows if r['txs']>2000])
print('round2',[(r['seller'],r['scenario'],r['round2']) for r in rows if r.get('round2')][:40])
print('ooc sellers',sum(1 for r in rows if r.get('ooc')),'defects only ooc',sum(1 for r in rows if r.get('ooc') and not r.get('defects')))
print('malformed',[(r['seller'],r['malformed'],r['outcome'],r.get('blockedBy','')[:60],r.get('eval') and r['eval']['detected'], r.get('byFamily')) for r in rows if 'malformed' in r])
print('silentloss',[(r['seller'],r['malformed'],r['silentLoss'],r['ledgerRead']) for r in rows if r.get('silentLoss')])
