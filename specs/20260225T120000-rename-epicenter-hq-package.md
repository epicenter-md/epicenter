# Rename `@epicenter/workspace` to `@epicenter/workspace`

## Problem

The package `@epicenter/workspace` (`packages/epicenter/`) is the core library of the monorepo. Its API is entirely about defining and creating workspaces:

- `defineWorkspace()`, `defineTable()`, `defineKv()`
- `createWorkspace()` with `.withExtension()` / `.withActions()`
- `TableHelper`, `KvHelper`, `AwarenessHelper`, `Documents`
- Action system (`defineQuery`, `defineMutation`)

The name "hq" (headquarters) is a metaphor for "the central package" but communicates nothing about what the package actually does. A new developer reading `import { createWorkspace } from '@epicenter/workspace'` has to wonder: what is "hq"? Why not just call it what it is?

## Decision

Rename `@epicenter/workspace` to `@epicenter/workspace`.

### Why `workspace` and not alternatives?

| Candidate | Verdict |
|---|---|
| `@epicenter/workspace` | Matches the API exactly. You `defineWorkspace`, you `createWorkspace`, you get a `WorkspaceClient`. The package IS the workspace SDK. |
| `@epicenter/core` | Generic. Every monorepo has a "core" package. Tells you nothing. |
| `@epicenter/sdk` | Too broad. An SDK for what? The workspace. Just say workspace. |
| `@epicenter/workspaces-api` | Overly formal. The `-api` suffix is redundant when the package is already a code library. |
| `@epicenter/workspace` (keep) | Cute but confusing. "HQ" as a concept has no future: it doesn't map to any real domain concept. |

### What would "hq" refer to in the future?

Nothing meaningful. The name was chosen as a catch-all for "the main package," but as the monorepo matured, the package's identity crystallized around workspaces specifically. There's no future feature where "hq" becomes the right word. The package won't grow into a general-purpose toolkit. It will stay focused on workspace definition, creation, and the extension/action system around workspaces.

## Scope

### What changes

1. **`packages/epicenter/package.json`**: `"name": "@epicenter/workspace"` becomes `"name": "@epicenter/workspace"`
2. **All import statements** across the monorepo referencing `@epicenter/workspace` or its subpaths (`@epicenter/workspace/extensions`, `@epicenter/workspace/extensions/sync`, etc.) become `@epicenter/workspace/...`
3. **All `package.json` dependency entries** referencing `@epicenter/workspace` become `@epicenter/workspace`
4. **Internal docs, comments, and JSDoc** referencing `@epicenter/workspace`
5. **`bun.lock`** regenerated after the rename

### What does NOT change

- The directory stays `packages/epicenter/`: the directory name is the project name, not the npm package name. No need to rename it.
- No API changes. Every export stays identical.
- No subpath export changes. `@epicenter/workspace/extensions/sync/web` etc. all keep their structure, just under the new scope.

## Affected files

### Direct dependency references (package.json files)

These packages list `@epicenter/workspace` as a dependency or peer dependency:

- `packages/filesystem/package.json`
- `packages/ai/package.json`
- `packages/server/package.json` (peerDependencies)
- `packages/cli/package.json`
- `apps/epicenter/package.json`
- `apps/tab-manager/package.json`
- `apps/tab-manager-markdown/package.json`
- `apps/whispering/package.json`
- `apps/fs-explorer/package.json`

### Import statements (source files)

Every `.ts` file importing from `@epicenter/workspace` or its subpaths. Key locations:

- `apps/epicenter/src/lib/yjs/`: workspace creation and persistence
- `apps/epicenter/src/lib/templates/`: workspace definitions
- `apps/tab-manager/src/`: workspace definition, background, popup, commands, state
- `apps/tab-manager-markdown/src/`: workspace creation
- `apps/fs-explorer/src/`: workspace creation
- `packages/filesystem/src/`: table helpers, types, documents
- `packages/ai/src/`: action iteration
- `packages/server/src/`: workspace plugin, routes, types
- `packages/cli/src/`: action iteration, types

### Docs and specs

Many files in `specs/`, `docs/`, and `packages/epicenter/docs/` reference `@epicenter/workspace` in examples. These should be updated but are lower priority. They can be batch-updated with a find-and-replace.

## Execution plan

This is a mechanical rename. The safest approach:

1. **Update `packages/epicenter/package.json`**: change the name field
2. **Global find-and-replace** `@epicenter/workspace` with `@epicenter/workspace` across all `.ts`, `.json`, and `.md` files
3. **Run `bun install`** to regenerate the lockfile
4. **Run `bun run typecheck`** from root to verify nothing broke
5. **Run tests** for the core package and key consumers
6. **Single commit**: `refactor: rename @epicenter/workspace to @epicenter/workspace`

## Decisions

1. **Directory stays `packages/epicenter/`.** No directory rename for now.
2. **`@epicenter/server/workspace` subpath keeps its name.** It exports `createWorkspacePlugin` (Elysia plugin that mounts workspace REST routes). The distinction between `@epicenter/workspace` (the SDK) and `@epicenter/server/workspace` (HTTP routes for workspaces) is clear enough: one is a package, the other is a server subpath.
3. **Drop the `./static` backward-compat alias.** Since this is already a breaking rename, clean up the dead alias too. Remove the `"./static"` entry from the exports map in `package.json`.
