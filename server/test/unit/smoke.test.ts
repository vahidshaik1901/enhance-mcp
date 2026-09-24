import { describe, expect, it } from 'vitest';
import { allTools } from '../../src/tools/index.js';
import { VERSION } from '../../src/version.js';

describe('package', () => {
  it('exposes a semver version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the registered tool set', () => {
  it('registers every milestone A, B, C and D1 tool exactly once', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // 29 milestone A + 13 mysql + 9 postgresql + 9 php + 5 htaccess + 6 cron + 5 node + 6 persistent apps + 1 files.
    expect(allTools.length).toBe(83);
    expect(names).toEqual(expect.arrayContaining(['db_create', 'php_extensions_list', 'cron_add', 'node_install', 'persistent_app_create', 'persistent_app_probe', 'files_list']));
    expect(allTools.every((t) => t.tier === 'customer')).toBe(true);
  });
});
