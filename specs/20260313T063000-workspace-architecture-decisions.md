# Workspace Architecture: Desktop App & AI Scripting Platform

**Date**: 2026-03-13
**Status**: Draft: amended 2026-03-13 (HTTP architecture, editor choice, self-contained workspace extensions)
**Supersedes**: Aspects of `20260225T210000-workspace-apps-orchestrator.md` (centralized model) and `20260312T211500-headless-workspace-runner.md` (runner-specific decisions)

> **Path note (2026-05-22):** The centralized `~/.epicenter/workspaces/` architecture in this draft is superseded. Do not copy its global workspace registry, install, or discovery paths into new work. Current generated workspace data is project-local under `<projectDir>/.epicenter/`; machine auth and daemon runtime files have separate platform/runtime path owners.

### Revision: Centralized Workspace Model (2026-03-13)

Simplified from "per-folder anywhere + discovery cache" to "all workspaces live in `~/.epicenter/workspaces/`." Key changes:

- **Decision 1**: Workspaces always live in `~/.epicenter/workspaces/`, not scattered across the filesystem. Eliminates discovery cache, self-registration, and scan logic.
- **Decision 6**: Aggregation becomes trivial `readdir()`. No `known-workspaces.json`.
- **Removed**: Cache schema, pruning logic, self-registration mechanism, scan locations.
- **Unchanged**: Decisions 2-5, 7-8 (config exports, module resolution, Bun server, Monaco types, HTTP protocol, editor choice).

Rationale: Browser configs will diverge from server configs anyway (different action sets, no FS extensions). Workspaces are Epicenter artifacts, not project artifacts. The per-folder model added discovery complexity for a use case that doesn't exist yet. Obsidian, VS Code, Docker, and every comparable tool uses a centralized registry: none do recursive filesystem scanning as primary discovery.
---

## Table of Contents

1. [Context & Background](#context--background)
2. [The Vision](#the-vision)
3. [Architecture Overview](#architecture-overview)
4. [Decision 1: Centralized Workspace Model](#decision-1-centralized-workspace-model)
5. [Decision 2: Config Exports Full Builder Chain](#decision-2-config-exports-full-builder-chain)
6. [Decision 3: Module Resolution](#decision-3-module-resolution-via-bun-add)
7. [Decision 4: Bun App Server](#decision-4-bun-app-server)
8. [Decision 5: Type Injection Pipeline](#decision-5-type-injection-into-monaco)
9. [Decision 6: Aggregation = Discovery](#decision-6-aggregation--discovery--loading)
10. [Decision 7: Communication Protocol](#decision-7-communication-protocol)
11. [Decision 8: Editor Choice](#decision-8-editor-choice)
12. [End-to-End Walkthrough: SQLite Query](#end-to-end-walkthrough-the-sqlite-query-scenario)
13. [What Exactly Are You Exporting?](#what-exactly-are-you-exporting)
14. [The Type Bridge: Why This Works](#the-type-bridge-why-this-works)
15. [Research Findings](#research-findings)
16. [Implementation Plan](#implementation-plan)
17. [Open Questions](#open-questions)
18. [Comparison with Prior Specs](#comparison-with-prior-specs)

---

## Context & Background

Epicenter is a local-first workspace platform using Yjs CRDTs, a Tauri desktop app, Bun runtime, and TypeScript. Two prior specs made conflicting architectural decisions:

- **Orchestrator spec** (Feb 25): Centralized `~/.epicenter/workspaces/` with symlinks, registry database, CLI as package manager
- **Runner spec** (Mar 12): Per-folder model: any folder with `epicenter.config.ts` + `.epicenter/` sibling, headless daemon

Both are partially implemented. They disagree on where state lives, what the config exports, and how workspaces are discovered.

This spec resolves 6 core architectural questions through deep analysis, 5 Oracle stress-tests, and 5 librarian research sessions. The key driver is a single use case that, if solved, makes everything else trivial.

### The Core Tension We Resolved

The original debate was "definitions vs builders in config." Oracle initially recommended pure definitions (`defineWorkspace()`). But the AI scripting use case requires full type information. Including extension methods and action signatures. Which only exist on the builder chain. The breakthrough insight: **Monaco's TypeScript worker resolves types statically from source code without executing it.** The same `.ts` file serves both Monaco (types) and Bun (runtime). No type transfer, generation, or serialization needed.

---

## The Vision

### What the User Sees

```
┌─────────────────────────────────────────────────────────────────────┐
│  Epicenter Desktop App                                               │
│                                                                      │
│  ┌─ Workspaces ──────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  ☑ blog          ~/.epicenter/workspaces/blog        3 tables, 2 actions   │  │
│  │  ☑ habits        ~/.epicenter/workspaces/habits      1 table, 5 actions   │  │
│  │  ☐ notes         ~/.epicenter/workspaces/notes        2 tables, 0 actions  │  │
│  │  ☑ tab-manager   ~/.epicenter/workspaces/tabs         1 table, 3 actions   │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─ AI Scripting Tool ───────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  const results = await blog.actions.searchPosts("hello");█    │  │
│  │                                                                │  │
│  │  ┌─ Autocomplete ─────────────────────────┐                   │  │
│  │  │ blog.actions.searchPosts(query: string) │                   │  │
│  │  │ blog.actions.createPost(input)          │                   │  │
│  │  │ blog.tables.posts.getAllValid()          │                   │  │
│  │  │ blog.extensions.sqlite.query(sql, ...)  │                   │  │
│  │  └─────────────────────────────────────────┘                   │  │
│  │                                                                │  │
│  │  Output:                                                       │  │
│  │  > [{title: "Hello World", content: "..."}, ...]              │  │
│  │                                                    [▶ Run]    │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### What's Happening Under the Hood

1. User opens the Tauri app
2. Rust shell spawns the Bun app server on a random port
3. Bun discovers all workspace folders, `import()`s each config
4. Bun starts an HTTP server (Hono) serving the Svelte SPA and workspace API
5. Rust opens the system webview to `http://127.0.0.1:{PORT}`
6. User selects workspaces via checkboxes in the UI
7. UI fetches config `.ts` source files via `GET /api/types` and loads them into Monaco's virtual filesystem
8. A tiny `__globals.d.ts` prelude declares the selected workspace clients as globals
9. Monaco's TypeScript worker resolves full types from the source (tables, extensions, actions)
10. User writes code with full autocomplete
11. Code is sent to Bun via `POST /api/run`, wrapped with a runtime prelude, and executed against live clients
12. Results stream back to the UI via WebSocket

### Why This Is the Hardest Problem

This use case requires:
- Multiple workspaces loaded simultaneously
- Extensions (like SQLite) that add methods to the client
- Actions that call those extension methods
- Full TypeScript type safety across all of it
- Types available in a browser-based editor (Monaco)
- Code executing in a separate process (Bun app server)

If this works, simpler use cases (single-workspace runner, CLI metadata, browser SPA) are just subsets.

---

## Architecture Overview

```
                        YOUR MACHINE

  ~/.epicenter/
  +-- workspaces/                  <-- ALL workspaces live here
  |   +-- blog/
  |   |   +-- epicenter.config.ts
  |   |   +-- .epicenter/
  |   |   |   +-- providers/
  |   |   |       +-- persistence/blog.yjs
  |   |   |       +-- sqlite/blog.db
  |   |   +-- package.json
  |   |   +-- node_modules/
  |   |       +-- @epicenter/workspace/
  |   |
  |   +-- notes/
  |   |   +-- epicenter.config.ts
  |   |   +-- .epicenter/
  |   |   +-- package.json
  |   |   +-- node_modules/
  |   |
  |   +-- habit-tracker/
  |       +-- epicenter.config.ts
  |       +-- .epicenter/
  |       +-- package.json
  |       +-- node_modules/
  |
  Discovery: readdir('~/.epicenter/workspaces/')  -- that's it.
  No cache. No self-registration. No scanning.

  +---------------------------------------------------------------------+
  |                      Tauri Desktop App                              |
  |                                                                     |
  |   +-- Rust Shell (thin) --+                                        |
  |   |  * Spawns Bun         |                                        |
  |   |  * Opens webview      |                                        |
  |   |  * System tray/menus  |                                        |
  |   |  * Kills Bun on close |                                        |
  |   +----------+------------+                                        |
  |              | spawns                                              |
  |              v                                                     |
  |   +-- Bun App Server (http://127.0.0.1:{PORT}) -----------------+ |
  |   |                                                             | |
  |   |  Serves:                    Runtime:                        | |
  |   |  GET /          -> SPA       readdir(workspacesDir)         | |
  |   |  GET /assets/*  -> static    import() each config           | |
  |   |  GET /api/workspaces        clients = {                     | |
  |   |  GET /api/types               blog:   live client,          | |
  |   |  POST /api/run                notes:  live client,          | |
  |   |  WS  /api/ws                  habits: live client,          | |
  |   |                              }                              | |
  |   +-------------------------------------------------------------+ |
  |              ^                                                     |
  |              | HTTP / WebSocket                                    |
  |              v                                                     |
  |   +-- Webview --------------------------------------------------+ |
  |   |  Svelte UI loaded from http://127.0.0.1:{PORT}              | |
  |   |  * Workspace list      * Monaco editor                      | |
  |   |  * Script output       * AI chat                            | |
  |   +-------------------------------------------------------------+ |
  +---------------------------------------------------------------------+
```

---

## Decision 1: Centralized Workspace Model

### Answer

All workspaces live in `~/.epicenter/workspaces/`. A workspace is an **isolated instance** with a stable ID, a config file, and a state namespace. Each instance is a subfolder of the centralized workspaces directory.

### What a Workspace Folder Looks Like

```
~/.epicenter/
+-- workspaces/
|   +-- blog/
|   |   +-- epicenter.config.ts      <-- Schema + extensions + actions
|   |   +-- .epicenter/              <-- State namespace (gitignored)
|   |   |   +-- providers/
|   |   |       +-- persistence/
|   |   |       |   +-- blog.yjs     <-- Yjs persistence
|   |   |       +-- sqlite/
|   |   |           +-- blog.db      <-- SQLite materialization
|   |   +-- package.json             <-- Has @epicenter/workspace dep
|   |   +-- node_modules/
|   |       +-- @epicenter/workspace/ <-- Resolved locally (Bun hard-links to global cache)
|   |
|   +-- habit-tracker/               <-- Installed via `epicenter install`
|   |   +-- epicenter.config.ts
|   |   +-- .epicenter/
|   |   +-- package.json
|   |   +-- node_modules/
|   |
|   +-- notes/                       <-- Created via `epicenter init`
|       +-- epicenter.config.ts
|       +-- .epicenter/
|       +-- package.json
|       +-- node_modules/
```

Every workspace has its own `node_modules/` for version isolation. Bun's global cache means this costs near-zero disk space (hard links, not copies).

### Discovery

Discovery is a single `readdir()` call:

```typescript
const entries = await readdir(join(epicenterHome, 'workspaces'), { withFileTypes: true });
// For each subdirectory: check for epicenter.config.ts, import it.
// That's it. No cache file. No self-registration. No scanning.
```

No `known-workspaces.json`. No stale path validation. No pruning logic. The filesystem IS the source of truth.

### How Workspaces Get Created

| Method | What happens |
|--------|-------------|
| `epicenter install <name>` | Downloads workspace into `~/.epicenter/workspaces/<name>/`, runs `bun install` |
| `epicenter init <name>` | Creates `~/.epicenter/workspaces/<name>/` with starter config, runs `bun install` |
| Desktop app UI | "Create workspace" button, equivalent to `epicenter init` |

All three create the workspace in the same location. There is no "workspace in an arbitrary directory" concept.

### Why Not Per-Folder Anywhere?

The original spec supported workspaces scattered across the filesystem (e.g., `~/projects/blog/epicenter.config.ts`). This was dropped because:

1. **Discovery complexity**: Required a cache file (`known-workspaces.json`), self-registration on `epicenter init`, stale path pruning, and configurable scan locations.
2. **Browser configs diverge anyway**: Browser apps need different action sets and can't use FS extensions (SQLite). The config in `~/projects/blog/` wouldn't be the same config the desktop app uses.
3. **No real demand**: The per-folder model served a hypothetical "workspace-powered app" use case that doesn't exist yet.
4. **Precedent**: Obsidian, VS Code, Docker, Homebrew, and every comparable tool uses centralized storage. None do recursive filesystem scanning.

### Key Rules

| Rule | Rationale |
|------|-----------|
| **ID is identity, not path** | Workspace ID (e.g., `blog`) is the stable identifier. Folder name within `workspaces/` is just a convenience. |
| **`.epicenter/` is one replica** | For shared workspaces, the sync layer is the source of truth. Local state is one copy. |
| **One directory, one `readdir()`** | No registry database, no cache, no symlinks. |
| **Per-workspace `node_modules/`** | Version isolation. Bun hard-links to global cache, so disk cost is near-zero. |

### Stress Test Results (Oracle)

| Scenario | How Centralized Handles It |
|----------|--------------------------|
| **Installed workspace** | `epicenter install` puts it in `~/.epicenter/workspaces/`. Found by `readdir()`. |
| **GUI-only user (never uses CLI)** | Desktop app creates workspaces in the same directory. They never see the folder. |
| **50 workspaces** | `readdir()` returns 50 entries. Each import is parallel. Startup: 1-3s. |
| **Shared team workspace** | Local `.epicenter/` is one replica. Sync layer is source of truth. |
| **CI/CD (no persistent state)** | Fine. `.epicenter/` is disposable if sync can rebuild it. |
| **Cloud/mobile (no filesystem)** | Future: host abstraction. Not needed now. |

## Decision 2: Config Exports Full Builder Chain

### Answer

`epicenter.config.ts` exports the result of `createWorkspace().withExtension().withActions()`: the **full builder chain** with workspace-inherent extensions and actions.

### What You're Actually Exporting

```typescript
// ~/.epicenter/workspaces/blog/epicenter.config.ts

import {
  createWorkspace,
  text,
  ytext,
  integer,
  boolean,
  date,
  defineQuery,
  defineMutation,
} from '@epicenter/workspace';

// ═══════════════════════════════════════════════════════════════════════
// THIS IS WHAT YOU EXPORT: a fully-chained workspace client
// ═══════════════════════════════════════════════════════════════════════

export const blog = createWorkspace({
  id: 'blog',
  tables: {
    posts: {
      title: text(),
      content: ytext(),
      published: boolean({ default: false }),
      views: integer({ default: 0 }),
      publishedAt: date({ nullable: true }),
    },
  },
})
  // ─── Workspace-inherent extension: SQLite materialization ───
  .withExtension('sqlite', ({ tables, id }) => {
    const { Database } = require('bun:sqlite');
    const db = new Database(`.epicenter/providers/sqlite/${id}.db`);
    // ... setup materialization from Yjs → SQLite ...
    return {
      db,
      query(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...params);
      },
    };
  })
  // ─── Actions that use the extension ───
  .withActions((client) => ({
    searchPosts: defineQuery({
      input: type({ query: 'string' }),
      handler: ({ query }) =>
        client.extensions.sqlite.query(
          'SELECT * FROM posts WHERE title LIKE ?',
          [`%${query}%`],
        ),
    }),
    createPost: defineMutation({
      input: type({ title: 'string', 'content?': 'string' }),
      handler: ({ title, content }) => {
        const id = crypto.randomUUID();
        client.tables.posts.set({
          id,
          _v: 1,
          title,
          content: content ?? '',
          published: false,
          views: 0,
          publishedAt: null,
        });
        return { id };
      },
    }),
    getPublishedPosts: defineQuery({
      handler: () =>
        client.extensions.sqlite.query(
          'SELECT * FROM posts WHERE published = 1 ORDER BY publishedAt DESC',
        ),
    }),
  }));
```

### What TypeScript Infers From This Export

When you hover over `blog` in VS Code (or when Monaco reads this source), TypeScript infers:

```typescript
typeof blog = WorkspaceClientWithActions<
  'blog',                                                    // ID
  {                                                          // Tables
    posts: TableDefinition<[{
      id: string; _v: 1;
      title: string; content: YText;
      published: boolean; views: number;
      publishedAt: DateTimeString | null;
    }]>
  },
  Record<string, never>,                                     // KV
  Record<string, never>,                                     // Awareness
  {                                                          // Extensions
    sqlite: Extension<{
      db: Database;
      query: (sql: string, params?: unknown[]) => unknown[];
    }>
  },
  {                                                          // Actions
    searchPosts: Query<{ query: string }, unknown[]>;
    createPost: Mutation<{ title: string; content?: string }, { id: string }>;
    getPublishedPosts: Query<void, unknown[]>;
  }
>
```

**This is the complete type.** Tables, extension methods, action signatures: all inferred from the source. No `.d.ts` generation. No schema walking. TypeScript already does this.

### Why Not Just `defineWorkspace()`?

If you only exported `defineWorkspace()`:

```typescript
// This gives Monaco: blog.tables.posts.getAllValid() ✓
// But NOT: blog.extensions.sqlite.query()  ✗
// And NOT: blog.actions.searchPosts()      ✗
export const blog = defineWorkspace({ id: 'blog', tables: { ... } });
```

The AI scripting tool needs to call `blog.actions.searchPosts()` and `blog.extensions.sqlite.query()`. Those types only exist on the full builder chain.

### Extension Placement Rules

**All extensions live in the config.** The workspace is self-contained.

```
┌─────────────────────────────────────────────────────────────────┐
│  IN THE CONFIG (workspace-inherent):                             │
│                                                                  │
│  • SQLite materialization   - the workspace needs SQL queries    │
│  • Markdown projection      - the workspace persists as .md     │
│  • Persistence (IDB/fs)     - the workspace persists its Y.Doc  │
│  • Sync (WebSocket)         - the workspace syncs its data      │
│  • Custom domain extensions - specific to this workspace        │
│                                                                  │
│  Everything the workspace needs is defined in the config and     │
│  appears in the exported type. Extensions use relative paths     │
│  (resolved from the config's directory = the workspace folder).  │
│  Environment-specific values (sync URLs, auth) are read from    │
│  env vars or local config by the extension factories.           │
│                                                                  │
│  The Bun app server does NOT inject extensions. It import()s    │
│  the config and gets back fully-formed live clients.            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decision 3: Module Resolution via `bun add`

### Answer

Each workspace folder has its own `node_modules/` with `@epicenter/workspace` installed.

### How Bun Resolves Imports

When Bun does:

```typescript
const config = await import('/Users/you/projects/blog/epicenter.config.ts');
```

Bun loads that file. The file has:

```typescript
import { createWorkspace } from '@epicenter/workspace';
```

Bun resolves `@epicenter/workspace` from the **config file's directory**, not the app server's:

```
/Users/you/projects/blog/         ← starts here
  └── node_modules/
      └── @epicenter/workspace/   ← finds it here ✓

NOT from:
/path/to/app-server/              ← does NOT look here
  └── node_modules/
```

This was confirmed by Oracle via Bun 1.3.1 testing. The imported config resolves its own imports from its own directory/ancestor chain.

### Setup Flow

```
┌─────────────────────────────────────────────────────────┐
│  $ epicenter init                                        │
│                                                          │
│  1. Creates package.json if absent                       │
│     {                                                    │
│       "name": "my-workspace",                            │
│       "private": true,                                   │
│       "dependencies": {                                  │
│         "@epicenter/workspace": "^1.0.0"                 │
│       }                                                  │
│     }                                                    │
│                                                          │
│  2. Runs: bun add -d @epicenter/workspace                │
│                                                          │
│  3. Creates starter epicenter.config.ts                  │
│     import { createWorkspace, text } from '...';         │
│     export const myWorkspace = createWorkspace({         │
│       id: 'my-workspace',                                │
│       tables: { items: { title: text() } },              │
│     });                                                  │
│                                                          │
│  4. Creates .epicenter/ directory                        │
│                                                          │
│  5. Adds .epicenter/providers/ to .gitignore             │
│                                                          │
│  Result:                                                 │
│  my-workspace/                                           │
│  ├── epicenter.config.ts                                 │
│  ├── .epicenter/                                         │
│  ├── .gitignore                                          │
│  ├── package.json                                        │
│  └── node_modules/@epicenter/workspace/                  │
└─────────────────────────────────────────────────────────┘
```

### Standalone Running

`bun run epicenter.config.ts` works as a **smoke test**: the module loads successfully, which verifies that:
- `@epicenter/workspace` is installed
- The config has no syntax errors
- Exports are valid

For meaningful standalone behavior, use CLI commands:
- `epicenter validate`: checks config structure and schema validity
- `epicenter inspect`: shows workspace ID, tables, actions, extensions

### Why This Model (Not Global Install)

| Approach | Problem |
|----------|---------|
| Global install (`bun install -g`) | Version pinning across workspaces is impossible |
| Runner provides imports | Bun resolves from config's dir, not runner's: confirmed broken |
| Self-bootstrapping config | Hidden mutation during module load is fragile and bad for CI |
| **Per-project install** | How every serious tool works (Prisma, Drizzle, Vite). Boring. Correct. |

---

## Decision 4: Bun App Server

### Answer

One Bun process serves everything: the Svelte SPA, the workspace API, and the workspace runtime. Tauri's Rust binary is a thin shell. It spawns Bun, opens a webview, and provides native OS capabilities (system tray, menus, global shortcuts, auto-update). All workspace logic lives in Bun.

### Why Not Tauri IPC?

The original design had Svelte communicating with Bun through Tauri's IPC, with Rust in the middle. This creates two translation layers (Svelte → IPC → Rust → ??? → Bun) where Rust is just a passthrough. HTTP eliminates the middleman.

| Factor | Tauri IPC (rejected) | Bun HTTP (chosen) |
|--------|---------------------|-------------------|
| **Hops** | Svelte → IPC → Rust → ??? → Bun | Svelte → HTTP → Bun |
| **Rust complexity** | Must route every message | Spawn process, open webview, done |
| **Type safety** | Need Rust↔TS type definitions for IPC | Types stay in TypeScript end-to-end |
| **Also works as web app** | Tied to Tauri IPC | Open browser to localhost:PORT |
| **Also works headless** | Need separate runner | Same Bun server, skip webview |
| **Streaming** | Tauri events (custom API) | Standard WebSocket |

### Process Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tauri Desktop App                                                      │
│                                                                          │
│  ┌── Rust Shell ─────────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  Does:                          Does NOT:                          │  │
│  │  • Spawn Bun on app launch       • Route workspace messages          │  │
│  │  • Open webview to localhost     • Know about Y.Docs or SQLite       │  │
│  │  • Kill Bun on app close         • Parse workspace configs            │  │
│  │  • System tray, native menus     • Touch any workspace data           │  │
│  │  • Global keyboard shortcuts                                        │  │
│  │  • Auto-updater                                                     │  │
│  │  • Dispatch CLI commands                                             │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│              │ spawns                                                     │
│              ▼                                                              │
│  ┌── Bun App Server (http://127.0.0.1:{PORT}) ────────────────────┐  │
│  │                                                                   │  │
│  │  HTTP API (Hono):                                                  │  │
│  │  GET  /              → Serve Svelte SPA (static build)             │  │
│  │  GET  /assets/*      → Static assets (JS, CSS, images)             │  │
│  │  GET  /api/workspaces → List loaded workspace metadata              │  │
│  │  GET  /api/types      → .ts source files + .d.ts for Monaco        │  │
│  │  POST /api/run        → Execute user script                        │  │
│  │  WS   /api/ws         → Script output stream, sync status           │  │
│  │                                                                   │  │
│  │  Workspace Runtime (same process):                                  │  │
│  │  STARTUP:                                                          │  │
│  │  1. readdir(~/.epicenter/workspaces/)                                │  │
│  │  2. For each folder: import(config.ts)                              │  │
│  │  3. All clients ready:                                              │  │
│  │     blog   → Y.Doc + SQLite + actions                               │  │
│  │     notes  → Y.Doc                                                  │  │
│  │     habits → Y.Doc + actions                                        │  │
│  │  4. Start HTTP server                                               │  │
│  │  5. Signal ready to Rust shell                                      │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│              ▲                                                              │
│              │ HTTP + WebSocket (standard web APIs)                        │
│              ▼                                                              │
│  ┌── Webview ────────────────────────────────────────────────────────┐  │
│  │  Svelte SPA loaded from http://127.0.0.1:{PORT}                    │  │
│  │                                                                   │  │
│  │  fetch('/api/workspaces')   → workspace list                      │  │
│  │  fetch('/api/types')        → .ts source files for Monaco         │  │
│  │  fetch('/api/run', {code})  → execute script                      │  │
│  │  new WebSocket('/api/ws')   → streaming output                    │  │
│  │                                                                   │  │
│  │  Standard web APIs. No Tauri IPC. No Rust bridge.                   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Startup Pipeline

The startup pipeline is unchanged from the original design. Only the transport changes from IPC to HTTP:

1. **Discovery**: `readdir(~/.epicenter/workspaces/)`, filter for directories containing `epicenter.config.ts`
2. **Import**: For each workspace directory, `import(Bun.pathToFileURL(configPath).href)` in parallel
3. **Register**: Collect all `WorkspaceClient` exports into a `Map<string, AnyWorkspaceClient>`
4. **Ready**: `await Promise.all(clients.values().map(c => c.whenReady))`
5. **Serve**: Start Hono HTTP server, signal ready to Rust shell

### Dev Mode vs Production

```
DEV MODE:
┌──────────────┐     ┌──────────────┐
│  Vite (1421) │     │  Bun (3913)  │
│  Svelte HMR  │────►│  API + WS    │
│  Proxy /api  │     │  Workspaces  │
└──────────────┘     └──────────────┘
• Vite proxies /api/* and /api/ws to Bun
• HMR works normally on the Svelte side
• Bun restarts on config changes (nodemon/watchman)

PRODUCTION:
┌──────────────────────────┐
│  Bun (PORT)              │
│  Serves static build/    │
│  + API + WS              │
│  + Workspace runtime     │
│  Everything on one port  │
└──────────────────────────┘
• Bun.serve() handles static files + API
• Tauri webview points to http://127.0.0.1:{PORT}
• Random port assignment avoids conflicts
```

### Memory Analysis (Oracle Numbers)

Per workspace:
- Y.Doc + decoded CRDT state: ~1-6MB (depends on data volume)
- SQLite connection/cache: ~0.5-2MB
- Idle WebSocket + sync objects: ~0.1-0.5MB
- **Total: ~2-8MB per workspace**

| Workspaces | Estimated Overhead | Verdict |
|------------|-------------------|---------|
| 10 | 20-80MB | Fine |
| 20 | 40-160MB | Fine |
| 50 | 100-400MB | Maybe revisit |
| 100 | 200-800MB | Needs lazy loading |

### Why Eager (Not Lazy)

| Factor | Eager (chosen) | Lazy |
|--------|----------------|------|
| **Invariant** | Registered = ready. Always. | Need "loading" / "unloaded" states everywhere. |
| **Scripting tool** | All clients ready. `blog.tables.posts.getAll()` is sync. | Every access becomes async. Breaks ergonomics. |
| **Implementation** | ~30 lines. Loop + import. | Medium: load/unload lifecycle, state management, cleanup, reconnect. |
| **Bug surface** | Minimal. | Stale references, unload races, cleanup leaks, cache policy. |
| **Startup time** | 1-3s for 20 workspaces (Bun import + SQLite open are fast). | Near-instant (but first access is slow). |

### Sync Deferral (Optional Optimization)

If 20 idle WebSocket connections are a concern:

```
All clients loaded with:    ✓ Y.Doc
                            ✓ Persistence
                            ✓ SQLite extension
                            ✓ Actions
                            ✗ Sync (deferred)

Sync connects when:         User views/edits the workspace
Sync disconnects when:      Idle timeout (e.g., 5 minutes)
```

This keeps the simple "always ready" model while avoiding connection fan-out.

---

## Decision 5: Type Injection into Monaco

### Answer

Load actual `.ts` source files into Monaco's virtual filesystem. Generate a tiny globals prelude. Monaco's TypeScript worker does all type inference, no `.d.ts` generation from schemas.

### The Setup

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Monaco Editor Virtual Filesystem                                        │
│                                                                          │
│  When user opens the scripting tool, Bun serves via HTTP:           │
│                                                                          │
│  1. Base library types (shipped with the app):                           │
│     node_modules/@epicenter/workspace/index.d.ts                        │
│     node_modules/@epicenter/workspace/extensions/index.d.ts             │
│     (all .d.ts files from the workspace package)                        │
│                                                                          │
│  2. Actual config source for each selected workspace:                    │
│     workspaces/blog/epicenter.config.ts        ← raw .ts source         │
│     workspaces/habits/epicenter.config.ts      ← raw .ts source         │
│                                                                          │
│  3. Generated globals prelude:                                           │
│     __globals.d.ts                                                       │
│     ┌──────────────────────────────────────────────────────────────┐     │
│     │ // Auto-generated by Bun app server                           │     │
│     │ // Maps global variables to config export types               │     │
│     │                                                                │     │
│     │ declare const blog:                                            │     │
│     │   typeof import('./workspaces/blog/epicenter.config').blog;   │     │
│     │                                                                │     │
│     │ declare const habits:                                          │     │
│     │   typeof import('./workspaces/habits/epicenter.config')       │     │
│     │     .habits;                                                   │     │
│     └──────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  The TypeScript worker then resolves:                                    │
│                                                                          │
│    blog.tables.posts.getAllValid()          → TableHelper<PostRow>[]     │
│    blog.extensions.sqlite.query(sql, ...)  → unknown[]                  │
│    blog.actions.searchPosts({ query })     → Query handler result       │
│    blog.actions.createPost({ title })      → { id: string }            │
│    habits.tables.entries.*                  → (whatever habits defines)  │
│                                                                          │
│  ✅ Full autocomplete                                                    │
│  ✅ Type errors on wrong arguments                                       │
│  ✅ Go-to-definition (jumps to config source)                           │
│  ✅ Hover documentation (JSDoc from workspace package)                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### What the Prelude Generator Looks Like

```typescript
// In the Bun app server: runs when user opens scripting tool or changes selection

function generateGlobalsPrelude(
  selectedWorkspaces: Map<string, { configPath: string; exportName: string }>
): string {
  const lines: string[] = ['// Auto-generated workspace globals'];

  for (const [id, { configPath, exportName }] of selectedWorkspaces) {
    // configPath is relative to Monaco's virtual FS root
    lines.push(
      `declare const ${id}: typeof import('${configPath}').${exportName};`
    );
  }

  return lines.join('\n');
}

// Example output:
// declare const blog: typeof import('./workspaces/blog/epicenter.config').blog;
// declare const habits: typeof import('./workspaces/habits/epicenter.config').habits;
```

That's it. ~15 lines of code. The TypeScript worker does the rest.

### Why Not Generate `.d.ts` From Schemas?

| Approach | Effort | Completeness | Fragility |
|----------|--------|-------------|-----------|
| Schema → .d.ts generator | High (walk every type) | Partial (misses extensions, actions) | Breaks when schema API changes |
| Load .ts source into Monaco | Low (~15 lines) | Complete (everything in the source) | Never breaks: same source |
| Ship only base .d.ts | Zero | Incomplete (no per-workspace types) | N/A |

---

## Decision 6: Aggregation = Discovery + Loading

### Answer

There is no separate "aggregation architecture." Aggregation is just: `readdir()` the workspaces directory, import each config, create clients.

```typescript
// Bun app server startup - entire discovery pipeline
const wsDir = join(epicenterHome, 'workspaces');
const entries = await readdir(wsDir, { withFileTypes: true });

const clients = new Map<string, AnyWorkspaceClient>();

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const configPath = join(wsDir, entry.name, 'epicenter.config.ts');
  if (!(await Bun.file(configPath).exists())) continue;

  const mod = await import(Bun.pathToFileURL(configPath).href);
  const client = extractWorkspaceClient(mod);
  clients.set(client.id, client);
}

await Promise.all([...clients.values()].map(c => c.whenReady));
// Done. All clients loaded and ready.
```

This replaces the previous design which required `known-workspaces.json`, cache validation, stale path pruning, and self-registration. The centralized model makes all of that unnecessary.
---

## Decision 7: Communication Protocol

### Answer

All communication between the webview and workspace runtime uses standard HTTP and WebSocket over `127.0.0.1`. No Tauri IPC, no custom protocols, no Rust message routing.

### HTTP API Surface

```
┌─────────────────────────────────────────────────────────────────────┐
│  Bun App Server: Hono Routes                                       │
│                                                                     │
│  Static:                                                            │
│  GET  /              → Serve Svelte SPA (index.html)                │
│  GET  /assets/*      → JS, CSS, images (static build output)       │
│                                                                     │
│  Workspace API:                                                     │
│  GET  /api/workspaces → [{id, tables, actions, extensions}, ...]   │
│  GET  /api/types      → {configs: {[path]: source}, dts: [...]}    │
│  POST /api/run        → {code: string} → execute + return result   │
│                                                                     │
│  Streaming:                                                         │
│  WS   /api/ws         → Script output, sync status, live updates   │
└─────────────────────────────────────────────────────────────────────┘
```

### Security Model

The server binds to `127.0.0.1` only. Never `0.0.0.0`. Traffic never leaves the machine. For defense-in-depth:

| Layer | Mechanism |
|-------|-----------|
| **Network binding** | `127.0.0.1:{PORT}`: unreachable from other machines |
| **Startup token** | Rust generates a random token, passes it to Bun (env var) and the webview (URL param or cookie). Bun rejects requests without it. |
| **Random port** | OS assigns a free port: avoids conflicts and makes the endpoint unpredictable |
| **No CORS needed** | Same-origin: webview loads from the same `http://127.0.0.1:{PORT}` it fetches from |

### Startup Token Flow

```
Rust Shell                Bun App Server             Webview
──────────                ──────────────             ───────
1. Generate random
   token (crypto)
        │
        ├── spawn bun
        │   --token={TOKEN}
        │
        │                 2. Read --token flag
        │                    Store in memory
        │                    Start HTTP server
        │                    ──► stdout: READY:{PORT}
        │
3. Parse PORT from
   stdout
        │
        └── open webview
            to http://127.0.0.1:{PORT}?token={TOKEN}

                                                     4. Store token
                                                        from URL param
                                                        Add to all
                                                        fetch() headers:
                                                        Authorization:
                                                        Bearer {TOKEN}
```

### Why Not Tauri's Custom Protocol?

Tauri offers `tauri://localhost` and custom protocol handlers. We avoid them because:

1. **Extra hop**: Custom protocol → Rust handler → forward to Bun. HTTP goes direct.
2. **No WebSocket support**: Custom protocols don't support WS upgrades.
3. **Non-standard**: Debugging requires Tauri-specific tooling. HTTP works with curl, browser devtools, Postman.
4. **Portability**: The same HTTP API works when running headless (no Tauri), in development (Vite proxy), or as a future web app.

### Comparison with Other Desktop App Patterns

| App | Communication | Our Assessment |
|-----|--------------|----------------|
| **VS Code** | Node.js extension host + custom JSON-RPC | Complex: justified by multi-language extension ecosystem |
| **Obsidian** | Single-process (Electron) | No IPC needed: but can't use Bun's runtime advantages |
| **Cursor** | Fork of VS Code + HTTP to AI backend | Similar to our approach for the AI layer |
| **Warp** | Rust renders directly, no webview API | Wrong model: we want web technologies |
| **Epicenter** | Bun HTTP + WebSocket | Simplest possible. Standard web APIs. |

---

## Decision 8: Editor Choice

### Answer

Monaco Editor for the AI scripting tool. It provides full TypeScript IntelliSense out of the box. The exact capability our architecture depends on.

### Why This Decision Matters

The entire type injection pipeline (Decision 5) depends on the editor's ability to:
1. Host a virtual filesystem of `.ts` source files
2. Run a TypeScript language service against those files
3. Provide autocomplete, hover types, and error checking from inferred types

This isn't a cosmetic choice. The editor IS the type system's frontend.

### Comparison

| Factor | Monaco | CodeMirror 6 | Ace | Eclipse Theia |
|--------|--------|-------------|-----|--------------|
| **TS IntelliSense** | Built-in TS worker + virtual FS. ~15 lines of setup. | Syntax highlighting only via `@codemirror/lang-javascript`. Full TS requires custom Web Worker + `@typescript/vfs` (~300-500 lines). | Partial via `ace-linters` + LSP bridge. | Full (embeds VS Code's language service). |
| **Virtual filesystem** | Native `monaco.languages.typescript.addExtraLib()` | Manual: must build custom LanguageServer integration | No native support | Full (inherits VS Code model) |
| **Setup effort** | ~15 lines to load types + config sources | ~300-500 lines for equivalent TS support | ~200 lines for basic TS | ~2000+ lines (full IDE framework) |
| **Bundle size** | ~2.5MB | ~200KB (base) + ~5MB (TS compiler for full support) | ~1MB | ~20MB+ |
| **Community TS support** | First-class (Monaco IS VS Code's editor) | `@valtown/codemirror-ts`: archived Sept 2025. Roll-your-own. | Minimal community investment | First-class |
| **Extensibility** | Moderate (VS Code extension-like API) | Excellent (composable extensions) | Limited | Full VS Code extension support |
| **Mobile/lightweight** | Heavy: not suitable for mobile | Excellent: designed for it | Moderate | Not suitable |

### Bundle Size Is Irrelevant for Desktop

A common objection to Monaco is its ~2.5MB bundle. In our context:
- Bun binary: ~60MB
- Tauri + Rust: ~15MB
- Svelte app + dependencies: ~5MB
- Monaco: ~2.5MB (3% of total)

We're building a desktop app. This is noise.

### The CodeMirror 6 Path (Evaluated and Rejected for Now)

`@codemirror/lang-javascript` provides syntax highlighting and basic JS completions. For full TypeScript IntelliSense equivalent to Monaco, you'd need:

1. Bundle the TypeScript compiler (~5MB) into a Web Worker
2. Create a virtual filesystem abstraction (like `@typescript/vfs`)
3. Wire the TS Language Service to CodeMirror's completion/diagnostic APIs
4. Handle incremental updates, cancellation, and worker lifecycle

The archived `@valtown/codemirror-ts` package did exactly this. Its archival in September 2025 means no maintained path exists. You'd be maintaining ~300-500 lines of TypeScript-to-CodeMirror glue code yourself.

Both Monaco and the CodeMirror TS path use the same TypeScript compiler underneath. Monaco just ships the integration already wired.

### Recommendation: Monaco Now, Abstract for Later

```
┌─────────────────────────────────────────────────────────────────┐
│  Current: Monaco                                                 │
│                                                                  │
│  User code ──► Monaco ──► TS Worker ──► Autocomplete             │
│                  │                                               │
│                  └── Virtual FS: config.ts + .d.ts + prelude     │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Future (if needed): Abstraction interface                       │
│                                                                  │
│  EditorAdapter {                                                 │
│    loadTypeDefinitions(files: Map<string, string>): void        │
│    loadSourceFiles(files: Map<string, string>): void            │
│    setGlobalsPrelude(content: string): void                     │
│    getValue(): string                                           │
│    onDidChangeContent(cb: () => void): Disposable               │
│  }                                                               │
│                                                                  │
│  MonacoAdapter implements EditorAdapter                          │
│  CodeMirrorAdapter implements EditorAdapter  ← future swap      │
└─────────────────────────────────────────────────────────────────┘
```

Build the abstraction interface from the start so the editor choice is an implementation detail, not an architectural commitment. But use Monaco now. It's the path of least resistance for the exact feature we need.

## End-to-End Walkthrough: The SQLite Query Scenario

The user wants to search blog posts using the AI scripting tool. Here's every step.

### Step 1: Config File (Author Time)

The developer wrote this config and ran `epicenter init` + `bun add @epicenter/workspace`:

```typescript
// ~/.epicenter/workspaces/blog/epicenter.config.ts
export const blog = createWorkspace({
  id: 'blog',
  tables: { posts: { title: text(), content: ytext() } },
})
  .withExtension('sqlite', ({ id }) => {
    const db = new Database(`.epicenter/providers/sqlite/${id}.db`);
    return {
      db,
      query: (sql: string, params: unknown[] = []) =>
        db.prepare(sql).all(...params),
    };
  })
  .withActions((client) => ({
    searchPosts: defineQuery({
      input: type({ query: 'string' }),
      handler: ({ query }) =>
        client.extensions.sqlite.query(
          'SELECT * FROM posts WHERE title LIKE ?',
          [`%${query}%`],
        ),
    }),
  }));
```

### Step 2: Bun Loads Config (App Startup)

```
Bun App Server                                   Filesystem
──────────────                                   ──────────
import('/Users/you/projects/blog/               /Users/you/projects/blog/
  epicenter.config.ts')                          ├── epicenter.config.ts
    │                                            ├── .epicenter/providers/
    ├── Bun evaluates the file                   │   └── sqlite/blog.db
    │   ├── createWorkspace({...})               └── node_modules/
    │   │   └── new Y.Doc()         [0.1ms]          └── @epicenter/workspace/
    │   ├── .withExtension('sqlite', factory)
    │   │   └── new Database(                    Opens: .epicenter/providers/
    │   │       '.epicenter/providers/             sqlite/blog.db
    │   │       sqlite/blog.db')    [5ms]
    │   └── .withActions(factory)
    │       └── binds action handlers  [0.1ms]
    │
    └── Returns: { blog: WorkspaceClientWithActions<...> }
                     │
                     │  blog.ydoc         → Y.Doc instance
                     │  blog.tables.posts  → TableHelper<PostRow>
                     │  blog.extensions.sqlite.query → function
                     │  blog.actions.searchPosts → bound handler
                     │
                     ▼
              clients.set('blog', blog)
```

### Step 3: Type Injection (User Opens Scripting Tool)

```
Bun App Server                       Monaco (in webview)
──────────────                       ──────────────────
Reads blog/epicenter.config.ts
  as raw text string ──────────HTTP──► Adds to virtual FS as
                                      workspaces/blog/epicenter.config.ts

Reads @epicenter/workspace
  .d.ts files ─────────────────HTTP──► Adds to virtual FS as
                                      node_modules/@epicenter/workspace/

Generates prelude:
  "declare const blog:
    typeof import(
      './workspaces/blog/epicenter.config'
    ).blog;" ──────────────────HTTP──► Adds to virtual FS as
                                      __globals.d.ts

                                      TS Worker resolves types:
                                      blog.actions.searchPosts
                                        → (input: {query: string}) => unknown[]
                                      blog.extensions.sqlite.query
                                        → (sql: string, params?: unknown[]) => unknown[]
                                      blog.tables.posts.getAllValid
                                        → () => PostRow[]

### Step 4: User Writes Code

```
Monaco editor shows:
┌─────────────────────────────────────────────────────────┐
│                                                          │
│  const results = await blog.actions.searchPosts({        │
│    query: "hello"                                        │
│  });                                                     │
│                                                          │
│  for (const post of results) {                           │
│    console.log(post.title);                              │
│  }                                                       │
│                                                          │
│                                             [▶ Run]     │
└─────────────────────────────────────────────────────────┘

Autocomplete works because:
  1. __globals.d.ts says blog is typeof import(...).blog
  2. TS worker reads the actual epicenter.config.ts source
  3. TS worker infers the full type from the builder chain
  4. searchPosts's input type is { query: string }
  5. TS knows the argument is correct ✓
```

### Step 5: Script Execution

```
Monaco ──── script text ────HTTP────► Bun App Server

Bun wraps with runtime prelude:
┌─────────────────────────────────────────────────────────┐
│  // Injected by Bun: matches what __globals.d.ts       │
│  // declares, so types match runtime                    │
│  const blog = __workspaceClients.get('blog');           │
│                                                          │
│  // ─── user's code ───                                 │
│  const results = await blog.actions.searchPosts({       │
│    query: "hello"                                       │
│  });                                                     │
│                                                          │
│  for (const post of results) {                           │
│    console.log(post.title);                              │
│  }                                                       │
└─────────────────────────────────────────────────────────┘

Execution trace:
  blog.actions.searchPosts({ query: "hello" })
    │
    ▼ (calls the handler function defined in the config)
  handler({ query: "hello" })
    │
    ▼ (handler calls the sqlite extension)
  client.extensions.sqlite.query(
    "SELECT * FROM posts WHERE title LIKE ?",
    ["%hello%"]
  )
    │
    ▼ (sqlite extension runs the query)
  db.prepare("SELECT * FROM ...").all("%hello%")
    │
    ▼ (SQLite reads from disk)
  .epicenter/providers/sqlite/blog.db
    │
    ▼ (returns rows)
  [{title: "Hello World", content: "...", ...},
   {title: "Say Hello", content: "...", ...}]
    │
    ▼ (returned to user's script)
  results = [{...}, {...}]
    │
    ▼ (console.log runs in Bun, output sent via WebSocket)
  "Hello World"
  "Say Hello"

Bun ──── output ────WebSocket────► Monaco displays result
```

---

## What Exactly Are You Exporting?

### FAQ

**Q: Am I literally exporting the `createWorkspace(...)` result?**
Yes. `export const blog = createWorkspace({...}).withExtension(...).withActions(...)`. That's a `WorkspaceClientWithActions`: a live client object with a Y.Doc, typed tables, extensions, and actions.

**Q: What happens when Bun `import()`s my config?**
Bun evaluates the file. `createWorkspace()` runs, creates a Y.Doc. `.withExtension()` runs, calls the factory, opens SQLite. `.withActions()` runs, binds handlers. Bun gets back a fully-formed live client.

**Q: What happens when Monaco reads my config?**
Monaco's TypeScript worker **does not execute** the code. It only performs static type analysis. `typeof blog` is resolved purely from the TypeScript types of `createWorkspace`, `withExtension`, `withActions`. No Y.Doc is created. No SQLite is opened. Just types.

**Q: Can I export multiple workspaces from one config?**
Yes:
```typescript
export const blog = createWorkspace({...}).withExtension(...).withActions(...);
export const auth = createWorkspace({...}).withActions(...);
```
Bun discovers all workspace client exports.

**Q: What if I have a workspace with no actions?**
Fine. Export without `.withActions()`:
```typescript
export const notes = createWorkspace({
  id: 'notes',
  tables: { entries: { title: text(), body: ytext() } },
});
```
Scripts can still access `notes.tables.entries.*`.

**Q: What if I have a workspace with no extensions?**
Also fine:
```typescript
export const simple = createWorkspace({...}).withActions((client) => ({
  addItem: defineMutation({
    input: type({ title: 'string' }),
    handler: ({ title }) => {
      client.tables.items.set({ id: crypto.randomUUID(), _v: 1, title });
    },
  }),
}));
```

**Q: Can actions call other workspace's clients?**
Yes, if they're in the same config file (same module scope):
```typescript
export const auth = createWorkspace({...});
export const blog = createWorkspace({...}).withActions((client) => ({
  getAuthorPosts: defineQuery({
    input: type({ authorId: 'string' }),
    handler: ({ authorId }) => {
      const user = auth.tables.users.get(authorId);
      // ...
    },
  }),
}));
```

**Q: What about the browser? Can it import my config?**
If your config has filesystem extensions (SQLite, markdown), the browser can't import it. Options:
1. Export a separate `blogDef = defineWorkspace(...)` for browser consumers
2. Create a browser-specific config without FS extensions
3. The browser app connects to the Bun app server via HTTP instead of importing directly

---

## The Type Bridge: Why This Works

This is the key architectural insight. Types don't "transfer" between processes. The same source code is read by two different consumers for two different purposes.

```
              SAME SOURCE FILE
              epicenter.config.ts
              ┌─────────────────────────────────────────┐
              │ export const blog = createWorkspace(...) │
              │   .withExtension('sqlite', factory)     │
              │   .withActions(actionsFactory);          │
              └───────────────┬─────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│     MONACO (webview)    │     │     BUN APP SERVER      │
│                         │     │                         │
│  TypeScript Worker      │     │  Bun Runtime            │
│  reads the source       │     │  executes the source    │
│                         │     │                         │
│  Resolves:              │     │  Creates:               │
│  typeof blog =          │     │  blog = {               │
│    WorkspaceClient-     │     │    ydoc: Y.Doc,         │
│    WithActions<         │     │    tables: {             │
│      'blog',            │     │      posts: TableHelper │
│      {posts: ...},      │     │    },                   │
│      {},                │     │    extensions: {         │
│      {},                │     │      sqlite: {           │
│      {sqlite: ...},     │     │        db: Database,     │
│      {searchPosts: ...} │     │        query: fn         │
│    >                    │     │      }                   │
│                         │     │    },                   │
│  TYPE ═══════════════════════════ OBJECT                 │
│  (compile-time)         │     │  (runtime)              │
│                         │     │                         │
│  Prelude:               │     │  Prelude:               │
│  declare const blog:    │     │  const blog =           │
│    typeof ...blog;      │     │    clients.get('blog'); │
│                         │     │                         │
│  SAME TYPE ══════════════════════ SAME VALUE             │
└─────────────────────────┘     └─────────────────────────┘
```

**Why this is clever**: Most systems that need types in one process and values in another resort to code generation, schema serialization, or RPC type definitions. We avoid ALL of that because:

1. TypeScript's `typeof` operator resolves types from source at compile time
2. Bun's `import()` creates values from source at runtime
3. Both read the same file
4. The type of `typeof blog` exactly matches the runtime shape of `blog`

**Nothing is generated. Nothing is transferred. Nothing can get out of sync.**

---

## Research Findings

### Oracle Stress Tests (5 agents)

| Question | Oracle Verdict | Key Insight |
|----------|---------------|-------------|
| Builders vs definitions? | Definitions > builders (pre-revision) | Side effects on import are real, but acceptable when the Bun app server IS the consumer |
| Standalone `bun run config`? | Per-project dep is the answer | Bun resolves from config's dir, not importer's. `epicenter init` solves friction. |
| Lazy vs eager loading? | Eager load all | Lazy loading contaminates scripting API. 20 workspaces = ~40-160MB, acceptable. |
| .d.ts generation needed? | No: load .ts source into Monaco | `typeof import(...)` gives full types. ~15 lines of prelude code. 1-4h effort. |
| Per-folder as THE model? | Centralized is simpler (revised) | Original verdict was per-folder. Revised: all workspaces in `~/.epicenter/workspaces/` eliminates discovery complexity with no loss of functionality. |

### Librarian Research (5 agents)

| Topic | Finding |
|-------|---------|
| Per-folder config patterns | Git, Deno, Cargo all use walk-up-to-find-root. Terraform is CWD-only. All use local state + global cache. |
| Desktop process models | VS Code: one extension host per workspace. Obsidian: single process, user-selected vaults. Recommend: single Bun server. |
| TypeScript scripting tools | Monaco + addExtraLib() is the standard. Bun server eval is simplest execution model. |
| Typed client patterns | Prisma: codegen. Drizzle: pure TS inference. tRPC: proxy-based. Our approach is closest to Drizzle. |
| Monaco TS integration | `addExtraLib(content, path)` for type declarations. Virtual FS models for source files. TS worker resolves types. |

---

## Implementation Plan

### Phase 1: Foundation

- [ ] Implement `epicenter init <name>` CLI command (creates workspace in `~/.epicenter/workspaces/<name>/`, installs deps, creates starter config)
- [ ] Implement `epicenter validate` (import config, check exports are valid workspace clients)
- [ ] Implement workspace discovery (`readdir()` on `~/.epicenter/workspaces/`, import each config)

### Phase 2: Bun App Server

- [ ] Create Bun app server entry point (Hono: serves SPA + API + WebSocket)
- [ ] Implement Rust shell: spawn Bun on launch, open webview to `http://127.0.0.1:{PORT}`, kill on close
- [ ] Implement config loading pipeline (`readdir()` workspaces dir, import each, register, await ready)
- [ ] Define HTTP API routes (`GET /api/workspaces`, `GET /api/types`, `POST /api/run`, `WS /api/ws`)
- [ ] Implement workspace list endpoint (returns id, tables, actions, extensions for each)
- [ ] Implement startup token auth (Rust generates token, passes to Bun + webview)

### Phase 3: Monaco Type Injection

- [ ] Bundle `@epicenter/workspace` .d.ts files into the desktop app
- [ ] Implement config source transfer (`GET /api/types` returns .ts files + .d.ts for Monaco)
- [ ] Implement globals prelude generator (~15 lines)
- [ ] Wire up Monaco virtual filesystem (load base types + config sources + prelude)
- [ ] Verify autocomplete works for tables, extensions, and actions

### Phase 4: Script Execution

- [ ] Implement runtime prelude generator (injects workspace client globals)
- [ ] Implement script execution endpoint (`POST /api/run`: wrap user code + eval in Bun)
- [ ] Implement output streaming via WebSocket (`WS /api/ws`)
- [ ] Handle script errors gracefully (syntax errors, runtime errors, timeout)

### Phase 5: AI Integration

- [ ] Wire AI chat to read workspace definitions (tables, actions, extensions)
- [ ] AI generates TypeScript code against workspace clients
- [ ] Generated code is displayed in Monaco (with full type checking)
- [ ] User can edit and run AI-generated code

---

## Open Questions

### ~~Lazy Extension Factory Execution~~ (Resolved)

**Decision**: Eager execution is fine. `.withExtension(factory)` calls the factory immediately on `import()`. The Bun app server IS the consumer. Side effects on import are acceptable. The simplicity of eager execution (~30 lines, no lifecycle management) outweighs the theoretical purity of deferred execution.

### ~~Environment-Specific Extension Override~~ (Resolved)

**Decision**: Not needed. This was a phantom requirement.

The per-folder model means each workspace is self-contained. The config defines ALL its extensions. Persistence, sync, SQLite, everything. Sync URLs are configured in the config itself (or read from env vars). Persistence paths are relative to the workspace folder. Auth tokens are read from local config or env vars by the extension factories.

The Bun app server just `import()`s configs and gets back fully-formed clients. It has nothing to inject. Therefore `.withActions()` being terminal is not a problem. Nothing needs to chain after it.

The browser never imports configs directly. It connects via HTTP API. CI runs the same configs headless. There is no environment split that demands runtime injection.

### ~~Browser Config Compatibility~~ (Resolved)

No longer an open question. Browser apps connect to the Bun app server via HTTP, not by importing configs directly. The workspace config is a server-side artifact.

### Config Hot Reload

When the user edits `epicenter.config.ts`, should Bun hot-reload? Options:
1. Watch for file changes, re-import (need to handle Y.Doc lifecycle)
2. Manual reload via CLI/UI button
3. No reload. Restart Bun

### Port Conflicts and Process Management

The Bun app server uses a random OS-assigned port. Potential issues:
1. What if the user runs multiple Epicenter instances? Each gets its own port. Fine.
2. What if Bun crashes? Rust shell should detect child process exit and either restart or show an error.
3. What if the port is somehow blocked by a firewall? Unlikely for loopback, but worth a fallback (retry with different port).
4. Should we support a fixed port for development? Probably yes: `EPICENTER_PORT=3913` env var override.

### Startup Token Rotation

The startup token is generated once per app launch. Should it rotate? Options:
1. Single token per session (simplest, current design)
2. Token rotation on a timer (complexity without clear benefit for localhost)
3. Per-request HMAC (overkill for same-machine communication)

Recommendation: single token per session. The threat model is local-only.
---

## Comparison with Prior Specs

| Topic | Orchestrator Spec (Feb 25) | Runner Spec (Mar 12) | This Spec (original) | This Spec (amended) |
|-------|---------------------------|---------------------|---------------------|---------------------|
| State location | Centralized `~/.epicenter/workspaces/` with symlinks | Per-folder (any folder with config) | Per-folder instances, folder is default host | **Centralized `~/.epicenter/workspaces/`, no symlinks** |
| Config export | Not specified | `defineWorkspace()` | Full builder chain | <- unchanged |
| Module resolution | Not specified | Runner provides imports | Per-project `bun add` | <- unchanged |
| Process model | Not specified | Single runner per workspace | Single sidecar, Tauri IPC | **Bun app server, HTTP/WS** |
| Communication | Not specified | Not specified | Tauri IPC (Rust bridge) | **HTTP + WebSocket (127.0.0.1)** |
| Editor | Not specified | Not specified | Monaco (implied) | **Monaco (explicit, with CodeMirror comparison)** |
| Type injection | Not specified | Not specified | Monaco virtual FS + prelude | <- unchanged (transport now HTTP) |
| Aggregation | Registry database + symlinks | Not addressed | Discovery cache + import loop | **`readdir()` on workspaces dir. No cache.** |
| Actions | Separate action exports | Not addressed | Chained via `.withActions()` | <- unchanged |
| Extensions | Not specified | Wired by runner | Workspace-inherent in config | <- unchanged |
| Security | Not specified | Not specified | Not specified | **Startup token auth, 127.0.0.1 binding** |

### Key Architectural Insight

The type system is the bridge between compile-time (Monaco) and runtime (Bun). The same `.ts` source file serves both consumers. No serialization, no generation, no transfer of types needed. This only works because the config exports the full builder chain: `typeof export` gives Monaco the complete type, and `import()` gives Bun the live object. The HTTP architecture means this bridge works over standard web APIs, making it portable to headless, web, and desktop contexts.
