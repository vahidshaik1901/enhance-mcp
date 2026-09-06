import { randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import { requireOrg, type ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import type { Target } from '../core/registry.js';
import { safe } from '../core/respond.js';
import type { Website } from '../core/resolver.js';

export const websiteArg = z.string().min(1).describe('Website domain name (primary or alias) or website UUID');

/** The panel prefixes every database and database-user name with `<unixUser>_`. Accept either the
 *  short name the user types or the full prefixed name, and always return the full form. The bare
 *  prefix is rejected like an empty string: it names nothing, and the panel would take it. */
function prefixed(unixUser: string, input: string, label: 'database name' | 'user name'): string {
  const name = input.trim();
  const prefix = `${unixUser}_`;
  if (name.length === 0 || name === prefix) throw new Error(`${label} must not be empty`);
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export function resolveDbName(unixUser: string, input: string): string {
  return prefixed(unixUser, input, 'database name');
}

export function resolveDbUser(unixUser: string, input: string): string {
  return prefixed(unixUser, input, 'user name');
}

/** Databases and database users live under the website's unix user, so a site without one (a
 *  kind that has no container, or one still being provisioned) has none. Fail loudly rather than
 *  prefixing with a bare `_` and creating or deleting something the user never named. */
export function unixUserOf(w: Website): string {
  if (!w.unixUser) throw new Error('this website has no unix user; databases are not available for it');
  return w.unixUser;
}

export const MYSQL_GRANTS = [
  'all', 'alter', 'alterRoutine', 'create', 'createRoutine', 'createTablespace',
  'createTemporaryTables', 'createView', 'delete', 'drop', 'event', 'execute', 'index',
  'insert', 'lockTables', 'references', 'select', 'showView', 'trigger', 'update',
] as const;

export async function siteWebsite(ctx: ToolContext, ref: string): Promise<{ org: string; w: Website }> {
  const org = requireOrg(ctx.client);
  const w = await ctx.resolver.resolveWebsite(ref);
  return { org, w };
}

/** The by-id form, for convention 12: a destructive `preview()`/`handler()` re-reads the website
 *  the `target()` already pinned instead of resolving the user's string a second time, so the
 *  preview and the confirmed action cannot drift onto a different site. */
export async function siteWebsiteById(ctx: ToolContext, id: string): Promise<{ org: string; w: Website }> {
  const org = requireOrg(ctx.client);
  const w = await ctx.resolver.getWebsite(id);
  return { org, w };
}

export interface DbSite {
  org: string;
  id: string;
  identity: string;
}

/** A site plus its unix user, for the tools that have to build a `<unixUser>_` prefixed name. */
export interface DbSiteWithUser extends DbSite {
  unixUser: string;
}

export function siteOf(ctx: ToolContext, org: string, w: Website): DbSite {
  return { org, id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

/**
 * Convention 12: a destructive `preview()`/`handler()` acts on the target it was handed. The
 * target id is `<websiteId>:<full db or user name>`, so split it and re-read that website by id
 * rather than resolving the user's `website` string again — otherwise the preview the human
 * confirmed and the drop that follows could land on different sites. The re-read website comes
 * back too, for the callers that must re-check a plan feature (PostgreSQL) or the unix user on
 * the site the target pinned.
 */
export async function dbTargetSite(ctx: ToolContext, target: Target): Promise<{ site: DbSite; name: string; website: Website }> {
  const cut = target.id.indexOf(':');
  if (cut <= 0) throw new Error(`malformed database target "${safe(target.id)}"`);
  const { org, w } = await siteWebsiteById(ctx, target.id.slice(0, cut));
  // No unix user is looked up here: the name is already the full prefixed one carried by
  // `target.id`, so only the create/user-facing paths need the prefix.
  return { site: siteOf(ctx, org, w), name: target.id.slice(cut + 1), website: w };
}

/**
 * A password for a database login the human never types: 24 random bytes (192 bits) as base64url,
 * which is always exactly 32 characters and, unlike base64, never contains `+`, `/` or `=` — so
 * nothing is stripped and the length is fixed rather than probabilistic. The `Db`/`9x` frame
 * guarantees an upper case letter, a lower case one and a digit for any password policy (the live
 * panel enforces none), and every character is safe unquoted in a `.env` file and inside shell
 * double quotes: no `!`, `$`, backtick or quote. Always 36 characters. Shared by the MySQL and
 * PostgreSQL user tools.
 */
export function generatePassword(): string {
  return `Db${randomBytes(24).toString('base64url')}9x`;
}
