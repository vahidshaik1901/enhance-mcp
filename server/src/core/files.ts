import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import { requireOrg, type ToolContext } from './context.js';
import { safe } from './respond.js';
import { UUID_RE, type Website } from './resolver.js';
import { describeError } from './verify.js';

/**
 * The panel's file service ("filerd"), read-only.
 *
 * Verified live on vahi.dev (2026-09-17; re-probed on panel and filerd 12.25.11 on 2026-09-24):
 * `POST /orgs/{org}/websites/{id}/access-tokens` (in the public spec) mints a site JWT that lives
 * 240 s and CAN WRITE (`read_only: false`, and the endpoint takes no body that could ask for less);
 * `GET <panel><filerdAddress>/websites/{id}/entries?recursive=true&maxDepth=N&fetchMetadata=true`
 * (not in the public spec) returns the tree of the site home, always from the home, N+1 levels deep.
 *
 * Because the token can write, this module is built so that it cannot: it sends exactly one request
 * shape to the service — this GET, with fixed query parameters — and no function here takes a
 * method, a body or a route. The token is a local of `listSiteFiles`: never logged, returned, audited
 * or placed in an error, and sent only to a path on the panel's own host with redirects refused.
 */

export type FileServiceReason = 'unsupported' | 'mint_refused' | 'unauthorized' | 'not_found' | 'http_error' | 'bad_shape' | 'too_large' | 'timeout' | 'network';

/** Every way the file service can be unavailable, typed, so each caller can degrade instead of throw. */
export class FileServiceUnavailable extends Error {
  override name = 'FileServiceUnavailable';
  constructor(
    readonly reason: FileServiceReason,
    message: string,
  ) {
    super(message);
  }
}

export interface SiteFileEntry {
  /** Relative to the site home, `/`-separated: `public_html/index.html`. The home itself is never an entry. */
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number | null;
  /** Epoch seconds. */
  modified: number | null;
  /** Permission bits as a number: 420 is 0644. */
  mode: number | null;
  /** A folder on the last level asked for, which the service did not open: its contents are unknown. */
  unexpanded: boolean;
}

export interface SiteFileListing {
  levels: number;
  entries: SiteFileEntry[];
}

/** The most levels below the home the service is asked for. Six levels of a Node site measured
 *  1.4 MB in 0.9 s live; eight stays well under the response cap. */
export const MAX_LEVELS = 8;
/** A listing past this size is refused rather than parsed. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FILES_TIMEOUT_MS = 15_000;

/** A path on the panel's own host — `/filerd/<uuid>` live — and nothing else: no scheme, no host,
 *  no `.` (so no `..`), no query or fragment. `//` is refused separately: it would name a host. */
const FILERD_ADDRESS_RE = /^\/[A-Za-z0-9/_-]+$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const Meta = z.object({ size: z.number(), modified: z.number(), permissions: z.number(), kind: z.string() });
type Meta = z.infer<typeof Meta>;
interface FileNode {
  file: { path: string; metadata?: Meta };
}
interface DirBody {
  path: string;
  /** Absent: a folder the service knows is empty. `[]` on the last level: a folder it did not open. */
  entries?: TreeNode[];
  metadata?: Meta;
}
interface DirNode {
  dir: DirBody;
}
type TreeNode = FileNode | DirNode;
const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.union([
    z.object({ file: z.object({ path: z.string(), metadata: Meta.optional() }) }),
    z.object({ dir: z.object({ path: z.string(), entries: z.array(TreeNodeSchema).optional(), metadata: Meta.optional() }) }),
  ]),
);
const RootSchema = z.object({ dir: z.object({ path: z.string(), entries: z.array(TreeNodeSchema).optional(), metadata: Meta.optional() }) });

/** The address check runs BEFORE a token exists: the token only ever goes to a path on the panel. */
export function checkFilerdAddress(address: string | undefined): string {
  if (!address) throw new FileServiceUnavailable('unsupported', 'the panel reports no file service address for this website');
  if (!FILERD_ADDRESS_RE.test(address) || address.includes('//')) {
    throw new FileServiceUnavailable('unsupported', `the panel's file service address "${safe(address)}" is not a plain path on the panel, so no token was sent to it`);
  }
  return address;
}

/** Releases a response body we will not read. A cancel that fails must not replace the reason the
 *  body was abandoned (a `too_large` would otherwise surface as `network`). */
async function discard(stream: { cancel(): Promise<void> } | null | undefined): Promise<void> {
  await stream?.cancel().catch(() => undefined);
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await discard(res.body);
    throw new FileServiceUnavailable('too_large', `the listing is ${declared} bytes, over the ${cap}-byte cap; ask for fewer levels`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await discard(reader);
      throw new FileServiceUnavailable('too_large', `the listing is over the ${cap}-byte cap; ask for fewer levels`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function flatten(root: DirBody, levels: number): SiteFileEntry[] {
  const out: SiteFileEntry[] = [];
  const walk = (nodes: TreeNode[] | undefined, level: number): void => {
    for (const node of nodes ?? []) {
      if ('file' in node) {
        const m = node.file.metadata;
        out.push({ path: node.file.path, kind: m?.kind === 'symlink' ? 'symlink' : 'file', size: m?.size ?? null, modified: m?.modified ?? null, mode: m?.permissions ?? null, unexpanded: false });
        continue;
      }
      const m = node.dir.metadata;
      out.push({ path: node.dir.path, kind: 'dir', size: m?.size ?? null, modified: m?.modified ?? null, mode: m?.permissions ?? null, unexpanded: level >= levels && node.dir.entries !== undefined && node.dir.entries.length === 0 });
      walk(node.dir.entries, level + 1);
    }
  };
  walk(root.entries, 1);
  return out;
}

/**
 * The site home, `levels` levels deep (1 = the home's own entries), as a flat list in the service's
 * order. Every failure is a `FileServiceUnavailable` with a plain reason, never a raw throw.
 */
export async function listSiteFiles(ctx: ToolContext, website: Website, opts: { levels: number; timeoutMs?: number }): Promise<SiteFileListing> {
  const levels = Math.min(MAX_LEVELS, Math.max(1, Math.trunc(opts.levels) || 1));
  const address = checkFilerdAddress(website.filerdAddress);
  if (!UUID_RE.test(website.id)) throw new FileServiceUnavailable('unsupported', 'the website id is not a UUID, so no file service route can be built for it');
  const org = requireOrg(ctx.client);
  let raw: string;
  try {
    raw = await ctx.client.call<string>('POST', '/orgs/{org_id}/websites/{website_id}/access-tokens', () =>
      ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/access-tokens', { params: { path: { org_id: org, website_id: website.id } }, parseAs: 'text' }),
    );
  } catch (e) {
    throw new FileServiceUnavailable('mint_refused', `the panel refused a site access token (${describeError(e)})`);
  }
  const token = parseScalarText(raw);
  if (!JWT_RE.test(token)) throw new FileServiceUnavailable('mint_refused', 'the panel answered the token request without a token');
  const scrub = (text: string): string => text.split(token).join('[redacted]');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FILES_TIMEOUT_MS;
  const url = `${ctx.config.panelUrl}${address}/websites/${website.id}/entries?recursive=true&maxDepth=${levels - 1}&fetchMetadata=true`;
  let body: string;
  try {
    const res = await (ctx.fetch ?? globalThis.fetch)(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) await discard(res.body);
    if (res.status === 401 || res.status === 403) throw new FileServiceUnavailable('unauthorized', `the file service refused the site token (HTTP ${res.status})`);
    if (res.status === 404) throw new FileServiceUnavailable('not_found', 'the file service has no such route for this website (HTTP 404)');
    if (!res.ok) throw new FileServiceUnavailable('http_error', `the file service answered HTTP ${res.status}`);
    body = await readCapped(res, MAX_RESPONSE_BYTES);
  } catch (e) {
    if (e instanceof FileServiceUnavailable) throw e;
    const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
    if (name === 'TimeoutError' || name === 'AbortError') throw new FileServiceUnavailable('timeout', `the file service did not answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new FileServiceUnavailable('network', `the file service could not be reached (${scrub(safe(e instanceof Error ? e.message : String(e)))})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new FileServiceUnavailable('bad_shape', 'the file service answered something that is not JSON');
  }
  const tree = RootSchema.safeParse(parsed);
  if (!tree.success) throw new FileServiceUnavailable('bad_shape', `the file service answered in an unexpected shape (at ${safe(tree.error.issues[0]?.path.join('.') || 'the top')}); the panel may have changed it`);
  return { levels, entries: flatten(tree.data.dir, levels) };
}
