import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { components } from '../client/generated/types.js';
import type { ToolContext } from '../core/context.js';
import { listSiteFiles, MAX_LEVELS } from '../core/files.js';
import { websiteHome } from '../core/identity.js';
import { ASSET_CONCURRENCY, ASSET_TIMEOUT_MS, assetsAnswered, checkPageAssets, httpsProbe, MAX_ASSETS, proxyRequestPath } from '../core/probe.js';
import { defineTool, type Target, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { confirmedByReadNote, describeError, unknownOutcome, writeThenVerify } from '../core/verify.js';
import { dbTargetSite, websiteArg, type DbSite } from './dbcommon.js';
import { appsSite, nodeSelectorArg, persistentAppsGate } from './node.js';
import { tailLog } from './php.js';

type ListedApp = components['schemas']['ListedPersistentApp'];
type NewApp = components['schemas']['PersistentApp'];
type AppPatch = components['schemas']['UpdatePersistentApp'];

/** The panel's rule for a proxy path (verified live): starts with a letter, digit or underscore,
 *  may carry `-`, `.` and `/` only in the middle, and never a leading slash (that is a 400). */
export const PROXY_PATH_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_./-]*[A-Za-z0-9_])?$/;

export function validateProxyPath(input: string): { path: string; note?: string } {
  let path = input.trim();
  let note: string | undefined;
  if (path.startsWith('/') && !path.startsWith('//')) {
    path = path.slice(1);
    note = `the leading slash was dropped: the panel wants "${safe(path)}", and it serves it at /${safe(path)}/`;
  }
  if (!PROXY_PATH_RE.test(path) || path.includes('..')) {
    throw new Error(`proxy path "${safe(input)}" is not accepted by the panel: use letters, digits and underscores, with "-", "." and "/" only in the middle, and no leading slash`);
  }
  return note ? { path, note } : { path };
}

/** Relative to the site home, no parent segments. An absolute path is refused here because the
 *  panel silently stores it as null and the app then runs from the home directory. */
export function validateWorkingDirectory(input: string): string {
  const dir = input.trim().replace(/\/+$/, '');
  if (dir.startsWith('/') || dir.split('/').includes('..') || dir === '') {
    throw new Error(`working directory "${safe(input)}" must be relative to the site home (for example "nodeapp"), with no leading slash and no ".." segments`);
  }
  return dir;
}

/**
 * The one way out of every command the runner cannot exec, named in every rejection message so
 * the model does not have to guess at a second broken form.
 */
const NO_SHELL_HELP =
  'the panel runs the command without a shell — it splits it on whitespace and exec\'s it as argv, so quotes, "VAR=value" prefixes, pipes and redirection reach the program as literal words. Put the port and any environment in an npm script ("start": "node --env-file=.env server.js", "start": "next start -p 3002") or a wrapper script, then use "npm start" or "node server.js" as the command';

/** A `NAME=value` first word: in argv that is the program name, not an assignment. */
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `=>` is a JavaScript arrow inside a one-liner, not a redirection, so `>` only counts when it
 *  is not preceded by `=`. Everything else here is a shell operator in any position. */
const SHELL_OPERATORS: Array<readonly [RegExp, string]> = [
  [/\|/, '|'],
  [/&&/, '&&'],
  // A bare `&` would background the process for a shell; here it is a literal argv word, and an
  // app the panel cannot supervise is worse than a refusal.
  [/&/, '&'],
  [/;/, ';'],
  [/(?<!=)>/, '>'],
  [/</, '<'],
  [/`/, '`'],
  [/\$\(/, '$('],
  // Any `$`: no shell expands it, so `$PORT` and `${HOME}` reach the program as literal words.
  [/\$/, '$'],
];

/** A `"…"` or `'…'` segment holding whitespace: the runner keeps the quotes and splits inside
 *  them, so `node -e "const x = 1"` reached node as `-e`, `"const`, `x`, `=`, `1"` and crashed. */
const QUOTED_WITH_SPACE_RE = /"[^"]*\s[^"]*"|'[^']*\s[^']*'/;

/**
 * The command as the panel's runner will see it. Verified live: the runner ends in
 * `exec "$@"` with the command's words as arguments, so nothing a shell would interpret works —
 * and no `PORT` (or any other app variable) is injected for a `VAR=value` prefix to override.
 * Reject the three shapes that silently produce a crash-looping or never-starting app rather
 * than letting the panel accept them with a 201.
 */
export function validateCommand(input: string): string {
  const command = input.trim();
  if (command === '') throw new Error('command must not be empty');
  const first = command.split(/\s+/)[0] ?? '';
  if (ENV_PREFIX_RE.test(first)) {
    throw new Error(`command "${safe(command)}" starts with the environment assignment "${safe(first)}", which cannot work: ${NO_SHELL_HELP}`);
  }
  for (const [re, op] of SHELL_OPERATORS) {
    if (re.test(command)) throw new Error(`command "${safe(command)}" contains the shell operator "${op}", which cannot work: ${NO_SHELL_HELP}`);
  }
  const quoted = QUOTED_WITH_SPACE_RE.exec(command);
  if (quoted) {
    throw new Error(`command "${safe(command)}" contains the quoted argument ${safe(quoted[0])}, and the whitespace inside it splits the argument: ${NO_SHELL_HELP}`);
  }
  return command;
}

export function findApp(apps: ListedApp[], appId: string): ListedApp | undefined {
  return apps.find((a) => a.id === appId);
}

/** Where a proxied app answers: the primary domain only (verified live: the preview alias 404s).
 *  The panel's empty path is the whole-site app, which owns the domain root. */
export function appUrl(w: Website, path: string | undefined): string | null {
  if (path === undefined) return null;
  return path === '' ? `https://${w.domain.domain}/` : `https://${w.domain.domain}/${path}/`;
}

/** The app server this website's traffic lands on, primary first. */
function serverIp(w: Website): string | undefined {
  return (w.serverIps?.find((x) => x.isPrimary) ?? w.serverIps?.[0])?.ip;
}

export interface PathClashCheck {
  /** The status of the answer `detail` names, or null when the check could not run at all. */
  status: number | null;
  /** The request path that gave that answer (`/node`, `/node/`, `/`), or null when none did. */
  path: string | null;
  /** Something other than a 404 answers there, so registering the app would replace it. */
  taken: boolean;
  /** What was seen — `HTTP 404`, `HTTP 301 on /node: a redirect to /node/, which is how an existing
   *  directory in public_html/ shows` — or why the check could not run. Every message about the
   *  path quotes this. */
  detail: string;
}

interface ProbeHit {
  path: string;
  status: number;
  location: string | null;
}
type ProbeAnswer = ProbeHit | { path: string; error: string };
const isProbeError = (a: ProbeAnswer): a is { path: string; error: string } => 'error' in a;

/** The statuses a web server uses for "this is a directory, ask again with the trailing slash". */
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * Verified live 2026-09-17: the bare `/dir` answers 301 to `https://<domain>/dir/` for EVERY
 * existing directory — empty, holding files, or holding an index page — while `/dir/` itself
 * answers 404 unless there is an index. That redirect is the only signal that sees a directory
 * with no index, and it is what lets the refusal say what the 301 actually means.
 *
 * A relative Location (`v1/` for `/api/v1`) resolves against the path that was asked, as a browser
 * resolves it.
 */
function isDirectoryRedirect(host: string, path: string, hit: ProbeHit): boolean {
  if (hit.path !== `/${path}` || !REDIRECT_STATUSES.has(hit.status) || !hit.location) return false;
  try {
    return new URL(hit.location, `https://${host}${hit.path}`).pathname === `/${path}/`;
  } catch {
    return false;
  }
}

/**
 * What the site serves at `path` right now, asked exactly the way the web server will serve the
 * app: HTTPS to the app server's IP with the primary domain as SNI and Host. It carries no
 * credential (the probe transport never sends one), follows no redirect and reads 512 bytes.
 *
 * BOTH forms of a path are asked, because they answer differently (verified live 2026-09-17): a
 * directory with no index file is 404 on `/dir/` and 301 on `/dir`, so the trailing-slash form
 * alone would call a real directory free and let the app shadow it. The path is free only when
 * both forms answer 404.
 *
 * Verified live: a proxy path shadows a same-named `public_html` directory and answers 503 while
 * the app is merely registered, so a path that answers anything but 404 today is a page the
 * registration would silently take off the web. A check that cannot run — no server IP, no answer
 * from either form — never blocks the write; it is reported instead, because refusing a deploy
 * over an unreachable probe would be worse than the clash it guards against.
 */
export async function pathPreflight(ctx: ToolContext, w: Website, path: string): Promise<PathClashCheck> {
  const ip = serverIp(w);
  if (!ip) return { status: null, path: null, taken: false, detail: 'this website has no server IP recorded' };
  const probe = ctx.httpProbe ?? httpsProbe;
  // The root has one form; every other path has two.
  const paths = path === '' ? ['/'] : [`/${path}`, `/${path}/`];
  const answers = await Promise.all(
    paths.map(async (p): Promise<ProbeAnswer> => {
      try {
        const res = await probe({ ip, host: w.domain.domain, path: p, timeoutMs: 5000, maxBodyBytes: 512 });
        return { path: p, status: res.status, location: res.location ?? null };
      } catch (e) {
        return { path: p, error: safe((e as Error).message) };
      }
    }),
  );
  const hits = answers.filter((a): a is ProbeHit => !isProbeError(a));
  const clashes = hits.filter((h) => h.status !== 404);
  if (clashes.length > 0) {
    // Report the most informative hit: live content first (a 2xx is a page someone can open), then
    // the bare-path redirect that means "directory", then whatever else answered. A directory that
    // holds an index file produces both, and the 200 is the one a reader can act on.
    const directory = clashes.find((h) => isDirectoryRedirect(w.domain.domain, path, h));
    const hit = clashes.find((h) => h.status >= 200 && h.status < 300) ?? directory ?? clashes[0]!;
    // Worded as what the redirect usually means, not as a fact: a redirect-everything rule answers
    // the same way, and the file service's line under the refusal can then say nothing is there.
    // The folder named is this website's own document root, which is not always public_html.
    const docroot = (w.domain.documentRoot ?? '').replace(/\/+$/, '');
    const where = docroot ? `${safe(docroot)}/` : 'the document root';
    return { status: hit.status, path: hit.path, taken: true, detail: `HTTP ${hit.status} on ${hit.path}${hit === directory ? `: a redirect to /${path}/, which is how an existing directory in ${where} shows` : ''}` };
  }
  // Half a check is not a check: when either form never answered, say so rather than calling the
  // path free on the strength of the other one.
  const failure = answers.find(isProbeError);
  if (failure) return { status: null, path: null, taken: false, detail: failure.error };
  return { status: 404, path: hits[0]!.path, taken: false, detail: 'HTTP 404' };
}

/** How long a clash refusal waits for the file service before going out without the on-disk line. */
const ON_DISK_BUDGET_MS = 5_000;

/** Resolves undefined once `ms` pass, whatever `work` is still doing. `Promise.race` keeps a handler
 *  on `work`, so a late rejection is never unhandled. Nothing cancels `work`: an abandoned listing
 *  runs on to its own timeout and its answer is dropped. That is harmless here: past the site-token
 *  mint, the listing's one request to the file service is a GET, and the token stays a local of
 *  `listSiteFiles`, so nothing on the site changes and nothing leaks after the refusal has gone out. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const entriesWord = (n: number): string => `${n} entr${n === 1 ? 'y' : 'ies'}`;

/** A document root the file service can be asked about: relative segments, none starting with a
 *  dot (so no `..`), nothing that would need escaping. Anything else is an odd root and adds nothing. */
const DOCROOT_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

/**
 * A second opinion for a clash refusal: what is actually on disk where the app would shadow, from
 * the panel's file service. The HTTP preflight stays the decision-maker; this only lets the refusal
 * say what it is protecting — or that no file is at stake, because the answer came from a rewrite
 * rule, a redirect-everything site or another app. Anything that goes wrong (no file manager on the
 * plan, the service down or slower than ON_DISK_BUDGET_MS, an odd document root) adds nothing.
 *
 * The service lists a symlink without following it, so a symlink on the way down means nothing
 * behind it was read: "nothing exists at public_html/node" under a symlinked document root would be
 * a false all-clear that talks the caller into replace_existing_path=true, and that adds nothing too.
 */
export async function onDiskLine(ctx: ToolContext, w: Website, proxyPath: string): Promise<string | undefined> {
  if (w.canUse?.fileManager !== true) return undefined;
  const docroot = (w.domain.documentRoot ?? '').replace(/\/+$/, '');
  if (!DOCROOT_RE.test(docroot)) return undefined;
  const rel = proxyPath === '' ? docroot : `${docroot}/${proxyPath}`;
  const segments = rel.split('/');
  // One level more than the path itself, so a folder there comes back with its entries counted.
  if (segments.length + 1 > MAX_LEVELS) return undefined;
  try {
    const listing = await withinBudget(listSiteFiles(ctx, w, { levels: segments.length + 1, timeoutMs: ON_DISK_BUDGET_MS }), ON_DISK_BUDGET_MS);
    if (!listing) return undefined;
    const byPath = new Map(listing.entries.map((e) => [e.path, e]));
    const at = (n: number) => byPath.get(segments.slice(0, n).join('/'));
    const docrootDepth = docroot.split('/').length;
    // The document root and every folder above it must be real folders the service opened; a
    // missing one means this listing is not describing what the web server serves.
    for (let n = 1; n <= docrootDepth; n += 1) {
      const step = at(n);
      if (step?.kind !== 'dir' || step.unexpanded) return undefined;
    }
    const children = listing.entries.filter((e) => e.path.startsWith(`${rel}/`) && !e.path.slice(rel.length + 1).includes('/')).length;
    const source = "on disk (the panel's file service)";
    if (proxyPath === '') return `${source}: ${safe(docroot)} holds ${entriesWord(children)}, and none of it is served while a whole-site app is registered.`;
    // "No files" is not "nothing to lose": a rewrite serves a live page (a WordPress or Laravel
    // route) from nowhere on disk, so this line must never read as leave to override.
    const nothing = `${source}: nothing exists at ${safe(rel)}, so that answer comes from the web server itself (a rewrite rule, a redirect-everything site or another app); replace_existing_path=true would hide no files there, but it would still replace what ${safe(appUrl(w, proxyPath))} answers today.`;
    // Below the document root, a folder missing on the way (or a file in its place) means nothing
    // can exist at the path; a symlink on the way means the service never looked behind it.
    for (let n = docrootDepth + 1; n < segments.length; n += 1) {
      const step = at(n);
      if (step === undefined || step.kind === 'file') return nothing;
      if (step.kind !== 'dir' || step.unexpanded) return undefined;
    }
    const hit = byPath.get(rel);
    if (!hit) return nothing;
    if (hit.kind === 'dir') return `${source}: ${safe(rel)} is an existing folder holding ${entriesWord(children)}, which the app would hide.`;
    return `${source}: ${safe(rel)} is an existing ${hit.kind === 'symlink' ? 'symlink' : `file of ${hit.size ?? '?'} bytes`}, which the app would hide.`;
  } catch {
    return undefined;
  }
}

/** `subject` names the edit that hit the clash: a create registers an app, an update moves the
 *  proxy of one that already exists, and telling an updater it is "registering" is a small lie
 *  that sends them looking for an app they think they just made. */
const pathClashRefusal = (url: string, seen: string, subject: 'create' | 'move'): string =>
  `${subject === 'create' ? 'Registering this app' : "Moving this app's proxy here"} would replace what ${url} serves today (${seen}). ${subject === 'create' ? 'The app was not registered' : 'The proxy was not moved'}; nothing on the site was changed. Pick a path that returns 404 now, or pass replace_existing_path=true if replacing it is intended.`;
const rootClashRefusal = (seen: string): string =>
  `This website already serves content at its root (${seen}). A root app takes over the ENTIRE site, including every PHP and static page. The app was not registered; nothing on the site was changed. Use a dedicated website or subdomain for a whole-site Node app, or pass replace_existing_path=true if taking the whole current site off the web is intended.`;
const replacedNote = (url: string, seen: string): string => `this app replaced what ${url} served before (${seen}); that content is no longer reachable while the app is registered`;
const uncheckedPathNote = (url: string, detail: string): string => `the path could not be checked before the write (${detail}), so ${url} may already serve something — open it and confirm nothing was replaced`;
const rootAppNote = (url: string): string =>
  `This app owns the whole domain: every URL under ${url} goes to it, and the PHP and static files in public_html are not served while it is registered (delete the app to get them back).`;

const PRIMARY_DOMAIN_ONLY = 'Persistent apps answer on the primary domain only; the *.mystaging.site preview URL does not proxy them (verified live).';
export const PREVIEW_NOTE = `${PRIMARY_DOMAIN_ONLY} Before DNS resolves, verify with persistent_app_probe.`;

/** Verified live: an app registered on a path that also exists under public_html wins — the PHP
 *  page there answered 503 while the app was merely registered, and 200 again once it was gone. */
const PROXY_SHADOWS_DOCROOT = 'the proxy path takes precedence over any public_html/<path> directory — never reuse a directory name that PHP or static files serve';

/** Verified live 2026-09-17: the reverse proxy strips the `/<path>` prefix before it forwards, so
 *  an app that was built to live under that prefix serves nothing the proxy asks for. An Express
 *  app answered at `/` and echoed `/foo/bar?x=1` for `/express/foo/bar?x=1`; a Next.js build with
 *  `basePath` returned its own 404 until it was rebuilt with `assetPrefix` and no `basePath`. */
const PROXY_STRIPS_PREFIX = 'The proxy strips the path prefix (/<proxy_path>/foo reaches the app as /foo), so the app serves its routes at "/" (Next.js: assetPrefix, not basePath).';

/** Verified live: create, update and delete all bounce the container, not just the app process. */
const CREATE_RESTART_NOTE = 'registering the app restarted the website container; PHP and static pages were interrupted for a second or two';
/** Arguments that describe a proxy the caller did not ask for, and arguments a clear_* flag
 *  overrode: both are silently dropped by the panel, so the tool says so instead. */
const IGNORED_PROXY_ARGS_NOTE = 'port/allow_websocket ignored: no proxy_path was given, so the app is not exposed';
const CLEAR_PROXY_WON_NOTE = 'clear_proxy won: proxy_path/port/allow_websocket were ignored and the app is no longer exposed';
const CLEAR_NODE_VERSION_WON_NOTE = 'clear_node_version won: node_version was ignored and the app was set to "default", nvm\'s default alias';
const UPDATE_RESTART_NOTE =
  'An update usually restarts the app and the whole website container (verified live for start mode, command and clearing the proxy), so expect the site\'s PHP and static pages to be interrupted for a second or two; a change that only added a proxy was once seen to apply without a restart. To restart on purpose, resend a field the app already has, e.g. start_mode=automatic.';
const DELETE_RESTART_NOTE = "Deleting also restarts the website container, so the site's PHP and static pages are interrupted for a second or two.";
/** The asset check's worst case, as the probe's description quotes it: the page re-read (its 5 s
 *  deadline in checkPageAssets) plus ceil(MAX_ASSETS / ASSET_CONCURRENCY) rounds of fetches that
 *  each run out ASSET_TIMEOUT_MS. Derived, so the sentence cannot drift from the constants. */
const ASSET_CHECK_WORST_S = Math.ceil(MAX_ASSETS / ASSET_CONCURRENCY) * (ASSET_TIMEOUT_MS / 1000) + 5;

const appIdArg = z.string().uuid().describe('Persistent app id from persistent_apps_list');
const startModeArg = z.enum(['automatic', 'manual']);
export const commandArg = z
  .string()
  .min(1)
  // Everything validateCommand refuses, named here: the refusal message arrives after the model has
  // already guessed, and a list that leaves a character out invites a second broken guess.
  .describe('Command to run, exec\'d as argv without a shell, e.g. "node server.js" or "npm start". Refused: a leading "VAR=value"; any of the characters | & ; < > $ ` anywhere in it (an "=>" arrow is fine); and a quoted segment containing whitespace such as -e "const x = 1". Put the port, the environment and anything needing a shell in an npm script or a wrapper script and run that.');
const portArg = z
  .number()
  .int()
  .min(1024)
  .max(65535)
  .describe('The port the app listens on inside the container. Nothing is injected into the app: it must choose this same port itself (in its code, its .env or its npm start script). The panel does not check that the port is free.');

function row(w: Website, a: ListedApp) {
  return {
    id: a.id,
    kind: a.appKind ?? 'generic',
    command: a.command,
    workingDirectory: a.workingDirectory ?? null,
    nodeVersion: a.nodeVersion ?? null,
    startMode: a.startMode,
    proxy: a.proxyDetails ? { path: a.proxyDetails.path, port: a.proxyDetails.port, websocket: a.proxyDetails.allowWebSocketUpgrade === true } : null,
    url: appUrl(w, a.proxyDetails?.path),
  };
}

export async function listApps(ctx: ToolContext, websiteId: string): Promise<ListedApp[]> {
  const res = await ctx.client.call('GET', '/websites/{website_id}/apps/persistent', () => ctx.client.api.GET('/websites/{website_id}/apps/persistent', { params: { path: { website_id: websiteId } } }));
  return res ?? [];
}

export const persistentAppsList = defineTool({
  name: 'persistent_apps_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the persistent apps (Node processes the panel keeps running) on a website: id, command, working directory, Node version, start mode, proxy path and port, and the URL each answers on. Use it to pick a free port before persistent_app_create. Requires persistent apps on the plan.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website, 'Persistent apps');
    if (!s.ok) return s.result;
    const items = (await listApps(ctx, s.id)).map((a) => row(s.w, a));
    if (items.length === 0) {
      return ok(`${s.identity}\nno persistent apps on this website. Create one with persistent_app_create (install Node first with node_install if the container has none).`, { total: 0, items });
    }
    // Verified live: an app with no nodeVersion never starts ("exec: node: not found"), so the
    // node cell says that outright instead of the reassuring "default".
    // An app on the panel's empty path owns every URL on the domain (verified live), which a blank
    // proxy cell would hide.
    const rows = items.map((i) => ({ id: i.id, kind: i.kind, command: i.command, 'working dir': i.workingDirectory ?? '(home)', node: i.nodeVersion ?? '(none: will not start; set node_version)', start: i.startMode, proxy: i.proxy ? `${i.proxy.path === '' ? '/ (whole site)' : i.proxy.path} → :${i.proxy.port}${i.proxy.websocket ? ' (ws)' : ''}` : 'none', url: i.url ?? '-' }));
    return ok([s.identity, `persistent apps (${items.length}):`, table(rows, ['id', 'kind', 'command', 'working dir', 'node', 'start', 'proxy', 'url']), PREVIEW_NOTE].join('\n'), { total: items.length, items });
  },
});

export const persistentAppCreate = defineTool({
  name: 'persistent_app_create',
  tier: 'customer',
  risk: 'write',
  description: `Registers a persistent app: a command the panel starts in the website container and keeps running, exposed at https://<primary domain>/<proxy_path>/ (proxy_path + port) or on the whole domain (serve_at_root=true; public_html then stops being served). The command runs without a shell and nothing injects PORT: the app must itself listen on the given port. ${PROXY_STRIPS_PREFIX} A proxy path shadows public_html/<path>, so this first fetches /<proxy_path> and /<proxy_path>/ in parallel (up to about 5 s) and refuses unless both answer 404; replace_existing_path=true overrides. The panel refuses a duplicate proxy path (409) but does not check ports: pick a free one (persistent_apps_list). node_version defaults to nvm's "default" alias. Registering restarts the whole website container. Needs persistent apps and node_install; the preview domain never proxies apps.`,
  input: z.object({
    website: websiteArg,
    command: commandArg,
    working_directory: z.string().min(1).optional().describe('Directory under the site home to run in, e.g. "nodeapp" (relative, never absolute)'),
    proxy_path: z.string().min(1).optional().describe('URL path the web server proxies to the app, e.g. "node" or "api/v1" (no leading slash, and never a directory name public_html already serves)'),
    serve_at_root: z.boolean().default(false).describe('Gives the app the whole domain instead of a path: every URL goes to it, it receives the full request path, and public_html is no longer served. Mutually exclusive with proxy_path; still needs port. For a website or subdomain dedicated to this app.'),
    replace_existing_path: z.boolean().default(false).describe('Registers the app even though the path already serves something today. Whatever answers there now (a PHP page, a static file, another app) stops being reachable.'),
    port: portArg.optional(),
    allow_websocket: z.boolean().default(false),
    start_mode: startModeArg.default('automatic'),
    node_version: nodeSelectorArg.default('default').describe('Node version for this app (semver, "stable" or "default"); the default is "default", nvm\'s default alias'),
  }),
  async handler(args, ctx) {
    const s = await appsSite(ctx, args.website, 'Persistent apps');
    if (!s.ok) return s.result;
    let command: string;
    let workingDirectory: string | undefined;
    let proxy: { path: string; note?: string } | undefined;
    try {
      command = validateCommand(args.command);
      if (args.working_directory !== undefined) workingDirectory = validateWorkingDirectory(args.working_directory);
      if (args.serve_at_root && args.proxy_path !== undefined) throw new Error('serve_at_root and proxy_path cannot both be given: serve_at_root hands the app the whole domain, proxy_path hands it one path under it');
      // The empty path is the panel's whole-site app (verified live); validateProxyPath keeps
      // rejecting "" so it can only ever be reached through serve_at_root.
      if (args.serve_at_root) proxy = { path: '' };
      else if (args.proxy_path !== undefined) proxy = validateProxyPath(args.proxy_path);
      // Refused like any other bad input, in the same shape: nothing reaches the panel.
      if (proxy && args.port === undefined) throw new Error('port is required when the app is exposed (proxy_path or serve_at_root): it is the port the app listens on');
    } catch (e) {
      return fail(`${s.identity}\n${(e as Error).message}. Nothing was sent to the panel.`, { created: false });
    }
    const notes: string[] = [];
    /** What the write took off the web, for a caller that has to put it back. */
    let replaced: { status: number | null; path: string | null } | undefined;
    if (proxy) {
      const target = safe(appUrl(s.w, proxy.path));
      const pre = await pathPreflight(ctx, s.w, proxy.path);
      if (pre.taken && !args.replace_existing_path) {
        const disk = await onDiskLine(ctx, s.w, proxy.path);
        return fail([s.identity, proxy.path === '' ? rootClashRefusal(pre.detail) : pathClashRefusal(target, pre.detail, 'create'), disk].filter(Boolean).join('\n'), { created: false, url: appUrl(s.w, proxy.path), pathStatus: pre.status, onDisk: disk ?? null });
      }
      if (pre.taken) {
        notes.push(replacedNote(target, pre.detail));
        replaced = { status: pre.status, path: pre.path };
      } else if (pre.status === null) notes.push(uncheckedPathNote(target, pre.detail));
    }
    // nodeVersion is always sent: verified live, an app created without one never starts.
    const body: NewApp = { command, startMode: args.start_mode, nodeVersion: args.node_version };
    if (workingDirectory !== undefined) body.workingDirectory = workingDirectory;
    if (proxy) body.proxyDetails = { path: proxy.path, port: args.port!, allowWebSocketUpgrade: args.allow_websocket };
    // Every app the site has just before the write. The create answers 201 with no body, so the new
    // app's id comes from the listing, and only an app that was NOT listed before can be this one:
    // nothing observed live says the panel refuses two apps with the same command and directory —
    // only a duplicate proxy path is a 409 (research, Milestone C probe item 3) — so an older
    // look-alike can exist. Without the snapshot the id could be that older app's, so a failed read
    // here stops the create before anything is sent.
    let before: Set<string>;
    try {
      before = new Set((await listApps(ctx, s.id)).map((a) => a.id));
    } catch (e) {
      return fail(`${s.identity}\ncould not read the app listing before registering (${describeError(e)}), so nothing was sent to the panel. Retry, or check persistent_apps_list.`, { created: false });
    }
    const newMatch = (apps: ListedApp[]): ListedApp | undefined =>
      apps.filter((a) => !before.has(a.id) && a.command === body.command && (a.workingDirectory ?? undefined) === body.workingDirectory && (a.proxyDetails?.path ?? undefined) === body.proxyDetails?.path).at(-1);
    const outcome = await writeThenVerify({
      write: () => ctx.client.call('POST', '/websites/{website_id}/apps/persistent', () => ctx.client.api.POST('/websites/{website_id}/apps/persistent', { params: { path: { website_id: s.id } }, body })),
      find: async () => newMatch(await listApps(ctx, s.id)),
      sleep: ctx.sleep,
    });
    const url = appUrl(s.w, proxy?.path);
    if (outcome.state === 'unknown') {
      // An app that lands late still takes its path (or the whole site) off the web, and only this
      // call saw what answered there before, so that travels with the unknown outcome.
      const ifItLands = [...notes.map((n) => `${n}.`), ...(proxy?.path === '' ? [rootAppNote(safe(url))] : [])];
      return unknownOutcome(
        s.identity,
        outcome,
        { action: `registering the app "${safe(command)}"`, settle: `persistent_apps_list website=${safe(args.website)}`, ...(ifItLands.length > 0 ? { extra: `If it lands: ${ifItLands.join(' ')}` } : {}) },
        { created: null, id: null, url, ...(replaced ? { replaced } : {}) },
      );
    }
    // After a clear answer the listing read is a convenience, and the write it follows has already
    // landed. A blip on it — a 5xx, a reset, the client's own timeout — must not come back as an
    // error result: a caller told "this failed" creates the app a second time. The app is reported
    // without its id instead.
    let match: ListedApp | undefined;
    let lookupError: string | undefined;
    if (outcome.confirmedBy === 'verify') {
      match = outcome.found;
      notes.push(confirmedByReadNote(outcome.writeError));
    } else {
      try {
        match = newMatch(await listApps(ctx, s.id));
      } catch (e) {
        lookupError = describeError(e);
      }
    }
    const lines = [
      s.identity,
      `persistent app registered${match ? ` (id ${match.id})` : ''}; ${CREATE_RESTART_NOTE}.`,
      kv([
        ['command', command],
        ['working directory', workingDirectory ? `${websiteHome(s.w)}/${workingDirectory}` : `${websiteHome(s.w)} (the site home)`],
        ['node version', args.node_version === 'default' ? "default (nvm's default alias)" : args.node_version],
        ['start mode', args.start_mode],
        ['proxy', proxy ? `${proxy.path === '' ? '/ (whole site)' : `/${proxy.path}/`} → port ${args.port}${args.allow_websocket ? ', WebSocket upgrades allowed' : ''}` : 'none (not reachable from the web)'],
        ['url', url ?? '-'],
      ]),
    ];
    if (proxy?.note) notes.push(proxy.note);
    // Arguments that only mean something with a proxy path: say they were dropped rather than
    // letting the caller believe the app is exposed on that port.
    if (!proxy && (args.port !== undefined || args.allow_websocket)) notes.push(IGNORED_PROXY_ARGS_NOTE);
    if (proxy?.path === '') lines.push(rootAppNote(safe(url)));
    else if (proxy) lines.push(PROXY_SHADOWS_DOCROOT);
    lines.push(...notes);
    if (!match) lines.push(`the panel accepted it but the listing did not show a matching app yet; run persistent_apps_list to find its id.${lookupError ? ` The listing could not be read: ${lookupError}` : ''}`);
    lines.push(`next: persistent_app_log${match ? ` app_id=${match.id}` : ''} until it reports listening, then persistent_app_probe. ${PREVIEW_NOTE}`);
    return ok(lines.join('\n'), { id: match?.id ?? null, url, created: true, ...(replaced ? { replaced } : {}), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) });
  },
});

export const persistentAppUpdate = defineTool({
  name: 'persistent_app_update',
  tier: 'customer',
  risk: 'write',
  description: `Changes a persistent app: command, working directory, start mode, Node version, proxy path, port or WebSocket flag. Only the fields given are sent; a new proxy path or port is merged with the current proxy. Moving the proxy to a new path fetches /<path> and /<path>/ in parallel first (up to about 5 s) and refuses unless both answer 404; replace_existing_path=true overrides. An app cannot be made whole-site or taken off the root here: delete it and recreate it with serve_at_root=true or a proxy_path. clear_proxy unexposes the app; clear_node_version sets node_version to "default" (an app with no version never starts). The command runs without a shell, as in persistent_app_create. An update usually restarts the app and the whole website container; to restart on purpose, resend a field the app already has, e.g. start_mode=automatic.`,
  input: z.object({
    website: websiteArg,
    app_id: appIdArg,
    command: commandArg.optional(),
    working_directory: z.string().min(1).optional(),
    start_mode: startModeArg.optional(),
    node_version: nodeSelectorArg.optional(),
    proxy_path: z.string().min(1).optional(),
    port: portArg.optional(),
    allow_websocket: z.boolean().optional(),
    replace_existing_path: z.boolean().default(false).describe('Moves the proxy onto a path that already serves something today. Whatever answers there now stops being reachable.'),
    clear_proxy: z.boolean().default(false).describe('Unexposes the app: removes its proxy path so the URL falls back to the docroot while the process keeps running (verified live).'),
    clear_node_version: z.boolean().default(false).describe('Returns the app to nvm\'s default alias by setting node_version to "default"; it wins over an explicit node_version. The panel\'s unset form is not used because an app with no Node version at all never starts (verified live).'),
  }),
  async handler(args, ctx) {
    const s = await appsSite(ctx, args.website, 'Persistent apps');
    if (!s.ok) return s.result;
    const current = findApp(await listApps(ctx, s.id), args.app_id);
    if (!current) return fail(`${s.identity}\nno persistent app with id ${safe(args.app_id)} on this website; run persistent_apps_list. Nothing was changed.`, { updated: false });
    const patch: AppPatch = {};
    const notes: string[] = [];
    /** Set only when the proxy moves to a path the app does not already hold: that is the one edit
     *  that can newly shadow something, and the only one worth a request to the live site. */
    let movedTo: string | undefined;
    try {
      if (args.command !== undefined) patch.command = validateCommand(args.command);
      if (args.working_directory !== undefined) patch.workingDirectory = validateWorkingDirectory(args.working_directory);
      if (args.start_mode !== undefined) patch.startMode = args.start_mode;
      if (args.clear_node_version) {
        // Verified live: an app with no nodeVersion never starts ("exec: node: not found"), while the
        // literal "default" resolves to nvm's default alias — so that, not Unset, is the clear path.
        patch.nodeVersion = 'default';
        if (args.node_version !== undefined) notes.push(CLEAR_NODE_VERSION_WON_NOTE);
      } else if (args.node_version !== undefined) patch.nodeVersion = args.node_version;
      if (args.clear_proxy) {
        // proxyDetails Unset is the API's documented way to unexpose an app, verified live
        // 2026-09-17: the listing came back with `proxy: null`, the URL fell through to the
        // docroot (404) and the Node process kept running, with command, working directory,
        // node version and start mode untouched.
        patch.proxyDetails = { unset: true };
        if (args.proxy_path !== undefined || args.port !== undefined || args.allow_websocket !== undefined) notes.push(CLEAR_PROXY_WON_NOTE);
      } else if (args.proxy_path !== undefined || args.port !== undefined || args.allow_websocket !== undefined) {
        const path = args.proxy_path !== undefined ? validateProxyPath(args.proxy_path) : undefined;
        if (path?.note) notes.push(path.note);
        const merged = {
          path: path?.path ?? current.proxyDetails?.path,
          port: args.port ?? current.proxyDetails?.port,
          allowWebSocketUpgrade: args.allow_websocket ?? current.proxyDetails?.allowWebSocketUpgrade ?? false,
        };
        if (merged.path === undefined || merged.port === undefined) throw new Error('this app has no proxy yet: give both proxy_path and port to expose it');
        patch.proxyDetails = { path: merged.path, port: merged.port, allowWebSocketUpgrade: merged.allowWebSocketUpgrade };
        // Only when the path itself moves: a port-only edit cannot newly shadow a directory.
        if (args.proxy_path !== undefined) {
          notes.push(PROXY_SHADOWS_DOCROOT);
          if (merged.path !== current.proxyDetails?.path) movedTo = merged.path;
        }
      }
    } catch (e) {
      return fail(`${s.identity}\n${(e as Error).message}. Nothing was sent to the panel.`, { updated: false });
    }
    if (Object.keys(patch).length === 0) return fail(`${s.identity}\nnothing to change: give at least one field. Nothing was sent to the panel.`, { updated: false });
    let replaced: { status: number | null; path: string | null } | undefined;
    if (movedTo !== undefined) {
      const target = safe(appUrl(s.w, movedTo));
      const pre = await pathPreflight(ctx, s.w, movedTo);
      if (pre.taken && !args.replace_existing_path) {
        const disk = await onDiskLine(ctx, s.w, movedTo);
        return fail([s.identity, pathClashRefusal(target, pre.detail, 'move'), disk].filter(Boolean).join('\n'), { updated: false, url: appUrl(s.w, movedTo), pathStatus: pre.status, onDisk: disk ?? null });
      }
      if (pre.taken) {
        notes.push(replacedNote(target, pre.detail));
        replaced = { status: pre.status, path: pre.path };
      } else if (pre.status === null) notes.push(uncheckedPathNote(target, pre.detail));
    }
    await ctx.client.call('PATCH', '/websites/{website_id}/apps/persistent/{app_id}', () => ctx.client.api.PATCH('/websites/{website_id}/apps/persistent/{app_id}', { params: { path: { website_id: s.id, app_id: args.app_id } }, body: patch }));
    const proxyAfter = args.clear_proxy ? undefined : patch.proxyDetails && 'path' in patch.proxyDetails ? patch.proxyDetails.path : current.proxyDetails?.path;
    const url = appUrl(s.w, proxyAfter);
    const changed = Object.keys(patch).map((k) => (k === 'proxyDetails' ? 'proxy' : k === 'nodeVersion' ? 'node version' : k === 'workingDirectory' ? 'working directory' : k === 'startMode' ? 'start mode' : k));
    const lines = [s.identity, `persistent app ${safe(args.app_id)} updated (${changed.join(', ')}).`, kv([['url', url ?? '-']]), ...notes];
    // Only when the app is still exposed: the URL named above is the primary domain, and the
    // preview alias does not proxy it.
    if (url !== null) lines.push(PREVIEW_NOTE);
    lines.push(UPDATE_RESTART_NOTE);
    return ok(lines.join('\n'), { id: args.app_id, updated: true, changed, url, ...(replaced ? { replaced } : {}) });
  },
});

export const persistentAppLog = defineTool({
  name: 'persistent_app_log',
  tier: 'customer',
  risk: 'read',
  description:
    "Returns a persistent app's startup and stdout log: nvm loading, the Node version, and whatever the app printed, such as its listening line or a crash. The panel keeps the last 256 KB of it and the file is truncated on every restart, so it only ever covers the current run; the newest 64 KB is returned. Read it before changing anything when an app does not answer.",
  input: z.object({ website: websiteArg, app_id: appIdArg }),
  async handler({ website, app_id }, ctx) {
    const s = await appsSite(ctx, website, 'Persistent apps');
    if (!s.ok) return s.result;
    const current = findApp(await listApps(ctx, s.id), app_id);
    if (!current) return fail(`${s.identity}\nno persistent app with id ${safe(app_id)} on this website; run persistent_apps_list. Nothing was read.`, { bytes: 0 });
    // The panel sends the log as a JSON string; read it as text and unquote it, as php_error_log does.
    const raw = await ctx.client.call<string>('GET', '/websites/{website_id}/apps/persistent/{app_id}', () =>
      ctx.client.api.GET('/websites/{website_id}/apps/persistent/{app_id}', { params: { path: { website_id: s.id, app_id } }, parseAs: 'text' }),
    );
    const { log, bytes, truncated } = tailLog(parseScalarText(raw));
    const body =
      log.trim().length === 0
        ? 'the log is empty: the app has not started yet or has not written anything.'
        : truncated
          ? `log in structuredContent.log: the newest 64 KB of ${bytes} bytes (truncated; older lines were dropped).`
          : `log (${bytes} bytes) in structuredContent.log.`;
    return ok(`${s.identity}\napp ${safe(app_id)} (${safe(current.command)}): ${body}`, { id: app_id, bytes, truncated, log });
  },
});

/** Convention 12: the target id is `<websiteId>:<appId>`, the same shape the database tools use,
 *  so `dbTargetSite` does the split and the re-read by id; this adds the plan gate and, when asked,
 *  the app lookup. Preview and handler both go through it, never re-resolving the `website` string.
 *
 *  `lookupApp` is off for the handler: it deletes by id and prints nothing about the app, so the
 *  listing it used to fetch there was a request issued and thrown away. */
async function appTarget(ctx: ToolContext, target: Target, lookupApp = true): Promise<{ site: DbSite; w: Website; appId: string; app: ListedApp | undefined; apps: ListedApp[] }> {
  const { site, name: appId, website: w } = await dbTargetSite(ctx, target);
  const gate = persistentAppsGate(site, w, 'Persistent apps');
  if (gate) throw new Error("Persistent apps are not enabled for this website's plan");
  const apps = lookupApp ? await listApps(ctx, w.id) : [];
  return { site, w, appId, app: findApp(apps, appId), apps };
}

export const persistentAppDelete = defineTool({
  name: 'persistent_app_delete',
  tier: 'customer',
  risk: 'destructive',
  description: `DESTRUCTIVE. Stops a persistent app's process and removes the app and its proxy path; the URL stops answering at once. The app's files in the container are not touched. ${DELETE_RESTART_NOTE} Requires the user to confirm by typing the website's domain name.`,
  input: z.object({ website: websiteArg, app_id: appIdArg }),
  async target({ website, app_id }, ctx) {
    const s = await appsSite(ctx, website, 'Persistent apps');
    if (!s.ok) throw new Error("Persistent apps are not enabled for this website's plan");
    const app = findApp(await listApps(ctx, s.id), app_id);
    if (!app) throw new Error(`no persistent app with id ${safe(app_id)} on this website; run persistent_apps_list`);
    return { kind: 'persistent_app', id: `${s.id}:${app_id}`, name: s.w.domain.domain };
  },
  async preview(_args, ctx, target) {
    const { site, w, appId, app, apps } = await appTarget(ctx, target);
    const what = app ? `${safe(app.command)}${app.proxyDetails ? `, served at ${safe(appUrl(w, app.proxyDetails.path) ?? '')}` : ''}` : 'an app the listing no longer shows';
    const others = apps.filter((a) => a.id !== appId);
    // The restart hits the whole container, so the apps that stay are interrupted too: say which.
    // An app the listing no longer shows is not "the only one" of anything.
    const rest =
      others.length === 0
        ? app
          ? 'It is the only persistent app on this site.'
          : 'No other persistent app is listed on this site.'
        : `The other ${others.length} app(s) on this site stay registered, though the container restart interrupts them too: ${others.map((a) => `${a.id} (${safe(a.command)}${a.proxyDetails ? `, at ${safe(appUrl(w, a.proxyDetails.path) ?? '')}` : ', not exposed'})`).join('; ')}.`;
    return `${site.identity}\nThis will stop persistent app ${safe(appId)} (${what}) and remove it from the panel. The URL stops answering immediately; the files in the container stay. ${DELETE_RESTART_NOTE}\n${rest}`;
  },
  async handler(_args, ctx, target) {
    const { site, w, appId } = await appTarget(ctx, target!, false);
    await ctx.client.call('DELETE', '/websites/{website_id}/apps/persistent/{app_id}', () => ctx.client.api.DELETE('/websites/{website_id}/apps/persistent/{app_id}', { params: { path: { website_id: w.id, app_id: appId } } }));
    return ok(`${site.identity}\npersistent app ${safe(appId)} stopped and removed. Its log file persistent_app_${safe(appId)}.log stays in ${websiteHome(w)}; remove it over SSH if you do not want it.`, { id: appId, deleted: true });
  },
});

export const persistentAppProbe = defineTool({
  name: 'persistent_app_probe',
  tier: 'customer',
  risk: 'read',
  description: `Fetches a persistent app's URL the way the web server serves it: HTTPS to the app server's IP with the primary domain as SNI and Host (curl --resolve), so it works before DNS points at the site. Reports status, latency, the first bytes and whether the certificate is still the placeholder. For an HTML page it also fetches the first ${MAX_ASSETS} images, scripts and stylesheets it references (${ASSET_CONCURRENCY} at a time, ${ASSET_TIMEOUT_MS / 1000} s each, so up to about ${ASSET_CHECK_WORST_S} s) and fails when one is definitely missing (404, 410, 5xx); a timeout is reported as unchecked, never as a failure, and a page naming more is reported as truncated. check_assets=false skips that. Give app_id (from persistent_apps_list) or proxy_path; a whole-site app (serve_at_root) can only be probed by app_id. ${PROXY_STRIPS_PREFIX} Run it after every Node deploy, before telling anyone the site is live.`,
  input: z.object({
    website: websiteArg,
    app_id: appIdArg.optional(),
    proxy_path: z.string().min(1).optional(),
    check_assets: z.boolean().default(true).describe(`Also fetch the images, scripts and stylesheets an HTML page references (the first ${MAX_ASSETS}, same origin only, ${ASSET_CONCURRENCY} at a time) and fail when one answers 404, 410 or 5xx. This is what catches a page that renders without its assets because they are requested outside the app's path. A page naming more than ${MAX_ASSETS} is reported as truncated; assets that time out or return no HTTP status come back as unchecked and assets behind a 401/403 as restricted, neither of them a failure.`),
  }),
  async handler({ website, app_id, proxy_path, check_assets }, ctx) {
    const s = await appsSite(ctx, website, 'Persistent apps');
    if (!s.ok) return s.result;
    // After the identity block, and in the same shape as every other refusal: a throw here would
    // reach the caller as a bare exception with no sign of which website it was about.
    if (app_id === undefined && proxy_path === undefined) return fail(`${s.identity}\ngive app_id or proxy_path: there is nothing to probe without one (app_id comes from persistent_apps_list). Nothing was probed.`, { reachable: false });
    let path: string;
    if (app_id !== undefined) {
      const app = findApp(await listApps(ctx, s.id), app_id);
      if (!app) return fail(`${s.identity}\nno persistent app with id ${safe(app_id)} on this website; run persistent_apps_list. Nothing was probed.`, { reachable: false });
      if (!app.proxyDetails) return fail(`${s.identity}\napp ${safe(app_id)} has no proxy path, so it is not reachable from the web; give it one with persistent_app_update proxy_path=… port=….`, { reachable: false });
      path = app.proxyDetails.path;
    } else {
      try {
        path = validateProxyPath(proxy_path!).path;
      } catch (e) {
        return fail(`${s.identity}\n${(e as Error).message}.`, { reachable: false });
      }
    }
    const ip = serverIp(s.w);
    if (!ip) return fail(`${s.identity}\nthis website has no server IP recorded, so there is nothing to connect to.`, { reachable: false });
    const host = s.w.domain.domain;
    const url = appUrl(s.w, path)!;
    const probe = ctx.httpProbe ?? httpsProbe;
    let res;
    try {
      res = await probe({ ip, host, path: proxyRequestPath(path), timeoutMs: 5000, maxBodyBytes: 512 });
    } catch (e) {
      return fail(`${s.identity}\n${safe(url)} via ${safe(ip)}: connection failed (${safe((e as Error).message)}). The app server did not answer at all; check website_get serverIps and that the site is active.`, { url, ip, reachable: false });
    }
    const gateway = res.status === 502 || res.status === 503 || res.status === 504;
    const certNote = res.certificate === 'placeholder' ? 'the domain still serves the panel placeholder certificate (issue one with domain_ssl_issue once DNS resolves)' : res.certificate.startsWith('error:') ? `certificate check: ${safe(res.certificate)}` : 'certificate valid';
    const summary = kv([['url', url], ['connected to', ip], ['response', `HTTP ${res.status} in ${res.latencyMs} ms`], ['content-type', res.contentType ?? '-'], ['body (first 512 bytes)', res.body.trim() || '(empty)'], ['tls', certNote]]);
    const structured = { url, ip, status: res.status, latencyMs: res.latencyMs, contentType: res.contentType, body: res.body, certificate: res.certificate, reachable: !gateway && res.status > 0 };
    if (gateway) {
      return fail(`${s.identity}\n${summary}\nthe web server answered but the app is not listening on its port (HTTP ${res.status}): read persistent_app_log for the startup error, and check the app really listens on the proxy's port — nothing injects PORT, so the app must choose that port itself. ${PRIMARY_DOMAIN_ONLY}`, structured);
    }
    // A 404 has two sources that look identical from here: the app's own 404 page (verified live
    // when a Next.js build with basePath answered the proxy's "/"), and the site's docroot, which
    // returns the same 404 for a path NO app owns (seen live after clear_proxy and after a delete).
    // Naming the wrong one sends the reader hunting a build bug that does not exist.
    let notFound = '';
    if (res.status === 404) {
      const proxied = app_id !== undefined || (await listApps(ctx, s.id)).some((a) => a.proxyDetails?.path === path);
      notFound = !proxied
        ? `\nno persistent app is registered on /${safe(path)}/, so this 404 is the site's own docroot answering.`
        : path === ''
          ? `\nHTTP 404 is most likely the app's own (the web server's failures are 502/503/504): this app owns the whole domain, so it received the request path unchanged — check it serves "/".`
          : `\nHTTP 404 is most likely the app's own (the web server's failures are 502/503/504): the proxy strips the /${safe(path)} prefix, so the app received "/" — check it serves "/" (Next.js: assetPrefix, not basePath).`;
    }
    const html = (res.contentType ?? '').includes('text/html') && res.status >= 200 && res.status < 300;
    const assets = check_assets && html ? await checkPageAssets(probe, { ip, host, pageUrl: url, path }) : undefined;
    const tail = `${PRIMARY_DOMAIN_ONLY} This probe connected straight to the app server with the domain as Host, so an answer here does not prove that public DNS resolves to this site yet.`;
    // 401/403 says the asset is there and guarded, which is not a broken deploy: named, never fatal.
    const restrictedLine =
      !assets || assets.restricted.length === 0
        ? ''
        : `\n${assets.restricted.length} of the ${assets.checked} assets that answered were 401/403: served but access-controlled, not counted as failures (${assets.restricted.map((a) => `${safe(a.url)} → HTTP ${a.status}`).join(', ')}).`;
    // A fetch that never produced a status proves nothing about the asset, only about the link
    // between here and the server. Named on its own line, in both paths, and never a failure.
    const uncheckedLine =
      !assets || assets.unchecked.length === 0
        ? ''
        : `\n${assets.unchecked.length} of the ${assets.attempted} assets could not be checked (no answer in time, or no HTTP status), which is not the same as broken — re-run the probe or open the URL (${assets.unchecked.map((a) => `${safe(a.url)}: ${a.reason}`).join(', ')}).`;
    // The cap has to travel with every claim about assets: "12 answered" on a page that names
    // thirty is a clean bill of health nobody checked.
    const truncationLine = !assets?.truncated ? '' : `\nonly the first ${assets.attempted} of the ${assets.totalFound} assets the page references were fetched; the rest were not checked and may be broken too.`;
    if (assets && assets.failed.length > 0) {
      const broken = assets.failed.map(
        (a) =>
          `  ${safe(a.url)} → HTTP ${a.status}: ${
            a.outsidePrefix
              ? `requested at the domain root, outside /${safe(path)}/, where this site's own files are served: reference it as /${safe(path)}${safe(a.url)} or move the app to its own website/subdomain (serve_at_root)`
              : 'the app itself does not serve it'
          }`,
      );
      // The app is up — only its HTML is wrong — so `reachable` stays true while the result fails:
      // a deploy with broken images is not a finished deploy.
      return fail(
        [
          s.identity,
          summary,
          `the page answered HTTP ${res.status}, but ${assets.failed.length} of the ${assets.checked} assets that answered are broken:`,
          ...broken,
          ...[truncationLine, restrictedLine, uncheckedLine].filter((l) => l !== '').map((l) => l.trimStart()),
          tail,
        ].join('\n'),
        { ...structured, assets },
      );
    }
    const assetLine = !assets
      ? ''
      : assets.error !== undefined
        ? `\nthe page could not be re-read for its asset URLs (${assets.error}), so its images and scripts were not checked.`
        : assets.attempted === 0
          ? '\nthe page references no same-origin images, scripts or stylesheets to check.'
          : `\n${assetsAnswered(assets)}.${restrictedLine}${uncheckedLine}`;
    return ok(`${s.identity}\n${summary}${notFound}${assetLine}\n${tail}`, assets ? { ...structured, assets } : structured);
  },
});

export const tools: ToolDef[] = [persistentAppsList, persistentAppCreate, persistentAppUpdate, persistentAppDelete, persistentAppLog, persistentAppProbe];
