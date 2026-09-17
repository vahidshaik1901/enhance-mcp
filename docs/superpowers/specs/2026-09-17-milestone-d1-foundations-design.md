# Milestone D1: foundations and the file listing — design

Date: 2026-09-17. Status: approved in brainstorming by the product owner, awaiting spec review.
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

### 3.2 Adopters and their verify reads

| Tool | Verify read | Window |
|---|---|---|
| `website_create` | `POST /orgs/{org}/domains/check` → `inUseCurrentOrg` with a `websiteId`, then the resolver's `getWebsite` | 90 s (the panel keeps working after the client's 30 s cut-off; seen live with parallel creates) |
| `domain_add` | the website's domain listing contains the domain | default |
| `db_create`, `pg_db_create` | the database listing contains the prefixed name | default |
| `db_user_create`, `pg_user_create` | the user listing contains the prefixed name. The password the tool sent is still returned once when `verify` confirms the create | default |
| `ssh_key_add` | the key listing contains the same key body | default |
| `cron_add` | the crontab read contains the added line | default |
| `persistent_app_create` | the existing listing match (path, command, port), refactored onto the helper; behaviour unchanged | default |

Each create already refuses up front when the object exists (or the panel answers 409), so an
object found by `verify` after an unclear write is the one this call created.

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

### 5.2 `core/files.ts`

`listSiteFiles(ctx, site, { maxDepth })` → a flat list of `{ path, kind: 'file'|'dir', size, modified, mode }`.

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
| `path` | `public_html` | relative to the site home; no leading `/`, no `..`, no empty segments; `""` lists the home |
| `depth` | 2 | 1–6 levels below `path` |
| `max_entries` | 500 | 1–2000 |
| `include_heavy` | false | when false, the contents of `node_modules`, `vendor`, `.git`, `.cache`, `.npm` and `.nvm` are not listed; the folder is shown once with "(contents skipped)" |

The tool asks the service for `segments(path) + depth` levels, at most 8; when the sum is larger it
lists fewer levels below `path` and says how many. It then narrows to `path`,
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

- a directory or file exists at `public_html/<path>`: what it is and how many entries it holds;
- nothing on disk: that the answer comes from the web server (a rewrite rule, a redirect-everything
  site or another app), so `replace_existing_path=true` shadows no files.

For `serve_at_root` the line gives the entry count of `public_html`. Any `FileServiceUnavailable`
adds nothing. The decision to refuse stays with the HTTP preflight, exactly as today.

## 6. Minors sweep

One task, no behaviour change beyond what is listed:

- the deferred minors in `.superpowers/sdd/milestone-c-minors.md` that are still true at `main`,
  and the four from the last re-review (`attempted` JSDoc wording, `MAX_ASSETS` exported and used
  in prose, `mapLimit(Infinity)`, stale wording);
- tool descriptions over about 700 characters trimmed, keeping every safety statement;
- `persistent_app_delete`'s preview names the other apps that stay on the site;
- `dbTargetSite`'s error text no longer says "database target" for app targets.

## 7. Skills and docs

- `enhance-deploy`: look before a deploy (`files_list` on the target folder) and confirm after it
  (the uploaded files are there, with today's modified time); the fallback is `ls` over SSH.
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

## 9. Delivery

Subagent-driven development, every subagent on Opus, one reviewer per task, ledger in
`.superpowers/sdd/progress.md`. About eight tasks: helper; adopters (two tasks); probe move;
`core/files.ts`; `files_list`; clash-guard line plus minors; skills, docs, e2e and walkthrough.
Then the whole-branch review, PR, CI, merge, and a plugin refresh.

## 10. Out of scope

Reading, writing or deleting files through the file service; any change to updates and deletes;
per-request timeouts in the API client; everything in D2–D6.
