import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { components } from '../client/generated/types.js';
import type { ToolContext } from '../core/context.js';
import { websiteHome } from '../core/identity.js';
import { httpsProbe } from '../core/probe.js';
import { defineTool, type Target, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { siteOf, siteWebsiteById, websiteArg, type DbSite } from './dbcommon.js';
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

/** Where a proxied app answers: the primary domain only (verified live: the preview alias 404s). */
export function appUrl(w: Website, path: string | undefined): string | null {
  return path ? `https://${w.domain.domain}/${path}/` : null;
}

const PRIMARY_DOMAIN_ONLY = 'Persistent apps answer on the primary domain only; the *.mystaging.site preview URL does not proxy them (verified live).';
export const PREVIEW_NOTE = `${PRIMARY_DOMAIN_ONLY} Before DNS resolves, verify with persistent_app_probe.`;

/** Verified live: an app registered on a path that also exists under public_html wins — the PHP
 *  page there answered 503 while the app was merely registered, and 200 again once it was gone. */
const PROXY_SHADOWS_DOCROOT = 'the proxy path takes precedence over any public_html/<path> directory — never reuse a directory name that PHP or static files serve';

/** Verified live: create, update and delete all bounce the container, not just the app process. */
const CREATE_RESTART_NOTE = 'registering the app restarted the website container; PHP and static pages were interrupted for a second or two';
/** Arguments that describe a proxy the caller did not ask for, and arguments a clear_* flag
 *  overrode: both are silently dropped by the panel, so the tool says so instead. */
const IGNORED_PROXY_ARGS_NOTE = 'port/allow_websocket ignored: no proxy_path was given, so the app is not exposed';
const CLEAR_PROXY_WON_NOTE = 'clear_proxy won: proxy_path/port/allow_websocket were ignored and the app is no longer exposed';
const CLEAR_NODE_VERSION_WON_NOTE = 'clear_node_version won: node_version was ignored and the app was set to "default", nvm\'s default alias';
const UPDATE_RESTART_NOTE = 'An update restarts the app and, verified live, the whole website container, so the site\'s PHP and static pages are interrupted for a second or two.';
const DELETE_RESTART_NOTE = "Deleting also restarts the website container, so the site's PHP and static pages are interrupted for a second or two.";

const appIdArg = z.string().uuid().describe('Persistent app id from persistent_apps_list');
const startModeArg = z.enum(['automatic', 'manual']);
const commandArg = z
  .string()
  .min(1)
  .describe('Command to run, exec\'d as argv without a shell, e.g. "node server.js" or "npm start". No "VAR=value" prefixes, pipes, redirection or quoted arguments containing spaces — put those in an npm script or a wrapper script.');
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
    const rows = items.map((i) => ({ id: i.id, kind: i.kind, command: i.command, 'working dir': i.workingDirectory ?? '(home)', node: i.nodeVersion ?? '(none: will not start; set node_version)', start: i.startMode, proxy: i.proxy ? `${i.proxy.path} → :${i.proxy.port}${i.proxy.websocket ? ' (ws)' : ''}` : 'none', url: i.url ?? '-' }));
    return ok([s.identity, `persistent apps (${items.length}):`, table(rows, ['id', 'kind', 'command', 'working dir', 'node', 'start', 'proxy', 'url']), PREVIEW_NOTE].join('\n'), { total: items.length, items });
  },
});

export const persistentAppCreate = defineTool({
  name: 'persistent_app_create',
  tier: 'customer',
  risk: 'write',
  description: `Registers a persistent app: a command the panel starts in the website container, keeps running, and (with proxy_path and port) exposes at https://<primary domain>/<proxy_path>/. The command runs without a shell — it is split on whitespace and exec'd as argv, so "VAR=value" prefixes, pipes, redirection and quoted arguments with spaces are refused here; put the port and any environment in an npm script or a wrapper script and use "npm start" or "node server.js". Nothing injects PORT, so the app must listen on the port given here by its own configuration, and ${PROXY_SHADOWS_DOCROOT}. The panel refuses a proxy path another app already uses (409 already_exists) but does not check ports, so pick a free one from persistent_apps_list. working_directory is relative to the site home (never absolute); proxy_path never starts with "/". node_version defaults to "default", nvm's default alias: an app created without a Node version never starts (verified live: "exec: node: not found"). Registering the app restarts the whole website container, so the site's PHP and static pages are interrupted for a second or two. Requires persistent apps on the plan and Node installed (node_install). The preview domain never proxies apps.`,
  input: z.object({
    website: websiteArg,
    command: commandArg,
    working_directory: z.string().min(1).optional().describe('Directory under the site home to run in, e.g. "nodeapp" (relative, never absolute)'),
    proxy_path: z.string().min(1).optional().describe('URL path the web server proxies to the app, e.g. "node" or "api/v1" (no leading slash, and never a directory name public_html already serves)'),
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
      if (args.proxy_path !== undefined) proxy = validateProxyPath(args.proxy_path);
      // Refused like any other bad input, in the same shape: nothing reaches the panel.
      if (proxy && args.port === undefined) throw new Error('port is required when proxy_path is given: it is the port the app listens on');
    } catch (e) {
      return fail(`${s.identity}\n${(e as Error).message}. Nothing was sent to the panel.`, { created: false });
    }
    // nodeVersion is always sent: verified live, an app created without one never starts.
    const body: NewApp = { command, startMode: args.start_mode, nodeVersion: args.node_version };
    if (workingDirectory !== undefined) body.workingDirectory = workingDirectory;
    if (proxy) body.proxyDetails = { path: proxy.path, port: args.port!, allowWebSocketUpgrade: args.allow_websocket };
    await ctx.client.call('POST', '/websites/{website_id}/apps/persistent', () => ctx.client.api.POST('/websites/{website_id}/apps/persistent', { params: { path: { website_id: s.id } }, body }));
    // The create answers 201 with no body, so the id comes from the listing: the newest app whose
    // command, working directory and proxy path match what was just sent.
    const match = (await listApps(ctx, s.id)).filter((a) => a.command === body.command && (a.workingDirectory ?? undefined) === body.workingDirectory && (a.proxyDetails?.path ?? undefined) === body.proxyDetails?.path).at(-1);
    const url = appUrl(s.w, proxy?.path);
    const lines = [
      s.identity,
      `persistent app registered${match ? ` (id ${match.id})` : ''}; ${CREATE_RESTART_NOTE}.`,
      kv([
        ['command', command],
        ['working directory', workingDirectory ? `${websiteHome(s.w)}/${workingDirectory}` : `${websiteHome(s.w)} (the site home)`],
        ['node version', args.node_version === 'default' ? "default (nvm's default alias)" : args.node_version],
        ['start mode', args.start_mode],
        ['proxy', proxy ? `/${proxy.path}/ → port ${args.port}${args.allow_websocket ? ', WebSocket upgrades allowed' : ''}` : 'none (not reachable from the web)'],
        ['url', url ?? '-'],
      ]),
    ];
    const notes: string[] = [];
    if (proxy?.note) notes.push(proxy.note);
    // Arguments that only mean something with a proxy path: say they were dropped rather than
    // letting the caller believe the app is exposed on that port.
    if (!proxy && (args.port !== undefined || args.allow_websocket)) notes.push(IGNORED_PROXY_ARGS_NOTE);
    if (proxy) lines.push(PROXY_SHADOWS_DOCROOT);
    lines.push(...notes);
    if (!match) lines.push('the panel accepted it but the listing did not show a matching app yet; run persistent_apps_list to find its id.');
    lines.push(`next: persistent_app_log${match ? ` app_id=${match.id}` : ''} until it reports listening, then persistent_app_probe. ${PREVIEW_NOTE}`);
    return ok(lines.join('\n'), { id: match?.id ?? null, url, created: true, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) });
  },
});

export const persistentAppUpdate = defineTool({
  name: 'persistent_app_update',
  tier: 'customer',
  risk: 'write',
  description: `Changes a persistent app: command, working directory, start mode, Node version, proxy path, port or WebSocket flag. Only the fields given are sent and the rest keep their current value; a new proxy path or port is merged with the current proxy. clear_proxy unexposes the app; clear_node_version returns the app to nvm's default alias by setting node_version to "default" (the panel's unset form is not used because an app with no Node version at all never starts, verified live). The command runs without a shell, under the same rules as persistent_app_create. ${UPDATE_RESTART_NOTE}`,
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
    clear_proxy: z.boolean().default(false),
    clear_node_version: z.boolean().default(false).describe('Returns the app to nvm\'s default alias by setting node_version to "default"; it wins over an explicit node_version. The panel\'s unset form is not used because an app with no Node version at all never starts (verified live).'),
  }),
  async handler(args, ctx) {
    const s = await appsSite(ctx, args.website, 'Persistent apps');
    if (!s.ok) return s.result;
    const current = findApp(await listApps(ctx, s.id), args.app_id);
    if (!current) return fail(`${s.identity}\nno persistent app with id ${safe(args.app_id)} on this website; run persistent_apps_list.`, { updated: false });
    const patch: AppPatch = {};
    const notes: string[] = [];
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
        // proxyDetails Unset is the API's documented way to unexpose an app; not yet exercised live (Task 7 / walkthrough).
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
        if (args.proxy_path !== undefined) notes.push(PROXY_SHADOWS_DOCROOT);
      }
    } catch (e) {
      return fail(`${s.identity}\n${(e as Error).message}. Nothing was sent to the panel.`, { updated: false });
    }
    if (Object.keys(patch).length === 0) return fail(`${s.identity}\nnothing to change: give at least one field. Nothing was sent to the panel.`, { updated: false });
    await ctx.client.call('PATCH', '/websites/{website_id}/apps/persistent/{app_id}', () => ctx.client.api.PATCH('/websites/{website_id}/apps/persistent/{app_id}', { params: { path: { website_id: s.id, app_id: args.app_id } }, body: patch }));
    const proxyAfter = args.clear_proxy ? undefined : patch.proxyDetails && 'path' in patch.proxyDetails ? patch.proxyDetails.path : current.proxyDetails?.path;
    const url = appUrl(s.w, proxyAfter);
    const changed = Object.keys(patch).map((k) => (k === 'proxyDetails' ? 'proxy' : k === 'nodeVersion' ? 'node version' : k === 'workingDirectory' ? 'working directory' : k === 'startMode' ? 'start mode' : k));
    const lines = [s.identity, `persistent app ${safe(args.app_id)} updated (${changed.join(', ')}).`, kv([['url', url ?? '-']]), ...notes];
    // Only when the app is still exposed: the URL named above is the primary domain, and the
    // preview alias does not proxy it.
    if (url !== null) lines.push(PREVIEW_NOTE);
    lines.push(UPDATE_RESTART_NOTE);
    return ok(lines.join('\n'), { id: args.app_id, updated: true, changed, url });
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
    if (!current) return fail(`${s.identity}\nno persistent app with id ${safe(app_id)} on this website; run persistent_apps_list.`, { bytes: 0 });
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

/** Convention 12: the target id is `<websiteId>:<appId>`; preview and handler re-read that site
 *  by id and re-check the plan flag, never re-resolving the `website` string. */
async function appTarget(ctx: ToolContext, target: Target): Promise<{ site: DbSite; w: Website; appId: string; app: ListedApp | undefined }> {
  const cut = target.id.indexOf(':');
  if (cut <= 0) throw new Error(`malformed persistent app target "${safe(target.id)}"`);
  const { org, w } = await siteWebsiteById(ctx, target.id.slice(0, cut));
  const site = siteOf(ctx, org, w);
  const gate = persistentAppsGate(site, w, 'Persistent apps');
  if (gate) throw new Error("Persistent apps are not enabled for this website's plan");
  const appId = target.id.slice(cut + 1);
  return { site, w, appId, app: findApp(await listApps(ctx, w.id), appId) };
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
    const { site, w, appId, app } = await appTarget(ctx, target);
    const what = app ? `${safe(app.command)}${app.proxyDetails ? `, served at ${appUrl(w, app.proxyDetails.path)}` : ''}` : 'an app the listing no longer shows';
    return `${site.identity}\nThis will stop persistent app ${safe(appId)} (${what}) and remove it from the panel. The URL stops answering immediately; the files in the container stay. ${DELETE_RESTART_NOTE}`;
  },
  async handler(_args, ctx, target) {
    const { site, w, appId } = await appTarget(ctx, target!);
    await ctx.client.call('DELETE', '/websites/{website_id}/apps/persistent/{app_id}', () => ctx.client.api.DELETE('/websites/{website_id}/apps/persistent/{app_id}', { params: { path: { website_id: w.id, app_id: appId } } }));
    return ok(`${site.identity}\npersistent app ${safe(appId)} stopped and removed. Its log file persistent_app_${safe(appId)}.log stays in ${websiteHome(w)}; remove it over SSH if you do not want it.`, { id: appId, deleted: true });
  },
});

export const persistentAppProbe = defineTool({
  name: 'persistent_app_probe',
  tier: 'customer',
  risk: 'read',
  description:
    "Fetches a persistent app's URL the way the web server serves it: HTTPS to the app server's IP with the primary domain as SNI and Host (the curl --resolve equivalent), so it works before DNS points at the site. Reports status, latency, the first bytes of the body, and whether the domain still has the placeholder certificate. Give app_id (from persistent_apps_list) or a proxy_path.",
  input: z.object({ website: websiteArg, app_id: appIdArg.optional(), proxy_path: z.string().min(1).optional() }),
  async handler({ website, app_id, proxy_path }, ctx) {
    if (app_id === undefined && proxy_path === undefined) throw new Error('give app_id or proxy_path');
    const s = await appsSite(ctx, website, 'Persistent apps');
    if (!s.ok) return s.result;
    let path: string;
    if (app_id !== undefined) {
      const app = findApp(await listApps(ctx, s.id), app_id);
      if (!app) return fail(`${s.identity}\nno persistent app with id ${safe(app_id)} on this website; run persistent_apps_list.`, { reachable: false });
      if (!app.proxyDetails) return fail(`${s.identity}\napp ${safe(app_id)} has no proxy path, so it is not reachable from the web; give it one with persistent_app_update proxy_path=… port=….`, { reachable: false });
      path = app.proxyDetails.path;
    } else {
      try {
        path = validateProxyPath(proxy_path!).path;
      } catch (e) {
        return fail(`${s.identity}\n${(e as Error).message}.`, { reachable: false });
      }
    }
    const ip = (s.w.serverIps?.find((x) => x.isPrimary) ?? s.w.serverIps?.[0])?.ip;
    if (!ip) return fail(`${s.identity}\nthis website has no server IP recorded, so there is nothing to connect to.`, { reachable: false });
    const host = s.w.domain.domain;
    const url = appUrl(s.w, path)!;
    const probe = ctx.httpProbe ?? httpsProbe;
    let res;
    try {
      res = await probe({ ip, host, path: `/${path}/`, timeoutMs: 5000, maxBodyBytes: 512 });
    } catch (e) {
      return fail(`${s.identity}\n${url} via ${ip}: connection failed (${safe((e as Error).message)}). The app server did not answer at all; check website_get serverIps and that the site is active.`, { url, ip, reachable: false });
    }
    const gateway = res.status === 502 || res.status === 503 || res.status === 504;
    const certNote = res.certificate === 'placeholder' ? 'the domain still serves the panel placeholder certificate (issue one with domain_ssl_issue once DNS resolves)' : res.certificate.startsWith('error:') ? `certificate check: ${safe(res.certificate)}` : 'certificate valid';
    const summary = kv([['url', url], ['connected to', ip], ['response', `HTTP ${res.status} in ${res.latencyMs} ms`], ['content-type', res.contentType ?? '-'], ['body (first 512 bytes)', res.body.trim() || '(empty)'], ['tls', certNote]]);
    const structured = { url, ip, status: res.status, latencyMs: res.latencyMs, contentType: res.contentType, body: res.body, certificate: res.certificate, reachable: !gateway && res.status > 0 };
    if (gateway) {
      return fail(`${s.identity}\n${summary}\nthe web server answered but the app is not listening on its port (HTTP ${res.status}): read persistent_app_log for the startup error, and check the app really listens on the proxy's port — nothing injects PORT, so the app must choose that port itself.`, structured);
    }
    return ok(`${s.identity}\n${summary}\n${PRIMARY_DOMAIN_ONLY} This probe connected straight to the app server with the domain as Host, so an answer here does not prove that public DNS resolves to this site yet.`, structured);
  },
});

export const tools: ToolDef[] = [persistentAppsList, persistentAppCreate, persistentAppUpdate, persistentAppDelete, persistentAppLog, persistentAppProbe];
