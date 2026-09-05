import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { defineTool, selectTools, type ToolDef } from '../../src/core/registry.js';
import { ok } from '../../src/core/respond.js';

const read = defineTool({ name: 'thing_get', tier: 'customer', risk: 'read', description: 'd', input: z.object({}), handler: async () => ok('x') });
const write = defineTool({ name: 'thing_set', tier: 'customer', risk: 'write', description: 'd', input: z.object({}), handler: async () => ok('x') });
const reseller = defineTool({ name: 'customer_create', tier: 'reseller', risk: 'write', description: 'd', input: z.object({}), handler: async () => ok('x') });
const destructive = defineTool({
  name: 'thing_delete', tier: 'customer', risk: 'destructive', description: 'd', input: z.object({ name: z.string() }),
  target: async ({ name }) => ({ kind: 'website', id: 'id', name }),
  preview: async () => 'will delete',
  handler: async () => ok('deleted'),
});
const all: ToolDef[] = [read, write, reseller, destructive];

describe('defineTool', () => {
  it('rejects destructive tools without target and preview', () => {
    expect(() => defineTool({ name: 'x_delete', tier: 'customer', risk: 'destructive', description: 'd', input: z.object({}), handler: async () => ok('') })).toThrow(/target\(\) and preview\(\)/);
  });
  it('rejects non snake_case names', () => {
    expect(() => defineTool({ name: 'Thing-Get', tier: 'customer', risk: 'read', description: 'd', input: z.object({}), handler: async () => ok('') })).toThrow(/snake_case/);
  });
});

describe('selectTools', () => {
  it('filters by tier', () => {
    expect(selectTools(all, { tiers: ['customer'], readOnly: false }).map((t) => t.name)).toEqual(['thing_get', 'thing_set', 'thing_delete']);
    expect(selectTools(all, { tiers: ['customer', 'reseller'], readOnly: false })).toHaveLength(4);
  });
  it('read-only keeps only read tools', () => {
    expect(selectTools(all, { tiers: ['customer'], readOnly: true }).map((t) => t.name)).toEqual(['thing_get']);
  });
});
