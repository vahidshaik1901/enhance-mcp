import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';

export const TIERS = ['customer', 'reseller', 'platform'] as const;
export type Tier = (typeof TIERS)[number];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const Schema = z.object({
  panelUrl: z.url({ error: 'ENHANCE_PANEL_URL must be a full URL such as https://panel.example.com' }).transform((u) => u.replace(/\/+$/, '')),
  token: z.string().min(10, { error: 'ENHANCE_TOKEN is missing or too short' }),
  orgId: z.uuid({ error: 'ENHANCE_ORG_ID must be a UUID' }).optional(),
  tiers: z.array(z.enum(TIERS, { error: 'ENHANCE_TIERS may only contain customer, reseller, platform' })).min(1).default(['customer']),
  readOnly: z.boolean().default(false),
  auditLog: z.string().min(1),
  timeoutMs: z.number().int().positive().default(30_000),
});

export interface Config extends z.infer<typeof Schema> {
  apiBase: string;
}

export interface ConfigSource {
  env: Record<string, string | undefined>;
  readFile?: (path: string) => string | undefined;
  home?: string;
}

interface Profile {
  panelUrl?: string;
  token?: string;
  orgId?: string;
  tiers?: string[];
  readOnly?: boolean;
  auditLog?: string;
  timeoutMs?: number;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function loadProfile(env: ConfigSource['env'], readFile: NonNullable<ConfigSource['readFile']>, home: string): Profile {
  const text = readFile(join(home, '.enhance-mcp', 'config.json'));
  if (!text) return {};
  let parsed: { profiles?: Record<string, Profile> };
  try {
    parsed = JSON.parse(text) as { profiles?: Record<string, Profile> };
  } catch (e) {
    throw new ConfigError(`~/.enhance-mcp/config.json is not valid JSON: ${(e as Error).message}`);
  }
  const name = env['ENHANCE_PROFILE'] ?? 'default';
  const profile = parsed.profiles?.[name];
  if (env['ENHANCE_PROFILE'] && !profile) throw new ConfigError(`profile "${name}" not found in ~/.enhance-mcp/config.json`);
  return profile ?? {};
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function loadConfig({ env, readFile = defaultReadFile, home = homedir() }: ConfigSource): Config {
  const profile = loadProfile(env, readFile, home);
  const raw = stripUndefined({
    panelUrl: env['ENHANCE_PANEL_URL'] ?? profile.panelUrl,
    token: env['ENHANCE_TOKEN'] ?? profile.token,
    orgId: env['ENHANCE_ORG_ID'] ?? profile.orgId,
    tiers: env['ENHANCE_TIERS'] ? env['ENHANCE_TIERS'].split(',').map((s) => s.trim()).filter(Boolean) : profile.tiers,
    readOnly: parseBool(env['ENHANCE_READ_ONLY']) ?? profile.readOnly,
    auditLog: env['ENHANCE_AUDIT_LOG'] ?? profile.auditLog ?? join(home, '.enhance-mcp', 'audit.jsonl'),
    timeoutMs: env['ENHANCE_TIMEOUT_MS'] ? Number(env['ENHANCE_TIMEOUT_MS']) : profile.timeoutMs,
  });
  if (!raw.panelUrl || !raw.token) {
    const missing = [!raw.panelUrl && 'ENHANCE_PANEL_URL', !raw.token && 'ENHANCE_TOKEN'].filter(Boolean).join(' and ');
    throw new ConfigError(`Missing ${missing}. Set them in the environment or in ~/.enhance-mcp/config.json under profiles.default.`);
  }
  const result = Schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return { ...result.data, apiBase: `${result.data.panelUrl}/api` };
}

export function redactSecret(secret: string): string {
  return secret.length > 5 ? `${secret.slice(0, 5)}…` : '…';
}
