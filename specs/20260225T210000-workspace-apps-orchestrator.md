> **Status: Superseded** by `20260313T063000-workspace-architecture-decisions.md`. The centralized workspace model, Hono-based app server, and self-contained config pattern replace this spec's architecture.
>
> **Path note (2026-05-22):** The `EPICENTER_HOME` and `~/.epicenter/workspaces/` model in this document is superseded. Do not copy its home-directory workspace registry, auth, or data paths into new work. Current runtime state no longer uses top-level `~/.epicenter/` as the mixed home for installed workspaces, auth, persistence, or process files.

# Workspace Apps: Install, Mount, Run

**Date**: 2026-02-25
**Status**: Superseded
**Author**: AI-assisted

## Overview

Turn each workspace into a self-contained app that can be installed from a registry, loaded into the local server process, accessed from a unified Svelte shell, and optionally run standalone or synced against a remote hosted version.

The core insight: `epicenter.config.ts` is a **universal contract**: a workspace definition (schema + actions) that works identically whether loaded into the local server, run standalone on its own port, or imported directly by a browser SPA. Every namespace in the filesystem is its own app. You can download and run 20 of them locally in one process, run any individually, or import the config in a client-side app that operates on its own Y.Doc and syncs via WebSocket. Hub sync keeps instances in sync regardless of where they run.

**Terminology**: `createWorkspace()` returns a `WorkspaceClientBuilder`: an object that IS a `WorkspaceClient` (Y.Doc, tables, kv, awareness) plus chainable builder methods (`.withExtension()`, `.withDocumentExtension()`, `.withActions()`). The builder uses immutable state: each `.withExtension()` returns a new builder, enabling builder branching (multiple chains from the same base). `.withActions()` is terminal, producing a `WorkspaceClientWithActions`.

**The config exports the builder, not the terminal client.** The `epicenter.config.ts` default export is a `WorkspaceClientBuilder`: the result of `createWorkspace()` without `.withExtension()` or `.withActions()` chained. This is the **data contract**: schema only. Each runtime (browser SPA, Bun sidecar, standalone hosted workspace) imports the builder and chains its own extensions and actions as appropriate. Extensions and actions are **not** part of the config: they are attached per-runtime, keeping the config portable and allowing different runtimes to expose different capabilities.

## The Hub Server Is Separate

This spec discusses three runtime contexts for a workspace config: the Bun sidecar, the browser SPA, and a "standalone hosted workspace." These must not be confused with the **hub server**, which is a fourth, entirely separate thing.

| | Hub Server | Standalone Hosted Workspace |
|---|---|---|
| Created with | `createHubServer()` | `createLocalServer({ clients: [client] })` |
| Knows about workspace configs | **No** | Yes: imports `epicenter.config.ts` |
| Has extensions | **No** | Yes (e.g., `filePersistence`, `markdownProjection`) |
| Has actions | **No** | Yes (e.g., `coreActions`, `sendWebhook`) |
| Persists Y.Docs | **No**: ephemeral rooms only | Yes: `workspace.yjs` on disk |
| Role | Auth + AI proxy + Yjs relay | Workspace CRUD + sync, running in the cloud |

**Hub server** (`createHubServer()`): A generic, schema-agnostic relay. It provides auth (Better Auth JWT), an AI proxy (streaming), and Yjs WebSocket rooms (ephemeral Y.Docs). It has **no knowledge of any workspace**: no `epicenter.config.ts` is ever imported, no extensions are mounted, no actions are registered. Any number of workspace instances (local sidecars, standalone hosted workspaces, browser SPAs) connect to the hub as peers. The hub merges their updates and rebroadcasts: nothing more.

**Standalone hosted workspace**: A specific `epicenter.config.ts` deployed as a cloud web service (Phase 5). It uses `createLocalServer({ clients: [client] })`: the same server used by the local Bun sidecar: with extensions and actions chained for the cloud environment (e.g., Durable Objects instead of `filePersistence`). It connects to the hub as a peer, just like the local sidecar does.

**Summary**: Local sidecar and standalone hosted workspace are both "local servers": one runs on your machine, one runs in the cloud. The hub knows about neither. All three connect to the hub as Yjs peers.

## Motivation

### Current State

Workspaces are hardcoded TypeScript templates compiled into the desktop app (`apps/epicenter/src/lib/templates/`). The server loads all workspace clients into a single `createLocalServer()` call with parameterized routes:

```typescript
// packages/server/src/local.ts
const app = new Elysia()
  .use(new Elysia({ prefix: '/workspaces' })
    .use(createWorkspacePlugin(clients)))  // ALL clients, one process
```

The CLI discovers workspaces by scanning directories for `epicenter.config.ts` files and dynamically importing them:

```typescript
// packages/cli/src/discovery.ts
const module = await import(Bun.pathToFileURL(configPath).href);
const client = module.default; // WorkspaceClientWithActions
```

This creates problems:

1. **No runtime installation**: Adding a workspace means editing source code and rebuilding the app.
2. **No isolation**: All workspaces share the same Elysia route tree, same process, same dependency context. A workspace can't bring its own dependencies.
3. **Two paradigms exist**: Desktop uses compiled templates, CLI uses dynamic TypeScript imports. They should converge.
4. **No standalone mode**: A workspace can't run on its own as a web app outside the Epicenter shell.

### Desired State

Each workspace is a directory with an `epicenter.config.ts` that can be:
- **Installed** from a jsrepo registry via the CLI
- **Loaded** into the local server alongside other workspaces
- **Browsed** in the Svelte shell alongside other workspaces
- **Run standalone** on its own port as a plain web app
- **Synced remotely**: a hosted version at `myapp.com` can share data with the local instance via Yjs hub relay

## Research Findings

### Elysia Composition: `mount()` vs `.use()` vs Reverse Proxy

Elysia provides two in-process composition mechanisms, plus external proxying:

| Mechanism | How it works | HTTP | WebSocket | Process |
|-----------|-------------|------|-----------|---------|
| `.use()` | Merges plugin into parent. Shares lifecycle hooks (scoped), decorators, store. | Yes | Yes | Same |
| `.mount(path, handler.fetch)` | Passes raw `Request` to a WinterCG `fetch` handler. Strips prefix. Fully isolated. | Yes | **No** | Same |
| `.mount(path, elysiaInstance)` | **Extracts `.fetch` handler**: same behavior as raw handler. Types NOT preserved, OpenAPI hidden, WebSocket broken. | Yes | **No** | Same |
| Reverse proxy | Manual `fetch()` forwarding to another port | Yes | Manual relay only | Separate |

**Critical nuance**: `.mount()` **always extracts `.fetch`** regardless of what you pass it. Passing an Elysia instance is NOT the same as calling `.use()`:

```typescript
// RAW HANDLER: opaque, no types, no OpenAPI, no WebSocket
orchestrator.mount('/entries', entriesApp.fetch);

// ELYSIA INSTANCE: also extracts .fetch internally. Same result as above.
// Does NOT auto-resolve via .use(). Types, OpenAPI, WebSocket all lost.
orchestrator.mount('/entries', entriesApp);

// CORRECT approach for first-party workspaces:
orchestrator.use(new Elysia({ prefix: '/entries' }).use(entriesApp));
```

The official docs claim `.mount(path, elysiaInstance)` auto-resolves via `.use()`, but source code analysis shows it extracts `.fetch` regardless. Verified via DeepWiki source analysis: routes are registered with `detail: { hide: true }` and WebSocket routes are inaccessible.

| Aspect | `.use(plugin)` | `.mount(path, anything)` |
|--------|---------------|--------------------------|
| Type inference (Eden) | Full | **None** |
| OpenAPI docs | Included | **Hidden** (`detail.hide = true`) |
| Lifecycle hooks | Merged (scoped) | **Isolated** |
| WebSocket | Yes | **No** |
| Prefix stripping | Via `{ prefix }` option | Automatic |
| Runtime overhead | Near zero (AOT) | New `Request` per call |
| Non-Elysia frameworks | No | **Yes** (Hono, etc.) |

**Key finding**: WebSocket proxying in Bun is broken. There is a known issue (`oven-sh/bun#10441`) where Bun's HTTP handling emits a `response` event instead of `upgrade`, breaking `node-http-proxy` and similar libraries. Manual WebSocket relay is possible but fragile and adds latency to Yjs sync messages.

**Implication**: For first-party workspaces, `.use()` is the clear choice: preserves types, OpenAPI, WebSocket, with zero runtime overhead. `.mount(path, handler.fetch)` becomes relevant only when mounting untrusted third-party code or non-Elysia frameworks. The local server should own the sync relay (WebSocket) centrally regardless of which composition mechanism is used for HTTP routes. Note: this research was originally done to evaluate per-workspace Elysia instances with dedicated prefixes. That approach was rejected (see Resolved Question #9), but the `.mount()` vs `.use()` findings remain relevant for future third-party workspace isolation.

### jsrepo as Distribution Mechanism

jsrepo distributes source code blocks from GitHub-backed registries.

| Capability | Support | Notes |
|-----------|---------|-------|
| Multi-file directories | Yes | `subdirectory: true` preserves tree structure |
| Arbitrary file types | Yes | `.ts`, `.svelte`, `.json`, anything |
| npm dependency detection | Yes | Reads registry's `package.json` for versions |
| Per-app `package.json` | **No** | Installs deps into consumer's root, doesn't copy `package.json` |
| Programmatic API | Yes | Exported from `dist/api/index.js`. File writing is NOT included: we write files ourselves via Bun. |
| Import rewriting | Yes (automatic, CLI only) | CLI rewrites imports; programmatic API fetches raw content without transformation |

**Key finding**: jsrepo's model is "copy source into your project." It does not natively support isolated per-workspace `package.json` files. The `package.json` in the registry is read for dependency versions but not copied to the consumer.

**Programmatic API surface** (confirmed from `jsrepo@3.6.1` type declarations):
```typescript
import {
  resolveRegistries,       // registry URLs → Map<string, ResolvedRegistry>
  parseWantedItems,        // item names → WantedItem[] (pure string parsing, no network)
  resolveWantedItems,      // WantedItem[] → ResolvedWantedItem[] (matches against manifests)
  resolveAndFetchAllItems, // ResolvedWantedItem[] → RegistryItemWithContent[] (fetches file content)
  fetchManifest,           // Provider → Manifest (low-level: fetch registry.json)
  DEFAULT_PROVIDERS,       // [azure, bitbucket, fs, github, gitlab, http, jsrepo]
} from "jsrepo";
import type { AbsolutePath, RegistryItemWithContent, ItemRepository } from "jsrepo";

// High-level flow:
const registries = await resolveRegistries(["github/myorg/workspaces"], {
  cwd: process.cwd() as AbsolutePath,
  providers: DEFAULT_PROVIDERS,
});
const parsed = parseWantedItems(["my-workspace"], {
  providers: DEFAULT_PROVIDERS,
  registries: ["github/myorg/workspaces"],
});
const resolved = await resolveWantedItems(parsed.value.wantedItems, {
  resolvedRegistries: registries.value,
  nonInteractive: true,
});
const items = await resolveAndFetchAllItems(resolved.value, {
  options: { withExamples: false, withDocs: false, withTests: false },
});
// items.value[n].files[m].content = raw file text
// items.value[n].files[m].path = relative path within item (e.g. "index.ts")
// items.value[n].dependencies = RemoteDependency[] for package.json generation
```

All results use `neverthrow`'s `Result<T, E>`: check `.isErr()` / `.isOk()` before unwrapping. File writing is not in the API. We use `Bun.write()` directly after fetching. This means **no import rewriting happens**, solving the mangling concern without any post-processing.

**Implication**: We should use jsrepo for source distribution but handle `package.json` generation and `bun install` ourselves. The workspace directory layout includes a `package.json` that jsrepo doesn't manage: either we template it during install, or the `epicenter.config.ts` file is self-sufficient (imports only from `@epicenter/workspace` which is already installed globally).

### Better Auth Across Services

Better Auth's JWT plugin issues tokens validated via a JWKS endpoint. Any service can validate locally:

```typescript
const { payload } = await jwtVerify(token, createRemoteJWKSet(
  new URL('https://hub.example.com/api/auth/jwks')
));
```

**Implication**: The local server validates auth once. All workspace routes trust the process boundary: no per-workspace auth needed.

### Yjs Sync as the Shared Data Layer

The existing sync plugin (`packages/server/src/sync/plugin.ts`) is a Y.Doc WebSocket relay. Any client: local WebView, remote web app, CLI: connects to a room and syncs via the standard y-websocket protocol.

**Key finding**: This is already the mechanism for remote data sharing. A hosted version of a workspace at `myapp.com` and the local Epicenter instance can both connect to the same hub room. Yjs handles the merge. No special plumbing needed beyond what exists.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage location | `~/.epicenter/` (configurable via `EPICENTER_HOME`) | Defaults to `~/.epicenter/`: developer-friendly: tab-completable (`~/.ep<tab>`), no spaces in path (unlike `~/Library/Application Support/`), cross-platform (works on macOS, Linux, WSL), follows conventions of `.cargo/`, `.bun/`, `.docker/`. **Configurable**: Set `EPICENTER_HOME=/path/to/dir` to override. CLI also accepts `--home /path/to/dir` on all commands. Resolution order: `--home` flag > `EPICENTER_HOME` env var > `~/.epicenter/`. This enables CI environments, portable installs, and testing against isolated directories. Non-developer users never interact with the filesystem directly: the Tauri app and CLI are the interfaces. **Alternatives considered**: `~/Library/Application Support/Epicenter/` (Apple-sanctioned, Time Machine-backed, but path has spaces, macOS-only, annoying to `cd` into), `~/Documents/Epicenter/` (user-visible, iCloud-synced, but mixes app internals like `node_modules/` and `workspace.yjs` with user content). **Backup implication**: `~/.epicenter/` is excluded from iCloud sync by default and may be skipped by some backup tools. This is acceptable because: (1) the Y.Doc can be reconstructed from hub sync, (2) extensions project user-visible data to backed-up locations like `~/Documents/`, (3) Time Machine does cover dotfiles. |
| Discovery model | Centralized directory + symlinks for dev workspaces | Single `readdir()` scan: no config registry to corrupt or get stale. Installed workspaces live directly in `~/.epicenter/workspaces/`. Developer-authored workspaces (in git repos elsewhere) are symlinked in via `epicenter add <path>`. Avoids the "stale paths in config.json" problem of the distributed model. |
| Filesystem projections | `.withExtension()` on workspace config | Workspaces may need to materialize Y.Doc data to arbitrary filesystem locations (Markdown files, JSON exports, etc.). Extensions are reactive side effects that subscribe to Y.Doc changes and write to a target path. This keeps the core contract clean (schema + actions) and makes materialization opt-in. The workspace directory stays centralized; extensions project *outward*. **This is the key enabler for the `~/.epicenter/` storage decision**: the internal data (Y.Doc, config, deps) lives in a hidden developer-friendly location, while extensions project user-visible output (Markdown, JSON, etc.) to wherever the user wants (`~/Documents/`, `~/notes/`, Obsidian vaults). The workspace doesn't need to *be* in the output directory to *write* to it. |
| Composition mechanism | Shared `createWorkspacePlugin(clients)` via `.use()`, parameterized `/:workspaceId` routes, centralized sync relay for WS | All workspaces share one plugin with parameterized routes (`/workspaces/:workspaceId/tables/:tableName`, etc.). Workspace resolution happens at request time via `workspaces[params.workspaceId]`. This is the current working approach: simple, no per-workspace Elysia instances needed. The SPA never hits HTTP (it uses Y.Doc directly via WebSocket), and the CLI only uses Eden Treaty for ~8 table/KV commands. Per-workspace route prefixes would only improve type discrimination for those few CLI calls: not worth the architectural complexity. `.mount(path, handler.fetch)` reserved for future untrusted third-party code where lifecycle isolation is needed. |
| Process model | Single process | Avoids port management, WebSocket relay, CORS across origins. `mount()` provides logical isolation. |
| Distribution | jsrepo programmatic API for source + custom install step for deps | Use `resolveRegistries()`, `parseWantedItems()`, `resolveWantedItems()`, `resolveAndFetchAllItems()` from `jsrepo`. Write files ourselves via `Bun.write()` (no file-writing in the API). We handle `package.json` generation and `bun install` since jsrepo doesn't support per-app isolation. Programmatic API returns raw file content without import rewriting, so `@epicenter/workspace` imports arrive unmodified. |
| CLI role | Package manager + process launcher | `epicenter install`, `epicenter serve`, `epicenter add`, `epicenter <workspace> <command>`. Not a persistent daemon. |
| Standalone mode | Each workspace can also run via `createLocalServer({ clients: [client] })` | The same `epicenter.config.ts` works mounted or standalone: isomorphic by design. |
| Config portability | `epicenter.config.ts` default export is the builder: no extensions, no actions | The config is the data contract (schema only). Each runtime chains its own extensions and actions. Enables browser SPA to import the config for local-first Y.Doc operations, while the server chains FS extensions and server-only actions. |
| Remote sync | Via hub relay, not a new mechanism | Hosted apps and local apps connect to the same Yjs room on the hub. Already works. |
| Auth boundary | Local server validates; workspace routes trust process | Better Auth JWT validated at the edge. No per-workspace auth layer. |

## Two Runtime Modes

Every workspace has the same storage format on disk. The only question is **how you run it**: in the local server alongside other workspaces, or standalone on its own port. Sync via a Yjs hub is orthogonal: any workspace in either mode can optionally connect to a hub.

### Multi-Workspace (Local Server)

The default. The local server scans `~/.epicenter/workspaces/`, imports each `epicenter.config.ts`, and passes all clients to `createLocalServer({ clients })`. All workspaces share one process, one port, one sync relay, one shared `createWorkspacePlugin`.

```
~/.epicenter/workspaces/epicenter.entries/
├── epicenter.config.ts    # Full source: schema + actions + handlers
├── package.json           # Dependencies (if any)
├── node_modules/          # bun install'd
└── data/
    └── workspace.yjs      # Local Y.Doc (source of truth)
```

**Data flow**: Browser → Y.Doc in memory (via WebSocket sync) → persisted to `workspace.yjs`. The SPA never hits HTTP: it imports the workspace config directly and syncs via `/rooms/:workspaceId`.
**Sync**: Optional. Start the local server with `--hub <url>` to share data with other instances.

This is the "app store" experience. `epicenter install @epicenter/entries` downloads the source, installs deps, and the local server picks it up on next start. You could install 20 apps this way and they all load into the same process, sharing one `createWorkspacePlugin` with parameterized routes.

### Standalone

Any workspace can run independently on its own port:

```bash
epicenter run epicenter.entries --port 4000
epicenter run epicenter.entries --port 4000 --hub wss://hub.example.com
```

The storage format is identical to multi-workspace mode: same directory, same files. The only difference is the process model: one workspace, one port, one server.

This produces an identical API surface to being in the multi-workspace local server: same routes, same sync. The workspace doesn't know or care whether it's the only client or one of twenty.

**Use cases**:
- Development: iterate on a workspace without starting the full local server
- Hosting: deploy a single workspace as a web service
- Embedding: mount the workspace into someone else's Elysia app via `.use()` or `.mount()`

### How Sync Composes Instances

The interesting scenario: the same workspace running in multiple places, all syncing through a hub.

```
Laptop A:  epicenter.entries (local server, --hub wss://hub.example.com)
Laptop B:  epicenter.entries (local server, --hub wss://hub.example.com)
Server:    epicenter.entries (standalone, deployed at entries.example.com, --hub wss://hub.example.com)
```

All three have the full workspace installed. All three run it locally. All three connect to the same Yjs hub room. CRDTs ensure they converge regardless of edit order or network partitions. There's no special "remote" mode. It's just multiple instances of the same workspace syncing via the mechanism Yjs already provides.

## Architecture

### The Local Server

```
┌──────────────────────────────────────────────────────────────┐
│  Elysia Local Server (single process, one port)              │
│                                                              │
│  GET  /                            → list workspaces + info  │
│  WS   /rooms/:room                 → Yjs sync relay          │
│  GET  /openapi                     → OpenAPI docs             │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  /workspaces (shared plugin, parameterized routes):   │  │
│  │                                                        │  │
│  │  GET  /:workspaceId              → workspace metadata  │  │
│  │  GET  /:workspaceId/tables/:t    → list rows           │  │
│  │  GET  /:workspaceId/tables/:t/:id → get row            │  │
│  │  PUT  /:workspaceId/tables/:t/:id → create/replace     │  │
│  │  PATCH /:workspaceId/tables/:t/:id → partial update    │  │
│  │  DELETE /:workspaceId/tables/:t/:id → delete row       │  │
│  │  GET  /:workspaceId/kv/:key      → get KV              │  │
│  │  PUT  /:workspaceId/kv/:key      → set KV              │  │
│  │  DELETE /:workspaceId/kv/:key    → delete KV           │  │
│  │  GET/POST /:workspaceId/actions/:path → query/mutate   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  All workspaces share one plugin. Workspace resolution       │
│  happens at request time: workspaces[params.workspaceId].    │
│  Tables and KV routes are fully static (no loops).           │
│  Action routes are registered once per unique action path    │
│  at construction time.                                       │
└──────────────────────────────────────────────────────────────┘
```

**Why parameterized routes, not per-workspace prefixes**: The SPA never hits HTTP: it imports the workspace config directly, operates on a local Y.Doc, and syncs via WebSocket. The HTTP API exists for the CLI and external clients. The CLI uses Eden Treaty for table/KV CRUD (~8 calls) and raw `fetch` for actions (dynamic paths break Treaty types anyway). Per-workspace prefixes (`/entries/tables/...` instead of `/workspaces/entries/tables/...`) would improve type discrimination for those ~8 CLI calls, but that's not worth creating a separate Elysia instance per workspace. The parameterized approach is simpler, already works, and the type safety that matters (schema validation, action input/output) comes from the workspace client itself, not from the HTTP layer.

### Workspace Directory Layout

Workspaces have two "weights": installed from a registry, or symlinked from a developer's local project. Both have the same directory structure. The root is `$EPICENTER_HOME` (defaults to `~/.epicenter/`, configurable via env var or `--home` flag):

```
$EPICENTER_HOME/                          # Default: ~/.epicenter/
├── config.json                          # Global: registries, default port
│
├── workspaces/
│   │
│   │  # INSTALLED: Downloaded from registry, Epicenter manages lifecycle
│   ├── epicenter.entries/
│   │   ├── epicenter.config.ts          # Default export: WorkspaceClient
│   │   ├── package.json                 # Isolated deps (optional)
│   │   ├── node_modules/               # bun install'd (if package.json exists)
│   │   ├── manifest.json               # jsrepo provenance: registry, version, hash
│   │   └── data/
│   │       └── workspace.yjs           # Persisted Y.Doc
│   │
│   │  # DEVELOPED: Lives in a git repo elsewhere, symlinked in
│   └── my-custom-app -> ~/projects/my-custom-app  # symlink via `epicenter add`
│       ├── epicenter.config.ts          # Developer owns this file
│       ├── package.json
│       └── data/
│           └── workspace.yjs
│
└── cache/                              # jsrepo manifest cache
    └── jsrepo-manifest.json
```

**Discovery is always a single `readdir()`** on `~/.epicenter/workspaces/`. Symlinks are transparent: the local server follows them and imports the `epicenter.config.ts` at the resolved path. If a symlink is broken (developer deleted the project), the local server logs a warning and skips it, same as any other import failure.

**Two CLI commands map to the two weights:**
- `epicenter install <registry/block>` → creates a directory in `workspaces/` (installed)
- `epicenter add <path>` → creates a symlink in `workspaces/` pointing to an existing directory (developed)

### How a Workspace Becomes an App

```
STEP 1: Author writes epicenter.config.ts (DATA CONTRACT: schema only)
──────────────────────────────────────────────────────────────────────
import { createWorkspace, defineTable, defineQuery, defineMutation } from '@epicenter/workspace';

const posts = defineTable({ /* schema */ });

// Default export: the BUILDER (not terminal). No actions, no extensions.
export default createWorkspace({ id: 'my-app', tables: { posts } });

// Optional: export shared action factories for DRY across runtimes
export const coreActions = (c) => ({
  posts: {
    getAll: defineQuery({ handler: () => c.tables.posts.getAllValid() }),
    create: defineMutation({ handler: (input) => c.tables.posts.create(input) }),
  },
});


STEP 2: Each runtime chains extensions + actions as needed
──────────────────────────────────────────────────────────
// Bun sidecar (server): chains extensions AND actions
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace
  .withExtension('persistence', () => filePersistence('./data/workspace.yjs'))
  .withExtension('markdown', () => markdownProjection({ target: '~/notes/' }))
  .withActions((c) => ({
    ...coreActions(c),
    posts: {
      ...coreActions(c).posts,
      deleteAll: defineMutation({ handler: () => c.tables.posts.clear() }),
      exportToCsv: defineMutation({ handler: () => { /* FS write */ } }),
    },
  }));

// Browser SPA: chains only actions (no FS extensions possible)
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace.withActions((c) => ({
  ...coreActions(c),
  // Browser-specific actions if any
}));


STEP 3: Local server loads all clients into shared plugin
─────────────────────────────────────────────────────────
// All workspace clients passed to a single createLocalServer()
// Parameterized routes: /workspaces/:workspaceId/tables/:tableName/...
createLocalServer({ clients: [entriesClient, whisperingClient, ...] });

// Internally, this does:
// new Elysia({ prefix: '/workspaces' }).use(createWorkspacePlugin(clients))
// One shared plugin, workspace resolution at request time.


STEP 4: Sync relay registered centrally
────────────────────────────────────────
// Also inside createLocalServer():
new Elysia({ prefix: '/rooms' }).use(createSyncPlugin({
  getDoc: (room) => {
    // All workspace Y.Docs accessible by room ID
    const client = workspaces[room];
    return client?.ydoc ?? createEphemeralDoc(room);
  },
}));


STEP 5: SPA connects via Yjs sync (local-first, no HTTP for data)
─────────────────────────────────────────────────────────────────
// SPA already has its own Y.Doc from importing the config (Step 2).
// Connect to the Yjs WebSocket room: all data syncs automatically.
ws://localhost:3913/rooms/my-app   → Yjs sync (bidirectional)

// Actions execute locally on the browser's Y.Doc:
client.actions.posts.getAll();     // Local read: zero latency
client.actions.posts.create({});   // Local write: syncs to server via WS

// Server-only actions (deleteAll, exportToCsv) are NOT on the SPA's client.
// The SPA can discover them via awareness protocol and proxy via HTTP if needed.
```

### Standalone Mode (Single Workspace)

Any workspace can run independently. `createLocalServer()` takes a `clients` array of `AnyWorkspaceClient` objects. There is no separate "createWorkspaceServer". A standalone workspace is just `createLocalServer` with a single client.

Since the config exports a builder (not terminal), the standalone runner must chain extensions and actions before passing to `createLocalServer`:

```typescript
// epicenter.standalone.ts (or inline in the CLI's `epicenter run` command)
import { createLocalServer } from '@epicenter/server';
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace
  .withExtension('persistence', () => filePersistence('./data/workspace.yjs'))
  .withActions((c) => coreActions(c));

createLocalServer({ clients: [client], port: 4000 }).start();
```

```bash
# The CLI wraps this pattern:
epicenter run epicenter.entries --port 4000
```

This produces an identical API surface to being in the multi-workspace local server: same routes, same sync. The workspace doesn't know or care whether it's the only client or one of twenty. The only difference between "multi-workspace" and "standalone" is how many clients are in the array passed to `createLocalServer()` and what extensions/actions each runtime chains.

### Remote Sync (Hosted App + Local Data)

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  myapp.com          │     │  Hub Relay        │     │  Local Epicenter    │
│  (hosted workspace) │────▶│  (Yjs WS rooms)  │◀────│  (Bun sidecar)     │
│                     │     │                    │     │                     │
│  Same epicenter     │     │  Room: "my-app"   │     │  Same epicenter     │
│  .config.ts         │     │  Merges via CRDT  │     │  .config.ts         │
└─────────────────────┘     └──────────────────┘     └─────────────────────┘
```

`myapp.com` here is a **standalone hosted workspace**: a specific `epicenter.config.ts` deployed as a cloud service (Phase 5). It is NOT the hub. The hub relay in the middle is the generic `createHubServer()` instance: schema-agnostic, no workspace config, no extensions, no actions. Both `myapp.com` and the local Bun sidecar connect to it as Yjs peers.

Both the hosted version and local instance use the same `epicenter.config.ts` schema. They connect to the same hub room. Yjs CRDTs handle conflict-free merging. No special sync protocol. This is what Yjs already does.

### Third-Party Auth Flow (Login with Epicenter)

When a third-party developer (Alice) hosts a workspace at `myapp.com`, users need to authenticate so the hub knows which room to grant access to. The hub acts as an **OAuth 2.1 / OIDC identity provider** using Better Auth's `oauthProvider` plugin. This is the same pattern as "Log in with Google". The hub is the identity provider, `myapp.com` is the relying party.

**Why this doesn't contradict the "no JWT" auth spec**: The simplified auth spec (`20260223T160300`) eliminates JWT for first-party use: the Tauri app and local sidecar use opaque session tokens because they're same-origin with the hub. Third-party apps are a different threat model: `myapp.com` and `hub.epicenter.com` are different origins. Cookies don't work across origins. The OAuth provider plugin naturally issues JWTs (id_tokens, access_tokens) for cross-origin use. Session tokens for first-party, OAuth JWTs for third-party: no overlap, no contradiction.

**Better Auth's `oauthProvider` plugin provides everything needed out of the box:**

| Endpoint | Path | Purpose |
|---|---|---|
| Authorization | `/oauth2/authorize` | User login + consent |
| Token | `/oauth2/token` | Code → token exchange |
| UserInfo | `/oauth2/userinfo` | User profile data |
| JWKS | `/jwks` | Public keys for token verification |
| Dynamic Client Registration | `/oauth2/register` | Apps register themselves |
| OIDC Discovery | `/.well-known/openid-configuration` | Standard discovery document |
| End Session | `/oauth2/endsession` | RP-initiated logout |

**The complete auth flow:**

```
STEP 1: Alice registers myapp.com as an OAuth client on the hub
────────────────────────────────────────────────────────────────
Option A: CLI         → epicenter register-app myapp.com --redirect https://myapp.com/callback
Option B: Hub admin   → Hub admin UI at hub.epicenter.com/admin
Option C: Dynamic     → POST /oauth2/register (if enabled)

Result: Alice receives client_id + client_secret for myapp.com.


STEP 2: User visits myapp.com and clicks "Log in with Epicenter"
────────────────────────────────────────────────────────────────
Browser redirects to:
  https://hub.epicenter.com/oauth2/authorize
    ?client_id=myapp_abc123
    &redirect_uri=https://myapp.com/callback
    &response_type=code
    &scope=openid+profile+offline_access
    &code_challenge=<PKCE_S256>
    &code_challenge_method=S256


STEP 3: User authenticates on the hub
──────────────────────────────────────
Hub shows login page (if not already logged in) → consent screen.
User grants myapp.com access to their profile + sync rooms.
Hub redirects back:
  https://myapp.com/callback?code=<authorization_code>


STEP 4: myapp.com exchanges the code for tokens
────────────────────────────────────────────────
POST https://hub.epicenter.com/oauth2/token
  grant_type=authorization_code
  &code=<authorization_code>
  &redirect_uri=https://myapp.com/callback
  &client_id=myapp_abc123
  &client_secret=<secret>
  &code_verifier=<PKCE_verifier>

Response:
  {
    "access_token": "<JWT>",       // For hub API access (sync rooms)
    "id_token": "<JWT>",           // User identity (sub, name, email)
    "refresh_token": "<opaque>",   // For token renewal
    "expires_in": 900              // 15 minutes
  }


STEP 5: myapp.com connects to the hub for Yjs sync
───────────────────────────────────────────────────
const provider = new WebsocketProvider(
  'wss://hub.epicenter.com',
  `myapp:${userId}`,             // Room scoped to workspace + user
  workspace.ydoc,
  { params: { token: accessToken } }
);

Hub validates JWT on WebSocket upgrade:
  1. Verify signature via JWKS (local, no DB call)
  2. Check token.sub matches the requested room's user scope
  3. Allow connection → Yjs sync begins


STEP 6: User's local Epicenter is already connected to the same room
────────────────────────────────────────────────────────────────────
The local sidecar (authenticated via session token, not OAuth) connects to:
  wss://hub.epicenter.com/rooms/myapp:user_abc123

Both peers sync via Yjs CRDTs. Data converges automatically.
```

**The full picture:**

```
┌──────────────────┐     ┌──────────────────────────┐     ┌──────────────────┐
│  myapp.com       │     │  Hub                      │     │  User's Desktop  │
│  (Alice's app)   │     │  (hub.epicenter.com)      │     │  (Epicenter app) │
│                  │     │                           │     │                  │
│  epicenter       │     │  Better Auth              │     │  epicenter       │
│  .config.ts      │     │   + oauthProvider plugin  │     │  .config.ts      │
│  (same schema)   │     │                           │     │  (same schema)   │
│                  │     │  /oauth2/authorize         │     │                  │
│  "Log in with    │────▶│  /oauth2/token            │     │  Session token   │
│   Epicenter"     │◀────│  /jwks                    │     │  (first-party)   │
│                  │     │                           │     │                  │
│  access_token    │────▶│  /rooms/myapp:user123     │◀────│  session token   │
│  (OAuth JWT)     │     │  Yjs relay                │     │  (via bearer)    │
└──────────────────┘     └──────────────────────────┘     └──────────────────┘

Both peers sync the same Y.Doc. User sees identical data everywhere.
```

**Room ID scoping**: The room ID encodes both the workspace and the user: `{workspaceId}:{userId}`. This ensures:
- Each user gets their own Y.Doc (no cross-user data leakage)
- The hub can verify room access by checking `token.sub` against the room's user component
- Multiple workspaces for the same user have separate rooms

**Token lifecycle for long-lived WebSocket connections**: Access tokens expire (15 minutes by default). For long-lived WebSocket connections:
1. The SPA monitors token expiry and refreshes via the `refresh_token` grant before expiration
2. On refresh, the SPA disconnects and reconnects the WebSocket with the new access token
3. Yjs handles reconnection gracefully: pending updates queue locally and sync on reconnect
4. Alternative: the hub could accept a token refresh message on the existing WebSocket (optimization for later)

**What Alice (third-party developer) needs:**

| Step | What | How |
|---|---|---|
| 1. Register app | Get OAuth credentials | CLI, admin UI, or dynamic registration |
| 2. Add login button | "Log in with Epicenter" | Standard OAuth redirect (any OAuth library works) |
| 3. Import config | Same `epicenter.config.ts` | `npm install` from jsrepo registry |
| 4. Connect sync | WebSocket to hub with access token | `y-websocket` with `params: { token }` |

Alice doesn't need an Epicenter SDK beyond the standard `@epicenter/workspace` package and any OAuth client library. The hub is a standard OIDC provider: Alice can use `openid-client`, `arctic`, or any OAuth library her framework supports.

**Trust model**: Registering an OAuth client on the hub does NOT give Alice access to user data. The OAuth flow requires explicit user consent. A user must visit `myapp.com`, click "Log in with Epicenter," and approve the consent screen before `myapp.com` can access their sync rooms. The hub enforces room-level access control based on the JWT's `sub` claim.

### The epicenter.config.ts as Universal Contract

The config file is portable across all runtime contexts: server (Bun local server, standalone), browser (Svelte SPA), or edge (Cloudflare Worker). This portability is possible because the config contains only the data contract: schema definitions and a Y.Doc. Actions and extensions are chained per-runtime.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  epicenter.config.ts (DATA CONTRACT: portable, runs anywhere)                    │
│                                                                                   │
│  ┌─────────────┐   ┌──────────────────┐   ┌──────────────────────────────────┐  │
│  │  Schema      │   │  UI Hints        │   │  Shared Action Factories         │  │
│  │  - tables    │   │  - default views  │   │  (optional named exports)        │  │
│  │  - fields    │   │  - column ordering│   │  - coreActions = (c) => ({...}) │  │
│  │  - types     │   │  - display names  │   │  - reusable across runtimes     │  │
│  │  - kv stores │   │                   │   │                                  │  │
│  └─────────────┘   └──────────────────┘   └──────────────────────────────────┘  │
│                                                                                   │
│  Default export: createWorkspace(config) → WorkspaceClientBuilder                │
│  Y.Doc created eagerly. Builder is chainable, NOT terminal.                     │
│  No .withExtension() or .withActions() in the config.                            │
└──────────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │  import workspace   │
                    │  from config        │
                    └──────┬──────────────┘
              ┌────────────┼────────────────────┐
              ▼            ▼                    ▼
┌──────────────────┐ ┌────────────────┐ ┌──────────────────────────┐
│  Bun Sidecar     │ │  Browser SPA   │ │  Standalone Hosted       │
│  (local)         │ │                │ │  Workspace (cloud)       │
│                  │ │                │ │                          │
│  .withExtension  │ │  .withActions  │ │  .withExtension          │
│    persistence   │ │    coreActions │ │    durableObjects        │
│    markdown      │ │               │ │  .withActions            │
│  .withActions    │ │  (no FS deps) │ │    coreActions           │
│    coreActions   │ │               │ │    sendWebhook           │
│    deleteAll     │ │               │ │    notifyEmail           │
│    exportToCsv   │ │               │ │                          │
└──────────────────┘ └────────────────┘ └──────────────────────────┘
         │                  │                        │
         └──────────────────┼────────────────────────┘
                            ▼
                  Yjs sync (all converge on same data)
                  Awareness (each peer advertises its actions)
```

**Note on the three columns above**: These are all consumers of `epicenter.config.ts`: each imports the builder and chains runtime-specific extensions and actions. The **hub server is not shown here** because it never imports workspace configs. The hub is a separate process that all three columns connect to as Yjs peers. "Standalone Hosted Workspace" (right column) is a `createLocalServer()` instance running in the cloud: a local server deployed remotely, not the hub.

**Three layers, three portability levels:**
- **Schema** (in config): Universal. Must be identical everywhere for Yjs sync to work.
- **Actions** (per-runtime): Context-dependent. Different runtimes expose different capabilities. Shared action factories (named exports) prevent duplication for common CRUD.
- **Extensions** (per-runtime): Environment-specific. FS projections on server, IndexedDB persistence in browser, Durable Objects on edge.

**Why this works**: `createWorkspace()` eagerly creates a `Y.Doc`. The builder uses immutable state, so branching is safe: multiple runtimes can chain different extensions/actions from the same base without interference. Each import in a different process creates a fresh Y.Doc. Yjs sync handles convergence.

**Awareness as action discovery**: Each peer can advertise its available actions via the Yjs awareness protocol. The SPA sees that the Bun sidecar has `deleteAll` and `exportToCsv`, and can proxy those calls via HTTP. The user sees all capabilities across the network, even actions that only run on the server.

**Browser import pattern**: The Svelte SPA imports the config, chains its own actions, and operates on a local Y.Doc synced via WebSocket. Zero HTTP round-trips for data operations. The HTTP API layer becomes optional: useful for non-browser clients (CLI, curl) and for proxying server-only actions, but not required for the SPA's own data path.

## Implementation Plan

### Configurable Home Directory

All commands resolve `EPICENTER_HOME` before doing anything:

```typescript
// packages/cli/src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolution order: --home flag > EPICENTER_HOME env > ~/.epicenter/ */
export function resolveEpicenterHome(flagValue?: string): string {
  return flagValue ?? Bun.env.EPICENTER_HOME ?? join(homedir(), ".epicenter");
}

export function workspacesDir(home: string): string {
  return join(home, "workspaces");
}

export function cacheDir(home: string): string {
  return join(home, "cache");
}
```

The `--home` global option is registered at the yargs root level so every command inherits it:

```bash
# All equivalent:
epicenter ls                                        # uses ~/.epicenter/
EPICENTER_HOME=/tmp/test epicenter ls               # uses /tmp/test/
epicenter --home /tmp/test ls                       # uses /tmp/test/
```

### CLI Command Reference (After All Phases)

```
PACKAGE MANAGEMENT
  epicenter install <registry/block>     Download workspace from jsrepo registry
  epicenter add <path>                   Symlink a local workspace directory
  epicenter uninstall <workspace-id>     Remove workspace (delete dir or unlink)
  epicenter update <workspace-id>        Re-fetch from registry, preserve data/
  epicenter ls                           List all workspaces (filesystem, no server)
  epicenter export <workspace-id>        Export workspace data as JSON/CSV

SERVER
  epicenter serve [--port 3913]          Start local server (all workspaces)
  epicenter run <id> [--port N]          Run single workspace standalone
    --hub <url>                            Connect to hub relay for sync

WORKSPACE CRUD (requires running server)
  epicenter <ws> tables                  List tables
  epicenter <ws> <table> list            List rows
  epicenter <ws> <table> get <id>        Get row
  epicenter <ws> <table> set <id> [json] Create/replace row
  epicenter <ws> <table> update <id>     Partial update
  epicenter <ws> <table> delete <id>     Delete row
  epicenter <ws> kv get|set|delete <key> KV operations
  epicenter <ws> action <path> [json]    Invoke action

GLOBAL OPTIONS
  --home <path>                          Override EPICENTER_HOME
  --format json|jsonl                    Output format
  --help                                 Show help
  --version                              Show version
```

### Step 1: Foundation: `resolveEpicenterHome` + Discovery Rewrite

**What changes**: Create `packages/cli/src/paths.ts`. Rewrite `packages/cli/src/discovery.ts` to scan `$EPICENTER_HOME/workspaces/` instead of arbitrary `--dir` paths.

**Files to create**:
- `packages/cli/src/paths.ts`: `resolveEpicenterHome()`, `workspacesDir()`, `cacheDir()`

**Files to modify**:
- `packages/cli/src/discovery.ts`: replace `discoverAllWorkspaces(dirs)` with `discoverWorkspaces(home)` that does a single `readdir()` on `workspacesDir(home)` with `{ withFileTypes: true }`, follows symlinks, imports each `epicenter.config.ts`
- `packages/cli/src/cli.ts`: add `--home` global option, thread through to discovery and commands

**Exact Bun APIs**:
```typescript
import { readdir, lstat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";

// Ensure home exists on first use
await mkdir(workspacesDir(home), { recursive: true });

// Discover all workspaces
const dirents = await readdir(workspacesDir(home), { withFileTypes: true });
for (const dirent of dirents) {
  const fullPath = join(workspacesDir(home), dirent.name);
  const configPath = join(fullPath, "epicenter.config.ts");
  const configExists = await Bun.file(configPath).exists();
  if (!configExists) { /* warn and skip */ continue; }

  try {
    const mod = await import(Bun.pathToFileURL(configPath).href);
    clients.push({ ...mod.default, _meta: { path: fullPath, isSymlink: dirent.isSymbolicLink() } });
  } catch (err) {
    console.error(`Failed to load ${dirent.name}: ${err}`);
    // continue loading other workspaces
  }
}
```

**Success criteria**: `epicenter serve` (no `--dir`) discovers workspaces from `~/.epicenter/workspaces/`. The `--dir` flag still works as a fallback (deprecated, not removed yet).

- [x] **1.1** Create `packages/cli/src/paths.ts` with `resolveEpicenterHome()`, `workspacesDir()`, `cacheDir()`
- [x] **1.2** Rewrite `discoverAllWorkspaces()` in `packages/cli/src/discovery.ts` to scan `workspacesDir(home)` via `readdir({ withFileTypes: true })`
- [x] **1.3** Add `--home` global yargs option in `packages/cli/src/cli.ts`, thread to all commands
- [x] **1.4** Graceful failure: `try/catch` around each workspace import, log error, continue loading others
- [x] **1.5** Ensure `mkdir(workspacesDir(home), { recursive: true })` on first use (idempotent)

### Step 2: `epicenter add <path>`: Symlink Registration

**What changes**: New command file. Simplest package manager command: validates path, creates symlink.

**Files to create**:
- `packages/cli/src/commands/add-command.ts`

**Files to modify**:
- `packages/cli/src/cli.ts`: register `buildAddCommand(home)` in tier 1 (non-workspace-scoped)

**Exact implementation**:
```typescript
import { symlink, lstat } from "node:fs/promises";
import { resolve, basename } from "node:path";

export function buildAddCommand(home: string): CommandModule {
  return {
    command: "add <path>",
    describe: "Symlink a local workspace into Epicenter",
    builder: (yargs) => yargs.positional("path", { type: "string", demandOption: true }),
    handler: async (argv) => {
      const targetPath = resolve(argv.path as string);
      const configPath = join(targetPath, "epicenter.config.ts");

      if (!(await Bun.file(configPath).exists())) {
        outputError(`No epicenter.config.ts found at ${targetPath}`);
        process.exitCode = 1;
        return;
      }

      // Import to get the workspace ID
      const mod = await import(Bun.pathToFileURL(configPath).href);
      const workspaceId = mod.default.id;
      const linkPath = join(workspacesDir(home), workspaceId);

      // Check for existing
      try {
        await lstat(linkPath);
        outputError(`Workspace "${workspaceId}" already exists at ${linkPath}`);
        process.exitCode = 1;
        return;
      } catch { /* doesn't exist: good */ }

      await symlink(targetPath, linkPath);
      output({ added: workspaceId, path: targetPath, link: linkPath });
    },
  };
}
```

**Success criteria**: `epicenter add ~/projects/my-workspace` creates symlink at `~/.epicenter/workspaces/my-workspace`, and `epicenter serve` discovers it.

- [x] **2.1** Create `packages/cli/src/commands/add-command.ts` with `buildAddCommand(home)`
- [x] **2.2** Validate `epicenter.config.ts` exists at target path before symlinking
- [x] **2.3** Use workspace ID from config as the symlink name (not directory basename)
- [x] **2.4** Error if a workspace with that ID already exists
- [x] **2.5** Register in `cli.ts` as a tier-1 command

### Step 3: `epicenter ls`: Filesystem Listing

**What changes**: New command. Reads `~/.epicenter/workspaces/` directly (no running server needed).

**Files to create**:
- `packages/cli/src/commands/ls-command.ts`

**Exact implementation**:
```typescript
import { readdir, lstat, readlink } from "node:fs/promises";

export function buildLsCommand(home: string): CommandModule {
  return {
    command: "ls",
    describe: "List installed workspaces",
    builder: (yargs) => yargs.options(formatYargsOptions()),
    handler: async (argv) => {
      const dir = workspacesDir(home);
      const dirents = await readdir(dir, { withFileTypes: true });
      const workspaces = [];

      for (const dirent of dirents) {
        const fullPath = join(dir, dirent.name);
        const isSymlink = dirent.isSymbolicLink();
        const configExists = await Bun.file(join(fullPath, "epicenter.config.ts")).exists();
        const hasManifest = await Bun.file(join(fullPath, "manifest.json")).exists();

        workspaces.push({
          id: dirent.name,
          type: isSymlink ? "linked" : "installed",
          path: isSymlink ? await readlink(fullPath) : fullPath,
          status: configExists ? "ok" : "error",
          registry: hasManifest ? JSON.parse(await Bun.file(join(fullPath, "manifest.json")).text()).registry : null,
        });
      }

      output(workspaces, { format: argv.format as any });
    },
  };
}
```

**Output example**:
```json
[
  { "id": "epicenter.entries", "type": "installed", "path": "~/.epicenter/workspaces/epicenter.entries", "status": "ok", "registry": "github/epicenter-dev/workspaces" },
  { "id": "my-journal", "type": "linked", "path": "/Users/braden/projects/my-journal", "status": "ok", "registry": null }
]
```

- [x] **3.1** Create `packages/cli/src/commands/ls-command.ts` with `buildLsCommand(home)`
- [x] **3.2** Show type (installed/linked), status (ok/error), path, and registry source
- [x] **3.3** Handle broken symlinks gracefully (status: "error", message: "symlink target not found")
- [x] **3.4** Register in `cli.ts` as tier-1 command

### Step 4: Update `epicenter serve`: Use New Discovery

**What changes**: Modify the existing `serve` command to use `discoverWorkspaces(home)` instead of `discoverAllWorkspaces(dirs)`. Deprecate `--dir` (keep it working with a warning).

**Files to modify**:
- `packages/cli/src/cli.ts`: `buildServeCommand()` uses `resolveEpicenterHome(argv.home)` and calls new discovery

**Before → After**:
```typescript
// BEFORE (current)
builder: (yargs) => yargs.option("dir", { type: "array", default: [process.cwd()] }),
handler: async (argv) => {
  const clients = await discoverAllWorkspaces(argv.dir);
  // ...
}

// AFTER
builder: (yargs) => yargs
  .option("dir", { type: "array", deprecated: "Use epicenter add <path> instead" })
  .option("home", { type: "string", describe: "Override EPICENTER_HOME" }),
handler: async (argv) => {
  const home = resolveEpicenterHome(argv.home);
  const clients = argv.dir
    ? await discoverAllWorkspaces(argv.dir)  // legacy fallback
    : await discoverWorkspaces(home);
  // ...
}
```

- [x] **4.1** Update `buildServeCommand()` to default to `discoverWorkspaces(home)` instead of `discoverAllWorkspaces(dirs)`
- [x] **4.2** Deprecate `--dir` with a console warning, keep it functional as fallback
- [x] **4.3** Add `--home` option to serve command

### Step 5: `epicenter install <registry/block>`: jsrepo Integration

**What changes**: The largest new command. Fetches workspace source from jsrepo, writes to disk, generates `package.json`, runs `bun install`.

**Files to create**:
- `packages/cli/src/commands/install-command.ts`

**Dependencies**: `jsrepo` (already in `packages/cli/package.json` or add it)

**Exact flow using grounded jsrepo API**:
```typescript
import {
  resolveRegistries, parseWantedItems, resolveWantedItems,
  resolveAndFetchAllItems, DEFAULT_PROVIDERS,
} from "jsrepo";
import type { AbsolutePath, RemoteDependency } from "jsrepo";
import { $ } from "bun";

async function installWorkspace(registryUrl: string, itemName: string, home: string) {
  const cwd = process.cwd() as AbsolutePath;

  // 1. Resolve registry
  const registriesResult = await resolveRegistries([registryUrl], {
    cwd, providers: DEFAULT_PROVIDERS,
  });
  if (registriesResult.isErr()) throw registriesResult.error;

  // 2. Parse + resolve wanted items
  const parsed = parseWantedItems([itemName], {
    providers: DEFAULT_PROVIDERS, registries: [registryUrl],
  });
  if (parsed.isErr()) throw parsed.error;

  const resolved = await resolveWantedItems(parsed.value.wantedItems, {
    resolvedRegistries: registriesResult.value, nonInteractive: true,
  });
  if (resolved.isErr()) throw resolved.error;

  // 3. Fetch all file content
  const items = await resolveAndFetchAllItems(resolved.value, {
    options: { withExamples: false, withDocs: false, withTests: false },
  });
  if (items.isErr()) throw items.error;

  const item = items.value[0];
  const wsDir = join(workspacesDir(home), item.name);
  await mkdir(wsDir, { recursive: true });
  await mkdir(join(wsDir, "data"), { recursive: true });

  // 4. Write files via Bun.write()
  for (const file of item.files) {
    const filePath = join(wsDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, file.content);
  }

  // 5. Generate package.json from item dependencies
  const deps: Record<string, string> = {};
  for (const dep of (item.dependencies ?? []) as RemoteDependency[]) {
    deps[dep.name] = dep.version ?? "latest";
  }
  if (Object.keys(deps).length > 0) {
    const pkg = { name: item.name, private: true, dependencies: deps };
    await Bun.write(join(wsDir, "package.json"), JSON.stringify(pkg, null, 2));
    await $`bun install`.cwd(wsDir).quiet();
  }

  // 6. Write manifest.json with provenance
  const manifest = {
    registry: registryUrl,
    item: item.name,
    installedAt: new Date().toISOString(),
    files: item.files.map((f) => f.path),
  };
  await Bun.write(join(wsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
```

- [x] **5.1** Create `packages/cli/src/commands/install-command.ts` with `buildInstallCommand(home)`
- [x] **5.2** Use `resolveRegistries()` → `parseWantedItems()` → `resolveWantedItems()` → `resolveAndFetchAllItems()` pipeline
- [x] **5.3** Write files via `Bun.write()`, ensure parent dirs exist with `mkdir({ recursive: true })`
- [x] **5.4** Generate `package.json` from `item.dependencies` (RemoteDependency[])
- [x] **5.5** Run `bun install` via `$\`bun install\`.cwd(wsDir).quiet()` if `package.json` was generated
- [x] **5.6** Write `manifest.json` with registry, item name, timestamp, file list
- [x] **5.7** Create empty `data/` directory for future `workspace.yjs` persistence
- [x] **5.8** Error if workspace ID already exists in `workspacesDir(home)`

### Step 6: `epicenter run <id>`: Standalone Mode

**What changes**: New command. Imports a single workspace, chains standard extensions, calls `createLocalServer({ clients: [client] })`.

**Files to create**:
- `packages/cli/src/commands/run-command.ts`

**Implementation sketch**:
```typescript
export function buildRunCommand(home: string): CommandModule {
  return {
    command: "run <workspace-id>",
    describe: "Run a single workspace as a standalone server",
    builder: (yargs) => yargs
      .positional("workspace-id", { type: "string", demandOption: true })
      .option("port", { type: "number", default: 4000 })
      .option("hub", { type: "string", describe: "Hub URL for Yjs sync" }),
    handler: async (argv) => {
      const wsId = argv["workspace-id"] as string;
      const wsPath = join(workspacesDir(home), wsId);
      const configPath = join(wsPath, "epicenter.config.ts");

      if (!(await Bun.file(configPath).exists())) {
        outputError(`Workspace "${wsId}" not found`);
        process.exitCode = 1;
        return;
      }

      const mod = await import(Bun.pathToFileURL(configPath).href);
      const builder = mod.default; // WorkspaceClientBuilder

      // Chain standard server extensions
      const { filePersistence } = await import("@epicenter/server/extensions");
      const client = builder
        .withExtension("persistence", () => filePersistence(join(wsPath, "data", "workspace.yjs")));

      // If coreActions exported, chain them
      if (mod.coreActions) {
        client = client.withActions(mod.coreActions);
      }

      const { createLocalServer } = await import("@epicenter/server");
      const server = createLocalServer({
        clients: [client],
        port: argv.port as number,
        ...(argv.hub ? { hub: argv.hub as string } : {}),
      });

      console.log(`Running ${wsId} on http://localhost:${argv.port}`);
      await server.start();
    },
  };
}
```

- [x] **6.1** Create `packages/cli/src/commands/run-command.ts` with `buildRunCommand(home)`
- [ ] **6.2** _(deferred: filePersistence extension not yet implemented: Step 9)_ Import workspace config, chain `filePersistence` extension for `data/workspace.yjs`
- [ ] **6.3** _(deferred: coreActions chaining depends on convention adoption)_ Chain `coreActions` if exported from config
- [x] **6.4** Pass `--hub` URL to `createLocalServer` for optional Yjs hub sync
- [x] **6.5** Register as tier-1 command in `cli.ts`

### Step 7: `epicenter uninstall`, `update`, `export`

These are smaller commands that build on the foundation from Steps 1-6.

**`uninstall`**: Check if symlink → `unlink()`, else `rm -rf` the directory. Confirm before deleting data.
```typescript
import { rm, unlink, lstat } from "node:fs/promises";

const stat = await lstat(wsPath);
if (stat.isSymbolicLink()) {
  await unlink(wsPath);  // just removes symlink, not target
} else {
  await rm(wsPath, { recursive: true, force: true });
}
```

**`update`**: Read `manifest.json` for registry source, re-run install flow, but preserve `data/` directory.

**`export`**: Import workspace config, read Y.Doc from `data/workspace.yjs`, iterate tables, output as JSON/CSV.

- [x] **7.1** Create `packages/cli/src/commands/uninstall-command.ts`
- [ ] **7.2** Create `packages/cli/src/commands/update-command.ts`
- [x] **7.3** Create `packages/cli/src/commands/export-command.ts`
- [x] **7.4** `uninstall`: distinguish symlink vs directory, confirm before data deletion
- [ ] **7.5** `update`: read `manifest.json` for provenance, re-fetch, preserve `data/`
- [x] **7.6** `export`: load Y.Doc from disk, iterate `getAllValid()` per table, output via `output()`

### Step 8: Wire Discovery into Server Package

**What changes**: Move the discovery function from `packages/cli/` to `packages/server/` (or a shared `packages/discovery/`) so both the CLI and the Tauri sidecar can use it.

- [ ] **8.1** Extract `discoverWorkspaces(home)` to a shared location importable by both `@epicenter/cli` and the Tauri sidecar
- [ ] **8.2** `createLocalServer()` optionally accepts a `home` path and discovers workspaces itself (alternative to passing `clients` array directly)
- [ ] **8.3** Serve Svelte SPA via `@elysiajs/static` with `indexHTML: true` for SPA fallback
- [ ] **8.4** Wire Tauri sidecar to use `resolveEpicenterHome()` and spawn the local server

### Step 9: Workspace Extensions (Filesystem Projections)

Extensions allow workspaces to reactively materialize Y.Doc data to arbitrary filesystem locations. This is how a workspace writes Markdown files, JSON exports, or any other file-based output without requiring the workspace itself to live in the output directory.

- [ ] **9.1** Define the `.withExtension()` API on the workspace builder: extensions receive access to the workspace's Y.Doc observation lifecycle and a target path
- [ ] **9.2** Implement `filePersistence` as the first built-in extension: binary snapshot of Y.Doc to `data/workspace.yjs`
- [ ] **9.3** Implement `markdownProjection`: subscribes to `observeDeep` on a table's Y.Map, diffs changes, writes/deletes `.md` files at the target path
- [ ] **9.4** Wire extension lifecycle into the local server: start extensions on workspace load, stop on shutdown
- [ ] **9.5** Support multiple extensions per workspace
- [ ] **9.6** Handle extension errors gracefully: log, expose status, don't crash the process

### Step 10: Third-Party Auth (Login with Epicenter)

- [ ] **10.1** Enable Better Auth's `oauthProvider` plugin on the hub: adds `/oauth2/authorize`, `/oauth2/token`, `/jwks`, `/.well-known/openid-configuration`, `/oauth2/userinfo` endpoints
- [ ] **10.2** Add `epicenter register-app <domain> --redirect <uri>` CLI command
- [ ] **10.3** Add room-level access control on WebSocket upgrade: validate OAuth JWT via JWKS, check `token.sub` matches room's user scope
- [ ] **10.4** Add consent screen UI on the hub
- [ ] **10.5** Document the third-party developer integration guide

**Example API:**

Since the config exports the builder (not terminal), each runtime chains extensions and actions independently. `.withActions()` is terminal: extensions must come before actions in the chain.

```typescript
// epicenter.config.ts: DATA CONTRACT (builder, no extensions, no actions)
export default createWorkspace({ id: 'journal', tables: { entries } });

export const coreActions = (c) => ({
  entries: {
    getAll: defineQuery({ handler: () => c.tables.entries.getAllValid() }),
    create: defineMutation({ handler: (input) => c.tables.entries.create(input) }),
  },
});

// Bun sidecar: chains extensions + actions
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace
  .withExtension('persistence', () => filePersistence('./data/workspace.yjs'))
  .withExtension('markdown-notes', () => markdownProjection({
    target: '~/notes/journal/',
    table: 'entries',
    filename: (entry) => `${entry.date}.md`,
    render: (entry) => entry.body,
  }))
  .withExtension('markdown-obsidian', () => markdownProjection({
    target: '~/obsidian-vault/journal/',
    table: 'entries',
    filename: (entry) => `${entry.date}.md`,
    render: (entry) => entry.body,
  }))
  .withActions((c) => ({
    ...coreActions(c),
    entries: {
      ...coreActions(c).entries,
      deleteAll: defineMutation({ handler: () => c.tables.entries.clear() }),
    },
  }));
```

**Key insight**: The workspace stays centralized in `~/.epicenter/workspaces/`. Extensions project *outward* to wherever the user wants output. The config exports a builder (not terminal), so every runtime: browser SPA, Bun sidecar, standalone hosted workspace: chains exactly the extensions and actions it needs. This cleanly separates "what the data looks like" (config) from "what you can do with it" (per-runtime).

## Hard Problems

These are the genuinely difficult parts of this architecture. Everything else is plumbing.

### 1. Schema Evolution After Updates

When a workspace is updated via `epicenter update`, the new `epicenter.config.ts` may add/remove tables or change field types. The persisted `workspace.yjs` still has the old schema's data. Yjs is schema-tolerant: old fields remain, new fields get defaults. But `getAllValid()` may filter out stale rows.

When two instances of the same workspace sync via hub and one updates to a newer schema version, they'll briefly disagree on the schema. This is fine: Yjs doesn't care about schema, and both instances render what their local schema understands. Unknown fields are preserved in the Y.Doc but not displayed.

**Recommendation**: Accept drift for v1. The SPA should handle unknown fields gracefully since `getAllValid()` already filters by the current schema.

### 2. Process Isolation at Scale

The local server runs all workspaces in a single Bun process. This is fine for personal use: each Y.Doc is KB to low MB, Yjs sync is cheap, and the scale is 20 workspaces on one laptop, not a multi-tenant server. Installing a third-party workspace is the same trust model as `npm install`: you're already trusting that code with full access to your machine. Process isolation doesn't change that.

**Recommendation**: Single process. Isolation becomes relevant only if Epicenter serves multiple untrusted tenants in a shared process: a product direction not currently planned.

### 3. The "20 Apps" UI Problem

If you have 20 workspaces mounted, the Svelte shell needs to render a coherent UI across all of them. Currently, each workspace gets a generic table/KV browser. But workspaces might want custom UI:

- A journal app wants a timeline view
- A bookmark manager wants a card grid
- A kanban board wants columns with drag-and-drop

**The tension**: The local server serves a single SPA. Custom per-workspace UI means either:
- The SPA is a generic shell that renders all workspaces as tables (current approach, boring but works)
- Workspaces can ship their own Svelte components (powerful but complex: code loading, security, bundle size)
- Workspaces define "views" declaratively (column layouts, card templates) that the SPA interprets

**Recommendation**: Generic table shell for v1. Explore declarative view definitions for v2 (a workspace's config could include `views: [{ type: 'kanban', groupBy: 'status' }]`). Custom Svelte components are a v3 concern: they require a plugin sandbox and dramatically increase complexity.

## Edge Cases

### Workspace with External Dependencies

1. A workspace's `epicenter.config.ts` imports from `nanoid` or another npm package.
2. The workspace directory needs its own `package.json` with that dependency listed.
3. `epicenter install` must run `bun install` in the workspace directory after downloading source.
4. If `package.json` is missing, the workspace can only import from `@epicenter/workspace` (globally available).

### Duplicate Workspace IDs

1. User installs two workspaces that both export `id: 'my-app'`.
2. The local server must detect this at load time and fail with a clear error.
3. Already handled by `discoverAllWorkspaces()` in `packages/cli/src/discovery.ts:88-95`.

### Workspace Crashes During Import

1. A workspace's `epicenter.config.ts` throws on import (syntax error, missing dep).
2. The local server should log the error and continue loading other workspaces.
3. The failed workspace appears in the workspace listing as `{ status: 'error', message: '...' }`.

### Schema Evolution After Update

1. User runs `epicenter update my-app`, which replaces `epicenter.config.ts` with a new version.
2. The new schema may add/remove tables or change field types.
3. The persisted `workspace.yjs` still has the old schema's data.
4. Yjs is schema-tolerant: old fields remain in the Y.Doc, new fields get defaults. But `getAllValid()` may filter out stale rows. This is the existing behavior and is acceptable.

### Data Trapped in Hidden Y.Doc (No Extensions Configured)

1. Non-technical user installs a journal workspace via the Tauri app.
2. They write 200 journal entries over 6 months.
3. They uninstall Epicenter, or their machine dies, or they want to export their data.
4. All 200 entries are in `~/.epicenter/workspaces/journal/data/workspace.yjs`: a binary CRDT file that no other app can read.
5. **Mitigations**: (a) The Tauri app should always offer an "Export" button that dumps table data as JSON/CSV/Markdown, independent of extensions. (b) If hub sync is configured, the data exists on the hub and can be recovered. (c) `epicenter export <workspace-id> --format json` as a CLI escape hatch. (d) Workspace authors can use `.withExtension()` to project data to user-visible locations.
6. **Principle**: The Y.Doc is the source of truth, but it must never be the *only* copy of user data in a human-readable format. At minimum, export must always be available via the app UI and CLI.

### Broken Symlink (Developed Workspace Removed)

1. Developer runs `epicenter add ~/projects/my-app`, creating a symlink in `~/.epicenter/workspaces/my-app`.
2. Developer deletes or moves `~/projects/my-app`.
3. The symlink is now dangling. `readdir()` still returns it, but `readFileSync` on the target fails.
4. The local server should detect this (same codepath as "Workspace Crashes During Import"), log a warning, and skip. The workspace appears in `epicenter ls` as `{ status: 'error', message: 'symlink target not found' }`.
5. `epicenter remove my-app` cleans up the dangling symlink.

### jsrepo Import Rewriting

1. jsrepo automatically rewrites imports in downloaded files.
2. This could mangle `@epicenter/workspace` imports or workspace-specific relative imports.
3. Options: (a) disable watermark + import rewriting via jsrepo config, (b) post-process to restore expected imports, (c) use jsrepo's raw fetch mode to skip transformations.

## Resolved Questions

These were open during design and have been decided. Kept here for context so implementing agents understand the reasoning.

1. **Where should workspaces be stored?**
   - **Decision**: `~/.epicenter/workspaces/` (centralized dotfile directory). See "Storage location" and "Discovery model" in Design Decisions.
   - **Alternatives rejected**: `~/Library/Application Support/Epicenter/` (path has spaces, macOS-only), `~/Documents/Epicenter/` (mixes app internals with user content), distributed paths in `config.json` (stale path problem, single point of failure).
   - **Key enabler**: The extension/projection system means user-visible data doesn't need to live *in* `~/.epicenter/`: it gets projected outward to user-chosen locations.

2. **How should developer-authored workspaces (in git repos) be registered?**
   - **Decision**: `epicenter add <path>` creates a symlink in `~/.epicenter/workspaces/`. The local server follows symlinks transparently. Broken symlinks are handled the same as import failures.
   - **Alternative rejected**: Path registry in `config.json` (corrupts, gets stale, requires validation on every startup).

3. **Where do non-technical users see their data?**
   - **Decision**: Extensions (`.withExtension()`) project Y.Doc data outward to user-visible locations (`~/Documents/`, Obsidian vaults, etc.). The Y.Doc in `~/.epicenter/` is internal plumbing: users interact with projected output or the Tauri app UI. Export via app UI and CLI is always available as a fallback.

4. **What happens to the current `createWorkspacePlugin` approach?**
   - **Decision**: Keep it. The shared parameterized approach (`/workspaces/:workspaceId/...`) stays. The only change is where the `clients` array comes from: currently hardcoded, moving to dynamic discovery from `~/.epicenter/workspaces/`. Per-workspace Elysia instances with dedicated prefixes were considered but rejected: the SPA never hits HTTP (it uses Y.Doc directly via WebSocket), and Eden Treaty type discrimination for the CLI's ~8 table/KV calls isn't worth the architectural complexity.

5. **How should workspace-specific dependencies be managed?**
   - **Decision**: Each workspace has its own `package.json` + `node_modules/`. Bun installs are fast (~100ms) and disk is cheap. This gives maximum flexibility: workspaces can import any npm package, not just `@epicenter/workspace`.
   - **Alternative rejected**: Restricting workspaces to only import from `@epicenter/workspace` (too limiting: workspaces that call external APIs, use crypto libraries, etc. need their own deps).

6. **Should the CLI shell out to `jsrepo add` or use the programmatic API?**
   - **Decision**: Use jsrepo's programmatic API exported from `jsrepo` (`resolveRegistries()`, `parseWantedItems()`, `resolveWantedItems()`, `resolveAndFetchAllItems()`). File writing is not in the API: we write files via `Bun.write()` directly, which means no import rewriting occurs.
   - **Why programmatic over shelling out**: (a) We need custom post-processing anyway (generate `package.json`, run `bun install`, write `manifest.json` with provenance). (b) Avoids the import rewriting edge case: jsrepo's CLI automatically rewrites imports, which could mangle `@epicenter/workspace` paths. Programmatic control lets us skip that. (c) No subprocess overhead, error handling stays in-process.
   - **Alternative rejected**: Shelling out to `jsrepo add` via `Bun.$` (viable but gives less control over the install flow, and the import rewriting problem requires post-processing to fix anyway).

7. **How should the hub relay authorize room access?**
   - **Decision**: User-level auth via Better Auth JWT. The hub validates the JWT on WebSocket upgrade and checks room-level permissions (which workspaces has this user been granted access to?).
   - **Why**: Both self-hosted and Cloudflare-hosted hubs support Better Auth. Using the same auth system everywhere means one mechanism, one codebase, one login flow: regardless of whether the hub is local or remote. No separate token issuance or distribution needed.
   - **Alternative rejected**: Room-level access tokens (creates a "who issues the token and how does it reach the other instance" problem, introduces a second auth system alongside Better Auth).

8. **Should `epicenter.config.ts` be portable across browser and server?**
   - **Decision**: Yes. The config's default export is a `WorkspaceClientBuilder` (result of `createWorkspace()`: not terminal). It contains NO extensions, NO actions, and NO server-only dependencies. This allows any runtime to import it and chain its own extensions and actions.
   - **Why**: `createWorkspace()` eagerly creates a Y.Doc, and Yjs is fully isomorphic (runs in browser, Bun, Deno, edge). The builder uses immutable state, so branching is safe: multiple runtimes chain different things from the same base. Actions are context-dependent (a Bun sidecar might expose `deleteAll` and `exportToCsv` that the browser SPA shouldn't have). Extensions are environment-specific (FS projections on server, IndexedDB in browser).
   - **Implication**: Neither `.withExtension()` nor `.withActions()` appear in the config. The config is purely the data contract (schema). Shared action factories can be exported as named exports for DRY across runtimes.
   - **Alternative rejected**: Putting actions in the config (forces all runtimes to have identical capabilities, prevents server-only or browser-only actions).

9. **Should per-workspace route prefixes replace parameterized routes?**
   - **Decision**: No. Keep the shared `createWorkspacePlugin` with parameterized `/:workspaceId` routes.
   - **Why**: Per-workspace prefixes (`/entries/tables/...` instead of `/workspaces/entries/tables/...`) would require a separate Elysia instance per workspace. The only benefit is Eden Treaty type discrimination: knowing at the type level that `entries` has a `posts` table vs `whispering` has a `recordings` table. But: (a) the SPA never hits HTTP at all: it uses Y.Doc directly, (b) the CLI uses Eden Treaty for only ~8 table/KV commands, and already uses raw `fetch` for actions (dynamic paths break Treaty types), (c) the type safety that matters (schema validation, action input/output) comes from the workspace client itself, not the HTTP layer. The parameterized approach is simpler, already works, and avoids creating N Elysia instances at startup.
   - **`.mount()` note**: The `.mount()` vs `.use()` research (see Research Findings) remains relevant for future untrusted third-party workspaces that need lifecycle isolation. For first-party workspaces, both are `.use()`'d: the question is just whether it's one shared plugin or N separate instances. Answer: one shared plugin.

## Open Questions

1. **How should awareness advertise per-runtime actions?**
   - Each runtime has different actions available (SPA has CRUD, Bun sidecar has CRUD + FS operations). The SPA should be able to discover and proxy server-only actions.
   - Option A: Each peer broadcasts its action list via Yjs awareness protocol. The SPA shows server-only actions as "available via server" and proxies calls via HTTP.
   - Option B: The `/registry` endpoint includes the server's full action list. The SPA knows which actions it has locally and which require HTTP proxy.
   - Option C: Both: awareness for real-time capability discovery (peer goes offline = actions disappear), registry for static discovery.
   - **Leaning toward Option C**: awareness handles the dynamic case (which peers are online and what can they do), registry handles the static case (what does this workspace support in general).

2. **Should shared action factories be a convention or a framework feature?**
   - Currently, shared actions are just named exports (`export const coreActions = ...`). This is a convention, not enforced.
   - Could the framework provide `defineActions()` that returns a reusable factory, or is the plain function export sufficient?
   - **Leaning toward convention**: a plain function export is simple, well-understood, and doesn't require framework support. Adding `defineActions()` would add API surface for minimal benefit.

3. **Should the hub allow dynamic OAuth client registration?**
   - Better Auth's `oauthProvider` plugin supports dynamic client registration (RFC 7591) at `/oauth2/register`.
   - Option A: Manual registration only: third-party developers register via CLI or admin UI. Simpler, more controlled.
   - Option B: Dynamic registration: any app can register itself programmatically. Lower friction for developers, but requires rate limiting and abuse prevention.
   - **Leaning toward Option A for v1**: manual registration is sufficient for early third-party integrations. Dynamic registration can be enabled later when there's demand and the abuse prevention story is clear.

4. **How should room IDs encode workspace + user scope for third-party access?**
   - Current room IDs are workspace IDs (e.g., `myapp`). Third-party auth needs user scoping so each user gets their own Y.Doc.
   - Option A: `{workspaceId}:{userId}`: simple, flat namespace.
   - Option B: `{workspaceId}/{userId}`: path-like, easier to parse.
   - Option C: Keep workspace-level rooms but use Yjs sub-documents for per-user data.
   - **Leaning toward Option A**: simple, no ambiguity. The hub checks `token.sub === roomId.split(':')[1]`.

## Success Criteria

### Phase 1-3 (Core)
- [ ] A workspace installed via `epicenter install` is discovered and loaded by the local server
- [ ] A workspace registered via `epicenter add <path>` (symlink) is loaded identically to an installed workspace
- [ ] Each workspace's table CRUD and actions are accessible at `/workspaces/{workspaceId}/...`
- [ ] WebSocket sync works for all loaded workspaces via the central relay at `/rooms/:room`
- [ ] The Svelte SPA can discover and render workspaces from the workspace listing endpoint
- [ ] `epicenter <workspace-id> tables <table> list` works against a running local server or standalone instance

### Phase 4 (Standalone)
- [ ] A workspace can be run standalone via `epicenter run <id>` with an identical API surface
- [ ] Standalone mode with `--hub` flag syncs data to/from a hub relay
- [ ] A standalone workspace exposes `/registry` so others can link to it

### Phase 5 (Deployment)
- [ ] A workspace can be deployed as a standalone hosted app with a single command
- [ ] The deployed app exposes `/registry` so other instances can discover its schema

### Phase 6 (Extensions)
- [ ] A workspace with `.withExtension(markdownProjection(...))` writes Markdown files to the target path on Y.Doc changes
- [ ] Multiple extensions per workspace work independently (different targets, different formats)
- [ ] Extension failures are isolated: a broken extension doesn't crash the workspace or local server
- [ ] Extensions run in the same process as the workspace (local server or standalone)

### Phase 7 (Third-Party Auth)
- [ ] Hub exposes `/.well-known/openid-configuration` and standard OAuth 2.1 endpoints
- [ ] A third-party app can register as an OAuth client and receive `client_id` + `client_secret`
- [ ] Users can "Log in with Epicenter" on a third-party hosted workspace via standard OAuth redirect
- [ ] Third-party app receives JWT access token and connects to hub Yjs sync room
- [ ] Hub validates JWT on WebSocket upgrade and enforces room-level access control (`token.sub` matches room user scope)
- [ ] A user logged in at `myapp.com` and on their local Epicenter desktop sees the same data synced via the hub
- [ ] Token refresh works for long-lived WebSocket connections without data loss

## Conceptual Model: The Filesystem as an App Store

The mental model that ties everything together: **your `~/.epicenter/workspaces/` directory is an app store**. Each subdirectory is an installed app. Some are downloaded from a registry (jsrepo). Some are symlinked from a developer's git repo. The local server is the runtime that loads them all.

This mirrors how mobile operating systems work:
- **Install** = download source + deps into a directory (like installing an APK/IPA)
- **Add** = symlink a developer's existing workspace into the app store (like sideloading)
- **Load** = import into the local server process (like the OS loading an app into memory)
- **Run standalone** = launch outside the local server (like running an app in debug mode)

### Why Centralized Directory, Not Distributed Paths

An alternative design was considered: workspaces live anywhere on disk, and Epicenter tracks them via a path list in `config.json` (the Obsidian model). This was rejected for the centralized-with-symlinks approach because:

1. **Stale path problem**: If a user moves or deletes a directory, `config.json` still points at it. The local server must handle N missing paths on every startup. This is a persistent UX paper cut.
2. **Single point of failure**: A corrupted or deleted `config.json` means Epicenter forgets about every workspace. With the centralized model, the directory *is* the source of truth: there's nothing to corrupt.
3. **Discovery simplicity**: One `readdir()` vs "read config, validate each path, handle missing ones."
4. **Symlinks solve the 90% case**: The only scenario that needs workspaces outside `~/.epicenter/` is developer-authored workspaces in git repos. `epicenter add <path>` creates a symlink, which is transparent to the local server and self-evidently broken (dangling symlink) if the target disappears.

The centralized model handles both workspace weights (installed, developed) without introducing a mutable registry of paths.

The key difference from mobile: **every app shares a universal data layer (Yjs)**. Apps don't have siloed databases. They have CRDTs that can sync with any other instance of the same schema. Two instances of the same workspace on different machines, both connected to a hub, are looking at the same data.

### The epicenter.config.ts is Like package.json for Apps

Just as `package.json` describes an npm package (name, version, dependencies, entry points), `epicenter.config.ts` describes a workspace app (ID, tables, actions, schema). It's the single file that makes a directory into an app.

The difference is that `epicenter.config.ts` is executable. It's not just metadata, it's the actual app definition. `createWorkspace()` eagerly creates a `Y.Doc` and returns a `WorkspaceClientBuilder`. Chaining `.withActions()` (terminal) produces a `WorkspaceClientWithActions`: the default export. The schema types are runtime-validated (via arktype). The action handlers are real functions that operate on the Y.Doc. This means the same file serves as both the "manifest" and the "implementation", and because Yjs is isomorphic, it works in browsers too.

### Why Yjs Makes Multi-Instance Sync Trivial

The typical approach to syncing a desktop app with a hosted version requires:
1. A REST API for CRUD operations
2. A conflict resolution strategy
3. An offline queue with retry logic
4. A sync protocol with change tracking (last-modified timestamps, version vectors)
5. A merge strategy for concurrent edits

Yjs eliminates all five. The Y.Doc is the single source of truth. Every mutation is a CRDT operation that commutes: order doesn't matter, every peer converges. The "sync protocol" is just y-websocket, a well-tested library. Offline support is automatic. The Y.Doc accumulates local changes and merges them when the connection resumes.

This means two instances of the same workspace: one on your laptop, one deployed as a web service: don't need any special plumbing to sync. They both connect to a hub room, and Yjs does the rest. The local `workspace.yjs` file is a snapshot of the Y.Doc for fast startup and offline access.

## References

- `packages/server/src/local.ts`: Current `createLocalServer()` composition
- `packages/server/src/workspace/plugin.ts`: Current shared workspace plugin (to be refactored)
- `packages/server/src/workspace/actions.ts`: Per-action static route registration
- `packages/server/src/sync/plugin.ts`: Yjs WebSocket sync relay
- `packages/cli/src/discovery.ts`: `loadClientFromPath()` and `discoverAllWorkspaces()`
- `packages/cli/src/cli.ts`: Current CLI two-mode dispatch
- `packages/epicenter/src/workspace/describe-workspace.ts`: Workspace introspection for registry
- `specs/20260225T000000-bun-sidecar-workspace-modules.md`: Prior spec: sidecar + dynamic loading
- `specs/20260225T172506-epicenter-workspace-module-redesign.md`: Prior spec: module redesign
- `docs/articles/tauri-bun-dual-backend-architecture.md`: Sidecar spawning pattern
