import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/intel/', import.meta.url));
const prohibitedImports = /from\s+['"](?:\.\.\/)+(?:pipeline|repair|cn-gate|orig-gate|holds|integrity|claims|invoice)(?:\.js)?['"]/;
const prohibitedWrites = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:main\.)?["']?(?:invoices|credit_claims|integrity_findings|integrity_history|holds|shipments|repairs|counters|events)\b/i;

test('intel module import and SQL boundary excludes financial authority paths', () => {
  const files = readdirSync(root).filter(name => name.endsWith('.js'));
  assert.ok(files.length >= 3);
  for (const name of files) {
    const source = readFileSync(join(root, name), 'utf8');
    assert.equal(prohibitedImports.test(source), false, `${name} imports an authoritative financial module`);
    assert.equal(prohibitedWrites.test(source), false, `${name} writes an authoritative financial table`);
  }
});
