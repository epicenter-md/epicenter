# ySweetSync Reconnect + Provider Listener Leak Fix

**Date**: 2026-02-13
**Status**: Implemented
**Implementation notes**: Both phases completed. Phase 1 (listener leak fix): `boundUpdate` and `boundAwarenessUpdate` stored in provider constructor, properly removed in `destroy()` via `doc.off()` and `awareness.off()`. Phase 2 (reconnect): `reconnect(newAuth)` method added to `ySweetSync` extension exports with provider getter for stale-reference safety. Tests in `y-sweet-sync.test.ts` cover reconnect, provider getter, and destroy-after-reconnect.
**References**: `specs/20260213T000000-fix-disconnect-reconnect-race.md`, `specs/20260212T190000-y-sweet-persistence-architecture.md`

## Overview

Add a `reconnect(newAuth)` method to the `ySweetSync` extension that swaps the sync rail (WebSocket target) without reinitializing persistence. Separately, fix a listener leak in `YSweetProvider.destroy()` where `doc.on('update')` and `awareness.on('update')` handlers are never removed.

## Motivation

### Current State

`ySweetSync` composes two independent concerns into one lifecycle:

```typescript
// packages/epicenter/src/extensions/y-sweet-sync.ts
export function ySweetSync(config: YSweetSyncConfig): ExtensionFactory {
	return ({ ydoc }) => {
		const provider = createYjsProvider(ydoc, ydoc.guid, authEndpoint, {
			connect: !hasPersistence,
		});
		let persistenceCleanup;

		const whenSynced = hasPersistence
			? (async () => {
					const p = config.persistence!({ ydoc });
					persistenceCleanup = p.destroy;
					await p.whenSynced;
					provider.connect();
				})()
			: waitForFirstSync(provider);

		return defineExports({
			provider,
			whenSynced,
			destroy: () => {
				persistenceCleanup?.(); // tears down persistence
				provider.destroy(); // tears down sync
			},
		});
	};
}
```

And `.withExtension()` runs factories once at construction with no re-registration path:

```typescript
// packages/epicenter/src/dynamic/workspace/create-workspace.ts (line 122)
// Each .withExtension() call creates a new client with the extension added
// The extension is written once, never reassigned
```

This creates two problems:

1. **No way to change sync target at runtime.** Switching from local y-sweet server to cloud (or vice versa) requires destroying the entire workspace client, which tears down persistence, SQLite extensions, and everything else. Wasteful when only the WebSocket target changed.

2. **Listener leak in YSweetProvider.** The constructor binds two listeners that `destroy()` never removes:

```typescript
// packages/y-sweet/src/provider.ts
constructor(private authEndpoint, _docId, private doc, extraOptions) {
  this.awareness = new awarenessProtocol.Awareness(doc);
  this.awareness.on('update', this.handleAwarenessUpdate.bind(this));  // ← never removed
  // ...
  doc.on('update', this.update.bind(this));  // ← never removed
}

public destroy() {
  this.disconnect();
  awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
  // removes window event listeners
  // MISSING: doc.off('update', ...)
  // MISSING: awareness.off('update', ...)
}
```

If the provider is destroyed but the Y.Doc lives on (which is exactly what `reconnect` does), the old provider's `update` handler stays bound to the doc. Each reconnect cycle accumulates another stale listener.

### Desired State

```typescript
const workspace = createWorkspace(definition).withExtension(
	'sync',
	ySweetSync({
		auth: directAuth('http://localhost:8080'),
		persistence: indexeddbPersistence,
	}),
);

await workspace.whenSynced;

// Later: switch to cloud server. Persistence stays, only sync rail changes.
workspace.extensions.sync.reconnect(directAuth('https://cloud.example.com'));
```

```
┌──────────────────────────────────────────────────────────────────┐
│                         ySweetSync extension                      │
│                                                                   │
│   ┌─────────────────────┐      ┌──────────────────────────────┐  │
│   │    Persistence       │      │      Sync (YSweetProvider)   │  │
│   │  (IndexedDB / FS)    │      │                              │  │
│   │                      │      │  reconnect(newAuth) ────────►│──┼── destroys old provider
│   │  ● Untouched during  │      │                              │  │   creates new provider
│   │    reconnect          │      │  ● New WebSocket target     │  │   on same Y.Doc
│   │  ● Loads once at init │      │  ● Same Y.Doc               │  │
│   └──────────┬───────────┘      └──────────────┬───────────────┘  │
│              │                                  │                  │
│              └──────────── Y.Doc ───────────────┘                  │
│                      (stays in memory)                             │
└──────────────────────────────────────────────────────────────────┘
```

## Design Decisions

| Decision                                | Choice                                                                  | Rationale                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where to put `reconnect`                | On the `ySweetSync` extension exports                                   | The extension owns the provider lifecycle. Adding it here means consumers just call `workspace.extensions.sync.reconnect(...)`. No framework changes needed.                                                             |
| Reconnect destroys + recreates provider | Destroy old `YSweetProvider`, create new one on same `Y.Doc`            | Simpler than mutating internals of the provider. `destroy()` is safe: it only closes the WebSocket and removes awareness. Does not touch Y.Doc. Avoids the complexity rejected in the supervisor-loop spec.             |
| Fix listener leak separately            | Patch `YSweetProvider.destroy()` first, then add `reconnect`            | The leak fix is prerequisite: without it, each `reconnect` call accumulates stale listeners. Fixing it first makes `reconnect` clean by default.                                                                        |
| Store bound references for cleanup      | Save `this.update.bind(this)` to a field so it can be passed to `off()` | `.bind()` creates a new function reference each time. Must store the bound reference at construction to pass the same reference to both `on()` and `off()`.                                                              |
| Deferred: supervisor loop redesign      | Deferred                                                                | The prior spec (`20260213T000000-fix-disconnect-reconnect-race.md`) analyzed a full supervisor-loop rewrite. That's architecturally better but much larger. `reconnect()` at the extension level is good enough for now. |

## Architecture

### Reconnect Flow

```
reconnect(newAuth) called
         │
         ▼
┌────────────────────────────┐
│  1. provider.destroy()      │──► closes WebSocket
│     (old provider)          │──► removes doc.on('update') listener  [FIXED]
│                             │──► removes awareness.on('update') listener  [FIXED]
│                             │──► removes window online/offline listeners
│                             │──► clears awareness states
└────────────────────────────┘
         │
         ▼
┌────────────────────────────┐
│  2. Update auth callback    │──► currentAuth = newAuth
└────────────────────────────┘
         │
         ▼
┌────────────────────────────┐
│  3. createYjsProvider(      │──► new WebSocket to new URL
│       ydoc,      ← same    │──► Yjs sync handshake
│       ydoc.guid, ← same    │──► server sends only delta
│       newAuth               │    (doc already has state)
│     )                       │
└────────────────────────────┘
         │
         ▼
┌────────────────────────────┐
│  4. provider.connect()      │──► WebSocket opens
│                             │──► sync step 1 with full state vector
│                             │──► minimal data transfer
└────────────────────────────┘

Throughout: persistence (IndexedDB/filesystem) is UNTOUCHED.
           Y.Doc stays in memory with all data intact.
```

### Why This Is Safe

Yjs providers are just observers. They:

- Subscribe to `doc.on('update', ...)` to send local changes over the wire
- Apply incoming changes via `syncProtocol.readSyncMessage(decoder, encoder, doc, origin)`
- Don't own or manage Y.Doc state

`YSweetProvider.destroy()` (after the leak fix):

- Calls `disconnect()` → closes WebSocket, bumps `connectGeneration`
- Removes awareness states for this client
- Removes `doc.on('update')` and `awareness.on('update')` listeners
- Removes window `online`/`offline` listeners
- Does **NOT** call `doc.destroy()`: the doc is untouched

Creating a new provider on the same doc:

- Binds fresh `doc.on('update')` listener
- Creates new `Awareness` instance
- Opens WebSocket to new URL
- Yjs sync handshake sends full state vector → server sends only delta

## Implementation Plan

### Phase 1: Fix listener leak in YSweetProvider.destroy()

- [ ] **1.1** In `YSweetProvider` constructor, store the bound handler references:

  ```typescript
  private boundUpdate: (update: Uint8Array, origin: unknown) => void;
  private boundAwarenessUpdate: (...) => void;

  constructor(...) {
    this.boundUpdate = this.update.bind(this);
    this.boundAwarenessUpdate = this.handleAwarenessUpdate.bind(this);
    this.awareness.on('update', this.boundAwarenessUpdate);
    doc.on('update', this.boundUpdate);
  }
  ```

- [ ] **1.2** In `destroy()`, remove both listeners:
  ```typescript
  public destroy() {
    this.disconnect();
    this.doc.off('update', this.boundUpdate);
    this.awareness.off('update', this.boundAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(...);
    // ... window listener removal
  }
  ```
- [ ] **1.3** Verify existing tests pass. Run `bun test` in `packages/y-sweet/`.

### Phase 2: Add reconnect method to ySweetSync

- [ ] **2.1** Refactor `ySweetSync` to use a mutable `provider` variable and `currentAuth` callback:

  ```typescript
  export function ySweetSync(config: YSweetSyncConfig): ExtensionFactory {
	return ({ ydoc }) => {
		let currentAuth = config.auth;
		const authEndpoint = () => currentAuth(ydoc.guid);
		const hasPersistence = !!config.persistence;

		let provider: YSweetProvider = createYjsProvider(
			ydoc,
			ydoc.guid,
			authEndpoint,
			{ connect: !hasPersistence },
		);

		let persistenceCleanup: (() => MaybePromise<void>) | undefined;

		// whenSynced logic unchanged from current implementation
		const whenSynced = hasPersistence
			? (async () => {
					const p = config.persistence!({ ydoc });
					persistenceCleanup = p.destroy;
					await p.whenSynced;
					provider.connect().catch(() => {});
				})()
			: waitForFirstSync(provider);

		return defineExports({
			provider, // Note: this reference becomes stale after reconnect.
			// See Open Questions.
			whenSynced,
			reconnect(newAuth: (docId: string) => Promise<ClientToken>) {
				provider.destroy();
				currentAuth = newAuth;
				provider = createYjsProvider(ydoc, ydoc.guid, () =>
					currentAuth(ydoc.guid),
				);
				provider.connect();
			},
			destroy: () => {
				persistenceCleanup?.();
				provider.destroy();
			},
		});
	};
  }
  ```

- [ ] **2.2** Update the `YSweetSyncConfig` type JSDoc to document the `reconnect` export.
- [ ] **2.3** Write a test for `reconnect`: verify the old provider is destroyed, new provider connects to a different URL, persistence is untouched, Y.Doc retains all data.
- [ ] **2.4** Run `bun test` in `packages/epicenter/` to verify no regressions.

## Edge Cases

### Reconnect called before initial sync completes

1. `whenSynced` is still pending (persistence loading or waiting for first WebSocket sync)
2. `reconnect(newAuth)` is called
3. Old provider is destroyed → if `whenSynced` was waiting on `waitForFirstSync`, it rejects (provider goes OFFLINE before CONNECTED)
4. New provider connects to new URL
5. The original `whenSynced` promise has already resolved or rejected: it's a one-shot promise from initialization. `reconnect` doesn't reset it.

**Acceptable behavior.** Consumers who already awaited `whenSynced` are fine. If `whenSynced` was still pending and persistence was provided, it already resolved (persistence resolves first). If no persistence, it may reject: consumer should handle this.

### Reconnect called multiple times rapidly

1. Each call destroys the current provider and creates a new one
2. The listener leak fix ensures no accumulation
3. Last writer wins: the final `reconnect` call determines the active connection

**Acceptable behavior.** No special debouncing needed. Provider creation is synchronous; connection is async but managed by the provider's internal connect loop.

### Provider reference on extension exports becomes stale

After `reconnect`, `workspace.extensions.sync.provider` still points to the original provider object (it was captured by value in `defineExports`). The internal `provider` variable has been reassigned, but the exported reference is stale.

See Open Questions.

## Open Questions

1. **Should `reconnect` return the new provider or a promise?**
   - Options: (a) Return `void`: fire and forget, (b) Return `Promise<void>` that resolves on first sync of new provider, (c) Return the new `YSweetProvider` instance
   - **Recommendation**: Return `void`. Consumers who need connection status should subscribe to provider events. Keeping it simple.

2. **How to handle the stale `provider` reference on extension exports?**
   - The `provider` property exported via `defineExports` is captured at creation time. After `reconnect`, it points to the destroyed old provider.
   - Options: (a) Accept staleness: consumers use `reconnect` and don't hold onto `provider`, (b) Use a getter that returns the current provider, (c) Export a `getProvider()` method
   - **Recommendation**: Use a getter. The `defineExports` return object can use `get provider() { return provider; }` to always return the current one. This is transparent to consumers.

3. **Should `reconnect` accept partial config (e.g., just a new URL)?**
   - Options: (a) Accept only `newAuth` callback (full flexibility), (b) Accept `string` URL for convenience (wraps in `directAuth`), (c) Accept `{ auth } | string` union
   - **Recommendation**: Accept only `(docId: string) => Promise<ClientToken>` (the auth callback). Consumers can use `directAuth(url)` for the common case. Keeps the API orthogonal.

## Success Criteria

- [ ] `YSweetProvider.destroy()` removes `doc.on('update')` and `awareness.on('update')` listeners
- [ ] `ySweetSync` exports a `reconnect(newAuth)` method
- [ ] Calling `reconnect` destroys the old provider and creates a new one on the same Y.Doc
- [ ] Persistence (IndexedDB/filesystem) is NOT reinitialized during reconnect
- [ ] Y.Doc retains all data through a reconnect cycle
- [ ] No listener accumulation after multiple reconnect calls
- [ ] `workspace.extensions.sync.provider` returns the current (not stale) provider after reconnect
- [ ] All existing tests pass (`bun test` in both `packages/y-sweet/` and `packages/epicenter/`)

## References

- `packages/y-sweet/src/provider.ts`: YSweetProvider class (listener leak fix)
- `packages/y-sweet/src/main.ts`: createYjsProvider factory
- `packages/epicenter/src/extensions/y-sweet-sync.ts`: ySweetSync extension (reconnect method)
- `packages/epicenter/src/shared/lifecycle.ts`: Lifecycle protocol / defineExports
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: withExtensions (context for why runtime swap isn't possible at framework level)
- `specs/20260213T000000-fix-disconnect-reconnect-race.md`: Prior analysis identifying listener leak (Part 5, item 2)
- `specs/20260212T190000-y-sweet-persistence-architecture.md`: Persistence/sync composition architecture
