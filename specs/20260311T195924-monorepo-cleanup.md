# Monorepo Structure Cleanup

Three sequential PRs to clean up dead/misplaced packages in the monorepo. Each PR is committed and pushed before starting the next.

---

## PR 1: Remove dead `packages/config/` + add README to `apps/fs-explorer/`

**Branch:** `chore/remove-config-clarify-fs-explorer`

### Context

- `packages/config/` previously housed ESLint and Prettier configs. Biome replaced them. The package now has `"exports": {}`, `"scripts": {}`, no `src/` directory. Its own README confirms it's dead.
- 4 packages still list `@epicenter/config` as a devDependency (dead references): `apps/epicenter`, `apps/whispering`, `packages/ui`, `apps/posthog-reverse-proxy`.
- `apps/fs-explorer/` has no README and its purpose is unclear to anyone reading the tree. It's a SvelteKit UI for visualizing the `@epicenter/filesystem` package.

### Todo

- [x] Delete `packages/config/` entirely
- [x] Remove `"@epicenter/config": "workspace:*"` from `apps/epicenter/package.json`
- [x] Remove `"@epicenter/config": "workspace:*"` from `apps/whispering/package.json`
- [x] Remove `"@epicenter/config": "workspace:*"` from `packages/ui/package.json`
- [x] Remove `"@epicenter/config": "workspace:*"` from `apps/posthog-reverse-proxy/package.json`
- [x] Add a README.md to `apps/fs-explorer/` explaining it's a dev UI for `@epicenter/filesystem`
- [x] Run `bun install` to update lockfile
- [x] Verify no typecheck regressions (the config package exported nothing, so there shouldn't be any)
- [x] Commit, push, open PR

### Verification

- `grep -r "@epicenter/config" --include="package.json"` returns zero results
- `packages/config/` no longer exists
- `apps/fs-explorer/README.md` exists and describes the app's purpose

---

## PR 2: Remove `apps/vault-demo/` and `apps/demo-mcp/`

**Branch:** `chore/remove-vault-demo-apps`

### Context

- `apps/vault-demo/` is a SvelteKit demo for `packages/vault/` (which is itself a "very early POC"). In-memory DB, no persistence. Features: Reddit GDPR ingest UI, entity extraction heuristics, entity curation, cross-adapter dashboard, notes with entity linking, import/export.
- `apps/demo-mcp/` is a 338-line CLI that exercises the vault Reddit adapter. Import ZIP → SQLite, export to Markdown, MCP integration.
- `packages/vault/` is kept alive for now. It has real architecture (adapters, codecs, migrations, tests) and unique ideas (entity extraction) not yet ported to the workspace system.
- Nothing outside the vault island depends on these two apps.
- Reddit ingestion is already being reimplemented in `packages/workspace/src/ingest/reddit/` on the Yjs architecture.

### Todo

- [x] Delete `apps/vault-demo/` entirely
- [x] Delete `apps/demo-mcp/` entirely
- [x] Run `bun install` to update lockfile
- [x] Verify no typecheck regressions
- [x] Commit, push, open PR

### Verification

- `apps/vault-demo/` and `apps/demo-mcp/` no longer exist
- `packages/vault/` still exists (intentionally kept)
- No other package.json references `vault-demo` or `demo-mcp`

---

## PR 3: Move `packages/server-remote/` → `apps/api/`

**Branch:** `refactor/move-server-remote-to-apps-api`

### Context

- `packages/server-remote/` is a standalone Cloudflare Worker (Hono + Better Auth + Durable Objects + Yjs sync + AI chat). It deploys to `api.epicenter.so`.
- Nothing in the monorepo imports `@epicenter/server-remote` as a dependency. It's a deployable application, not a library.
- Its own `wrangler.jsonc` already names it `"api"`.
- It belongs in `apps/`, not `packages/`.

### Todo

- [x] Move `packages/server-remote/` → `apps/api/` (use `git mv`)
- [x] Update `package.json` name from `@epicenter/server-remote` to `@epicenter/api`
- [x] Check `turbo.json` for any references to `server-remote` or `@epicenter/server-remote` and update
- [x] Check root `package.json` for any workspace references and update
- [x] Check `.github/` workflows for any references and update
- [x] Run `bun install` to update lockfile
- [x] Verify no typecheck regressions
- [x] Commit, push, open PR

### Verification

- `packages/server-remote/` no longer exists
- `apps/api/` exists with all original content
- `apps/api/package.json` has `"name": "@epicenter/api"`
- `grep -r "server-remote" --include="*.json" --include="*.jsonc" --include="*.yml" --include="*.yaml" --include="*.ts"` returns zero results (excluding git history)
- Wrangler config is unchanged (still deploys to `api.epicenter.so`)

---

## Review

**Completed**: 2026-03-11
**PRs**:
- PR 1: https://github.com/EpicenterHQ/epicenter/pull/1489
- PR 2: https://github.com/EpicenterHQ/epicenter/pull/1490
- PR 3: https://github.com/EpicenterHQ/epicenter/pull/1491

### Summary

All three PRs executed as specified. Each branch was created off `opencode/lucky-river`, changes committed with conventional commit messages, and PRs opened against the same base.

**PR 1** removed the dead `packages/config/` directory (empty exports, empty scripts. Confirmed by its own README) and scrubbed the four stale `devDependency` references across `apps/epicenter`, `apps/whispering`, `packages/ui`, and `apps/posthog-reverse-proxy`. Added a README to `apps/fs-explorer/` explaining its purpose as a dev UI for `@epicenter/filesystem`.

**PR 2** removed `apps/vault-demo/` (~2,400 lines) and `apps/demo-mcp/` (338 lines). Both were demo consumers of `packages/vault/` with no external dependents. `packages/vault/` intentionally kept.

**PR 3** moved `packages/server-remote/` to `apps/api/` via `git mv` (full history preserved), renamed the package from `@epicenter/server-remote` to `@epicenter/api`, and updated five documentation files that referenced the old path or the legacy codename `server-remote-cloudflare`.

### Straggler Hunting

Between each PR, 5+ parallel grep agents were fired to search for orphaned references across CI configs, source code imports, tsconfig project references, lockfiles, documentation, and Infisical/secrets configs. All PRs were verified clean before committing.

### Deviations from Spec

- PR 3 included doc updates not listed in the spec's todo items. Five `.md` files outside `specs/` referenced the old `packages/server-remote/` path or `server-remote-cloudflare` codename and were updated to reflect the new `apps/api/` location.
