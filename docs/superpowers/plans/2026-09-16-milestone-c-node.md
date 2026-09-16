# Milestone C: Node.js and persistent apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer install Node in a website container, register a Node app as a panel-managed persistent app behind the reverse proxy, read its log, verify it on the domain, and delete it through the typed-name gate — eleven new tools plus a Node path in the `enhance-deploy` skill, live-verified on vahi.dev.

**Architecture:** Two new tool groups follow the milestone A/B `defineTool` contract exactly: `tools/node.ts` (five thin tools on `/websites/{id}/apps/node…`) and `tools/apps.ts` (six tools on `/websites/{id}/apps/persistent…` plus one in-process HTTPS probe). Both gate on `canUse.persistentApps` the way the PostgreSQL tools gate on `canUse.postgresql`. `persistent_app_delete` is the milestone's one destructive tool. A small `core/probe.ts` does the `curl --resolve` equivalent so a deploy can be verified before DNS exists. The spec is re-vendored first (12.25.8 → 12.25.11), and the open behaviours are probed live before the tools that depend on them are written.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` 2.0.0, `openapi-fetch` over the vendored spec types, zod 4 (`zod/v4`), vitest 4, `node:https` for the probe. No new dependencies.

Spec: `docs/superpowers/specs/2026-09-16-milestone-c-node-design.md`. Live facts: `docs/research.md`, "Node and persistent apps (milestone C, probed now)".

## Global Constraints

- Language TypeScript, Node >= 20, ESM. Official `@modelcontextprotocol/*` 2.0.0 SDK. zod imported from `zod/v4`. No new runtime dependencies.
- Every tool is created with `defineTool` from `src/core/registry.ts` and added to a group array re-exported through `src/tools/index.ts`.
- Every tool response begins with the identity block (`siteOf(ctx, org, w).identity`, convention 3). Any interpolated panel string passes through `safe()` (convention 8).
- Non-destructive tool tests call `callTool(byName(tools, name), args, ctx)`; destructive-tool tests drive `target()`, then `preview()`, then `handler(args, ctx, target)` directly.
- Destructive tools define `target()` and `preview()`; `preview()`/`handler()` act on the handed target, re-reading the website by id (convention 12). Milestone C's destructive set is exactly `persistent_app_delete`; its typed confirmation is the **website's primary domain name**.
- Every tool in `node.ts` and `apps.ts` refuses without sending anything when `canUse.persistentApps` is not `true` (the "not enabled" wording, never "is false").
- `working_directory` is relative to the site home (`/var/www/<website_id>`); absolute paths and `..` segments are rejected by the tool (verified live: the panel silently stores an absolute path as `null`). `proxy_path` never starts with `/` (a leading slash is a panel 400); the tool strips exactly one leading slash and says so.
- Persistent apps answer on the **primary domain only**, never on the `*.mystaging.site` preview alias (verified live). Every response that names a URL says this.
- `node_versions_installed` output is labelled "as reported by the panel" and never used to claim a version is absent (verified live: the endpoint lags `nvm ls`).
- Logs returned to the transcript are capped at 64 KB with `tailLog` from `src/tools/php.ts`.
- Tests: unit (fake panel), MCP in-memory, and opt-in live e2e. `npm run typecheck`, `npm test`, `npm run build` all clean before each commit. `claude plugin validate .` clean after any change under `.claude-plugin/` or `skills/`.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## File Structure

- `server/spec/oas3-api.yaml`, `server/spec/VERSION`, `server/src/client/generated/types.ts` (modify, Task 0) — the vendored 12.25.11 spec and its generated types. `docs/enhance-api/oas3-api.yaml` gets the same copy.
- `docs/research.md` (modify, Tasks 0, 1, 8) — spec diff summary, the Task 1 live findings, "Live test C".
- `server/src/core/registry.ts` (modify, Task 4) — `Target.kind` gains `'persistent_app'`.
- `server/src/core/context.ts` (modify, Task 4) — optional `httpProbe` seam on `ToolContext`.
- `server/src/core/probe.ts` (create, Task 4) — `httpsProbe` (SNI + Host to an IP) and the pure `classifyCertificate`.
- `server/src/tools/node.ts` (create, Task 2) — the persistent-apps gate helper and the five Node runtime tools.
- `server/src/tools/apps.ts` (create, Tasks 3–4) — persistent app list/create/update/log, then delete and probe.
- `server/src/tools/index.ts` (modify, Task 5) — register both groups.
- `server/test/fixtures/panel.ts` (modify, Task 3) — `APP_ID`, `persistentApps` fixture.
- `server/test/unit/tools-node.test.ts` (create, Task 2), `server/test/unit/tools-apps.test.ts` (create, Tasks 3–4), `server/test/unit/probe.test.ts` (create, Task 4).
- `server/test/unit/smoke.test.ts`, `server/test/mcp/server.test.ts`, `server/test/unit/spec.test.ts` (modify, Tasks 0 and 5).
- `server/test/e2e/milestone-c.e2e.test.ts` (create, Task 7).
- `skills/enhance-deploy/SKILL.md` (modify, Task 6).
- `README.md`, `CLAUDE.md` (modify, Task 8).

---

### Task 0: Re-vendor the API spec (12.25.8 → 12.25.11) and regenerate types

**Files:**
- Modify: `server/spec/oas3-api.yaml`, `server/spec/VERSION`, `server/src/client/generated/types.ts`, `docs/enhance-api/oas3-api.yaml`
- Modify (only if the `type: int` count changed): `server/scripts/patch-spec.ts:10`, `server/test/unit/spec.test.ts`
- Modify: `docs/research.md` (new section)

**Interfaces:**
- Consumes: nothing.
- Produces: generated `paths`/`components` for 12.25.11 that every later task imports through `openapi-fetch`.

- [ ] **Step 1: Confirm the drift and capture the old path list**

Run, from `server/`:
```bash
npm run check:spec; echo "exit=$?"
grep -E '^  /' spec/oas3-api.yaml | sort > /tmp/paths-old.txt; wc -l /tmp/paths-old.txt
```
Expected: `check-spec-drift: upstream spec (version 12.25.11) differs …`, `exit=1`, and a path count of 302.

- [ ] **Step 2: Fetch the upstream spec into both copies and record the version**

```bash
curl -sSL https://apidocs.enhance.com/spec/oas3-api.yaml -o spec/oas3-api.yaml
cp spec/oas3-api.yaml ../docs/enhance-api/oas3-api.yaml
grep -m1 -E '^\s+version:' spec/oas3-api.yaml | awk '{print $2}' | tr -d '"' > spec/VERSION
cat spec/VERSION
npm run check:spec; echo "exit=$?"
grep -E '^  /' spec/oas3-api.yaml | sort > /tmp/paths-new.txt
diff /tmp/paths-old.txt /tmp/paths-new.txt; echo "paths: $(wc -l < /tmp/paths-new.txt)"
```
Expected: `12.25.11`, `check-spec-drift: vendored spec matches upstream`, `exit=0`, and a `diff` listing any added or removed paths (possibly none).

- [ ] **Step 3: Regenerate the types**

```bash
npm run gen:types; echo "exit=$?"
```
Expected: `patch-spec: rewrote 2 'type: int' occurrence(s)` then the openapi-typescript success line, `exit=0`.

If it prints `patch-spec: expected exactly 2; the upstream spec changed` and exits 1: count the occurrences with `grep -cE '^\s+type: int$' spec/oas3-api.yaml`, set `EXPECTED_INT_OCCURRENCES` in `server/scripts/patch-spec.ts` to that number, and re-run. `test/unit/spec.test.ts` reads the constant, so it needs no edit.

- [ ] **Step 4: Typecheck and test against the new types**

```bash
npm run typecheck; npm test 2>&1 | tail -5
```
Expected: typecheck clean, `Tests 313 passed (313)`. If a generated type changed shape and a tool no longer compiles, fix the tool to the new shape (keep the fix minimal, name it in the commit body) and record the change in Step 5.

- [ ] **Step 5: Record the diff in the research notes**

Append to `docs/research.md`, after the "Task 10 walkthrough" section:

```markdown
## Spec re-vendored: 12.25.8 → 12.25.11 (2026-09-16)

- `server/spec/oas3-api.yaml` and `docs/enhance-api/oas3-api.yaml` now carry 12.25.11; the
  `spec-drift` CI job is green again.
- Paths added: <list from Step 2, or "none">. Paths removed: <list, or "none">.
- Schema changes that touched a tool: <name each, or "none; all 313 tests passed unchanged">.
- Milestone C endpoints (`/websites/{id}/apps/node…`, `/websites/{id}/apps/persistent…`) are
  unchanged apart from <differences, or "nothing">.
```
Fill every angle-bracket item from the Step 2 diff and the Step 4 outcome before committing.

- [ ] **Step 6: Commit**

```bash
git add spec/oas3-api.yaml spec/VERSION src/client/generated/types.ts ../docs/enhance-api/oas3-api.yaml ../docs/research.md scripts/patch-spec.ts
git commit -m "chore(spec): re-vendor Enhance API spec 12.25.11 and regenerate types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Live probe of the open behaviours (no code)

**Files:**
- Modify: `docs/research.md` (new subsection under "Node and persistent apps")

**Interfaces:**
- Consumes: a fresh panel credential in `../.env` (`ENHANCE_SESSION_COOKIE`, a session JWT sent as the `id0` cookie) and the SSH key `~/.ssh/enhance_vahi_dev_ed25519`.
- Produces: six recorded findings that Tasks 2, 3 and 6 quote verbatim in tool descriptions and the skill.

Everything here runs against vahi.dev (website id `6106382b-143f-4d24-9bea-0e9368ad2a1f`, unix user `vahi_dev1`, server IP `65.98.32.45`). Ask the user for a fresh cookie first if `auth_status`/`doctor` fails. Every command below is read-then-write on a throwaway app; nothing touches the static site or `demo-login/`.

- [ ] **Step 1: Set up the shell**

```bash
cd /Users/vahid/Documents/project_4_enhance_mcp && set -a && source .env && set +a
P="https://e4500.sgp1.stableserver.net/api"; W=6106382b-143f-4d24-9bea-0e9368ad2a1f
api() { curl -sS -b "id0=$ENHANCE_SESSION_COOKIE" -H 'content-type: application/json' "$@"; }
api "$P/login/memberships" | head -c 200; echo
```
Expected: JSON with `"orgName":"Shaik Vahid"`. Anything else means the cookie is dead: stop and ask for a fresh one.

- [ ] **Step 2: Question 1 — a second `installNvm`**

```bash
ssh -i ~/.ssh/enhance_vahi_dev_ed25519 vahi_dev1@65.98.32.45 'ls -d ~/.nvm 2>/dev/null && . ~/.nvm/nvm.sh && nvm ls --no-colors | head -12 || echo "no nvm"'
api -o /dev/null -w 'installNvm #1: HTTP %{http_code} %{time_total}s\n' -X POST "$P/websites/$W/apps/node"
api -o /dev/null -w 'installNvm #2: HTTP %{http_code} %{time_total}s\n' -X POST "$P/websites/$W/apps/node"
ssh -i ~/.ssh/enhance_vahi_dev_ed25519 vahi_dev1@65.98.32.45 '. ~/.nvm/nvm.sh && nvm ls --no-colors | head -12'
api "$P/websites/$W/apps/node/versions"; echo
```
Record: both status codes, whether the second call changed `nvm ls` (reinstalled, no-op) or errored, and whether the installed-versions endpoint still lags `nvm ls`.

- [ ] **Step 3: Questions 2 and 6 — create an app, then PATCH it, then toggle start mode**

```bash
api -i -X POST "$P/websites/$W/apps/persistent" -d '{"command":"node -e \"const s=require(\\\"http\\\").createServer((q,r)=>r.end(\\\"probe-\\\"+process.pid));s.listen(process.env.PORT||3077,()=>console.log(\\\"listening\\\",process.pid))\"","workingDirectory":"","startMode":"automatic","proxyDetails":{"path":"mcpprobe","port":3077},"nodeVersion":"stable"}' | sed -n '1p;/^{/p'
api "$P/websites/$W/apps/persistent" | python3 -c 'import json,sys; [print(a["id"], a.get("appKind"), a["command"][:40], a.get("nodeVersion"), a.get("proxyDetails")) for a in json.load(sys.stdin)]'
```
Record: whether the POST body carries the new app (an `id`) or is empty (then the id comes from the list), and whether `nodeVersion: "stable"` was accepted (question 6). Copy the app id into `A=<uuid>`. Then:

```bash
sleep 5; api "$P/websites/$W/apps/persistent/$A" | python3 -c 'import json,sys; print(json.load(sys.stdin)[-600:])'
curl -k -sS --resolve vahi.dev:443:65.98.32.45 https://vahi.dev/mcpprobe/; echo   # note the pid
api -o /dev/null -w 'PATCH no-op: HTTP %{http_code}\n' -X PATCH "$P/websites/$W/apps/persistent/$A" -d '{"startMode":"automatic"}'
sleep 5; curl -k -sS --resolve vahi.dev:443:65.98.32.45 https://vahi.dev/mcpprobe/; echo   # same pid = no restart
api -o /dev/null -w 'PATCH manual: HTTP %{http_code}\n' -X PATCH "$P/websites/$W/apps/persistent/$A" -d '{"startMode":"manual"}'
sleep 5; curl -k -sS -o /dev/null -w 'while manual: HTTP %{http_code}\n' --resolve vahi.dev:443:65.98.32.45 https://vahi.dev/mcpprobe/
api -o /dev/null -w 'PATCH automatic: HTTP %{http_code}\n' -X PATCH "$P/websites/$W/apps/persistent/$A" -d '{"startMode":"automatic"}'
sleep 8; curl -k -sS --resolve vahi.dev:443:65.98.32.45 https://vahi.dev/mcpprobe/; echo   # new pid = restarted
```
Record (question 2): whether a no-change PATCH restarts (pid changes), whether `manual` stops the process (502/503 while manual), and whether `automatic` starts a new one.

- [ ] **Step 4: Question 3 — port and path collisions**

```bash
api -i -X POST "$P/websites/$W/apps/persistent" -d '{"command":"node -e \"require(\\\"http\\\").createServer((q,r)=>r.end(\\\"dup\\\")).listen(3077)\"","startMode":"manual","proxyDetails":{"path":"mcpprobe2","port":3077}}' | sed -n '1p;/^{/p'
api -i -X POST "$P/websites/$W/apps/persistent" -d '{"command":"node -e \"require(\\\"http\\\").createServer((q,r)=>r.end(\\\"clash\\\")).listen(3078)\"","startMode":"manual","proxyDetails":{"path":"demo-login","port":3078}}' | sed -n '1p;/^{/p'
api "$P/websites/$W/apps/persistent" | python3 -c 'import json,sys; [print(a["id"], a["proxyDetails"]) for a in json.load(sys.stdin)]'
```
Record: whether the panel accepts a duplicate port and a path that collides with a real docroot directory (`demo-login`), or answers 400 with which message. Delete every app this step created:

```bash
for id in <ids from the listing except $A>; do api -o /dev/null -w "delete $id: HTTP %{http_code}\n" -X DELETE "$P/websites/$W/apps/persistent/$id"; done
curl -sS -o /dev/null -w 'demo-login still PHP: HTTP %{http_code}\n' https://vahi.dev/demo-login/
```
Expected: the login page still answers 200 from PHP.

- [ ] **Step 5: Question 4 — log size**

```bash
api -o /dev/null -w 'log: HTTP %{http_code} %{size_download} bytes\n' "$P/websites/$W/apps/persistent/$A"
ssh -i ~/.ssh/enhance_vahi_dev_ed25519 vahi_dev1@65.98.32.45 "ls -la persistent_app_$A.log; wc -c persistent_app_$A.log"
```
Record: whether the endpoint returns the whole file or a capped tail (compare the two sizes).

- [ ] **Step 6: Question 5 — `appKind`, then clean up**

Record what `appKind` the listing showed for the probe app in Step 3 (`generic` expected) and note that `openclaw` is a panel-provided app kind the tools display but never create. Then:

```bash
api -o /dev/null -w "delete $A: HTTP %{http_code}\n" -X DELETE "$P/websites/$W/apps/persistent/$A"
api "$P/websites/$W/apps/persistent"; echo
ssh -i ~/.ssh/enhance_vahi_dev_ed25519 vahi_dev1@65.98.32.45 'ls persistent_app_*.log; rm -f persistent_app_*.log; ls persistent_app_*.log 2>/dev/null || echo "logs removed"'
```
Expected: `[]` and `logs removed`. Leave nvm installed (Task 7 and the walkthrough need it).

- [ ] **Step 7: Write the findings**

Append under `### Node and persistent apps (milestone C, probed now)` in `docs/research.md`:

```markdown
#### Milestone C Task 1 probe (2026-09-16)

1. Second `installNvm`: HTTP <code>; <no-op | reinstalled | error "<text>">. `GET …/node/versions` after it: <still lags nvm ls | matches>.
2. Restart: a no-change PATCH <does | does not> restart the process (pid <same | changed>); `startMode: manual` <stops it (HTTP <code> on the path) | leaves it running>; back to `automatic` <starts a new process | does nothing>.
3. Duplicate port: <accepted | 400 "<message>">. Proxy path colliding with a docroot directory (`demo-login`): <accepted, and the proxy wins | 400 "<message>" | accepted, PHP still served>.
4. Log endpoint: <whole file | capped at <n> bytes> (file was <n> bytes, endpoint returned <n>).
5. `appKind`: `generic` on our app; `openclaw` is a panel-provided kind, never created by these tools.
6. `nodeVersion: "stable"` on create: <accepted | 400 "<message>">. POST body: <carries the app with id | empty; id comes from the listing>.
```
Fill every angle-bracket item with what was observed.

- [ ] **Step 8: Commit**

```bash
git add docs/research.md
git commit -m "docs(research): milestone C live probe — nvm reinstall, restart semantics, collisions, log size

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Node runtime tools (`node.ts`)

**Files:**
- Create: `server/src/tools/node.ts`
- Test: `server/test/unit/tools-node.test.ts`

**Interfaces:**
- Consumes: `siteOf`, `siteWebsite`, `websiteArg`, `DbSite` from `src/tools/dbcommon.ts`; `fail`, `ok`, `kv`, `safe` from `src/core/respond.ts`.
- Produces: `persistentAppsGate(site: DbSite, w: Website, feature?: string): ToolResult | undefined`, `appsSite(ctx, website): Promise<AppsSite>` (the gated resolver Task 3 reuses), `SEMVER_RE`, `compareSemverDesc(a, b)`, and `tools: ToolDef[]` = `node_install`, `node_versions_available`, `node_versions_installed`, `node_version_install`, `node_version_set_default`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/unit/tools-node.test.ts
import { describe, expect, it } from 'vitest';
import { compareSemverDesc, tools } from '../../src/tools/node.js';
import { base, ORG_ID, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;
const nodeBase = `/websites/${WEBSITE_ID}/apps/node`;

/** A site whose plan has no persistent apps: every tool here must refuse without a request. */
const noApps = (): Route[] => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [websiteDetail], total: 1 } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, canUse: { ...websiteDetail.canUse, persistentApps: false } } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: { items: [] } },
];

/** Captures the raw wire body: the two version endpoints take a bare JSON string. */
function captureRaw(route: Omit<Route, 'handler'>, sink: { raw?: string; path?: string }, status = 200): Route {
  return {
    ...route,
    handler: async (req, url) => {
      sink.raw = await req.text();
      sink.path = url.pathname.replace(/^\/api/, '');
      return new Response(null, { status });
    },
  };
}

describe('the persistent-apps gate', () => {
  for (const [name, args] of [
    ['node_install', {}],
    ['node_versions_available', {}],
    ['node_versions_installed', {}],
    ['node_version_install', { version: '22.23.2' }],
    ['node_version_set_default', { version: 'stable' }],
  ] as const) {
    it(`${name} refuses when canUse.persistentApps is not true and sends nothing`, async () => {
      const { ctx, f } = await makeContext(noApps());
      const r = await callTool(byName(tools, name), { website: 'vahi.dev', ...args }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('not enabled');
      expect(r.text).toContain(websiteLine);
      expect(f.calls.some((c) => c.path.includes('/apps/node'))).toBe(false);
    });
  }
});

describe('node_install', () => {
  it('posts to the nvm endpoint and says it takes a while', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'POST', path: nodeBase, status: 200 }]);
    const r = await callTool(byName(tools, 'node_install'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(f.calls.some((c) => c.method === 'POST' && c.path === nodeBase)).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toMatch(/minute/);
    expect(r.structured).toMatchObject({ installed: true });
  });
});

describe('compareSemverDesc', () => {
  it('orders newest first, numerically per segment', () => {
    expect(['0.12.18', '22.23.2', '26.8.1', '4.9.1', '22.3.0'].sort(compareSemverDesc)).toEqual(['26.8.1', '22.23.2', '22.3.0', '4.9.1', '0.12.18']);
  });
});

describe('node_versions_available', () => {
  it('lists newest first, summarises by major, and keeps the full list in structuredContent', async () => {
    const all = ['0.12.18', '4.9.1', '20.19.0', '22.3.0', '22.23.2', '26.8.1'];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `${nodeBase}/possible_versions`, body: all }]);
    const r = await callTool(byName(tools, 'node_versions_available'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ total: 6, versions: ['26.8.1', '22.23.2', '22.3.0', '20.19.0', '4.9.1', '0.12.18'] });
    expect(r.text).toContain('26.8.1');
    expect(r.text).toContain('22.23.2');
    expect(r.text).not.toContain('22.3.0'); // only the newest of each major is rendered
    expect(r.text).toMatch(/6 versions/);
  });
});

describe('node_versions_installed', () => {
  it('labels the list as the panel\'s and points at nvm ls, never claiming a version is absent', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `${nodeBase}/versions`, body: ['26.8.1'] }]);
    const r = await callTool(byName(tools, 'node_versions_installed'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ versions: ['26.8.1'], authoritative: false });
    expect(r.text).toContain('as reported by the panel');
    expect(r.text).toContain('nvm ls');
  });

  it('says so when the panel reports none', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `${nodeBase}/versions`, body: [] }]);
    const r = await callTool(byName(tools, 'node_versions_installed'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toMatch(/none reported/);
    expect(r.structured).toMatchObject({ versions: [] });
  });
});

describe('node_version_install', () => {
  it('sends the version as a bare JSON string', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'POST', path: `${nodeBase}/versions` }, sink)]);
    const r = await callTool(byName(tools, 'node_version_install'), { website: 'vahi.dev', version: '22.23.2' }, ctx);
    expect(sink.raw).toBe('"22.23.2"');
    expect(sink.path).toBe(`${nodeBase}/versions`);
    expect(r.structured).toMatchObject({ version: '22.23.2', installed: true });
    expect(r.text).toContain('node_version_set_default');
  });

  it('rejects a non-semver version before resolving anything', async () => {
    const { ctx, f } = await makeContext([...base()]);
    await expect(callTool(byName(tools, 'node_version_install'), { website: 'vahi.dev', version: 'stable' }, ctx)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe('node_version_set_default', () => {
  it('puts a semver as a bare JSON string', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `${nodeBase}/versions/default` }, sink)]);
    const r = await callTool(byName(tools, 'node_version_set_default'), { website: 'vahi.dev', version: '22.23.2' }, ctx);
    expect(sink.raw).toBe('"22.23.2"');
    expect(r.structured).toMatchObject({ version: '22.23.2', default: true });
  });

  it('accepts the stable and default selectors', async () => {
    const sink: { raw?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `${nodeBase}/versions/default` }, sink)]);
    await callTool(byName(tools, 'node_version_set_default'), { website: 'vahi.dev', version: 'stable' }, ctx);
    expect(sink.raw).toBe('"stable"');
  });

  it('rejects anything else', async () => {
    const { ctx } = await makeContext([...base()]);
    await expect(callTool(byName(tools, 'node_version_set_default'), { website: 'vahi.dev', version: 'latest' }, ctx)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/unit/tools-node.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/node.js'`.

- [ ] **Step 3: Write the implementation**

Replace `<SECOND_INSTALL_SENTENCE>` in `node_install`'s description with the one sentence matching the Task 1 finding for question 1, chosen from exactly these: `Calling it again on a site that already has nvm is a harmless no-op.` / `Calling it again on a site that already has nvm reinstalls the stable version; installed versions and the default alias survive.` / `Calling it again on a site that already has nvm fails with the panel's error; check node_versions_installed first.`

```ts
// server/src/tools/node.ts
import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { defineTool, type ToolDef, type ToolResult } from '../core/registry.js';
import { fail, kv, ok, safe } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { siteOf, siteWebsite, websiteArg, type DbSite } from './dbcommon.js';

/** A Node version the way nvm names it: `22.23.2`, with optional pre-release and build parts. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const semverArg = z.string().regex(SEMVER_RE, 'a Node version like 22.23.2');
/** The API's `NodeVersion` selector: a semver, or the nvm aliases `stable` / `default`. */
export const nodeSelectorArg = z.string().refine((v) => v === 'stable' || v === 'default' || SEMVER_RE.test(v), 'a Node version like 22.23.2, or "stable" or "default"');

/**
 * Node and persistent apps are one plan feature: the panel reports it in `canUse.persistentApps`
 * and every `/apps/node…` and `/apps/persistent…` endpoint answers with an error on a plan without
 * it. Check the flag and say so instead of sending a request that can only fail. "Not enabled"
 * rather than "is false": the block can also be absent.
 */
export function persistentAppsGate(site: DbSite, w: Website, feature = 'Node.js'): ToolResult | undefined {
  if (w.canUse?.persistentApps === true) return undefined;
  return fail(
    `${site.identity}\n${feature} is not enabled for this website's plan (canUse.persistentApps is not true), so nothing was sent to the panel. Ask the hosting provider to add persistent apps to the plan.`,
    { available: false },
  );
}

export type AppsSite = ({ ok: true } & DbSite & { w: Website }) | { ok: false; result: ToolResult };

/** The site plus its full record, or the "not on this plan" result. Gate first, then act. */
export async function appsSite(ctx: ToolContext, website: string, feature = 'Node.js'): Promise<AppsSite> {
  const { org, w } = await siteWebsite(ctx, website);
  const site = siteOf(ctx, org, w);
  const gate = persistentAppsGate(site, w, feature);
  return gate ? { ok: false, result: gate } : { ok: true, ...site, w };
}

/** Newest first. Segments compare numerically; a pre-release sorts after the same release. */
export function compareSemverDesc(a: string, b: string): number {
  const num = (v: string) => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10));
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  }
  return a.includes('-') === b.includes('-') ? 0 : a.includes('-') ? 1 : -1;
}

const nodePath = (id: string) => ({ params: { path: { website_id: id } } });

export const nodeInstall = defineTool({
  name: 'node_install',
  tier: 'customer',
  risk: 'write',
  description: 'Installs nvm and the current stable Node.js into the website container (takes up to a minute). Needed once before any Node app can run; node_version_install then adds other versions. Requires persistent apps on the plan (canUse.persistentApps). <SECOND_INSTALL_SENTENCE>',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    await ctx.client.call('POST', '/websites/{website_id}/apps/node', () => ctx.client.api.POST('/websites/{website_id}/apps/node', nodePath(s.id)));
    return ok(
      `${s.identity}\nnvm and the stable Node.js are being installed in the container; allow up to a minute before using them. Next: node_version_install for a specific version, node_version_set_default to pin the default, then persistent_app_create.`,
      { installed: true },
    );
  },
});

export const nodeVersionsAvailable = defineTool({
  name: 'node_versions_available',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the Node.js versions nvm can install on this website, newest first. The text shows the newest release of each major; structuredContent.versions has every one.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    const raw = await ctx.client.call('GET', '/websites/{website_id}/apps/node/possible_versions', () => ctx.client.api.GET('/websites/{website_id}/apps/node/possible_versions', nodePath(s.id)));
    const versions = [...(raw ?? [])].sort(compareSemverDesc);
    // One line per major keeps the transcript short: nvm knows well over a hundred releases.
    const newestPerMajor: string[] = [];
    const seen = new Set<string>();
    for (const v of versions) {
      const major = v.split('.')[0]!;
      if (!seen.has(major)) {
        seen.add(major);
        newestPerMajor.push(v);
      }
    }
    const shown = newestPerMajor.slice(0, 8);
    return ok(
      [s.identity, `${versions.length} versions available (newest of each major shown; the full list is in structuredContent.versions):`, shown.map(safe).join(', ') || 'none'].join('\n'),
      { total: versions.length, versions, newestPerMajor },
    );
  },
});

export const nodeVersionsInstalled = defineTool({
  name: 'node_versions_installed',
  tier: 'customer',
  risk: 'read',
  description: "Lists the Node.js versions the panel reports as installed by nvm on this website. Verified live: this list can lag behind nvm — a version installed and set default through the API was still missing from it — so treat it as a hint. `ssh <user>@<host> '. ~/.nvm/nvm.sh && nvm ls'` is authoritative; never conclude from this tool that a version is absent.",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    const raw = await ctx.client.call('GET', '/websites/{website_id}/apps/node/versions', () => ctx.client.api.GET('/websites/{website_id}/apps/node/versions', nodePath(s.id)));
    const versions = [...(raw ?? [])].sort(compareSemverDesc);
    const list = versions.length ? versions.map(safe).join(', ') : 'none reported';
    return ok(
      [s.identity, kv([['installed (as reported by the panel)', list]]), "This list can lag behind nvm. Confirm over SSH with '. ~/.nvm/nvm.sh && nvm ls' before relying on it, and do not treat a missing version as absent."].join('\n'),
      { versions, authoritative: false },
    );
  },
});

export const nodeVersionInstall = defineTool({
  name: 'node_version_install',
  tier: 'customer',
  risk: 'write',
  description: 'Installs a specific Node.js version with nvm on this website (takes up to a minute). Pick one from node_versions_available. Does not change the default; run node_version_set_default afterwards.',
  input: z.object({ website: websiteArg, version: semverArg }),
  async handler({ website, version }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    // The endpoint takes a bare JSON string: the body on the wire is `"22.23.2"`.
    await ctx.client.call('POST', '/websites/{website_id}/apps/node/versions', () => ctx.client.api.POST('/websites/{website_id}/apps/node/versions', { ...nodePath(s.id), body: version }));
    return ok(`${s.identity}\nNode.js ${safe(version)} is being installed; allow up to a minute. Run node_version_set_default website=${safe(website)} version=${safe(version)} to make it the default for apps without an explicit nodeVersion.`, { version, installed: true });
  },
});

export const nodeVersionSetDefault = defineTool({
  name: 'node_version_set_default',
  tier: 'customer',
  risk: 'write',
  description: "Sets nvm's default Node.js version on this website: a version from node_versions_installed, or \"stable\" / \"default\". Persistent apps without an explicit nodeVersion start on this default; running apps keep their current process until restarted.",
  input: z.object({ website: websiteArg, version: nodeSelectorArg }),
  async handler({ website, version }, ctx) {
    const s = await appsSite(ctx, website);
    if (!s.ok) return s.result;
    await ctx.client.call('PUT', '/websites/{website_id}/apps/node/versions/default', () => ctx.client.api.PUT('/websites/{website_id}/apps/node/versions/default', { ...nodePath(s.id), body: version }));
    return ok(`${s.identity}\ndefault Node.js version set to ${safe(version)}. Apps that pin nodeVersion are unaffected; others pick it up when they next start.`, { version, default: true });
  },
});

export const tools: ToolDef[] = [nodeInstall, nodeVersionsAvailable, nodeVersionsInstalled, nodeVersionInstall, nodeVersionSetDefault];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-node.test.ts && npm run typecheck`
Expected: all tests in the file PASS; typecheck clean. If `body: version` fails to typecheck against the generated request type, the generated type is `string` (checked in Task 0); do not cast — fix the path literal instead.

- [ ] **Step 5: Commit**

```bash
git add src/tools/node.ts test/unit/tools-node.test.ts
git commit -m "feat(node): nvm install, version listing, install and default tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Persistent app list, create, update and log (`apps.ts`)

**Files:**
- Create: `server/src/tools/apps.ts`
- Modify: `server/test/fixtures/panel.ts` (append fixtures)
- Test: `server/test/unit/tools-apps.test.ts`

**Interfaces:**
- Consumes: `appsSite`, `nodeSelectorArg` from `src/tools/node.ts`; `tailLog` from `src/tools/php.ts`; `parseScalarText` from `src/client/client.ts`; `websiteHome` from `src/core/identity.ts`.
- Produces: `validateProxyPath(input): { path: string; note?: string }`, `validateWorkingDirectory(input): string`, `findApp(apps, appId)`, `appUrl(w, path)`, `PROXY_PATH_RE`, and `tools` = `persistent_apps_list`, `persistent_app_create`, `persistent_app_update`, `persistent_app_log` (Task 4 appends `persistent_app_delete` and `persistent_app_probe` to the same array).

- [ ] **Step 1: Add fixtures**

Append to `server/test/fixtures/panel.ts`:

```ts
export const APP_ID = '54bd4d05-4f8e-4291-a507-9be9e8424a89';

/** One panel-managed Node app, the shape `GET /websites/{id}/apps/persistent` returns. */
export const persistentApp = {
  id: APP_ID,
  appKind: 'generic',
  command: 'PORT=3000 node server.js',
  workingDirectory: 'nodeapp',
  startMode: 'automatic',
  nodeVersion: '22.23.2',
  proxyDetails: { path: 'node', port: 3000, allowWebSocketUpgrade: false },
};

export const persistentApps = [persistentApp];
```

- [ ] **Step 2: Write the failing tests**

```ts
// server/test/unit/tools-apps.test.ts
import { describe, expect, it } from 'vitest';
import { tools, validateProxyPath, validateWorkingDirectory } from '../../src/tools/apps.js';
import { APP_ID, base, ORG_ID, persistentApp, persistentApps, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;
const appsPath = `/websites/${WEBSITE_ID}/apps/persistent`;
const appPath = `${appsPath}/${APP_ID}`;

const noApps = (): Route[] => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [websiteDetail], total: 1 } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, canUse: { ...websiteDetail.canUse, persistentApps: false } } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: { items: [] } },
];

/** Captures the parsed JSON body of a write. */
function captureBody(route: Omit<Route, 'handler'>, sink: { body?: unknown; path?: string }, status = 200): Route {
  return {
    ...route,
    handler: async (req, url) => {
      const text = await req.text();
      sink.body = text ? JSON.parse(text) : undefined;
      sink.path = url.pathname.replace(/^\/api/, '');
      return new Response(null, { status });
    },
  };
}

describe('validateProxyPath', () => {
  it('accepts the panel shape and strips exactly one leading slash with a note', () => {
    expect(validateProxyPath('node')).toEqual({ path: 'node' });
    expect(validateProxyPath('api/v1.2-beta')).toEqual({ path: 'api/v1.2-beta' });
    expect(validateProxyPath('/node')).toMatchObject({ path: 'node' });
    expect(validateProxyPath('/node').note).toMatch(/leading slash/);
  });
  it('rejects what the panel rejects', () => {
    for (const bad of ['', '//node', 'node/', '-node', 'no de', 'nöde', '../x']) {
      expect(() => validateProxyPath(bad), bad).toThrow(/proxy path/);
    }
  });
});

describe('validateWorkingDirectory', () => {
  it('accepts a relative path and trims a trailing slash', () => {
    expect(validateWorkingDirectory('nodeapp')).toBe('nodeapp');
    expect(validateWorkingDirectory('apps/web/')).toBe('apps/web');
  });
  it('rejects absolute paths and parent segments', () => {
    expect(() => validateWorkingDirectory('/var/www/x/nodeapp')).toThrow(/relative to the site home/);
    expect(() => validateWorkingDirectory('../other')).toThrow(/relative to the site home/);
    expect(() => validateWorkingDirectory('a/../b')).toThrow(/relative to the site home/);
  });
});

describe('the persistent-apps gate', () => {
  for (const [name, args] of [
    ['persistent_apps_list', {}],
    ['persistent_app_create', { command: 'node server.js' }],
    ['persistent_app_update', { app_id: APP_ID, command: 'node app.js' }],
    ['persistent_app_log', { app_id: APP_ID }],
  ] as const) {
    it(`${name} refuses when canUse.persistentApps is not true and sends nothing`, async () => {
      const { ctx, f } = await makeContext(noApps());
      const r = await callTool(byName(tools, name), { website: 'vahi.dev', ...args }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('not enabled');
      expect(f.calls.some((c) => c.path.includes('/apps/persistent'))).toBe(false);
    });
  }
});

describe('persistent_apps_list', () => {
  it('renders every field and the primary-domain URL', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_apps_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(APP_ID);
    expect(r.text).toContain('PORT=3000 node server.js');
    expect(r.text).toContain('https://vahi.dev/node/');
    expect(r.text).toContain('preview');
    expect(r.structured).toMatchObject({ total: 1, items: [{ id: APP_ID, kind: 'generic', command: 'PORT=3000 node server.js', workingDirectory: 'nodeapp', nodeVersion: '22.23.2', startMode: 'automatic', proxy: { path: 'node', port: 3000, websocket: false }, url: 'https://vahi.dev/node/' }] });
  });

  it('says so when there are none and points at persistent_app_create', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [] }]);
    const r = await callTool(byName(tools, 'persistent_apps_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toMatch(/no persistent apps/);
    expect(r.text).toContain('persistent_app_create');
    expect(r.structured).toMatchObject({ total: 0, items: [] });
  });
});

describe('persistent_app_create', () => {
  it('posts the panel shape, then finds the new app in the listing and names its URL', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([
      ...base(),
      captureBody({ method: 'POST', path: appsPath }, sink, 201),
      { method: 'GET', path: appsPath, body: persistentApps },
    ]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'PORT=3000 node server.js', working_directory: 'nodeapp', proxy_path: 'node', port: 3000, node_version: '22.23.2' }, ctx);
    expect(sink.body).toEqual({ command: 'PORT=3000 node server.js', workingDirectory: 'nodeapp', startMode: 'automatic', nodeVersion: '22.23.2', proxyDetails: { path: 'node', port: 3000, allowWebSocketUpgrade: false } });
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ id: APP_ID, url: 'https://vahi.dev/node/', created: true });
    expect(r.text).toContain('https://vahi.dev/node/');
    expect(r.text).toMatch(/preview .*not/);
    expect(r.text).toContain('persistent_app_log');
  });

  it('omits proxyDetails when no proxy path is given and requires a port when one is', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'POST', path: appsPath }, sink, 201), { method: 'GET', path: appsPath, body: [{ ...persistentApp, proxyDetails: undefined, command: 'node worker.js' }] }]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node worker.js' }, ctx);
    expect(sink.body).toEqual({ command: 'node worker.js', startMode: 'automatic' });
    expect(r.structured).toMatchObject({ created: true, url: null });
    await expect(callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node server.js', proxy_path: 'node' }, ctx)).rejects.toThrow(/port/);
  });

  it('strips one leading slash from the proxy path and says so; rejects an absolute working directory', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext([...base(), captureBody({ method: 'POST', path: appsPath }, sink, 201), { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'PORT=3000 node server.js', proxy_path: '/node', port: 3000 }, ctx);
    expect((sink.body as { proxyDetails: { path: string } }).proxyDetails.path).toBe('node');
    expect(r.text).toMatch(/leading slash/);
    const before = f.calls.length;
    const bad = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node server.js', working_directory: '/var/www/x/nodeapp' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/relative to the site home/);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(f.calls.length - before).toBeGreaterThanOrEqual(0);
  });

  it('reports the app even when the listing cannot match it', async () => {
    const { ctx } = await makeContext([...base(), { method: 'POST', path: appsPath, status: 201 }, { method: 'GET', path: appsPath, body: [] }]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node other.js' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ created: true, id: null });
    expect(r.text).toContain('persistent_apps_list');
  });
});

describe('persistent_app_update', () => {
  it('patches only the given fields and merges the proxy with the current one', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, captureBody({ method: 'PATCH', path: appPath }, sink)]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, port: 3100 }, ctx);
    expect(sink.path).toBe(appPath);
    expect(sink.body).toEqual({ proxyDetails: { path: 'node', port: 3100, allowWebSocketUpgrade: false } });
    expect(r.structured).toMatchObject({ id: APP_ID, updated: true, url: 'https://vahi.dev/node/' });
  });

  it('sends the Unset shape for clear_proxy and clear_node_version', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, captureBody({ method: 'PATCH', path: appPath }, sink)]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, clear_proxy: true, clear_node_version: true, start_mode: 'manual' }, ctx);
    expect(sink.body).toEqual({ proxyDetails: { unset: true }, nodeVersion: { unset: true }, startMode: 'manual' });
    expect(r.structured).toMatchObject({ url: null });
  });

  it('refuses an unknown app id without patching, and refuses an empty update', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: '00000000-0000-4000-8000-000000000000', command: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no persistent app/);
    const empty = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/nothing to change/);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('mentions the restart behaviour in its description', () => {
    expect(byName(tools, 'persistent_app_update').description).toMatch(/restart/);
  });
});

describe('persistent_app_log', () => {
  it('returns the newest 64 KB of the JSON-string log', async () => {
    const big = `${'x'.repeat(70_000)}\nlistening on 3000\n`;
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'GET', path: appPath, body: big }]);
    const r = await callTool(byName(tools, 'persistent_app_log'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    const s = r.structured as { bytes: number; truncated: boolean; log: string };
    expect(s.truncated).toBe(true);
    expect(s.bytes).toBe(Buffer.byteLength(big));
    expect(s.log.endsWith('listening on 3000\n')).toBe(true);
    expect(r.text).toMatch(/newest 64 KB/);
  });

  it('says the app has not written anything when the log is empty', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'GET', path: appPath, body: '' }]);
    const r = await callTool(byName(tools, 'persistent_app_log'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.text).toMatch(/not started yet or has not written/);
    expect(r.structured).toMatchObject({ bytes: 0, log: '' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/unit/tools-apps.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/apps.js'`.

- [ ] **Step 4: Write the implementation**

Replace `<RESTART_SENTENCE>` (used twice) with the one sentence matching the Task 1 finding for question 2, chosen from exactly these: `An update restarts the running process.` / `An update does not restart the running process; set start_mode to manual and then back to automatic to restart it.` / `An update does not restart the running process and toggling start_mode does not either; delete and recreate the app to restart it.`

```ts
// server/src/tools/apps.ts
import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { components } from '../client/generated/types.js';
import type { ToolContext } from '../core/context.js';
import { websiteHome } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { websiteArg } from './dbcommon.js';
import { appsSite, nodeSelectorArg } from './node.js';
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
    note = `the leading slash was dropped: the panel wants "${path}", and it serves it at /${path}/`;
  }
  if (!PROXY_PATH_RE.test(path) || path.includes('..')) {
    throw new Error(`proxy path "${input}" is not accepted by the panel: use letters, digits and underscores, with "-", "." and "/" only in the middle, and no leading slash`);
  }
  return note ? { path, note } : { path };
}

/** Relative to the site home, no parent segments. An absolute path is refused here because the
 *  panel silently stores it as null and the app then runs from the home directory. */
export function validateWorkingDirectory(input: string): string {
  const dir = input.trim().replace(/\/+$/, '');
  if (dir.startsWith('/') || dir.split('/').includes('..') || dir === '') {
    throw new Error(`working directory "${input}" must be relative to the site home (for example "nodeapp"), with no leading slash and no ".." segments`);
  }
  return dir;
}

export function findApp(apps: ListedApp[], appId: string): ListedApp | undefined {
  return apps.find((a) => a.id === appId);
}

/** Where a proxied app answers: the primary domain only (verified live: the preview alias 404s). */
export function appUrl(w: Website, path: string | undefined): string | null {
  return path ? `https://${w.domain.domain}/${path}/` : null;
}

const PREVIEW_NOTE = 'Persistent apps answer on the primary domain only; the *.mystaging.site preview URL does not proxy them (verified live). Before DNS resolves, verify with persistent_app_probe.';

const appIdArg = z.string().uuid().describe('Persistent app id from persistent_apps_list');
const startModeArg = z.enum(['automatic', 'manual']);
const portArg = z.number().int().min(1024).max(65535).describe('The port the app listens on inside the container; pass it to the app as PORT in the command');

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

async function listApps(ctx: ToolContext, websiteId: string): Promise<ListedApp[]> {
  const res = await ctx.client.call('GET', '/websites/{website_id}/apps/persistent', () => ctx.client.api.GET('/websites/{website_id}/apps/persistent', { params: { path: { website_id: websiteId } } }));
  return res ?? [];
}

export const persistentAppsList = defineTool({
  name: 'persistent_apps_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the persistent apps (Node processes the panel keeps running) on a website: id, command, working directory, Node version, start mode, proxy path and port, and the URL each answers on. Requires persistent apps on the plan.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await appsSite(ctx, website, 'Persistent apps');
    if (!s.ok) return s.result;
    const items = (await listApps(ctx, s.id)).map((a) => row(s.w, a));
    if (items.length === 0) {
      return ok(`${s.identity}\nno persistent apps on this website. Create one with persistent_app_create (install Node first with node_install if the container has none).`, { total: 0, items });
    }
    const rows = items.map((i) => ({ id: i.id, kind: i.kind, command: i.command, 'working dir': i.workingDirectory ?? '(home)', node: i.nodeVersion ?? 'default', start: i.startMode, proxy: i.proxy ? `${i.proxy.path} → :${i.proxy.port}${i.proxy.websocket ? ' (ws)' : ''}` : 'none', url: i.url ?? '-' }));
    return ok([s.identity, `persistent apps (${items.length}):`, table(rows, ['id', 'kind', 'command', 'working dir', 'node', 'start', 'proxy', 'url']), PREVIEW_NOTE].join('\n'), { total: items.length, items });
  },
});

export const persistentAppCreate = defineTool({
  name: 'persistent_app_create',
  tier: 'customer',
  risk: 'write',
  description: 'Registers a persistent app: a command the panel starts in the website container, keeps running, and (with proxy_path and port) exposes at https://<primary domain>/<proxy_path>/. working_directory is relative to the site home (never absolute); proxy_path never starts with "/". The app must listen on the given port — pass it in the command (PORT=3000 node server.js). Requires persistent apps on the plan and Node installed (node_install). The preview domain never proxies apps.',
  input: z.object({
    website: websiteArg,
    command: z.string().min(1).describe('Shell command to run, e.g. "PORT=3000 node server.js" or "PORT=3000 npm start"'),
    working_directory: z.string().min(1).optional().describe('Directory under the site home to run in, e.g. "nodeapp" (relative, never absolute)'),
    proxy_path: z.string().min(1).optional().describe('URL path the web server proxies to the app, e.g. "node" or "api/v1" (no leading slash)'),
    port: portArg.optional(),
    allow_websocket: z.boolean().default(false),
    start_mode: startModeArg.default('automatic'),
    node_version: nodeSelectorArg.optional().describe('Pin a Node version (semver, "stable" or "default"); omitted = nvm default'),
  }),
  async handler(args, ctx) {
    const s = await appsSite(ctx, args.website, 'Persistent apps');
    if (!s.ok) return s.result;
    let workingDirectory: string | undefined;
    let proxy: { path: string; note?: string } | undefined;
    try {
      if (args.working_directory !== undefined) workingDirectory = validateWorkingDirectory(args.working_directory);
      if (args.proxy_path !== undefined) proxy = validateProxyPath(args.proxy_path);
    } catch (e) {
      return fail(`${s.identity}\n${(e as Error).message}. Nothing was sent to the panel.`, { created: false });
    }
    if (proxy && args.port === undefined) throw new Error('port is required when proxy_path is given: it is the port the app listens on');
    const body: NewApp = { command: args.command, startMode: args.start_mode };
    if (workingDirectory !== undefined) body.workingDirectory = workingDirectory;
    if (args.node_version !== undefined) body.nodeVersion = args.node_version;
    if (proxy) body.proxyDetails = { path: proxy.path, port: args.port!, allowWebSocketUpgrade: args.allow_websocket };
    await ctx.client.call('POST', '/websites/{website_id}/apps/persistent', () => ctx.client.api.POST('/websites/{website_id}/apps/persistent', { params: { path: { website_id: s.id } }, body }));
    // The create answers 201 with no body, so the id comes from the listing: the newest app whose
    // command, working directory and proxy path match what was just sent.
    const match = (await listApps(ctx, s.id)).filter((a) => a.command === body.command && (a.workingDirectory ?? undefined) === body.workingDirectory && (a.proxyDetails?.path ?? undefined) === body.proxyDetails?.path).at(-1);
    const url = appUrl(s.w, proxy?.path);
    const lines = [
      s.identity,
      `persistent app registered${match ? ` (id ${match.id})` : ''}.`,
      kv([
        ['command', args.command],
        ['working directory', workingDirectory ? `${websiteHome(s.w)}/${workingDirectory}` : `${websiteHome(s.w)} (the site home)`],
        ['node version', args.node_version ?? 'nvm default'],
        ['start mode', args.start_mode],
        ['proxy', proxy ? `/${proxy.path}/ → port ${args.port}${args.allow_websocket ? ', WebSocket upgrades allowed' : ''}` : 'none (not reachable from the web)'],
        ['url', url ?? '-'],
      ]),
    ];
    if (proxy?.note) lines.push(proxy.note);
    if (!match) lines.push('the panel accepted it but the listing did not show a matching app yet; run persistent_apps_list to find its id.');
    lines.push(`next: persistent_app_log${match ? ` app_id=${match.id}` : ''} until it reports listening, then persistent_app_probe. ${PREVIEW_NOTE}`);
    return ok(lines.join('\n'), { id: match?.id ?? null, url, created: true, ...(proxy?.note ? { note: proxy.note } : {}) });
  },
});

export const persistentAppUpdate = defineTool({
  name: 'persistent_app_update',
  tier: 'customer',
  risk: 'write',
  description: 'Changes a persistent app: command, working directory, start mode, Node version, proxy path, port or WebSocket flag. Only the fields given are sent; a new proxy path or port is merged with the current proxy. clear_proxy unexposes the app, clear_node_version returns it to the nvm default. <RESTART_SENTENCE>',
  input: z.object({
    website: websiteArg,
    app_id: appIdArg,
    command: z.string().min(1).optional(),
    working_directory: z.string().min(1).optional(),
    start_mode: startModeArg.optional(),
    node_version: nodeSelectorArg.optional(),
    proxy_path: z.string().min(1).optional(),
    port: portArg.optional(),
    allow_websocket: z.boolean().optional(),
    clear_proxy: z.boolean().default(false),
    clear_node_version: z.boolean().default(false),
  }),
  async handler(args, ctx) {
    const s = await appsSite(ctx, args.website, 'Persistent apps');
    if (!s.ok) return s.result;
    const current = findApp(await listApps(ctx, s.id), args.app_id);
    if (!current) return fail(`${s.identity}\nno persistent app with id ${safe(args.app_id)} on this website; run persistent_apps_list.`, { updated: false });
    const patch: AppPatch = {};
    const notes: string[] = [];
    try {
      if (args.command !== undefined) patch.command = args.command;
      if (args.working_directory !== undefined) patch.workingDirectory = validateWorkingDirectory(args.working_directory);
      if (args.start_mode !== undefined) patch.startMode = args.start_mode;
      if (args.clear_node_version) patch.nodeVersion = { unset: true };
      else if (args.node_version !== undefined) patch.nodeVersion = args.node_version;
      if (args.clear_proxy) {
        patch.proxyDetails = { unset: true };
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
      }
    } catch (e) {
      return fail(`${s.identity}\n${(e as Error).message}. Nothing was sent to the panel.`, { updated: false });
    }
    if (Object.keys(patch).length === 0) return fail(`${s.identity}\nnothing to change: give at least one field. Nothing was sent to the panel.`, { updated: false });
    await ctx.client.call('PATCH', '/websites/{website_id}/apps/persistent/{app_id}', () => ctx.client.api.PATCH('/websites/{website_id}/apps/persistent/{app_id}', { params: { path: { website_id: s.id, app_id: args.app_id } }, body: patch }));
    const proxyAfter = args.clear_proxy ? undefined : patch.proxyDetails && 'path' in patch.proxyDetails ? patch.proxyDetails.path : current.proxyDetails?.path;
    const url = appUrl(s.w, proxyAfter);
    const changed = Object.keys(patch).map((k) => (k === 'proxyDetails' ? 'proxy' : k === 'nodeVersion' ? 'node version' : k === 'workingDirectory' ? 'working directory' : k === 'startMode' ? 'start mode' : k));
    return ok([s.identity, `persistent app ${safe(args.app_id)} updated (${changed.join(', ')}).`, kv([['url', url ?? '-']]), ...notes, '<RESTART_SENTENCE>'].join('\n'), { id: args.app_id, updated: true, changed, url });
  },
});

export const persistentAppLog = defineTool({
  name: 'persistent_app_log',
  tier: 'customer',
  risk: 'read',
  description: "Returns a persistent app's startup and stdout log (the newest 64 KB): nvm loading, the Node version, and whatever the app printed, such as its listening line or a crash. Read it before changing anything when an app does not answer.",
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

export const tools: ToolDef[] = [persistentAppsList, persistentAppCreate, persistentAppUpdate, persistentAppLog];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-apps.test.ts && npm run typecheck`
Expected: PASS; typecheck clean. If `ListedPersistentApp` in the 12.25.11 types lacks `appKind`, drop `?? 'generic'` to a plain `a.appKind ?? 'generic'` cast-free read via `(a as { appKind?: string }).appKind` and say so in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/tools/apps.ts test/unit/tools-apps.test.ts test/fixtures/panel.ts
git commit -m "feat(apps): persistent app list, create, update and log tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `persistent_app_delete` (gated) and `persistent_app_probe`

**Files:**
- Create: `server/src/core/probe.ts`
- Modify: `server/src/core/registry.ts:7` (`Target.kind`), `server/src/core/context.ts` (`httpProbe` seam), `server/src/tools/apps.ts` (two tools appended)
- Test: `server/test/unit/probe.test.ts`, `server/test/unit/tools-apps.test.ts` (append)

**Interfaces:**
- Consumes: `findApp`, `listApps` pattern, `appUrl` from Task 3; `siteWebsiteById`, `siteOf` from `dbcommon.ts`.
- Produces: `HttpProbe`, `ProbeRequest`, `ProbeResponse`, `httpsProbe`, `classifyCertificate` in `core/probe.ts`; `ToolContext.httpProbe?: HttpProbe`; `Target.kind` includes `'persistent_app'`; `tools` gains `persistent_app_delete` and `persistent_app_probe`.

- [ ] **Step 1: Write the failing probe tests**

```ts
// server/test/unit/probe.test.ts
import { describe, expect, it } from 'vitest';
import { classifyCertificate } from '../../src/core/probe.js';

describe('classifyCertificate', () => {
  it('is valid when TLS authorised the chain', () => {
    expect(classifyCertificate({ issuer: { CN: 'R11' }, subject: { CN: 'vahi.dev' }, valid_from: 'Sep  5 17:28:04 2026 GMT' }, 'vahi.dev', true)).toBe('valid');
  });
  it("is the panel's placeholder when the certificate is self-issued for the domain and dated 1975", () => {
    expect(classifyCertificate({ issuer: { CN: 'vahi.dev' }, subject: { CN: 'vahi.dev' }, valid_from: 'Jan  1 00:00:00 1975 GMT' }, 'vahi.dev', false, 'SELF_SIGNED_CERT_IN_CHAIN')).toBe('placeholder');
  });
  it('reports any other failure with its reason', () => {
    expect(classifyCertificate({ issuer: { CN: 'R11' }, subject: { CN: 'other.example' }, valid_from: 'Sep  5 17:28:04 2026 GMT' }, 'vahi.dev', false, 'ERR_TLS_CERT_ALTNAME_INVALID')).toBe('error:ERR_TLS_CERT_ALTNAME_INVALID');
    expect(classifyCertificate(undefined, 'vahi.dev', false)).toBe('error:no certificate');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/unit/probe.test.ts`
Expected: FAIL, `Cannot find module '../../src/core/probe.js'`.

- [ ] **Step 3: Write `core/probe.ts` and the context seam**

```ts
// server/src/core/probe.ts
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';

export interface ProbeRequest {
  /** The app server's IP: the connection goes here, whatever DNS says. */
  ip: string;
  /** The primary domain, sent as SNI and as the Host header. */
  host: string;
  /** Absolute URL path, e.g. `/node/`. */
  path: string;
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface ProbeResponse {
  status: number;
  latencyMs: number;
  contentType: string | null;
  /** The first `maxBodyBytes` of the body, decoded as UTF-8. */
  body: string;
  /** `valid`, `placeholder` (the panel's self-signed 1975 certificate), or `error:<reason>`. */
  certificate: string;
}

export type HttpProbe = (req: ProbeRequest) => Promise<ProbeResponse>;

interface CertLike {
  issuer?: { CN?: string };
  subject?: { CN?: string };
  valid_from?: string;
}

/** Pure: the verdict from what the socket reports. The placeholder is what every new Enhance
 *  domain serves until Let's Encrypt issues (issuer equals the domain, dated 1975). */
export function classifyCertificate(cert: CertLike | undefined, host: string, authorized: boolean, authorizationError?: string): string {
  if (authorized) return 'valid';
  if (!cert || Object.keys(cert).length === 0) return 'error:no certificate';
  const selfIssued = cert.issuer?.CN === host && cert.subject?.CN === host;
  if (selfIssued || cert.valid_from?.includes('1975')) return 'placeholder';
  return `error:${authorizationError ?? 'unverified'}`;
}

/**
 * The `curl --resolve <host>:443:<ip>` equivalent: TLS to the IP with the domain as SNI. The
 * certificate is inspected and REPORTED, not enforced (`rejectUnauthorized: false`), because a
 * new domain serves the panel's self-signed placeholder until Let's Encrypt issues and the tool
 * exists to verify a deploy before that. This is safe only because the probe is one-way and
 * secret-free: it never sends the panel credential, a cookie or any header beyond Host and
 * User-Agent, follows no redirects, and reads at most `maxBodyBytes` of a page the customer
 * publishes. Never reuse this transport for anything that carries a credential.
 */
export const httpsProbe: HttpProbe = (req) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const r = request(
      { host: req.ip, port: 443, servername: req.host, path: req.path, method: 'GET', headers: { host: req.host, 'user-agent': 'enhance-mcp/probe' }, rejectUnauthorized: false, timeout: req.timeoutMs },
      (res) => {
        const socket = res.socket as TLSSocket;
        const certificate = classifyCertificate(socket.getPeerCertificate?.() as CertLike | undefined, req.host, socket.authorized === true, socket.authorizationError ? String(socket.authorizationError) : undefined);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < req.maxBodyBytes) {
            chunks.push(c.subarray(0, req.maxBodyBytes - size));
            size += c.length;
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, latencyMs: Date.now() - started, contentType: res.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8'), certificate }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error(`no response within ${req.timeoutMs} ms`)));
    r.on('error', reject);
    r.end();
  });
```

In `server/src/core/context.ts`, add the import and the optional field on `ToolContext`:

```ts
import type { HttpProbe } from './probe.js';
// inside `export interface ToolContext { … }`, after the existing fields:
  /** Test seam for persistent_app_probe; production falls back to httpsProbe. */
  httpProbe?: HttpProbe;
```

In `server/src/core/registry.ts`, extend the union on line 7:

```ts
  kind: 'website' | 'domain' | 'ssh_key' | 'mysql_db' | 'mysql_user' | 'pg_db' | 'pg_user' | 'crontab' | 'persistent_app';
```

- [ ] **Step 4: Run the probe tests**

Run: `cd server && npx vitest run test/unit/probe.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Write the failing tool tests (append to `tools-apps.test.ts`)**

Add to the imports: `import type { HttpProbe, ProbeRequest } from '../../src/core/probe.js';` and `SERVER_IP` from the fixtures. Then append:

```ts
describe('persistent_app_delete', () => {
  it('is destructive, previews the app behind the identity block, and the human types the domain', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: appsPath, body: persistentApps },
      { method: 'DELETE', path: appPath, handler: async (_req, url) => { deleted = url.pathname.split('/').pop(); return new Response(null, { status: 200 }); } },
    ]);
    const del = byName(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: 'vahi.dev', app_id: APP_ID });
    const target = await del.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'persistent_app', id: `${WEBSITE_ID}:${APP_ID}`, name: 'vahi.dev' });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(websiteLine);
    expect(preview).toContain('PORT=3000 node server.js');
    expect(preview).toContain('/node/');
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('stop'));
    const r = await del.handler(args, ctx, target);
    expect(deleted).toBe(APP_ID);
    expect(r.structured).toMatchObject({ id: APP_ID, deleted: true });
    expect(r.text).toContain(`persistent_app_${APP_ID}.log`);
  });

  it('refuses at target() for an unknown app or a plan without persistent apps, sending nothing', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [] }]);
    const del = byName(tools, 'persistent_app_delete');
    await expect(del.target!(del.input.parse({ website: 'vahi.dev', app_id: APP_ID }), ctx)).rejects.toThrow(/no persistent app/);
    const { ctx: gated, f: f2 } = await makeContext(noApps());
    await expect(del.target!(del.input.parse({ website: 'vahi.dev', app_id: APP_ID }), gated)).rejects.toThrow(/not enabled/);
    expect([...f.calls, ...f2.calls].some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('persistent_app_probe', () => {
  const fakeProbe = (answer: Partial<Awaited<ReturnType<HttpProbe>>>, seen: ProbeRequest[]): HttpProbe => async (req) => {
    seen.push(req);
    return { status: 200, latencyMs: 12, contentType: 'text/plain', body: 'mcp-c ok', certificate: 'valid', ...answer };
  };

  it('connects to the server IP with the primary domain as host and reports the answer', async () => {
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = fakeProbe({}, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(seen).toEqual([{ ip: SERVER_IP, host: 'vahi.dev', path: '/node/', timeoutMs: 5000, maxBodyBytes: 512 }]);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ url: 'https://vahi.dev/node/', status: 200, certificate: 'valid', body: 'mcp-c ok', reachable: true });
    expect(r.text).toContain('HTTP 200');
  });

  it('takes a proxy_path directly, flags a placeholder certificate, and treats 502/503 as the app not listening', async () => {
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base()]);
    ctx.httpProbe = fakeProbe({ status: 502, certificate: 'placeholder', body: '' }, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', proxy_path: 'node' }, ctx);
    expect(seen[0]?.path).toBe('/node/');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not (listening|answering)/);
    expect(r.text).toMatch(/placeholder/);
    expect(r.structured).toMatchObject({ status: 502, reachable: false, certificate: 'placeholder' });
  });

  it('reports a connection failure as an error result with the reason', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = async () => { throw new Error('no response within 5000 ms'); };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no response within 5000 ms');
    expect(r.structured).toMatchObject({ reachable: false });
  });

  it('refuses an app without a proxy and requires app_id or proxy_path', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [{ ...persistentApp, proxyDetails: undefined }] }]);
    ctx.httpProbe = async () => { throw new Error('must not be called'); };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no proxy/);
    await expect(callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev' }, ctx)).rejects.toThrow(/app_id or proxy_path/);
  });
});
```

- [ ] **Step 6: Run to verify the new tests fail**

Run: `cd server && npx vitest run test/unit/tools-apps.test.ts`
Expected: the four new `describe` blocks FAIL with `no tool persistent_app_delete` / `no tool persistent_app_probe`; the Task 3 tests still pass.

- [ ] **Step 7: Append the two tools to `apps.ts`**

Add to the imports at the top of `server/src/tools/apps.ts`:

```ts
import { httpsProbe } from '../core/probe.js';
import type { Target } from '../core/registry.js';
import { siteOf, siteWebsiteById } from './dbcommon.js';
import { persistentAppsGate } from './node.js';
```

Then, before the final `export const tools` line, add:

```ts
/** Convention 12: the target id is `<websiteId>:<appId>`; preview and handler re-read that site
 *  by id and re-check the plan flag, never re-resolving the `website` string. */
async function appTarget(ctx: ToolContext, target: Target): Promise<{ site: ReturnType<typeof siteOf>; w: Website; appId: string; app: ListedApp | undefined }> {
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
  description: "DESTRUCTIVE. Stops a persistent app's process and removes the app and its proxy path; the URL stops answering at once. The app's files in the container are not touched. Requires the user to confirm by typing the website's domain name.",
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
    return `${site.identity}\nThis will stop persistent app ${safe(appId)} (${what}) and remove it from the panel. The URL stops answering immediately; the files in the container stay.`;
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
  description: "Fetches a persistent app's URL the way the web server serves it: HTTPS to the app server's IP with the primary domain as SNI and Host (the curl --resolve equivalent), so it works before DNS points at the site. Reports status, latency, the first bytes of the body, and whether the domain still has the placeholder certificate. Give app_id (from persistent_apps_list) or a proxy_path.",
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
    const summary = kv([['url', url], ['connected to', ip], ['HTTP', `${res.status} in ${res.latencyMs} ms`], ['content-type', res.contentType ?? '-'], ['body (first 512 bytes)', res.body.trim() || '(empty)'], ['tls', certNote]]);
    const structured = { url, ip, status: res.status, latencyMs: res.latencyMs, contentType: res.contentType, body: res.body, certificate: res.certificate, reachable: !gateway && res.status > 0 };
    if (gateway) {
      return fail(`${s.identity}\n${summary}\nthe web server answered but the app is not listening on its port (HTTP ${res.status}): read persistent_app_log for the startup error, and check the command passes PORT to the app.`, structured);
    }
    return ok(`${s.identity}\n${summary}\n${PREVIEW_NOTE}`, structured);
  },
});
```

Change the last line to:

```ts
export const tools: ToolDef[] = [persistentAppsList, persistentAppCreate, persistentAppUpdate, persistentAppDelete, persistentAppLog, persistentAppProbe];
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-apps.test.ts test/unit/probe.test.ts test/unit/registry.test.ts test/unit/gate.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/core/probe.ts src/core/context.ts src/core/registry.ts src/tools/apps.ts test/unit/probe.test.ts test/unit/tools-apps.test.ts
git commit -m "feat(apps): gated persistent_app_delete and in-process persistent_app_probe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Register the groups, smoke count, MCP gate coverage, spec paths

**Files:**
- Modify: `server/src/tools/index.ts`, `server/test/unit/smoke.test.ts`, `server/test/mcp/server.test.ts`, `server/test/unit/spec.test.ts`

**Interfaces:**
- Consumes: `tools` from `node.ts` and `apps.ts`.
- Produces: `allTools` with 82 entries; the MCP destructive case list covering `persistent_app_delete`.

- [ ] **Step 1: Update the smoke test first**

In `server/test/unit/smoke.test.ts` replace the count block with:

```ts
    // 29 milestone A + 13 mysql + 9 postgresql + 9 php + 5 htaccess + 6 cron + 5 node + 6 persistent apps.
    expect(allTools.length).toBe(82);
    expect(names).toEqual(expect.arrayContaining(['db_create', 'php_extensions_list', 'cron_add', 'node_install', 'persistent_app_create', 'persistent_app_probe']));
```

Run: `cd server && npx vitest run test/unit/smoke.test.ts`
Expected: FAIL, `expected 71 to be 82`.

- [ ] **Step 2: Register**

`server/src/tools/index.ts` becomes:

```ts
import type { ToolDef } from '../core/registry.js';
import { tools as account } from './account.js';
import { tools as apps } from './apps.js';
import { tools as cron } from './cron.js';
import { tools as domains } from './domains.js';
import { tools as htaccess } from './htaccess.js';
import { tools as mysql } from './mysql.js';
import { tools as node } from './node.js';
import { tools as php } from './php.js';
import { tools as postgres } from './postgres.js';
import { tools as ssh } from './ssh.js';
import { tools as websites } from './websites.js';

export const allTools: ToolDef[] = [...account, ...websites, ...domains, ...ssh, ...mysql, ...postgres, ...php, ...htaccess, ...cron, ...node, ...apps];
```

Run: `cd server && npx vitest run test/unit/smoke.test.ts test/mcp/server.test.ts`
Expected: smoke PASS; `server.test.ts` FAILS on "drives every registered destructive tool through the cases below" (expected list lacks `persistent_app_delete`).

- [ ] **Step 3: Add the MCP destructive case**

In `server/test/mcp/server.test.ts`, import `APP_ID` and `persistentApps` from `'../fixtures/panel.js'`, add two routes to `destructiveRoutes` (after the crontab DELETE):

```ts
    { method: 'GET', path: `/websites/${WEBSITE_ID}/apps/persistent`, body: persistentApps },
    { method: 'DELETE', path: `/websites/${WEBSITE_ID}/apps/persistent/${APP_ID}`, status: 200 },
```

and one case to `destructiveCases` (after `cron_delete`):

```ts
    { tool: 'persistent_app_delete', args: { website: 'vahi.dev', app_id: APP_ID }, typed: 'vahi.dev', write: { method: 'DELETE', path: `/websites/${WEBSITE_ID}/apps/persistent/${APP_ID}` } },
```

Run: `cd server && npx vitest run test/mcp/server.test.ts`
Expected: PASS, including the never-exposed name guard (none of the eleven names matches `/(^|_)(servers?|settings?|…)/`) and the dangerous-flag guard.

- [ ] **Step 4: Cover the milestone C paths in the spec test**

In `server/test/unit/spec.test.ts` add to the list in "generated types cover the milestone A paths" (rename the test to "…milestone A and C paths"):

```ts
      '"/websites/{website_id}/apps/node/versions/default"',
      '"/websites/{website_id}/apps/persistent/{app_id}"',
```

- [ ] **Step 5: Full suite, build, plugin validate**

Run, from `server/`: `npm run typecheck && npm test 2>&1 | tail -4 && npm run build 2>&1 | tail -1 && cd .. && claude plugin validate . | tail -1`
Expected: all green; the test count is 313 plus the new tests; `✔ Validation passed`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts test/unit/smoke.test.ts test/mcp/server.test.ts test/unit/spec.test.ts
git commit -m "feat: register node and persistent app tools (82), gate coverage for persistent_app_delete

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The Node path in `enhance-deploy`

**Files:**
- Modify: `skills/enhance-deploy/SKILL.md` (step 7 Node bullet, new "Node layout" subsection, step 9 and 10 additions, new "Node runtime" section)

**Interfaces:**
- Consumes: the tool names and argument names from Tasks 2–4, the Task 1 restart finding.
- Produces: the skill text Task 8's walkthrough follows.

- [ ] **Step 1: Replace the step 7 Node bullet**

Find the line beginning `- **Node**: handled by a later milestone;` and replace it with:

```markdown
- **Node**: use the Node layout below. The app runs as a panel-managed **persistent app** behind the reverse proxy; there is no document root involved. Verification differs from static and PHP: a persistent app answers on the **primary domain only**, never on the `*.mystaging.site` preview URL (verified live), so use `persistent_app_probe` until DNS resolves.
```

- [ ] **Step 2: Add the Node layout subsection after the Laravel layout**

Insert immediately after the Laravel layout's closing sentence (`Everything below calls `<home>/app` the **`<app dir>`**.`):

```markdown
#### Node layout (persistent apps)

Stop here if `website_get` shows `canUse.persistentApps: false`: the plan does not run Node processes (safety rule 4).

1. **Runtime.** `node_versions_installed` shows what the panel believes is installed — that list is
   known to lag (verified live), so confirm over SSH with `. ~/.nvm/nvm.sh && nvm ls`. If there is
   no `~/.nvm`, run `node_install` (nvm plus the current stable Node; allow a minute). For the
   version the project wants (`.nvmrc`, `engines.node`, else the current LTS from
   `node_versions_available`): `node_version_install version=<x.y.z>` then
   `node_version_set_default version=<x.y.z>`.
2. **Directory.** The app lives in a named directory in the home, `<home>/<app>` (for example
   `/var/www/<website_id>/nodeapp`), never in `public_html` and never the home root. That
   directory name, relative to the home, is the `working_directory` the panel needs.
3. **Port.** Pick a port in 3000–3999 that `persistent_apps_list` does not already show, and make the
   app read it from `PORT`. The command carries it: `PORT=3000 node server.js`,
   `PORT=3000 npm start`, or for Next.js `PORT=3000 npm start` with `"start": "next start -p $PORT"`
   (or `next start -p 3000`).
4. **Proxy path.** The URL path the web server forwards to the app: `node`, `api`, `app/v2`. No
   leading slash (the panel rejects it; the tool strips one and says so). It must not clash with a
   real directory in `public_html`.

Everything below calls `<home>/<app>` the **`<app dir>`** for Node too.
```

- [ ] **Step 3: Add the Node rsync target to step 8**

In step 8's target bullet (`- Target is the document root, a directory under it, or a named directory in the home (`app/` for the Laravel layout in step 7 …`) append after `Never the home directory root itself.`:

```markdown
 For Node, the target is the `<app dir>` from the Node layout, excluding `.git`, `node_modules`, `.env` and the build output (`.next`, `dist`, `build`): `rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude .next --exclude dist <src>/ <user>@<host>:<app>/`.
```

- [ ] **Step 4: Add the Node post-deploy steps to step 9**

After the Laravel list and before `- WordPress: …`, insert:

```markdown
- **Node**, in this order, all over SSH in the `<app dir>` with nvm loaded (`. ~/.nvm/nvm.sh &&`):
  1. `npm ci --omit=dev` when a lockfile exists, else `npm install --omit=dev`. Frameworks that build with dev dependencies (Next.js, Vite) need `npm ci` without `--omit=dev`, then the build, then optionally `npm prune --omit=dev`.
  2. `npm run build` when `package.json` has a build script. If the build is killed for memory, build locally instead and rsync the output directory up (Next.js: set `output: 'standalone'`), and say so.
  3. Write `.env` on the server (never rsync a local one); include `PORT=<port>` only if the app reads it from the file rather than the command.
  4. Register the app: `persistent_app_create website=<site> command="PORT=<port> npm start" working_directory=<app> proxy_path=<path> port=<port>` (`allow_websocket=true` for Socket.IO and similar; `node_version=<x.y.z>` when the project pins one). Note the `id` it returns.
  5. `persistent_app_log app_id=<id>` until it shows the listening line. A crash shows here first; fix it before touching the proxy.
  6. For a later deploy: rsync again, rebuild, then restart — <RESTART_SENTENCE> `persistent_app_update` is for changing the command, port, path or Node version.
```

Replace `<RESTART_SENTENCE>` with the same sentence chosen in Task 3 Step 4 (the Task 1 question 2 finding).

- [ ] **Step 5: Add Node verification to step 10**

After the first bullet of step 10 (the `curl` of a deployed file), insert:

```markdown
- **Node**: `persistent_app_probe website=<site> app_id=<id>` — it connects to the app server's IP with the domain as SNI, so it works before DNS. `HTTP 200` with the app's body means the proxy and the process are up; `502`/`503` means the web server is fine and the app is not listening on its port (read `persistent_app_log`, check the command passes `PORT`). Once DNS resolves, `curl https://<primary domain>/<path>/`. The preview URL returns 404 for the app path; that is expected, not a failure.
```

- [ ] **Step 6: Add the "Node runtime" section**

After the "PHP settings and cron" section (before "Access control and rewrites"), add:

```markdown
## Node runtime

- **Versions**: `node_versions_available` (newest of each major in the text, all in `structuredContent.versions`), `node_version_install`, `node_version_set_default`. `node_versions_installed` is a hint only; `nvm ls` over SSH is the truth.
- **Apps**: `persistent_apps_list` shows every app with its URL. `persistent_app_log` is the first thing to read when an app misbehaves. `persistent_app_update` changes command, port, path, WebSocket flag or Node version; `clear_proxy=true` takes an app off the web without stopping it.
- **`persistent_app_delete`** is destructive: it stops the process and removes the proxy at once, and the user types the website's domain name to confirm. The app's files and its `persistent_app_<id>.log` stay in the home directory.
- **Ports and paths**: one app per port; a proxy path that collides with a directory in `public_html` is the app's, not PHP's, so pick paths that do not exist in the docroot.
```

- [ ] **Step 7: Validate**

Run: `cd /Users/vahid/Documents/project_4_enhance_mcp && claude plugin validate . | tail -1 && grep -c "persistent_app_probe" skills/enhance-deploy/SKILL.md`
Expected: `✔ Validation passed` and a count of at least 3.

- [ ] **Step 8: Commit**

```bash
git add skills/enhance-deploy/SKILL.md
git commit -m "docs(skill): Node path in enhance-deploy — runtime, layout, persistent app, probe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Live e2e harness for milestone C

**Files:**
- Create: `server/test/e2e/milestone-c.e2e.test.ts`
- Modify: `server/.env.example` (one comment line)

**Interfaces:**
- Consumes: the registered tools from Task 5 via `bootstrap`.
- Produces: an opt-in suite, `ENHANCE_E2E=1 ENHANCE_E2E_SITE=vahi.dev`, that leaves the panel clean.

- [ ] **Step 1: Write the suite**

```ts
// server/test/e2e/milestone-c.e2e.test.ts
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
  let site: string;
  // A path and port no real app uses: `mcpc-<5 hex>` and a port in 3900–3999 from the same bytes.
  const slug = `mcpc-${randomBytes(3).toString('hex').slice(0, 5)}`;
  const port = 3900 + (randomBytes(1)[0]! % 100);
  const marker = `mcp-c ok ${slug}`;
  // No files to upload: the whole app is one inline Node script that echoes the marker.
  const command = `PORT=${port} node -e "require('http').createServer((q,s)=>s.end('${marker}')).listen(process.env.PORT)"`;
  let appId: string | undefined;

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

  it('the Node runtime tools answer and the installed list is labelled as the panel\'s', async () => {
    const avail = await call(tool(tools, 'node_versions_available'), { website: site });
    expect(avail.isError, avail.text).toBeFalsy();
    const versions = (avail.structured as { versions: string[] }).versions;
    expect(versions.length).toBeGreaterThan(10);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = await call(tool(tools, 'node_versions_installed'), { website: site });
    expect(installed.isError, installed.text).toBeFalsy();
    expect(installed.text).toContain('as reported by the panel');
    // If the container has no nvm yet, install it and give the panel a minute. Later runs skip this.
    if ((installed.structured as { versions: string[] }).versions.length === 0) {
      const inst = await call(tool(tools, 'node_install'), { website: site });
      expect(inst.isError, inst.text).toBeFalsy();
      await sleep(60_000);
    }
  }, 150_000);

  it('creates an inline app, sees it listening in the log, probes it on the domain, updates it, and deletes it through the gate', async () => {
    const created = await call(tool(tools, 'persistent_app_create'), { website: site, command, working_directory: undefined, proxy_path: slug, port });
    expect(created.isError, created.text).toBeFalsy();
    appId = (created.structured as { id: string | null }).id ?? undefined;
    if (!appId) {
      // The listing lagged the create; find it by our unique command.
      const list = await call(tool(tools, 'persistent_apps_list'), { website: site });
      appId = (list.structured as { items: Array<{ id: string; command: string }> }).items.find((a) => a.command === command)?.id;
    }
    expect(appId, 'persistent_app_create did not yield an app id').toBeTruthy();

    // The panel starts it asynchronously: poll the probe for up to 60 s.
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
    const list = await call(tool(tools, 'persistent_apps_list'), { website: site });
    const mine = (list.structured as { items: Array<{ id: string; proxy: { websocket: boolean } | null }> }).items.find((a) => a.id === appId);
    expect(mine?.proxy?.websocket).toBe(true);

    const del = tool(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: site, app_id: appId });
    const target = await del.target!(args, ctx);
    expect(target.name).toBe(site);
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(slug);
    const r = await del.handler(args, ctx, target);
    expect(r.isError, r.text).toBeFalsy();
    expect(await listedIds()).not.toContain(appId);
  }, 150_000);
});
```

- [ ] **Step 2: Skip-mode run and typecheck**

Run: `cd server && npx vitest run --config vitest.e2e.config.ts test/e2e/milestone-c.e2e.test.ts && npm run typecheck`
Expected: `2 skipped`, typecheck clean.

- [ ] **Step 3: Live run (needs a fresh cookie in `../.env`)**

Run, from `server/`:
```bash
set -a && source ../.env && set +a && ENHANCE_TOKEN="${ENHANCE_TOKEN:-$ENHANCE_SESSION_COOKIE}" ENHANCE_E2E=1 ENHANCE_E2E_SITE=vahi.dev npx vitest run --config vitest.e2e.config.ts test/e2e/milestone-c.e2e.test.ts
```
Expected: `2 passed`. Then confirm the panel is clean: `persistent_apps_list` on vahi.dev shows nothing (the `demo-login/` PHP page and static site are untouched: `curl -sS -o /dev/null -w '%{http_code}\n' https://vahi.dev/demo-login/` → 200). If the suite fails, fix the tool (not the test) and re-run; record any live finding in `docs/research.md`.

- [ ] **Step 4: Note the env variable**

In `server/.env.example` add, next to the existing `ENHANCE_E2E_SITE` line:
```
# Milestone C live suite also uses ENHANCE_E2E_SITE; it creates one throwaway mcpc-… persistent app (needs nvm in the container; installs it on first run).
```

- [ ] **Step 5: Commit**

```bash
git add test/e2e/milestone-c.e2e.test.ts .env.example
git commit -m "test(e2e): live Node runtime and persistent app round trip for milestone C

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Docs, status, and the walkthrough

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/research.md`

- [ ] **Step 1: README**

- Line 3: change `71 typed, safety-gated tools` to `82 typed, safety-gated tools`.
- In the Status section, replace the paragraph beginning `Next: Node.js and persistent apps (milestone C)` with:

```markdown
Milestone C (Node.js via nvm and panel-managed persistent apps: install and pin Node versions, register an app behind the reverse proxy, read its log, probe it on the domain before DNS, delete it through the typed-name gate, plus the Node path in the deploy skill) is merged and verified live: the milestone C end-to-end suite and an Express and a Next.js walkthrough on vahi.dev (see "Live test C" in `docs/research.md`).

Next: email, backups, DNS zone editing, WordPress, staging and the other deploy modes (milestone D). OAuth support lands as soon as the panel offers it.
```

- In the capabilities bullet list near the top (the `- **…**` lines), add after the database bullet:

```markdown
- **Node apps.** Install Node with nvm, register a persistent app with its proxy path and port, watch its log, and verify it on the domain with an in-process probe. Apps answer on the primary domain, not the preview URL.
```

- [ ] **Step 2: CLAUDE.md**

Update the status block: heading date to the day of the run; the phase sentence to `milestone C COMPLETE and LIVE-VERIFIED on branch feat/milestone-c (…)`; `71 tools are registered (a client lists 72 …)` to `82 tools are registered (a client lists 83 with confirm_action)`; the live-suite command line to name `milestone-c.e2e.test.ts` as well; the "Remaining" sentence to milestone D. Keep everything else.

- [ ] **Step 3: Walkthrough with the user (Express, then Next.js, on vahi.dev)**

Follow `skills/enhance-deploy/SKILL.md` exactly, through the installed plugin in Claude Code, with ssh/rsync unsandboxed and the key `~/.ssh/enhance_vahi_dev_ed25519`:

1. Express: scaffold in the session scratchpad — `package.json` with `"start": "node server.js"` and `express` as the dependency, `server.js` = `const app = require('express')(); app.get('/', (q, r) => r.json({ ok: true, node: process.version, pid: process.pid })); app.listen(process.env.PORT);`. Deploy to `<home>/express`, `npm ci --omit=dev` over SSH, `persistent_app_create command="PORT=3001 npm start" working_directory=express proxy_path=express port=3001`, `persistent_app_log`, `persistent_app_probe`, then `curl https://vahi.dev/express/` → the JSON.
2. Next.js: `npx create-next-app@latest nextwalk --ts --app --no-eslint --no-tailwind --use-npm --yes` in the scratchpad; deploy to `<home>/nextwalk` excluding `node_modules` and `.next`; over SSH `npm ci` then `npm run build`; `persistent_app_create command="PORT=3002 npm start" working_directory=nextwalk proxy_path=next port=3002` — note Next.js serves under `/` by default, so set `basePath: '/next'` in `next.config.ts` before the build; probe, then `curl https://vahi.dev/next/` → 200 with the welcome page.
3. Restart per the Task 1 finding, and confirm both apps answer again (`pid` changes for Express).
4. `persistent_app_delete` for both inside Claude Code: the typed prompt appears, a mistyped domain cancels, `vahi.dev` deletes. Remove `<home>/express`, `<home>/nextwalk` and the two `persistent_app_*.log` files over SSH. Leave nvm installed.
5. Record in `docs/research.md` under a new `## Live test C: Node runtime and persistent apps on vahi.dev (<date>)` section: the e2e result, both walkthrough URLs and their HTTP codes, the restart behaviour as seen, build time and memory for `next build` in the container, and every tool or skill fix the walkthrough forced (make those fixes in their own commits, with tests).

- [ ] **Step 4: Full verification, then commit**

Run, from `server/`: `npm run typecheck && npm test 2>&1 | tail -4 && npm run build 2>&1 | tail -1 && cd .. && claude plugin validate . | tail -1`
Expected: all green.

```bash
git add README.md CLAUDE.md docs/research.md
git commit -m "docs: milestone C status, Node tools in README, live test C findings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then `superpowers:finishing-a-development-branch` for `feat/milestone-c` (push, PR, CI, merge), and refresh the installed plugin copy with `claude plugin uninstall enhance@enhance-mcp && claude plugin install enhance@enhance-mcp` followed by removing the copied `.env` from `~/.claude/plugins/cache/enhance-mcp/enhance/0.1.0/`.

---

## Self-review against the spec

- §2 decisions: Task 0 (re-vendor), Task 7/8 (vahi.dev), thin tools + probe (Tasks 2–4, no composite tool). ✔
- §3 table: all eleven tools present with the stated risk classes and files; the count moves to 82 (Task 5). ✔
- §3.1: gate on every Node tool (the plan gates the reads too, which is stricter than the spec's "the two Node writes" and harmless); "as reported by the panel" label; bare-string bodies; semver and selector validation. ✔
- §3.2: create validation (absolute working dir, `..`, proxy path shape, one leading slash stripped with a note, port required with a path, defaults), the 201-without-body handling via the listing, update with `Unset` flags and proxy merge, delete typed on the domain with the log-file note, log capped at 64 KB, probe with SNI/Host to the IP, 5 s, 512 bytes, certificate classification, `502/503/504` as "not listening". ✔
- §3.4 restart: settled in Task 1, quoted in Task 3 and Task 6 through the three fixed sentences. ✔
- §4 skill: runtime, directory, port, path, rsync target, post-deploy order, verify, later changes, "Node runtime" section. ✔
- §5 testing: unit files for both groups plus `probe.test.ts`, smoke 82, MCP destructive case, e2e with the inline `node -e` server and guarded cleanup, walkthrough with Express and Next.js and the typed prompt. ✔
- §6 delivery order matches Tasks 0–8. ✔
- §7 open questions: all six probed in Task 1 Steps 2–6. ✔
- Placeholder scan: the only bracketed items are the Task 0/1 recording templates (filled from observations at run time) and the two sentence choices in Tasks 2, 3 and 6, each with every candidate sentence written out. No "TBD"/"TODO".
- Type consistency: `appsSite(ctx, website, feature?)` (Task 2) is what Task 3/4 call; `findApp`, `listApps`, `appUrl`, `validateProxyPath`, `validateWorkingDirectory` are defined in Task 3 and reused in Task 4; `ProbeRequest` fields `{ ip, host, path, timeoutMs, maxBodyBytes }` match between `probe.ts`, the tool and the test; `Target.kind 'persistent_app'` added in Task 4 before its first use; fixtures `APP_ID`/`persistentApps` added in Task 3 before Task 5's import.
