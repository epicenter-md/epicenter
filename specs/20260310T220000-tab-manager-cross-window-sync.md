# Tab Manager Cross-Window Sync Fix

**Date**: 2026-03-10
**Status**: Phase 1 Complete (sync status visibility shipped; Phases 2-3 deferred)
**Author**: AI-assisted

## Overview

Add sync status visibility to the tab manager extension and a BroadcastChannel bridge for instant local cross-window Y.Doc synchronization. Currently, two side panel windows don't sync saved tabs in real-time because `y-indexeddb` is persistence-only and the WebSocket sync status is invisible.

## Motivation

### Current State

Each side panel window creates its own `workspaceClient` with a separate `Y.Doc`:

```typescript
// apps/tab-manager/src/lib/workspace.ts
export const workspaceClient = createWorkspace(defineWorkspace({ id: 'tab-manager', ... }))
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({
    url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
    getToken: async () => authState.token ?? '',
  }))
```

The `indexeddbPersistence` extension uses `y-indexeddb` v9.0.12 (184 lines, verified from source). It persists Y.Doc updates to IndexedDB and loads them on initialization. **It has no BroadcastChannel, no cross-tab notification, no polling.**

The only real-time sync path between windows is the WebSocket sync extension. Its connection status is invisible to users.

This creates problems:

1. **No local cross-window sync**: When two side panels are open, changes in one don't appear in the other until close+reopen (which triggers IndexedDB reload).
2. **Invisible sync failures**: If WebSocket auth fails or the server is unreachable, there's no UI indication. The sync provider silently retries with exponential backoff.
3. **Unknown root cause**: We can't tell whether the sync issue is from missing local sync, broken WebSocket, or both.

### Desired State

- A visible sync status indicator showing whether WebSocket is `connected`, `connecting`, `error`, or `offline`.
- Instant local cross-window sync via BroadcastChannel (works without any server).
- Clear separation of concerns: BroadcastChannel handles same-browser sync, WebSocket handles cross-device sync.

## Research Findings

### y-indexeddb v9.0.12 Source Analysis

Read the full source at `node_modules/.bun/y-indexeddb@9.0.12/.../src/y-indexeddb.js`. Key findings:

| Mechanism | Present? | Details |
|-----------|----------|---------|
| IndexedDB persistence | ✓ | `doc.on('update', this._storeUpdate)` + `fetchUpdates()` on init |
| BroadcastChannel | ✗ | Not in source: zero cross-tab communication |
| Cross-tab polling | ✗ | No interval-based IndexedDB reads |
| Storage events | ✗ | IndexedDB doesn't fire cross-tab events like localStorage |

**Key finding**: `y-indexeddb` is persistence-only. The close+reopen "fix" works because a fresh `IndexeddbPersistence` calls `fetchUpdates()` on construction, loading all stored updates.

### Sync Provider Status Model

The `@epicenter/sync-client` provider already tracks five states:

```
offline → connecting → handshaking → connected
                ↑                        ↓
               error ←──── ws.close ────┘
```

This status is available via `provider.status` and `provider.onStatusChange()`, but it's never surfaced in the UI.

### BroadcastChannel in Chrome Extensions

Chrome extension pages (side panels, popups, options) all share the `chrome-extension://<id>` origin. BroadcastChannel works across all of them. This is the same mechanism `y-webrtc` uses internally for same-origin tab sync.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync status placement | Settings/footer area of side panel | Non-intrusive, always visible, doesn't clutter tab UI |
| BroadcastChannel scope | Workspace extension factory | Follows existing extension pattern, lifecycle-managed, reusable |
| Update encoding | V2 (`updateV2` / `applyUpdateV2`) | Matches what sync-client uses (~40% smaller than V1) |
| BroadcastChannel name | `ydoc.guid` (= workspace ID) | Ensures only same-workspace docs sync; matches y-indexeddb's DB name |
| Origin sentinel | Symbol for loop prevention | Same pattern as sync-client's `SYNC_ORIGIN` |

## Architecture

### Phase 1: Sync Status Visibility

```
┌──────────────────────────────────────────┐
│ Side Panel UI                            │
│                                          │
│  ┌─ Settings or Footer ───────────────┐  │
│  │  Sync: ● Connected                 │  │
│  │  (or ○ Connecting... / ✗ Offline)  │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
         ▲
         │ reads provider.status via
         │ workspaceClient.extensions.sync.provider
```

### Phase 2: BroadcastChannel Bridge

```
Window A (Side Panel)              Window B (Side Panel)
┌──────────────┐                   ┌──────────────┐
│ Y.Doc        │                   │ Y.Doc        │
│  │           │                   │  │           │
│  ├─ IDB ────►│─── IndexedDB ───►│◄─ IDB        │  (persistence, no cross-tab)
│  │           │                   │  │           │
│  ├─ WS ─────►│─── Server ──────►│◄─ WS         │  (cross-device, if connected)
│  │           │                   │  │           │
│  └─ BC ─────►│─── Broadcast ───►│◄─ BC         │  (NEW: instant local sync)
│              │    Channel        │              │
└──────────────┘                   └──────────────┘
```

The BroadcastChannel bridge extension:

```typescript
// Conceptual shape (not final code)
function broadcastChannelSync({ ydoc }: { ydoc: Y.Doc }) {
  const ORIGIN = Symbol('bc-sync');
  const channel = new BroadcastChannel(`yjs:${ydoc.guid}`);

  // Broadcast local changes
  const handler = (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN) return; // don't echo
    channel.postMessage(update);
  };
  ydoc.on('updateV2', handler);

  // Apply remote changes
  channel.onmessage = (event) => {
    Y.applyUpdateV2(ydoc, new Uint8Array(event.data), ORIGIN);
  };

  return {
    destroy() {
      ydoc.off('updateV2', handler);
      channel.close();
    },
  };
}
```

## Implementation Plan

### Phase 1: Sync Status Visibility

Goal: Surface WebSocket sync status so we can see what's happening.

- [x] **1.1** Create a reactive sync status state in `apps/tab-manager/src/lib/state/` that reads from `workspaceClient.extensions.sync.provider.onStatusChange()`
- [x] **1.2** Add a minimal sync status indicator component (dot + text) to the side panel UI (settings area or footer)
- [x] **1.3** Show connection state: `connected` (green), `connecting` (yellow/pulsing), `offline` (gray)

**CHECKPOINT**: User verifies sync status. If it shows `error` or `offline`, investigate and fix WebSocket sync before proceeding.

### Phase 2: Fix WebSocket Sync (if broken)

Only if Phase 1 reveals the WebSocket isn't connecting:

- [ ] **2.1** Diagnose based on status: token issue, URL issue, server unreachable, etc.
- [ ] **2.2** Fix the root cause (auth flow, URL resolution timing, server config)
- [ ] **2.3** Verify both windows show `connected` status

### Phase 3: BroadcastChannel Bridge

- [ ] **3.1** Create `broadcastChannelSync` extension factory in `packages/workspace/src/extensions/sync/broadcast-channel.ts`
- [ ] **3.2** Wire it into the tab-manager workspace client chain (before WebSocket sync, after persistence)
- [ ] **3.3** Verify: open two side panels, save a tab in one, confirm it appears instantly in the other

## Edge Cases

### Two windows write simultaneously

1. Both windows save a tab at the same millisecond
2. BroadcastChannel delivers both updates to both docs
3. YKeyValueLww resolves via timestamp comparison (LWW semantics): no data loss, deterministic winner

### Extension service worker termination (MV3)

1. Chrome terminates the service worker
2. BroadcastChannel is NOT affected: it lives in each side panel context, not the service worker
3. Side panel contexts persist as long as the panel is open

### WebSocket + BroadcastChannel delivering same update

1. Both paths deliver the same update to Window B
2. Yjs deduplicates internally: `applyUpdateV2` with an already-applied state vector is a no-op
3. Observer fires once (from whichever arrives first)

### BroadcastChannel unavailable

1. Some browsers/contexts might not support BroadcastChannel
2. Extension factory should check `typeof BroadcastChannel !== 'undefined'` and no-op if unavailable
3. WebSocket sync remains the fallback

## Open Questions

1. **Where exactly should the sync status indicator go?**
   - Options: (a) footer bar, (b) settings page only, (c) small icon in the header
   - **Recommendation**: Small indicator in the footer or settings: visible but unobtrusive

2. **Should the BroadcastChannel extension live in `packages/workspace/` or `apps/tab-manager/`?**
   - Options: (a) `packages/workspace/src/extensions/sync/broadcast-channel.ts` (reusable), (b) `apps/tab-manager/src/lib/` (app-specific)
   - **Recommendation**: (a): it's a generic Yjs extension, useful for any browser-based workspace

3. **Should we also sync awareness via BroadcastChannel?**
   - Awareness shows which devices are online / user presence
   - **Recommendation**: Defer: awareness is less critical than data sync and adds complexity

## Success Criteria

- [ ] Sync status is visible in the side panel UI
- [ ] User can tell at a glance whether WebSocket sync is working
- [ ] Two side panel windows sync saved tabs in real-time without server dependency
- [ ] Close+reopen is no longer needed to see changes from another window
- [ ] No regressions: existing persistence, WebSocket sync, and observer patterns unchanged

## References

- `apps/tab-manager/src/lib/workspace.ts`: workspaceClient definition and extension chain
- `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts`: savedTabs observer and reactive state
- `apps/tab-manager/src/lib/state/settings.svelte.ts`: serverUrl storage state
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: auth token state
- `apps/tab-manager/src/entrypoints/background.ts`: minimal background script (no sync)
- `packages/workspace/src/extensions/sync.ts`: sync extension factory
- `packages/workspace/src/extensions/sync/web.ts`: indexeddbPersistence factory
- `packages/sync-client/src/provider.ts`: sync provider with status model
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts`: LWW conflict resolution
- `node_modules/.bun/y-indexeddb@9.0.12/.../src/y-indexeddb.js`: verified: no BroadcastChannel
