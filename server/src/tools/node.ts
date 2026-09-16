import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { defineTool, type ToolDef, type ToolResult } from '../core/registry.js';
import { fail, kv, ok, safe } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { siteOf, siteWebsite, websiteArg, type DbSite } from './dbcommon.js';

/** A Node version the way nvm names it: `22.23.2`, with optional pre-release and build parts. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const semverArg = z.string().regex(SEMVER_RE, 'a Node version like 22.23.2');
/** The API's `NodeVersion` selector: a semver, or the nvm aliases `stable` / `default`. */
export const nodeSelectorArg = z.string().refine((v) => v === 'stable' || v === 'default' || SEMVER_RE.test(v), 'a Node version like 22.23.2, or "stable" or "default"');

/**
 * Node and persistent apps are one plan feature: the panel reports it in `canUse.persistentApps`
 * and every `/apps/node…` and `/apps/persistent…` endpoint answers with an error on a plan without
 * it. Check the flag and say so instead of sending a request that can only fail. "Not enabled"
 * rather than "is false": the block can also be absent.
 */
export function persistentAppsGate(site: DbSite, w: Website, feature = 'Node.js'): ToolResult | undefined {
  if (w.canUse?.persistentApps === true) return undefined;
  return fail(
    `${site.identity}\n${feature} is not enabled for this website's plan (canUse.persistentApps is not true), so nothing was sent to the panel. Ask the hosting provider to add persistent apps to the plan.`,
    { available: false },
  );
}

export type AppsSite = ({ ok: true } & DbSite & { w: Website }) | { ok: false; result: ToolResult };

/** The site plus its full record, or the "not on this plan" result. Gate first, then act. */
export async function appsSite(ctx: ToolContext, website: string, feature = 'Node.js'): Promise<AppsSite> {
  const { org, w } = await siteWebsite(ctx, website);
  const site = siteOf(ctx, org, w);
  const gate = persistentAppsGate(site, w, feature);
  return gate ? { ok: false, result: gate } : { ok: true, ...site, w };
}

/** Newest first. Segments compare numerically; a pre-release sorts after the same release. */
export function compareSemverDesc(a: string, b: string): number {
  const num = (v: string) => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10));
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  }
  return a.includes('-') === b.includes('-') ? 0 : a.includes('-') ? 1 : -1;
}

const nodePath = (id: string) => ({ params: { path: { website_id: id } } });

export const nodeInstall = defineTool({
  name: 'node_install',
  tier: 'customer',
  risk: 'write',
  description: 'Installs nvm and the current stable Node.js into the website container (takes up to a minute). Needed once before any Node app can run; node_version_install then adds other versions. Requires persistent apps on the plan (canUse.persistentApps). Calling it again on a site that already has nvm is a harmless no-op (verified live: the installer exits early on "NVM already installed").',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    await ctx.client.call('POST', '/websites/{website_id}/apps/node', () => ctx.client.api.POST('/websites/{website_id}/apps/node', nodePath(s.id)));
    return ok(
      `${s.identity}\nnvm and the stable Node.js are being installed in the container; allow up to a minute before using them. Next: node_version_install for a specific version, node_version_set_default to pin the default, then persistent_app_create.`,
      { installed: true },
    );
  },
});

export const nodeVersionsAvailable = defineTool({
  name: 'node_versions_available',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the Node.js versions nvm can install on this website, newest first. The text shows the newest release of each major; structuredContent.versions has every one.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    const raw = await ctx.client.call('GET', '/websites/{website_id}/apps/node/possible_versions', () => ctx.client.api.GET('/websites/{website_id}/apps/node/possible_versions', nodePath(s.id)));
    const versions = [...(raw ?? [])].sort(compareSemverDesc);
    // One line per major keeps the transcript short: nvm knows well over a hundred releases.
    const newestPerMajor: string[] = [];
    const seen = new Set<string>();
    for (const v of versions) {
      const major = v.split('.')[0]!;
      if (!seen.has(major)) {
        seen.add(major);
        newestPerMajor.push(v);
      }
    }
    const shown = newestPerMajor.slice(0, 8);
    return ok(
      [s.identity, `${versions.length} versions available (newest of each major shown; the full list is in structuredContent.versions):`, shown.map(safe).join(', ') || 'none'].join('\n'),
      { total: versions.length, versions, newestPerMajor },
    );
  },
});

export const nodeVersionsInstalled = defineTool({
  name: 'node_versions_installed',
  tier: 'customer',
  risk: 'read',
  description: "Lists the Node.js versions the panel reports as installed by nvm on this website. Verified live: this list can lag behind nvm — a version installed and set default through the API was still missing from it — so treat it as a hint. Verified live: the list omits exactly the version nvm's default alias points at; apps that pin a nodeVersion are unaffected. `ssh <user>@<host> '. ~/.nvm/nvm.sh && nvm ls'` is authoritative; never conclude from this tool that a version is absent.",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    const raw = await ctx.client.call('GET', '/websites/{website_id}/apps/node/versions', () => ctx.client.api.GET('/websites/{website_id}/apps/node/versions', nodePath(s.id)));
    const versions = [...(raw ?? [])].sort(compareSemverDesc);
    const list = versions.length ? versions.map(safe).join(', ') : 'none reported';
    return ok(
      [
        s.identity,
        kv([['installed (as reported by the panel)', list]]),
        "This list can lag behind nvm. Verified live: the list omits exactly the version nvm's default alias points at; apps that pin a nodeVersion are unaffected. Confirm over SSH with '. ~/.nvm/nvm.sh && nvm ls' before relying on it, and do not treat a missing version as absent.",
      ].join('\n'),
      { versions, authoritative: false },
    );
  },
});

export const nodeVersionInstall = defineTool({
  name: 'node_version_install',
  tier: 'customer',
  risk: 'write',
  description: 'Installs a specific Node.js version with nvm on this website (takes up to a minute). Pick one from node_versions_available. Does not change the default; run node_version_set_default afterwards.',
  input: z.object({ website: websiteArg, version: semverArg }),
  async handler({ website, version }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    // The endpoint takes a bare JSON string: the body on the wire is `"22.23.2"`.
    await ctx.client.call('POST', '/websites/{website_id}/apps/node/versions', () => ctx.client.api.POST('/websites/{website_id}/apps/node/versions', { ...nodePath(s.id), body: version }));
    return ok(`${s.identity}\nNode.js ${safe(version)} is being installed; allow up to a minute. Run node_version_set_default website=${safe(website)} version=${safe(version)} to make it the default for apps created with node_version "default".`, { version, installed: true });
  },
});

export const nodeVersionSetDefault = defineTool({
  name: 'node_version_set_default',
  tier: 'customer',
  risk: 'write',
  description: "Sets nvm's default Node.js version on this website: a version from node_versions_installed, or \"stable\" / \"default\". Persistent apps created with node_version \"default\" start on this alias; an app that pins a specific version is unaffected. Running apps keep their current process until restarted.",
  input: z.object({ website: websiteArg, version: nodeSelectorArg }),
  async handler({ website, version }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    await ctx.client.call('PUT', '/websites/{website_id}/apps/node/versions/default', () => ctx.client.api.PUT('/websites/{website_id}/apps/node/versions/default', { ...nodePath(s.id), body: version }));
    return ok(`${s.identity}\ndefault Node.js version set to ${safe(version)}. Apps that pin nodeVersion are unaffected; others pick it up when they next start.`, { version, default: true });
  },
});

export const tools: ToolDef[] = [nodeInstall, nodeVersionsAvailable, nodeVersionsInstalled, nodeVersionInstall, nodeVersionSetDefault];
