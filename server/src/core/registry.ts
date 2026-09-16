import type * as z from 'zod/v4';
import type { ToolContext } from './context.js';

export type Tier = 'customer' | 'reseller' | 'platform';
export type Risk = 'read' | 'write' | 'destructive';

export interface Target {
  kind: 'website' | 'domain' | 'ssh_key' | 'mysql_db' | 'mysql_user' | 'pg_db' | 'pg_user' | 'crontab';
  id: string;
  /** Human name the user must type to confirm (domain name, never a UUID). */
  name: string;
}

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDef<A = any> {
  name: string;
  tier: Tier;
  risk: Risk;
  description: string;
  input: z.ZodType<A>;
  handler: (args: A, ctx: ToolContext, target?: Target) => Promise<ToolResult>;
  /** Required for destructive tools: resolves what will be affected. Throw to refuse. */
  target?: (args: A, ctx: ToolContext) => Promise<Target>;
  /** Required for destructive tools: human-readable summary shown before confirmation. */
  preview?: (args: A, ctx: ToolContext, target: Target) => Promise<string>;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function defineTool<A>(def: ToolDef<A>): ToolDef<A> {
  if (!NAME_RE.test(def.name)) throw new Error(`tool name "${def.name}" must be snake_case`);
  if (def.risk === 'destructive' && (!def.target || !def.preview)) {
    throw new Error(`destructive tool "${def.name}" must define target() and preview()`);
  }
  return def;
}

export function selectTools(all: ToolDef[], opts: { tiers: Tier[]; readOnly: boolean }): ToolDef[] {
  return all.filter((t) => opts.tiers.includes(t.tier) && (!opts.readOnly || t.risk === 'read'));
}
