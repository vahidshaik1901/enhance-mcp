import { describe, expect, it } from 'vitest';
import { MYSQL_GRANTS, resolveDbName, resolveDbUser, siteWebsite, unixUserOf, websiteArg } from '../../src/tools/dbcommon.js';
import { base, ORG_ID, WEBSITE_ID } from '../fixtures/panel.js';
import { makeContext } from '../helpers/context.js';

describe('resolveDbName', () => {
  it('prefixes a short name with the unix user', () => {
    expect(resolveDbName('vahi_dev1', 'demo')).toBe('vahi_dev1_demo');
  });
  it('passes an already-prefixed name through unchanged', () => {
    expect(resolveDbName('vahi_dev1', 'vahi_dev1_demo')).toBe('vahi_dev1_demo');
  });
  it('does not double-prefix a name that merely starts with a similar string', () => {
    // "vahi_dev10" is a different unix user prefix; treat as a short name.
    expect(resolveDbName('vahi_dev1', 'vahi_dev10things')).toBe('vahi_dev1_vahi_dev10things');
  });
  it('trims and rejects empty input, naming the database', () => {
    expect(resolveDbName('vahi_dev1', '  demo  ')).toBe('vahi_dev1_demo');
    expect(() => resolveDbName('vahi_dev1', '   ')).toThrow('database name must not be empty');
  });
  it('rejects the bare prefix, which would name nothing', () => {
    expect(() => resolveDbName('vahi_dev1', 'vahi_dev1_')).toThrow('database name must not be empty');
  });
});

describe('resolveDbUser', () => {
  it('prefixes like resolveDbName', () => {
    expect(resolveDbUser('vahi_dev1', 'app')).toBe('vahi_dev1_app');
    expect(resolveDbUser('vahi_dev1', 'vahi_dev1_app')).toBe('vahi_dev1_app');
  });
  it('names the user, not the database, when the input is empty or the bare prefix', () => {
    expect(() => resolveDbUser('vahi_dev1', ' ')).toThrow('user name must not be empty');
    expect(() => resolveDbUser('vahi_dev1', 'vahi_dev1_')).toThrow('user name must not be empty');
  });
});

describe('MYSQL_GRANTS', () => {
  it('is the lowercase enum, not SQL text', () => {
    expect(MYSQL_GRANTS).toContain('all');
    expect(MYSQL_GRANTS).toContain('select');
    expect(MYSQL_GRANTS).not.toContain('ALL PRIVILEGES');
  });
});

describe('websiteArg', () => {
  it('rejects an empty reference', () => {
    expect(websiteArg.safeParse('vahi.dev').success).toBe(true);
    expect(websiteArg.safeParse('').success).toBe(false);
  });
});

describe('siteWebsite', () => {
  it('returns the active org and the resolved website', async () => {
    const { ctx } = await makeContext(base());
    const { org, w } = await siteWebsite(ctx, 'vahi.dev');
    expect(org).toBe(ORG_ID);
    expect(w).toMatchObject({ id: WEBSITE_ID, unixUser: 'vahi_dev1' });
  });
});

describe('unixUserOf', () => {
  it('returns the unix user, and refuses a website that has none instead of prefixing with a bare _', async () => {
    const { ctx } = await makeContext(base());
    const { w } = await siteWebsite(ctx, 'vahi.dev');
    expect(unixUserOf(w)).toBe('vahi_dev1');
    expect(() => unixUserOf({ ...w, unixUser: undefined })).toThrow(/no unix user/);
  });
});
