# QuickAction ↔ Workspace Action Unification

**Date**: 2026-03-14
**Status**: Implemented
**Author**: AI-assisted

## Overview

Extract pure tab-analysis helpers from QuickActions so both the command palette and AI workspace actions can share the same logic. Trim QuickActions from 5 to 2 (dedup, groupByDomain) and expose dedup/groupByDomain as workspace actions with `destructive: true`.

## Motivation

### Current State

`quick-actions.ts` contains 5 actions with embedded logic that reads directly from `browserState`:

```typescript
// quick-actions.ts: logic is coupled to browserState
function findDuplicates(): Map<string, { tabId: TabCompositeId; title: string }[]> {
    for (const window of browserState.windows) {
        for (const tab of browserState.tabsByWindow(window.id)) {
            // ...normalize URL, group duplicates
        }
    }
}

const dedupAction: QuickAction = {
    execute() {
        const dupes = findDuplicates(); // reads browserState internally
        confirmationDialog.open({ ... });
    },
};
```

Workspace actions (`workspace.ts`) have atomic CRUD operations (`tabs.close`, `tabs.group`, `tabs.save`) but no high-level orchestrations like dedup or auto-grouping.

This creates problems:

1. **Logic duplication risk**: If workspace actions ever need dedup/grouping logic, it would be reimplemented
2. **Untestable helpers**: `findDuplicates` and `getUniqueDomains` are coupled to `browserState`: can't unit test without mocking the whole reactive store
3. **Low-value actions clutter the palette**: Sort, Save All, and Close by Domain are rarely useful

### Desired State

Pure helper functions that take a tab array and return analysis results. Both QuickActions and workspace actions feed their own data source into the same logic.

```
tab-helpers.ts (pure logic, zero dependencies)
    ├── quick-actions.ts    → feeds browserState tabs, shows confirmationDialog
    └── workspace.ts        → feeds tables.tabs, marks destructive: true
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Keep only dedup + groupByDomain | Drop sort, saveAll, closeByDomain | Sort destroys spatial context. SaveAll is a panic button. CloseByDomain's auto-pick heuristic is poor UX. |
| Extract helpers as pure functions | `tab-helpers.ts` in `$lib/utils/` | Makes logic testable, data-source agnostic |
| Expose `findDuplicates` as query | `tabs.findDuplicates` defineQuery | AI can inspect duplicates without acting |
| Expose `dedup` as mutation | `tabs.dedup` defineMutation, destructive | AI gets one-click dedup with built-in approval |
| Expose `groupByDomain` as mutation | `tabs.groupByDomain` defineMutation | AI gets auto-grouping without needing to compose domains.count → tabs.group |
| QuickActions keep their own confirmation | Don't call workspace action handlers | QuickActions use `confirmationDialog`; workspace actions use inline approval. Different UX patterns for different consumers. |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  $lib/utils/tab-helpers.ts                       │
│  ├── normalizeUrl(url) → string                  │
│  ├── findDuplicateGroups(tabs) → Map<url, tabs>  │
│  └── groupTabsByDomain(tabs) → Map<domain, tabs> │
└──────────────┬──────────────────┬────────────────┘
               │                  │
    ┌──────────▼───────┐  ┌──────▼──────────────┐
    │  quick-actions.ts │  │  workspace.ts       │
    │  (2 actions)      │  │  (.withActions)     │
    │                   │  │                     │
    │  Data: getAllTabs()│  │  Data: tables.tabs  │
    │  UX: confirmation │  │  UX: destructive    │
    │       Dialog      │  │       flag           │
    └───────────────────┘  └─────────────────────┘
```

## Implementation Plan

### Phase 1: Extract pure helpers

- [x] **1.1** Create `$lib/utils/tab-helpers.ts`
- [x] **1.2** Move `normalizeUrl` as-is (already pure)
- [x] **1.3** Extract `findDuplicateGroups<T>(tabs: T[])`: generic over any tab-like object with `id` and `url`
- [x] **1.4** Extract `groupTabsByDomain<T>(tabs: T[])`: generic, uses `getDomain` from existing utils

### Phase 2: Add workspace actions

- [x] **2.1** Add `tabs.findDuplicates` query to `.withActions()` in workspace.ts: calls `findDuplicateGroups(tables.tabs.getAllValid())`
- [x] **2.2** Add `tabs.dedup` mutation (destructive): finds duplicates, closes all but first per group
- [x] **2.3** Add `tabs.groupByDomain` mutation: groups all tabs by domain for domains with 2+ tabs

### Phase 3: Slim QuickActions

- [x] **3.1** Rewrite `dedupAction` to use `findDuplicateGroups` from tab-helpers
- [x] **3.2** Rewrite `groupByDomainAction` to use `groupTabsByDomain` from tab-helpers
- [x] **3.3** Remove `sortAction`, `saveAllAction`, `closeByDomainAction`
- [x] **3.4** Remove unused helpers from quick-actions.ts (`getAllTabs` kept as local, others removed)
- [x] **3.5** Remove unused imports (ArchiveIcon, ArrowDownAZIcon, GlobeIcon, savedTabState, getDomain)

### Phase 4: Verify

- [x] **4.1** LSP diagnostics clean on all changed files (pre-existing sync extension type error unrelated)
- [x] **4.2** No broken imports across tab-manager app
- [x] **4.3** CommandPalette still renders correctly (only 2 actions)

## Edge Cases

### Empty tab list

1. User has no open tabs (or all tabs lack URLs)
2. `findDuplicateGroups` returns empty Map
3. Both QuickAction and workspace action return early / return `{ duplicates: [] }`

### Single-tab domains

1. Every domain has exactly 1 tab
2. `groupTabsByDomain` returns all domains, but `groupByDomain` action filters to 2+ tabs
3. No Chrome tab groups created, action returns `{ groupedCount: 0 }`

### Cross-device tabs in workspace actions

1. Y.Doc has tabs from multiple devices
2. Workspace dedup/groupByDomain should scope to current device only (can only call Chrome APIs on local tabs)
3. Handler calls `getDeviceId()` and filters before passing to helpers

## Success Criteria

- [x] `tab-helpers.ts` contains 3 pure, exported functions with no imports from `$lib/state/`
- [x] Workspace actions `tabs.findDuplicates`, `tabs.dedup`, `tabs.groupByDomain` exist and are typed
- [x] `tabs.dedup` has `destructive: true`
- [x] QuickActions array has exactly 2 entries (dedup, groupByDomain)
- [x] No lint/type errors on changed files

## References

- `apps/tab-manager/src/lib/quick-actions.ts`: current QuickActions (will be slimmed)
- `apps/tab-manager/src/lib/workspace.ts`: workspace actions (will gain 3 new actions)
- `apps/tab-manager/src/lib/utils/format.ts`: existing `getDomain` helper
- `apps/tab-manager/src/lib/components/CommandPalette.svelte`: QuickAction consumer
- `packages/workspace/src/shared/actions.ts`: `defineQuery`/`defineMutation` API

## Review


**Completed**: 2026-03-14

### Summary

Extracted 3 pure tab-analysis helpers (`normalizeUrl`, `findDuplicateGroups`, `groupTabsByDomain`) into `$lib/utils/tab-helpers.ts`. Added 3 workspace actions (`tabs.findDuplicates` query, `tabs.dedup` destructive mutation, `tabs.groupByDomain` mutation) to `workspace.ts`. Trimmed QuickActions from 5 to 2 (dedup + groupByDomain), reducing `quick-actions.ts` from 296 to 138 lines.

### Deviations from Spec

- `getAllTabs` kept as a local helper in `quick-actions.ts` rather than moved to tab-helpers, since it reads from `browserState` (reactive Svelte state) and isn't pure
- Workspace actions use `tables.tabs.filter()` scoped to current device rather than `tables.tabs.getAllValid()`, matching the cross-device edge case requirement

### Files Changed

- `apps/tab-manager/src/lib/utils/tab-helpers.ts`: **new** (128 lines)
- `apps/tab-manager/src/lib/workspace.ts`: added import + 3 actions (967 → 1058 lines)
- `apps/tab-manager/src/lib/quick-actions.ts`: slimmed (296 → 138 lines)
