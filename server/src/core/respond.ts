import type { ToolResult } from './registry.js';

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { text, structured };
}

export function fail(text: string, structured?: Record<string, unknown>): ToolResult {
  return { text, structured, isError: true };
}

function cell(v: unknown): string {
  if (v === undefined || v === null || v === '') return '-';
  if (Array.isArray(v)) return v.map(cell).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function kv(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${cell(v)}`)
    .join('\n');
}

export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const grid = [columns, ...rows.map((r) => columns.map((c) => cell(r[c])))];
  const widths = columns.map((_, i) => Math.max(...grid.map((line) => line[i]?.length ?? 0)));
  return grid.map((line) => line.map((v, i) => (i === line.length - 1 ? v : v.padEnd(widths[i] ?? 0))).join('  ').trimEnd()).join('\n');
}
