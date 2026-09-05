import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { parse } from 'yaml';

interface Schema {
  required?: string[];
  properties?: Record<string, unknown>;
}

const spec = parse(readFileSync(new URL('../../spec/oas3-api.yaml', import.meta.url), 'utf8')) as { components: { schemas: Record<string, Schema> } };

/** Asserts that every `required` property of the named spec schema is present on the live value. */
export function assertRequired(schemaName: string, value: unknown): void {
  const schema = spec.components.schemas[schemaName];
  if (!schema) throw new Error(`no schema ${schemaName} in the vendored spec`);
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    expect(obj, `${schemaName}.${key} missing from live response`).toHaveProperty(key);
  }
}
