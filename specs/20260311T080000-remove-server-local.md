# Remove server-local Package (Dead Code)

**Date**: 2026-03-11
**Status**: Implemented
**Author**: AI-assisted

## Overview

Remove `packages/server-local` and its sole consumer (the CLI sidecar command) from the monorepo. The package is functional, well-tested, and recently rewritten. But nothing actually uses it. This PR preserves it in git history so it can be restored when needed.

## Motivation

### Current State

`@epicenter/server-local` is a Hono-based HTTP server that provides REST CRUD, WebSocket Yjs sync, and OpenAPI docs for workspace data. It was rewritten from Elysia to Hono three days ago (2026-03-08) and has 76 passing tests.

Its only runtime consumer is a dynamic import in the CLI:

```ts
// packages/cli/src/commands/sidecar-command.ts:79
const { createSidecar } = await import('@epicenter/server-local');
```

No app, no UI component, no Rust code, and no other package imports from it. The CLI sidecar command exists but nobody runs it. It's an unused code path behind a manual CLI invocation.

### Problems

1. **Dead weight**: The package adds dependencies (`hono`, `hono-openapi`, `@hono/standard-validator`), lockfile entries, and typecheck surface for code that never runs.
2. **Maintenance drag**: Any changes to `@epicenter/workspace` or `@epicenter/sync-server` must still satisfy server-local's type requirements, slowing unrelated work.
3. **False signal**: Its presence implies the sidecar is a supported feature. It isn't. Not yet.

### Desired State

The package is removed. Git history preserves every file for future restoration. When the sidecar becomes a real feature, revert this PR (or cherry-pick from it) and continue from a clean, known-good state.

## Research Findings

### Usage Audit

Searched every `.ts`, `.svelte`, `.rs`, and `.json` file in the monorepo for `server-local`, `serverLocal`, `createSidecar`, and `sidecar`.

| Location | Type | Active? |
|---|---|---|
| `packages/server-local/` | Package (source + tests) | Self-contained, not imported by apps |
| `packages/cli/src/commands/sidecar-command.ts` | Dynamic import of `createSidecar` | Only consumer; never invoked by any app |
| `packages/cli/src/cli.ts` | Registers sidecar command | 2 lines |
| `packages/cli/package.json` | `@epicenter/server-local` dependency | 1 line |
| `packages/sync-server/` | Dependency of server-local | Only imported by server-local |
| 12+ spec files | Prose references | Documentation only |
| 4+ doc/article files | Prose references | Documentation only |

**Key finding**: The only runtime import path is `CLI → sidecar-command.ts → @epicenter/server-local`. No app exercises it.

### Dependency Graph

```
@epicenter/server-local
├── depends on:
│   ├── @epicenter/sync-server (workspace:*)   ← ALSO orphaned after removal
│   ├── @epicenter/workspace (peer dep)
│   ├── hono, hono-openapi, @hono/standard-validator
│   ├── typebox, wellcrafted, y-protocols
│   └── yjs (peer dep)
└── depended on by:
    └── @epicenter/cli (single dynamic import)
```

`@epicenter/sync-server` is only imported by `server-local`. Removing server-local orphans it too.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove vs comment out | Remove entirely | Git history preserves everything; commented code rots |
| Also remove `@epicenter/sync-server` | Yes | Only consumer is server-local; keeping it orphaned adds noise |
| Remove CLI sidecar command | Yes | Without server-local it won't compile; no reason to keep a broken command |
| Update spec/doc prose references | No | They're historical context in planning docs, not active code |
| Preserve for restoration | Via git revert of this PR | Cleaner than a feature branch; single revert restores everything |

## Package Contents (Restoration Reference)

When restoring, revert this PR. Here's what comes back:

### packages/server-local/

```
packages/server-local/
├── package.json                    # @epicenter/server-local, v0.0.1
├── tsconfig.json
└── src/
    ├── index.ts                    # Public API exports
    ├── sidecar.ts                  # createSidecar(): Hono app factory
    ├── server.ts                   # Bun.serve wrapper, port fallback
    ├── start.ts                    # CLI entry: `bun src/start.ts`
    ├── sidecar.test.ts             # Integration tests
    ├── middleware/
    │   └── auth.ts                 # Auth middleware (none / token / remote)
    ├── workspace/
    │   ├── index.ts                # createWorkspacePlugin()
    │   ├── plugin.ts               # Workspace route mounting
    │   ├── plugin.test.ts
    │   ├── tables.ts               # REST CRUD for tables
    │   ├── tables.test.ts
    │   ├── kv.ts                   # REST CRUD for KV stores
    │   ├── actions.ts              # Workspace action endpoints
    │   ├── actions.test.ts
    │   └── errors.ts               # Error helpers
    ├── sync/
    │   ├── ws-plugin.ts            # WebSocket Yjs sync relay
    │   ├── ws-plugin.test.ts
    │   ├── rooms.ts                # Room lifecycle management
    │   └── rooms.test.ts
    └── opencode/
        ├── index.ts                # OpenCode integration
        ├── config.ts
        └── spawner.ts
```

**Public API** (`src/index.ts`):
- `createSidecar(config: SidecarConfig)`: main factory, returns `{ app, start(), stop() }`
- `serve(app, port, websocket?)`: Bun.serve with fallback
- `DEFAULT_PORT`: 3913
- `createWorkspacePlugin(clients)`: Hono sub-app for workspace CRUD
- `type AuthUser`, `type SidecarApp`, `type SidecarAuthConfig`, `type SidecarConfig`

**Auth modes** (middleware/auth.ts):
- `none`: CORS-only, no token validation
- `token`: pre-shared secret
- `remote`: delegates to hub via `GET /auth/get-session`

**Dependencies** (package.json):
- `@epicenter/sync-server: workspace:*`
- `@epicenter/workspace: workspace:*` (peer)
- `hono: catalog:`, `hono-openapi: ^1.3.0`, `@hono/standard-validator: ^0.2.2`
- `typebox: catalog:`, `wellcrafted: catalog:`, `y-protocols: catalog:`
- `yjs: catalog:` (peer)

**Test count**: 76 passing (as of Elysia→Hono rewrite, 2026-03-08)

### packages/sync-server/

Also removed (only consumer was server-local). Check `packages/sync-server/` contents in git history for restoration.

### CLI sidecar command

```
packages/cli/src/commands/sidecar-command.ts   # Entire file removed
packages/cli/src/cli.ts                        # 2 lines removed (import + .command())
packages/cli/package.json                      # @epicenter/server-local dep removed
```

The sidecar command provided: `epicenter sidecar start [--workspace] [--hub] [--port] [--watch]`, `epicenter sidecar status`, `epicenter sidecar stop`.

## Implementation Plan

### Phase 1: Remove packages

- [x] **1.1** Delete `packages/server-local/` directory
- [x] **1.2** Delete `packages/sync-server/` directory

### Phase 2: Update CLI

- [x] **2.1** Remove `import { buildSidecarCommand }` from `packages/cli/src/cli.ts`
- [x] **2.2** Remove `.command(buildSidecarCommand(home))` from the yargs chain in `packages/cli/src/cli.ts`
- [x] **2.3** Delete `packages/cli/src/commands/sidecar-command.ts`
- [x] **2.4** Remove `"@epicenter/server-local": "workspace:*"` from `packages/cli/package.json`

### Phase 3: Clean up

- [x] **3.1** Run `bun install` to update lockfile
- [x] **3.2** Run `bun run typecheck` across affected packages (at minimum `packages/cli`)
  > Pre-existing type errors in `data-command.ts` and `workspace/define-table.ts`: none related to this removal.
- [x] **3.3** Run full build/test to confirm nothing breaks

## Edge Cases

### Something else imports sync-server indirectly

Searched all `.ts` files for `from '@epicenter/sync-server'`: only one match, inside `server-local`. The Cloudflare server has a comment referencing it but inlined the code; no actual import. Safe to remove.

### Specs and docs reference "server-local"

12+ spec files and 4+ articles mention server-local in prose. These are historical planning documents. Updating them would rewrite history for no benefit. Leave them as-is.

## Success Criteria

- [x] `packages/server-local/` and `packages/sync-server/` no longer exist in the working tree
- [x] `epicenter sidecar` command is gone from the CLI
- [x] `bun install` succeeds with clean lockfile
- [x] `bun run typecheck` passes for `packages/cli` (pre-existing errors only)
- [x] No remaining TypeScript imports reference `@epicenter/server-local` or `@epicenter/sync-server`
- [ ] PR description documents how to restore (revert this PR)

## References

- `packages/server-local/`: package being removed
- `packages/sync-server/`: orphaned dependency, also removed
- `packages/cli/src/commands/sidecar-command.ts`: sole consumer
- `packages/cli/src/cli.ts`: registers sidecar command
- `specs/20260308T120000-server-local-elysia-to-hono.md`: most recent spec (Elysia→Hono rewrite, completed 2026-03-08)
- `specs/20260308T120000-sync-three-layer-split.md`: created sync-server as a separate package
