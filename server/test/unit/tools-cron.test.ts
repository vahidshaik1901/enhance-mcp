import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/cron.js';
import { base, ORG_ID, websiteDetail, WEBSITE_ID, websiteSummary, websitesList } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const cronPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/crontab`;
const containerPath = `/websites/${WEBSITE_ID}/container_cron_enabled`;
const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;

const JOB_A = '0 3 * * * php /var/www/x/cron.php';
const JOB_B = '*/5 * * * * php artisan schedule:run';

/** Line numbers in a crontab response are 0-based (verified live 2026-09-06). */
const twoLines = {
  items: [
    { cronCmd: { lineNumber: 0, expr: JOB_A } },
    { variable: { lineNumber: 1, key: 'PATH', val: '/usr/local/bin:/usr/bin' } },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Records every crontab request in order — method plus the parsed body for the writes — so a
 *  tool that reads before it appends can be asserted on exactly what the panel saw, and when. */
function crontabTrace(seen: Array<{ method: string; body?: unknown }>, listing: unknown = twoLines): Route[] {
  return [
    { method: 'GET', path: cronPath, handler: async () => { seen.push({ method: 'GET' }); return json(listing); } },
    { method: 'PATCH', path: cronPath, handler: async (req) => { seen.push({ method: 'PATCH', body: await req.json() }); return new Response(null, { status: 204 }); } },
  ];
}

describe('cron_get', () => {
  it('lists command lines and variables with the panel’s own 0-based numbering', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: cronPath, body: twoLines }]);
    const r = await callTool(byName(tools, 'cron_get'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(JOB_A);
    expect(r.text).toContain('PATH');
    expect(r.text).toContain('/usr/local/bin:/usr/bin');
    // The human has to know the numbering is 0-based before calling cron_remove.
    expect(r.text).toContain('numbered from 0');
    expect(r.structured).toEqual({ commands: 1, variables: 1, items: twoLines.items });
  });

  it('renders an empty crontab without inventing rows', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: cronPath, body: { items: [] } }]);
    const r = await callTool(byName(tools, 'cron_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('cron commands (0)');
    expect(r.structured).toEqual({ commands: 0, variables: 0, items: [] });
  });
});

describe('cron_add', () => {
  it('reads the crontab first, then appends one PATCH per job after the last existing line', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen)]);
    const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [JOB_B, '@daily /usr/bin/backup.sh'] }, ctx);
    expect(seen).toEqual([
      { method: 'GET' },
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 2, expr: JOB_B } }] } },
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 3, expr: '@daily /usr/bin/backup.sh' } }] } },
    ]);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('2, 3');
    expect(r.text).toContain('container_cron_get');
    expect(r.structured).toEqual({ added: [{ line: 2, expr: JOB_B }, { line: 3, expr: '@daily /usr/bin/backup.sh' }] });
  });

  it('appends from line 0 on an empty crontab', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen, { items: [] })]);
    const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [JOB_B] }, ctx);
    expect(seen).toEqual([{ method: 'GET' }, { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 0, expr: JOB_B } }] } }]);
    expect(r.structured).toEqual({ added: [{ line: 0, expr: JOB_B }] });
  });

  it('rejects a line that is not a schedule plus a command before anything is sent', async () => {
    const { ctx, f } = await makeContext([...base(), ...crontabTrace([])]);
    for (const bad of ['', 'php artisan schedule:run', '* * * * *', '@daily', '@nope /bin/true', '0 3 * * * php x\n0 4 * * * php y']) {
      await expect(callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [bad] }, ctx)).rejects.toThrow();
    }
    await expect(callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('says in its description that variables (and MAILTO in particular) are not settable here', async () => {
    const d = byName(tools, 'cron_add').description;
    expect(d).toContain('MAILTO');
  });
});

describe('cron_remove', () => {
  it('removes the highest line first, one request per line, so renumbering cannot shift a target', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen)]);
    const r = await callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [0, 2] }, ctx);
    expect(seen).toEqual([
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 2 } }] } },
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 0 } }] } },
    ]);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('2, 0');
    expect(r.text).toContain('renumbered from 0');
    expect(r.structured).toEqual({ removed: [2, 0] });
  });

  it('sends one request per distinct line number', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen)]);
    const r = await callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [1, 4, 1] }, ctx);
    expect(seen).toEqual([
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 4 } }] } },
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 1 } }] } },
    ]);
    expect(r.structured).toEqual({ removed: [4, 1] });
  });

  it('rejects an empty list and a negative line number before anything is sent', async () => {
    const { ctx, f } = await makeContext([...base(), ...crontabTrace([])]);
    await expect(callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [] }, ctx)).rejects.toThrow();
    await expect(callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [-1] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

/** A second website that takes over the domain after `target()` has already resolved it. */
const OTHER_WEBSITE_ID = 'a1b2c3d4-5566-4778-9900-aabbccddeeff';

function movingTargetRoutes(seen: string[]): Route[] {
  let listCalls = 0;
  return [
    {
      method: 'GET',
      path: `/orgs/${ORG_ID}/websites`,
      handler: async () => {
        listCalls += 1;
        return json(listCalls === 1 ? websitesList : { items: [{ ...websiteSummary, id: OTHER_WEBSITE_ID }], total: 1 });
      },
    },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${OTHER_WEBSITE_ID}`, body: { ...websiteDetail, id: OTHER_WEBSITE_ID } },
    {
      method: 'DELETE',
      path: new RegExp(`^/orgs/${ORG_ID}/websites/[^/]+/crontab$`),
      handler: async (_req, url) => { seen.push(url.pathname.replace(/^\/api/, '')); return new Response(null, { status: 204 }); },
    },
  ];
}

describe('cron_delete', () => {
  it('is destructive, previews the whole crontab going away, and clears it', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: cronPath, status: 204 }]);
    const del = byName(tools, 'cron_delete');
    const args = del.input.parse({ website: 'vahi.dev' });
    const target = await del.target!(args, ctx);
    expect(target).toEqual({ kind: 'crontab', id: WEBSITE_ID, name: 'vahi.dev' });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(`org: Shaik Vahid (${ORG_ID})`);
    expect(preview).toContain(websiteLine);
    // The identity block leads, then the warning.
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('cron_get'));
    const r = await del.handler(args, ctx, target);
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path === cronPath)).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.structured).toEqual({ website: WEBSITE_ID, cleared: true });
  });

  it('acts on the website the target named, even if the domain now resolves elsewhere', async () => {
    const seen: string[] = [];
    const { ctx } = await makeContext(movingTargetRoutes(seen));
    const del = byName(tools, 'cron_delete');
    const args = del.input.parse({ website: 'vahi.dev' });
    const target = await del.target!(args, ctx);
    expect(target.id).toBe(WEBSITE_ID);
    // The panel changed under us: a different website now answers for vahi.dev.
    ctx.resolver.invalidate();
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(WEBSITE_ID);
    expect(preview).not.toContain(OTHER_WEBSITE_ID);
    await del.handler(args, ctx, target);
    expect(seen).toEqual([cronPath]);
  });
});

describe('container_cron_get', () => {
  it('shows the runner state', async () => {
    for (const [enabled, shown] of [[true, 'container cron: on'], [false, 'container cron: off']] as const) {
      const { ctx } = await makeContext([...base(), { method: 'GET', path: containerPath, body: enabled }]);
      const r = await callTool(byName(tools, 'container_cron_get'), { website: 'vahi.dev' }, ctx);
      expect(r.isError).toBeUndefined();
      expect(r.text).toContain(websiteLine);
      expect(r.text).toContain(shown);
      expect(r.structured).toEqual({ enabled });
    }
  });
});

describe('container_cron_set', () => {
  it('PUTs the bare boolean', async () => {
    for (const enabled of [true, false]) {
      const sink: { method?: string; path?: string; body?: unknown } = {};
      const { ctx } = await makeContext([
        ...base(),
        {
          method: 'PUT',
          path: containerPath,
          handler: async (req, url) => {
            sink.method = req.method;
            sink.path = url.pathname.replace(/^\/api/, '');
            sink.body = await req.json();
            return new Response(null, { status: 204 });
          },
        },
      ]);
      const r = await callTool(byName(tools, 'container_cron_set'), { website: 'vahi.dev', enabled }, ctx);
      expect(sink.method).toBe('PUT');
      expect(sink.path).toBe(containerPath);
      expect(sink.body).toBe(enabled);
      expect(r.text).toContain(websiteLine);
      expect(r.text).toContain(enabled ? 'turned on' : 'turned off');
      expect(r.structured).toEqual({ enabled });
    }
  });
});

describe('tools', () => {
  it('exports the six cron tools in order, with only cron_delete destructive', async () => {
    expect(tools.map((t) => t.name)).toEqual(['cron_get', 'cron_add', 'cron_remove', 'cron_delete', 'container_cron_get', 'container_cron_set']);
    expect(tools.filter((t) => t.risk === 'destructive').map((t) => t.name)).toEqual(['cron_delete']);
    expect(tools.every((t) => t.tier === 'customer')).toBe(true);
  });
});
