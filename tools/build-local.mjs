// Builds public/local/engine.js: the server app's parsing, checks and PDF code, bundled for the browser.
// Dev tool (esbuild and buffer are devDependencies). The output is committed, so deploys need no build.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), w = (p) => join(root, 'web', p);
const redirect = { name: 'redirect', setup(b) {
  b.onResolve({ filter: /^node:fs$/ }, () => ({ path: w('shim-fs.js') }));
  b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: w('shim-crypto.js') }));
  b.onResolve({ filter: /^pdfkit$/ }, () => ({ path: join(root, 'node_modules/pdfkit/js/pdfkit.standalone.js') }));
  b.onResolve({ filter: /\/db\.js$/ }, (a) => a.importer.startsWith(join(root, 'src')) ? { path: w('stub-db.js') } : undefined);
} };
const r = await build({ entryPoints: [w('engine-entry.js')], bundle: true, format: 'esm', platform: 'browser', outfile: join(root, 'public/local/engine.js'),
  inject: [w('buffer-shim.js')], plugins: [redirect], loader: { '.json': 'json' }, define: { 'process.env.PDF_CACHE_MB': '"64"', 'process.env.RULES_ASOF': 'undefined', 'global': 'globalThis' }, legalComments: 'none', metafile: true, logLevel: 'info' });
const ins = Object.keys(r.metafile.inputs).filter(f => f.startsWith('src/') || f.startsWith('web/'));
console.log('inputs from our code:', ins.join(', '));
