import type { EnhanceClient } from '../client/client.js';
import type { Config } from '../config.js';
import type { AuditLog } from './audit.js';
import type { ConfirmationGate } from './gate.js';
import type { Resolver } from './resolver.js';

export interface ToolContext {
  client: EnhanceClient;
  config: Config;
  resolver: Resolver;
  gate: ConfirmationGate;
  audit: AuditLog;
}

export class OrgRequiredError extends Error {
  override name = 'OrgRequiredError';
}

/** Returns the active org id or explains which orgs the credential belongs to. */
export function requireOrg(client: EnhanceClient): string {
  if (client.orgId) return client.orgId;
  const options = client.memberships.map((m) => `${m.orgName} (${m.orgId})`).join('; ') || 'none';
  throw new OrgRequiredError(`This credential belongs to several orgs and no org is selected. Set ENHANCE_ORG_ID to one of: ${options}`);
}
