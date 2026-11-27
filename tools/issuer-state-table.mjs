import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
const root = process.argv[2]; const { reconcile } = await import(root + '/src/reconcile.js');
const DECL = JSON.parse(readFileSync(root + '/fixtures/recon/declared.json', 'utf8')), NAME = 'special-r1.tsv';
const raw = readFileSync(root + '/fixtures/recon/' + NAME, 'utf8'), lines = raw.trim().split('\n'), h = lines[0].split('\t');
const rows = [];
for (const ship of ['S9701', 'S9801']) for (const [label, flags] of [['as in fixture', null], ['TRUE', ['TRUE']], ['FALSE', ['FALSE']], ['blank', ['']], ['unreadable (yes)', ['yes']], ['rows TRUE+FALSE', ['TRUE', 'FALSE']]]) {
  const out = [lines[0]]; for (const r of lines.slice(1)) { const c = r.split('\t'); if (c[h.indexOf('shipping-id')] !== ship) continue; if (!flags) { out.push(r); continue; } flags.forEach((f, i) => { const d = [...c]; d[h.indexOf('order-item-id')] = String(i + 1); d[h.indexOf('is-amazon-invoiced')] = f; out.push(d.join('\t')); }); }
  const text = out.join('\n') + '\n', o = reconcile([{ id: 'r1', fileName: NAME, text, sha256: createHash('sha256').update(text).digest('hex'), importedAt: '2026-11-20T10:00:00Z', declared: DECL[NAME] }]), d = o.docs[0];
  rows.push([ship, d.rawStatus, label, d.state, o.headline.createdByAmazon]);
}
for (const r of rows) console.log(r.join(' | '));
