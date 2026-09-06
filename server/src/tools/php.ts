import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { siteOf, siteWebsite, websiteArg, type DbSite } from './dbcommon.js';

const domainArg = z.string().min(1).optional().describe('Domain name or UUID; defaults to the primary domain');

/** The website itself comes back alongside the resolved site, because the tools here need its
 *  `canUse` flags (Redis) and the record `resolveDomain` takes (cache_clear). */
async function phpSite(ctx: ToolContext, website: string): Promise<DbSite & { w: Website }> {
  const { org, w } = await siteWebsite(ctx, website);
  return { ...siteOf(ctx, org, w), w };
}

/** The panel caps the error log at 256 KB; this caps what reaches the transcript at 64 KB. */
const MAX_LOG_BYTES = 65_536;

/**
 * The last `max` bytes of a log, cut on a line boundary. The slice is taken on the byte buffer so
 * the cap is the documented one rather than a character count, and the leading partial line is
 * dropped — which also removes the half of a multi-byte character that a byte-boundary cut can
 * leave behind. `bytes` is always the full size the panel returned, not the size of the excerpt.
 */
export function tailLog(text: string, max = MAX_LOG_BYTES): { log: string; bytes: number; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= max) return { log: text, bytes: buf.byteLength, truncated: false };
  const tail = buf.subarray(buf.byteLength - max).toString('utf8');
  const nl = tail.indexOf('\n');
  return { log: nl === -1 ? tail : tail.slice(nl + 1), bytes: buf.byteLength, truncated: true };
}

export const phpExtensionsList = defineTool({
  name: 'php_extensions_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists PHP extensions for a website: enabled now, available to enable, and built in (always on). Use php_extension_enable to turn on one of the available ones.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const path = { path: { website_id: s.id } };
    // `php_extensions` is the *enabled* set; the other two are what could be enabled and what is
    // compiled in. All three are independent reads, so fetch them together.
    const [enabled, available, builtIn] = await Promise.all([
      ctx.client.call('GET', '/websites/{website_id}/php_extensions', () => ctx.client.api.GET('/websites/{website_id}/php_extensions', { params: path })),
      ctx.client.call('GET', '/websites/{website_id}/available_php_extensions', () => ctx.client.api.GET('/websites/{website_id}/available_php_extensions', { params: path })),
      ctx.client.call('GET', '/websites/{website_id}/built_in_php_extensions', () => ctx.client.api.GET('/websites/{website_id}/built_in_php_extensions', { params: path })),
    ]);
    const list = (xs: string[] | undefined): string => (xs ?? []).map(safe).join(', ') || 'none';
    return ok(
      [s.identity, kv([['enabled', list(enabled)], ['available to enable', list(available)], ['built in (always on)', list(builtIn)]])].join('\n'),
      { enabled: enabled ?? [], available: available ?? [], builtIn: builtIn ?? [] },
    );
  },
});

export const phpExtensionEnable = defineTool({
  name: 'php_extension_enable',
  tier: 'customer',
  risk: 'write',
  description: 'Enables a PHP extension for a website (from the available list). Restart PHP after with website_restart_php if a running app needs it.',
  input: z.object({ website: websiteArg, extension: z.string().min(1) }),
  async handler({ website, extension }, ctx) {
    const s = await phpSite(ctx, website);
    // The endpoint takes a bare JSON string, not an object: the body on the wire is `"apcu"`.
    await ctx.client.call('POST', '/websites/{website_id}/php_extensions', () =>
      ctx.client.api.POST('/websites/{website_id}/php_extensions', { params: { path: { website_id: s.id } }, body: extension }),
    );
    return ok(`${s.identity}\nPHP extension ${safe(extension)} enabled. Run website_restart_php if a running app needs it.`, { extension, enabled: true });
  },
});

export const phpExtensionDisable = defineTool({
  name: 'php_extension_disable',
  tier: 'customer',
  risk: 'write',
  description: 'Disables a PHP extension for a website.',
  input: z.object({ website: websiteArg, extension: z.string().min(1) }),
  async handler({ website, extension }, ctx) {
    const s = await phpSite(ctx, website);
    await ctx.client.call('DELETE', '/websites/{website_id}/php_extensions', () =>
      ctx.client.api.DELETE('/websites/{website_id}/php_extensions', { params: { path: { website_id: s.id } }, body: extension }),
    );
    return ok(`${s.identity}\nPHP extension ${safe(extension)} disabled. Run website_restart_php if a running app still has it loaded.`, { extension, enabled: false });
  },
});

export const phpWorkersGet = defineTool({
  name: 'php_workers_get',
  tier: 'customer',
  risk: 'read',
  description: 'Shows the number of PHP workers (LSPHP/LSAPI child processes) for a website: how many PHP requests it can run at once. That count is the only PHP setting tunable at the customer tier; arbitrary php.ini directives are not editable here.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const cfg = await ctx.client.call('GET', '/websites/{website_id}/lsphp_settings', () =>
      ctx.client.api.GET('/websites/{website_id}/lsphp_settings', { params: { path: { website_id: s.id } } }),
    );
    return ok(`${s.identity}\n${kv([['LSAPI children', cfg.lsapiChildren]])}`, { lsapiChildren: cfg.lsapiChildren });
  },
});

export const phpWorkersSet = defineTool({
  name: 'php_workers_set',
  tier: 'customer',
  risk: 'write',
  description: 'Sets the number of LSPHP (LSAPI) child processes for a website. Raising it allows more concurrent PHP requests at the cost of memory.',
  input: z.object({ website: websiteArg, lsapi_children: z.number().int().min(1).max(200) }),
  async handler({ website, lsapi_children }, ctx) {
    const s = await phpSite(ctx, website);
    await ctx.client.call('PUT', '/websites/{website_id}/lsphp_settings', () =>
      ctx.client.api.PUT('/websites/{website_id}/lsphp_settings', { params: { path: { website_id: s.id } }, body: { lsapiChildren: lsapi_children } }),
    );
    return ok(`${s.identity}\nLSAPI children set to ${lsapi_children}.`, { lsapiChildren: lsapi_children });
  },
});

export const phpErrorLog = defineTool({
  name: 'php_error_log',
  tier: 'customer',
  risk: 'read',
  description: 'Returns the PHP error log for a website (the panel keeps the last 256 KB; the newest 64 KB is returned). Empty when there have been no errors.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    // The only text-body read here: the panel sends the log as a JSON string, so read it as text
    // and unwrap the quoting rather than letting a plain-text deployment fail to parse as JSON.
    const raw = await ctx.client.call<string>('GET', '/websites/{website_id}/php_error_log', () =>
      ctx.client.api.GET('/websites/{website_id}/php_error_log', { params: { path: { website_id: s.id } }, parseAs: 'text' }),
    );
    const { log, bytes, truncated } = tailLog(parseScalarText(raw));
    const body =
      log.trim().length === 0
        ? 'PHP error log is empty.'
        : truncated
          ? `PHP error log in structuredContent.log: the newest 64 KB of ${bytes} bytes (truncated; older lines were dropped).`
          : `PHP error log (${bytes} bytes) in structuredContent.log.`;
    return ok(`${s.identity}\n${body}`, { bytes, truncated, log });
  },
});

export const redisStateGet = defineTool({
  name: 'redis_state_get',
  tier: 'customer',
  risk: 'read',
  description: 'Shows whether the per-site Redis instance is on. Redis here is an on/off feature, not a key-value API.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const on = await ctx.client.call('GET', '/v2/websites/{website_id}/redis', () =>
      ctx.client.api.GET('/v2/websites/{website_id}/redis', { params: { path: { website_id: s.id } } }),
    );
    return ok(`${s.identity}\n${kv([['redis', on ? 'on' : 'off']])}`, { redis: on === true });
  },
});

export const redisStateSet = defineTool({
  name: 'redis_state_set',
  tier: 'customer',
  risk: 'write',
  description: 'Turns the per-site Redis instance on or off. Enabling it needs canUse.redis on the plan (see website_get); turning it off always works.',
  input: z.object({ website: websiteArg, enabled: z.boolean() }),
  async handler({ website, enabled }, ctx) {
    const s = await phpSite(ctx, website);
    // Refuse rather than send a request that can only fail. Turning Redis *off* is always allowed:
    // a plan that lost the feature can still need the instance shut down.
    if (enabled && s.w.canUse?.redis !== true) {
      return fail(`${s.identity}\nRedis is not available on this website's plan (canUse.redis is false), so nothing was sent to the panel. Ask the hosting provider to add it to the plan.`, { redis: false, available: false });
    }
    await ctx.client.call('PUT', '/v2/websites/{website_id}/redis', () =>
      ctx.client.api.PUT('/v2/websites/{website_id}/redis', { params: { path: { website_id: s.id } }, body: enabled }),
    );
    return ok(`${s.identity}\nredis turned ${enabled ? 'on' : 'off'}.`, { redis: enabled });
  },
});

export const cacheClear = defineTool({
  name: 'cache_clear',
  tier: 'customer',
  risk: 'write',
  description: "Clears a domain's FastCGI (page) cache. For PHP OPcache, run website_restart_php as well. Defaults to the primary domain.",
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler({ website, domain }, ctx) {
    const s = await phpSite(ctx, website);
    const d = await ctx.resolver.resolveDomain(s.w, domain);
    await ctx.client.call('DELETE', '/v2/domains/{domain_id}/nginx_fastcgi', () =>
      ctx.client.api.DELETE('/v2/domains/{domain_id}/nginx_fastcgi', { params: { path: { domain_id: d.domainId } } }),
    );
    // This is the one tool here that acts on a single domain rather than the whole site, so the
    // identity block names the domain that was cleared, id and all.
    const identity = identityBlock({ name: ctx.client.orgName, id: s.org }, s.w, d);
    return ok(`${identity}\nFastCGI cache cleared for ${safe(d.domain)}. For PHP OPcache, also run website_restart_php.`, { domain: d.domain, domainId: d.domainId, cleared: true });
  },
});

export const tools: ToolDef[] = [phpExtensionsList, phpExtensionEnable, phpExtensionDisable, phpWorkersGet, phpWorkersSet, phpErrorLog, redisStateGet, redisStateSet, cacheClear];
