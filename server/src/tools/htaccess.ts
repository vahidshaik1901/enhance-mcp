import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import { partialFailure, siteOf, siteWebsite, websiteArg, type DbSite } from './dbcommon.js';

/** The site the htaccess tools act on, plus its primary domain: the IP tools quote the domain
 *  back in the undo call and the `curl` verification hint. */
interface HtSite extends DbSite {
  domain: string;
}

async function htSite(ctx: ToolContext, website: string): Promise<HtSite> {
  const { org, w } = await siteWebsite(ctx, website);
  return { ...siteOf(ctx, org, w), domain: w.domain.domain };
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
 * `lineNumber` is how the panel identifies a chain inside the file. The API's update shape also
 * allows a bare line number, which deletes that chain; that is `htaccess_rewrites_delete`'s job,
 * so `rule` stays required here and a `_set` call can never silently remove something.
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

/**
 * Two sentences, both from a live check on this panel (2026-09-06): the panel writes IP rules as
 * an Apache 2.4 `<RequireAny> Require ip ... </RequireAny>` block, and the LiteSpeed server the
 * site runs on ignores that block outright — an allow list naming one address still answered 200
 * to every other IP, on static, PHP and 404 paths alike. `host` is the site's own domain in a
 * response, a placeholder in a static tool description.
 */
function litespeedCaveat(host: string): string {
  return `Caveat: the panel writes this rule as an Apache \`Require ip\` block, which (Open)LiteSpeed servers ignore; that was verified live, where an allow list still served 200 to every other IP. Check any rule with \`curl -o /dev/null -w '%{http_code}' https://${host}/\` from an IP that should be blocked, and do not rely on it as a security control on LiteSpeed.`;
}

/**
 * The caller's own public IP, as the panel sees it. Unauthenticated and advisory only: this is
 * enrichment for a warning, so convention 9 applies and any failure degrades to silence rather
 * than to a failed write. Anything that is not shaped like an address (IPv4/IPv6 characters only)
 * is treated as no answer, so a surprise body never lands in the text as "your current IP".
 */
async function currentClientIp(ctx: ToolContext): Promise<string | null> {
  try {
    const raw = await ctx.client.call<string>('GET', '/client_ip', () => ctx.client.api.GET('/client_ip', { parseAs: 'text' }));
    const ip = parseScalarText(raw);
    return /^[0-9a-f.:]+$/i.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

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
    // `items`, `rule` and `conds` are all required in the spec but the panel is the one filling
    // them in, so all three are guarded the same way: a missing key should degrade to a readable
    // listing (an empty table, a `-` cell), never to a TypeError. `res` itself is optional for the
    // same reason `readCrontab`'s is: a real 204 comes back from `client.call` as undefined.
    const items = res?.items ?? [];
    const rows = items.map((c) => ({ line: c.lineNumber, pattern: c.rule?.pattern, substitution: c.rule?.substitution, flags: (c.rule?.flags ?? []).join(','), conds: (c.conds ?? []).length }));
    return ok([s.identity, `managed rewrite chains (${rows.length}):`, table(rows, ['line', 'pattern', 'substitution', 'flags', 'conds'])].join('\n'), { total: rows.length, items });
  },
});

export const htaccessRewritesSet = defineTool({
  name: 'htaccess_rewrites_set',
  tier: 'customer',
  risk: 'write',
  description: 'Adds or replaces the panel-managed mod_rewrite chains at the given line numbers: the panel merges by lineNumber (verified live), so chains you do not list are kept exactly as they are. Read htaccess_rewrites_get first for the current numbering, and use htaccess_rewrites_delete to remove a chain.',
  input: z.object({ website: websiteArg, items: z.array(rewriteChain) }),
  async handler({ website, items }, ctx) {
    const s = await htSite(ctx, website);
    await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/htaccess', () =>
      ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/htaccess', { params: { path: { org_id: s.org, website_id: s.id } }, body: { items } }),
    );
    const lines = items.map((c) => c.lineNumber).join(', ') || 'none';
    return ok(`${s.identity}\nadded or replaced ${items.length} chain(s) at line(s) ${lines}. Chains not listed are kept; use htaccess_rewrites_delete to remove one.`, { total: items.length });
  },
});

export const htaccessRewritesDelete = defineTool({
  name: 'htaccess_rewrites_delete',
  tier: 'customer',
  risk: 'write',
  description: "Deletes the panel-managed mod_rewrite chains at the given line numbers. Only the chains the panel manages are touched; rules the app ships in its own .htaccess are left alone. Removing a chain can break an app's routing (a front-controller rewrite is what makes its pretty URLs resolve at all), so read htaccess_rewrites_get first and keep a copy of what you remove. The panel renumbers the surviving chains from 1 after every deletion, so this sends one request per line, highest line first; if it reports a partial failure, re-read htaccess_rewrites_get before retrying, because the numbers it took have already moved.",
  input: z.object({ website: websiteArg, line_numbers: z.array(z.number().int().min(1, 'line numbers start at 1')).min(1, 'name at least one line number to delete') }),
  async handler({ website, line_numbers: lineNumbers }, ctx) {
    const s = await htSite(ctx, website);
    // Highest first, one request per line: the panel renumbers what is left from 1 after each
    // delete, so a lower line number sent first would shift every later target up. Sending two
    // bare items in a single PATCH was never verified live, so it is not used.
    const removed = [...new Set(lineNumbers)].sort((a, b) => b - a);
    for (const [i, lineNumber] of removed.entries()) {
      try {
        await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/htaccess', () =>
          ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/htaccess', { params: { path: { org_id: s.org, website_id: s.id } }, body: { items: [{ lineNumber }] } }),
        );
      } catch (e) {
        // One PATCH per line, so a failure lands mid-sequence: say how many chains are already
        // gone. Reporting it as a flat failure would invite a retry with the same numbers, which
        // the panel has renumbered under them.
        throw partialFailure('removed', i, removed.length, lineNumber, e);
      }
    }
    return ok(`${s.identity}\nremoved rewrite chain(s) at line(s) ${removed.join(', ')} (highest first, one request each). The remaining chains are renumbered from 1, so re-read htaccess_rewrites_get before deleting more.`, { removed });
  },
});

export const ipRulesGet = defineTool({
  name: 'ip_rules_get',
  tier: 'customer',
  risk: 'read',
  description: `Shows the website's IP access rule: whether it is an allow list or a block list, and the IPs in it. ${litespeedCaveat('<domain>')}`,
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await htSite(ctx, website);
    const rule = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/htaccess/ips', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/htaccess/ips', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
    // Optional for the same reason the crontab listing is: a real 204 comes back as undefined,
    // and `kind`/`ips` are the panel's to fill in.
    const ips = rule?.ips ?? [];
    return ok(`${s.identity}\n${kv([['mode', rule?.kind], ['ips', ips.map(safe).join(', ') || 'none']])}`, { kind: rule?.kind, ips });
  },
});

export const ipRulesSet = defineTool({
  name: 'ip_rules_set',
  tier: 'customer',
  risk: 'write',
  description: `Sets the website's IP access rule. kind='allow' permits only the listed IPs and gives every other visitor a 403; kind='block' blocks the listed IPs. This replaces the whole rule; kind='block' with an empty list clears it. An allow list that leaves out the human's own IP locks them out of the site. ${litespeedCaveat('<domain>')}`,
  input: z.object({ website: websiteArg, kind: z.enum(['allow', 'block']), ips: z.array(ipArg) }),
  async handler({ website, kind, ips }, ctx) {
    const s = await htSite(ctx, website);
    if (kind === 'allow' && ips.length === 0) {
      return fail(`${s.identity}\nRefusing to set an empty allow list: on a server that enforces the rule it lets nobody in at all, and on one that ignores it it means nothing. Nothing was sent. To clear the rule instead, call ip_rules_set with kind=block and ips=[].`);
    }
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/htaccess/ips', () =>
      ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/htaccess/ips', { params: { path: { org_id: s.org, website_id: s.id } }, body: { kind, ips } }),
    );
    const clientIp = kind === 'allow' ? await currentClientIp(ctx) : null;
    const clientIpListed = clientIp === null ? null : ips.includes(clientIp);
    const host = safe(s.domain);
    const lines = [s.identity, `IP rule set: ${kind} [${ips.map(safe).join(', ') || 'empty'}].`];
    if (kind === 'allow') {
      lines.push(`Every IP that is not in this list now gets 403 on a server that enforces the rule. To undo: ip_rules_set website=${host} kind=block ips=[]`);
      if (clientIpListed === false) lines.push(`Note: your current IP ${safe(clientIp)} is not in this list. CIDR entries are not evaluated by this check, so a range that covers it would not be spotted here.`);
    }
    lines.push(litespeedCaveat(host));
    return ok(lines.join('\n'), { kind, ips, clientIp, clientIpListed });
  },
});

export const tools: ToolDef[] = [htaccessRewritesGet, htaccessRewritesSet, htaccessRewritesDelete, ipRulesGet, ipRulesSet];
