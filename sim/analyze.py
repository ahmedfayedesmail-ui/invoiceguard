import json,sys,collections
rows=[json.loads(l) for l in open(sys.argv[1])]
for r in rows:
    e=r.get('eval')
    if not e: continue
    n=r.get('notes') or {}
    bad=e['missed'] or e['misclassified'] or e['fpConfident'] or e['extraConfident']
    if bad: print(r['seller'],r['scenario'],'M',e['missed'][:2],len(e['missed']),'MC',e['misclassified'][:1],'FP',[x['subtype'] for x in e['fpConfident']][:3],'X',e['extraConfident'][:2],'mapwhy',(r['mapping'] or {}).get('why'),'n',{k:v for k,v in n.items()})
