import { safe } from '../core/respond.js';

/**
 * The panel's message is free text we do not control (it can echo a domain name straight back). Cap it
 * so an oversized body can't flood a tool result or the audit log, and render it through `safe()`
 * so it can't forge extra lines in either.
 */
export const MAX_API_MESSAGE = 300;

export interface ErrorExplanation {
  code: string;
  explanation: string;
  nextStep: string;
}

export function explainError(status: number, code: string, message?: string): ErrorExplanation {
  const msg = message ?? '';
  if (status === 401 && code === 'invalid_session_token') {
    return { code, explanation: 'The panel session credential is no longer valid (invalid_session_token): it expired or a newer login replaced it. Panel sessions expire on their own or when a newer login replaces them.', nextStep: 'Create an access token under Settings > Access Tokens and put it in ENHANCE_TOKEN, or copy a fresh session credential.' };
  }
  if (status === 401) {
    return { code, explanation: 'No credential reached the panel (no_session_token). This is a configuration problem, not a permissions problem.', nextStep: 'Check ENHANCE_TOKEN and run auth_status.' };
  }
  if (status === 403 && code === 'only_mo_allowed') {
    return { code, explanation: 'This operation is restricted to the master org (platform administrators). It is not available to this account.', nextStep: 'Nothing to do; this is outside the customer tier.' };
  }
  if (status === 403 && /reseller or the MO/i.test(msg)) {
    return { code, explanation: 'This operation is restricted to reseller or master-org accounts. It is not available in the customer tier.', nextStep: 'Nothing to do; ask the hosting provider if you need this.' };
  }
  if (status === 403) {
    return { code, explanation: 'The credential is invalid, expired, IP-restricted, or lacks the role for this endpoint. The panel uses one code for all four.', nextStep: 'Run auth_status. If it also fails, create a new access token in the panel (Settings > Access Tokens) or copy a fresh session credential.' };
  }
  if (status === 404 && /UUID parsing failed/i.test(msg)) {
    return { code, explanation: 'A non-UUID value was sent where the panel expects a UUID. This is an internal bug in the MCP, not a user error.', nextStep: 'Report the tool name and arguments.' };
  }
  if (status === 404) {
    return { code, explanation: 'The target was not found in this org. It may have been deleted, or the name or id is wrong.', nextStep: 'List the parent resource (websites_list, domains_list) and retry with an exact name or id.' };
  }
  if (status === 409) {
    return { code, explanation: 'The resource already exists or is in a conflicting state.', nextStep: 'List existing resources and reuse or rename.' };
  }
  if (status === 429) {
    return { code, explanation: 'The panel rate limit was hit; the client already retried with backoff.', nextStep: 'Wait a few seconds and retry.' };
  }
  if (status >= 500) {
    return { code, explanation: 'Panel error (the request was valid). Reads are safe to retry; writes may or may not have applied.', nextStep: 'Re-read the resource to see whether the change applied before retrying a write.' };
  }
  return { code, explanation: `Unexpected HTTP ${status} from the panel.`, nextStep: 'Inspect the message and retry once.' };
}

export class EnhanceApiError extends Error {
  override name = 'EnhanceApiError';
  /** Panel text, capped at construction; never longer than MAX_API_MESSAGE. */
  readonly apiMessage: string | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    apiMessage: string | undefined,
    readonly method: string,
    readonly path: string,
    readonly retryAfterMs?: number,
  ) {
    const capped = apiMessage === undefined ? undefined : apiMessage.slice(0, MAX_API_MESSAGE);
    super(`${method} ${path} -> HTTP ${status} ${code}${capped ? `: ${safe(capped)}` : ''}`);
    this.apiMessage = capped;
  }

  get explanation(): ErrorExplanation {
    return explainError(this.status, this.code, this.apiMessage);
  }

  toText(): string {
    const e = this.explanation;
    return [
      `Enhance API error on ${this.method} ${this.path}: HTTP ${this.status} (${this.code})`,
      this.apiMessage ? `Panel says: ${safe(this.apiMessage)}` : undefined,
      `Cause: ${e.explanation}`,
      `Next: ${e.nextStep}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  static async fromResponse(response: Response, method: string, path: string): Promise<EnhanceApiError> {
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
    let code = `http_${response.status}`;
    let message: string | undefined;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        const body = JSON.parse(text) as { code?: string; message?: string; detail?: string };
        if (typeof body.code === 'string') code = body.code;
        message = (body.message ?? body.detail)?.slice(0, MAX_API_MESSAGE);
      } catch {
        message = text.slice(0, MAX_API_MESSAGE);
      }
    }
    return new EnhanceApiError(response.status, code, message, method, path, retryAfterMs);
  }
}

export function isEnhanceApiError(e: unknown): e is EnhanceApiError {
  return e instanceof EnhanceApiError;
}
