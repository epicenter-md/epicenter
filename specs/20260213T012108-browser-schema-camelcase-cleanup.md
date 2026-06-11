# Browser Schema camelCase Cleanup

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. See `specs/20260213T014300-rename-suspended-to-saved.md`.

## Goal

Refactor `browser.schema.ts` and all consumers in `apps/tab-manager/` to use camelCase field names and table keys. Remove unused constants. Simplify where possible.

**Data migration**: Nuke existing IndexedDB data. No versioned migration needed.

## Changes

### 1. `browser.schema.ts`: Schema source of truth

**Table key renames** (in `BROWSER_TABLES` export object):

- `tab_groups` → `tabGroups`
- `suspended_tabs` → `suspendedTabs`
- `devices`, `tabs`, `windows`: already camelCase, no change

**Field renames** (snake_case → camelCase):

| Table          | Old Field          | New Field         |
| -------------- | ------------------ | ----------------- |
| devices        | `last_seen`        | `lastSeen`        |
| tabs           | `device_id`        | `deviceId`        |
| tabs           | `tab_id`           | `tabId`           |
| tabs           | `window_id`        | `windowId`        |
| tabs           | `fav_icon_url?`    | `favIconUrl?`     |
| tabs           | `auto_discardable` | `autoDiscardable` |
| tabs           | `group_id?`        | `groupId?`        |
| tabs           | `opener_tab_id?`   | `openerTabId?`    |
| windows        | `device_id`        | `deviceId`        |
| windows        | `window_id`        | `windowId`        |
| windows        | `always_on_top`    | `alwaysOnTop`     |
| tab_groups     | `device_id`        | `deviceId`        |
| tab_groups     | `group_id`         | `groupId`         |
| tab_groups     | `window_id`        | `windowId`        |
| suspended_tabs | `fav_icon_url?`    | `favIconUrl?`     |
| suspended_tabs | `source_device_id` | `sourceDeviceId`  |
| suspended_tabs | `suspended_at`     | `suspendedAt`     |

**Remove unused constants**: `WINDOW_STATES`, `WINDOW_TYPES`, `TAB_STATUS`, `TAB_GROUP_COLORS`

**Update type exports**: `BrowserTables` type stays, individual row types stay (`Device`, `Tab`, `Window`, `TabGroup`, `SuspendedTab`): field shapes change automatically via `InferTableRow`.

### 2. `browser-helpers.ts`: Row converters

Update `tabToRow()`, `windowToRow()`, `tabGroupToRow()` return object keys from snake_case to camelCase. The Chrome API input side stays the same (Chrome uses its own naming).

### 3. `schema.ts`: Re-exports

Minimal: just re-exports `BROWSER_TABLES`. No changes needed unless we rename the export itself (we won't).

Update `BrowserDb` type: table access changes from `tables.suspended_tabs` to `tables.suspendedTabs` etc.

### 4. `index.ts`: Public type re-exports

No changes needed. Type names stay the same, field shapes change automatically.

### 5. `suspend-tab.ts`: Suspend/restore helpers

Update all field accesses:

- `tab.fav_icon_url` → `tab.favIconUrl`
- `tab.tab_id` → `tab.tabId`
- `tables.suspended_tabs` → `tables.suspendedTabs`
- `source_device_id` → `sourceDeviceId`
- `suspended_at` → `suspendedAt`
- `fav_icon_url` → `favIconUrl`

### 6. `background.ts`: Background service worker (biggest file, ~930 lines)

Table accessor renames:

- `tables.tab_groups` → `tables.tabGroups`
- `tables.suspended_tabs` → `tables.suspendedTabs` (if referenced)
- `client.tables.tab_groups.observe` → `client.tables.tabGroups.observe`

Field access renames throughout:

- `existing.device_id` → `existing.deviceId`
- `existing.tab_id` → `existing.tabId`
- `existing.window_id` → `existing.windowId`
- `row.device_id` → `row.deviceId`
- `row.tab_id` → `row.tabId`
- `row.window_id` → `row.windowId`
- `last_seen` → `lastSeen`

Also: the debug `ytables.get('tabs')` string reference on line ~319 stays as-is (that's a Y.Doc internal key, not a schema field).

### 7. `query/suspended-tabs.ts`: Suspended tab queries

- `popupWorkspace.tables.suspended_tabs` → `popupWorkspace.tables.suspendedTabs`
- `b.suspended_at` → `b.suspendedAt`

### 8. `query/tabs.ts`: Tab queries

No table access changes (reads from Chrome APIs directly). The `tabToRow` / `windowToRow` / `tabGroupToRow` calls produce new camelCase field shapes, but the query layer just returns them.

### 9. Svelte components

**`TabItem.svelte`**:

- `tab.fav_icon_url` → `tab.favIconUrl`
- `tab.tab_id` → `tab.tabId`

**`TabList.svelte`**:

- `t.window_id` → `t.windowId`

**`SuspendedTabList.svelte`**:

- `tab.fav_icon_url` → `tab.favIconUrl`
- `tab.suspended_at` → `tab.suspendedAt`

## TODO

- [x] Update `browser.schema.ts`: camelCase fields, camelCase table keys, remove unused constants
- [x] Update `browser-helpers.ts`: camelCase return object keys
- [x] Update `schema.ts`: if needed for table key renames
- [x] Update `suspend-tab.ts`: camelCase field accesses and table accessors
- [x] Update `background.ts`: camelCase table accessors and field accesses
- [x] Update `query/suspended-tabs.ts`: camelCase table accessor and field accesses
- [x] Update `TabItem.svelte`: camelCase field accesses
- [x] Update `TabList.svelte`: camelCase field accesses
- [x] Update `SuspendedTabList.svelte`: camelCase field accesses
- [x] Run type check to verify no field name mismatches remain

## Review

All spec items completed. Changes across 9 files:

- **browser.schema.ts**: Removed 4 unused constants (`WINDOW_STATES`, `WINDOW_TYPES`, `TAB_STATUS`, `TAB_GROUP_COLORS`). Renamed all snake_case fields to camelCase. Renamed table keys `tab_groups` → `tabGroups`, `suspended_tabs` → `suspendedTabs`. Renamed local variables to match (`tab_groups` → `tabGroups`, `suspended_tabs` → `suspendedTabs`).
- **browser-helpers.ts**: Updated all return object keys in `tabToRow`, `windowToRow`, `tabGroupToRow`.
- **suspend-tab.ts**: Updated table accessor (`tables.suspendedTabs`) and all field accesses (`favIconUrl`, `tabId`, `sourceDeviceId`, `suspendedAt`). Updated JSDoc comments.
- **background.ts**: Updated all `tables.tabGroups` accessors, all field accesses (`deviceId`, `tabId`, `windowId`, `groupId`, `lastSeen`), and JSDoc comments.
- **query/suspended-tabs.ts**: Updated `popupWorkspace.tables.suspendedTabs` and `suspendedAt` sort.
- **workspace.ts**: Updated JSDoc comments only.
- **TabItem.svelte**: `tab.fav_icon_url` → `tab.favIconUrl`, `tab.tab_id` → `tab.tabId`.
- **TabList.svelte**: `t.window_id` → `t.windowId`.
- **SuspendedTabList.svelte**: `tab.fav_icon_url` → `tab.favIconUrl`, `tab.suspended_at` → `tab.suspendedAt`.

**Type check**: 9 pre-existing errors (all `Browser.tabs.Tab` intersection type mismatches), zero new errors introduced.
