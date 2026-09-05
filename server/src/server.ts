import { type CallToolResult, CLIENT_CAPABILITIES_META_KEY, type ClientCapabilities, inputRequired, inputResponse, McpServer, type ServerContext } from '@modelcontextprotocol/server';
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

/** The `inputRequests` key our destructive wrapper asks under, and reads back on re-entry. */
const CONFIRM = 'confirm';

export function createServer(ctx: ToolContext, tools: ToolDef[]): McpServer {
  const server = new McpServer({ name: 'enhance', version: VERSION });
  const byName = new Map(tools.map((t) => [t.name, t]));

  /**
   * Whether this client can be asked to prompt its human at all, i.e. whether returning an
   * `inputRequired` result will reach a person rather than fail the call.
   *
   * Mirrors the SDK's own per-request capability view (`_inputRequestCapabilityView`,
   * mcp-DXXb3Vv3.mjs:936), which is the gate our `inputRequired` result is actually judged
   * against, and it differs per era:
   *
   * - 2026-07-28 era (what `serveStdio` serves): the capabilities ride the per-request `_meta`
   *   envelope. `getClientCapabilities()` returns `undefined` there — the instance the entry pins
   *   for the connection never sees an `initialize` — so reading only that accessor would send
   *   every modern-era client down the token path. `RequestMetaEnvelope` is erased to `{}` on the
   *   public surface (createMcpHandler-CLhGwQTn.d.mts:355), hence the cast; the key itself is
   *   public.
   * - 2025 era: no envelope, and the `initialize`-scoped accessor answers.
   *
   * Any `elicitation` declaration qualifies, bare `{}` included. The SDK's gate treats a bare
   * declaration as form support (`isImpliedCapabilityMember`, src-CX2iR2pK.mjs:471) and the 2025
   * wire schema rewrites `{}` to `{ form: {} }` outright while parsing `initialize`
   * (`ElicitationCapabilitySchema`, core/dist/auth-*.mjs:268). Claude Code 2.1.258 sends the bare
   * shape, so it must never be read as "no elicitation".
   */
  function clientCanElicit(extra: ServerContext): boolean {
    const envelope = extra.mcpReq.envelope as Record<string, unknown> | undefined;
    const declared = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ?? server.server.getClientCapabilities();
    return declared?.elicitation !== undefined;
  }

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

  /**
   * A `confirm_action` that never reached its pending tool. Audited under `confirm_action` itself —
   * the pending tool's name is not always known, and when it is, the entry still describes the
   * confirmation step rather than the action. Only `confirm_target` is recorded: the token is a
   * bearer secret and never belongs in the audit log. Unlike `refuse`, a cancellation here is still
   * an `isError` result, because the caller passed a token and needs to know it was not honoured.
   */
  function refuseConfirm(target: Target | undefined, confirmTarget: string, outcome: 'cancelled' | 'error', message: string): CallToolResult {
    ctx.audit.append({ tool: 'confirm_action', risk: 'destructive', target, args: { confirm_target: confirmTarget }, outcome, durationMs: 0, gate: 'token', message: message.slice(0, 300) });
    return toMcp({ text: message, isError: true });
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
        // Re-entry is what the SDK's multi-round-trip flow looks like from inside the callback: the
        // same tool call arrives a second time carrying the client's answers. `inputResponse` (not
        // `acceptedContent`) is the accessor here because it discriminates decline/cancel from a
        // missing answer, which `acceptedContent` collapses into `undefined`
        // (createMcpHandler-CLhGwQTn.d.mts:1459 vs :1495).
        const answer = inputResponse(extra.mcpReq.inputResponses, CONFIRM);
        let target: Target;
        let preview = '';
        try {
          target = await tool.target!(args, ctx);
          // Re-resolving on re-entry keeps the confirmed name pointing at the record we delete;
          // the preview is only needed for the prompt we are about to compose.
          if (answer.kind !== 'elicit') preview = await tool.preview!(args, ctx, target);
        } catch (e) {
          return refuseError(tool, undefined, args, 'none', e);
        }
        const name = safe(target.name);
        // Path A, round 2: the human answered.
        if (answer.kind === 'elicit') {
          if (answer.action !== 'accept') return refuse(tool, target, args, 'cancelled', 'elicitation', `Action cancelled: confirmation ${answer.action === 'decline' ? 'declined' : 'dismissed'} by the user.`);
          const typed = String(answer.content?.['confirm_name'] ?? '');
          if (!ConfirmationGate.matches(target, typed)) return refuse(tool, target, args, 'cancelled', 'elicitation', `Confirmation text "${safe(typed)}" did not match "${name}".`);
          return run(tool, args, target, 'elicitation');
        }
        // Path A, round 1: ask the human to type the name in the client's own prompt. This is the
        // era-proof form of the request: on a 2025-era connection the SDK's default-on legacy shim
        // performs the `elicitation/create` round trip and re-invokes this callback with the answer,
        // and on a 2026-07-28-era connection (what `serveStdio` serves) the client does the same —
        // whereas the push-style `mcpReq.elicitInput` throws outright there
        // (`_assertPushApiInServedEra`, mcp-DXXb3Vv3.mjs:946).
        if (clientCanElicit(extra)) {
          return inputRequired({
            inputRequests: {
              [CONFIRM]: inputRequired.elicit({
                message: `${preview}\n\nType the name "${name}" to confirm.`,
                requestedSchema: { type: 'object', properties: { confirm_name: { type: 'string', title: `Type ${name} to confirm` } }, required: ['confirm_name'] },
              }),
            },
          });
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
          // A name the human got wrong (or a UUID they pasted) is a cancellation: the token is
          // still live and they can retype. Everything else — malformed, unknown, expired, already
          // used — is an error. Either way the attempt is recorded; the target is unknown here
          // because `verify` refused before handing back the pending action.
          const cancelled = e instanceof GateError && (e.reason === 'mismatch' || e.reason === 'uuid');
          return refuseConfirm(undefined, confirm_target, cancelled ? 'cancelled' : 'error', errorText(e));
        }
        const tool = byName.get(pending.tool);
        if (!tool) return refuseConfirm(pending.target, confirm_target, 'error', `Tool ${pending.tool} is no longer registered.`);
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
