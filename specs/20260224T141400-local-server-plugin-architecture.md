> **Path note (2026-05-22):** This draft's top-level `~/.epicenter/` layout is superseded. Do not copy its `~/.epicenter/workspaces`, `~/.epicenter/node_modules`, `~/.epicenter/data`, or `~/.epicenter/jsrepo.json` instructions into new work. Current durable user data uses platform directories, runtime sockets use the OS runtime directory, and generated project data stays under `<projectDir>/.epicenter/`.

# Local Server Plugin Architecture: JSRepo + Bun Compiled Binary

**Date**: 2026-02-24
**Status**: Draft
**Author**: AI-assisted

## Overview

The local Epicenter server becomes a Bun-compiled binary that dynamically discovers and loads workspace definitions from a `~/.epicenter/` folder. Workspace "apps" are plain TypeScript source files, downloaded via JSRepo's programmatic API, that the binary imports at runtime using Bun's built-in TypeScript transpiler.

## Motivation

### Current State

Workspace definitions live inside the monorepo and are statically composed into the server at build time:

```typescript
// packages/server/src/start-local.ts
const server = createLocalServer({
  clients: [],  // hardcoded, empty
  port,
});
```

To use a workspace on the local server, you must:
1. Clone the monorepo
2. Import the workspace definition in source code
3. Run the server via `bun src/start-local.ts`

This creates problems:

1. **No user-installable workspaces**: End users can't add workspace apps without modifying source code
2. **No distribution mechanism**: Workspace definitions (like `redditWorkspace`, `whisperingWorkspace`) have no way to be shared outside the monorepo
3. **Server requires dev toolchain**: Running the local server means having the full repo + Bun installed as a dev tool rather than a single binary

### Desired State

```bash
# User installs a single binary
brew install epicenter

# First run initializes the local data folder
epicenter init

# User installs a workspace app: just downloads TypeScript source
epicenter install reddit

# Server starts, auto-discovers installed workspaces, serves them
epicenter serve
# → REST: /workspaces/reddit/tables/posts
# → WS:   /rooms/reddit
```

The binary handles everything: downloading source code via JSRepo's programmatic API, installing dependencies by re-invoking itself as the Bun CLI, dynamically importing `.ts` files, and mounting them as live workspace endpoints. **No separate Bun installation required.**

## Research Findings

### Bun Compiled Binary + Dynamic TypeScript Import

Confirmed that `bun build --compile` produces a standalone executable that embeds the full Bun runtime, including the TypeScript transpiler.

| Capability | Status | Mechanism |
|---|---|---|
| Import external `.ts` files at runtime | ✅ Works | Embedded Bun runtime transpiles on the fly |
| Prevent compile-time bundling of dynamic paths | ✅ Works | Use variable for import path (not string literal) |
| Resolve `node_modules` for imported files | ✅ Works | Standard Bun module resolution walks up from file location |
| Locate files relative to binary | ✅ Works | `dirname(process.execPath)` or `os.homedir()` |
| Load `tsconfig.json` at runtime | ⚠️ Opt-in | Requires `--compile-autoload-tsconfig` flag |

**Key finding**: A compiled Bun binary can `await import(pathVariable)` where the path points to a `.ts` file on disk that was never part of the original build. Bun's embedded runtime handles transpilation transparently.

**Critical detail**: The import path must be a variable (not a string literal) to prevent the bundler from trying to resolve it at compile time:

```typescript
// ❌ Bundler tries to resolve at compile time
const mod = await import('./workspace.ts');

// ✅ Forces runtime resolution
const path = join(dir, 'workspace.ts');
const mod = await import(path);
```

### `BUN_BE_BUN=1`: Running `bun install` From a Compiled Binary

A compiled Bun binary embeds the runtime but does **not** expose the full Bun CLI (package manager, test runner, etc.) by default. However, Bun v1.2.16 added the `BUN_BE_BUN=1` environment variable: when set, the compiled executable acts as the full Bun CLI.

This means the binary can run `bun install` by **spawning itself** with `BUN_BE_BUN=1`:

```typescript
import { spawnSync } from 'bun';

function bunInstall(cwd: string) {
  const result = spawnSync({
    cmd: [process.execPath, 'install'],   // process.execPath = the compiled binary itself
    env: { ...process.env, BUN_BE_BUN: '1' },
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error('bun install failed');
}
```

**Key implication**: No separate Bun installation is needed on the host. The compiled binary is self-sufficient for package management. The parenthetical exception in earlier drafts of this spec ("except for the `bun install` step") is eliminated.

### JSRepo Programmatic API

JSRepo exports a public programmatic API from `jsrepo/api`. This allows the compiled binary to fetch and write workspace blocks directly, no CLI, no `bunx`, no shell-out.

**Confirmed exports from `jsrepo/api`:**

| Export | Purpose |
|---|---|
| `selectProvider(url)` | Returns the `RegistryProvider` for a registry URL (github, gitlab, etc.) |
| `fetchManifest(state)` | Fetches `jsrepo-manifest.json` → `Result<Manifest, string>` |
| `fetchBlocks(...states)` | Fetches all blocks from one or more registries → `Result<Map<string, RemoteBlock>, ...>` |
| `fetchRaw(sourceRepo, filePath)` | Fetches raw file content from registry → `Result<string, string>` |
| `resolvePaths(paths, cwd)` | Resolves `paths` config (handles TS path aliases) |
| `getPathForBlock(block, resolvedPaths, cwd)` | Returns the target install directory for a block |

**Block installation flow** (replacing `bunx jsrepo add workspaces/<name>`):

```typescript
import { selectProvider, fetchBlocks, fetchRaw } from 'jsrepo/api';
import { github } from 'jsrepo/api'; // registry provider
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

async function installWorkspace(name: string, epicenterDir: string) {
  const registryUrl = 'github/EpicenterHQ/epicenter';

  // 1. Resolve registry provider and state
  const provider = selectProvider(registryUrl);
  if (!provider) throw new Error(`No provider found for ${registryUrl}`);
  const state = await github.state(registryUrl);

  // 2. Fetch all available blocks from the registry
  const blocksResult = await fetchBlocks(state);
  if (blocksResult.isErr()) throw new Error(blocksResult.unwrapErr().message);
  const blocks = blocksResult.unwrap();

  // 3. Find the requested workspace block
  const blockKey = `workspaces/${name}`;
  const block = blocks.get(blockKey);
  if (!block) throw new Error(`Workspace "${name}" not found in registry`);

  // 4. Fetch and write each file
  const targetDir = join(epicenterDir, 'workspaces', name);
  mkdirSync(targetDir, { recursive: true });

  for (const file of block.files) {
    const repoPath = join(block.directory, file);
    const contentResult = await fetchRaw(block.sourceRepo, repoPath);
    if (contentResult.isErr()) throw new Error(`Failed to fetch ${file}: ${contentResult.unwrapErr()}`);
    writeFileSync(join(targetDir, file), contentResult.unwrap(), 'utf-8');
  }

  // 5. Install any new deps introduced by this workspace
  bunInstall(epicenterDir);
}
```

**Note on updates**: The CLI's update flow (diffs, merge prompts) is not exposed via the programmatic API: it's CLI-only UX. For `epicenter update`, the binary fetches the latest content via `fetchRaw`, compares it to the existing file, and shows a simple "file changed, overwrite? [y/N]" prompt before writing. This loses the line-level diff view but is sufficient for v1.

**Note on the `jsrepo.json` config file**: The `~/.epicenter/jsrepo.json` is still written by `init` for documentation purposes (what registry this folder tracks), but the binary does not use it at runtime: the registry URL is hardcoded in the binary.

### Bare Specifier Resolution

When the compiled binary imports `~/.epicenter/workspaces/reddit/workspace.ts`, and that file contains `import { defineWorkspace } from '@epicenter/hq'`, Bun needs to resolve `@epicenter/hq`.

| Approach | Pros | Cons |
|---|---|---|
| Bundle `@epicenter/hq` in binary, externalize in workspace files | Binary is self-contained | Version mismatch risk between binary and workspace expectations |
| Install `@epicenter/hq` in `~/.epicenter/node_modules/` | Single source of truth, version always matches workspace expectations | Slightly larger disk footprint, requires `bun install` |
| Use import maps | No `node_modules` needed | Bun import map support is limited for compiled binaries |

**Recommendation**: Install `@epicenter/hq` and `arktype` in `~/.epicenter/node_modules/`. Standard module resolution walks up from the imported file's location (`~/.epicenter/workspaces/reddit/workspace.ts` → `~/.epicenter/node_modules/`). The `bun install` step is handled by `BUN_BE_BUN=1`: no separate Bun installation needed.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Binary runtime | Bun `--compile` | Embeds TS transpiler for free, fast startup, single file distribution |
| Source delivery | JSRepo programmatic API (`jsrepo/api`) | Bundled in binary: no shell-out, no `bunx`, no host dependency. `fetchBlocks` + `fetchRaw` cover install and update. |
| `bun install` from binary | `BUN_BE_BUN=1` + `process.execPath` | Compiled binary spawns itself as the full Bun CLI. No separate Bun installation required on host. |
| Plugin location | `~/.epicenter/` | Standard XDG-ish home directory pattern. Survives binary upgrades. |
| Dependency resolution | `node_modules` in `.epicenter/` | Standard Bun module resolution. No import maps or custom loaders. |
| Workspace discovery | Scan `workspaces/` directory at startup | Simple, predictable, no config file to maintain |
| Registry source | Epicenter monorepo on GitHub | Zero additional infrastructure. JSRepo reads directly from the repo. |
| `@epicenter/hq` location | `.epicenter/node_modules/`, NOT bundled in binary | Avoids version mismatch between binary and workspace expectations |
| Server composition | Plugins from `@epicenter/server` bundled in binary | Sync, workspace, opencode plugins are core: not user-installable |

## Architecture

### Folder Structure

```
~/.epicenter/
├── jsrepo.json                        ← Registry reference (informational; not read at runtime)
├── package.json                       ← Shared deps: @epicenter/hq, arktype
├── tsconfig.json                      ← Minimal config for workspace files
├── node_modules/                      ← bun install'd via BUN_BE_BUN=1, shared by all workspaces
│   ├── @epicenter/hq/
│   └── arktype/
├── data/                              ← Yjs document storage (Y.Doc files)
│   ├── reddit/
│   └── tab-manager/
└── workspaces/                        ← JSRepo programmatic API writes blocks here
    ├── reddit/
    │   └── workspace.ts               ← export const redditWorkspace = defineWorkspace({...})
    ├── tab-manager/
    │   └── workspace.ts
    └── whispering/
        └── workspace.ts
```

### Registry Structure (in Epicenter monorepo)

```
epicenter/                             ← GitHub repo = JSRepo registry
├── jsrepo-build-config.json           ← Declares available blocks
└── registry/                          ← Source blocks for JSRepo
    └── workspaces/                    ← Category
        ├── reddit/
        │   └── workspace.ts           ← Copied from packages/epicenter/src/ingest/reddit/
        ├── whispering/
        │   └── workspace.ts
        └── entries/
            └── workspace.ts
```

### Runtime Flow

```
STEP 1: epicenter init
────────────────────────
Binary creates ~/.epicenter/ with:
  - jsrepo.json  (registry = github/EpicenterHQ/epicenter, informational)
  - package.json (deps: @epicenter/hq, arktype: versions pinned to match binary)
  - tsconfig.json (minimal, required for workspace file transpilation)
Runs bun install via BUN_BE_BUN=1:
  spawnSync([process.execPath, 'install'], { env: { BUN_BE_BUN: '1' }, cwd: '~/.epicenter/' })

STEP 2: epicenter install <workspace>
──────────────────────────────────────
Binary uses jsrepo/api programmatic API:
  1. selectProvider('github/EpicenterHQ/epicenter')
  2. fetchBlocks(providerState)  →  Map<string, RemoteBlock>
  3. block = blocks.get('workspaces/<name>')
  4. For each file: fetchRaw(block.sourceRepo, filePath) → write to ~/.epicenter/workspaces/<name>/
  5. spawnSync([process.execPath, 'install'], { env: { BUN_BE_BUN: '1' }, cwd: epicenterDir })
     (fast no-op if no new deps; installs new ones if the workspace introduced them)

STEP 3: epicenter serve
────────────────────────
Binary scans ~/.epicenter/workspaces/*/workspace.ts
For each .ts file:
  const path = join(epicenterDir, 'workspaces', name, 'workspace.ts');
  const mod = await import(path);         // Bun transpiles .ts at runtime
  const definition = findWorkspaceExport(mod);
  const client = createWorkspace(definition);
  clients.push(client);

createLocalServer({ clients, port: 3913 }).start();

STEP 4: epicenter update [workspace]
─────────────────────────────────────
Binary uses jsrepo/api to fetch latest content:
  1. fetchRaw latest workspace.ts content from registry
  2. Compare to existing ~/.epicenter/workspaces/<name>/workspace.ts
  3. If changed: show summary ("workspace.ts has changed: overwrite? [y/N]")
  4. On confirm: write new file
  5. spawnSync([process.execPath, 'install'], { env: { BUN_BE_BUN: '1' }, cwd: epicenterDir })
```

### Compiled Binary Contents

```
epicenter (single binary, ~50MB)
├── Bun runtime (TS transpiler, module resolver, HTTP server)
├── @epicenter/server (sync, workspace, ai, auth, proxy, opencode plugins)
├── jsrepo/api (selectProvider, fetchBlocks, fetchRaw: for install/update commands)
├── elysia, y-protocols, lib0 (server deps)
└── CLI commands (init, install, update, serve, uninstall, list)

NOT bundled (resolved from ~/.epicenter/node_modules/ at runtime):
├── @epicenter/hq
└── arktype
```

## Implementation Plan

### Phase 1: Registry Setup

- [ ] **1.1** Create `registry/` directory in monorepo root with workspace blocks
- [ ] **1.2** Add `jsrepo-build-config.json` to monorepo root exposing `workspaces/` category
- [ ] **1.3** Copy existing workspace definitions (`reddit`, `whispering`, `entries`) into `registry/workspaces/`
- [ ] **1.4** Run `jsrepo build` to generate manifest, verify blocks are discoverable
- [ ] **1.5** Test `jsrepo add workspaces/reddit` from a scratch directory to validate the flow

### Phase 2: `.epicenter/` Scaffold

- [ ] **2.1** Create `packages/cli/src/commands/init.ts`: generates `~/.epicenter/` with `jsrepo.json`, `package.json`, `tsconfig.json`
- [ ] **2.2** Define the `package.json` template (pinned `@epicenter/hq` and `arktype` versions matching the binary)
- [ ] **2.3** Define the `jsrepo.json` template (registry URL, informational)
- [ ] **2.4** Run `bun install` via `BUN_BE_BUN=1`: `spawnSync([process.execPath, 'install'], { env: { BUN_BE_BUN: '1' }, cwd: epicenterDir })`

### Phase 3: Install / Uninstall Commands

- [ ] **3.1** `epicenter install <name>`: uses `jsrepo/api`: `selectProvider` → `fetchBlocks` → `fetchRaw` → write files → `bunInstall(epicenterDir)`
- [ ] **3.2** `epicenter uninstall <name>`: removes `~/.epicenter/workspaces/<name>/`
- [ ] **3.3** `epicenter update [name]`: uses `jsrepo/api` to fetch latest, diff against local, prompt user, write on confirm, re-run `bunInstall`
- [ ] **3.4** `epicenter list`: scans `~/.epicenter/workspaces/` and lists installed workspaces

### Phase 4: Dynamic Workspace Loader

- [ ] **4.1** Create `loadInstalledWorkspaces()`: scans `~/.epicenter/workspaces/`, dynamic imports each `workspace.ts`, extracts `defineWorkspace` export
- [ ] **4.2** Integrate with `createLocalServer`: loaded clients passed to server factory
- [ ] **4.3** Error handling: graceful skip on malformed workspace files with clear error messages
- [ ] **4.4** `epicenter serve` command: loads workspaces + starts server

### Phase 5: Compiled Binary

- [ ] **5.1** Create `bun build --compile` configuration for the CLI + server binary
- [ ] **5.2** Ensure dynamic import paths use variables (not literals) to prevent compile-time bundling
- [ ] **5.3** Test that compiled binary can import `.ts` from `~/.epicenter/workspaces/`
- [ ] **5.4** Verify `node_modules` resolution works: workspace file at `~/.epicenter/workspaces/reddit/workspace.ts` correctly resolves `@epicenter/hq` from `~/.epicenter/node_modules/`
- [ ] **5.5** Test `BUN_BE_BUN=1` mechanism: verify `spawnSync([process.execPath, 'install'], { env: { BUN_BE_BUN: '1' } })` runs successfully from the compiled binary
- [ ] **5.6** Set up release pipeline (GitHub Actions → binary artifacts for macOS/Linux/Windows)

## Edge Cases

### Workspace depends on a version of `@epicenter/hq` newer than what's installed

1. User runs `epicenter install new-workspace`
2. `new-workspace` was built against `@epicenter/hq@2.0` but `.epicenter/package.json` has `@epicenter/hq@1.5`
3. Import succeeds but runtime behavior is wrong (missing API, changed types)
4. **Mitigation**: The binary knows its own `@epicenter/hq` version. The `install` command should check the registry block's declared peer deps against the installed version and warn before writing files.

### User edits a workspace file locally, then runs `epicenter update`

1. User modifies `~/.epicenter/workspaces/reddit/workspace.ts`
2. Runs `epicenter update reddit`
3. Binary fetches latest content via `fetchRaw`, detects the local file differs
4. Prompts: "workspace.ts has local changes. Overwrite? [y/N]"
5. User chooses to overwrite or skip.
6. **Note**: This is simpler than the full jsrepo CLI diff/merge UX. If line-level diffs are needed in the future, the existing content and fetched content are both in memory: diffing can be added without architectural changes.

### Malformed workspace file crashes the server

1. User manually edits a workspace file and introduces a syntax error
2. `epicenter serve` tries to `import()` it
3. Import throws: **must not crash the entire server**
4. **Mitigation**: Wrap each `import()` in try/catch, log the error, skip that workspace, continue serving others.

### Two workspaces use the same `id`

1. User installs `reddit` and a custom workspace that also uses `id: 'reddit'`
2. Both get loaded, `createLocalServer` receives two clients with the same ID
3. **Mitigation**: Detect duplicate IDs during the scan phase, warn the user, skip the duplicate.

### Binary upgrade changes `@epicenter/server` but not `@epicenter/hq`

1. User upgrades the `epicenter` binary (new server plugins)
2. `~/.epicenter/node_modules/@epicenter/hq` stays at old version
3. Server boots fine: the server plugins are in the binary, workspace schemas resolve from `node_modules`
4. **This is the intended behavior**: binary upgrades don't break installed workspaces.

### No internet connection during `epicenter install`

1. `fetchBlocks` or `fetchRaw` fails: network error
2. **Mitigation**: `jsrepo/api` returns `Result` types. The `install` command checks `isErr()` and surfaces a clear "Could not reach registry: check your internet connection" message. No partial writes occur (files are only written after all fetches succeed).

## Open Questions

1. **Should the server hot-reload when workspace files change?**
   - Options: (a) File watcher auto-restarts, (b) Manual restart only, (c) Hot-mount new workspaces without restart
   - **Recommendation**: Start with manual restart (`epicenter serve` re-scans on each boot). Add file watching later if needed. Hot-mounting Elysia routes at runtime is fragile.

2. **Where should Yjs document data live?**
   - Options: (a) `~/.epicenter/data/<workspace-id>/`, (b) Alongside workspace files, (c) XDG data directory
   - **Recommendation**: `~/.epicenter/data/`: keeps data and code in the same top-level folder, but separated. Workspace uninstall should NOT delete data (separate `epicenter purge` command).

3. **Should `epicenter install` also run `bun install` automatically?**
   - Options: (a) Always, (b) Only if new deps detected, (c) Prompt user
   - **Recommendation**: Always: it's fast with Bun and prevents subtle "missing dep" errors. The `BUN_BE_BUN=1` spawn is cheap.

4. **Should workspaces be able to declare actions (custom server-side logic)?**
   - Actions require arbitrary code execution, not just schema definitions
   - **Recommendation**: Support it from day one: workspace `.ts` files can export actions alongside the definition. The dynamic import loads everything. Defer sandboxing to a later phase.

5. **Should the registry be the monorepo directly, or a separate `epicenter-registry` repo?**
   - Options: (a) Monorepo with `registry/` folder, (b) Separate repo, (c) Published to jsrepo.com
   - **Recommendation**: Start with monorepo `registry/` folder. Simplest path. Move to separate repo if the registry grows large or needs independent versioning.

6. **How should `@epicenter/hq` version pinning work?**
   - The binary knows which version of `@epicenter/hq` it was built against
   - Options: (a) `epicenter init` writes the matching version to `package.json`, (b) Binary checks at startup and warns on mismatch, (c) Both
   - **Recommendation**: Both. Init writes the correct version. Serve checks and warns if `node_modules` version doesn't match expectations.

7. ~~**Should JSRepo be a runtime dependency of the binary, or shelled out to?**~~ **Resolved**: Use `jsrepo/api` programmatic API bundled in the binary. No shell-out to `bunx jsrepo`. Eliminates host dependency on jsrepo CLI. `fetchBlocks` + `fetchRaw` cover install; simple diff + overwrite covers update.

## Success Criteria

- [ ] `epicenter init` creates a valid `~/.epicenter/` folder with `jsrepo.json`, `package.json`, and `node_modules/`
- [ ] `epicenter install reddit` downloads `workspace.ts` into `~/.epicenter/workspaces/reddit/`
- [ ] `epicenter serve` starts a local server that serves installed workspaces as REST + WebSocket endpoints
- [ ] A compiled Bun binary performs all of the above with **no separate Bun installation required** on the host
- [ ] `epicenter list` shows installed workspaces
- [ ] `epicenter update` pulls latest workspace definitions from the registry
- [ ] Malformed workspace files are skipped gracefully without crashing the server
- [ ] Server exposes correct routes: `/workspaces/<id>/tables/<table>` and `/rooms/<id>`

## References

- `packages/server/src/local.ts`: Current `createLocalServer` factory (clients array, plugin composition)
- `packages/server/src/hub.ts`: Hub server factory (reference for how plugins compose)
- `packages/server/src/workspace/plugin.ts`: Workspace REST plugin (tables + actions)
- `packages/epicenter/src/ingest/reddit/workspace.ts`: Example workspace definition (complex, real-world)
- `apps/epicenter/src/lib/templates/whispering.ts`: Example workspace definition (simple)
- `apps/tab-manager/src/lib/workspace.ts`: Example workspace definition (with actions, awareness)
- `packages/cli/`: Existing CLI package where new commands would live
- [JSRepo docs](https://jsrepo.dev): Registry configuration, block management
- [JSRepo programmatic API](https://github.com/ieedan/jsrepo): `jsrepo/api` exports: `selectProvider`, `fetchBlocks`, `fetchRaw`, `resolvePaths`, `getPathForBlock`
- [Bun compiled executables](https://bun.sh/docs/bundler/executables): `--compile` flag, dynamic imports
- [Bun `BUN_BE_BUN=1`](https://bun.sh/docs/bundler/executables): v1.2.16+, compiled binary acts as full Bun CLI when env var is set
