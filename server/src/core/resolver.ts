import type { EnhanceClient } from '../client/client.js';
import type { components } from '../client/generated/types.js';
import { requireOrg } from './context.js';

export type Website = components['schemas']['Website'];
export type DomainMapping = components['schemas']['DomainMapping'];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ResolveError extends Error {
  override name = 'ResolveError';
  constructor(
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(suggestions.length ? `${message} Closest matches: ${suggestions.join(', ')}` : message);
  }
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

export function closest(needle: string, candidates: string[], n: number): string[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => (seen.has(c) ? false : (seen.add(c), true)))
    .map((c) => ({ c, d: levenshtein(needle.toLowerCase(), c.toLowerCase()) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, n)
    .map((x) => x.c);
}

export class Resolver {
  private cache: { at: number; items: Website[] } | undefined;

  constructor(
    private readonly client: EnhanceClient,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  async listWebsites(): Promise<Website[]> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.items;
    const org = requireOrg(this.client);
    const limit = 100;
    const items: Website[] = [];
    for (let offset = 0; ; offset += limit) {
      const page = await this.client.call('GET', '/orgs/{org_id}/websites', () =>
        this.client.api.GET('/orgs/{org_id}/websites', { params: { path: { org_id: org }, query: { showAliases: true, limit, offset } } }),
      );
      items.push(...page.items);
      if (page.items.length < limit || items.length >= page.total) break;
    }
    this.cache = { at: this.now(), items };
    return items;
  }

  async getWebsite(id: string): Promise<Website> {
    const org = requireOrg(this.client);
    return this.client.call('GET', '/orgs/{org_id}/websites/{website_id}', () =>
      this.client.api.GET('/orgs/{org_id}/websites/{website_id}', { params: { path: { org_id: org, website_id: id.toLowerCase() } } }),
    );
  }

  async resolveWebsite(ref: string): Promise<Website> {
    const needle = ref.trim().toLowerCase();
    if (UUID_RE.test(needle)) return this.getWebsite(needle);
    const all = await this.listWebsites();
    const hit = all.find((w) => w.domain.domain.toLowerCase() === needle || w.aliases.some((a) => a.domain.toLowerCase() === needle));
    if (hit) return this.getWebsite(hit.id);
    const names = all.flatMap((w) => [w.domain.domain, ...w.aliases.map((a) => a.domain)]);
    throw new ResolveError(`No website named "${ref}" in org ${this.client.orgName ?? this.client.orgId ?? ''}.`, closest(needle, names, 3));
  }

  async listDomains(websiteId: string): Promise<DomainMapping[]> {
    const org = requireOrg(this.client);
    const res = await this.client.call('GET', '/orgs/{org_id}/websites/{website_id}/domains', () =>
      this.client.api.GET('/orgs/{org_id}/websites/{website_id}/domains', { params: { path: { org_id: org, website_id: websiteId }, query: { withSsl: true } } }),
    );
    return res.items;
  }

  async resolveDomain(website: Website, ref?: string): Promise<DomainMapping> {
    const items = await this.listDomains(website.id);
    if (!ref) {
      const primary = items.find((d) => d.mappingKind === 'primary');
      if (primary) return primary;
      throw new ResolveError(`Website ${website.domain.domain} has no primary domain mapping.`);
    }
    const needle = ref.trim().toLowerCase();
    const hit = items.find((d) => d.domainId.toLowerCase() === needle || d.domain.toLowerCase() === needle);
    if (hit) return hit;
    throw new ResolveError(`No domain "${ref}" on website ${website.domain.domain}.`, closest(needle, items.map((d) => d.domain), 3));
  }
}
