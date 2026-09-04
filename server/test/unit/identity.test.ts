import { describe, expect, it } from 'vitest';
import { identityBlock, previewDomain, websiteHome } from '../../src/core/identity.js';
import type { DomainMapping, Website } from '../../src/core/resolver.js';
import { domainMappings, ORG_ID, WEBSITE_ID, websiteDetail } from '../fixtures/panel.js';

const site = websiteDetail as unknown as Website;
const primary = domainMappings.items[0] as unknown as DomainMapping;

describe('identityBlock', () => {
  it('prints org, website and domain lines', () => {
    expect(identityBlock({ name: 'Shaik Vahid', id: ORG_ID })).toBe(`org: Shaik Vahid (${ORG_ID})`);
    expect(identityBlock({ name: 'Shaik Vahid', id: ORG_ID }, site)).toBe(`org: Shaik Vahid (${ORG_ID})\nwebsite: vahi.dev (${WEBSITE_ID}) · php84 · active · subscription 686`);
    expect(identityBlock({ id: ORG_ID }, site, primary)).toContain(`domain: vahi.dev (${primary.domainId}) · primary`);
  });
  it('derives home and preview domain', () => {
    expect(websiteHome(site)).toBe(`/var/www/${WEBSITE_ID}`);
    expect(previewDomain(site)).toBe('vahi-dev-ccyq.sgp1.mystaging.site');
    expect(previewDomain({ ...site, aliases: [] })).toBeUndefined();
  });
});
