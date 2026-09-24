import { createEnhanceClient } from '../../src/client/client.js';
import { createLimiter } from '../../src/client/ratelimit.js';
import { loadConfig } from '../../src/config.js';
import { AuditLog } from '../../src/core/audit.js';
import type { ToolContext } from '../../src/core/context.js';
import { ConfirmationGate } from '../../src/core/gate.js';
import type { HttpProbe } from '../../src/core/probe.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';
import { Resolver } from '../../src/core/resolver.js';
import { memberships, PANEL_URL, TOKEN } from '../fixtures/panel.js';
import { authGuard, fakeFetch, type FakeFetch, type Route } from './fakeFetch.js';

export interface TestContext {
  ctx: ToolContext;
  f: FakeFetch;
  auditLines: string[];
}

/** The unit suite's default HTTP probe: every path answers 404, the "nothing serves this" case. */
const noProbe: HttpProbe = async () => ({ status: 404, latencyMs: 1, contentType: 'text/html', body: '', certificate: 'valid', location: null });

export async function makeContext(routes: Route[], env: Record<string, string> = {}, membershipsBody: unknown = memberships): Promise<TestContext> {
  const f = fakeFetch([authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: membershipsBody }), ...routes]);
  // `readFile: () => undefined` is loadConfig's "no profile file" answer (see loadProfile), so a
  // stray /tmp/.enhance-mcp/config.json on a developer machine can never leak into these tests.
  const config = loadConfig({ env: { ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN, ...env }, readFile: () => undefined, home: '/tmp' });
  // The limiter's 5 rps pacing waits for real by default: 200 ms per request, which put a 90 s
  // write-then-verify test (about 20 requests) at 4 s of vitest's 5 s timeout. Tests never wait.
  const client = await createEnhanceClient(config, { fetch: f, sleep: async () => undefined, limiter: createLimiter({ sleep: async () => undefined }) });
  const auditLines: string[] = [];
  const ctx: ToolContext = {
    client,
    config,
    resolver: new Resolver(client, () => 0),
    gate: new ConfirmationGate({ now: () => 0 }),
    audit: new AuditLog('/x/audit.jsonl', [TOKEN], (_p, line) => auditLines.push(line)),
    now: () => Date.UTC(2026, 8, 4),
    // Write-then-verify re-reads without waiting, and the file service answers from the same fake
    // routes as the API.
    sleep: async () => undefined,
    fetch: f,
    // Without this, a create or update with a proxy path sent its path preflight to the real app
    // server (SERVER_IP) from the unit suite. Every path is free here unless a test says otherwise.
    httpProbe: noProbe,
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
