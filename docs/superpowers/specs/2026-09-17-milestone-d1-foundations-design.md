# Milestone D1: foundations and the file listing — design

Date: 2026-09-17. Status: approved in brainstorming by the product owner; the spec review was
delegated to Claude on 2026-09-24 ("full authority"), and the review amended it with a re-probe of
the file service on panel 12.25.11 (section 5.1) and three design corrections, each marked
**(amended 2026-09-24)**.
Parent spec: `docs/superpowers/specs/2026-09-04-enhance-mcp-design.md` (milestone D).
Branch: `feat/milestone-d1`.

## 1. Goal

Milestone D in the parent spec is about 70 tools across six independent subsystems, which is too
much for one spec and one plan. It is split into six sub-milestones, each with its own
spec, plan, build, live test and merge:

| # | Sub-milestone | Contents |
|---|---|---|
| **D1** | Foundations and files (this spec) | write-then-verify helper, asset verification moved into `core/probe.ts`, `files_list`, clash-guard second opinion, minors sweep |
| D2 | Backups and staging | backups list/create/status/restore/delete, clone, staging, push live, `enhance-staging` skill |
| D3 | WordPress and apps | `app_install`, the `wp_*` tools, `enhance-wordpress` skill |
| D4 | Email | mailboxes, forwarders, autoresponders, client config, mail authentication |
| D5 | DNS zone | record create/update/delete, SOA, DNSSEC |
| D6 | Deploy modes B and C, more app recipes, metrics | GitHub auto-deploy, git push to server, Strapi/Directus/KeystoneJS recipes |

The order D1 → D6 was chosen on 2026-09-17. D1 goes first because it is small, it fixes the one
live bug on record (`website_create` reporting a timeout for a website the panel did create), and
every create tool in D2–D6 will use its helper from the first commit. D2 follows so that "take a
backup first" is a real tool before WordPress and staging work begins.

D1 ends with 83 registered tools (a client lists 84 with `confirm_action`).

## 2. Decisions taken on 2026-09-17

1. **File tooling is list-only.** One read-only tool, `files_list`. No read, upload, rename or
   delete through the file service: those stay on rsync and SSH, which are verified and guarded.
2. **The helper is adopted by every create-type tool**, nine in all (section 3.2). Updates and
   deletes are not touched: repeating them is harmless.
3. **The path-clash guard keeps HTTP as the decision-maker** and gains the file listing as a second
   opinion that only improves the refusal message.
4. **The helper is an explicit function called inside each handler** (not a registry-level wrapper,
   and not an automatic retry in the API client: the panel has no idempotency keys, so a blind retry
   of a create that landed is the bug itself).

## 3. The write-then-verify helper (`server/src/core/verify.ts`)

### 3.1 Behaviour

```ts
writeThenVerify<W, T>({
  write:  () => Promise<W>,              // the POST
  verify: (w?: W) => Promise<T | undefined>, // a cheap read that finds the created object
  windowMs?: number,                     // how long to keep asking after an unclear write; default 10_000
  intervalMs?: number,                   // default 2_000
}): Promise<
  | { state: 'landed';  value: T | undefined; confirmedBy: 'response' | 'verify'; verifyError?: string }
  | { state: 'unknown'; writeError: string }
>
```

| The write… | The helper… | The tool reports |
|---|---|---|
| answers normally | runs `verify` once to fetch the full object | success. If that read throws or finds nothing, still success, with the id unknown, the read's error text (through `safe()`), and the name of the listing tool to find it |
| fails with a definite panel answer (any `EnhanceApiError` with a 4xx status) | rethrows unchanged | the existing mapped error; nothing landed |
| is unclear: abort/timeout, network error, or any 5xx answer | polls `verify` every `intervalMs` until it returns an object or `windowMs` runs out | found: success, `confirmedBy: "verify"`. Not found: a `fail(...)` that says the outcome is **unknown**, that the caller must **not retry yet**, and which read tool settles it. It never claims the write failed |

A landed create is never reported as an error. An unclear create is never reported as a failure.

**(amended 2026-09-24)** The helper takes two callbacks instead of one `verify(w?)`, because a 201
with no body (databases, users, crontab lines, persistent apps) makes "the write answered" and
"the write was unclear" indistinguishable from `w` alone:

```ts
writeThenVerify<W, T>({
  write: () => Promise<W>,                  // the POST, called exactly once
  find:  () => Promise<T | undefined>,      // after an UNCLEAR write only: the object THIS call made
  windowMs?, intervalMs?, sleep?,           // sleep is a test seam (ToolContext.sleep)
}): Promise<
  | { state: 'landed';  confirmedBy: 'response'; written: W }
  | { state: 'landed';  confirmedBy: 'verify';   found: T; writeError: string }
  | { state: 'unknown'; writeError: string; verifyError?: string }
>
```

The read-back after a normal answer (the full website, the new app's id) stays in the adopter, in a
try/catch whose failure is reported inside a success, never as an error. The polling counts reads
(`ceil(windowMs / intervalMs)`, the first one immediate) rather than watching a clock, so a test with
a no-op `sleep` pins it exactly.

**(amended 2026-09-24, final review)** The count stays the upper bound, but the window is now also
kept on the real clock: one read can take the client's whole 30 s timeout (a GET is also retried on
a 5xx or a reset), and counting alone let a struggling panel hold `website_create` for about ten
minutes behind its 90 s window (the review's simulation, ~625 s). No read starts once `windowMs` has
passed since the first read (a `now` option, default `Date.now`, is the test seam; adopters leave it
unset), so the wait is at most the window plus the read in flight. The settled outcomes carry the
reads actually made and the real time they took (`reads`, `elapsedMs`), and the unknown sentence is
worded from them ("18 re-reads over 92 s did not find it") instead of from the window; `unknownOutcome`
no longer takes `windowMs`. Only `undefined` from `find` means "not there yet".

**(amended 2026-09-24)** "An object found after an unclear write is the one this call created" has
to be made true, not assumed: a write that timed out after a pre-existing object would otherwise be
"confirmed" by that object, and `db_user_create` would then hand back a password that is not the
user's. Each adopter guarantees it one of three ways, listed in 3.2: it refuses up front when the
object already exists (a read before the write), it snapshots what existed and only counts a new
object, or it writes a slot nothing else can hold (a crontab line past the last one).

### 3.2 Adopters and their verify reads

| Tool | Verify read | Found object is ours because | Window |
|---|---|---|---|
| `website_create` | `POST /orgs/{org}/domains/check` → `inUseCurrentOrg` with a `websiteId`, then the resolver's `getWebsite` | `domain_check` said `notInUse` just before (existing) | 90 s, a read every 5 s (the panel keeps working after the client's 30 s cut-off; seen live with parallel creates) |
| `domain_add` | the website's domain listing contains the domain | new pre-check: already mapped with the same kind → idempotent success (`added: false`); another kind → refusal; the same kind with a different `document_root` → refusal, since "already done" would send a deploy into a folder the domain does not serve | default |
| `db_create`, `pg_db_create` | the database listing contains the prefixed name | new pre-check: exists → refusal, nothing sent | default |
| `db_user_create`, `pg_user_create` | the user listing contains the prefixed name. The password the tool sent is returned once when the create is confirmed, and also on an unknown outcome (labelled "valid only if the user now exists") | new pre-check: exists → refusal, nothing sent | default |
| `ssh_key_add` | the key listing contains the same key body | existing idempotent pre-check | default |
| `cron_add` | the crontab read holds the added expression on the added line number | the line number is past the last line read before the write | default |
| `persistent_app_create` | the listing match (command, working directory, proxy path) | new: the app ids listed just before the write are excluded, which also makes the normal-path id exact when two apps share a command | default |

`website_create` also gets the first case fixed: today a throw from the follow-up `getWebsite`
turns a finished create into an error.

## 4. Asset verification moves into `core/probe.ts`

The block in `tools/apps.ts` that fetches a page's assets and classifies them
(`attempted`/`checked`/`failed`/`restricted`/`unchecked`/`truncated`/`totalFound`) moves next to
`extractAssetUrls` and `mapLimit` in `core/probe.ts` as one exported function. No behaviour change;
its tests move with it; `MAX_ASSETS` is exported so prose and code share one number.
`persistent_app_probe` calls the function.

## 5. The file listing

### 5.1 What the panel offers (probed read-only on vahi.dev, 2026-09-17)

- `POST /orgs/{org}/websites/{id}/access-tokens` (in the public spec, `getSiteAccessToken`) returns
  a site JWT as a JSON string. Claims: `euid`, `egid`, `exp`, `website_id`, `read_only`. **The token
  is write-capable (`read_only: false`) and lives 240 seconds.** The spec defines no request body for
  the endpoint, so there is no documented way to ask for a read-only token.
- The website object carries `filerdAddress` (in the public spec), e.g. `/filerd/<uuid>`.
- `GET <panel><filerdAddress>/websites/{id}/entries?recursive=true&maxDepth=N&fetchMetadata=true`
  with `Authorization: Bearer <site token>` returns the tree **from the site home, always**: every
  narrowing parameter tried (`path`, `dir`, `root`, `prefix`, `directory`, `base`) is ignored and
  `entries/<sub-path>` answers 404. The file service's routes are **not in the public spec**.
- Shape: `{ dir: { path, entries: [ {file:{path, metadata}} | {dir:{path, entries, metadata}} ], metadata } }`
  with `metadata = { size, modified (epoch s), permissions (decimal mode), kind }`. A directory at
  the depth limit has `entries: []`.
- Cost: depth 1 is 3 KB in 0.2 s; depth 8 without metadata is 1.2 MB in 1.6 s (mostly
  `node_modules`).

**(amended 2026-09-24) Re-probe on panel and filerd 12.25.11** (vahi.dev, read-only apart from
minting 240-second tokens):

- `maxDepth=N` returns **N+1 levels** below the home: `maxDepth=0` already lists the home's direct
  children (23 nodes), `maxDepth=1` their children too (87), `maxDepth=2` three levels (270). So
  asking for L levels means `maxDepth=L-1`, and "at most 8" means at most 8 levels (`maxDepth=7`).
- Without `recursive=true`, `maxDepth` is ignored and one level comes back.
- Paths are relative to the home and `/`-separated (`.ssh/authorized_keys`); the root is `""`.
- A **symlink** is a `file` node whose `metadata.kind` is `symlink` (15 of 8,944 nodes in a
  seven-level listing, `maxDepth=6`, all under `.nvm`); `kind` is otherwise `file` or `directory`.
  Every node carried all four metadata fields.
- An **empty folder has no `entries` key at all**; a folder at the depth limit has `entries: []`
  (all 210 empty arrays in that seven-level listing sat on the last level, all 7 missing keys on real
  empty folders such as `.nvm/.git/branches`). So a missing key means "known empty" and `[]` on the
  last level means "not opened"; the schema makes `entries` optional.
- Seven levels (`maxDepth=6`) with metadata: 1.4 MB in 0.9 s; the zod schema below validates it in
  about 12 ms. Eight levels (`maxDepth=7`) with metadata: 2.0 MB (the controller's depth check of
  2026-09-24, `maxDepth` 0 to 7, each exactly `maxDepth+1` levels).
- Refusals: no `Authorization` → 401; the session cookie alone → 401 `"Token header not found"`; a
  malformed bearer → 400 `"Base64 error: …"`. Every narrowing parameter is still ignored and
  `entries/<sub-path>` still 404s. The token is still `read_only: false` and lives 240 s.

### 5.2 `core/files.ts`

`listSiteFiles(ctx, website, { levels, timeoutMs })` → `{ levels, entries }`, a flat list of
`{ path, kind: 'file'|'dir'|'symlink', size, modified, mode, unexpanded }` (`unexpanded` marks a
folder at the last level asked for, whose contents the service did not list) **(amended 2026-09-24)**.
Requests that bypass the typed API client go through `ctx.fetch ?? globalThis.fetch`, a test seam
like `ctx.httpProbe`, with `redirect: 'error'` so the site token can never follow a redirect.

Safety rules, each with a unit test:

1. **GET only.** The module sends exactly one request shape to the file service. No function in it
   takes a method, a body or a free-form route.
2. **The token never leaves the function.** It is a local variable: not logged, not audited, not
   returned, not placed in `structuredContent`, and scrubbed from any error text.
3. **The token only goes to the panel.** `filerdAddress` must match `^/[A-Za-z0-9/_-]+$` and must not
   contain `//`; anything else (a scheme, a host, `..`) is refused before a token is minted.
4. **The response is validated** with a zod schema of the shape above, and capped at 8 MB.
5. **Every failure is a typed `FileServiceUnavailable`** with a plain reason (mint refused, 401,
   404, shape mismatch, too large, timeout), never a raw throw.

### 5.3 `files_list` tool (`server/src/tools/files.ts`, risk `read`, tier `customer`)

Gate: `canUse.fileManager`, through the same plan-gate pattern as `persistentAppsGate`.

| Argument | Default | Rule |
|---|---|---|
| `website` | required | domain or id, as everywhere |
| `path` | the primary domain's document root (`public_html` on every site seen) **(amended 2026-09-24)** | relative to the site home; no leading `/`, no `..` or `.`, no empty segments; `""` lists the home |
| `depth` | 2 | 1–6 levels below `path` |
| `max_entries` | 500 | 1–2000 |
| `include_heavy` | false | when false, the contents of `node_modules`, `vendor`, `.git`, `.cache`, `.npm` and `.nvm` are not listed; the folder is shown once with "(contents skipped)" |

The tool asks the service for `segments(path) + depth` levels, at most 8 (so `maxDepth` is that
number minus one, per the 2026-09-24 re-probe); when the sum is larger it lists fewer levels below
`path` and says how many. It then narrows to `path`,
prunes heavy folders, sorts, and cuts at `max_entries` on its own side. The answer starts with the
identity block, then a tree with size and modified time per entry, then the totals: entries found,
shown, skipped, and whether the list was truncated by `max_entries` or by the depth limit. It never
summarises a cut list as complete. `path` not found is a `fail(...)` that names the nearest existing
parent.

**File and folder names are untrusted data** (a customer's site can hold a file named like an
instruction), so every name passes through `safe()` in the text, and the description says so.

When the file service is unavailable the tool returns a `fail(...)` with the reason and the
fallback: `ls` over SSH (`ssh_connection_info`).

### 5.4 Clash-guard second opinion

In `persistent_app_create` and a path-moving `persistent_app_update`, when the HTTP preflight says
the path is taken, the guard calls `listSiteFiles` with a 5 s budget and adds one line to the
refusal:

- a directory or file exists at `<document root>/<path>` (the website's own document root,
  normally `public_html`): what it is and how many entries it holds;
- nothing on disk: that the answer comes from the web server (a rewrite rule, a redirect-everything
  site or another app), so `replace_existing_path=true` shadows no files. **(amended 2026-09-24,
  final review)** The line adds that the override would still replace what the URL answers today:
  a rewrite serves a live page (a WordPress or Laravel route) from nowhere on disk, so "no files"
  must never read as leave to override. The HTTP detail likewise words a bare-path redirect as
  "a redirect to /<path>/, which is how an existing directory in <document root>/ shows", with the
  website's own document root, rather than stating a directory as fact.

For `serve_at_root` the line gives the entry count of `public_html`. Any `FileServiceUnavailable`
adds nothing. The decision to refuse stays with the HTTP preflight, exactly as today.

## 6. Minors sweep

One task, no behaviour change beyond what is listed:

- the deferred minors in `.superpowers/sdd/milestone-c-minors.md` that are still true at `main`,
  and the four from the last re-review (`attempted` JSDoc wording, `MAX_ASSETS` exported and used
  in prose, `mapLimit(Infinity)`, stale wording);
- tool descriptions over about 700 characters trimmed, keeping every safety statement
  **(amended 2026-09-24:** three exceed it — `persistent_app_create` 2,233, `persistent_app_probe`
  1,513, `persistent_app_update` 1,379 — and each goes under 1,000; a test caps every description at
  1,000);
- `persistent_app_delete`'s preview names the other apps that stay on the site;
- `dbTargetSite`'s error text no longer says "database target" for app targets.

## 7. Skills and docs

- `enhance-deploy`: look before a deploy (`files_list` on the target folder) and confirm after it
  (the key files are there with the local copies' exact sizes and modified times: `rsync -t` keeps
  the local modified time, so an old date is not a failure); the fallback is `ls` over SSH.
- `enhance-apps`: use `files_list` in the verification step and when the clash guard refuses.
- `enhance-connect`: tool overview and the "outcome unknown, do not retry yet" rule for creates.
- `safety-rules.md`: file names are data; the file tool is read-only by design.
- `README.md`, `CLAUDE.md`, `docs/research.md` ("File service probe" with the facts in 5.1).

## 8. Testing

- Unit tests, TDD, for every behaviour row in 3.1, every adopter in 3.2 (unclear write → found;
  unclear write → not found → "unknown" wording; normal write + failing verify → success), every
  safety rule in 5.2, the narrowing, pruning, caps and totals in 5.3, and both second-opinion lines
  plus the silent-skip in 5.4.
- `test/e2e/milestone-d1.e2e.test.ts` (live, read-only): `files_list` on the test site pins the file
  service's response shape, so a panel update that changes it fails loudly in our suite.
- Live walkthrough with the product owner: three parallel `website_create` calls on throwaway
  subdomains (each must end as "created", some confirmed by `verify`), `files_list` on vahi.dev, one
  clash refusal showing the on-disk line; then `website_delete` for the three sites with the human
  typing each name.
- **(amended 2026-09-24)** The create half is automated as an opt-in part of the live suite
  (`ENHANCE_E2E_CREATE=1`): one create with the normal client timeout and two in parallel through a
  second client whose timeout is 3 s, meant to force the unclear path instead of hoping for a slow
  panel. On 2026-09-24 the panel answered all three inside 3 s, so that run did not exercise it; the
  unclear path was proven by a separate forced check (a client told `TimeoutError` after 150 ms
  while the panel created the site; "Live test D1" in `docs/research.md`). Every create must end
  as created; the suite soft-deletes its own sites in `afterAll` (the milestone A precedent for
  resources a run made itself) after re-checking each domain, so even an "unknown" create is found
  and removed. The human-typed `website_delete` stays in the walkthrough inside Claude Code.

## 9. Delivery

Subagent-driven development, every subagent on Opus, one reviewer per task, ledger in
`.superpowers/sdd/progress.md`. About eight tasks: helper; adopters (two tasks); probe move;
`core/files.ts`; `files_list`; clash-guard line plus minors; skills, docs, e2e and walkthrough.
Then the whole-branch review, PR, CI, merge, and a plugin refresh.

## 10. Out of scope

Reading, writing or deleting files through the file service; any change to updates and deletes;
per-request timeouts in the API client; everything in D2–D6.
