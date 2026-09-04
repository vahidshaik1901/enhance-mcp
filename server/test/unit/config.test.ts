import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, redactSecret } from '../../src/config.js';

const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.payload.sig';

describe('loadConfig', () => {
  it('loads from env with defaults', () => {
    const c = loadConfig({ env: { ENHANCE_PANEL_URL: 'https://panel.example.com/', ENHANCE_TOKEN: TOKEN }, home: '/home/u' });
    expect(c.panelUrl).toBe('https://panel.example.com');
    expect(c.apiBase).toBe('https://panel.example.com/api');
    expect(c.tiers).toEqual(['customer']);
    expect(c.readOnly).toBe(false);
    expect(c.auditLog).toBe('/home/u/.enhance-mcp/audit.jsonl');
    expect(c.timeoutMs).toBe(30_000);
    expect(c.orgId).toBeUndefined();
  });

  it('parses tiers, read-only, org, timeout from env', () => {
    const c = loadConfig({
      env: {
        ENHANCE_PANEL_URL: 'https://p.example.com',
        ENHANCE_TOKEN: TOKEN,
        ENHANCE_TIERS: 'customer, reseller',
        ENHANCE_READ_ONLY: '1',
        ENHANCE_ORG_ID: '98071de9-291f-4bc4-82e8-b3d1da46d19e',
        ENHANCE_TIMEOUT_MS: '5000',
      },
    });
    expect(c.tiers).toEqual(['customer', 'reseller']);
    expect(c.readOnly).toBe(true);
    expect(c.orgId).toBe('98071de9-291f-4bc4-82e8-b3d1da46d19e');
    expect(c.timeoutMs).toBe(5000);
  });

  it('falls back to the profile file, env wins', () => {
    const file = JSON.stringify({
      profiles: {
        default: { panelUrl: 'https://file.example.com', token: TOKEN, readOnly: true },
        prod: { panelUrl: 'https://prod.example.com', token: TOKEN },
      },
    });
    const readFile = (p: string) => (p === '/home/u/.enhance-mcp/config.json' ? file : undefined);
    const a = loadConfig({ env: {}, readFile, home: '/home/u' });
    expect(a.panelUrl).toBe('https://file.example.com');
    expect(a.readOnly).toBe(true);
    const b = loadConfig({ env: { ENHANCE_PROFILE: 'prod', ENHANCE_READ_ONLY: '0' }, readFile, home: '/home/u' });
    expect(b.panelUrl).toBe('https://prod.example.com');
    expect(b.readOnly).toBe(false);
  });

  it('fails with a helpful message when required values are missing', () => {
    expect(() => loadConfig({ env: {}, readFile: () => undefined, home: '/home/u' })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, readFile: () => undefined, home: '/home/u' })).toThrow(/ENHANCE_PANEL_URL/);
  });

  it('rejects unknown tiers and bad urls', () => {
    expect(() => loadConfig({ env: { ENHANCE_PANEL_URL: 'not a url', ENHANCE_TOKEN: TOKEN } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { ENHANCE_PANEL_URL: 'https://p.example.com', ENHANCE_TOKEN: TOKEN, ENHANCE_TIERS: 'god' } })).toThrow(/tiers/);
  });

  it('redacts secrets to five characters', () => {
    expect(redactSecret(TOKEN)).toBe('eyJ0e…');
    expect(redactSecret('abc')).toBe('…');
  });

  it('ignores a malformed profile file when env is complete, with a warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = loadConfig({
      env: { ENHANCE_PANEL_URL: 'https://p.example.com', ENHANCE_TOKEN: TOKEN },
      readFile: () => '{ not json',
      home: '/home/u',
    });
    expect(c.panelUrl).toBe('https://p.example.com');
    expect(spy).toHaveBeenCalledOnce();
    const callArg = spy.mock.calls[0]![0] as string;
    expect(callArg).toContain('malformed');
    expect(callArg).not.toContain(TOKEN);
    spy.mockRestore();
  });

  it('still fails on a malformed profile file when env is incomplete', () => {
    expect(() =>
      loadConfig({
        env: {},
        readFile: () => '{ not json',
        home: '/home/u',
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        env: {},
        readFile: () => '{ not json',
        home: '/home/u',
      }),
    ).toThrow(/not valid JSON/);
  });

  it('fails on an unknown ENHANCE_PROFILE even when env is complete', () => {
    const file = JSON.stringify({
      profiles: {
        default: { panelUrl: 'https://p.example.com', token: TOKEN },
      },
    });
    const readFile = (p: string) => (p === '/home/u/.enhance-mcp/config.json' ? file : undefined);
    expect(() =>
      loadConfig({
        env: {
          ENHANCE_PANEL_URL: 'https://p.example.com',
          ENHANCE_TOKEN: TOKEN,
          ENHANCE_PROFILE: 'prod',
        },
        readFile,
        home: '/home/u',
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        env: {
          ENHANCE_PANEL_URL: 'https://p.example.com',
          ENHANCE_TOKEN: TOKEN,
          ENHANCE_PROFILE: 'prod',
        },
        readFile,
        home: '/home/u',
      }),
    ).toThrow(/profile "prod" not found/);
  });

  it('rejects a non-numeric ENHANCE_TIMEOUT_MS', () => {
    expect(() =>
      loadConfig({
        env: {
          ENHANCE_PANEL_URL: 'https://p.example.com',
          ENHANCE_TOKEN: TOKEN,
          ENHANCE_TIMEOUT_MS: 'soon',
        },
        home: '/home/u',
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        env: {
          ENHANCE_PANEL_URL: 'https://p.example.com',
          ENHANCE_TOKEN: TOKEN,
          ENHANCE_TIMEOUT_MS: 'soon',
        },
        home: '/home/u',
      }),
    ).toThrow(/timeoutMs/);
  });
});
