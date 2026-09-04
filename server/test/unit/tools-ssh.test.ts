import { describe, expect, it } from 'vitest';
import { allTools } from '../../src/tools/index.js';
import { fingerprint, parsePublicKey, tools } from '../../src/tools/ssh.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { domainMappings, ORG_ID, sshKeys, WEBSITE_ID, websiteDetail, websitesList } from '../fixtures/panel.js';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa user@laptop';
const base = () => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/ssh/keys`, body: sshKeys },
];

describe('parsePublicKey / fingerprint', () => {
  it('parses type, blob and comment and rejects private keys', () => {
    const k = parsePublicKey(PUB);
    expect(k).toMatchObject({ type: 'ssh-ed25519', comment: 'user@laptop' });
    expect(fingerprint(k.blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(() => parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toThrow(/public key/);
    expect(() => parsePublicKey('ssh-rsa not-base64!!')).toThrow(/public key/);
  });
  it('rejects two-line pastes and accepts CRLF', () => {
    const blob = PUB.split(' ')[1]!;
    expect(() => parsePublicKey(`ssh-ed25519 ${blob}\nsecond line`)).toThrow(/public key/);
    expect(parsePublicKey(PUB.replace(' user@laptop', '') + '\r\n')).toMatchObject({ comment: undefined });
  });
});

describe('ssh_connection_info', () => {
  it('derives the login command and rsync example', async () => {
    const { ctx } = await makeContext(base());
    const r = await callTool(byName(tools, 'ssh_connection_info'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('ssh -p 22 vahi_dev1@65.98.32.45');
    expect(r.text).toContain(`rsync -avz --dry-run ./dist/ vahi_dev1@65.98.32.45:public_html/`);
    expect(r.text).toContain('sandbox');
    expect(r.structured).toMatchObject({ user: 'vahi_dev1', host: '65.98.32.45', port: 22, home: `/var/www/${WEBSITE_ID}`, documentRoot: 'public_html', keysAuthorized: 1 });
  });
  it('degrades when the website has no unix user or IP', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, unixUser: undefined, serverIps: [] } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/ssh/keys`, body: sshKeys },
    ]);
    const r = await callTool(byName(tools, 'ssh_connection_info'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('unavailable');
    expect(r.structured!.sshCommand).toBeUndefined();
    expect(r.structured!.user).toBeUndefined();
  });
  it('survives a forbidden key listing', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/ssh/keys`, status: 403, body: { code: 'unauthorized' } },
    ]);
    const r = await callTool(byName(tools, 'ssh_connection_info'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('authorized keys: unavailable (unauthorized)');
    expect(r.text).toContain('ssh -p 22 vahi_dev1@65.98.32.45');
    expect(r.structured!.keysUnavailable).toBe(true);
  });
});

describe('ssh_keys_list / ssh_key_add / ssh_key_remove', () => {
  it('lists keys with fingerprints', async () => {
    const { ctx } = await makeContext(base());
    const r = await callTool(byName(tools, 'ssh_keys_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('claude-mcp-test');
    expect(r.text).toContain('SHA256:');
    const item = (r.structured! as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item).not.toHaveProperty('blob');
    expect(item.fingerprint).toMatch(/^SHA256:/);
  });
  it('is idempotent for an already-authorized key and posts a new one', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'POST', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/ssh/keys`, status: 201, body: { id: '1' } }]);
    const same = await callTool(byName(tools, 'ssh_key_add'), { website: 'vahi.dev', public_key: PUB }, ctx);
    expect(same.text).toContain('already authorized');
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    const other = PUB.replace('AAAAIO/0aaaa', 'AAAAIO/0bbbb');
    const added = await callTool(byName(tools, 'ssh_key_add'), { website: 'vahi.dev', public_key: other, name: 'ci' }, ctx);
    expect(added.text).toContain('authorized as "ci"');
    const post = f.calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post!.body!)).toEqual({ value: other.split(' ').slice(0, 2).join(' '), name: 'ci' });
  });
  it('removes a key through the gate contract, confirming with the website domain', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/ssh/keys/0`, status: 204 }]);
    const t = byName(tools, 'ssh_key_remove');
    const target = await t.target!({ website: 'vahi.dev', key: 'claude-mcp-test' }, ctx);
    expect(target).toEqual({ kind: 'ssh_key', id: '0', name: 'vahi.dev' });
    expect(await t.preview!({ website: 'vahi.dev', key: 'claude-mcp-test' }, ctx, target)).toContain('claude-mcp-test');
    await t.handler({ website: 'vahi.dev', key: 'claude-mcp-test' }, ctx, target);
    expect(f.calls.find((c) => c.method === 'DELETE')?.path).toBe(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/ssh/keys/0`);
  });
});

describe('allTools', () => {
  it('contains every milestone A tool exactly once', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(29);
    for (const n of ['auth_status', 'subscriptions_list', 'activity_log', 'platform_info', 'domain_check', 'websites_list', 'website_get', 'website_create', 'website_set_php_version', 'website_restart_php', 'website_preview_domain', 'website_delete', 'domains_list', 'domain_add', 'domain_set_primary', 'domain_remove', 'domain_dns_status', 'domain_dns_query', 'domain_dns_records', 'domain_ssl_get', 'domain_ssl_issue', 'domain_set_force_ssl', 'cloudflare_keys_list', 'domain_cloudflare_connect', 'domain_cloudflare_nameservers', 'ssh_connection_info', 'ssh_keys_list', 'ssh_key_add', 'ssh_key_remove']) {
      expect(names).toContain(n);
    }
    expect(allTools.filter((t) => t.risk === 'destructive').map((t) => t.name).sort()).toEqual(['domain_remove', 'ssh_key_remove', 'website_delete']);
  });
});
