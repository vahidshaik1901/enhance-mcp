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

/** Only the editable part of the crontab comes back, so the numbering can be sparse: here the
 *  file's next free line is 6, while `items.length` is 2 — a number that would REPLACE line 2. */
const gappedLines = {
  items: [
    { cronCmd: { lineNumber: 0, expr: JOB_A } },
    { cronCmd: { lineNumber: 5, expr: JOB_B } },
  ],
};

/** Three lines with no gaps: a command, a variable, a command. */
const threeLines = {
  items: [
    { cronCmd: { lineNumber: 0, expr: JOB_A } },
    { variable: { lineNumber: 1, key: 'PATH', val: '/usr/local/bin:/usr/bin' } },
    { cronCmd: { lineNumber: 2, expr: JOB_B } },
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

/** Like `crontabTrace`, but the `failOn`th PATCH (1-based) answers 400, so a failure that lands
 *  after some lines have already been written can be asserted on. 400 is not retryable, so the
 *  sequence stops exactly there. */
function crontabTraceFailingAt(seen: Array<{ method: string; body?: unknown }>, failOn: number, listing: unknown = twoLines): Route[] {
  let patches = 0;
  return [
    { method: 'GET', path: cronPath, handler: async () => { seen.push({ method: 'GET' }); return json(listing); } },
    {
      method: 'PATCH',
      path: cronPath,
      handler: async (req) => {
        patches += 1;
        seen.push({ method: 'PATCH', body: await req.json() });
        if (patches !== failOn) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ code: 'invalid_syntax', message: 'panel refused the line' }), { status: 400, headers: { 'content-type': 'application/json' } });
      },
    },
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

  // The spec declares this GET as 204, and the client returns undefined for a real 204 body.
  it('renders a 204 (no body) listing as an empty crontab', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: cronPath, status: 204 }]);
    const r = await callTool(byName(tools, 'cron_get'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('cron commands (0)');
    expect(r.structured).toEqual({ commands: 0, variables: 0, items: [] });
  });

  it('does not claim jobs need the container cron flag to fire', async () => {
    expect(byName(tools, 'cron_get').description).not.toContain('container_cron_get');
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
    // The container cron flag does not gate execution, so the result must not send the human off
    // to turn it on before the job will fire (verified live 2026-09-06).
    expect(r.text).not.toContain('container_cron_get');
    expect(r.structured).toEqual({ added: [{ line: 2, expr: JOB_B }, { line: 3, expr: '@daily /usr/bin/backup.sh' }] });
  });

  it('appends after the highest line number, not after items.length, when the numbering has gaps', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen, gappedLines)]);
    const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: ['@daily /usr/bin/backup.sh'] }, ctx);
    // items.length is 2 here, and line 2 is inside the file: sending it would replace a job.
    expect(seen).toEqual([{ method: 'GET' }, { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 6, expr: '@daily /usr/bin/backup.sh' } }] } }]);
    expect(r.structured).toEqual({ added: [{ line: 6, expr: '@daily /usr/bin/backup.sh' }] });
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

  it('accepts every @ keyword cron itself accepts, @annually and @midnight included', async () => {
    for (const job of ['@annually /usr/bin/backup.sh', '@midnight /usr/bin/backup.sh', '@reboot /usr/bin/warm.sh']) {
      const seen: Array<{ method: string; body?: unknown }> = [];
      const { ctx } = await makeContext([...base(), ...crontabTrace(seen, { items: [] })]);
      const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [job] }, ctx);
      expect(r.isError).toBeUndefined();
      expect(seen).toEqual([{ method: 'GET' }, { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 0, expr: job } }] } }]);
    }
  });

  it('rejects an unescaped % and says to write \\% instead', async () => {
    const { ctx, f } = await makeContext([...base(), ...crontabTrace([])]);
    // crontab ends the command at a bare %, so `date +%s >> log` silently never wrote the file
    // (verified live 2026-09-06).
    await expect(callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: ['* * * * * /bin/date +%s >> /tmp/x.log'] }, ctx)).rejects.toThrow(/\\%/);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
    // An escaped % is the documented way to write one, so it must pass.
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx: ctx2 } = await makeContext([...base(), ...crontabTrace(seen, { items: [] })]);
    const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: ['* * * * * /bin/date +\\%s >> /tmp/x.log'] }, ctx2);
    expect(r.isError).toBeUndefined();
    expect(seen).toHaveLength(2);
  });

  it('reports how many lines were already added when a later PATCH fails', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTraceFailingAt(seen, 2)]);
    await expect(callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [JOB_B, '@daily /usr/bin/backup.sh'] }, ctx)).rejects.toThrow(/added 1 of 2 lines before line 3 failed/);
    // It stops at the failure rather than carrying on with the rest.
    expect(seen.filter((s) => s.method === 'PATCH')).toHaveLength(2);
  });

  it('says in its description that variables (and MAILTO in particular) are not settable here, and that the read-then-append is not atomic', async () => {
    const d = byName(tools, 'cron_add').description;
    expect(d).toContain('MAILTO');
    expect(d).toMatch(/not atomic/i);
    expect(d).not.toContain('container_cron_get');
  });
});

describe('cron_add settles an unclear answer (write-then-verify)', () => {
  /** The crontab read answers `twoLines` until the first PATCH, then `after`; each PATCH throws. */
  function unclearPatches(after: unknown, seen: Array<{ method: string }>): Route[] {
    let patched = false;
    return [
      { method: 'GET', path: cronPath, handler: async () => { seen.push({ method: 'GET' }); return json(patched ? after : twoLines); } },
      { method: 'PATCH', path: cronPath, handler: async () => { seen.push({ method: 'PATCH' }); patched = true; throw new TypeError('fetch failed'); } },
    ];
  }
  const withLine2 = { items: [...twoLines.items, { cronCmd: { lineNumber: 2, expr: JOB_B } }] };

  it('confirms a line whose PATCH answer never came, by finding it on its line number', async () => {
    const seen: Array<{ method: string }> = [];
    const { ctx } = await makeContext([...base(), ...unclearPatches(withLine2, seen)]);
    const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [JOB_B] }, ctx);
    expect(r.isError, r.text).toBeUndefined();
    expect(r.text).toContain('confirmed by reading it back');
    expect(r.structured).toEqual({ added: [{ line: 2, expr: JOB_B }], confirmedByRead: [2] });
    expect(seen.filter((s) => s.method === 'PATCH')).toHaveLength(1);
  });

  it('stops at a line whose outcome is unknown and says which lines were not sent', async () => {
    const seen: Array<{ method: string }> = [];
    const { ctx } = await makeContext([...base(), ...unclearPatches(twoLines, seen)]);
    const r = await callTool(byName(tools, 'cron_add'), { website: 'vahi.dev', jobs: [JOB_B, '@daily /usr/bin/backup.sh'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('cron_get website=vahi.dev');
    expect(r.text).toContain('1 line(s) after it were not sent');
    expect(r.structured).toMatchObject({ outcome: 'unknown', added: [], unknown: { line: 2, expr: JOB_B }, notSent: [{ line: 3, expr: '@daily /usr/bin/backup.sh' }] });
    expect(seen.filter((s) => s.method === 'PATCH')).toHaveLength(1);
  });
});

describe('cron_remove', () => {
  it('removes the highest line first, one request per line, so renumbering cannot shift a target', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen, threeLines)]);
    const r = await callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [0, 2] }, ctx);
    expect(seen).toEqual([
      { method: 'GET' },
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
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen, gappedLines)]);
    const r = await callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [0, 5, 0] }, ctx);
    expect(seen).toEqual([
      { method: 'GET' },
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 5 } }] } },
      { method: 'PATCH', body: { items: [{ cronCmd: { lineNumber: 0 } }] } },
    ]);
    expect(r.structured).toEqual({ removed: [5, 0] });
  });

  it('removes a variable line with the variable shape the listing showed for it', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen)]);
    const r = await callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [1] }, ctx);
    expect(seen).toEqual([{ method: 'GET' }, { method: 'PATCH', body: { items: [{ variable: { lineNumber: 1 } }] } }]);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toEqual({ removed: [1] });
  });

  it('refuses a line number the crontab does not have, and sends no PATCH', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTrace(seen)]);
    // An out-of-range line number is an append on this endpoint, not a no-op, so a typo would
    // add a line instead of removing one.
    const r = await callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [1, 7] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no such cron line(s): 7');
    expect(r.text).toContain('has line(s) 0, 1');
    // The identity block still leads, so the human sees which site was left alone.
    expect(r.text.indexOf(websiteLine)).toBeLessThan(r.text.indexOf('no such cron line'));
    expect(r.structured).toEqual({ removed: [], unknown: [7], available: [0, 1] });
    expect(seen).toEqual([{ method: 'GET' }]);
  });

  it('reports how many lines were already removed when a later PATCH fails', async () => {
    const seen: Array<{ method: string; body?: unknown }> = [];
    const { ctx } = await makeContext([...base(), ...crontabTraceFailingAt(seen, 2, threeLines)]);
    await expect(callTool(byName(tools, 'cron_remove'), { website: 'vahi.dev', line_numbers: [0, 2] }, ctx)).rejects.toThrow(/removed 1 of 2 lines before line 0 failed/);
    expect(seen.filter((s) => s.method === 'PATCH')).toHaveLength(2);
  });

  it('says in its description that variables can be removed too', async () => {
    expect(byName(tools, 'cron_remove').description).toMatch(/variable/i);
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

  // The spec declares 204 for some of these container settings; an empty body must not read as on.
  it('reports a 204 (no body) as off, cleanly', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: containerPath, status: 204 }]);
    const r = await callTool(byName(tools, 'container_cron_get'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('container cron: off');
    expect(r.structured).toEqual({ enabled: false });
  });

  it('describes the flag as crontab access from inside the container, not a job switch', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: containerPath, body: false }]);
    const r = await callTool(byName(tools, 'container_cron_get'), { website: 'vahi.dev' }, ctx);
    // Verified live 2026-09-06: with the flag off, a panel-managed job still fired on schedule,
    // while `crontab -l` inside the container answered "Command unavailable".
    expect(r.text).toMatch(/crontab -l/);
    expect(r.text).toMatch(/run either way|regardless/i);
    const d = byName(tools, 'container_cron_get').description;
    expect(d).toMatch(/crontab -l/);
    expect(d).not.toMatch(/nothing fires/i);
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

  it('says what the flag actually does: crontab access inside the container, not job execution', async () => {
    const d = byName(tools, 'container_cron_set').description;
    expect(d).toMatch(/crontab -l/);
    expect(d).toMatch(/run either way|regardless/i);
    expect(d).not.toMatch(/has to be on/i);
  });
});

describe('tools', () => {
  it('exports the six cron tools in order, with only cron_delete destructive', async () => {
    expect(tools.map((t) => t.name)).toEqual(['cron_get', 'cron_add', 'cron_remove', 'cron_delete', 'container_cron_get', 'container_cron_set']);
    expect(tools.filter((t) => t.risk === 'destructive').map((t) => t.name)).toEqual(['cron_delete']);
    expect(tools.every((t) => t.tier === 'customer')).toBe(true);
  });
});
