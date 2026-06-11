# Runner→CLI Merge: Unified Epicenter Companion

**Status**: Draft: awaiting review
**Effort**: Medium (1-2 days)

> **Path note (2026-05-22):** The `$EPICENTER_HOME/auth.json`, `$EPICENTER_HOME/auth/sessions.json`, and `$EPICENTER_HOME/workspaces/` migration guidance is stale. Do not copy these top-level home-directory paths into new auth, workspace discovery, or migration work.

## Problem

Runner (`apps/runner`) and CLI (`packages/cli`) are two binaries that do overlapping things with incompatible conventions:

| Concern | Runner | CLI |
|---|---|---|
| Auth method | Device code flow (RFC 8628) | Email/password prompt |
| Token storage | `{configDir}/.epicenter/auth/token.json` | `$EPICENTER_HOME/auth.json` |
| Token format | `{ access_token, server, created_at, expires_in }` | `{ remoteUrl, token, expiresAt, user }` |
| Config loading | Named exports only, skips `default` | Prefers `default`, fallback to named |
| Workspace discovery | Project dir `epicenter.config.ts` | `$EPICENTER_HOME/workspaces/` registry |
| Data access | Direct Y.Doc (wires persistence + sync) | HTTP to local server (that doesn't exist) |
| Lifecycle | Long-lived daemon | Short-lived commands |

Three concrete problems:
1. **Two auth systems that can't share tokens.** `epicenter auth login` and `runner login` write incompatible files to different locations.
2. **CLI `data` commands are dead code.** They call `assertServerRunning()` against `http://localhost:3913`: a server the `hub start` stub can't start.
3. **Two config loaders with different conventions.** CLI prefers `default` exports. Runner skips them. Same config file, different behavior.

## Solution

Merge Runner into CLI as `epicenter start [dir]`. Delete the `hub` stubs. Unify auth and config loading.

### Command Hierarchy (After Merge)

```
epicenter
├── start [dir]                   # long-lived sync daemon (moved from Runner)
├── auth
│   ├── login --server <url>      # interactive password (existing)
│   ├── login --server <url> --device  # device code flow (moved from Runner)
│   ├── logout [--server <url>]
│   └── status [--server <url>]
├── workspace
│   ├── add <path>                # symlink (existing)
│   ├── install <item>            # jsrepo (existing)
│   ├── uninstall <id>            # remove (existing)
│   ├── ls                        # list (existing)
│   └── export <id>               # export (existing)
└── data <workspace>              # reworked: reads Y.Doc from disk, no HTTP
    ├── tables
    ├── kv get/set/delete
    ├── action <path>
    └── <table> list/get/set/update/delete
```

## Detailed Design

### 1. `epicenter start [dir]`

Replaces `apps/runner`. A foreground process that:

1. Resolves `epicenter.config.ts` in `[dir]` (default: cwd)
2. Loads token from unified auth store
3. For each raw `WorkspaceDefinition`: auto-wires `filesystemPersistence` + `createSyncExtension`
4. For each pre-wired `WorkspaceClient`: passthrough (already has extensions)
5. Awaits `whenReady` on all clients
6. Prints status, stays alive
7. SIGINT/SIGTERM → `destroy()` all clients → exit

**Not a server.** No local HTTP. No pid management. No `stop`/`status` commands. It's a foreground daemon. Ctrl+C stops it. If daemon management is needed later, that's a separate concern (launchd/systemd/pm2).

**Why not `hub start`?** "Hub" implies a server managing multiple things. This is a sync client. It connects *to* a hub, it doesn't *run* one. The name `start` is clearer.

### 2. Unified Auth Store

**Location**: `$EPICENTER_HOME/auth/sessions.json`

**Format**:
```json
{
  "https://api.epicenter.so": {
    "access_token": "ey...",
    "server": "https://api.epicenter.so",
    "created_at": 1710700000000,
    "expires_in": 604800,
    "user": { "id": "...", "email": "...", "name": "..." }
  }
}
```

Keyed by server URL. Supports multiple servers simultaneously.

**Resolution order** (same as Runner's existing behavior):
1. `EPICENTER_TOKEN` env var → immediate (CI/scripts)
2. `--server <url>` flag + session store lookup
3. Default server from session store (most recently used)

**Both auth methods available:**
- `epicenter auth login --server <url>` → interactive email/password (existing CLI behavior)
- `epicenter auth login --server <url> --device` → device code flow (existing Runner behavior)
- If stdin is not a TTY and `--device` is not set → auto-use device code flow

**Migration**: On first run, read from both old locations (`$EPICENTER_HOME/auth.json` and `{configDir}/.epicenter/auth/token.json`), merge into new format, leave old files in place (don't break existing installs).

### 3. Unified Config Loading

One function, one convention:

```typescript
// packages/cli/src/config/load-config.ts

export async function loadConfig(targetDir: string): Promise<LoadConfigResult> {
  // 1. Resolve epicenter.config.ts
  // 2. Dynamic import
  // 3. If default export is valid → use it (single workspace)
  // 4. Else, collect named exports (multi-workspace)
  // 5. Classify each: WorkspaceDefinition vs WorkspaceClient
  // 6. Duplicate ID detection
}
```

Rule: **`default` takes priority.** If present and valid, it's the only workspace. Named exports are for multi-workspace configs. This matches standard JS module conventions.

### 4. `data` Commands: Direct Disk Access

Instead of HTTP to a nonexistent local server, `data` commands open workspaces directly:

```typescript
// Shared helper: open a workspace from disk (persistence only, no sync)
function openWorkspaceFromDisk(definition, persistencePath) {
  return createWorkspace(definition)
    .withExtension('persistence', filesystemPersistence({ filePath: persistencePath }));
}
```

This is exactly what `workspace export` already does (loads Y.Doc from `.yjs` file). We generalize it.

**New flag**: `epicenter data --dir <path> <workspace> notes list`
- `--dir`: target a project directory's `epicenter.config.ts`
- Without `--dir`: uses `$EPICENTER_HOME/workspaces/` (existing behavior)

**Concurrency note**: If `epicenter start` is running and writing to the SQLite persistence file, a concurrent `epicenter data` read *should* be safe. SQLite supports concurrent readers by default (WAL mode). But if it causes issues, that's the signal to add a local RPC layer. Cross that bridge when we hit it.

### 5. File Structure (After Merge)

```
packages/cli/
├── src/
│   ├── bin.ts                        # entry (existing)
│   ├── cli.ts                        # yargs setup (modified)
│   ├── index.ts                      # public API (existing)
│   │
│   ├── config/
│   │   ├── load-config.ts            # unified config loader (merge of both)
│   │   └── resolve-config.ts         # existing discovery.ts, renamed
│   │
│   ├── auth/
│   │   ├── store.ts                  # unified session store
│   │   ├── device-flow.ts            # from apps/runner/src/auth.ts
│   │   └── password-flow.ts          # from existing auth-command.ts (extracted)
│   │
│   ├── runtime/
│   │   ├── start-daemon.ts           # from apps/runner/src/index.ts
│   │   └── open-workspace.ts         # shared: open from disk with persistence
│   │
│   ├── commands/
│   │   ├── start-command.ts          # NEW: yargs wrapper for start-daemon
│   │   ├── auth-command.ts           # modified: uses unified auth
│   │   ├── workspace-command.ts      # existing
│   │   └── data-command.ts           # modified: direct disk access
│   │
│   ├── http-client.ts                # existing (still used for remote API calls)
│   ├── format-output.ts              # existing
│   ├── parse-input.ts                # existing
│   └── paths.ts                      # existing
│
├── test/
│   └── fixtures/
│       └── honeycrisp-basic/
│           ├── epicenter.config.ts    # imports honeycrisp defineWorkspace
│           └── package.json           # deps: @epicenter/workspace
│
└── package.json                       # add deps from runner
```

**Deleted after merge:**
- `apps/runner/` (entire directory)
- `packages/cli/src/commands/hub-command.ts` (stubs)

### 6. What Moves Where

| Source | Destination | Changes |
|---|---|---|
| `apps/runner/src/index.ts` (main logic) | `packages/cli/src/runtime/start-daemon.ts` | Extract into `startDaemon(options)` function. Remove manual argv parsing. |
| `apps/runner/src/auth.ts` | `packages/cli/src/auth/device-flow.ts` | Keep `login()` and `loadToken()`. Remove `logout()` (use unified store). |
| `apps/runner/src/load-config.ts` | `packages/cli/src/config/load-config.ts` | Merge with CLI's `loadClientFromPath`. Add default export support. |
| `packages/cli/src/discovery.ts` | `packages/cli/src/config/resolve-config.ts` | Rename. Keep `resolveWorkspace`, `discoverWorkspaces`. |
| `packages/cli/src/auth-store.ts` | `packages/cli/src/auth/store.ts` | Rewrite: multi-server keyed JSON. Migration from old formats. |
| `packages/cli/src/commands/auth-command.ts` | Same path, modified | Add `--device` flag. Use unified store. |
| `packages/cli/src/commands/hub-command.ts` | **Deleted** | Stubs provide no value. |
| `packages/cli/src/commands/data-command.ts` | Same path, modified | Replace HTTP calls with direct Y.Doc disk access. |

## End-to-End Test

### Goal

Prove the full flow works without jsrepo, without Cloudflare, without auth:

1. Config loads from `epicenter.config.ts`
2. Workspace instantiates with persistence
3. Data written via workspace client persists to SQLite
4. Data readable via CLI `data` commands from the same persistence file
5. Restart proves data survives across process lifetimes

### Test Fixture

```
packages/cli/test/fixtures/honeycrisp-basic/
├── epicenter.config.ts
└── package.json
```

```typescript
// epicenter.config.ts
import {
  defineWorkspace,
  defineTable,
  defineKv,
  DateTimeString,
  dateTimeStringNow,
} from '@epicenter/workspace';
import { type } from 'arktype';

const foldersTable = defineTable(
  type({
    id: 'string',
    name: 'string',
    'icon?': 'string | undefined',
    sortOrder: 'number',
    _v: '1',
  }),
);

const notesTable = defineTable(
  type({
    id: 'string',
    'folderId?': 'string | undefined',
    title: 'string',
    preview: 'string',
    pinned: 'boolean',
    'deletedAt?': 'string | undefined',
    'wordCount?': 'number | undefined',
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '2',
  }),
);

export default defineWorkspace({
  id: 'epicenter.honeycrisp',
  tables: { folders: foldersTable, notes: notesTable },
  kv: {
    selectedFolderId: defineKv(type('string | null'), null),
    selectedNoteId: defineKv(type('string | null'), null),
    sortBy: defineKv(
      type("'dateEdited' | 'dateCreated' | 'title'"),
      'dateEdited',
    ),
    sidebarCollapsed: defineKv(type('boolean'), false),
  },
});
```

### Test Script

```typescript
// packages/cli/test/e2e-honeycrisp.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createWorkspace } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { loadConfig } from '../src/config/load-config';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/honeycrisp-basic');
const PERSISTENCE_DIR = join(FIXTURE_DIR, '.epicenter-test');

describe('e2e: honeycrisp workspace', () => {
  beforeAll(async () => {
    // Clean persistence from previous runs
    await rm(PERSISTENCE_DIR, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(PERSISTENCE_DIR, { recursive: true, force: true });
  });

  test('loads config and classifies as definition', async () => {
    const result = await loadConfig(FIXTURE_DIR);
    expect(result.definitions.length + result.clients.length).toBeGreaterThan(0);

    // Should find honeycrisp workspace
    const all = [...result.definitions, ...result.clients];
    const honeycrisp = all.find((w) => w.id === 'epicenter.honeycrisp');
    expect(honeycrisp).toBeDefined();
  });

  test('writes and reads data through persistence', async () => {
    const { definitions } = await loadConfig(FIXTURE_DIR);
    const definition = definitions[0]!;

    const dbPath = join(PERSISTENCE_DIR, `${definition.id}.db`);

    // Create workspace with filesystem persistence (no sync)
    const client = createWorkspace(definition)
      .withExtension('persistence', filesystemPersistence({ filePath: dbPath }));

    await client.whenReady;

    // Write a folder
    client.tables.folders.set({
      id: 'folder-1',
      name: 'Work Notes',
      icon: undefined,
      sortOrder: 0,
      _v: 1,
    });

    // Write a note
    const now = new Date().toISOString();
    client.tables.notes.set({
      id: 'note-1',
      folderId: 'folder-1',
      title: 'Test Note',
      preview: 'This is a test note from the e2e test',
      pinned: false,
      deletedAt: undefined,
      wordCount: 8,
      createdAt: now,
      updatedAt: now,
      _v: 2,
    });

    // Verify reads
    const folders = client.tables.folders.getAllValid();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('Work Notes');

    const notes = client.tables.notes.getAllValid();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Test Note');

    // Destroy to flush persistence
    await client.destroy();
  });

  test('data survives restart (persistence proof)', async () => {
    const { definitions } = await loadConfig(FIXTURE_DIR);
    const definition = definitions[0]!;
    const dbPath = join(PERSISTENCE_DIR, `${definition.id}.db`);

    // Re-open same workspace: should load persisted state
    const client = createWorkspace(definition)
      .withExtension('persistence', filesystemPersistence({ filePath: dbPath }));

    await client.whenReady;

    // Data written in previous test should be here
    const folders = client.tables.folders.getAllValid();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('Work Notes');

    const notes = client.tables.notes.getAllValid();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Test Note');

    await client.destroy();
  });

  test('KV persistence works', async () => {
    const { definitions } = await loadConfig(FIXTURE_DIR);
    const definition = definitions[0]!;
    const dbPath = join(PERSISTENCE_DIR, `${definition.id}.db`);

    const client = createWorkspace(definition)
      .withExtension('persistence', filesystemPersistence({ filePath: dbPath }));

    await client.whenReady;

    // Set KV value
    client.kv.sortBy.set('title');
    client.kv.sidebarCollapsed.set(true);

    await client.destroy();

    // Re-open and verify
    const client2 = createWorkspace(definition)
      .withExtension('persistence', filesystemPersistence({ filePath: dbPath }));

    await client2.whenReady;

    expect(client2.kv.sortBy.get()).toBe('title');
    expect(client2.kv.sidebarCollapsed.get()).toBe(true);

    await client2.destroy();
  });
});
```

### What This Proves

- [x] `loadConfig()` correctly loads `epicenter.config.ts` with a `default` export
- [x] Raw definitions can be wired with `filesystemPersistence` (same path as `start` will use)
- [x] Table CRUD works (set, getAllValid, filter)
- [x] KV works (get, set)
- [x] SQLite persistence survives process restart
- [x] No auth, no network, no Cloudflare required

### What This Does NOT Prove (Future Tests)

- [ ] WebSocket sync between two clients (needs local sync server or mock)
- [ ] Device code auth flow (needs API)
- [ ] CLI `data` commands reading from persisted state (needs the reworked data-command.ts)
- [ ] Multi-workspace configs (named exports)
- [ ] Pre-wired `WorkspaceClient` passthrough

## Implementation Order

1. **Unified config loader**: merge Runner's `loadConfig` + CLI's `loadClientFromPath` into one function at `packages/cli/src/config/load-config.ts`. Add `default` export support.
2. **E2e test fixture + test**: create `test/fixtures/honeycrisp-basic/` and the test above. Run it. This validates the config loader and persistence independently.
3. **`start-daemon.ts`**: extract Runner's main logic into a function. Import unified config loader.
4. **`start` command**: yargs wrapper that calls `startDaemon()`.
5. **Unified auth store**: new `auth/store.ts` with multi-server support. Migration from old formats.
6. **Auth commands**: modify to use unified store, add `--device` flag.
7. **`data` commands**: replace HTTP calls with direct disk access via `openWorkspaceFromDisk()`.
8. **Delete `apps/runner/`**: move example config to test fixtures.
9. **Delete `hub-command.ts`**: remove stubs.

## Review

*To be filled after implementation.*
