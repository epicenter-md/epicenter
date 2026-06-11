# `connectWorkspace`: One-Line Authenticated Workspace for Scripts

**Date**: 2026-04-14
**Status**: Superseded in part: 2026-04-18
**Author**: AI-assisted

> **2026-04-18 Update**: `connectWorkspace` no longer attaches filesystem persistence. It now chains only `unlock → sync` and is ephemeral by design. Rationale: scripts are short-lived and the sync handshake downloads the full doc on connect, so paying for a second SQLite writer only created lock contention with a concurrently running `epicenter start` daemon on the same workspace. Persistence remains the daemon's responsibility; see `epicenter.config.ts` examples. References below that show `persistence` in the chain are historical.
>
> **Path note (2026-05-22):** The `resolveEpicenterHome()`, `~/.epicenter/auth/sessions.json`, and `~/.epicenter/persistence/` examples are stale. Do not copy them into new script or daemon persistence work.

## Overview

Add a `connectWorkspace` function to `@epicenter/cli` that takes a workspace factory function and returns a fully authenticated, syncing, persisted workspace client in one `await`. Eliminates the 15-line boilerplate that every script and playground config currently copy-pastes.

## Motivation

### Current State

Every server-side script or `epicenter.config.ts` that connects to a workspace repeats the same ceremony:

```typescript
const sessions = createSessionStore(resolveEpicenterHome());

const workspace = createFujiWorkspace()
  .withExtension('persistence', filesystemPersistence({
    filePath: join(import.meta.dir, '.epicenter', 'persistence', 'fuji.db'),
  }))
  .withWorkspaceExtension('unlock', createCliUnlock(sessions, SERVER_URL))
  .withExtension('sync', createSyncExtension({
    url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
    getToken: async () => {
      const session = await sessions.load(SERVER_URL);
      return session?.accessToken ?? null;
    },
  }));

await workspace.whenReady;
```

This creates problems:

1. **Agent-hostile**: An agent writing a Bun script needs to know 5+ imports, their wiring order, and the session store pattern. Easy to cargo-cult, hard to get right.
2. **Extension ordering footgun**: If sync is chained before persistence, it downloads the full document on every cold start instead of exchanging a delta. Nothing prevents this at the type level.
3. **Duplication**: The vault `epicenter.config.ts`, both playground configs, and every app's `client.ts` repeat the same unlock + sync boilerplate with only path/URL differences.

### Desired State

```typescript
import { connectWorkspace } from '@epicenter/cli';
import { createFujiWorkspace } from '@epicenter/fuji/workspace';

const workspace = await connectWorkspace(createFujiWorkspace);
// Ready. Authenticated. Syncing. Persistence loaded.

const entries = workspace.tables.entries.getAllValid();
await workspace.dispose();
```

Two imports. One await. Type-safe. Extension ordering handled internally.

## Research Findings

### Existing Call Site Patterns

Every app in the monorepo follows the same two-layer pattern:

| Layer | Location | What it does |
|---|---|---|
| Factory | `apps/*/src/lib/workspace/workspace.ts` | `createWorkspace(def).withActions(...)`: schema + actions only |
| Consumer | `apps/*/src/lib/client.ts` or `epicenter.config.ts` | Chains persistence + unlock + sync: environment-specific |

Factory functions are intentionally bare (no I/O, isomorphic). The consumer adds environment-specific extensions. `connectWorkspace` is the "CLI/script consumer". The counterpart of the browser's `client.ts`.

### Extension Initialization Model

Extensions initialize in registration order. Each factory receives `ctx.whenReady`: a composite promise of all prior extensions.

- Persistence extensions (SQLite, IndexedDB) do **not** await `ctx.whenReady`: they start loading immediately.
- Unlock and sync extensions **do** await `ctx.whenReady`: they wait for persistence to finish.

This means the chain `persistence → unlock → sync` creates the correct dependency graph without explicit coordination:

```
persistence starts immediately ──────────────→ done
                                                ↓
                          unlock waits... ─────→ applies keys → done
                                                                 ↓
                          sync waits... ────────────────────────→ connects (delta only)
```

### Auth Infrastructure

- `createSessionStore(resolveEpicenterHome())` reads from `~/.epicenter/auth/sessions.json`
- Sessions are stored per server URL: `{ accessToken, encryptionKeys, user }`
- `createCliUnlock` reads encryption keys from the session and calls `applyEncryptionKeys()`
- `createSyncExtension` uses `getToken` to fetch the access token on each reconnect
- Both read from the same session store: shared via closure

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Input type | Factory function `() => T` | Every app exports a `create*Workspace()` factory. Passing the function (not the result) avoids ambiguity about `()` vs no `()` and matches the established pattern. |
| Persistence | Always on, no flag | Redownloading the full workspace on every script run is wasteful. SQLite at `~/.epicenter/persistence/<id>.db` is the sensible default. |
| Server URL | Destructured option with env var default | `process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so'`. Local dev needs `http://localhost:8787`. |
| Return type | Inferred from factory + chained extensions | Let TypeScript infer naturally. The return type includes tables, actions, AND the infrastructure extensions. Scripts use tables/actions; extensions are ignorable. |
| `whenReady` | Awaited internally | The function returns a ready client. No `.whenReady` needed at the call site. |
| Materializer | Not included | Too workspace-specific (different tables, different serializers). Materializers belong in `epicenter.config.ts`, not in a generic connect function. |
| Package location | `packages/cli/src/connect.ts` | The CLI package already owns session store, unlock extension, and config loading. `connectWorkspace` is the script-oriented complement to `loadConfig`. |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  connectWorkspace(createFujiWorkspace)                    │
│                                                          │
│  1. Call factory() → get builder with schema + actions   │
│  2. Read workspace ID from builder                       │
│  3. Create session store from ~/.epicenter/              │
│  4. Chain extensions in order:                           │
│     a. persistence (SQLite at ~/.epicenter/persistence/) │
│     b. unlock (encryption keys from session store)       │
│     c. sync (WebSocket with auth token)                  │
│  5. await client.whenReady                               │
│  6. Return ready client                                  │
└──────────────────────────────────────────────────────────┘
```

### File Structure

```
packages/cli/src/
├── connect.ts          ← NEW: connectWorkspace function
├── extensions.ts       ← existing: createCliUnlock
├── auth/store.ts       ← existing: createSessionStore
├── load-config.ts      ← existing: epicenter.config.ts loader
└── index.ts            ← update: re-export connectWorkspace
```

## Implementation Plan

### Phase 1: Core Function

- [ ] **1.1** Create `packages/cli/src/connect.ts` with `connectWorkspace` function
- [ ] **1.2** Export from `packages/cli/src/index.ts`
- [ ] **1.3** Add JSDoc with usage example and extension ordering explanation

### Phase 2: Validation

- [ ] **2.1** Write a test script in `packages/cli/test/` that uses `connectWorkspace` with a test workspace
- [ ] **2.2** Verify TypeScript inference: `workspace.tables.*` and `workspace.actions.*` should be fully typed
- [ ] **2.3** Verify extension ordering: persistence loads before sync connects

### Phase 3: Documentation

- [ ] **3.1** Update `packages/cli/README.md` with `connectWorkspace` usage
- [ ] **3.2** Add example script to `packages/cli/src/README.md` CLI docs

## Implementation

```typescript
// packages/cli/src/connect.ts

import { join } from 'node:path';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
import { createSessionStore } from './auth/store.js';
import { createCliUnlock } from './extensions.js';
import { resolveEpicenterHome } from './home.js';

import type { AnyWorkspaceClientBuilder } from '@epicenter/workspace';

/**
 * Connect a workspace factory to the Epicenter API with authentication,
 * persistence, and sync: ready to use in one `await`.
 *
 * Chains extensions in the correct order (persistence → unlock → sync) so
 * the sync handshake only exchanges the delta between local state and the
 * server. Persistence is stored at `~/.epicenter/persistence/<workspace-id>.db`.
 *
 * Requires a prior `epicenter auth login` to store session credentials at
 * `~/.epicenter/auth/sessions.json`.
 *
 * @param factory - Workspace factory function (e.g. `createFujiWorkspace`).
 *   Must return a workspace builder: typically `createWorkspace(def).withActions(...)`.
 * @param opts.server - Epicenter API server URL. Defaults to
 *   `process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so'`.
 *
 * @example
 * ```typescript
 * import { connectWorkspace } from '@epicenter/cli';
 * import { createFujiWorkspace } from '@epicenter/fuji/workspace';
 *
 * const workspace = await connectWorkspace(createFujiWorkspace);
 *
 * const entries = workspace.tables.entries.filter(e => !e.deletedAt);
 * for (const entry of entries) {
 *   workspace.tables.entries.update(entry.id, { tags: [...entry.tags, 'Journal'] });
 * }
 *
 * await workspace.dispose();
 * ```
 */
export async function connectWorkspace<T extends AnyWorkspaceClientBuilder>(
  factory: () => T,
  { server = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so' }: { server?: string } = {},
) {
  const sessions = createSessionStore(resolveEpicenterHome());
  const base = factory();

  const client = base
    .withExtension('persistence', filesystemPersistence({
      filePath: join(resolveEpicenterHome(), 'persistence', `${base.id}.db`),
    }))
    .withWorkspaceExtension('unlock', createCliUnlock(sessions, server))
    .withExtension('sync', createSyncExtension({
      url: (docId) => `${server}/workspaces/${docId}`,
      getToken: async () => (await sessions.load(server))?.accessToken ?? null,
    }));

  await client.whenReady;
  return client;
}
```

## Edge Cases

### No Session Stored

1. User hasn't run `epicenter auth login`
2. `sessions.load(server)` returns `null`
3. `getToken` returns `null`: sync connects without auth (will fail on authenticated endpoints)
4. `createCliUnlock` skips encryption key application

**Expected**: Sync fails with an auth error. The error message from the WebSocket close should surface. Consider adding a pre-check that throws a clear error like `"No session found for ${server}. Run: epicenter auth login --server ${server}"`.

### Workspace Already Has Extensions

1. Factory returns a builder that already has persistence or sync chained
2. `connectWorkspace` chains them again: duplicate extensions

**Expected**: This is a misuse. The factory pattern (`createFujiWorkspace`) deliberately returns schema + actions only. Document that `connectWorkspace` is for bare factories, not pre-configured clients.

### Dispose Without Sync Flush

1. Script calls `workspace.dispose()` immediately after writes
2. Sync extension hasn't pushed changes to server yet
3. Local persistence has the writes (SQLite observer is synchronous)
4. Next run will have the writes locally and sync them

**Expected**: Writes are not lost because persistence captures them. They'll sync on the next run. For scripts that need immediate server confirmation, a future `flush()` API on the sync extension would be needed.

## Open Questions

1. **Should `connectWorkspace` pre-check for a valid session?**
   - Options: (a) Throw immediately if no session, (b) Let sync fail naturally, (c) Log a warning
   - **Recommendation**: (a) Throw with a clear message. Scripts should fail fast, not silently produce empty results because auth failed.

2. **Should the return type strip builder methods (`withExtension`, etc.)?**
   - Options: (a) Return as-is (builder methods visible but useless), (b) Omit builder methods from type
   - **Recommendation**: (a) Return as-is for simplicity. Builder methods are harmless noise in autocomplete.

## Success Criteria

- [ ] `const workspace = await connectWorkspace(createFujiWorkspace)` compiles and returns a typed client
- [ ] `workspace.tables.entries` and `workspace.actions.entries.*` are fully typed
- [ ] Extension chain is persistence → unlock → sync (verified by init order)
- [ ] Persistence files appear at `~/.epicenter/persistence/<id>.db`
- [ ] Sync authenticates using the stored session token
- [ ] Encrypted fields are readable (unlock applies keys)
- [ ] `workspace.dispose()` cleans up without errors
- [ ] TypeScript build passes with no errors

## References

- `packages/cli/src/extensions.ts`: `createCliUnlock` implementation
- `packages/cli/src/auth/store.ts`: `createSessionStore` implementation
- `packages/cli/src/load-config.ts`: How CLI discovers workspace exports (for comparison)
- `packages/workspace/src/extensions/persistence/sqlite.ts`: `filesystemPersistence` factory
- `packages/workspace/src/extensions/sync/websocket.ts`: `createSyncExtension` factory
- `playground/opensidian-e2e/epicenter.config.ts`: Reference config with full extension chain
- `~/Code/vault/epicenter.config.ts`: Real-world config this function replaces for scripts
