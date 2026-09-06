import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { defineTool, type Target, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import { siteOf, siteWebsite, siteWebsiteById, websiteArg, type DbSite } from './dbcommon.js';

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

/**
 * A light shape check, not a cron parser: five whitespace-separated schedule fields (or one of
 * the `@` keywords the panel's cron accepts) followed by a command. The panel is the authority on
 * whether each field is a valid range or step — it answers 400 `invalid_syntax` when it is not —
 * but a line with no command at all, or one carrying an embedded newline that would smuggle a
 * second entry into the crontab, is caught here before anything is sent. Tabs and spaces only:
 * `\s` would let a newline through as a field separator.
 */
const CRON_LINE_RE = /^(?:@(?:reboot|hourly|daily|weekly|monthly|yearly)|\S+(?:[ \t]+\S+){4})[ \t]+\S(?:.*\S)?$/;

const jobArg = z
  .string()
  .trim()
  .min(1, 'a cron job line must not be empty')
  .regex(CRON_LINE_RE, "a cron job must be a full crontab line: five schedule fields, or @reboot/@hourly/@daily/@weekly/@monthly/@yearly, then the command — e.g. '*/5 * * * * php /var/www/<website_id>/artisan schedule:run'");

export const cronGet = defineTool({
  name: 'cron_get',
  tier: 'customer',
  risk: 'read',
  description: "Lists the website's crontab: the scheduled command lines and any environment variables in it. Line numbers are the panel's own and start at 0; cron_remove takes them. Jobs only fire while the container cron runner is on (container_cron_get).",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await cronSite(ctx, website);
    const res = await ctx.client.call('GET', CRON_PATH, () => ctx.client.api.GET(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } } }));
    // `items` is a union of the variable and command shapes, so each row is picked with an `in`
    // check rather than a cast: an item carrying neither key lands in no table at all.
    const items = res.items ?? [];
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
  description: "Appends cron jobs to the website's crontab. Each job is a full crontab line ('<schedule> <command>', e.g. '*/5 * * * * php /var/www/<website_id>/artisan schedule:run'). Existing lines are never touched: the current crontab is read first and each job is appended after the last line. Environment variables cannot be set here, and the panel rejects MAILTO outright (it is blacklisted). Jobs only fire while the container cron runner is on (container_cron_get).",
  input: z.object({ website: websiteArg, jobs: z.array(jobArg).min(1, 'name at least one cron job to add') }),
  async handler({ website, jobs }, ctx) {
    const s = await cronSite(ctx, website);
    // Read first: the panel merges by line number, so an in-range number would *replace* that
    // line. Only a number at or beyond the current count appends, and the current count is the
    // first free line. Verified live 2026-09-06.
    const current = await ctx.client.call('GET', CRON_PATH, () => ctx.client.api.GET(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } } }));
    const start = (current.items ?? []).length;
    const added = jobs.map((expr, i) => ({ line: start + i, expr }));
    // One request per job, in order. Whether a single PATCH carrying several append-range line
    // numbers keeps them apart was never verified live, and getting it wrong would collapse two
    // jobs onto one line.
    for (const { line, expr } of added) {
      await ctx.client.call('PATCH', CRON_PATH, () =>
        ctx.client.api.PATCH(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } }, body: { items: [{ cronCmd: { lineNumber: line, expr } }] } }),
      );
    }
    return ok(
      `${s.identity}\nadded ${added.length} cron line(s) at line(s) ${added.map((a) => a.line).join(', ')} (0-based, appended after the ${start} line(s) already there). Nothing fires until the container cron runner is on: check container_cron_get.`,
      { added },
    );
  },
});

export const cronRemove = defineTool({
  name: 'cron_remove',
  tier: 'customer',
  risk: 'write',
  description: "Removes lines from the website's crontab by line number (0-based, as cron_get shows them). The panel renumbers the remaining lines after every removal, so this sends one request per line, highest line first, and you should re-read cron_get before removing more.",
  input: z.object({ website: websiteArg, line_numbers: z.array(z.number().int().min(0, 'line numbers start at 0')).min(1, 'name at least one line number to remove') }),
  async handler({ website, line_numbers: lineNumbers }, ctx) {
    const s = await cronSite(ctx, website);
    // Highest first, one request per line: the panel renumbers what is left after each removal,
    // so a lower line number sent first would shift every later target down by one.
    const removed = [...new Set(lineNumbers)].sort((a, b) => b - a);
    for (const lineNumber of removed) {
      await ctx.client.call('PATCH', CRON_PATH, () =>
        ctx.client.api.PATCH(CRON_PATH, { params: { path: { org_id: s.org, website_id: s.id } }, body: { items: [{ cronCmd: { lineNumber } }] } }),
      );
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
  description: 'Shows whether the container cron runner is on. When it is off the crontab still exists and cron_get still lists it, but nothing fires.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await cronSite(ctx, website);
    const on = await ctx.client.call('GET', CONTAINER_PATH, () => ctx.client.api.GET(CONTAINER_PATH, { params: { path: { website_id: s.id } } }));
    return ok(`${s.identity}\n${kv([['container cron', on ? 'on' : 'off']])}`, { enabled: on === true });
  },
});

export const containerCronSet = defineTool({
  name: 'container_cron_set',
  tier: 'customer',
  risk: 'write',
  description: 'Turns the container cron runner on or off. It has to be on for any scheduled job (a Laravel schedule:run, a WordPress cron replacement) to fire.',
  input: z.object({ website: websiteArg, enabled: z.boolean() }),
  async handler({ website, enabled }, ctx) {
    const s = await cronSite(ctx, website);
    // The body is a bare JSON boolean, not an object — that is what the spec declares and what
    // the panel accepts.
    await ctx.client.call('PUT', CONTAINER_PATH, () => ctx.client.api.PUT(CONTAINER_PATH, { params: { path: { website_id: s.id } }, body: enabled }));
    return ok(`${s.identity}\ncontainer cron turned ${enabled ? 'on' : 'off'}.`, { enabled });
  },
});

export const tools: ToolDef[] = [cronGet, cronAdd, cronRemove, cronDelete, containerCronGet, containerCronSet];
