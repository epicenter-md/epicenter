# Y-Sweet Persist-Sync Rename

**Date**: 2026-02-13
**Status**: Implemented (clean break, no backward-compat shims)
**Related**: `20260213T102800-chainable-extension-api.md` (can be implemented independently)

## Overview

Rename `ySweetSync` to `ySweetPersistSync`, make `persistence` a required config option, and move the persistence implementations (`indexeddbPersistence`, `filesystemPersistence`) into the y-sweet extension module. The standalone `extensions/persistence/` directory becomes a backward-compat re-export shim or is removed.

## Motivation

### The Name Lies

`ySweetSync` isn't just sync. It orchestrates a two-phase lifecycle:

1. Load from local persistence (IndexedDB or filesystem)
2. Connect WebSocket to Y-Sweet server in the background
3. Resolve `whenSynced` on persistence load (not network)
4. Destroy both on cleanup

Calling this "sync" undersells half of what it does and confuses users about what the extension manages. The name `ySweetPersistSync` makes the dual nature explicit.

### Persistence Is the Point

The entire design of this extension assumes a local-first pattern: persistence loads first, then WebSocket connects in the background. Without persistence, it degrades to a bare WebSocket provider, which `websocketSync` (`extensions/websocket-sync.ts`) already covers.

Making `persistence` optional creates a false choice. If you don't need persistence, use `websocketSync`. If you want Y-Sweet, you want the full local-first lifecycle, which requires persistence.

### Scattered Persistence Is Confusing

Today, `indexeddbPersistence` and `filesystemPersistence` live in `extensions/persistence/` as standalone extension factories that also happen to be composable into `ySweetSync`. This dual identity is confusing:

- Are they standalone extensions or config options for ySweetSync?
- Why do they exist in a separate directory from the extension that actually uses them?

They're exclusively used as the `persistence` argument to `ySweetSync`. Moving them into the y-sweet module makes the relationship clear.

## Design Decisions

| Decision                         | Choice                                         | Rationale                                                           |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| New name                         | `ySweetPersistSync`                            | Explicit about dual nature (persist + sync)                         |
| `persistence` config             | Required                                       | Without it, use `websocketSync` instead                             |
| Persistence location             | Move into y-sweet module as sub-paths          | Co-locate with the only consumer                                    |
| Standalone persistence files     | Become re-export shims (deprecation path)      | Don't break external consumers who import from the old path         |
| `extensions/persistence/` export | Keep as re-exports initially, remove in future | Gradual migration                                                   |
| Epicenter Tauri app              | Out of scope                                   | Uses custom `workspacePersistence` with no sync: different pattern |
| File naming                      | `y-sweet-persist-sync.ts`                      | Matches the function name in kebab-case                             |

## Current State

### File Layout

```
packages/epicenter/src/extensions/
├── y-sweet-sync.ts              # ySweetSync(config) → ExtensionFactory
├── y-sweet-sync.test.ts         # Tests
├── persistence/
│   ├── web.ts                   # indexeddbPersistence: browser (y-indexeddb)
│   ├── desktop.ts               # filesystemPersistence + persistence: Node.js/Bun
│   ├── index.browser.ts         # Conditional re-export → web.ts
│   └── index.node.ts            # Conditional re-export → desktop.ts
└── websocket-sync.ts            # websocketSync: standalone y-websocket
```

### Package.json Exports

```json
{
	"./extensions/persistence": {
		"browser": "./src/extensions/persistence/index.browser.ts",
		"node": "./src/extensions/persistence/index.node.ts",
		"default": "./src/extensions/persistence/index.node.ts"
	},
	"./extensions/y-sweet-sync": "./src/extensions/y-sweet-sync.ts"
}
```

### Current Config Type

```typescript
type YSweetSyncConfig = {
	auth: (docId: string) => Promise<ClientToken>;
	persistence?: (context: { ydoc: Y.Doc }) => Lifecycle; // optional
};
```

### Current Import Pattern (call sites)

```typescript
// apps/tab-manager/src/lib/workspace-popup.ts
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence';
import { directAuth, ySweetSync } from '@epicenter/workspace/extensions/y-sweet-sync';

// apps/tab-manager/src/entrypoints/background.ts
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence';
import { directAuth, ySweetSync } from '@epicenter/workspace/extensions/y-sweet-sync';
```

### Current Usage

```typescript
createWorkspace(definition).withExtension(
	'sync',
	ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
);
```

## New State

### File Layout

```
packages/epicenter/src/extensions/
├── y-sweet-persist-sync.ts       # ySweetPersistSync(config) → ExtensionFactory
├── y-sweet-persist-sync.test.ts  # Tests (renamed)
├── y-sweet-persist-sync/
│   ├── web.ts                    # indexeddbPersistence (MOVED from persistence/web.ts)
│   └── desktop.ts                # filesystemPersistence (MOVED from persistence/desktop.ts)
├── persistence/                  # RE-EXPORT SHIMS (backward compat, marked deprecated)
│   ├── web.ts                    # re-exports from ../y-sweet-persist-sync/web.ts
│   ├── desktop.ts                # re-exports from ../y-sweet-persist-sync/desktop.ts
│   ├── index.browser.ts          # re-exports from ../y-sweet-persist-sync/web.ts
│   └── index.node.ts             # re-exports from ../y-sweet-persist-sync/desktop.ts
└── websocket-sync.ts             # websocketSync: unchanged
```

### Package.json Exports

```json
{
	"./extensions/y-sweet-persist-sync": "./src/extensions/y-sweet-persist-sync.ts",
	"./extensions/y-sweet-persist-sync/web": "./src/extensions/y-sweet-persist-sync/web.ts",
	"./extensions/y-sweet-persist-sync/desktop": "./src/extensions/y-sweet-persist-sync/desktop.ts",
	"./extensions/persistence": {
		"browser": "./src/extensions/persistence/index.browser.ts",
		"node": "./src/extensions/persistence/index.node.ts",
		"default": "./src/extensions/persistence/index.node.ts"
	},
	"./extensions/y-sweet-sync": "./src/extensions/y-sweet-sync.ts"
}
```

Note: The old export paths (`./extensions/persistence`, `./extensions/y-sweet-sync`) are kept temporarily as re-export shims. They can be removed in a future breaking change.

**Alternative (clean break, recommended if external consumers are few):** Remove the old paths entirely. The only known consumers are the two tab-manager files. If there are no external consumers of `@epicenter/workspace/extensions/persistence`, skip the shims.

### New Config Type

```typescript
type YSweetPersistSyncConfig = {
	/** Auth callback that returns a ClientToken for the given doc ID. */
	auth: (docId: string) => Promise<ClientToken>;
	/** Persistence factory. REQUIRED: loads local state before connecting. */
	persistence: (context: { ydoc: Y.Doc }) => Lifecycle;
};
```

`persistence` is no longer optional. The `hasPersistence` branch in the current implementation is removed. The extension always loads persistence first, then connects WebSocket in the background.

### New Import Pattern

```typescript
// Primary import: everything from one path
import {
	ySweetPersistSync,
	directAuth,
} from '@epicenter/workspace/extensions/y-sweet-persist-sync';

// Persistence from platform-specific sub-paths
import { indexeddbPersistence } from '@epicenter/workspace/extensions/y-sweet-persist-sync/web';
import { filesystemPersistence } from '@epicenter/workspace/extensions/y-sweet-persist-sync/desktop';
```

### New Usage

```typescript
// Browser (tab-manager)
import { indexeddbPersistence } from '@epicenter/workspace/extensions/y-sweet-persist-sync/web';
import {
	ySweetPersistSync,
	directAuth,
} from '@epicenter/workspace/extensions/y-sweet-persist-sync';

createWorkspace(definition).withExtension(
	'sync',
	ySweetPersistSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
);

// Desktop/Node.js
import { filesystemPersistence } from '@epicenter/workspace/extensions/y-sweet-persist-sync/desktop';
import {
	ySweetPersistSync,
	directAuth,
} from '@epicenter/workspace/extensions/y-sweet-persist-sync';

createWorkspace(definition).withExtension(
	'sync',
	ySweetPersistSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' }),
	}),
);
```

Note: Usage examples above use `.withExtension()` (singular) from the chainable extension API spec. If that spec is not yet implemented, the current `.withExtensions({ sync: ... })` pattern works identically. The rename is independent of the chaining refactor.

## Import Path Design: Rationale

**Why sub-paths (`/web`, `/desktop`) instead of a single conditional export?**

The current `extensions/persistence` uses conditional exports (`browser` vs `node` in package.json). This is clever but has problems:

1. **IDE discovery**: You can't see what's available without checking package.json
2. **Testing**: Hard to import the browser version in Node.js tests
3. **Explicit is better**: `import from '.../web'` vs `import from '.../desktop'` is immediately clear

The sub-path approach also matches how other platform-specific modules work in the ecosystem.

**Why keep `directAuth` in the main module?**

`directAuth` is a utility function, not platform-specific. It belongs alongside `ySweetPersistSync` in the main export.

## Implementation Changes to `y-sweet-persist-sync.ts`

The implementation simplifies because the `hasPersistence` branch is removed:

```typescript
export function ySweetPersistSync(
	config: YSweetPersistSyncConfig,
): ExtensionFactory {
	return ({ ydoc }) => {
		let currentAuth = config.auth;
		const authEndpoint = () => currentAuth(ydoc.guid);

		// Create provider: defer connection until persistence loads
		let provider: YSweetProvider = createYjsProvider(
			ydoc,
			ydoc.guid,
			authEndpoint,
			{ connect: false }, // Always false: persistence always loads first
		);

		let persistenceCleanup: (() => MaybePromise<void>) | undefined;

		// whenSynced = persistence loaded (local-first: fast, reliable)
		// WebSocket connects in background: don't block on it.
		const whenSynced = (async () => {
			const p = config.persistence({ ydoc });
			persistenceCleanup = p.destroy;
			await p.whenSynced;
			// Kick off WebSocket in background
			provider.connect().catch(() => {
				// Suppress unhandled rejection. Connection errors
				// are surfaced reactively via provider status events.
			});
		})();

		return {
			get provider() {
				return provider;
			},
			whenSynced,
			reconnect(newAuth: (docId: string) => Promise<ClientToken>) {
				provider.destroy();
				currentAuth = newAuth;
				provider = createYjsProvider(ydoc, ydoc.guid, authEndpoint);
				provider.connect();
			},
			destroy() {
				persistenceCleanup?.();
				provider.destroy();
			},
		};
	};
}
```

**What's removed:**

- The `hasPersistence` check (`const hasPersistence = !!config.persistence`)
- The `hasPersistence ? ... : waitForFirstSync(provider)` conditional
- The `waitForFirstSync()` helper function
- The `{ connect: !hasPersistence }` conditional: now always `{ connect: false }`

**What's kept:**

- `directAuth()` helper: unchanged, re-exported
- `ClientToken` re-export: unchanged
- `reconnect()` method: unchanged
- `provider` getter: unchanged

## What Happens to the Old `y-sweet-sync.ts`

Two options:

### Option A: Re-export shim (recommended)

```typescript
// packages/epicenter/src/extensions/y-sweet-sync.ts
/**
 * @deprecated Use `@epicenter/workspace/extensions/y-sweet-persist-sync` instead.
 */
export {
	ySweetPersistSync as ySweetSync,
	directAuth,
} from './y-sweet-persist-sync';
export type { YSweetPersistSyncConfig as YSweetSyncConfig } from './y-sweet-persist-sync';
```

This keeps the old import path working but with a deprecation signal. The type alias means existing code that passes `persistence` (which was already the common case) continues to work. Code that relied on `persistence` being optional will get a type error, which is the desired behavior.

### Option B: Delete it

If we're doing a clean break (no external consumers), just delete `y-sweet-sync.ts` and remove the `./extensions/y-sweet-sync` export from package.json. The implementer should grep for any remaining imports.

**Recommendation:** Option A for now. Delete in a follow-up.

## What Happens to Standalone `persistence/` Files

### `persistence/web.ts` → Re-export shim

```typescript
// packages/epicenter/src/extensions/persistence/web.ts
/**
 * @deprecated Import from '@epicenter/workspace/extensions/y-sweet-persist-sync/web' instead.
 */
export { indexeddbPersistence } from '../y-sweet-persist-sync/web';
```

### `persistence/desktop.ts` → Re-export shim

```typescript
// packages/epicenter/src/extensions/persistence/desktop.ts
/**
 * @deprecated Import from '@epicenter/workspace/extensions/y-sweet-persist-sync/desktop' instead.
 */
export {
	filesystemPersistence,
	persistence,
	type PersistenceConfig,
} from '../y-sweet-persist-sync/desktop';
```

### `persistence/index.browser.ts` and `persistence/index.node.ts` → Update re-exports

Point to the new shims (which themselves point to the new location).

### Alternative: Delete persistence/ entirely

The `persistence/` directory's only real consumers are:

1. `apps/tab-manager/src/lib/workspace-popup.ts`
2. `apps/tab-manager/src/entrypoints/background.ts`

Both will be updated to import from the new path. The only reason to keep `persistence/` is if external packages import from `@epicenter/workspace/extensions/persistence`. If that's not a concern, delete the directory and the package.json export.

**Recommendation:** Keep as re-export shims initially. Mark `@deprecated`. Remove in a future version.

## What Happens to `persistence` in `extensions/index.ts`

The barrel file (`extensions/index.ts`) currently exports persistence:

```typescript
export { type PersistenceConfig, persistence } from './persistence/desktop.js';
export { indexeddbPersistence as webPersistence } from './persistence/web.js';
```

Update to point to new locations:

```typescript
export {
	type PersistenceConfig,
	persistence,
} from './y-sweet-persist-sync/desktop.js';
export { indexeddbPersistence as webPersistence } from './y-sweet-persist-sync/web.js';
```

## Migration Guide

### `apps/tab-manager/src/lib/workspace-popup.ts`

```typescript
// Before
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence';
import { directAuth, ySweetSync } from '@epicenter/workspace/extensions/y-sweet-sync';

export const popupWorkspace = createWorkspace(definition).withExtension(
	'sync',
	ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
);
```

This is a different pattern: standalone persistence, no Y-Sweet. It does NOT use `ySweetSync` or `indexeddbPersistence`. Leave it as-is. The `workspacePersistence` function is app-specific and imports `ExtensionContext` from `@epicenter/workspace/dynamic`, not from `extensions/persistence`.

**TODO for future:** This app should eventually use `ySweetPersistSync` when Y-Sweet sync is added to the Epicenter desktop app.

## Out of Scope

1. **Chainable extension API**: covered by `20260213T102800-chainable-extension-api.md`. This rename works with either `.withExtensions(map)` or `.withExtension(key, factory)`.
2. **Epicenter Tauri app persistence**: uses custom `workspacePersistence`, no sync. Different pattern.
3. **The older `persistence` factory** in `desktop.ts` (the direct extension factory, not the `filesystemPersistence` curried factory): moves with the file but its API doesn't change.

## Implementation Plan

### Phase 1: Create new files

- [x] Create `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`: copy from `y-sweet-sync.ts`, rename function to `ySweetPersistSync`, rename config type to `YSweetPersistSyncConfig`, make `persistence` required, remove `hasPersistence` branch and `waitForFirstSync` helper
- [x] Create `packages/epicenter/src/extensions/y-sweet-persist-sync/web.ts`: move `indexeddbPersistence` from `persistence/web.ts`
- [x] Create `packages/epicenter/src/extensions/y-sweet-persist-sync/desktop.ts`: move `filesystemPersistence` and `persistence` from `persistence/desktop.ts`

### Phase 2: Delete old files (clean break: no shims)

> **Decision**: Took Option B (clean break) instead of Option A (re-export shims). The only consumers were the two tab-manager files, both updated in Phase 5. No external consumers exist.

- [x] Delete `packages/epicenter/src/extensions/y-sweet-sync.ts`
- [x] Delete `packages/epicenter/src/extensions/persistence/web.ts`
- [x] Delete `packages/epicenter/src/extensions/persistence/desktop.ts`
- [x] Delete `packages/epicenter/src/extensions/persistence/index.browser.ts`
- [x] Delete `packages/epicenter/src/extensions/persistence/index.node.ts`

### Phase 3: Update package.json exports

- [x] Add `"./extensions/y-sweet-persist-sync": "./src/extensions/y-sweet-persist-sync.ts"`
- [x] Add `"./extensions/y-sweet-persist-sync/web": "./src/extensions/y-sweet-persist-sync/web.ts"`
- [x] Add `"./extensions/y-sweet-persist-sync/desktop": "./src/extensions/y-sweet-persist-sync/desktop.ts"`
- [x] Remove old export paths (`./extensions/persistence`, `./extensions/y-sweet-sync`)

### Phase 4: Update barrel file

- [x] Update `packages/epicenter/src/extensions/index.ts`: point persistence exports to new locations

### Phase 5: Migrate call sites

- [x] `apps/tab-manager/src/lib/workspace-popup.ts`: update imports to new paths, rename `ySweetSync` to `ySweetPersistSync`
- [x] `apps/tab-manager/src/entrypoints/background.ts`: same

### Phase 6: Migrate tests

- [x] Rename `y-sweet-sync.test.ts` to `y-sweet-persist-sync.test.ts`
- [x] Update all `ySweetSync` references to `ySweetPersistSync`
- [x] Update import path
- [x] No "no persistence" test cases existed (all tests already provided persistence)

### Phase 7: Verify

- [x] Run `bun test`: 3/3 tests pass
- [x] Run `bun run typecheck`: 0 new errors (pre-existing errors unchanged)
- [x] Grep for remaining `ySweetSync` references: zero found
- [x] Grep for remaining `extensions/persistence` imports in app code: zero found

## Files Changed

| File                                                                | Change                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`         | **NEW**: renamed + simplified `ySweetSync` → `ySweetPersistSync` |
| `packages/epicenter/src/extensions/y-sweet-persist-sync/web.ts`     | **MOVED** from `persistence/web.ts`                               |
| `packages/epicenter/src/extensions/y-sweet-persist-sync/desktop.ts` | **MOVED** from `persistence/desktop.ts`                           |
| `packages/epicenter/src/extensions/y-sweet-persist-sync.test.ts`    | **RENAMED** from `y-sweet-sync.test.ts`, updated references       |
| `packages/epicenter/src/extensions/y-sweet-sync.ts`                 | **DELETED** (clean break, no shim)                                |
| `packages/epicenter/src/extensions/persistence/`                    | **DELETED** (entire directory: clean break, no shims)            |
| `packages/epicenter/src/extensions/index.ts`                        | Updated persistence export paths                                  |
| `packages/epicenter/package.json`                                   | Add new export paths, remove old ones                             |
| `apps/tab-manager/src/lib/workspace-popup.ts`                       | Update imports + rename                                           |
| `apps/tab-manager/src/entrypoints/background.ts`                    | Update imports + rename                                           |
