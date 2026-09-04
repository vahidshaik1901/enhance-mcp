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
  // Collapse control characters (newlines, tabs, etc.) so panel-supplied strings can't forge
  // extra output lines (e.g. a fake "warnings:" section) inside a table cell or kv value.
  return String(v).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
}

/**
 * Public sanitiser for any panel-controlled string interpolated directly into panel text
 * outside of `kv`/`table` (e.g. a hand-built header line). Collapses control characters and
 * renders empty/null as "-", exactly like a table/kv cell, so a fake "warnings:" section or
 * embedded newline can't be forged into a tool's rendered text.
 */
export function safe(v: unknown): string {
  return cell(v);
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
