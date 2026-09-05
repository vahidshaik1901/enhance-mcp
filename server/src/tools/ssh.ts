import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { isEnhanceApiError } from '../client/errors.js';
import type { components } from '../client/generated/types.js';
import { requireOrg, type ToolContext } from '../core/context.js';
import { identityBlock, websiteHome } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';

type SshKey = components['schemas']['SshKey'];

const websiteArg = z.string().min(1).describe('Website domain name (primary or alias) or website UUID');
const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[ \t]+([A-Za-z0-9+/]+=*)(?:[ \t]+([^\r\n]*))?$/;

export interface ParsedKey {
  type: string;
  blob: string;
  comment?: string;
}

export function parsePublicKey(text: string): ParsedKey {
  const m = KEY_RE.exec(text.trim());
  if (!m) throw new Error('Not an OpenSSH public key. Expected "ssh-ed25519 AAAA... comment" (the .pub file), never a private key.');
  return { type: m[1]!, blob: m[2]!, comment: m[3]?.trim() || undefined };
}

/** SHA256 fingerprint of a base64 key blob, OpenSSH-style: "SHA256:" + unpadded base64 digest. */
export function fingerprint(blob: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

function conn(w: Website): { user: string | undefined; host: string | undefined; port: number; home: string; documentRoot: string } {
  const host = (w.serverIps?.find((s) => s.isPrimary) ?? w.serverIps?.[0])?.ip ?? undefined;
  return { user: w.unixUser ?? undefined, host, port: 22, home: websiteHome(w), documentRoot: w.domain.documentRoot };
}

interface ListedKey {
  id: string;
  name: string;
  createdAt: string;
  type: string;
  fingerprint: string;
  blob: string;
}

async function listKeys(ctx: ToolContext, org: string, websiteId: string): Promise<ListedKey[]> {
  const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/ssh/keys', () =>
    ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/ssh/keys', { params: { path: { org_id: org, website_id: websiteId } } }),
  );
  // The live panel answered this endpoint with a bare array (docs/research.md), while the spec —
  // and so the generated type — describes an `{ items }` envelope. Cast noted per convention 6:
  // the narrowing below is the only place that knows both shapes exist.
  const items = Array.isArray(res) ? (res as SshKey[]) : res.items;
  return items.map((k) => {
    let parsed: ParsedKey | undefined;
    try {
      parsed = parsePublicKey(k.value);
    } catch {
      parsed = undefined;
    }
    return { id: k.id, name: k.name ?? '', createdAt: k.createdAt, type: parsed?.type ?? '?', fingerprint: parsed ? fingerprint(parsed.blob) : '?', blob: parsed?.blob ?? k.value };
  });
}

/** Resolves a key by id, name or fingerprint (used only by target(), which owns raw-ref resolution). */
async function findKeyByRef(ctx: ToolContext, org: string, w: Website, ref: string): Promise<ListedKey> {
  const keys = await listKeys(ctx, org, w.id);
  const needle = ref.trim().toLowerCase();
  const hit = keys.find((k) => k.id === ref.trim() || k.name.toLowerCase() === needle || k.fingerprint.toLowerCase() === needle);
  if (!hit) throw new Error(`No SSH key "${safe(ref)}" on ${safe(w.domain.domain)}. Known keys: ${keys.map((k) => `${k.id}${k.name ? ` (${safe(k.name)})` : ''}`).join(', ') || 'none'}`);
  return hit;
}

/** Looks a key up by its stable id (target.id), never by the raw ref, per convention 12. */
async function getKeyById(ctx: ToolContext, org: string, w: Website, id: string): Promise<ListedKey> {
  const keys = await listKeys(ctx, org, w.id);
  const hit = keys.find((k) => k.id === id);
  if (!hit) throw new Error(`SSH key ${id} on ${safe(w.domain.domain)} no longer exists; it may already have been removed.`);
  return hit;
}

export const sshConnectionInfo = defineTool({
  name: 'ssh_connection_info',
  tier: 'customer',
  risk: 'read',
  description:
    "Read-only. The SSH login command, home directory, document root and an rsync example for a website, plus how many keys are authorized. SSH only works after ssh_key_add. Note: Claude Code's Bash sandbox cannot open SSH connections; run ssh/rsync with the sandbox disabled or add them to sandbox.excludedCommands.",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(website);
    const c = conn(w);
    let keys: ListedKey[] = [];
    let keysUnavailable = false;
    let keyErrorCode: string | undefined;
    try {
      keys = await listKeys(ctx, org, w.id);
    } catch (e) {
      if (isEnhanceApiError(e)) {
        keysUnavailable = true;
        keyErrorCode = e.code;
      } else {
        throw e;
      }
    }
    const missing = [!c.user ? 'unix user' : undefined, !c.host ? 'server IP' : undefined].filter((x): x is string => x !== undefined);
    const ready = missing.length === 0;
    const sshCommand = ready ? `ssh -p ${c.port} ${c.user}@${c.host}` : undefined;
    // -rltvz, not -a: with a trailing-slash source, -a copies the local folder's owner, group and
    // mode onto the document root, which the panel keeps at 750 with the web server group
    // (verified live 2026-09-05).
    const rsyncExample = ready ? `rsync -rltvz --dry-run ./dist/ ${c.user}@${c.host}:${c.documentRoot}/` : undefined;
    const authorizedKeysValue = keysUnavailable ? `unavailable (${keyErrorCode})` : keys.length;
    const text = [
      identityBlock({ name: ctx.client.orgName, id: org }, w),
      kv([
        ['login', ready ? sshCommand : `unavailable — this website is missing its ${missing.join(' and ')}`],
        ['home', c.home],
        ['document root', `${c.home}/${c.documentRoot}`],
        ['authorized keys', authorizedKeysValue],
      ]),
      'deploy example (dry run first, then without --dry-run):',
      `  ${ready ? safe(rsyncExample) : 'unavailable — see login above'}`,
      `  (use -rltvz, not -a: -a would copy the local folder's owner, group and mode onto ${safe(c.documentRoot)}, which the panel keeps at 750 with the web server group; add -e "ssh -i <key>" for a non-default key)`,
      "sandbox: Claude Code's Bash sandbox cannot open SSH connections. Run ssh and rsync with the sandbox disabled for that command, or add \"ssh\" and \"rsync\" to sandbox.excludedCommands in settings.",
    ].join('\n');
    return ok(text, { website: w.id, ...c, keysAuthorized: keysUnavailable ? null : keys.length, keysUnavailable, sshCommand, rsyncExample });
  },
});

export const sshKeysList = defineTool({
  name: 'ssh_keys_list',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Lists the public keys authorized on a website with id, name, type, fingerprint and creation time.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(website);
    const keys = await listKeys(ctx, org, w.id);
    const rows = keys.map(({ blob: _blob, ...k }) => k);
    return ok([identityBlock({ name: ctx.client.orgName, id: org }, w), keys.length ? table(rows, ['id', 'name', 'type', 'fingerprint', 'createdAt']) : 'no SSH keys authorized yet. Use ssh_key_add.'].join('\n'), { website: w.id, items: rows });
  },
});

export const sshKeyAdd = defineTool({
  name: 'ssh_key_add',
  tier: 'customer',
  risk: 'write',
  description: 'Authorizes an OpenSSH public key (the contents of a .pub file) on a website so ssh and rsync work. Idempotent: if the same key is already authorized nothing changes. Never pass a private key.',
  input: z.object({ website: websiteArg, public_key: z.string().min(20), name: z.string().max(64).optional() }),
  async handler(args, ctx) {
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(args.website);
    const key = parsePublicKey(args.public_key);
    const fp = fingerprint(key.blob);
    const existing = (await listKeys(ctx, org, w.id)).find((k) => k.type === key.type && k.blob === key.blob);
    const id = identityBlock({ name: ctx.client.orgName, id: org }, w);
    if (existing) {
      return ok(`${id}\nkey ${fp} is already authorized (id ${existing.id}${existing.name ? `, "${safe(existing.name)}"` : ''}). Nothing changed.`, { website: w.id, keyId: existing.id, fingerprint: fp, added: false });
    }
    const name = args.name ?? key.comment ?? 'claude-code';
    const res = await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/ssh/keys', () =>
      ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/ssh/keys', { params: { path: { org_id: org, website_id: w.id } }, body: { value: `${key.type} ${key.blob}`, name } }),
    );
    const c = conn(w);
    const sshCommand = c.user && c.host ? `ssh -p ${c.port} ${c.user}@${c.host}` : undefined;
    return ok(`${id}\nkey ${fp} authorized as "${safe(name)}" (id ${res.id}).${sshCommand ? `\nconnect with: ${safe(sshCommand)}` : ''}`, { website: w.id, keyId: res.id, fingerprint: fp, name, added: true, sshCommand });
  },
});

export const sshKeyRemove = defineTool({
  name: 'ssh_key_remove',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Removes an authorized SSH key (by id, name or fingerprint) from a website. Whoever holds that key loses access. Requires the user to type the website domain to confirm.',
  input: z.object({ website: websiteArg, key: z.string().min(1).describe('Key id, name, or SHA256 fingerprint') }),
  async target(args, ctx) {
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(args.website);
    const k = await findKeyByRef(ctx, org, w, args.key);
    // The human confirms with the website domain, not the key name/fingerprint.
    return { kind: 'ssh_key', id: k.id, name: w.domain.domain };
  },
  async preview(args, ctx, target) {
    // Act on the target it was handed (convention 12): look the key up by target.id, not by
    // re-parsing args.key, so the preview can't drift from what handler() will actually delete.
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(args.website);
    const k = await getKeyById(ctx, org, w, target.id);
    return `This will remove SSH key id ${k.id}${k.name ? ` "${safe(k.name)}"` : ''} (${k.fingerprint}, added ${safe(k.createdAt)}) from website ${safe(w.domain.domain)}. Anyone using that key can no longer ssh or rsync to the site.`;
  },
  async handler(args, ctx, target) {
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(args.website);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/ssh/keys/{key_id}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/ssh/keys/{key_id}', { params: { path: { org_id: org, website_id: w.id, key_id: target!.id } } }),
    );
    return ok(`${identityBlock({ name: ctx.client.orgName, id: org }, w)}\nSSH key ${target!.id} removed.`, { website: w.id, keyId: target!.id, removed: true });
  },
});

export const tools: ToolDef[] = [sshConnectionInfo, sshKeysList, sshKeyAdd, sshKeyRemove];
