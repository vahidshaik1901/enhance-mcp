import * as z from 'zod/v4';
import { requireOrg, type ToolContext } from '../core/context.js';
import type { Website } from '../core/resolver.js';

export const websiteArg = z.string().min(1).describe('Website domain name (primary or alias) or website UUID');

/** The panel prefixes every database and database-user name with `<unixUser>_`. Accept either the
 *  short name the user types or the full prefixed name, and always return the full form. */
function prefixed(unixUser: string, input: string): string {
  const name = input.trim();
  if (name.length === 0) throw new Error('database name must not be empty');
  const prefix = `${unixUser}_`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export function resolveDbName(unixUser: string, input: string): string {
  return prefixed(unixUser, input);
}

export function resolveDbUser(unixUser: string, input: string): string {
  return prefixed(unixUser, input);
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
