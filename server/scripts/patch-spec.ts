// Rewrites the two non-standard `type: int` occurrences in the upstream spec to
// `type: integer` so openapi-typescript emits `number` instead of `unknown`.
// `patchSpec` is pure so the unit test can apply it to the vendored spec in memory; the CLI
// below writes `spec/oas3-api.patched.yaml` (git-ignored) for `openapi-typescript`.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

/** How many `type: int` occurrences the vendored 12.25.11 spec is known to contain. */
export const EXPECTED_INT_OCCURRENCES = 2;

export function patchSpec(yamlText: string): { text: string; patched: number } {
  const doc: unknown = parse(yamlText);
  let patched = 0;
  const walk = (node: unknown): void => {
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
  };
  walk(doc);
  return { text: stringify(doc, { lineWidth: 0 }), patched };
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const src = new URL('../spec/oas3-api.yaml', import.meta.url);
  const out = new URL('../spec/oas3-api.patched.yaml', import.meta.url);
  const { text, patched } = patchSpec(readFileSync(src, 'utf8'));
  writeFileSync(out, text);
  console.error(`patch-spec: rewrote ${patched} 'type: int' occurrence(s)`);
  if (patched !== EXPECTED_INT_OCCURRENCES) {
    console.error(`patch-spec: expected exactly ${EXPECTED_INT_OCCURRENCES}; the upstream spec changed. Review before continuing.`);
    process.exit(1);
  }
}
