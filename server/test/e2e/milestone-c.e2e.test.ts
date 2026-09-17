import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import type { ToolContext } from '../../src/core/context.js';
import { GateError } from '../../src/core/gate.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';

const enabled = process.env['ENHANCE_E2E'] === '1';
const suite = enabled ? describe : describe.skip;

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The row persistent_apps_list puts in structuredContent: the tool's own mapped shape, not the
 *  panel's raw app payload (which is why there is no assertRequired call in this file). */
type ListedRow = {
  id: string;
  kind: string;
  command: string;
  workingDirectory: string | null;
  nodeVersion: string | null;
  startMode: string;
  proxy: { path: string; port: number; websocket: boolean } | null;
  url: string | null;
};

suite('milestone C against the live panel', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  /**
   * The existing site every tool here addresses, as milestone B does: this suite creates no
   * website, only one throwaway persistent app inside the site named by ENHANCE_E2E_SITE.
   */
  let site: string;
  // A path no real app uses: `mcpc-<5 hex>`. The port is not random-only — it is picked against
  // the live listing inside the test, because the panel does not check that a port is free.
  const slug = `mcpc-${randomBytes(3).toString('hex').slice(0, 5)}`;
  /** The id of the one app this run created, and the only id cleanup is ever allowed to remove. */
  let appId: string | undefined;

  // Live suite only: call tools directly against the live-panel `ctx`, parsing through the tool's
  // own schema (convention 1) without the fake-panel helpers the unit suite uses.
  async function call<A>(t: ToolDef<A>, args: unknown): Promise<ToolResult> {
    return t.handler(t.input.parse(args), ctx);
  }

  async function listedRows(): Promise<ListedRow[]> {
    const r = await call(tool(tools, 'persistent_apps_list'), { website: site });
    return (r.structured as { items: ListedRow[] }).items;
  }

  async function listedIds(): Promise<string[]> {
    return (await listedRows()).map((a) => a.id);
  }

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    site = process.env['ENHANCE_E2E_SITE'] ?? '';
    expect(site, 'ENHANCE_E2E_SITE must name an existing website (e.g. vahi.dev) for the milestone C live suite; it creates one throwaway mcpc-… persistent app on that site').toBeTruthy();
    // A read-only registry never registers persistent_app_create and friends, so say why here
    // instead of failing several lines later with a bare "tool not registered".
    expect(ctx.config.readOnly, 'ENHANCE_READ_ONLY is set: the milestone C live suite needs the write and destructive tools').toBe(false);
  });

  afterAll(async () => {
    if (!site || !appId) return;
    // Bypasses the gate on purpose, and only for the id this run created and the panel still lists.
    try {
      if ((await listedIds()).includes(appId)) {
        const del = tool(tools, 'persistent_app_delete');
        const args = del.input.parse({ website: site, app_id: appId });
        const target = await del.target!(args, ctx).catch(() => undefined);
        if (target?.id.endsWith(`:${appId}`)) await del.handler(args, ctx, target);
      }
    } catch (e) {
      console.error(`e2e cleanup: could not remove persistent app ${appId}; delete it by hand: ${(e as Error).message}`);
    }
    // The persistent_app_<id>.log file stays in the home directory; removing it needs SSH.
  });

  it("the Node runtime tools answer and the installed list is labelled as the panel's", async () => {
    const avail = await call(tool(tools, 'node_versions_available'), { website: site });
    expect(avail.isError, avail.text).toBeFalsy();
    const versions = (avail.structured as { versions: string[] }).versions;
    expect(versions.length).toBeGreaterThan(10);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = await call(tool(tools, 'node_versions_installed'), { website: site });
    expect(installed.isError, installed.text).toBeFalsy();
    expect(installed.text).toContain('as reported by the panel');
    // If the container has no nvm yet, install it and give the panel a minute. Later runs skip
    // this: a repeat node_install is a harmless no-op, but a full minute of waiting is not.
    if ((installed.structured as { versions: string[] }).versions.length === 0) {
      const inst = await call(tool(tools, 'node_install'), { website: site });
      expect(inst.isError, inst.text).toBeFalsy();
      await sleep(60_000);
    }
  }, 150_000);

  it('creates an inline app, sees it listening in the log, probes it on the domain, updates it, and deletes it through the gate', async () => {
    // The panel refuses a duplicate proxy path but does NOT check ports, so two apps can silently
    // fight over one port. Pick a port in 3900–3999 that no app on this site already proxies to,
    // starting from a random offset and wrapping, so parallel sites and reruns do not collide.
    const taken = new Set((await listedRows()).map((a) => a.proxy?.port).filter((p): p is number => typeof p === 'number'));
    const offset = randomBytes(1)[0]! % 100;
    const port = Array.from({ length: 100 }, (_, i) => 3900 + ((offset + i) % 100)).find((p) => !taken.has(p));
    expect(port, 'every port in 3900–3999 is already proxied by a persistent app on this site; clean them up before running this suite').toBeTruthy();
    // No whitespace in the marker, because there is none anywhere in the command: see below.
    const marker = `mcp-c-ok-${slug}`;
    /**
     * No files to upload: the whole app is one inline Node script that echoes the marker. The
     * command is built here, after the port is known, because the port is hard-coded into it.
     *
     * Verified live (docs/research.md, "Milestone C Task 1 probe"): the panel's runner ends in
     * `exec "$@"` with the command's words as arguments, so there is no shell — a `PORT=…` prefix
     * would become argv[0] and a quoted segment containing whitespace would be split apart. Nothing
     * injects `PORT` either. So the port is hard-coded into the script and the script carries no
     * whitespace at all; the `'…'` quotes are literal argv characters that survive the word split,
     * and `=>` is an arrow, not a redirection. `validateCommand` refuses every other shape.
     */
    const command = `node -e require('http').createServer((q,s)=>s.end('${marker}')).listen(${port})`;

    // Optional, because it needs a path this particular site already serves: on vahi.dev
    // ENHANCE_E2E_TAKEN_PATH=demo-login is the live PHP page whose 200 the preflight must refuse to
    // replace (the clash that turned that page into a 503 during the Task 1 probe). Unset, the
    // suite stays site-agnostic and skips it.
    const takenPath = process.env['ENHANCE_E2E_TAKEN_PATH'];
    if (takenPath) {
      const clash = await call(tool(tools, 'persistent_app_create'), { website: site, command, proxy_path: takenPath, port });
      // A preflight that cannot reach the site does NOT block the write, so this create can land a
      // real app on a path that serves a real page. Remove it before asserting anything, or the
      // failure leaves the site's own page shadowed by this suite's throwaway app.
      const strayId = (clash.structured as { id?: string | null } | undefined)?.id ?? undefined;
      let stray = '';
      if (strayId) {
        stray = ` It registered app ${strayId} on that path`;
        try {
          const del = tool(tools, 'persistent_app_delete');
          const args = del.input.parse({ website: site, app_id: strayId });
          const target = await del.target!(args, ctx).catch(() => undefined);
          if (target?.id.endsWith(`:${strayId}`)) await del.handler(args, ctx, target);
          stray += ', now deleted again';
        } catch (e) {
          stray += `, and it could NOT be deleted — remove it by hand: ${(e as Error).message}`;
        }
      }
      expect(clash.isError, `the preflight let a create through on ${takenPath}, which already serves something.${stray}: ${clash.text}`).toBe(true);
      expect(clash.text).toMatch(/would replace what/);
      expect(clash.text).toContain('replace_existing_path');
      expect((clash.structured as { created: boolean }).created).toBe(false);
      expect((await listedRows()).some((a) => a.proxy?.path === takenPath), 'the refused create registered an app anyway').toBe(false);
    }

    const created = await call(tool(tools, 'persistent_app_create'), { website: site, command, proxy_path: slug, port });
    expect(created.isError, created.text).toBeFalsy();
    appId = (created.structured as { id: string | null }).id ?? undefined;
    if (!appId) {
      // The listing lagged the create; find it by our unique command.
      appId = (await listedRows()).find((a) => a.command === command)?.id;
    }
    // The automatic cleanup only ever removes an id this run recorded, so if the create landed and
    // the id did not, the app is now orphaned and a human has to remove it.
    expect(appId, `persistent_app_create did not yield an app id. The create itself did not report an error, so an app is probably running on ${site}: open persistent_apps_list and delete the one whose proxy path is "${slug}" (command: ${command}) by hand — this suite's cleanup cannot.`).toBeTruthy();

    // The panel starts it asynchronously (and the create bounced the whole container): poll the
    // probe for up to 60 s rather than asserting on the first answer.
    let probe: ToolResult | undefined;
    for (let i = 0; i < 12; i += 1) {
      probe = await call(tool(tools, 'persistent_app_probe'), { website: site, app_id: appId });
      if (!probe.isError && (probe.structured as { body: string }).body.includes(marker)) break;
      await sleep(5_000);
    }
    // When the loop ran out, the probe's own text says only that the web server answered without
    // the app: the app's log is the thing that names the real cause, so put its tail in the
    // failure message rather than making the operator go and fetch it.
    let why = probe?.text;
    if (!probe || probe.isError || !(probe.structured as { body: string }).body.includes(marker)) {
      const tail = await call(tool(tools, 'persistent_app_log'), { website: site, app_id: appId })
        .then((l) => ((l.structured as { log?: string }).log ?? '').slice(-600))
        .catch((e: unknown) => `persistent_app_log also failed: ${(e as Error).message}`);
      why = `${probe?.text ?? 'the probe never ran'}\n--- last 600 chars of persistent_app_log ---\n${tail || '(the log is empty)'}`;
    }
    expect(probe?.isError, why).toBeFalsy();
    expect((probe!.structured as { status: number; body: string }).status, why).toBe(200);
    expect((probe!.structured as { body: string }).body, why).toContain(marker);

    const log = await call(tool(tools, 'persistent_app_log'), { website: site, app_id: appId });
    expect(log.isError, log.text).toBeFalsy();
    expect((log.structured as { bytes: number }).bytes).toBeGreaterThan(0);

    const updated = await call(tool(tools, 'persistent_app_update'), { website: site, app_id: appId, allow_websocket: true });
    expect(updated.isError, updated.text).toBeFalsy();
    // Only the panel's own listing is read after the update: an update restarts the container
    // (verified live), so the app itself needs up to 30 s before it would answer a probe again.
    // The listing can lag the PATCH by a moment, so re-read it a couple of times before failing.
    let mine: ListedRow | undefined;
    for (let i = 0; i < 3; i += 1) {
      mine = (await listedRows()).find((a) => a.id === appId);
      if (mine?.proxy?.websocket === true) break;
      if (i < 2) await sleep(3_000);
    }
    expect(mine, 'the app this run created is no longer in the listing after persistent_app_update').toBeTruthy();
    // The PATCH carried allow_websocket alone: the flag must have changed and every other field
    // must have survived the merge, which is the whole point of sending a partial body.
    expect(mine!.proxy?.websocket).toBe(true);
    expect(mine!.command, 'the partial PATCH dropped the command').toBe(command);
    expect(mine!.proxy?.path, 'the partial PATCH dropped the proxy path').toBe(slug);
    expect(mine!.proxy?.port, 'the partial PATCH dropped the proxy port').toBe(port);
    expect(mine!.nodeVersion, 'the partial PATCH dropped the Node version; an app without one never starts').toBeTruthy();
    // structuredContent carries the tool's mapped row, not the panel's raw app object.
    expect(Object.keys(mine!)).toEqual(expect.arrayContaining(['id', 'kind', 'command', 'startMode', 'proxy', 'url']));

    // The delete goes through the real gate, exactly as a human would drive it: issue a token,
    // watch a mistyped name bounce, then confirm with the name the preview showed.
    const del = tool(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: site, app_id: appId });
    const target = await del.target!(args, ctx);
    // The gate makes the human type the website's *primary* domain. That is the same string as
    // ENHANCE_E2E_SITE whenever the suite is pointed at the site by its primary domain (vahi.dev);
    // point it at an alias instead and this is the one line to relax.
    expect(target.name).toBe(site);
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(slug);
    const token = ctx.gate.issue(del.name, target, args);
    let mistyped: unknown;
    try {
      ctx.gate.verify(token, `not-${site}`);
    } catch (e) {
      mistyped = e;
    }
    expect(mistyped, 'the gate accepted a name that is not the website').toBeInstanceOf(GateError);
    expect((mistyped as GateError).reason).toBe('mismatch');
    // The happy path on the same token: the name the preview showed is what the matcher accepts,
    // and the handler then runs with the args and target the gate pinned, not the ones above.
    const pending = ctx.gate.verify(token, site);
    expect(pending.tool).toBe(del.name);
    expect(pending.target.id).toBe(target.id);
    const r = await del.handler(pending.args, ctx, pending.target);
    expect(r.isError, r.text).toBeFalsy();
    expect(await listedIds()).not.toContain(appId);
  }, 150_000);
});
