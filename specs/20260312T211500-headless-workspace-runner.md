> **Status: Superseded** by `20260313T063000-workspace-architecture-decisions.md`. The headless runner concept is subsumed into the Bun app server, which loads all workspaces in one process.

> **Path note (2026-05-22)**: This spec's `{configDir}/.epicenter/auth/token.json` and `.epicenter/persistence/...` examples predate the current path policy. Machine auth now lives at `env-paths('epicenter').data/auth/<host>.json` and daemon runtime files use the OS runtime dir. See `specs/20260522T203209-top-level-epicenter-path-cleanup.md`.

# Headless Workspace Runner

**Date**: 2026-03-12
**Status**: Superseded

## Overview

A new `apps/runner/` app that loads `epicenter.config.ts` from any project folder, auto-wires persistence and sync extensions, and stays alive as a headless workspace client connected to the Epicenter server.

## Motivation

### Current State

`apps/tab-manager-markdown/` is a hardcoded headless client for one specific workspace:

```typescript
// apps/tab-manager-markdown/src/index.ts
import { definition } from '@epicenter/tab-manager/workspace';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { createMarkdownPersistenceExtension } from './markdown-persistence-extension';

const client = createWorkspace(definition)
  .withExtension('persistence', createMarkdownPersistenceExtension({
    outputDir: './markdown/devices',
    debounceMs: 1000,
  }))
  .withExtension('sync', createSyncExtension({
    url: (id) => `ws://localhost:3913/workspaces/${id}`,
  }));

await client.whenReady;
// ... SIGINT handler
```

Every workspace that needs headless operation requires a new `apps/` entry with duplicate extension wiring. The "load workspace, wire extensions, keep alive" pattern is generic but each instance is bespoke.

This creates problems:

1. **No reusable runner**: Each headless use case requires a new app with duplicate extension wiring
2. **Users write boilerplate**: Understanding the extension API shouldn't be required to run a workspace headlessly
3. **tab-manager-markdown is too specific**: The only tab-manager-specific code is the markdown serializer; the runner pattern is completely generic

### Desired State

```bash
cd my-project/
bun run apps/runner -- .
# → Loads epicenter.config.ts from current directory
# → Creates workspace clients with persistence + sync
# → Stays alive, syncs with Epicenter server
```

The user writes only `defineWorkspace()` in their config. Zero extension wiring.

## Research Findings

### Existing Building Blocks

Every piece needed already exists in the codebase. The runner is pure composition.

| Component | Location | What it does |
|---|---|---|
| Config loading | `packages/cli/src/discovery.ts` | Loads `epicenter.config.ts`, validates exports, detects ambiguous configs |
| SQLite persistence | `packages/workspace/src/extensions/sync/desktop.ts` | Append-only update log via `bun:sqlite`, compaction on startup/shutdown |
| Sync extension | `packages/workspace/src/extensions/sync/` | WebSocket connection to Epicenter server |
| Workspace creation | `packages/workspace/src/workspace/create-workspace.ts` | `createWorkspace(def).withExtension(...)` chaining |
| Tab manager markdown | `apps/tab-manager-markdown/src/index.ts` | Manual extension wiring (the pattern to generalize) |

### Config Export Convention

The CLI currently loads **pre-wired clients** from config files:

```typescript
// What CLI expects (packages/cli/src/discovery.ts)
function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
  return (
    typeof value === 'object' && value !== null &&
    'id' in value && 'tables' in value && 'definitions' in value &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}
```

The runner needs to load **raw definitions**. A `WorkspaceDefinition` has `id` and `tables` but NOT `definitions` (that property only exists on instantiated clients). This makes detection straightforward:

```typescript
function isWorkspaceDefinition(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null &&
    'id' in value && !('definitions' in value) &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}
```

The runner can also accept pre-wired clients (detected via `isWorkspaceClient`), in which case it skips extension wiring and just keeps them alive.

### Persistence Format

The codebase already settled on SQLite append-only log (same pattern as the Cloudflare Durable Object sync server):

```sql
CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)
```

Each Y.Doc `updateV2` event is a tiny INSERT. Compaction merges all rows into one via `Y.encodeStateAsUpdateV2` on startup and shutdown. Uses `bun:sqlite`: no external dependencies.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| App location | `apps/runner/` | Separate app with clean boundary from packages |
| Config file | `epicenter.config.ts` | Existing convention; CLI already uses it |
| Export format | Named exports of `defineWorkspace()` results | Multiple workspaces via named exports; natural TypeScript |
| Persistence | SQLite append-log (auto-wired) | Already battle-tested in codebase; `bun:sqlite` is built-in |
| Sync | WebSocket via `createSyncExtension` (auto-wired) | Existing extension; connects to Epicenter server |
| `.epicenter/` location | Sibling to `epicenter.config.ts` | Consistent with existing folder discovery spec |
| Markdown output | Not auto-wired by runner | Markdown is workspace-specific presentation, not generic infra |
| tab-manager-markdown | Fold into runner | Its config becomes a standard `epicenter.config.ts` |
| Server URL | `EPICENTER_SERVER_URL` env var, default `ws://localhost:3913` | Configurable without touching code |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  User's Project Folder                                              │
│                                                                     │
│  epicenter.config.ts          ← exports defineWorkspace() results   │
│  posts/                       ← markdown output (visible to user)   │
│  .epicenter/                  ← runner creates this (gitignored)    │
│    └── persistence/                                                 │
│        └── {workspaceId}.db   ← SQLite append-log                   │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
                   │  bun run apps/runner -- /path/to/project
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Runner Process                                                     │
│                                                                     │
│  1. Resolve target directory (arg or cwd)                           │
│  2. Load epicenter.config.ts via dynamic import                     │
│  3. Collect all defineWorkspace() exports                           │
│  4. For each definition:                                            │
│     createWorkspace(definition)                                     │
│       .withExtension('persistence', filesystemPersistence({         │
│         filePath: '.epicenter/persistence/{id}.db'                  │
│       }))                                                           │
│       .withExtension('sync', createSyncExtension({                  │
│         url: serverUrl + '/workspaces/{id}'                         │
│       }))                                                           │
│  5. await Promise.all(clients.map(c => c.whenReady))                │
│  6. Log status, keep alive                                          │
│  7. SIGINT/SIGTERM → destroy all clients (flushes persistence)      │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
                   │  ws://localhost:3913/workspaces/{id}
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Epicenter Sync Server (packages/server)                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Config file example

```typescript
// epicenter.config.ts
import { defineWorkspace, text, ytext, boolean } from '@epicenter/workspace';

export const blog = defineWorkspace({
  id: 'blog',
  tables: {
    posts: {
      title: text(),
      content: ytext({ nullable: true }),
      published: boolean(),
    },
  },
});

export const notes = defineWorkspace({
  id: 'notes',
  tables: {
    entries: {
      title: text(),
      body: ytext({ nullable: true }),
    },
  },
});
```

Running `bun run apps/runner -- .` in that folder creates two workspace clients, each with their own persistence DB and sync connection.

## Implementation Plan

### Phase 1: Scaffold `apps/runner/`

- [x] **1.1** Create `apps/runner/package.json`: dependencies: `@epicenter/workspace`, `yjs`
- [x] **1.2** Create `apps/runner/tsconfig.json`
- [x] **1.3** Create `apps/runner/src/index.ts`: entry point with arg parsing and SIGINT handler

### Phase 2: Config loading

- [x] **2.1** Create `apps/runner/src/load-config.ts`: load `epicenter.config.ts` from target dir via `Bun.pathToFileURL` + dynamic import (same approach as `packages/cli/src/discovery.ts`)
- [x] **2.2** Filter exports: detect `WorkspaceDefinition` (has `id`, lacks `definitions`) and `WorkspaceClient` (has `definitions`)
- [x] **2.3** Error cases: no config found, no valid exports, duplicate workspace IDs

### Phase 3: Extension wiring

- [x] **3.1** For each `WorkspaceDefinition`: `createWorkspace(def).withExtension('persistence', ...).withExtension('sync', ...)`
- [x] **3.2** For each pre-wired `WorkspaceClient`: skip wiring, just track for lifecycle
- [x] **3.3** Persistence path: `.epicenter/persistence/{workspaceId}.db` relative to config dir
- [x] **3.4** Sync URL: `EPICENTER_SERVER_URL` env var or `ws://localhost:3913`, append `/workspaces/{id}`

### Phase 4: Process lifecycle

- [x] **4.1** `await Promise.all(...)` on all clients' `whenReady`
- [x] **4.2** Log: workspace count, IDs, server URL, persistence paths
- [x] **4.3** SIGINT + SIGTERM: call `destroy()` on all clients, then `process.exit(0)`

### Phase 5: Fold `apps/tab-manager-markdown/`

- [ ] **5.1** Create `epicenter.config.ts` for the tab-manager workspace (exports `defineWorkspace(...)` with tab-manager schema)
- [ ] **5.2** Verify the runner loads and runs it successfully
- [ ] **5.3** Decide: keep `apps/tab-manager-markdown/` as a reference, or remove it entirely

### Phase 6: Device Code Auth (RFC 8628)

The runner needs authenticated sync against remote servers (e.g. `api.epicenter.so`). The server already has `bearer()` and `jwt()` plugins, and the auth guard supports `?token=` on WebSocket upgrades. What's missing is a way for the headless runner to obtain a token without a browser.

Better Auth has a first-party `deviceAuthorization` plugin implementing RFC 8628 (OAuth 2.0 Device Authorization Grant): the same flow used by `gh auth login`, `wrangler login`, and every serious CLI tool.

```
Runner                           Server                          User's Browser
  │                                │                                │
  ├─POST /auth/device/code────────►│                                │
  │  { client_id }                 │                                │
  │◄───────────────────────────────│                                │
  │  { device_code, user_code,     │                                │
  │    verification_uri }          │                                │
  │                                │                                │
  │  "Visit api.epicenter.so/device │                                │
  │   and enter code: ABCD-1234"   │                                │
  │                                │                                │
  │                                │◄──── User visits /device ──────┤
  │                                │◄──── Enters code, approves ────┤
  │                                │                                │
  ├─POST /auth/device/token───────►│  (polling)                     │
  │  { device_code, client_id }    │                                │
  │◄───────────────────────────────│                                │
  │  { access_token, expires_in }  │                                │
  │                                │                                │
  │  Store token → .epicenter/auth │                                │
  │  Use for WebSocket sync        │                                │
```

#### 6.1: Server: Add `deviceAuthorization` plugin

Surgical change to `apps/api/src/app.ts`:

```typescript
import { deviceAuthorization } from 'better-auth/plugins';

plugins: [
  bearer(),
  jwt(),
  deviceAuthorization({
    verificationUri: '/device',
    expiresIn: 600,  // 10 min to complete flow
    interval: 5,     // poll every 5s
  }),
  oauthProvider({ ... }),
]
```

- [x] **6.1.1** Add `deviceAuthorization` plugin to `createAuth` in `apps/api/src/app.ts`
- [x] **6.1.2** Validate the device-flow client ID in `deviceAuthorization`

#### 6.2: Server: Build `/device` verification page

Simple page where the user enters the code displayed by the runner. Can be a minimal HTML form or part of the existing Epicenter web app.

- [x] **6.2.1** Create verification page at the `verificationUri` path
- [x] **6.2.2** Page flow: enter code → approve → confirmation message
- [x] **6.2.3** User must be logged in to approve (redirect to sign-in if not)

#### 6.3: Runner: `login` command

```bash
bun run apps/runner login                         # login to default server
bun run apps/runner login --server api.epicenter.so  # login to specific server
```

Implementation (~50 lines):

```typescript
// src/auth.ts
const CLIENT_ID = 'epicenter-runner';
const TOKEN_PATH = join(configDir, '.epicenter', 'auth', 'token.json');

async function login(serverUrl: string) {
  // 1. Request device + user codes
  const { device_code, user_code, verification_uri } = await fetch(
    `${serverUrl}/auth/device/code`,
    { method: 'POST', body: JSON.stringify({ client_id: CLIENT_ID }) },
  ).then(r => r.json());

  console.log(`\nVisit: ${verification_uri}`);
  console.log(`Enter code: ${user_code}\n`);

  // 2. Poll for token
  while (true) {
    await Bun.sleep(5000);
    const res = await fetch(`${serverUrl}/auth/device/token`, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
        client_id: CLIENT_ID,
      }),
    }).then(r => r.json());

    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') { await Bun.sleep(5000); continue; }
    if (res.error) throw new Error(`Auth failed: ${res.error}`);

    // 3. Store token
    await Bun.write(TOKEN_PATH, JSON.stringify({
      access_token: res.access_token,
      server: serverUrl,
      created_at: Date.now(),
    }));
    console.log('✓ Login successful');
    return;
  }
}
```

- [ ] **6.3.1** Create `apps/runner/src/auth.ts` with `login()` and `loadToken()` functions
- [ ] **6.3.2** Token storage at `.epicenter/auth/token.json` relative to config dir
- [ ] **6.3.3** Add `login` subcommand to entry point arg parsing
- [ ] **6.3.4** Auto-load stored token on startup (replaces `EPICENTER_TOKEN` env var as primary method, env var remains as override)

#### 6.4: Runner: Token lifecycle

- [ ] **6.4.1** On startup: check for stored token → use it; check for `EPICENTER_TOKEN` env var → use it; neither → warn "not authenticated, sync will fail against auth-required servers"
- [ ] **6.4.2** Pass token to `createSyncExtension`'s `getToken` callback
- [ ] **6.4.3** Handle token expiry gracefully. Sync extension reconnects automatically, `getToken` is called on each reconnect so a refreshed token is used if available
- [ ] **6.4.4** Add `logout` subcommand that deletes stored token

#### Scope boundaries

What's IN scope for Phase 6:
- `deviceAuthorization` plugin on server
- Device-flow client ID validation
- Verification page (minimal)
- Runner `login`/`logout` commands
- Token storage + auto-loading

What's OUT of scope:
- Token refresh (Better Auth sessions last 7 days; `login` again when expired)
- Keychain integration (file storage is fine for v1; tokens are scoped to one server)
- Multiple server profiles (one token file per config dir is sufficient)

## Edge Cases

### Config exports pre-wired clients

1. User exports `createWorkspace(...)` result (already has extensions)
2. Runner detects the `definitions` property → identifies as a client
3. Skips extension wiring, just tracks for lifecycle management

### Server unreachable

1. Sync extension fails to connect on startup
2. Persistence still works. Offline-first by design
3. Sync extension reconnects automatically (existing behavior)
4. Runner stays alive; logs warning

### Multiple workspaces with the same ID

1. Config exports two definitions with identical `id` values
2. Runner throws before creating any clients: "Duplicate workspace ID 'X' found"

### No `epicenter.config.ts` found

1. Runner checks target directory
2. Prints: `No epicenter.config.ts found in {dir}`

### Config has no workspace exports

1. File exists but contains no `defineWorkspace()` or `createWorkspace()` exports
2. Prints: `No workspace definitions found in epicenter.config.ts`

## Open Questions

1. **Should the runner accept a `--dir` flag, a positional arg, or default to cwd?**
   - `bun run apps/runner -- --dir /path` vs `bun run apps/runner -- /path` vs `bun run apps/runner` (uses cwd)
   - **Recommendation**: Positional arg with cwd fallback. Simplest UX.

2. **Should the runner watch `epicenter.config.ts` for changes?**
   - Hot-reload during development would be convenient
   - Adds complexity; config changes might mean schema changes which need migration logic
   - **Recommendation**: Defer. Manual restart is fine for v1.

3. **Should the runner support markdown materialization as a built-in?**
   - Currently markdown is workspace-specific (different serializers per workspace)
   - A generic "dump all tables to markdown" might be useful
   - **Recommendation**: Out of scope for v1. Users can wire markdown extensions in the config by exporting pre-wired clients instead of raw definitions.

4. **What happens to `apps/tab-manager-markdown/` after folding?**
   - Option A: Delete entirely. The runner replaces it
   - Option B: Keep as a reference/example
   - **Recommendation**: Delete. The runner + a tab-manager `epicenter.config.ts` fully replaces it.

## Success Criteria

- [ ] `bun run apps/runner -- .` in a folder with `epicenter.config.ts` connects to the Epicenter server
- [ ] Each workspace's state persists to `.epicenter/persistence/{id}.db`
- [ ] Multiple workspaces from a single config all run simultaneously
- [ ] Graceful shutdown (SIGINT) flushes all pending persistence writes
- [ ] `apps/tab-manager-markdown/` functionality reproducible by pointing the runner at the right config
- [ ] No type errors; `bun run typecheck` passes
- [ ] `bun run apps/runner login` completes device code flow and stores token
- [ ] Stored token is automatically used for authenticated WebSocket sync
- [ ] `bun run apps/runner -- .` against `api.epicenter.so` syncs successfully with stored token

## References

- `apps/tab-manager-markdown/src/index.ts`: pattern to generalize
- `apps/tab-manager-markdown/src/markdown-persistence-extension.ts`: example custom extension
- `packages/cli/src/discovery.ts`: config loading logic (detection, error messages)
- `packages/workspace/src/extensions/sync/desktop.ts`: `filesystemPersistence()` and `persistence()` functions
- `packages/workspace/src/workspace/create-workspace.ts`: `createWorkspace()` and `.withExtension()` chain
- `packages/workspace/src/workspace/define-workspace.ts`: `defineWorkspace()` and `WorkspaceDefinition` type
- `specs/20251225T210000-epicenter-folder-discovery.md`: `.epicenter/` folder conventions
- `specs/20251030T000000 persistence-factory-pattern.md`: persistence factory pattern (storagePath)
- Better Auth Device Authorization plugin: `better-auth/plugins/deviceAuthorization`
- Better Auth Bearer plugin: `better-auth/plugins/bearer` (already active in `apps/api/src/app.ts`)
- RFC 8628: OAuth 2.0 Device Authorization Grant
- `apps/api/src/app.ts` lines 73-100: existing plugin config and device-client validation

## Review

### Implementation Summary (Phases 1-4)

Created `apps/runner/` with 4 files:

| File | Lines | Purpose |
|---|---|---|
| `package.json` | 20 | Deps: `@epicenter/workspace`, `yjs`. Scripts: `dev`, `typecheck` |
| `tsconfig.json` | 9 | Extends `tsconfig.base.json`, ESNext target |
| `src/load-config.ts` | ~95 | Dynamic import of `epicenter.config.ts`, duck-type detection of definitions vs clients |
| `src/index.ts` | ~82 | Entry point: arg parsing → config loading → extension wiring → lifecycle |

**Total new code**: ~175 lines (as predicted by spec's "~100 lines of real code").

### Key decisions made during implementation

1. **`AnyWorkspaceDefinition` type**: Used `WorkspaceDefinition<string, any, any, any>` from the workspace package rather than a manual duck type. Dynamic imports erase generics, so the `any` variance is justified at this boundary. Matches the `AnyWorkspaceClient` pattern already in the codebase.

2. **Named exports only**: The loader skips `default` exports and only processes named exports, matching the spec's convention of `export const blog = defineWorkspace(...)`. This avoids ambiguity with configs that might `export default` something unrelated.

3. **Pre-existing type errors**: Two errors in `packages/workspace` (`NumberKeysOf`, `TDocuments` indexing) are pre-existing and unrelated to this change. Verified by running typecheck on `apps/tab-manager-markdown/` which shows the same errors.

### Phase 5 (deferred)

Folding `apps/tab-manager-markdown/` into the runner is deferred per instructions. The runner already supports all the functionality needed. A user would create an `epicenter.config.ts` that exports the tab-manager definition and optionally wire custom extensions by exporting a pre-wired client instead.

### Phase 6.3-6.4 Implementation Plan

#### Overview

Two files change. One new file (`auth.ts`), one modified file (`index.ts`). Total ~80 lines new code.

#### File 1: `apps/runner/src/auth.ts` (new, ~55 lines)

Three exported functions, one module-level constant, one type.

```typescript
const CLIENT_ID = 'epicenter-runner';

type StoredToken = {
  access_token: string;
  server: string;
  created_at: number;
  expires_in: number;
};
```

**`login(serverUrl: string, configDir: string): Promise<void>`**

Device code flow (RFC 8628):
1. POST `{serverUrl}/auth/device/code` with `{ client_id: CLIENT_ID }`
2. Print `verification_uri_complete` and `user_code` to console
3. Poll POST `{serverUrl}/auth/device/token` with `{ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: CLIENT_ID }`
4. Handle poll responses:
   - `authorization_pending` → continue polling
   - `slow_down` → double the interval, continue
   - `expired_token` → throw, tell user to retry
   - `access_denied` → throw, user denied
   - Success → write token to disk
5. `mkdir` the auth directory with `recursive: true`
6. `Bun.write` the token as `StoredToken` JSON to `{configDir}/.epicenter/auth/token.json`

Control flow: while(true) loop with early returns on terminal errors. Uses `Bun.sleep()` for polling interval.

**`logout(configDir: string): Promise<void>`**

Delete `{configDir}/.epicenter/auth/token.json` via `unlink`. No-op if file doesn't exist (catch and ignore ENOENT).

**`loadToken(configDir: string): Promise<string | undefined>`**

Token resolution order:
1. `EPICENTER_TOKEN` env var → return immediately (override)
2. Read `{configDir}/.epicenter/auth/token.json` → return `access_token` field
3. Neither exists → return `undefined`

This function is called once on startup. The `getToken` callback passed to `createSyncExtension` calls `loadToken` each time, so a token refreshed by running `login` in another terminal is picked up on the next WebSocket reconnect.

#### File 2: `apps/runner/src/index.ts` (modify, ~25 lines changed)

Insert subcommand parsing before the existing config-loading flow.

**Arg parsing changes:**

Current: `const targetDir = process.argv[2] ?? process.cwd();`

New: parse `process.argv.slice(2)`: first non-flag arg is either a subcommand (`login`, `logout`) or the target dir.

```
bun run apps/runner login --server https://api.epicenter.so [dir]
bun run apps/runner logout [dir]
bun run apps/runner -- [dir]        ← existing flow, unchanged
```

**Subcommand handling (switch statement):**

- `login`: extract `--server` flag value (required), resolve config dir from remaining positional arg or cwd, call `login()`, exit
- `logout`: resolve config dir from positional arg or cwd, call `logout()`, exit
- default: treat first arg as target dir (existing behavior)

**Token integration in normal startup:**

Replace the current static env-var read:
```typescript
// Before
const token = process.env.EPICENTER_TOKEN;
...(token && { getToken: async () => token })

// After
import { loadToken } from './auth';
getToken: async () => loadToken(configDir),
```

The `getToken` callback returns `string | undefined`. The sync extension already handles `undefined` (no token → unauthenticated connection). Passing `loadToken` as a callback (not a captured value) means each reconnect re-reads from disk.

**Startup log update:**

```typescript
// Before
console.log(`  Auth: ${token ? 'token provided' : 'none (open mode)'}`);

// After: resolve token once for logging, but getToken callback re-reads
const initialToken = await loadToken(configDir);
console.log(`  Auth: ${initialToken ? 'token loaded' : 'none (open mode)'}`);
```

#### Execution checklist

- [x] **6.3.1** Create `apps/runner/src/auth.ts` with `login()`, `logout()`, and `loadToken()`
- [x] **6.3.2** Token storage at `.epicenter/auth/token.json` relative to config dir
- [x] **6.3.3** Add `login` and `logout` subcommands to `index.ts` arg parsing
- [x] **6.3.4** Replace static env-var token with `loadToken()` callback in `createSyncExtension`
- [x] **6.4.1** Startup token resolution: env var override → stored file → undefined with warning
- [x] **6.4.2** Log authentication state on startup
- [x] **6.4.3** `getToken` callback re-reads from disk on each reconnect (not cached)
- [x] **6.4.4** Typecheck passes: `bun run typecheck` in `apps/runner`

#### API contract reference (from Better Auth source)

**POST `/auth/device/code`**
- Request: `{ client_id: string, scope?: string }`
- Response: `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`
- Errors: `{ error: 'invalid_request' | 'invalid_client', error_description }`

**POST `/auth/device/token`**
- Request: `{ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: string, client_id: string }`
- Response: `{ access_token, token_type: 'Bearer', expires_in, scope }`
- Errors: `{ error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant', error_description }`

#### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Token scope | Per-project (config dir) | Different projects may connect to different servers |
| `login` dir resolution | Optional positional arg, default CWD | Matches existing runner UX for target dir |
| `getToken` caching | No cache (re-read on each call) | Reconnect picks up fresh token if `login` ran in another terminal |
| Env var precedence | `EPICENTER_TOKEN` overrides stored file | Escape hatch for CI/scripts; matches existing behavior |
| Polling backoff | Use server-provided `interval`, double on `slow_down` | Per RFC 8628 §3.5 |
| Arg parsing | Manual (no library) | Only 2 subcommands + 1 flag; adding a dep is overkill |
