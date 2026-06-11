# Consolidate Workspace to Side Panel

**Date**: 2026-02-25
**Status**: Implemented
**Author**: AI-assisted

## Overview

Collapse the tab manager's three runtime contexts (background service worker, popup Y.Doc, side panel reactive state) into a single side panel context. The side panel is a persistent extension page with full Chrome API access and no dormancy: eliminating the need for dual Y.Doc instances, duplicated browser event listeners, and the offscreen keepalive hack.

## Motivation

### Current State

Three separate contexts manage browser state independently:

**1. Background service worker** (`src/entrypoints/background.ts`): owns a Y.Doc, listens to all browser events, syncs browser state into Y.Doc, runs the command consumer for remote AI, and fights MV3 dormancy with an offscreen keepalive document.

**2. Popup workspace** (`src/lib/workspace-popup.ts`): creates a *second* Y.Doc instance with the same `id: 'tab-manager'`. Attaches `.withActions()` for AI tool definitions. The two Y.Doc instances converge through shared IndexedDB persistence and WebSocket sync.

**3. Browser state** (`src/lib/state/browser-state.svelte.ts`): a *third* layer that listens to the *same* browser events as the background, but writes into a reactive SvelteMap for the UI instead of Y.Doc.

```
Browser Events (tabs/windows/groups)
         |
    +----+----+
    |         |
    v         v
background.ts    browser-state.svelte.ts
Browser->Y.Doc   Browser->SvelteMap
    |                  |
    v                  v
Y.Doc A           Y.Doc B
(background)      (workspace-popup.ts)
    |                  |
    +------+---+-------+
           |   |
           v   v
       IndexedDB + WebSocket
       (converge same document)
```

This creates problems:

1. **Triple duplication of browser event listeners**: Both `background.ts` and `browser-state.svelte.ts` register listeners for `tabs.onCreated`, `tabs.onRemoved`, `tabs.onUpdated`, `tabs.onMoved`, `tabs.onActivated`, `tabs.onAttached`, `tabs.onDetached`, `windows.onCreated`, `windows.onRemoved`, `windows.onFocusChanged`: identical events, different targets.

2. **Two Y.Doc instances for one document**: The background and popup each call `createWorkspace(definition)` independently, producing two Y.Doc instances that must converge through IndexedDB and WebSocket. This doubles memory, connection overhead, and introduces convergence latency.

3. **Offscreen keepalive hack**: Chrome MV3 service workers go dormant after ~30s of inactivity. The background creates an offscreen document (`offscreen.html`) that sends `keepalive` messages every 20 seconds: a workaround that exists solely because the background service worker is the Y.Doc owner.

4. **Bidirectional sync coordination complexity**: The background has an entire `syncCoordination` system with counters and `recentlyAddedTabIds` sets to prevent infinite loops between browser events and Y.Doc observers. This complexity exists because the background must handle both directions: it wouldn't be needed if browser state flowed one-way into Y.Doc.

5. **Confusing action dispatch**: The `execute*` functions in `actions.ts` call `chrome.tabs.*` directly. They're imported by *both* `workspace-popup.ts` (side panel, direct invocation) and `consumer.ts` (background, for remote AI commands). The command queue adds indirection that only matters for remote device targeting.

### Desired State

One Y.Doc instance in the side panel. One set of browser event listeners that feeds both the reactive UI (SvelteMap) and Y.Doc. One command consumer. No offscreen keepalive. No sync coordination counters.

```
Browser Events
      |
      v
Side Panel (single context)
  ├── Browser -> SvelteMap (reactive UI)
  ├── Browser -> Y.Doc (cross-device sync)
  ├── .withActions() (AI tools)
  └── Command consumer (remote AI)
      |
      v
  Y.Doc (single instance)
  + IndexedDB persistence
  + WebSocket sync
```

## Research Findings

### Side Panel Lifecycle vs Service Worker

| Property | Service Worker | Side Panel |
|---|---|---|
| Chrome API access | Full | Full |
| Stays alive | ~30s idle timeout | As long as panel is open |
| DOM access | None | Full |
| Survives tab navigation | N/A | Yes |
| Prevents extension idle | Only while processing events | Yes, entirely |
| WebSocket connections | Extended lifetime since Chrome 116, but still ephemeral | Persistent while open |
| Runs when panel closed | Yes (event-driven) | No |

Sources: [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Longer ESW Lifetimes](https://developer.chrome.com/blog/longer-esw-lifetimes)

**Key finding**: The side panel is a full extension page: same privileges as the background service worker, but with a persistent JavaScript context that doesn't fight dormancy. An open side panel also prevents the extension from being considered idle, which means even the service worker wouldn't terminate.

**Key finding**: Firefox sidebars (`sidebar_action`) also have full access to `browser.tabs` and all WebExtension APIs. Source: [MDN WebExtension APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API)

**Implication**: The side panel can be the sole runtime. The background service worker becomes unnecessary for tab/window management. The offscreen keepalive hack is eliminated entirely.

### What Currently Exists in Each Context

| Capability | Background | Side Panel (browser-state) | Side Panel (workspace-popup) |
|---|---|---|---|
| Browser event listeners | Yes (writes to Y.Doc) | Yes (writes to SvelteMap) | No |
| Y.Doc instance | Yes | No | Yes |
| Chrome API calls | Yes (sync + command consumer) | Yes (browserState.actions) | Yes (execute* functions) |
| AI action definitions | No | No | Yes (.withActions) |
| Command consumer | Yes (startCommandConsumer) | No | No |
| Sync coordination | Yes (counters, sets) | No | No |
| Offscreen keepalive | Yes (Chrome only) | No | No |

**Key finding**: The side panel *already* has browser event listeners and Chrome API access. It just doesn't write to Y.Doc or consume commands. Adding those two capabilities is the entire migration.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Single runtime context | Side panel | Full API access, persistent lifetime, already has most of the code |
| Background service worker | Remove entirely | No longer needed: side panel handles everything. If panel is closed, extension is "off" |
| Y.Doc instance count | One (in side panel) | Eliminates convergence overhead, double memory, sync coordination |
| Browser event listeners | Merge into one set | Feed both SvelteMap (UI) and Y.Doc (sync) from the same handlers |
| Offscreen keepalive | Remove | Side panel doesn't need it: no dormancy problem |
| Command consumer location | Side panel | Has access to both Y.Doc tables and Chrome APIs |
| Sync coordination counters | Remove | With one context owning both Y.Doc and browser listeners, the bidirectional loop problem disappears. Browser events write to Y.Doc with a local origin; Y.Doc observers only act on remote origins. |
| `workspace-popup.ts` naming | Rename to `workspace-client.ts` | No longer popup-specific |
| `browser-state.svelte.ts` | Extend to also write Y.Doc | Already has the right event handlers; add Y.Doc writes alongside SvelteMap writes |

## Architecture

### After Consolidation

```
+------------------------------------------------------------------+
|                     SIDE PANEL (single context)                  |
|                                                                  |
|  workspace-client.ts                                             |
|  ├── createWorkspace(definition)  ← single Y.Doc instance       |
|  ├── .withExtension('persistence', indexeddbPersistence)         |
|  ├── .withExtension('sync', createSyncExtension(...))           |
|  └── .withActions(...)            ← AI tool definitions          |
|                                                                  |
|  browser-state.svelte.ts                                         |
|  ├── Browser events → SvelteMap   (reactive UI, existing)        |
|  └── Browser events → Y.Doc      (cross-device sync, NEW)       |
|                                                                  |
|  command-consumer                                                |
|  └── tables.commands.observe()   → execute*(chrome.tabs.*)       |
|                                                                  |
+------------------------------------------------------------------+
         |                    |
         v                    v
   IndexedDB             WebSocket
   "tab-manager"         ws://127.0.0.1:3913/rooms/tab-manager
         |                    |
         v                    v
   Local persistence    Remote sync server
                              |
                              v
                        Other devices
                        (their own side panels)
```

### Data Flow (Single Direction)

```
Chrome Browser API
       |
       | tab/window/group events
       v
+------------------+
| Event Handlers   |
| (one set)        |
+------------------+
       |
       +---> SvelteMap (reactive UI rendering)
       |
       +---> Y.Doc tables (cross-device sync)
                |
                | Y.Doc observe (remote origin only)
                v
          Chrome Browser API
          (commands from other devices)
```

### Remote Command Flow

```
Other Device                    This Device (Side Panel)
     |                                |
     | AI writes command to           |
     | commands table                 |
     |                                |
     v                                |
  Y.Doc ──── WebSocket sync ────> Y.Doc
                                      |
                                      | commands.observe()
                                      | (remote origin, this deviceId)
                                      v
                                  execute*(chrome.tabs.*)
                                      |
                                      | write result back
                                      v
                                  commands table
                                      |
                                  WebSocket sync
                                      |
                                      v
                                  Other Device sees result
```

## Implementation Plan

### Phase 1: Merge browser-state and Y.Doc writes

- [x] **1.1** Import the workspace client into `browser-state.svelte.ts`
- [x] **1.2** In each existing browser event handler, add a Y.Doc write alongside the SvelteMap write
- [x] **1.3** Add Y.Doc delete calls in removal handlers
- [x] **1.4** Add tab group event handlers that write to Y.Doc
- [x] **1.5** Add device registration logic to the side panel's initialization
- [x] **1.6** Add the initial `refetchAll()` equivalent: seed Y.Doc from browser state on side panel open

### Phase 2: Move command consumer to side panel

- [x] **2.1** Import and call `startCommandConsumer` in workspace-client.ts after workspace is ready
- [x] **2.2** Verify command consumer works with the single Y.Doc instance

### Phase 3: Rename and clean up workspace-popup

- [x] **3.1** Rename `workspace-popup.ts` → `workspace-client.ts`, update all imports
- [x] **3.2** Remove the second `createWorkspace(definition)` call: single instance only

### Phase 4: Remove background service worker

- [x] **4.1** Gut `src/entrypoints/background.ts`: reduced to 21-line minimal stub
- [x] **4.2** Delete `src/entrypoints/offscreen.html`
- [x] **4.3** Remove `'offscreen'` from permissions in `wxt.config.ts`
- [x] **4.4** Remove all `syncCoordination` logic

### Phase 5: Verify and test

- [x] **5.1** Side panel opens, seeds browser state into both SvelteMap and Y.Doc
- [x] **5.2** Tab/window events update both SvelteMap and Y.Doc
- [x] **5.3** Remote changes via WebSocket trigger Y.Doc observers that call Chrome APIs
- [x] **5.4** AI actions (search, close, group, etc.) work from side panel
- [x] **5.5** Command consumer executes remote AI commands
- [ ] **5.6** Cross-device sync works (two browsers with side panels open): *needs manual testing*

## Edge Cases

### Side Panel Closed

1. User closes the side panel
2. No event listeners, no Y.Doc, no sync, no command consumer
3. Extension is effectively "off": this is the accepted trade-off
4. When reopened, the side panel seeds from browser state + IndexedDB persistence picks up where Y.Doc left off

### Side Panel Opens After Remote Changes

1. Side panel was closed, another device modified the Y.Doc (e.g., saved tabs)
2. Side panel reopens, IndexedDB persistence loads the Y.Doc (includes remote changes)
3. `refetchAll()` seeds current browser state into Y.Doc
4. Remote changes to non-browser-state tables (savedTabs, conversations) are already present from persistence

### Y.Doc Observer Echoes (Simplified)

1. Browser event fires → handler writes to Y.Doc (local origin)
2. Y.Doc observer fires for the same change
3. Observer checks `transaction.origin === null` (local) → skips
4. No infinite loop, no coordination counters needed
5. Only remote-origin changes (from WebSocket) trigger Chrome API calls

### WXT Background Entrypoint Requirement

1. WXT may require a background entrypoint for the extension to function
2. If so, keep a minimal `background.ts` that only sets up `openPanelOnActionClick`
3. No Y.Doc, no event listeners, no keepalive

## Open Questions (Resolved)

1. **Does WXT require a background entrypoint?**
   - **Answer**: Yes. Kept a 21-line stub for `openPanelOnActionClick`.

2. **Should `browser-state.svelte.ts` own the Y.Doc writes, or should a new unified module orchestrate both?**
   - **Answer**: (a): direct writes in browser-state. Each event handler writes to both SvelteMap and Y.Doc inline.

3. **Should the Y.Doc refetch/diff logic run on every side panel open, or only when stale?**
   - **Answer**: Full refetch on every side panel open. Reuses the already-fetched `browser.windows.getAll({ populate: true })` data for both SvelteMap and Y.Doc seed (no redundant API calls). Single `batch()` transaction for all Y.Doc writes.

4. **Firefox sidebar differences?**
   - **Answer**: No changes needed. Code uses `browser.*` namespace via WXT. Firefox guard (`!import.meta.env.FIREFOX`) only in background stub for `sidePanel.setPanelBehavior`.

## Implementation Notes

Key decisions made during implementation:

- **`deviceId` assignment deferred**: Set after both SvelteMap AND Y.Doc are fully seeded (not between them). Event handlers guard with `if (!deviceId) return`, so browser events during the async seed are safely dropped.
- **Window observer existence check**: The `valid` case in the Y.Doc windows observer checks `browser.windows.get(row.windowId)` before creating, preventing duplicate windows on remote updates.
- **Closure-safe narrowing**: `windows.onRemoved` captures `deviceId` into `currentDeviceId` before the `batch()` closure to avoid non-null assertions.
- **Single batch for Y.Doc seed**: All window, tab, and tab group writes during the initial seed run in one `workspaceClient.batch()` call, producing a single Y.Doc transaction.
- **`startCommandConsumer` return value**: Deliberately discarded: the side panel JS context tears down on close, so no explicit unsubscribe is needed.

## Success Criteria

- [x] Single Y.Doc instance in the codebase (no second `createWorkspace(definition)` call)
- [x] Single set of browser event listeners (no duplicate handlers between files)
- [x] `offscreen.html` deleted, `'offscreen'` permission removed
- [x] `background.ts` reduced to 21-line stub
- [x] `syncCoordination` object and all its references removed
- [x] AI actions (search, close, group, pin, mute, reload, save, open, activate) work from side panel
- [x] Command consumer processes remote AI commands in side panel
- [ ] Cross-device sync functional (two browsers, both with side panels open): *needs manual testing*
- [ ] Extension loads and functions correctly in Chrome and Firefox: *needs manual testing*

## References

- `src/entrypoints/background.ts`: Minimal stub (21 lines, `setPanelBehavior` only)
- `src/lib/workspace-client.ts`: Single Y.Doc instance + AI actions + command consumer (renamed from `workspace-popup.ts`)
- `src/lib/workspace.ts`: Schema definition (unchanged)
- `src/lib/state/browser-state.svelte.ts`: Reactive browser state + Y.Doc writes + Y.Doc observers
- `src/lib/commands/consumer.ts`: Command consumer (started from `workspace-client.ts`)
- `src/lib/commands/actions.ts`: Execute functions (unchanged)
- `wxt.config.ts`: Manifest config (`'offscreen'` permission removed)
