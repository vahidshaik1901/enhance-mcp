import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import { siteOf, siteWebsite, websiteArg, type DbSite } from './dbcommon.js';

async function htSite(ctx: ToolContext, website: string): Promise<DbSite> {
  const { org, w } = await siteWebsite(ctx, website);
  return siteOf(ctx, org, w);
}

/** One `RewriteCond ... ` line: the string tested, the pattern it is tested against, and the
 *  bracketed flags (`NC`, `OR`, ...). */
const rewriteCond = z.object({
  testString: z.string(),
  condPattern: z.string(),
  flags: z.array(z.string()),
});

/**
 * A rewrite *chain*: zero or more `RewriteCond` lines terminated by the `RewriteRule` they guard.
 * `lineNumber` is how the panel identifies a chain inside the file. The API's update shape allows
 * a bare line number (which deletes that chain) but this tool always sends whole chains, so
 * `rule` stays required: a caller that means to drop a chain leaves it out of the list instead.
 */
const rewriteChain = z.object({
  lineNumber: z.number().int(),
  rule: z.object({ pattern: z.string(), substitution: z.string(), flags: z.array(z.string()) }),
  conds: z.array(rewriteCond).default([]),
});

/** `Require ip` takes IPv4, IPv6 and CIDR ranges alike, so only the shape all three share is
 *  checked: a single non-empty token with no whitespace inside it. The panel is the authority on
 *  whether the address itself parses. */
const ipArg = z
  .string()
  .trim()
  .min(1, 'an IP must not be empty')
  .regex(/^\S+$/, 'an IP must be a single token (IPv4, IPv6 or CIDR) with no spaces');

export const htaccessRewritesGet = defineTool({
  name: 'htaccess_rewrites_get',
  tier: 'customer',
  risk: 'read',
  description: 'Reads the mod_rewrite rules the panel manages for a website (RewriteRule/RewriteCond chains). Rules the app ships in its own .htaccess are not shown here.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await htSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/htaccess', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/htaccess', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
    // `items` is required in the spec but the panel is the one filling it in; a missing key here
    // would only turn a readable listing into a TypeError.
    const items = res.items ?? [];
    const rows = items.map((c) => ({ line: c.lineNumber, pattern: c.rule.pattern, substitution: c.rule.substitution, flags: c.rule.flags.join(','), conds: c.conds.length }));
    return ok([s.identity, `managed rewrite chains (${rows.length}):`, table(rows, ['line', 'pattern', 'substitution', 'flags', 'conds'])].join('\n'), { total: rows.length, items });
  },
});

export const htaccessRewritesSet = defineTool({
  name: 'htaccess_rewrites_set',
  tier: 'customer',
  risk: 'write',
  description: 'REPLACES the panel-managed mod_rewrite chains for a website with the given list. Read htaccess_rewrites_get first and send the full desired set: anything you leave out is dropped.',
  input: z.object({ website: websiteArg, items: z.array(rewriteChain) }),
  async handler({ website, items }, ctx) {
    const s = await htSite(ctx, website);
    await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/htaccess', () =>
      ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/htaccess', { params: { path: { org_id: s.org, website_id: s.id } }, body: { items } }),
    );
    return ok(`${s.identity}\nreplaced the managed rewrite chains (${items.length} chain(s) sent).`, { total: items.length });
  },
});

export const ipRulesGet = defineTool({
  name: 'ip_rules_get',
  tier: 'customer',
  risk: 'read',
  description: "Shows the website's IP access rule: whether it is an allow list or a block list, and the IPs in it.",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await htSite(ctx, website);
    const rule = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/htaccess/ips', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/htaccess/ips', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
    const ips = rule.ips ?? [];
    return ok(`${s.identity}\n${kv([['mode', rule.kind], ['ips', ips.map(safe).join(', ') || 'none']])}`, { kind: rule.kind, ips });
  },
});

export const ipRulesSet = defineTool({
  name: 'ip_rules_set',
  tier: 'customer',
  risk: 'write',
  description: "Sets the website's IP access rule. kind='allow' permits only the listed IPs and blocks the rest; kind='block' blocks the listed IPs. This replaces the whole rule; an empty list clears it. Warning: an allow list that does not include the human's own IP locks them out of the site.",
  input: z.object({ website: websiteArg, kind: z.enum(['allow', 'block']), ips: z.array(ipArg) }),
  async handler({ website, kind, ips }, ctx) {
    const s = await htSite(ctx, website);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/htaccess/ips', () =>
      ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/htaccess/ips', { params: { path: { org_id: s.org, website_id: s.id } }, body: { kind, ips } }),
    );
    return ok(`${s.identity}\nIP rule set: ${kind} [${ips.map(safe).join(', ') || 'empty'}].`, { kind, ips });
  },
});

export const tools: ToolDef[] = [htaccessRewritesGet, htaccessRewritesSet, ipRulesGet, ipRulesSet];
