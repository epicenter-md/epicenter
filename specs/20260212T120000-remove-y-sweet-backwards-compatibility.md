# Remove Y-Sweet Backwards Compatibility

Remove legacy backwards-compatibility code from `@epicenter/y-sweet` that exists solely to support older Y-Sweet server versions and y-websocket API consumers. This simplifies the provider, reduces surface area, and removes dead code.

## Context

`@epicenter/y-sweet` is a fork of `@y-sweet/client` v0.9.1. The original client maintained backwards compatibility with:

1. **Older Y-Sweet Rust servers** that didn't support `MESSAGE_SYNC_STATUS` (type 102)
2. **y-websocket API consumers** expecting events like `sync`, `synced`, and `status`
3. **Jamsocket's hosted debugger** at `debugger.y-sweet.dev` (service is shutting down)

Since we control both the client and server, and always deploy the latest Rust Y-Sweet server, this compatibility code is unnecessary.

### Protocol confirmation (via DeepWiki / jamsocket/y-sweet)

The latest Y-Sweet Rust server:
- **Supports `MESSAGE_SYNC_STATUS` (type 102)**: Handled in `DocConnection::handle_msg` which matches on `Message::Custom(SYNC_STATUS_MESSAGE, data)` and echoes the payload back
- **Has its own keepalive**: Server sends `Ping` every 20s and closes connections if no `Pong` within 40s
- **Handles unrecognized message types**: Returns `Error::Unsupported` (logged, not fatal)
- **Enforces authorization**: `ReadOnly` blocks `SyncStep2` and `Update` messages server-side

The heartbeat/version tracking protocol (`MESSAGE_SYNC_STATUS`) is fully supported. The `receivedAtLeastOneSyncResponse` guard is unnecessary with the current server.

## Scope

### What to remove

#### 1. Old server heartbeat guard (`provider.ts`)

**Files:** `provider.ts`

Remove the `receivedAtLeastOneSyncResponse` field and the early return in `setConnectionTimeout()` that skips timeout enforcement for old servers.

**Remove field** at `provider.ts:171-180`:
```typescript
// DELETE this entire block
/**
 * Older versions of the Y-Sweet server did not support the sync message...
 */
private receivedAtLeastOneSyncResponse: boolean = false;
```

**Remove early return** at `provider.ts:280-284`:
```typescript
// DELETE this guard
if (!this.receivedAtLeastOneSyncResponse) {
    return;
}
```

**Remove reset** at `provider.ts:587`:
```typescript
// DELETE this line
this.receivedAtLeastOneSyncResponse = false;
```

**Remove set** at `provider.ts:326`:
```typescript
// DELETE this line
this.receivedAtLeastOneSyncResponse = true;
```

**Effect:** `setConnectionTimeout()` will always set the timeout after sending `MESSAGE_SYNC_STATUS`. This is correct behavior because the latest server always echoes the payload back.

#### 2. y-websocket compatibility layer (`ws-status.ts`)

**Files:** `ws-status.ts` (delete entire file), `provider.ts`, `main.ts`

Delete `ws-status.ts` entirely. This file:
- Translates YSweet statuses to y-websocket statuses (`connected`/`connecting`/`disconnected`)
- Emits `EVENT_STATUS`, `EVENT_SYNC`, `EVENT_SYNCED` events for y-websocket consumers
- Defines `EVENT_CONNECTION_CLOSE` and `EVENT_CONNECTION_ERROR`

**In `provider.ts`**, remove:
- Import of `EVENT_CONNECTION_CLOSE`, `EVENT_CONNECTION_ERROR`, `WebSocketCompatLayer`, `YWebsocketEvent` from `./ws-status` (line 10-15)
- Instantiation: `new WebSocketCompatLayer(this)` (line 204)
- `YWebsocketEvent` from the `listeners` map type (line 152), `emit()` signature (line 645), `_on()` signature (line 696), `on()` signature (line 715), `once()` signature (line 722), `off()` signature (line 729)
- `this.emit(EVENT_CONNECTION_CLOSE, event)` in `websocketClose()` (line 619)
- `this.emit(EVENT_CONNECTION_ERROR, event)` in `websocketError()` (line 636)

After removal, the event listener types simplify from `YSweetEvent | YWebsocketEvent` to just `YSweetEvent` everywhere.

#### 3. Deprecated provider properties (`provider.ts`)

**Files:** `provider.ts`

Remove these four getters at `provider.ts:751-787`:
- `shouldConnect`: consumers should use `provider.status !== 'offline'`
- `wsconnected`: consumers should use `provider.status === 'connected' || provider.status === 'handshaking'`
- `wsconnecting`: consumers should use `provider.status === 'connecting'`
- `synced`: consumers should use `provider.status === 'connected'`

**No production code uses these.** Only spec files reference them in documentation examples (not executable code).

#### 4. Debugger URL and encoding utilities

**Files:** `provider.ts`, `encoding.ts` (delete entire file), `main.ts`

Remove the deprecated `debugUrl` getter at `provider.ts:182-188`.

Remove the `showDebuggerLink` field, option, and console logging:
- Field at `provider.ts:165`: `private showDebuggerLink = true`
- Option at `provider.ts:97`: `showDebuggerLink?: boolean` in `YSweetProviderParams`
- Assignment at `provider.ts:201`: `this.showDebuggerLink = extraOptions.showDebuggerLink !== false`
- Usage at `provider.ts:425`: `const lastDebugUrl = this.debugUrl`
- Console logging block at `provider.ts:472-481`

Delete `encoding.ts` entirely. The `encodeClientToken` and `decodeClientToken` functions are only used by `debugUrl`. No production code outside the package imports them.

Remove exports from `main.ts`:
- `export { decodeClientToken, encodeClientToken } from './encoding'` (line 27)

#### 5. Unnecessary constructor options (`provider.ts`)

**Files:** `provider.ts`

Remove these options from `YSweetProviderParams` and their corresponding constructor logic:

**`awareness?: awarenessProtocol.Awareness`** (line 81):
- Never passed by any call site: both consumers use the default `new Awareness(doc)`
- Creates ownership ambiguity: provider calls `removeAwarenessStates` in `destroy()` and `websocketClose()`, which could blow away shared state if the Awareness instance is externally owned
- Consumers can configure awareness post-construction via the public `provider.awareness` property
- Remove the option and always create `new awarenessProtocol.Awareness(doc)` internally

**`warnOnClose?: boolean`** (line 100):
- Never passed by any call site
- Leaky abstraction: tab-close warning is a UI concern, not a sync provider concern
- The provider already exposes `hasLocalChanges`, so the consuming app can handle `beforeunload` itself
- Remove the option, the `handleBeforeUnload` method, and the `window.addEventListener('beforeunload', ...)` logic

### What to keep

- `createYjsProvider` factory: used by 2 production files
- `YSweetProvider` class: core provider
- `EVENT_CONNECTION_STATUS` and `EVENT_LOCAL_CHANGES`: the modern event API
- All status constants (`STATUS_OFFLINE`, `STATUS_CONNECTING`, etc.)
- `ClientToken`, `Authorization`, `AuthDocRequest` types
- `YSweetProviderParams` type (minus `showDebuggerLink`, `awareness`, `warnOnClose`)
- `connect`, `initialClientToken`, `offlineSupport`, `WebSocketPolyfill` options: all serve real purposes
- `indexeddb.ts`: offline persistence
- `sleeper.ts`: reconnection utility
- All reconnection, heartbeat, and sync protocol logic (minus the old-server guard)

## Consumer migration

Two production files used the deprecated `'sync'` event. **Both have been migrated** to use `'connection-status'` directly.

- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`: now uses `provider.on('connection-status', ...)` with proper unsubscribe
- `packages/epicenter/src/extensions/y-sweet-sync.ts`: now uses `provider.on('connection-status', ...)` with proper unsubscribe (also fixes a subtle bug where the original `provider.on('sync', () => resolve())` never unsubscribed)

## Tasks

- [x] Update `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`: replace `'sync'` event with `'connection-status'` event
- [x] Update `packages/epicenter/src/extensions/y-sweet-sync.ts`: replace `'sync'` event with `'connection-status'` event
- [x] Remove `receivedAtLeastOneSyncResponse` field and all 4 references in `provider.ts`
- [x] Delete `packages/y-sweet/src/ws-status.ts`
- [x] Remove all ws-status imports, `WebSocketCompatLayer` instantiation, `EVENT_CONNECTION_CLOSE`/`EVENT_CONNECTION_ERROR` emits, and `YWebsocketEvent` type references from `provider.ts`
- [x] Remove deprecated getters (`shouldConnect`, `wsconnected`, `wsconnecting`, `synced`) from `provider.ts`
- [x] Remove `debugUrl` getter, `showDebuggerLink` field/option/assignment/logging from `provider.ts`
- [x] Delete `packages/y-sweet/src/encoding.ts`
- [x] Remove `encodeClientToken`/`decodeClientToken` exports from `main.ts`
- [x] Remove `awareness` option from `YSweetProviderParams` and constructor logic: always create `new Awareness(doc)` internally
- [x] Remove `warnOnClose` option from `YSweetProviderParams`, the `handleBeforeUnload` method, and `beforeunload` listener logic
- [x] Run `bun run check` to verify no type errors (y-sweet package passes `tsc --noEmit`; unrelated `@epicenter/config` failure pre-exists)
- [x] Run `bun test` in `packages/y-sweet`: no test files exist

## File summary

| File | Action |
|------|--------|
| `packages/y-sweet/src/ws-status.ts` | Delete |
| `packages/y-sweet/src/encoding.ts` | Delete |
| `packages/y-sweet/src/provider.ts` | Remove backwards-compat code |
| `packages/y-sweet/src/main.ts` | Remove encoding exports |
| `apps/epicenter/src/lib/yjs/y-sweet-connection.ts` | Migrate from `'sync'` to `'connection-status'` |
| `packages/epicenter/src/extensions/y-sweet-sync.ts` | Migrate from `'sync'` to `'connection-status'` |

## Verification

After all changes:

1. **No references to deleted APIs**: Grep for `shouldConnect`, `wsconnected`, `wsconnecting`, `\.synced`, `debugUrl`, `showDebuggerLink`, `encodeClientToken`, `decodeClientToken`, `WebSocketCompatLayer`, `EVENT_SYNC`, `EVENT_SYNCED`, `EVENT_STATUS`, `receivedAtLeastOneSyncResponse`: none should appear in `packages/y-sweet/src/`
2. **Type check passes**: `bun run check` should produce no errors related to y-sweet
3. **Functional test**: Connect to a running Y-Sweet server, verify sync completes and `whenSynced` resolves
4. **Heartbeat works**: After connecting, wait >5s idle: connection should remain open (heartbeat succeeds)
5. **Reconnection works**: Kill the Y-Sweet server, wait, restart it: client should reconnect automatically
