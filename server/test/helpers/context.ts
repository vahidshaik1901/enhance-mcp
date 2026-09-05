import { createEnhanceClient } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { AuditLog } from '../../src/core/audit.js';
import type { ToolContext } from '../../src/core/context.js';
import { ConfirmationGate } from '../../src/core/gate.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';
import { Resolver } from '../../src/core/resolver.js';
import { memberships, PANEL_URL, TOKEN } from '../fixtures/panel.js';
import { authGuard, fakeFetch, type FakeFetch, type Route } from './fakeFetch.js';

export interface TestContext {
  ctx: ToolContext;
  f: FakeFetch;
  auditLines: string[];
}

export async function makeContext(routes: Route[], env: Record<string, string> = {}, membershipsBody: unknown = memberships): Promise<TestContext> {
  const f = fakeFetch([authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: membershipsBody }), ...routes]);
  const config = loadConfig({ env: { ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN, ...env }, home: '/tmp' });
  const client = await createEnhanceClient(config, { fetch: f, sleep: async () => undefined });
  const auditLines: string[] = [];
  const ctx: ToolContext = {
    client,
    config,
    resolver: new Resolver(client, () => 0),
    gate: new ConfirmationGate({ now: () => 0 }),
    audit: new AuditLog('/x/audit.jsonl', [TOKEN], (_p, line) => auditLines.push(line)),
    now: () => Date.UTC(2026, 8, 4),
  };
  return { ctx, f, auditLines };
}

export function byName<T extends { name: string }>(tools: T[], name: string): T {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

export async function callTool<A>(tool: ToolDef<A>, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  return tool.handler(tool.input.parse(args), ctx);
}
