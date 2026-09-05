import { detectAuthMode } from './client/auth.js';
import { createEnhanceClient, type ClientDeps } from './client/client.js';
import { ConfigError, loadConfig, redactSecret } from './config.js';
import { safe } from './core/respond.js';
import { VERSION } from './version.js';

export async function runDoctor(env: NodeJS.ProcessEnv = process.env, deps: ClientDeps = {}, out: (line: string) => void = (l) => console.error(l)): Promise<number> {
  out(`enhance-mcp doctor ${VERSION}`);
  let failed = false;
  const okLine = (s: string) => out(`ok  ${s}`);
  const failLine = (s: string) => {
    failed = true;
    out(`FAIL ${s}`);
  };

  let config;
  try {
    config = loadConfig({ env, home: env['HOME'] });
    okLine(`config: panel ${config.panelUrl}, credential ${redactSecret(config.token)}, tiers ${config.tiers.join(',')}, read-only ${config.readOnly ? 'yes' : 'no'}`);
  } catch (e) {
    failLine(`config: ${e instanceof ConfigError ? e.message : String(e)}`);
    return 1;
  }

  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(`${config.apiBase}/version`, { signal: AbortSignal.timeout(config.timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The spec labels this application/json, but the panel serves it as a bare, unquoted
    // text/plain string (e.g. "12.25.5", which is not valid JSON on its own). Try JSON first
    // for the fixture-driven tests, then fall back to the raw text for the real panel.
    const raw = await res.text();
    let panelVersion: string;
    try {
      panelVersion = JSON.parse(raw) as string;
    } catch {
      panelVersion = raw;
    }
    okLine(`panel reachable (${safe(panelVersion)})`);
  } catch (e) {
    failLine(`panel unreachable at ${config.apiBase}/version: ${(e as Error).message}`);
    return 1;
  }

  try {
    const { mode } = await detectAuthMode(fetchFn, config.apiBase, config.token);
    okLine(`credential: ${mode}${mode === 'cookie' ? ' (panel session; it can expire on logout, prefer an access token)' : ''}`);
  } catch (e) {
    failLine(`credential: ${(e as Error).message}`);
    return 1;
  }

  try {
    const client = await createEnhanceClient(config, deps);
    if (client.orgId) okLine(`org: ${safe(client.orgName)} (${client.orgId})`);
    else failLine(`org: credential spans ${client.memberships.length} orgs; set ENHANCE_ORG_ID to one of ${client.memberships.map((m) => m.orgId).join(', ')}`);
    if (client.orgId) {
      const org = client.orgId;
      if (client.authMode === 'bearer') {
        const tokens = await client.call('GET', '/orgs/{org_id}/access_tokens', () => client.api.GET('/orgs/{org_id}/access_tokens', { params: { path: { org_id: org } } }));
        const mine = tokens.find((t) => config!.token.startsWith(t.firstFive));
        if (mine) okLine(`access token "${safe(mine.friendlyName ?? '(unnamed)')}" roles ${mine.roles.join(',')} expires ${mine.tokenExpires ?? 'never'}`);
        else okLine('access token not listed in this org (may belong to a parent org)');
      }
      const subs = await client.call('GET', '/orgs/{org_id}/subscriptions', () => client.api.GET('/orgs/{org_id}/subscriptions', { params: { path: { org_id: org } } }));
      okLine(`subscriptions: ${subs.total}`);
      const sites = await client.call('GET', '/orgs/{org_id}/websites', () => client.api.GET('/orgs/{org_id}/websites', { params: { path: { org_id: org }, query: { limit: 1 } } }));
      okLine(`websites: ${sites.total}`);
    }
  } catch (e) {
    failLine(`api: ${(e as Error).message}`);
  }

  out(failed ? 'doctor: problems found' : 'doctor: all good');
  return failed ? 1 : 0;
}
