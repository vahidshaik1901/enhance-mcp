import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPECTED_INT_OCCURRENCES, patchSpec } from '../../scripts/patch-spec.js';

const vendored = new URL('../../spec/oas3-api.yaml', import.meta.url);
const generated = new URL('../../src/client/generated/types.ts', import.meta.url);

describe('vendored spec', () => {
  // Applied in memory: the patched file is a git-ignored build artifact and does not exist in CI.
  it('has no non-standard `type: int` after patching', () => {
    const source = readFileSync(vendored, 'utf8');
    expect(source).toMatch(/^\s+type: int$/m);
    const { text, patched } = patchSpec(source);
    expect(patched).toBe(EXPECTED_INT_OCCURRENCES);
    expect(text).not.toMatch(/^\s+type: int$/m);
  });

  it('generated types cover the milestone A paths', () => {
    const text = readFileSync(generated, 'utf8');
    for (const p of [
      '"/login/memberships"',
      '"/orgs/{org_id}/websites"',
      '"/orgs/{org_id}/websites/{website_id}/domains"',
      '"/orgs/{org_id}/websites/{website_id}/ssh/keys"',
      '"/v2/domains/{domain_id}/letsencrypt"',
      '"/orgs/{org_id}/domains/check"',
    ]) {
      expect(text).toContain(p);
    }
  });

  it('records the spec version', () => {
    const v = readFileSync(new URL('../../spec/VERSION', import.meta.url), 'utf8').trim();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
