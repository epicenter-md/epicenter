# Migration Dialog Cleanup

**Date**: 2026-03-14
**Status**: Implemented
**Author**: AI-assisted

## Overview

Consolidate the migration dialog's state into a single source of truth, remove `$state` that doesn't earn its reactivity, and absorb the split toast lifecycle. No file renames: `migration-dialog.svelte.ts` and `migrationDialog` stay as-is.

## Motivation

### Current State

The migration system spans four files with state scattered between them:

```
migration-dialog.svelte.ts   → 10 $state variables, factory function, module singleton
check-database-migration.ts  → orchestration, creates toast, pokes dialog state
migrate-database.ts           → pure migration logic (no state, fine as-is)
MigrationDialog.svelte        → UI shell (thin consumer, fine as-is)
```

The reactive state in `migration-dialog.svelte.ts`:

```typescript
let isOpen = $state(false);
let isRunning = $state(false);
let isPending = $state(getDatabaseMigrationState() === 'pending');
let isSeeding = $state(false);      // dev-only
let isClearing = $state(false);     // dev-only
let isResetting = $state(false);    // dev-only
let logs = $state<string[]>([]);
let migrationResult = $state<MigrationResult | null>(null);
let hasFailedAttempt = $state(false);
let migrationToastId = $state<string | undefined>(undefined);
```

This creates problems:

1. **`isPending` is double-sourced**: initialized from `getDatabaseMigrationState()` (localStorage), then set imperatively from `check-database-migration.ts`, `openDialog()`, `startWorkspaceMigration()`, and `resetMigration()`. localStorage and the `$state` can diverge if any write path is missed.
2. **`migrationToastId` is `$state` but never read reactively**: no template reads this value. It's used imperatively. Created in `check-database-migration.ts`, dismissed in `startWorkspaceMigration()`. A plain `let` works.
3. **Toast lifecycle is split across files**: `check-database-migration.ts` creates the toast and assigns the ID; `migration-dialog.svelte.ts` dismisses it. Neither file owns the full lifecycle.
4. **Dev tools inflate production surface**: `isSeeding`, `isClearing`, `isResetting`, `seedIndexedDB()`, `clearIndexedDB()`, `resetMigration()`: six members only used behind `import.meta.env.DEV`: are interleaved with production state.
5. **Test data is eagerly created**: `const testData = createMigrationTestData()` runs at module load even in production builds.

### Desired State

The migration dialog module owns the lifecycle end-to-end. `isPending` has a single source of truth. Toast creation and dismissal live in the same place. No `$state` exists unless a template reads it.

## Research Findings

### Svelte 5 `.svelte.ts` Patterns in This Codebase

| Module | Pattern | State mechanism |
|---|---|---|
| `device-config.svelte.ts` | Factory → SvelteMap | `SvelteMap` for granular key-value reactivity |
| `workspace-settings.svelte.ts` | Factory → SvelteMap | `SvelteMap` for granular key-value reactivity |
| `NotificationLog.svelte` | IIFE in `<script module>` | Raw `$state` with getter/setter |
| `migration-dialog.svelte.ts` | Factory in separate file | Raw `$state` with getter/setter |

**Key finding**: The SvelteMap pattern is used for key-value stores that need per-key reactivity. The raw `$state` + getter/setter pattern is used for imperative UI state (dialogs, logs, toggles). The migration dialog correctly uses Pattern B. It's not a key-value store.

**Implication**: No pattern change needed. The factory-with-raw-`$state` approach is right for this use case. The issues are about *which* variables are `$state` and *who owns* state transitions, not the Svelte pattern itself.

### State Ownership Patterns

The `device-config` module demonstrates the correct approach: all writes to localStorage go through `set()`, which updates both the persistent store and the `SvelteMap` in one call. The migration module should follow this. All writes to the `whispering:db-migration` localStorage key should go through a single function that updates both localStorage and the `$state`.

### `check-database-migration.ts` State Machine

The JSDoc in `check-database-migration.ts` documents the state machine well:

```
(absent) → probe old data → found? set 'pending' : set 'done'
'pending' → show toast with "Migrate" button
'done'    → skip
```

But the transitions are split across two files. The check function sets `isPending` and creates the toast; the dialog transitions through `isRunning → result → done` and dismisses the toast. This split makes the full state machine harder to reason about.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Keep one file vs split flow/dev | One file, comment boundaries | Three dev methods don't justify a second module. Comment sections are enough. |
| `isPending` source of truth | Derive from internal `persistedState` | All writes go through one function that updates both localStorage and `$state`. No external setter. |
| `migrationToastId` | Plain `let`, not `$state` | Never read by a template. Pure coordination variable. |
| Toast lifecycle ownership | Dialog module owns both create and dismiss | `showPendingToast()` and dismiss-on-success live in the same module. |
| Absorb `check-database-migration.ts` | Yes, as a `check()` method on the dialog | The check logic is part of the migration lifecycle. Keeps the state machine in one place. |
| Keep filename `migration-dialog.svelte.ts` | Yes | It IS a dialog. The toast is just a doorbell that opens it. Renaming 5 files for a naming preference is churn, not value. |
| Dev tools guard for test data | Lazy `import()` behind `import.meta.env.DEV` | Prevents `createMigrationTestData()` from running at module load in production. |
| `hasFailedAttempt` vs derive from logs | Keep explicit flag | Deriving from log contents (`❌`) is fragile. An explicit boolean is clearer. |

## Architecture

```
BEFORE:
┌──────────────────────────────┐     ┌───────────────────────────────────┐
│ check-database-migration.ts  │────▶│ migration-dialog.svelte.ts        │
│ • probes for old data        │     │ • 10 $state vars                  │
│ • creates toast              │     │ • startWorkspaceMigration()       │
│ • sets isPending             │     │ • dismisses toast                 │
│ • stores toastId on dialog   │     │ • dev tools (seed, clear, reset)  │
└──────────────────────────────┘     └───────────────────────────────────┘
         ▲ state writes go both ways ▲

AFTER:
┌───────────────────────────────────────────────────────────┐
│ migration-dialog.svelte.ts                                │
│                                                           │
│ ── Persisted state ──────────────────────────────────     │
│ persistedState: $state   ◄── single source of truth       │
│ isPending: getter         (derived from persistedState)   │
│                                                           │
│ ── Session state ────────────────────────────────────     │
│ isOpen: $state            (bind:open on Dialog.Root)      │
│ logs: $state              (auto-scrolling log viewer)     │
│ result: $state            (results summary)               │
│ hasFailedAttempt: $state  (retry button label latch)      │
│ phase: $state             (idle|running|completed|failed) │
│                                                           │
│ ── Coordination (NOT $state) ────────────────────────     │
│ toastId: let              (toast create/dismiss)          │
│                                                           │
│ ── Actions ──────────────────────────────────────────     │
│ check()                   (probe + toast, called at boot) │
│ startMigration()          (run + dismiss toast on success)│
│                                                           │
│ ── Dev tools (import.meta.env.DEV) ──────────────────     │
│ isSeeding, isClearing, isResetting: $state                │
│ seedIndexedDB(), clearIndexedDB(), resetMigration()       │
│ testData: lazy import()                                   │
└───────────────────────────────────────────────────────────┘
         │
         ▼ consumed by
┌────────────────────────────────────────────┐
│ MigrationDialog.svelte  (thin UI shell)    │
│ NavItems.svelte         (nav badge)        │
│ VerticalNav.svelte      (sidebar badge)    │
└────────────────────────────────────────────┘

check-database-migration.ts → thin one-liner wrapper calling migrationDialog.check()
```

### State transition flow

```
BOOT
─────
check() called from layout (via thin wrapper in check-database-migration.ts)

  ┌─ persistedState === 'done' → return (no-op)
  │
  ├─ persistedState === null → probeForOldData()
  │   ├─ no data → setPersistedState('done'), return
  │   └─ has data → setPersistedState('pending')
  │
  └─ persistedState === 'pending' → showPendingToast()


USER CLICKS "MIGRATE NOW" (toast button)
──────────────────────────────────────────
isOpen = true → Dialog.Root opens


USER CLICKS "START MIGRATION" (dialog button)
───────────────────────────────────────────────
startMigration()
  phase: idle → running
  logs: cleared
  result: cleared

  migrateDatabaseToWorkspace() runs with onProgress → addLog()

  on success:
    result = migrationOutcome
    setPersistedState('done')    ← updates localStorage + $state
    phase: running → completed
    dismiss toast (if exists)

  on failure:
    hasFailedAttempt = true
    phase: running → failed
    toast remains (user can retry)
```

## Implementation Plan

### Phase 1: Single source of truth for `isPending` and demote `migrationToastId`

> No file renames. No import path changes. Just internal state cleanup.

- [x] **1.1** Replace `isPending` `$state` + getter/setter with a `persistedState` `$state` and a derived getter:
  ```typescript
  let persistedState = $state(getDatabaseMigrationState());

  function setPersistedState(state: DbMigrationState) {
    setDatabaseMigrationState(state);  // writes localStorage
    persistedState = state;            // updates $state
  }

  // In return object:
  get isPending() { return persistedState === 'pending'; }
  // No setter: all transitions go through setPersistedState()
  ```
- [x] **1.2** Demote `migrationToastId` from `$state` to plain `let`.
- [x] **1.3** Replace all direct `setDatabaseMigrationState()` calls inside the factory with `setPersistedState()`. Remove the `isPending` setter from the public API.

### Phase 2: Absorb toast lifecycle and check logic

- [x] **2.1** Move toast creation from `check-database-migration.ts` into a `showPendingToast()` method on the dialog (private. Not exported on the return object).
- [x] **2.2** Move the probe logic from `check-database-migration.ts` into a `check()` method on the dialog.
- [x] **2.3** Simplify `check-database-migration.ts` to a one-liner:
  ```typescript
  import { migrationDialog } from '$lib/migration/migration-dialog.svelte';
  export async function checkDatabaseMigration() { return migrationDialog.check(); }
  ```
- [x] **2.4** Remove the `migrationToastId` setter from the public API (toast dismiss is now internal).

### Phase 3: Replace `isRunning` with `phase`

- [x] **3.1** Replace `isRunning` `$state(false)` with `phase: $state<'idle' | 'running' | 'completed' | 'failed'>('idle')`.
- [x] **3.2** Update `MigrationDialog.svelte` to use `phase` instead of `isRunning`:
  - `migrationDialog.phase === 'running'` for disabled state
  - Button label: `phase === 'running'` → 'Migrating…', `hasFailedAttempt` → 'Retry Migration', else → 'Start Migration'
- [x] **3.3** Keep `hasFailedAttempt` as a latch (set on first failure, cleared only by `resetMigration()`). Different semantics from `phase`: "has ever failed this session" vs "is currently failed."

### Phase 4: Dev tools cleanup

- [x] **4.1** Add clear comment boundary: `// ── Dev tools (import.meta.env.DEV only) ──`
- [x] **4.2** Lazy-load test data:
  ```typescript
  // Before (runs in production):
  const testData = createMigrationTestData();

  // After (only in dev):
  async seedIndexedDB() {
    const { createMigrationTestData, MOCK_RECORDING_COUNT, MOCK_TRANSFORMATION_COUNT } =
      await import('./migration-test-data');
    const testData = createMigrationTestData();
    // ...
  }
  ```
- [x] **4.3** Group dev state together at the bottom of the closure, clearly separated from production state.
- [x] **4.4** Remove the top-level `import` of `createMigrationTestData` and `MOCK_RECORDING_COUNT`/`MOCK_TRANSFORMATION_COUNT` from the module (they move into the dynamic import). Note: `MOCK_RECORDING_COUNT` and `MOCK_TRANSFORMATION_COUNT` are still needed in `MigrationDialog.svelte` for the dev UI button labels. That import stays.

### Phase 5: Update `MigrationDialog.svelte` for new property names

- [x] **5.1** Update any renamed properties (e.g., `startWorkspaceMigration` → `startMigration` if renamed, `isRunning` → `phase`, etc.).
- [x] **5.2** Verify the layout still calls `checkDatabaseMigration()` (the thin wrapper): no change needed there.

## Edge Cases

### Page refresh during migration

1. User starts migration, migration is running (`phase === 'running'`)
2. User refreshes the page
3. `persistedState` is still `'pending'` (only set to `'done'` on success)
4. `check()` runs again, shows toast again. Correct behavior

### Multiple tabs

1. User opens two tabs
2. Tab A runs migration successfully, sets localStorage to `'done'`
3. Tab B still shows toast with `'pending'`
4. Tab B won't detect the change because there's no `storage` event listener on this key
5. If Tab B clicks "Migrate Now" and runs migration, it will skip already-migrated records (idempotent): correct behavior, if slightly redundant

### Dev tools: reset then immediately migrate

1. Developer clicks "Reset Migration State"
2. `persistedState` set to `'pending'`, workspace tables cleared
3. Developer clicks "Start Migration"
4. Migration runs on whatever data exists in IndexedDB
5. This is intentional dev workflow. Works correctly

## Open Questions

1. **Should `check-database-migration.ts` be deleted or kept as a thin wrapper?**
   - **Decision**: Keep the wrapper. The layout calls `checkDatabaseMigration()` alongside other check functions (`checkFfmpeg`, etc.). A named function reads better in that list.

2. **Should `phase` replace both `isRunning` AND `hasFailedAttempt`?**
   - `phase === 'running'` replaces `isRunning` cleanly
   - `phase === 'failed'` almost replaces `hasFailedAttempt`, but after retry starts, `phase` goes back to `'running'`. "Has ever failed" and "is currently failed" are different semantics.
   - **Decision**: Use `phase` for current state, keep `hasFailedAttempt` as a latch (set on first failure, cleared by `resetMigration()` only).

3. **Should dev tools be extracted to a separate file?**
   - **Decision**: No. Three methods + three states is small. Keep in one file with comment boundaries.

## Success Criteria

- [x] `isPending` has one source of truth: `persistedState` `$state` synced with localStorage via `setPersistedState()`
- [x] `migrationToastId` is a plain `let`, not `$state`
- [x] Toast creation and dismissal both live in `migration-dialog.svelte.ts`
- [x] `createMigrationTestData()` does not execute at module load in production
- [x] No functional behavior changes. Migration still works identically from the user's perspective
- [x] Filename stays `migration-dialog.svelte.ts`, export stays `migrationDialog`
- [x] `lsp_diagnostics` clean on all changed files
- [x] Build passes (7 pre-existing errors in unrelated packages, zero in migration files)

## References

- `apps/whispering/src/lib/migration/migration-dialog.svelte.ts`: primary refactor target (filename unchanged)
- `apps/whispering/src/routes/(app)/_layout-utils/check-database-migration.ts`: simplified to one-liner wrapper
- `apps/whispering/src/lib/migration/MigrationDialog.svelte`: UI consumer, property name updates only
- `apps/whispering/src/lib/migration/migrate-database.ts`: pure logic, unchanged
- `apps/whispering/src/lib/migration/migration-test-data.ts`: lazy-loaded in dev
- `apps/whispering/src/lib/state/device-config.svelte.ts`: reference pattern for persisted state sync

## Review

### Changes Made

Five waves of incremental commits, each verified with `lsp_diagnostics` and `svelte-check`:

1. **Single source of truth**: Replaced `isPending` `$state` + external setter with `persistedState` `$state` derived from localStorage. All writes go through `setPersistedState()` which atomically syncs both localStorage and reactive state. Demoted `migrationToastId` from `$state` to plain `let`.

2. **Absorb toast lifecycle**: Moved toast creation (`showPendingToast`) and data probe (`check`) from `check-database-migration.ts` into the dialog factory. The wrapper file is now a one-liner. Removed `isPending` setter and `migrationToastId` getter/setter from public API.

3. **Phase state machine**: Replaced `isRunning` boolean with `phase: 'idle' | 'running' | 'completed' | 'failed'`. Updated `MigrationDialog.svelte` to use `phase` for disabled state and button labels. Kept `hasFailedAttempt` as a separate latch.

4. **Dev tools cleanup**: Lazy-loaded test data via `dynamic import()` in `seedIndexedDB`/`clearIndexedDB`. Removed eagerly-executed `createMigrationTestData()` from module scope. Grouped dev state at bottom of closure with comment boundary.

5. **Final verification**: Confirmed all consumers compile clean. Layout still calls thin wrapper. Full `svelte-check` shows zero new errors.

### What Didn't Change

- `migrate-database.ts`: pure migration logic, untouched (only added `export` to `DbMigrationState` type)
- `migration-test-data.ts`: untouched
- `MigrationDialog.svelte`: only `isRunning` → `phase` in two lines
- No file renames, no import path changes for consumers
