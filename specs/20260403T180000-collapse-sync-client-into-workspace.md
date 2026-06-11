# Collapse @epicenter/sync-client into Workspace Extension Module

**Date**: 2026-04-03
**Status**: Draft
**Author**: AI-assisted (Braden + Sisyphus)

## Overview

Delete the `@epicenter/sync-client` package and inline its logic into the workspace sync extension module. The WebSocket transport becomes an internal sibling file. Not a published package. RPC moves entirely into the extension, eliminating the `pendingRequests` leak and `data: unknown` callback pattern.

## Motivation

### Current State

Two packages, two layers, one awkward seam:

```
@epicenter/sync-client (provider.ts: 747 lines)
  └─ createSyncProvider() → SyncProvider
      - Supervisor loop, backoff, liveness
      - WebSocket lifecycle
      - Y.Doc sync + awareness
      - RPC: sendRpcRequest(), onRpcRequest(), pendingRequests (public Map)

@epicenter/workspace (websocket.ts: 262 lines)
  └─ createSyncExtension() → SyncExtensionExports
      - Wraps provider: status, onStatusChange, reconnect (passthrough)
      - peers() from awareness
      - rpc<TMap>() with timeout management
      - Lifecycle: whenReady, dispose
```

This creates problems:

1. **RPC straddles both layers.** The provider sends/receives RPC messages and exposes `pendingRequests` as a public mutable Map. The extension reaches in, plants resolve callbacks, and manages timeouts from outside. Timer lifecycle is split. Extension creates timers, provider clears them on reconnect.

2. **`data: unknown, error: unknown` in public types.** Because the provider operates at the protocol level, the callback signature is `(result: { data: unknown; error: unknown }) => void`. The extension casts both fields: `result.error as RpcError | null`, `result.data as TMap[TAction]['output']`.

3. **Nobody uses the raw provider.** Every consumer imports `createSyncExtension` from the workspace package. The `@epicenter/sync-client` README says "Most consumers don't use this package directly." The exploration confirms: zero direct consumers exist.

4. **The broadcast-channel extension proves single-module transport works.** `broadcastChannelSync` is a transport AND extension factory in 70 lines. No separate `@epicenter/broadcast-client` package. WebSocket is more complex but the same principle applies.

### Desired State

```
packages/workspace/src/extensions/sync/
  websocket.ts              ← public: createSyncExtension(), websocketUrl(), types
  websocket-transport.ts    ← internal: createTransport(): supervisor, backoff, liveness
  broadcast-channel.ts      ← unchanged
```

- `@epicenter/sync-client` package deleted
- RPC fully owned by `websocket.ts`: `pendingRequests` is a private closure variable
- Transport is an implementation detail, not a published API
- Consumer call sites unchanged (they already import from the workspace package)
- One type import changes: `SyncStatusIndicator.svelte` imports `SyncStatus` from the workspace extension instead of `@epicenter/sync-client`

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| File split | Two files (websocket.ts + websocket-transport.ts) | ~850 lines in one file is too much. Transport (supervisor loop, backoff, liveness) is a natural boundary. But it's a sibling file, not a package. |
| Transport API | Config callback for unknown message types | Transport handles SYNC, AWARENESS, QUERY_AWARENESS, SYNC_STATUS. RPC dispatches via `onCustomMessage` callback. No dynamic handler registration, no plugin system. |
| RPC ownership | Entirely in websocket.ts | Extension creates promises, manages timeouts, cleans up on dispose. No public `pendingRequests`. |
| `SyncStatus` location | Exported from websocket.ts, defined in websocket-transport.ts | Transport owns status transitions, so it defines the type. Extension re-exports for consumers. |
| Package deletion | Delete entirely, no re-export shim | Zero direct consumers. Clean break. |
| Testing | Transport tests move alongside transport file | `provider.test.ts` → `websocket-transport.test.ts` with updated imports. Same test logic, different factory signature. |

## Architecture

### Transport API

```typescript
// websocket-transport.ts: INTERNAL, not exported from package

export type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; attempt: number; lastError?: SyncError }
  | { phase: 'connected'; hasLocalChanges: boolean };

export type SyncError =
  | { type: 'auth'; error: unknown }
  | { type: 'connection' };

export type TransportConfig = {
  doc: Y.Doc;
  url: () => string;
  getToken?: () => Promise<string | null>;
  awareness?: Awareness;
  /** Called for message types the transport doesn't handle internally. */
  onCustomMessage?: (messageType: number, data: Uint8Array) => void;
};

export type Transport = {
  readonly status: SyncStatus;
  readonly awareness: Awareness;
  connect(): void;
  disconnect(): void;
  reconnect(): void;
  onStatusChange(listener: (status: SyncStatus) => void): () => void;
  /** Send a binary message. No-ops if not connected. */
  send(message: Uint8Array): void;
  dispose(): void;
};

export function createTransport(config: TransportConfig): Transport;
```

### Extension (public API: unchanged)

```typescript
// websocket.ts: createSyncExtension() signature stays identical

// Re-export types consumers need
export type { SyncStatus, SyncError } from './websocket-transport.js';

export function createSyncExtension(config: SyncExtensionConfig) {
  return ({ ydoc, whenReady: priorReady }: SharedExtensionContext) => {
    const docId = ydoc.guid;
    const { getToken } = config;

    // ── RPC state (private: closure variables) ──
    const pendingRequests = new Map<number, { resolve: ...; timer: ... }>();
    let nextRequestId = 0;
    let rpcHandler: ... | null = null;

    // ── Transport (internal, handles sync + awareness) ──
    const transport = createTransport({
      doc: ydoc,
      url: () => config.url(docId),
      getToken: getToken ? () => getToken(docId) : undefined,
      onCustomMessage(messageType, data) {
        if (messageType !== MESSAGE_TYPE.RPC) return;
        const rpc = decodeRpcMessage(data);
        if (rpc.type === 'response') {
          // Resolve pending request: all in this scope
          const pending = pendingRequests.get(rpc.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(rpc.requestId);
            pending.resolve(rpc.result);
          }
        } else if (rpc.type === 'request' && rpcHandler) {
          rpcHandler(
            { requestId: rpc.requestId, action: rpc.action, input: rpc.input },
            (result) => {
              transport.send(encodeRpcResponse({ ... }));
            },
          );
        }
      },
    });

    const whenReady = (async () => {
      await priorReady;
      transport.connect();
    })();

    return {
      get status() { return transport.status; },
      onStatusChange: transport.onStatusChange,
      reconnect: transport.reconnect,
      peers() { /* reads transport.awareness: same as today */ },
      async rpc<TMap, TAction>(...) {
        // Full RPC lifecycle here: no reaching into transport internals
      },
      whenReady,
      dispose() {
        for (const [, p] of pendingRequests) clearTimeout(p.timer);
        pendingRequests.clear();
        transport.dispose();
      },
    };
  };
}
```

### What changes for consumers

```
BEFORE                                              AFTER
─────                                               ─────
import { createSyncExtension, websocketUrl }             import { createSyncExtension, websocketUrl }
  from '@epicenter/workspace/extensions/             from '@epicenter/workspace/extensions/
         sync/websocket';                                     sync/websocket';
                                                    (identical, no change)

import type { SyncStatus }                          import type { SyncStatus }
  from '@epicenter/sync-client';                      from '@epicenter/workspace/extensions/
                                                              sync/websocket';
                                                    (one file changes this import)
```

## Implementation Plan

### Phase 1: Create transport file (code move, no behavior change)

- [ ] **1.1** Create `packages/workspace/src/extensions/sync/websocket-transport.ts`
- [ ] **1.2** Move from `provider.ts` into transport file: `createTransport()` with the supervisor loop, `attemptConnection()`, `createStatusEmitter()`, `createLivenessMonitor()`, `createBackoff()`, `SyncStatus`, `SyncError`, all constants
- [ ] **1.3** The `onmessage` switch: SYNC, AWARENESS, QUERY_AWARENESS, SYNC_STATUS stay in transport. The `MESSAGE_TYPE.RPC` case and `default` case become a call to `config.onCustomMessage?.(messageType, data)`
- [ ] **1.4** Transport exposes `send()` for the extension to send RPC messages
- [ ] **1.5** Remove all RPC state from transport: no `pendingRequests`, no `nextRequestId`, no `rpcHandler`, no `sendRpcRequest()`, no `onRpcRequest()`
- [ ] **1.6** Transport's `dispose()` handles its own cleanup only (disconnect, remove doc/awareness listeners, clear status listeners). RPC cleanup is the extension's job.

### Phase 2: Rewire websocket.ts to use transport (behavior change: RPC moves)

- [ ] **2.1** Import `createTransport` from `./websocket-transport.js` instead of `createSyncProvider` from `@epicenter/sync-client`
- [ ] **2.2** Move RPC state into the extension closure: `pendingRequests`, `nextRequestId`, `rpcHandler`
- [ ] **2.3** Handle RPC messages via `onCustomMessage` callback (decode, dispatch to pending/handler)
- [ ] **2.4** Send RPC messages via `transport.send(encodeRpcRequest(...))` instead of `provider.sendRpcRequest()`
- [ ] **2.5** RPC timeout timers created AND cleaned up in the extension (no split lifecycle)
- [ ] **2.6** Re-export `SyncStatus` and `SyncError` types from websocket.ts for consumers
- [ ] **2.7** Remove the import of `@epicenter/sync-client` from websocket.ts

### Phase 3: Move and adapt tests

- [ ] **3.1** Move `packages/sync-client/src/provider.test.ts` → `packages/workspace/src/extensions/sync/websocket-transport.test.ts`
- [ ] **3.2** Update test imports: `createTransport` from `./websocket-transport.js` instead of `createSyncProvider` from `@epicenter/sync-client`
- [ ] **3.3** Adapt test factory calls to match new `TransportConfig` shape (add `onCustomMessage` where RPC tests exist)
- [ ] **3.4** Run tests, verify they pass

### Phase 4: Update consumer imports

- [ ] **4.1** `SyncStatusIndicator.svelte`: change `import type { SyncStatus } from '@epicenter/sync-client'` → `from '@epicenter/workspace/extensions/sync/websocket'`
- [ ] **4.2** Remove `@epicenter/sync-client` from `apps/honeycrisp/package.json` dependencies
- [ ] **4.3** Remove `@epicenter/sync-client` from `apps/tab-manager/package.json` dependencies
- [ ] **4.4** Remove `@epicenter/sync-client` from `apps/opensidian/package.json` dependencies
- [ ] **4.5** Remove `@epicenter/sync-client` from `packages/workspace/package.json` dependencies

### Phase 5: Delete the package

- [ ] **5.1** Delete `packages/sync-client/` directory entirely
- [ ] **5.2** Run `bun install` to update lockfile
- [ ] **5.3** Verify full build: `bun run typecheck` from repo root
- [ ] **5.4** Verify tests: `bun test` in `packages/workspace/`
- [ ] **5.5** Grep for any remaining `sync-client` references (specs/docs are fine to leave as historical)

## Edge Cases

### RPC pending requests on reconnect

Currently, `provider.ts` lines 343-346 clear pending requests on reconnect (inside `attemptConnection`). After collapse, the transport doesn't know about RPC. The extension needs to handle this.

**Solution**: The extension subscribes to status changes. When status transitions to `connecting` (attempt 0 = fresh connection), it clears pending requests and rejects with timeout. Alternatively, the `onCustomMessage` callback can be stateless and the extension clears pending requests in its own reconnect handler.

Actually, simplest: the transport already resets connection state in `attemptConnection`. The extension should clear pending requests when the transport fires `onStatusChange({ phase: 'connecting', attempt: 0 })`: which means a new connection attempt just started and old responses will never arrive.

### RPC handler registration without ExtensionContext

The deferred spec item 6.4 notes that `onRpcRequest` needs `ExtensionContext.actions` which isn't available in `SharedExtensionContext`. This hasn't changed. The handler is registered externally (e.g., by the app after workspace creation). After collapse, the extension still exposes `onRpcRequest()` for external registration. Same as today.

### Transport reuse (future)

If someone later needs raw Y.Doc sync without the workspace extension, `createTransport()` is a clean internal function that could be promoted to a public export. The function is self-contained. No workspace dependencies. This door isn't closed; it's just not the default path.

## Success Criteria

- [ ] `@epicenter/sync-client` package directory deleted
- [ ] No file imports from `@epicenter/sync-client`
- [ ] `pendingRequests` is not in any public type definition
- [ ] `data: unknown; error: unknown` removed from all public callback signatures
- [ ] All existing sync tests pass
- [ ] `bun run typecheck` passes from repo root
- [ ] All apps build: honeycrisp, tab-manager, opensidian
- [ ] Sync still works (connect, disconnect, reconnect, status changes)

## References

- `packages/sync-client/src/provider.ts`: Source for transport logic (will be deleted)
- `packages/sync-client/src/types.ts`: Source for SyncStatus/SyncError types (will be deleted)
- `packages/workspace/src/extensions/sync/websocket.ts`: Extension that wraps the provider (will be rewritten)
- `packages/workspace/src/extensions/sync/broadcast-channel.ts`: Pattern reference (single-module transport)
- `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte`: Only consumer that imports a type from sync-client
- `specs/20260402T120000-workspace-rpc.md`: Original RPC spec that designed the split
