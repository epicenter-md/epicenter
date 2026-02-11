# Modernize Tab Manager Client

**Created**: 2026-02-02T20:30:00  
**Status**: Draft  
**Scope**: apps/tab-manager

## Problem Statement

The tab manager's background service worker has a critical bug and uses outdated patterns:

1. **Bug**: `createWorkspaceClient(backgroundWorkspace)` is called but never imported (line 304)
2. **Outdated API**: Uses dynamic workspace API with inline `actions` and `extensions` fields (not supported)
3. **Missing Persistence**: Y.Doc is in-memory only; service worker restarts lose all state
4. **Random Workspace ID**: Uses `generateGuid()` which creates a new ID on every restart

## Architecture Decision: Y.Doc in Background Only

The Y.Doc lives **exclusively in the background service worker**. This is intentional:

```
┌─────────────────────────────────────────────────────────────────┐
│                    BACKGROUND SERVICE WORKER                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Static Workspace (Y.Doc)                                │   │
│  │  ├── Tables: tabs, windows, tab_groups, devices         │   │
│  │  └── Capabilities:                                       │   │
│  │      ├── persistence (y-indexeddb)                      │   │
│  │      └── websocketSync (multi-device + CLI access)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│         ┌────────────────────┴────────────────────┐             │
│         ▼                                          ▼             │
│  [Browser Events]                           [Y.Doc Observers]    │
│  tab created → upsert to Y.Doc              remote delete →      │
│  tab removed → delete from Y.Doc            browser.tabs.remove  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket (y-websocket protocol)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         SYNC SERVER                              │
│  Enables CLI tools to list/edit/delete tabs via Y.Doc           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         POPUP CONTEXT                            │
│  TanStack Query → Chrome APIs directly                          │
│  NO Y.Doc (Chrome is source of truth for local display)         │
└─────────────────────────────────────────────────────────────────┘
```

**Why this architecture?**

| Concern         | Background-Only Y.Doc                      | Y.Doc in Both Contexts             |
| --------------- | ------------------------------------------ | ---------------------------------- |
| Source of truth | Clear: Chrome for local UI, Y.Doc for sync | Ambiguous                          |
| Memory          | One Y.Doc                                  | Two Y.Docs duplicating data        |
| Popup lifecycle | Irrelevant                                 | Y.Doc created/destroyed constantly |
| CLI integration | Clean: CLI connects to same sync server    | Complex                            |

**Use case**: A CLI tool can connect to the sync server and manipulate tabs. When the CLI deletes a tab from the Y.Doc, the browser extension's Y.Doc observer calls `browser.tabs.remove()`. Each device's tabs are scoped by `device_id`, so deleting a tab only affects that device.

## Goals

1. Migrate from dynamic to **static workspace API**
2. Fix the broken import bug
3. Add **y-indexeddb persistence** (critical for service worker restarts)
4. Use a **stable workspace ID** (not random GUID)
5. Extract actions to standalone helper functions

## Non-Goals

- Changing the bidirectional sync coordination (counter-based pattern is proven)
- Changing the popup architecture (it correctly queries Chrome APIs directly)
- Adding new features beyond modernization

## Sync Coordination Pattern

The current counter-based sync coordination prevents infinite loops and is the **same pattern used by the markdown provider**. It works correctly and should be kept:

```typescript
const syncCoordination = {
	yDocChangeCount: 0, // Incremented when Y.Doc observer calls Browser APIs
	refetchCount: 0, // Incremented when Browser events update Y.Doc
};
```

**Why counters instead of booleans?** Multiple async operations can run concurrently. A boolean causes race conditions; counters handle overlapping operations correctly.

**Why not origin-only?** The code already uses `transaction.origin` checks as the primary mechanism. Counters are a secondary safety layer (belt-and-suspenders). Given the complexity of browser extension lifecycles, keeping both is prudent.

## Implementation Plan

### Phase 1: Add y-indexeddb Persistence (CRITICAL)

Service workers get terminated by Chrome after 30 seconds of inactivity. Without persistence, the Y.Doc is lost and must refetch everything on wake.

**File**: `apps/tab-manager/src/entrypoints/background.ts`

- [ ] Install y-indexeddb: `bun add y-indexeddb`
- [ ] Create persistence capability that works in service worker context
- [ ] Test that state survives service worker termination

```typescript
import { IndexeddbPersistence } from 'y-indexeddb';

// Capability factory for y-indexeddb
const indexedDbPersistence = (ctx: CapabilityContext) => {
	const provider = new IndexeddbPersistence('tab-manager', ctx.ydoc);

	return {
		whenSynced: provider.whenSynced,
		destroy: () => provider.destroy(),
	};
};
```

### Phase 2: Migrate to Static Workspace API

- [ ] Change import from `@epicenter/hq/dynamic` to `@epicenter/hq/static`
- [ ] Remove `extensions` field from `defineWorkspace`
- [ ] Remove `actions` field from `defineWorkspace`
- [ ] Use stable workspace ID: `'tab-manager'` instead of `generateGuid()`
- [ ] Replace broken `createWorkspaceClient()` with `createWorkspace().withExtensions()`

**Before** (broken):

```typescript
import { defineWorkspace, generateGuid } from '@epicenter/hq/dynamic';

const backgroundWorkspace = defineWorkspace({
  id: generateGuid(),  // Random ID = new Y.Doc every restart!
  slug: 'browser',
  name: 'Browser Tabs',
  kv: {},
  tables: BROWSER_TABLES,
  // @ts-expect-error
  extensions: { serverSync: websocketSync({...}) },
  actions: ({ ydoc, tables }) => ({...}),
});

const client = createWorkspaceClient(backgroundWorkspace); // NOT IMPORTED!
```

**After** (correct):

```typescript
import { createWorkspace, defineWorkspace } from '@epicenter/hq/static';
import { IndexeddbPersistence } from 'y-indexeddb';

// 1. Define workspace schema (pure, no runtime)
const definition = defineWorkspace({
	id: 'tab-manager', // Stable ID!
	tables: BROWSER_TABLES,
});

// 2. Create client with capabilities
const client = createWorkspace(definition).withExtensions({
	persistence: (ctx) => {
		const provider = new IndexeddbPersistence('tab-manager', ctx.ydoc);
		return {
			whenSynced: provider.whenSynced,
			destroy: () => provider.destroy(),
		};
	},
	sync: (ctx) =>
		websocketSync({
			url: 'ws://localhost:3913/sync',
			ydoc: ctx.ydoc,
		}),
});
```

### Phase 3: Extract Actions to Helper Functions

The `actions` parameter in `defineWorkspace` is not part of the static API. Extract to standalone functions:

- [ ] Create `createTabManagerActions(client, deviceIdPromise)` factory function
- [ ] Move all action methods (registerDevice, refetchTabs, etc.) to the factory
- [ ] Update all call sites to use the new pattern

```typescript
function createTabManagerActions(
	client: WorkspaceClient<typeof definition>,
	deviceIdPromise: Promise<string>,
) {
	const { tables, ydoc } = client;

	return {
		async registerDevice() {
			const deviceId = await deviceIdPromise;
			const existingDevice = tables.get('devices').get({ id: deviceId });
			const existingName =
				existingDevice.status === 'valid' ? existingDevice.row.name : null;

			tables.get('devices').upsert({
				id: deviceId,
				name: existingName ?? (await generateDefaultDeviceName()),
				last_seen: new Date().toISOString(),
				browser: getBrowserName(),
			});
		},

		async refetchTabs() {
			const deviceId = await deviceIdPromise;
			const { tabToRow, TabId } = createBrowserConverters(deviceId);
			const browserTabs = await browser.tabs.query({});
			// ... rest of implementation unchanged
		},

		// ... other methods unchanged
	};
}

// Usage
const tabManagerActions = createTabManagerActions(client, deviceIdPromise);
await tabManagerActions.refetchAll();
```

### Phase 4: Update Initialization Flow

- [ ] Wait for persistence to sync before initial refetch
- [ ] Update `initPromise` to include persistence readiness

```typescript
const initPromise = (async () => {
	// Wait for IndexedDB to load existing state
	await client.capabilities.persistence.whenSynced;

	// Then refetch to sync with current browser state
	await tabManagerActions.refetchAll();
	console.log('[Background] Initial sync complete');
})();
```

## Detailed Changes

### background.ts Structure (After)

```typescript
import { createWorkspace, defineWorkspace } from '@epicenter/hq/static';
import { IndexeddbPersistence } from 'y-indexeddb';
import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
import { defineBackground } from 'wxt/utils/define-background';
// ... other imports

// ─────────────────────────────────────────────────────────────
// Sync Coordination (unchanged - proven pattern)
// ─────────────────────────────────────────────────────────────
const syncCoordination = {
	yDocChangeCount: 0,
	refetchCount: 0,
	recentlyAddedTabIds: new Set<number>(),
};

// ─────────────────────────────────────────────────────────────
// Workspace Definition (static, pure)
// ─────────────────────────────────────────────────────────────
const definition = defineWorkspace({
	id: 'tab-manager',
	tables: BROWSER_TABLES,
});

export default defineBackground(() => {
	console.log('[Background] Initializing Tab Manager...');

	const deviceIdPromise = getDeviceId();

	// ─────────────────────────────────────────────────────────────
	// Create Workspace Client with Capabilities
	// ─────────────────────────────────────────────────────────────
	const client = createWorkspace(definition).withExtensions({
		persistence: (ctx) => {
			const provider = new IndexeddbPersistence('tab-manager', ctx.ydoc);
			return {
				whenSynced: provider.whenSynced,
				destroy: () => provider.destroy(),
			};
		},
		sync: (ctx) => websocketSync({ url: 'ws://localhost:3913/sync' }),
	});

	// ─────────────────────────────────────────────────────────────
	// Action Helpers
	// ─────────────────────────────────────────────────────────────
	const actions = createTabManagerActions(client, deviceIdPromise);

	// ─────────────────────────────────────────────────────────────
	// Initialization
	// ─────────────────────────────────────────────────────────────
	const initPromise = (async () => {
		await client.capabilities.persistence.whenSynced;
		await actions.refetchAll();
		console.log('[Background] Initial sync complete');
	})();

	// ... rest of event handlers unchanged, but use `actions.xxx` instead of `client.xxx`
});
```

## Risks and Mitigations

| Risk                                           | Mitigation                                                |
| ---------------------------------------------- | --------------------------------------------------------- |
| y-indexeddb incompatible with service workers  | Test early; fallback to chrome.storage.local if needed    |
| Stable ID causes Y.Doc collision with old data | Use unique ID like `'tab-manager-v2'` if migration needed |
| Breaking existing sync behavior                | Keep sync coordination logic unchanged                    |
| Type errors during refactor                    | Run `bun typecheck` after each phase                      |

## Testing Plan

1. **Phase 1 (Persistence)**:
   - [ ] Build succeeds with y-indexeddb
   - [ ] State persists across service worker restarts
   - [ ] State persists across browser restarts

2. **Phase 2-4 (API Migration)**:
   - [ ] `bun typecheck` passes
   - [ ] `bun build` succeeds
   - [ ] Manual test: tabs appear in popup
   - [ ] Manual test: WebSocket sync works (check console logs)
   - [ ] Manual test: Delete tab from CLI, verify browser tab closes

## Todo Checklist

- [ ] **Phase 1: Persistence (Critical)**
  - [ ] Install y-indexeddb
  - [ ] Create persistence capability
  - [ ] Test service worker restart recovery
- [ ] **Phase 2: Static Workspace API**
  - [ ] Change import to `@epicenter/hq/static`
  - [ ] Use stable workspace ID `'tab-manager'`
  - [ ] Remove `extensions` and `actions` from `defineWorkspace`
  - [ ] Use `createWorkspace().withExtensions()`
- [ ] **Phase 3: Extract Actions**
  - [ ] Create `createTabManagerActions()` factory
  - [ ] Update all action call sites
- [ ] **Phase 4: Initialization**
  - [ ] Wait for persistence before refetch
  - [ ] Update debug logging
- [ ] Run `bun typecheck` in apps/tab-manager
- [ ] Run `bun build` in apps/tab-manager
- [ ] Manual test the extension

## Future Considerations

### CLI Integration

With this architecture, a CLI tool can:

```bash
# List all tabs across devices
epicenter tabs list

# Close a specific tab
epicenter tabs close <device-id>_<tab-id>

# Open a URL on a specific device
epicenter tabs open --device laptop --url "https://example.com"
```

The CLI connects to the same sync server and manipulates the Y.Doc. The browser extension's observers detect the change and execute the corresponding Browser API call.

### Markdown Provider (Future)

If you want git-friendly tab history, you could add the markdown provider:

```typescript
const client = createWorkspace(definition).withExtensions({
	persistence: indexedDbPersistence,
	sync: websocketSync({ url: '...' }),
	markdown: markdownProvider({ directory: './tabs' }), // Tabs as markdown files
});
```

This would create markdown files for each tab, enabling version control of tab sessions.

## Review

_(To be completed after implementation)_
