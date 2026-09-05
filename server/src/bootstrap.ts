import { createEnhanceClient, type ClientDeps } from './client/client.js';
import { loadConfig } from './config.js';
import { AuditLog } from './core/audit.js';
import type { ToolContext } from './core/context.js';
import { ConfirmationGate } from './core/gate.js';
import { selectTools, type ToolDef } from './core/registry.js';
import { Resolver } from './core/resolver.js';
import { allTools } from './tools/index.js';

export async function bootstrap(env: NodeJS.ProcessEnv = process.env, deps: ClientDeps = {}): Promise<{ ctx: ToolContext; tools: ToolDef[] }> {
  const config = loadConfig({ env, home: env['HOME'] });
  const client = await createEnhanceClient(config, deps);
  const ctx: ToolContext = {
    client,
    config,
    resolver: new Resolver(client),
    gate: new ConfirmationGate(),
    audit: new AuditLog(config.auditLog, [config.token]),
  };
  const tools = selectTools(allTools, { tiers: config.tiers, readOnly: config.readOnly });
  return { ctx, tools };
}
