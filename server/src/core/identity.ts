import type { DomainMapping, Website } from './resolver.js';

export function websiteHome(website: Website): string {
  return `/var/www/${website.id}`;
}

export function previewDomain(website: Website): string | undefined {
  return website.aliases.find((a) => a.kind === 'preview')?.domain;
}

export function identityBlock(org: { name?: string; id: string }, website?: Website, domain?: DomainMapping): string {
  const lines = [`org: ${org.name ? `${org.name} ` : ''}(${org.id})`];
  if (website) {
    const bits = [website.phpVersion, website.status, website.subscriptionId !== undefined ? `subscription ${website.subscriptionId}` : undefined].filter(Boolean);
    lines.push(`website: ${website.domain.domain} (${website.id})${bits.length ? ` · ${bits.join(' · ')}` : ''}`);
  }
  if (domain) lines.push(`domain: ${domain.domain} (${domain.domainId}) · ${domain.mappingKind}`);
  return lines.join('\n');
}
