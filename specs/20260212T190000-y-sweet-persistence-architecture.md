# Y-Sweet Persistence Architecture

**Status**: Implemented
**Implementation notes**: All 5 steps completed. `indexeddb.ts` deleted from y-sweet package. `ySweetSync` extension rewritten with `auth` callback API, `persistence` factory option, `directAuth` helper, and `connect: false` orchestration. Factory functions (`indexeddbPersistence`, `filesystemPersistence`) exported from persistence modules. See `packages/epicenter/src/extensions/y-sweet-sync.ts`.

Specification for how persistence and sync compose in the Y-Sweet extension.

## Decision

**Remove persistence from the Y-Sweet provider. Compose persistence into the `ySweetSync` extension using `connect: false` to enforce correct load ordering.**

The provider becomes a pure WebSocket sync machine. The extension orchestrates the lifecycle: load persisted state first, then connect with an accurate state vector.

## Why Load Order Matters

Yjs CRDTs don't care about order: merging is commutative. But load order matters for **efficiency**:

**IndexedDB loads first, then WebSocket connects:**

1. Doc starts empty
2. IndexedDB loads → doc has all persisted state (e.g. 500KB of workspace history)
3. WebSocket connects → sync step 1 sends state vector reflecting that 500KB
4. Server compares → sends only the delta since last session (e.g. 2KB)

**WebSocket connects first, IndexedDB loads later:**

1. Doc starts empty
2. WebSocket connects → sync step 1 sends empty state vector
3. Server sees empty state → sends everything (500KB)
4. IndexedDB loads later → Yjs deduplicates, but the full download already happened

Both are correct. But the first path downloads 2KB; the second downloads 500KB. For large workspaces on slow connections, this difference is significant.

## Current State (problems)

Three persistence implementations that don't coordinate:

### 1. Y-Sweet provider's built-in `IndexedDBProvider`: dead code with a race condition

`packages/y-sweet/src/indexeddb.ts`. Custom IndexedDB implementation with compaction, BroadcastChannel cross-tab, and write-conflict retry.

**Never activated**: no call site passes `offlineSupport: true`.

Even if it were activated, it's broken. The constructor fires off IndexedDB creation in an async IIFE without awaiting it, then immediately calls `connect()`:

```typescript
// provider.ts constructor: race condition
(async () => {
	this.indexedDBProvider = await createIndexedDBProvider(doc, docId);
})();
// ↑ Not awaited. this.indexedDBProvider is null during sync handshake.

doc.on('update', this.update.bind(this));

if (extraOptions.connect !== false) {
	this.connect(); // ← WebSocket connects before IndexedDB loads
}
```

The echo-loop filter (`origin === this.indexedDBProvider`) is also broken during this window since `indexedDBProvider` is null.

### 2. Epicenter's standalone persistence extensions

`packages/epicenter/src/extensions/persistence/`:

- **Web** (`web.ts`): Wraps `y-indexeddb`. Uses `ydoc.guid` as DB name. Works correctly.
- **Desktop** (`desktop.ts`): `Bun.file()` read + `writeFileSync` on every update. Works but no debouncing.

### 3. Tab-manager inline persistence

`apps/tab-manager/src/entrypoints/background.ts`: Inline `IndexeddbPersistence` with hardcoded name `'tab-manager'`. Same pattern as `web.ts` but inline.

## Architecture

### Provider: pure WebSocket sync

`packages/y-sweet/src/provider.ts`: no persistence knowledge.

Remove from the provider:

- `indexeddb.ts` (190 lines): delete entirely
- `offlineSupport` option from `YSweetProviderParams`
- `indexedDBProvider` field from `YSweetProvider`
- `origin === this.indexedDBProvider` check in `update()`
- `indexedDBProvider.destroy()` in `destroy()`
- `createIndexedDBProvider` import

Keep: `connect: false` option (already supported): the extension uses this to defer connection until persistence loads.

### Extension: `ySweetSync` with composable persistence

`packages/epicenter/src/extensions/y-sweet-sync.ts`: orchestrates lifecycle.

The extension mirrors the provider's API. Instead of a `mode` discriminant wrapping different config shapes, `auth` is a callback that takes a `docId` and returns a `ClientToken`. A `directAuth` helper handles the common local-dev case.

`persistence` is a function `(ydoc: Y.Doc) => Lifecycle`: any backend that can load state into a ydoc and clean up after itself. Factory functions (`indexeddbPersistence`, `filesystemPersistence`) handle common cases. Custom persistence is just a function.

```typescript
// Consumer API:

// Web: IndexedDB persistence + sync:
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/web';
import { directAuth, ySweetSync } from '@epicenter/workspace/extensions/y-sweet-sync';

createWorkspace(def).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://localhost:8080'),
		persistence: indexeddbPersistence(),
	}),
});

// Desktop: filesystem persistence + sync:
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/desktop';

createWorkspace(def).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://localhost:8080'),
		persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' }),
	}),
});

// Authenticated: hosted server:
createWorkspace(def).withExtensions({
	sync: ySweetSync({
		auth: (docId) => fetch(`/api/token/${docId}`).then((r) => r.json()),
		persistence: indexeddbPersistence({ dbName: 'my-app' }),
	}),
});

// Sync only (no local persistence):
createWorkspace(def).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://localhost:8080'),
	}),
});

// Custom persistence: bring your own:
createWorkspace(def).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://localhost:8080'),
		persistence: (ydoc) => {
			const opfs = new OPFSProvider(ydoc);
			return { whenSynced: opfs.ready, destroy: () => opfs.close() };
		},
	}),
});
```

Internal orchestration:

```typescript
return ({ ydoc }) => {
	const authEndpoint = () => config.auth(ydoc.guid);
	const hasPersistence = !!config.persistence;

	// 1. Create provider: defer connection if persistence needs to load first
	const provider = createYjsProvider(ydoc, ydoc.guid, authEndpoint, {
		connect: !hasPersistence,
	});

	let persistenceCleanup: (() => MaybePromise<void>) | undefined;

	const whenSynced = hasPersistence
		? (async () => {
				const p = config.persistence!(ydoc);
				persistenceCleanup = p.destroy;
				await p.whenSynced; // 2. Load persisted state
				provider.connect(); // 3. Connect with accurate state vector
				await waitForConnected(provider); // 4. Wait for handshake
			})()
		: waitForConnected(provider);

	return defineExports({
		provider,
		whenSynced,
		destroy: () => {
			persistenceCleanup?.();
			provider.destroy();
		},
	});
};
```

When `persistence` is not provided, the extension creates the provider with `connect: true` (current behavior: immediate connection, no change).

### Persistence as `(ydoc: Y.Doc) => Lifecycle`

Persistence is a function, not a discriminated union. The return type is `Lifecycle`: the same protocol extensions already use:

```typescript
type Lifecycle = {
	whenSynced: Promise<unknown>; // resolves when initial load is complete
	destroy: () => MaybePromise<void>; // cleanup observers, close connections
};
```

Factory functions for common backends:

**IndexedDB** (`indexeddbPersistence`): Wraps `y-indexeddb`. Handles loading, auto-saving, and compaction internally.

```typescript
export function indexeddbPersistence(options?: { dbName?: string }) {
	return (ydoc: Y.Doc): Lifecycle => {
		const idb = new IndexeddbPersistence(options?.dbName ?? ydoc.guid, ydoc);
		return {
			whenSynced: idb.whenSynced.then(() => {}),
			destroy: () => idb.destroy(),
		};
	};
}
```

**Filesystem** (`filesystemPersistence`): Uses `Bun.file()` for read, debounced writes. Encodes full state via `Y.encodeStateAsUpdate()`.

```typescript
export function filesystemPersistence(options: { filePath: string }) {
	return (ydoc: Y.Doc): Lifecycle => {
		// load, observe with debounced writes, return { whenSynced, destroy }
	};
}
```

Custom persistence is just a function, no adapter interface needed. If it returns `Lifecycle`, it works.

### Auth as `(docId: string) => Promise<ClientToken>`

Instead of a `mode` discriminant, auth is a single callback. The extension calls `config.auth(ydoc.guid)` and wraps it for the provider.

`directAuth` is a helper for local dev. It constructs the WebSocket URL from a server URL:

```typescript
export function directAuth(serverUrl: string) {
	return (docId: string): Promise<ClientToken> => {
		const url = new URL(serverUrl);
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return Promise.resolve({
			url: `${wsProtocol}//${url.host}/d/${docId}/ws`,
		});
	};
}
```

For authenticated mode, pass a function that fetches a token:

```typescript
auth: (docId) => fetch(`/api/token/${docId}`).then((r) => r.json());
```

### Standalone persistence extensions (kept)

`packages/epicenter/src/extensions/persistence/web.ts` and `desktop.ts` remain as standalone extensions for persistence-only use cases (no sync):

- Local development without a Y-Sweet server
- Tests
- Offline-only applications

They also export factory functions (`indexeddbPersistence`, `filesystemPersistence`) for use with `ySweetSync`.

## Resolved Questions

### Echo-loop filtering

**Not needed.** The provider currently skips relaying updates where `origin === this.indexedDBProvider`. Without this, persistence-originated updates relay over WebSocket. But:

- If the socket isn't open yet → `send()` silently drops them (checks `readyState === OPEN`)
- If the socket is open → the server already has the state from sync step 1/2 → Yjs deduplicates
- The sync protocol uses state vectors: the server knows what it has

Cost: one redundant message (the persisted state) per page load, only if sync beats persistence. For the combined extension this doesn't happen because persistence loads first (`connect: false`).

If profiling later shows this matters, add a `skipOrigins` option to the provider: one line in `update()`. Don't build it preemptively.

### Compaction

**Owned by the persistence backend, not a shared utility.** Each storage backend has different performance characteristics:

- **IndexedDB**: `y-indexeddb` handles compaction internally
- **Filesystem**: Full state encode on write (effectively compacted every save)
- **OPFS** (future): Single binary blob, overwrite in place

The Yjs API (`Y.mergeUpdates()`, `Y.encodeStateAsUpdate()`) provides the primitives. Each backend calls what's appropriate for its strategy.

### Cross-tab coordination

**Not a persistence concern.** When sync is active, all tabs connect to the same Y-Sweet server: updates propagate naturally. BroadcastChannel adds nothing.

For offline cross-tab (no server), `y-webrtc` with BroadcastChannel transport is the Yjs-ecosystem solution. Don't put cross-tab logic in the persistence layer.

### Extension ordering

**Solved by composing persistence into the sync extension.** No framework-level dependency system needed. The `ySweetSync` extension internally uses `connect: false`, loads persistence, then calls `provider.connect()`. The ordering is explicit in the code, not implicit in extension registration order.

### Desktop persistence performance

`desktop.ts` currently calls `Y.encodeStateAsUpdate(ydoc)` + `writeFileSync` on every update: full state encode + synchronous disk write per keystroke. For large docs this will become a problem.

**Fix:** Debounce saves in the filesystem backend (e.g. 500ms). The combined extension's filesystem variant should include this.

## Implementation Plan

### Step 1: Strip persistence from the Y-Sweet provider

Remove `indexeddb.ts`, `offlineSupport`, `indexedDBProvider` field, echo-loop filtering, and related imports/cleanup from `packages/y-sweet/`. ~200 lines deleted, zero new code.

### Step 2: Rewrite `ySweetSync` extension with new API

- Replace `mode` discriminant with `auth: (docId: string) => Promise<ClientToken>` callback
- Add `persistence?: (ydoc: Y.Doc) => Lifecycle` option
- Add `directAuth(serverUrl)` helper
- Implement `connect: false` → load → connect orchestration
- Add `waitForConnected` helper

### Step 3: Export persistence factory functions

- `web.ts`: Export `indexeddbPersistence(options?)` factory alongside existing standalone extension
- `desktop.ts`: Export `filesystemPersistence(options)` factory alongside existing standalone extension

### Step 4: Migrate consumers

- **Tab-manager** (`apps/tab-manager/`): Replace inline `IndexeddbPersistence` + separate `ySweetSync` with combined `ySweetSync({ auth: directAuth(...), persistence: indexeddbPersistence({ dbName: 'tab-manager' }) })`.
- **Other consumers**: Update to use new `auth` callback API on `ySweetSync`.

### Step 5: Keep standalone persistence extensions

`web.ts` and `desktop.ts` standalone extensions stay for persistence-only use cases. No changes needed beyond adding the factory function exports.
