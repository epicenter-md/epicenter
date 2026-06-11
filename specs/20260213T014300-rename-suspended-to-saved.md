# Rename "Suspended" to "Saved" Terminology

**Date**: 2026-02-13
**Status**: Complete

## Overview

Rename all "suspend/suspended" terminology to "save/saved" across the tab manager app. The user-facing label becomes **"Save for later"** and the code/data model uses **"saved"**.

## Motivation

"Suspend" is the wrong term for what this feature does. In browser land, "suspend" means freezing a tab in place to save memory (like The Great Suspender): the tab stays in the tab bar but stops consuming resources. Our feature actually **closes the tab and persists it for later retrieval**, which is saving, not suspending.

Evidence: the current helper text already says _"Suspend tabs to save them for later"_: using a second phrase to explain what the first word means. If the verb needs explaining, it's the wrong verb.

"Save for later" is universally understood (Slack uses this exact phrase), requires zero learning curve, and works for both developer and non-developer audiences.

## Terminology Mapping

| Before (Suspended)                    | After (Saved)                          | Where                         |
| ------------------------------------- | -------------------------------------- | ----------------------------- |
| "Suspended Tabs"                      | "Saved Tabs"                           | Section header                |
| "No suspended tabs"                   | "No saved tabs"                        | Empty state                   |
| "Suspend tabs to save them for later" | "Save tabs to come back to them later" | Empty state helper            |
| "Suspend" (tooltip)                   | "Save for later" (tooltip)             | TabItem action button         |
| "Error loading suspended tabs"        | "Error loading saved tabs"             | Error state                   |
| "Restore"                             | "Restore"                              | **No change**: still correct |
| "Delete"                              | "Delete"                               | **No change**                 |
| "Restore All"                         | "Restore All"                          | **No change**                 |
| "Delete All"                          | "Delete All"                           | **No change**                 |

## Code Rename Mapping

### Types & Schema (`browser.schema.ts`)

| Before                         | After                      |
| ------------------------------ | -------------------------- | ------------- |
| `SuspendedTab` (type)          | `SavedTab`                 |
| `suspendedTabs` (table const)  | `savedTabs`                |
| `BROWSER_TABLES.suspendedTabs` | `BROWSER_TABLES.savedTabs` |
| `suspendedAt` (field)          | `savedAt`                  |
| `sourceDeviceId` (field)       | `sourceDeviceId`           | **No change** |
| JSDoc: "Suspended tabs table"  | "Saved tabs table"         |

### Helpers (`suspend-tab.ts` -> `save-tab.ts`)

| Before                          | After               |
| ------------------------------- | ------------------- | ------------- |
| File: `suspend-tab.ts`          | File: `save-tab.ts` |
| `suspendTab()`                  | `saveTab()`         |
| `restoreTab()`                  | `restoreTab()`      | **No change** |
| `deleteSuspendedTab()`          | `deleteSavedTab()`  |
| `updateSuspendedTab()`          | `updateSavedTab()`  |
| All JSDoc referencing "suspend" | Updated to "save"   |

### Query Layer (`suspended-tabs.ts` -> `saved-tabs.ts`)

| Before                                             | After                                  |
| -------------------------------------------------- | -------------------------------------- |
| File: `suspended-tabs.ts`                          | File: `saved-tabs.ts`                  |
| `suspendedTabsKeys`                                | `savedTabsKeys`                        |
| `suspendedTabsKeys.all` = `['suspended-tabs']`     | `savedTabsKeys.all` = `['saved-tabs']` |
| `SuspendedTabsErr` / `'SuspendedTabsError'`        | `SavedTabsErr` / `'SavedTabsError'`    |
| `suspendedTabs` (export)                           | `savedTabs`                            |
| `suspendedTabs.suspend` mutation                   | `savedTabs.save`                       |
| Mutation key `['suspended-tabs', 'suspend']`       | `['saved-tabs', 'save']`               |
| All other mutation keys: `'suspended-tabs'` prefix | `'saved-tabs'` prefix                  |
| Error messages: "Failed to suspend tab"            | "Failed to save tab"                   |

### Component (`SuspendedTabList.svelte` -> `SavedTabList.svelte`)

| Before                          | After                       |
| ------------------------------- | --------------------------- |
| File: `SuspendedTabList.svelte` | File: `SavedTabList.svelte` |
| Imports from `suspended-tabs`   | Imports from `saved-tabs`   |
| `type SuspendedTab`             | `type SavedTab`             |
| `suspendedTabs.getAll`          | `savedTabs.getAll`          |
| `suspendedTabs.restore`         | `savedTabs.restore`         |
| `suspendedTabs.remove`          | `savedTabs.remove`          |
| `suspendedTabs.restoreAll`      | `savedTabs.restoreAll`      |
| `suspendedTabs.removeAll`       | `savedTabs.removeAll`       |
| `suspendedTabsKeys`             | `savedTabsKeys`             |
| `tab.suspendedAt`               | `tab.savedAt`               |

### TabItem (`TabItem.svelte`)

| Before                  | After                                          |
| ----------------------- | ---------------------------------------------- |
| `suspendMutation`       | `saveMutation`                                 |
| `suspendedTabs.suspend` | `savedTabs.save`                               |
| `suspendedTabsKeys`     | `savedTabsKeys`                                |
| `tooltip="Suspend"`     | `tooltip="Save for later"`                     |
| `PauseIcon`             | Consider `BookmarkIcon` or `ArchiveIcon`: TBD |

### Other Files

| File                         | Change                                               |
| ---------------------------- | ---------------------------------------------------- |
| `App.svelte`                 | Import `SavedTabList` instead of `SuspendedTabList`  |
| `lib/epicenter/index.ts`     | Export `SavedTab` instead of `SuspendedTab`          |
| `lib/epicenter/workspace.ts` | Update JSDoc referencing `suspendedTabs`             |
| `lib/query/index.ts`         | Import/export `savedTabs` instead of `suspendedTabs` |

## Icon Change

Current: `PauseIcon` (pause symbol, fits "suspend" metaphor)

Options for "save":

- `BookmarkIcon`: universally means "save for later", strong precedent
- `ArchiveIcon` (box with arrow): feels too permanent
- `InboxIcon`: implies a queue/inbox metaphor
- `SaveIcon` (floppy disk): dated, means "save file" not "save for later"

**Recommendation**: `BookmarkIcon`: it's the standard "save for later" icon across Slack, browsers, and mobile apps.

## Data Migration

**Breaking change accepted.** The Yjs table key is derived from the JS object key name via `TableKey(name)` → `table:{name}`. Field names are also Y.Map keys. Renaming `suspendedTabs` → `savedTabs` and `suspendedAt` → `savedAt` will orphan existing data (new empty table created). This was accepted as a breaking change: existing saved tabs will not carry over.

## Implementation Plan

- [x] **1. Verify data migration**: `defineTable` uses object key name as Y.Doc key. Breaking change accepted.
- [x] **2. Schema rename**: `workspace.ts`: `suspendedTabs` → `savedTabs`, `suspendedAt` → `savedAt`, type `SavedTab`, JSDoc updated
- [x] **3. State file rename**: `suspended-tab-state.svelte.ts` → `saved-tab-state.svelte.ts`, all functions/exports renamed
- [x] **4. SavedTabList component**: `SuspendedTabList.svelte` → `SavedTabList.svelte`, updated all imports, labels, icon
- [x] **5. TabItem component**: Tooltip → "Save for later", icon → `BookmarkIcon`, action → `savedTabState.actions.save()`
- [x] **6. Remaining imports**: `App.svelte`, `workspace-popup.ts` JSDoc updated
- [x] **7. Verify**: Zero stale "suspend" references in code (except unrelated WebSocket comment in background.ts)

## Edge Cases

### Yjs Table Key (Breaking Change)

The table key in Y.Doc IS derived from the variable name (`table:suspendedTabs`). Renaming to `savedTabs` creates `table:savedTabs`: a new empty table. Existing saved tabs in the old key are orphaned. This was accepted as a breaking change since the feature is new and has minimal user data.

## Success Criteria

- [x] Zero references to "suspend" terminology in user-facing text
- [x] Zero references to `suspended`/`Suspended`/`suspend` in code (except the background.ts WebSocket comment which is unrelated)
- [x] Icon changed from `PauseIcon` to `BookmarkIcon`

## Review

All "suspend/suspended" terminology renamed to "save/saved" across the tab manager app:

| File | Change |
|------|--------|
| `workspace.ts` | Table key `suspendedTabs` → `savedTabs`, field `suspendedAt` → `savedAt`, type `SavedTab` |
| `saved-tab-state.svelte.ts` | New file (was `suspended-tab-state.svelte.ts`). All table refs + field refs updated. |
| `SavedTabList.svelte` | New file (was `SuspendedTabList.svelte`). UI strings + icon updated. |
| `TabItem.svelte` | Tooltip "Save for later", `BookmarkIcon`, `savedTabState.actions.save()` |
| `App.svelte` | Import `SavedTabList` |
| `workspace-popup.ts` | JSDoc updated |

### Docs & Specs Updated

Added terminology rename notes to all historical specs and docs that reference "suspended":

| File | Type |
|------|------|
| `specs/20260213T003200-suspended-tabs.md` | Note added, status → "Complete (terminology renamed)" |
| `specs/20260213T103000-request-dispatch.md` | Note added |
| `specs/20260212T132200-events-based-tab-management.md` | Note added |
| `specs/20260213T015500-popup-reactive-state.md` | Note added |
| `specs/20260213T105705-tab-manager-src-reorganization.md` | Note added |
| `specs/20260213T012108-browser-schema-camelcase-cleanup.md` | Note added |
| `docs/articles/migrating-tanstack-query-to-svelte-state-and-observers.md` | Note added |
| `docs/articles/when-tanstack-query-is-the-wrong-abstraction.md` | Note added |
| `docs/articles/types-should-be-computed-not-declared.md` | Note added |
| `packages/epicenter/docs/architecture/action-dispatch.md` | Note added |

Done in three commits:
1. `refactor(tab-manager): rename "suspended" to "saved" terminology`: user-facing + types + files (kept Y.Doc keys)
2. `refactor(tab-manager)!: rename Y.Doc keys from suspended to saved`: breaking rename of storage keys
3. `docs: add terminology rename notes to specs and articles`: notes on all historical docs
