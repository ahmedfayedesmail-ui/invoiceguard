// Builds public/local/engine.js: the server app's parsing, checks and PDF code, bundled for the browser.
// Dev tool (esbuild and buffer are devDependencies). The output is committed, so deploys need no build.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
// `node tools/build-local.mjs --check` rebuilds in memory and FAILS (exit 1, names the files) if a committed bundle differs from what its sources build. It writes nothing.
const CHECK = process.argv.includes('--check'), stale = [];
const finish = (r) => { if (CHECK) for (const o of r.outputFiles) if (!existsSync(o.path) || !Buffer.from(o.contents).equals(readFileSync(o.path))) stale.push(o.path.replace(root + '/', '')); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), w = (p) => join(root, 'web', p);
const redirect = { name: 'redirect', setup(b) {
  b.onResolve({ filter: /^node:fs$/ }, () => ({ path: w('shim-fs.js') }));
  b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: w('shim-crypto.js') }));
  b.onResolve({ filter: /^pdfkit$/ }, () => ({ path: join(root, 'node_modules/pdfkit/js/pdfkit.standalone.js') }));
  b.onResolve({ filter: /\/db\.js$/ }, (a) => a.importer.startsWith(join(root, 'src')) ? { path: w('stub-db.js') } : undefined);
} };
const r = await build({ entryPoints: [w('engine-entry.js')], bundle: true, format: 'esm', platform: 'browser', outfile: join(root, 'public/local/engine.js'),
  inject: [w('buffer-shim.js')], plugins: [redirect], loader: { '.json': 'json' }, define: { 'process.env.PDF_CACHE_MB': '"64"', 'process.env.RULES_ASOF': 'undefined', 'global': 'globalThis' }, legalComments: 'none', metafile: true, write: !CHECK, logLevel: CHECK ? 'silent' : 'info' });
finish(r);
const ins = Object.keys(r.metafile.inputs).filter(f => f.startsWith('src/') || f.startsWith('web/'));
console.log('inputs from our code:', ins.join(', '));

// Problem loop bundle (separate file: the loop never shares a module with the issuing code).
const r2 = await build({ entryPoints: [w('loop-entry.js')], bundle: true, format: 'esm', platform: 'browser', outfile: join(root, 'public/local/loop-engine.js'),
  inject: [w('buffer-shim.js')], plugins: [redirect], loader: { '.json': 'json' }, define: { 'global': 'globalThis' }, legalComments: 'none', metafile: true, write: !CHECK, logLevel: CHECK ? 'silent' : 'info' });
finish(r2);
console.log('loop inputs from our code:', Object.keys(r2.metafile.inputs).filter(f => f.startsWith('src/') || f.startsWith('web/')).join(', '));

if (CHECK) { if (stale.length) { console.error('STALE BUNDLE(S): ' + stale.join(', ') + '. Run: node tools/build-local.mjs, then commit the rebuilt files.'); process.exit(1); } console.log('bundles are current: ' + 2); }
