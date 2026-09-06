import * as z from 'zod/v4';
import { requireOrg, type ToolContext } from '../core/context.js';
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
