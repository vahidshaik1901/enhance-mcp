import type { EnhanceClient } from '../client/client.js';
import type { Config } from '../config.js';
import type { AuditLog } from './audit.js';
import type { ConfirmationGate } from './gate.js';
import type { HttpProbe } from './probe.js';
import { safe } from './respond.js';
import type { Resolver } from './resolver.js';

export interface ToolContext {
  client: EnhanceClient;
  config: Config;
  resolver: Resolver;
  gate: ConfirmationGate;
  audit: AuditLog;
  now?: () => number;
  /** Test seam for persistent_app_probe; production falls back to httpsProbe. */
  httpProbe?: HttpProbe;
  /** Test seam for write-then-verify's pauses (core/verify.ts); production waits for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the one request that does not go through the typed API client, the panel's file
   *  service (core/files.ts); production falls back to the global fetch. */
  fetch?: typeof fetch;
}

export class OrgRequiredError extends Error {
  override name = 'OrgRequiredError';
}

/** Returns the active org id or explains which orgs the credential belongs to. */
export function requireOrg(client: EnhanceClient): string {
  if (client.orgId) return client.orgId;
  const options = client.memberships.map((m) => `${safe(m.orgName)} (${m.orgId})`).join('; ') || 'none';
  throw new OrgRequiredError(`This credential belongs to several orgs and no org is selected. Set ENHANCE_ORG_ID to one of: ${options}`);
}
