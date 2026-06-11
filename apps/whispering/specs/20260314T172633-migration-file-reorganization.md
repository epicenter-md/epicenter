# Migration File Reorganization

**Status**: Implemented
**Type**: Refactor (zero behavior change)

## Problem

Migration logic is spread across 4 directories (`state/`, `components/`, `routes/_layout-utils/`) with mixed concerns:

- `state/migrate-database.ts` and `state/migrate-settings.ts` are plain async functions, not reactive singletons: violates the `state/` README contract
- `MigrationDialog.svelte`'s `<script module>` contains 150 lines of orchestration state + test data factories: not just UI
- `migrationDialog` singleton is imported from a `.svelte` file by 3 external consumers, coupling state access to component import
- `check-indexeddb-migration.ts` names an implementation detail ("IndexedDB"), not intent

## Proposed Structure

```
src/lib/migration/                          NEW feature directory
├── migrate-database.ts                     moved from state/ (unchanged)
├── migrate-settings.ts                     moved from state/ (unchanged)
├── migration-dialog.svelte.ts              extracted from MigrationDialog.svelte <script module>
├── migration-test-data.ts                  extracted from MigrationDialog.svelte <script module>
└── MigrationDialog.svelte                  moved from components/ (thin UI shell)

src/routes/(app)/_layout-utils/
└── check-database-migration.ts             renamed from check-indexeddb-migration.ts
```

## Dependency Graph (Pre-Refactor)

```
+layout.svelte ──────────────────► state/migrate-settings.ts
AppLayout.svelte ──(relative)───► _layout-utils/check-indexeddb-migration.ts
                                    ├─► state/migrate-database.ts
                                    └─► components/MigrationDialog.svelte (migrationDialog)
VerticalNav.svelte ─────────────► components/MigrationDialog.svelte (component + migrationDialog)
NavItems.svelte ────────────────► components/MigrationDialog.svelte (component + migrationDialog)
MigrationDialog.svelte ─────────► state/migrate-database.ts
```

## Implementation Plan

### Wave 1: Create directory + move pure files
- [x] **1.1** Create `src/lib/migration/` directory
- [x] **1.2** Move `state/migrate-database.ts` → `migration/migrate-database.ts` (no content changes)
- [x] **1.3** Move `state/migrate-settings.ts` → `migration/migrate-settings.ts` (no content changes)

### Wave 2: Extract state and test data from MigrationDialog.svelte
- [x] **2.1** Create `migration/migration-test-data.ts`: extract `createMigrationTestData()`, `createMockRecording()`, constants, and their imports
- [x] **2.2** Create `migration/migration-dialog.svelte.ts`: extract `createMigrationDialog()`, `$state` runes, singleton. Import test data from `./migration-test-data`
- [x] **2.3** Rewrite `MigrationDialog.svelte` as thin UI shell → move to `migration/MigrationDialog.svelte`. Remove `<script module>`. Import from extracted files.

### Wave 3: Rename route file + update all consumer imports
- [x] **3.1** Rename `check-indexeddb-migration.ts` → `check-database-migration.ts`
- [x] **3.2** Update `check-database-migration.ts` imports: `$lib/migration/migrate-database`, `$lib/migration/migration-dialog.svelte`
- [x] **3.3** Update `+layout.svelte`: `$lib/migration/migrate-settings`
- [x] **3.4** Update `VerticalNav.svelte`: split into component import + state import from `$lib/migration/`
- [x] **3.5** Update `NavItems.svelte`: same split as VerticalNav
- [x] **3.6** Update `AppLayout.svelte`: relative path `../_layout-utils/check-database-migration`

### Wave 4: Verify
- [x] **4.1** Run `lsp_diagnostics` on all changed files: clean
- [x] **4.2** Run `bun typecheck`: only pre-existing errors in `packages/ui/`, `packages/workspace/`, `(config)/+layout.svelte`

## Constraints

- Zero behavior changes: pure file moves + import updates
- All imports must resolve after moves
- Follow existing codebase conventions
- Route-level `check-database-migration.ts` stays in `_layout-utils/` (layout-level side effect pattern)

## Review

### Summary

Colocated all migration logic under `src/lib/migration/`, separated orchestration state from UI, and extracted dev-only test data into its own module. The route-level check file stays in `_layout-utils/` with a renamed, intent-based filename.

### Deviations from Spec

- **Fixed pre-existing type error**: `migrateDatabaseToWorkspace` was refactored to return `Result<MigrationResult, MigrationError>` in commit `9da10e74`, but the dialog's `startWorkspaceMigration()` caller was never updated to unwrap the inner Result. The old `<script module>` context was lenient about this, but the `.svelte.ts` extraction exposed it. Fixed by properly unwrapping `migrationOutcome?.data` instead of using the raw Result as a `MigrationResult`.

### Files Changed

**Moved** (git mv, preserves history):
- `state/migrate-database.ts` → `migration/migrate-database.ts`
- `state/migrate-settings.ts` → `migration/migrate-settings.ts`
- `_layout-utils/check-indexeddb-migration.ts` → `_layout-utils/check-database-migration.ts`

**Created** (extracted from MigrationDialog.svelte):
- `migration/migration-test-data.ts`: dev-only test data factory
- `migration/migration-dialog.svelte.ts`: reactive dialog state singleton

**Rewritten**:
- `migration/MigrationDialog.svelte`: thin UI shell (was in `components/`)

**Import updates** (6 files):
- `check-database-migration.ts`, `+layout.svelte`, `VerticalNav.svelte`, `NavItems.svelte`, `AppLayout.svelte`

**Deleted**:
- `components/MigrationDialog.svelte` (replaced by `migration/MigrationDialog.svelte`)
