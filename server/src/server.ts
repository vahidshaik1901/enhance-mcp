import { type CallToolResult, type ElicitResult, McpServer, SdkError, SdkErrorCode, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { EnhanceApiError } from './client/errors.js';
import type { ToolContext } from './core/context.js';
import { ConfirmationGate, GateError, type GateMechanism } from './core/gate.js';
import type { Target, ToolDef, ToolResult } from './core/registry.js';
import { ResolveError } from './core/resolver.js';
import { safe } from './core/respond.js';
import { VERSION } from './version.js';

export function errorText(e: unknown): string {
  if (e instanceof EnhanceApiError) return e.toText();
  if (e instanceof ResolveError || e instanceof GateError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * `CallToolResult` (not a hand-rolled shape): the SDK's tool callback return type is
 * `CallToolResult | InputRequiredResult`, and both carry a `[x: string]: unknown` index
 * signature that a plain interface cannot satisfy. No `outputSchema` is declared anywhere
 * (Claude Code has known issues with it), so `structuredContent` travels unvalidated —
 * and unwrapped, since every payload here is a plain object (see the wire codec's
 * `projectCallToolResult`, which only wraps non-object structured content).
 */
function toMcp(r: ToolResult): CallToolResult {
  return { content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), ...(r.isError ? { isError: true } : {}) };
}

/**
 * True when `elicitInput` failed because this connection cannot prompt the human at all,
 * rather than because the human answered badly — the signal to fall back to the token path.
 *
 * Two SDK v2 codes qualify (see node_modules/@modelcontextprotocol/server/dist/mcp-*.mjs):
 * `CAPABILITY_NOT_SUPPORTED` ("Client does not support form elicitation.") when the client
 * never declared `elicitation.form`, and `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` when the
 * connection negotiated the 2026-07-28 era, which removed server-to-client requests entirely.
 * The message test is a fallback for a duplicated/older SDK copy whose class identity differs.
 */
function cannotElicit(e: unknown): boolean {
  if (SdkError.isInstance(e)) return e.code === SdkErrorCode.CapabilityNotSupported || e.code === SdkErrorCode.MethodNotSupportedByProtocolVersion;
  const message = String((e as { message?: unknown } | undefined)?.message ?? '');
  return /does not support .*elicitation|elicitation.*not supported|CAPABILITY_NOT_SUPPORTED|Server-to-client requests are not available/i.test(message);
}

export function createServer(ctx: ToolContext, tools: ToolDef[]): McpServer {
  const server = new McpServer({ name: 'enhance', version: VERSION });
  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Runs the tool for real. Audits every write/destructive outcome; reads are not audited. */
  async function run(tool: ToolDef, args: Record<string, unknown>, target: Target | undefined, gate: GateMechanism): Promise<CallToolResult> {
    const started = Date.now();
    try {
      const result = await tool.handler(args, ctx, target);
      if (tool.risk !== 'read') {
        ctx.audit.append({
          tool: tool.name,
          risk: tool.risk,
          target,
          args,
          outcome: result.isError ? 'error' : 'ok',
          durationMs: Date.now() - started,
          gate,
          message: result.isError ? result.text.slice(0, 300) : undefined,
        });
      }
      return toMcp(result);
    } catch (e) {
      if (tool.risk !== 'read') {
        ctx.audit.append({
          tool: tool.name,
          risk: tool.risk,
          target,
          args,
          outcome: 'error',
          status: e instanceof EnhanceApiError ? e.status : undefined,
          durationMs: Date.now() - started,
          gate,
          message: errorText(e).slice(0, 300),
        });
      }
      return toMcp({ text: errorText(e), isError: true });
    }
  }

  /** A destructive call that never reached the panel: recorded, then reported as a plain result. */
  function refuse(tool: ToolDef, target: Target | undefined, args: Record<string, unknown>, outcome: 'cancelled' | 'error', gate: GateMechanism, reason: string, status?: number): CallToolResult {
    ctx.audit.append({ tool: tool.name, risk: tool.risk, target, args, outcome, status, durationMs: 0, gate, message: reason.slice(0, 300) });
    if (outcome === 'error') return toMcp({ text: reason, isError: true });
    return toMcp({ text: `${reason} Nothing was changed.`, structured: { cancelled: true, reason } });
  }

  /** Same as `refuse(..., 'error', ...)`, carrying the panel's HTTP status when there was one. */
  function refuseError(tool: ToolDef, target: Target | undefined, args: Record<string, unknown>, gate: GateMechanism, e: unknown): CallToolResult {
    return refuse(tool, target, args, 'error', gate, errorText(e), e instanceof EnhanceApiError ? e.status : undefined);
  }

  for (const tool of tools) {
    const annotations = { readOnlyHint: tool.risk === 'read', destructiveHint: tool.risk === 'destructive', idempotentHint: tool.risk === 'read', openWorldHint: true };
    if (tool.risk !== 'destructive') {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations }, async (args) => run(tool, args as Record<string, unknown>, undefined, 'none'));
      continue;
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations,
        // Marks the tool for user approval in Claude Code. `registerTool`'s config type declares
        // `_meta?: Record<string, unknown>`, so no cast is needed on SDK v2.
        _meta: { 'anthropic/requiresUserInteraction': true },
      },
      async (rawArgs, extra: ServerContext) => {
        const args = rawArgs as Record<string, unknown>;
        let target: Target;
        let preview: string;
        try {
          target = await tool.target!(args, ctx);
          preview = await tool.preview!(args, ctx, target);
        } catch (e) {
          return refuseError(tool, undefined, args, 'none', e);
        }
        const name = safe(target.name);
        // Path A: elicitation — the human types the name in the client's own prompt. Only the
        // elicitInput call sits in the try, so a failure inside run() can never be mistaken for
        // "this client cannot prompt" and fall through to the token path.
        let answer: ElicitResult | undefined;
        try {
          answer = await extra.mcpReq.elicitInput({
            mode: 'form',
            message: `${preview}\n\nType the name "${name}" to confirm.`,
            requestedSchema: { type: 'object', properties: { confirm_name: { type: 'string', title: `Type ${name} to confirm` } }, required: ['confirm_name'] },
          });
        } catch (e) {
          if (!cannotElicit(e)) return refuseError(tool, target, args, 'elicitation', e);
        }
        if (answer) {
          if (answer.action !== 'accept') return refuse(tool, target, args, 'cancelled', 'elicitation', `Action cancelled: confirmation ${answer.action === 'decline' ? 'declined' : 'dismissed'} by the user.`);
          const typed = String(answer.content?.['confirm_name'] ?? '');
          if (!ConfirmationGate.matches(target, typed)) return refuse(tool, target, args, 'cancelled', 'elicitation', `Confirmation text "${safe(typed)}" did not match "${name}".`);
          return run(tool, args, target, 'elicitation');
        }
        // Path B: the client cannot prompt the human; hand back a token for confirm_action.
        const token = ctx.gate.issue(tool.name, target, args);
        const text = [
          preview,
          '',
          'DESTRUCTIVE ACTION, NOT EXECUTED.',
          `Ask the user to confirm by typing the exact name "${name}". Do not type it yourself.`,
          'Then call confirm_action with confirmation_token and confirm_target set to what the user typed.',
          `confirmation_token: ${token}`,
          `expires in ${Math.round(ctx.gate.ttlMs / 60_000)} minutes, single use.`,
        ].join('\n');
        return toMcp({ text, structured: { confirmation_required: true, confirmation_token: token, confirm_target_hint: target.name, tool: tool.name } });
      },
    );
  }

  if (tools.some((t) => t.risk === 'destructive')) {
    server.registerTool(
      'confirm_action',
      {
        description:
          'Second step of a destructive action when the client cannot prompt the user directly. Pass the confirmation_token from the previous destructive call and confirm_target exactly as the human typed it (the domain name, never a UUID). Never call this without the human having typed the name.',
        inputSchema: z.object({ confirmation_token: z.string().min(10), confirm_target: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        _meta: { 'anthropic/requiresUserInteraction': true },
      },
      async ({ confirmation_token, confirm_target }) => {
        let pending;
        try {
          pending = ctx.gate.verify(confirmation_token, confirm_target);
        } catch (e) {
          return toMcp({ text: errorText(e), isError: true });
        }
        const tool = byName.get(pending.tool);
        if (!tool) return toMcp({ text: `Tool ${pending.tool} is no longer registered.`, isError: true });
        // Re-resolve before executing: if the name now points at a different record (recreated,
        // renamed, moved) the human's confirmation no longer applies to what we would delete.
        let target: Target;
        try {
          target = await tool.target!(pending.args, ctx);
        } catch (e) {
          return refuseError(tool, pending.target, pending.args, 'token', e);
        }
        if (target.id !== pending.target.id) {
          return refuse(tool, pending.target, pending.args, 'error', 'token', `The target changed since the token was issued (${pending.target.id} vs ${target.id}). Start again.`);
        }
        return run(tool, pending.args, target, 'token');
      },
    );
  }

  return server;
}
