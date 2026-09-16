import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import type { ToolContext } from '../../src/core/context.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';

const enabled = process.env['ENHANCE_E2E'] === '1';
const suite = enabled ? describe : describe.skip;

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('milestone C against the live panel', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  /**
   * The existing site every tool here addresses, as milestone B does: this suite creates no
   * website, only one throwaway persistent app inside the site named by ENHANCE_E2E_SITE.
   */
  let site: string;
  // A path and port no real app uses: `mcpc-<5 hex>` and a port in 3900–3999 from the same bytes.
  const slug = `mcpc-${randomBytes(3).toString('hex').slice(0, 5)}`;
  const port = 3900 + (randomBytes(1)[0]! % 100);
  // No whitespace in the marker, because there is none anywhere in the command: see below.
  const marker = `mcp-c-ok-${slug}`;
  /**
   * No files to upload: the whole app is one inline Node script that echoes the marker.
   *
   * Verified live (docs/research.md, "Milestone C Task 1 probe"): the panel's runner ends in
   * `exec "$@"` with the command's words as arguments, so there is no shell — a `PORT=…` prefix
   * would become argv[0] and a quoted segment containing whitespace would be split apart. Nothing
   * injects `PORT` either. So the port is hard-coded into the script and the script carries no
   * whitespace at all; the `'…'` quotes are literal argv characters that survive the word split,
   * and `=>` is an arrow, not a redirection. `validateCommand` refuses every other shape.
   */
  const command = `node -e require('http').createServer((q,s)=>s.end('${marker}')).listen(${port})`;
  /** The id of the one app this run created, and the only id cleanup is ever allowed to remove. */
  let appId: string | undefined;

  // Live suite only: call tools directly against the live-panel `ctx`, parsing through the tool's
  // own schema (convention 1) without the fake-panel helpers the unit suite uses.
  async function call<A>(t: ToolDef<A>, args: unknown): Promise<ToolResult> {
    return t.handler(t.input.parse(args), ctx);
  }

  async function listedIds(): Promise<string[]> {
    const r = await call(tool(tools, 'persistent_apps_list'), { website: site });
    return (r.structured as { items: Array<{ id: string }> }).items.map((a) => a.id);
  }

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    site = process.env['ENHANCE_E2E_SITE'] ?? '';
    expect(site, 'ENHANCE_E2E_SITE must name an existing website (e.g. vahi.dev) for the milestone C live suite; it creates one throwaway mcpc-… persistent app on that site').toBeTruthy();
    // A read-only registry never registers persistent_app_create and friends, so say why here
    // instead of failing several lines later with a bare "tool … not registered".
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
    const created = await call(tool(tools, 'persistent_app_create'), { website: site, command, proxy_path: slug, port });
    expect(created.isError, created.text).toBeFalsy();
    appId = (created.structured as { id: string | null }).id ?? undefined;
    if (!appId) {
      // The listing lagged the create; find it by our unique command.
      const list = await call(tool(tools, 'persistent_apps_list'), { website: site });
      appId = (list.structured as { items: Array<{ id: string; command: string }> }).items.find((a) => a.command === command)?.id;
    }
    expect(appId, 'persistent_app_create did not yield an app id').toBeTruthy();

    // The panel starts it asynchronously (and the create bounced the whole container): poll the
    // probe for up to 60 s rather than asserting on the first answer.
    let probe: ToolResult | undefined;
    for (let i = 0; i < 12; i += 1) {
      probe = await call(tool(tools, 'persistent_app_probe'), { website: site, app_id: appId });
      if (!probe.isError && (probe.structured as { body: string }).body.includes(marker)) break;
      await sleep(5_000);
    }
    expect(probe?.isError, probe?.text).toBeFalsy();
    expect((probe!.structured as { status: number; body: string }).status).toBe(200);
    expect((probe!.structured as { body: string }).body).toContain(marker);

    const log = await call(tool(tools, 'persistent_app_log'), { website: site, app_id: appId });
    expect(log.isError, log.text).toBeFalsy();
    expect((log.structured as { bytes: number }).bytes).toBeGreaterThan(0);

    const updated = await call(tool(tools, 'persistent_app_update'), { website: site, app_id: appId, allow_websocket: true });
    expect(updated.isError, updated.text).toBeFalsy();
    // Only the panel's own listing is read after the update: an update restarts the container
    // (verified live), so the app itself needs up to 30 s before it would answer a probe again.
    const list = await call(tool(tools, 'persistent_apps_list'), { website: site });
    const mine = (list.structured as { items: Array<{ id: string; proxy: { websocket: boolean } | null }> }).items.find((a) => a.id === appId);
    expect(mine?.proxy?.websocket).toBe(true);

    const del = tool(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: site, app_id: appId });
    const target = await del.target!(args, ctx);
    // The gate makes the human type the website's *primary* domain. That is the same string as
    // ENHANCE_E2E_SITE whenever the suite is pointed at the site by its primary domain (vahi.dev);
    // point it at an alias instead and this is the one line to relax.
    expect(target.name).toBe(site);
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(slug);
    const r = await del.handler(args, ctx, target);
    expect(r.isError, r.text).toBeFalsy();
    expect(await listedIds()).not.toContain(appId);
  }, 150_000);
});
