// CI guard: fails when the upstream spec differs from the vendored copy, so a
// panel upgrade becomes a reviewed change instead of a silent one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const UPSTREAM = 'https://apidocs.enhance.com/spec/oas3-api.yaml';
const local = readFileSync(new URL('../spec/oas3-api.yaml', import.meta.url), 'utf8');
const res = await fetch(UPSTREAM);
if (!res.ok) {
  console.error(`check-spec-drift: upstream fetch failed with HTTP ${res.status}`);
  process.exit(2);
}
const upstream = await res.text();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
if (sha(upstream) !== sha(local)) {
  const version = /^\s+version:\s*(\S+)/m.exec(upstream)?.[1] ?? 'unknown';
  console.error(`check-spec-drift: upstream spec (version ${version}) differs from spec/oas3-api.yaml. Re-vendor, run gen:types, review the diff.`);
  process.exit(1);
}
console.error('check-spec-drift: vendored spec matches upstream');
