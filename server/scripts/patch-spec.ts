// Rewrites the two non-standard `type: int` occurrences in the upstream spec to
// `type: integer` so openapi-typescript emits `number` instead of `unknown`.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const src = new URL('../spec/oas3-api.yaml', import.meta.url);
const out = new URL('../spec/oas3-api.patched.yaml', import.meta.url);

const doc: unknown = parse(readFileSync(src, 'utf8'));
let patched = 0;

function walk(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj['type'] === 'int') {
      obj['type'] = 'integer';
      patched += 1;
    }
    for (const value of Object.values(obj)) walk(value);
  }
}

walk(doc);
writeFileSync(out, stringify(doc, { lineWidth: 0 }));
console.error(`patch-spec: rewrote ${patched} 'type: int' occurrence(s)`);
if (patched !== 2) {
  console.error('patch-spec: expected exactly 2; the upstream spec changed. Review before continuing.');
  process.exit(1);
}
