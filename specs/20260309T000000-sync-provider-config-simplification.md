# Sync Provider Config Simplification

> Remove `connect` param, rename `baseUrl` → `url`, separate test-only DI from config, clarify awareness ownership.

## Problem

`createSyncProvider` has config design issues:

1. **`connect` collides with the method name**: requires renaming to `shouldConnect` internally. A boolean defaulting to `true` that controls "do I start doing things on construction" is a footgun. The only consumer that uses `connect: false` immediately calls `.connect()` after an async gate: it would read better as two explicit lines.

2. **`baseUrl` lies**: the URL is only used as a WebSocket URL. The JSDoc mentions "HTTP snapshot prefetch" but no such feature exists. The provider silently swaps `http:` → `ws:` and `https:` → `wss:`, which is surprising behavior.

3. **`WebSocketConstructor` is DI pollution**: a testing/environment escape hatch mixed into the main config object. Every production call site ignores it; every test call site sets it.

4. **Awareness ownership is ambiguous**: if you pass one in, `destroy()` still calls `removeAwarenessStates` on it. The provider doesn't distinguish "I created this" from "caller owns this."

## Design

### New Config Type

```typescript
type SyncProviderConfig = {
  /** The Y.Doc to sync. */
  doc: Y.Doc;

  /** WebSocket URL for the sync room (ws: or wss:). */
  url: string;

  /** Dynamic token fetcher. Called fresh on each connection attempt. */
  getToken?: () => Promise<string>;

  /** External awareness instance. If provided, destroy() will NOT remove its states. */
  awareness?: Awareness;

  /** WebSocket constructor override for testing or non-browser environments. */
  WebSocket?: WebSocketConstructor;
};
```

### Changes

| Before | After | Why |
|---|---|---|
| `baseUrl: string` | `url: string` | It's a WebSocket URL. No HTTP usage exists. |
| `connect?: boolean` (default `true`) | Removed | Provider always starts disconnected. Call `.connect()` explicitly. |
| `WebSocketConstructor?: ...` | `WebSocket?: ...` | Shorter, mirrors the global it replaces. |
| `awareness` passed in → `destroy()` clears its states | `awareness` passed in → `destroy()` skips `removeAwarenessStates` | Caller owns what caller passes. |

### URL handling

The provider no longer does protocol swapping. Callers pass `ws:` or `wss:` URLs directly.

The sync extension (`packages/epicenter/src/extensions/sync.ts`) currently passes HTTP URLs via `config.url(workspaceId)`. This call site will do the conversion:

```typescript
// sync.ts: before
const resolvedBaseUrl = config.url(workspaceId);

// sync.ts: after
const httpUrl = config.url(workspaceId);
const wsUrl = httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
```

This keeps the extension's public config as HTTP URLs (which makes sense. The extension config is a higher-level concept that may also use HTTP endpoints in the future), while the provider takes exactly what it uses.

### Awareness ownership

Track whether the provider created the awareness or received it:

```typescript
const ownsAwareness = !config.awareness;
const awareness = config.awareness ?? new Awareness(doc);
```

In `destroy()`:
```typescript
destroy() {
  this.disconnect();
  doc.off('updateV2', handleDocUpdate);
  awareness.off('update', handleAwarenessUpdate);
  if (ownsAwareness) {
    removeAwarenessStates(awareness, [doc.clientID], 'window unload');
  }
  statusListeners.clear();
}
```

### No auto-connect

The provider always starts disconnected. The `if (shouldConnect)` block and initial `desired = 'online'` are removed. The factory function body ends at `return { ... }`.

Callers that want immediate connection:
```typescript
const provider = createSyncProvider({ doc, url });
provider.connect();
```

The sync extension already does this pattern for the `connect: false` case. The `reconnect()` path becomes:
```typescript
reconnect() {
  provider.destroy();
  provider = createSyncProvider({ doc: ydoc, url: wsUrl, getToken, awareness: awareness.raw });
  provider.connect();
}
```

## Implementation Plan

### Wave 1: Config and types
**Files:** `packages/sync-client/src/types.ts`

- [x] **1.1** Rename `baseUrl` → `url` in `SyncProviderConfig`
- [x] **1.2** ~~Rename `WebSocketConstructor` → `WebSocket`~~: N/A, already removed in a14008659
- [x] **1.3** Remove `connect` from `SyncProviderConfig`
- [x] **1.4** Update `SyncProviderConfig` JSDoc: remove HTTP snapshot references, document awareness ownership

### Wave 2: Provider implementation
**Files:** `packages/sync-client/src/provider.ts`

- [x] **2.1** Update destructuring: `baseUrl` → `url`, remove `connect: shouldConnect`
  > WebSocketConstructor already removed in a14008659
- [x] **2.2** Track `ownsAwareness` flag based on whether `awareness` was passed in
- [x] **2.3** Remove auto-connect block (`if (shouldConnect) { ... }`)
- [x] **2.4** Replace `baseUrl` usage in `attemptConnection` with `url` (remove protocol swap)
- [x] **2.5** Update `destroy()` to only `removeAwarenessStates` when `ownsAwareness`
- [x] **2.6** Update JSDoc examples to show explicit `.connect()` and `ws:`/`wss:` URLs

### Wave 3: Consumer updates
**Files:** `packages/epicenter/src/extensions/sync.ts`

- [x] **3.1** Convert HTTP URL → WS URL in the extension before passing to provider
- [x] **3.2** Remove `connect: false` / `connect: true` from both call sites
- [x] **3.3** Add explicit `provider.connect()` calls after construction
- [x] **3.4** Rename `baseUrl` → `url` in both call sites

### Wave 4: Test updates
**Files:** `packages/sync-client/src/provider.test.ts`, `packages/server-local/src/sync/ws-plugin.test.ts`

- [x] **4.1** Update unit tests: `baseUrl` → `url`, remove `connect` param, add explicit `.connect()` where needed
  > WebSocketConstructor already removed in a14008659
- [x] **4.2** Update integration tests: pass `ws:`/`wss:` URLs instead of `http:` URLs
- [x] **4.3** Update any tests that assert auto-connect behavior to assert starts-disconnected
