import * as z from 'zod/v4';
import type { components } from '../client/generated/types.js';
import type { ToolContext } from '../core/context.js';
import { defineTool, type Target, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import { partialFailure, siteOf, siteWebsite, siteWebsiteById, websiteArg, type DbSite } from './dbcommon.js';

async function cronSite(ctx: ToolContext, website: string): Promise<DbSite> {
  const { org, w } = await siteWebsite(ctx, website);
  return siteOf(ctx, org, w);
}

/** Convention 12: the destructive tool's `preview()`/`handler()` re-read the website the
 *  `target()` already pinned, by id, so the preview and the confirmed clear cannot drift onto a
 *  different site if the domain starts answering for another website in between. */
async function cronTargetSite(ctx: ToolContext, target: Target): Promise<DbSite> {
  const { org, w } = await siteWebsiteById(ctx, target.id);
  return siteOf(ctx, org, w);
}

const CRON_PATH = '/orgs/{org_id}/websites/{website_id}/crontab';
const CONTAINER_PATH = '/websites/{website_id}/container_cron_enabled';

/** One crontab row: either a command line or a variable assignment. */
type CronItem = components['schemas']['CrontabValue'];

/** The line the row occupies, whichever half of the union it is. */
function lineOf(item: CronItem): number {
  return 'cronCmd' in item ? item.cronCmd.lineNumber : item.variable.lineNumber;
}

/** Line number to union member, for every row the listing carries. */
function crontabKinds(items: CronItem[]): Map<number, 'cronCmd' | 'variable'> {
  return new Map(items.map((i) => [lineOf(i), 'cronCmd' in i ? 'cronCmd' : 'variable'] as const));
}

/**
 * Reads the editable part of the crontab. The spec declares this GET as 204 (it answers 200 with a
 * body live), and `client.call` returns `undefined` for a real 204, so the listing is treated as
 * optional even though the generated type is not.
 */
async function readCrontab(ctx: ToolContext, s: DbSite): Promise<CronItem[]> {
  const res = await ctx.client.call('GET', CRON_PATH, () => ctx.client.api.GET(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } } }));
  return res?.items ?? [];
}

/**
 * A light shape check, not a cron parser: five whitespace-separated schedule fields (or one of
 * the `@` keywords the panel's cron accepts) followed by a command. The panel is the authority on
 * whether each field is a valid range or step — it answers 400 `invalid_syntax` when it is not —
 * but a line with no command at all, or one carrying an embedded newline that would smuggle a
 * second entry into the crontab, is caught here before anything is sent. Tabs and spaces only:
 * `\s` would let a newline through as a field separator.
 */
const CRON_LINE_RE = /^(?:@(?:reboot|hourly|daily|midnight|weekly|monthly|yearly|annually)|\S+(?:[ \t]+\S+){4})[ \t]+\S(?:.*\S)?$/;

const jobArg = z
  .string()
  .trim()
  .min(1, 'a cron job line must not be empty')
  .regex(CRON_LINE_RE, "a cron job must be a full crontab line: five schedule fields, or @reboot/@hourly/@daily/@midnight/@weekly/@monthly/@yearly/@annually, then the command — e.g. '* * * * * php /var/www/<website_id>/app/artisan schedule:run'")
  // Verified live 2026-09-06: `* * * * * date +%s >> log` ran and wrote nothing, because cron
  // ends the command at the first unescaped %.
  .refine(
    (v) => !/(?<!\\)%/.test(v),
    "crontab treats an unescaped % as a newline: it ends the command there and feeds the rest to the command's stdin, so a line like 'date +%s >> out.log' runs but writes nothing. Escape each one as \\% (e.g. 'date +\\%s')",
  );

export const cronGet = defineTool({
  name: 'cron_get',
  tier: 'customer',
  risk: 'read',
  description: "Lists the website's crontab: the scheduled command lines and any environment variables in it. Only the editable part of the file is returned, so the numbering can have gaps. Line numbers are the panel's own and start at 0; cron_remove takes them.",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await cronSite(ctx, website);
    // `items` is a union of the variable and command shapes, so each row is picked with an `in`
    // check rather than a cast: an item carrying neither key lands in no table at all.
    const items = await readCrontab(ctx, s);
    const cmds = items.flatMap((i) => ('cronCmd' in i ? [{ line: i.cronCmd.lineNumber, schedule_and_command: i.cronCmd.expr }] : []));
    const vars = items.flatMap((i) => ('variable' in i ? [{ line: i.variable.lineNumber, key: i.variable.key, value: i.variable.val }] : []));
    const out = [s.identity, 'Lines are numbered from 0, as the panel numbers them.', `cron commands (${cmds.length}):`, table(cmds, ['line', 'schedule_and_command'])];
    if (vars.length) out.push(`variables (${vars.length}):`, table(vars, ['line', 'key', 'value']));
    return ok(out.join('\n'), { commands: cmds.length, variables: vars.length, items });
  },
});

export const cronAdd = defineTool({
  name: 'cron_add',
  tier: 'customer',
  risk: 'write',
  description: "Appends cron jobs to the website's crontab. Each job is a full crontab line ('<schedule> <command>', e.g. '* * * * * php /var/www/<website_id>/app/artisan schedule:run'), and a % in a command must be escaped as \\% or cron ends the command there. Existing lines are never touched: the current crontab is read first and each job is appended past the highest line number in it. That read-then-append is not atomic — a job added from the panel in between would not be seen — so re-read cron_get afterwards if someone else may be editing. Environment variables cannot be set here, and the panel rejects MAILTO outright (it is blacklisted).",
  input: z.object({ website: websiteArg, jobs: z.array(jobArg).min(1, 'name at least one cron job to add') }),
  async handler({ website, jobs }, ctx) {
    const s = await cronSite(ctx, website);
    // Read first: the panel merges by line number, so an in-range number would *replace* that
    // line and only a number past the last one appends (verified live 2026-09-06). The count of
    // items is not that number: only the editable part of the file comes back, so the numbering
    // can be sparse and `items.length` could land inside the file.
    const items = await readCrontab(ctx, s);
    const start = items.length ? Math.max(...items.map(lineOf)) + 1 : 0;
    const added = jobs.map((expr, i) => ({ line: start + i, expr }));
    // One request per job, in order. Whether a single PATCH carrying several append-range line
    // numbers keeps them apart was never verified live, and getting it wrong would collapse two
    // jobs onto one line.
    for (const [i, { line, expr }] of added.entries()) {
      try {
        await ctx.client.call('PATCH', CRON_PATH, () =>
          ctx.client.api.PATCH(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } }, body: { items: [{ cronCmd: { lineNumber: line, expr } }] } }),
        );
      } catch (e) {
        throw partialFailure('added', i, added.length, line, e);
      }
    }
    return ok(
      `${s.identity}\nadded ${added.length} cron line(s) at line(s) ${added.map((a) => a.line).join(', ')} (0-based), appended past the highest line the crontab already had. Re-read cron_get to see the file as the panel numbers it now.`,
      { added },
    );
  },
});

export const cronRemove = defineTool({
  name: 'cron_remove',
  tier: 'customer',
  risk: 'write',
  description: "Removes lines from the website's crontab by line number (0-based, as cron_get shows them). Command lines and variable lines can both be removed. The crontab is read first and any line number it does not list is refused without sending anything, because the panel treats an out-of-range number in this request as an append, not as a no-op. The panel renumbers the remaining lines after every removal, so this sends one request per line, highest line first, and you should re-read cron_get before removing more.",
  input: z.object({ website: websiteArg, line_numbers: z.array(z.number().int().min(0, 'line numbers start at 0')).min(1, 'name at least one line number to remove') }),
  async handler({ website, line_numbers: lineNumbers }, ctx) {
    const s = await cronSite(ctx, website);
    // Bounds-check against the real file first: a line number the crontab does not have is an
    // *append* on this endpoint (verified live 2026-09-06), so a typo would add a line instead of
    // removing one. The listing also says which union member each line is, and a removal has to
    // be sent under the same one.
    const kinds = crontabKinds(await readCrontab(ctx, s));
    // Highest first, one request per line: the panel renumbers what is left after each removal,
    // so a lower line number sent first would shift every later target down by one.
    const removed = [...new Set(lineNumbers)].sort((a, b) => b - a);
    const unknown = removed.filter((l) => !kinds.has(l)).sort((a, b) => a - b);
    if (unknown.length) {
      const available = [...kinds.keys()].sort((a, b) => a - b);
      return fail(
        `${s.identity}\nno such cron line(s): ${unknown.join(', ')}. The crontab has line(s) ${available.length ? available.join(', ') : 'none — it is empty'}. Nothing was removed: on this endpoint an unknown line number appends a line instead of deleting one. Re-read cron_get and retry with the numbers it lists.`,
        { removed: [], unknown, available },
      );
    }
    for (const [i, lineNumber] of removed.entries()) {
      const item = kinds.get(lineNumber) === 'variable' ? { variable: { lineNumber } } : { cronCmd: { lineNumber } };
      try {
        await ctx.client.call('PATCH', CRON_PATH, () => ctx.client.api.PATCH(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } }, body: { items: [item] } }));
      } catch (e) {
        throw partialFailure('removed', i, removed.length, lineNumber, e);
      }
    }
    return ok(`${s.identity}\nremoved cron line(s) ${removed.join(', ')} (0-based, highest first, one request each). The remaining lines are renumbered from 0, so re-read cron_get before removing more.`, { removed });
  },
});

export const cronDelete = defineTool({
  name: 'cron_delete',
  tier: 'customer',
  risk: 'destructive',
  description: "DESTRUCTIVE. Removes the website's entire crontab — every scheduled job and every variable in it — by deleting the file. Requires the user to confirm by typing the website domain. To drop single jobs instead, use cron_remove.",
  input: z.object({ website: websiteArg }),
  async target({ website }, ctx) {
    const { w } = await siteWebsite(ctx, website);
    return { kind: 'crontab', id: w.id, name: w.domain.domain };
  },
  async preview(_args, ctx, target) {
    const site = await cronTargetSite(ctx, target);
    // The identity block leads so the human confirming sees which site loses its schedule.
    return `${site.identity}\nThis will delete the whole crontab for ${safe(target.name)}. Every scheduled job stops and the file is removed from disk; the panel cannot restore it. Read cron_get first if you want a copy of the lines.`;
  },
  async handler(_args, ctx, target) {
    const site = await cronTargetSite(ctx, target!);
    await ctx.client.call('DELETE', CRON_PATH, () => ctx.client.api.DELETE(CRON_PATH, { params: { path: { org_id: site.org, website_id: site.id } } }));
    return ok(`${site.identity}\ncrontab cleared for ${safe(target!.name)}.`, { website: target!.id, cleared: true });
  },
});

export const containerCronGet = defineTool({
  name: 'container_cron_get',
  tier: 'customer',
  risk: 'read',
  description: "Shows whether the website container may read and edit its own crontab from inside (`crontab -l` / `crontab -e` over SSH). This flag does not gate execution: panel-managed cron jobs (cron_get, cron_add) run either way — verified live 2026-09-06. With it off, `crontab -l` in the container answers that the command is unavailable.",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await cronSite(ctx, website);
    // A 204 with no body reads as undefined here, which is not "on": only an explicit true is.
    const on = await ctx.client.call('GET', CONTAINER_PATH, () => ctx.client.api.GET(CONTAINER_PATH, { params: { path: { website_id: s.id } } }));
    const enabled = on === true;
    const meaning = enabled
      ? 'The container can run `crontab -l` / `crontab -e` on its own crontab from inside (over SSH).'
      : 'The container cannot run `crontab -l` / `crontab -e` from inside; it is told the command is unavailable.';
    return ok(`${s.identity}\n${kv([['container cron', enabled ? 'on' : 'off']])}\n${meaning} Scheduled jobs run either way: this flag does not start or stop them.`, { enabled });
  },
});

export const containerCronSet = defineTool({
  name: 'container_cron_set',
  tier: 'customer',
  risk: 'write',
  description: "Turns on or off the container's own access to its crontab: with it on, `crontab -l` and `crontab -e` work from inside the container (over SSH), which a deploy script that installs its own jobs needs. It does not start or stop anything — panel-managed cron jobs run either way — so use cron_add and cron_remove to change what is scheduled.",
  input: z.object({ website: websiteArg, enabled: z.boolean() }),
  async handler({ website, enabled }, ctx) {
    const s = await cronSite(ctx, website);
    // The body is a bare JSON boolean, not an object — that is what the spec declares and what
    // the panel accepts.
    await ctx.client.call('PUT', CONTAINER_PATH, () => ctx.client.api.PUT(CONTAINER_PATH, { params: { path: { website_id: s.id } }, body: enabled }));
    const meaning = enabled
      ? 'The container can now run `crontab -l` / `crontab -e` on its own crontab from inside.'
      : 'The container can no longer run `crontab -l` / `crontab -e` from inside.';
    return ok(`${s.identity}\ncontainer cron turned ${enabled ? 'on' : 'off'}. ${meaning} Already-scheduled jobs are unaffected: they run either way.`, { enabled });
  },
});

export const tools: ToolDef[] = [cronGet, cronAdd, cronRemove, cronDelete, containerCronGet, containerCronSet];
