# Flatten Workspace State Prefix

**Date**: 2026-03-15
**Status**: Implemented
**Author**: AI-assisted

## Overview

Remove the `workspace-` prefix from state file names and the `workspace` prefix from exported singleton names in `apps/whispering/src/lib/state/`. The prefix encodes storage-backend information (Yjs CRDT) that consumers don't need at the call site. The `state/` directory already provides the namespace.

## Motivation

### Current State

Every Yjs-backed state module carries a `workspace-` prefix on both the filename and the export name:

```typescript
// Import path repeats "workspace" redundantly
import { workspaceRecordings } from '$lib/state/workspace-recordings.svelte';
import { workspaceSettings } from '$lib/state/workspace-settings.svelte';
import { workspaceTransformationRuns } from '$lib/state/workspace-transformation-runs.svelte';

// Usage sites are verbose: "workspace" adds nothing here
workspaceRecordings.sorted
workspaceSettings.get('recording.mode')
workspaceTransformationRuns.getByRecordingId(id)
```

```
state/
  workspace-recordings.svelte.ts           → export const workspaceRecordings
  workspace-settings.svelte.ts             → export const workspaceSettings
  workspace-transformations.svelte.ts      → export const workspaceTransformations
  workspace-transformation-steps.svelte.ts → export const workspaceTransformationSteps
  workspace-transformation-runs.svelte.ts  → export const workspaceTransformationRuns
  device-config.svelte.ts                  → export const deviceConfig     (no prefix)
  vad-recorder.svelte.ts                   → export const vadRecorder      (no prefix)
```

This creates problems:

1. **Redundant naming.** The prefix is a namespace simulated via convention. 5 of 7 files share it. That's a pattern screaming to be structural, or removed.
2. **Verbose call sites.** `workspaceRecordings.sorted` says nothing more than `recordings.sorted` in context. The storage backend (Yjs vs localStorage) is an implementation detail, not something every consumer needs to see.
3. **Asymmetric naming.** `deviceConfig` already scopes itself by name. Everything else is implicitly workspace-level. The `workspace` prefix on the majority is noise. You don't prefix the default.
4. **323 usage sites.** The `workspace` prefix appears in 323 lines across 48 source files. That's a lot of keystrokes encoding information that matters to the implementer of the module, not its consumers.

### Desired State

```typescript
// Clean, domain-focused imports
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformationRuns } from '$lib/state/transformation-runs.svelte';

// Usage reads like plain English
recordings.sorted
settings.get('recording.mode')
transformationRuns.getByRecordingId(id)
```

```
state/
  recordings.svelte.ts           → export const recordings
  settings.svelte.ts             → export const settings
  transformations.svelte.ts      → export const transformations
  transformation-steps.svelte.ts → export const transformationSteps
  transformation-runs.svelte.ts  → export const transformationRuns
  device-config.svelte.ts        → export const deviceConfig     (unchanged)
  vad-recorder.svelte.ts         → export const vadRecorder      (unchanged)
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Drop `workspace-` from filenames | Yes | The `state/` directory is the namespace. 5/7 files sharing a prefix is a redundant pseudo-namespace. |
| Drop `workspace` from export names | Yes | Call sites don't need storage-backend information. `recordings.sorted` is sufficient context. `deviceConfig` already self-scopes as the exception. |
| Keep flat directory (no subfolder) | Yes | 7 files doesn't warrant a subdirectory. The rename alone resolves the naming issue. |
| Don't rename `deviceConfig` or `vadRecorder` | Correct | These names are already clean. They describe their domain, not their storage backend. |
| Don't update historical specs | Correct | Specs document what happened at that point in time. Rewriting history makes them unreliable references. |
| DO update live documentation | Yes | READMEs, ARCHITECTURE.md, and articles with code examples should reflect the current API. |
| Handle local variable collisions | Rename the local variable | 2 files have `const transformations = $derived(workspaceTransformations.sorted)`. After rename, the local must change to avoid shadowing the import. |
| Internal factory function names | Also rename | `createWorkspaceRecordings()` → `createRecordings()`, etc. These are private but should be consistent. |

## Architecture

The directory structure change is minimal. File renames only, no moves:

```
apps/whispering/src/lib/state/
  BEFORE                                    AFTER
  ──────                                    ─────
  workspace-recordings.svelte.ts        →   recordings.svelte.ts
  workspace-settings.svelte.ts          →   settings.svelte.ts
  workspace-transformations.svelte.ts   →   transformations.svelte.ts
  workspace-transformation-steps.svelte.ts → transformation-steps.svelte.ts
  workspace-transformation-runs.svelte.ts  → transformation-runs.svelte.ts
  device-config.svelte.ts                   (unchanged)
  vad-recorder.svelte.ts                    (unchanged)
  README.md                                 (updated)
```

Export name mapping:

```
  BEFORE                              AFTER
  ──────                              ─────
  workspaceRecordings             →   recordings
  workspaceSettings               →   settings
  workspaceTransformations        →   transformations
  workspaceTransformationSteps    →   transformationSteps
  workspaceTransformationRuns     →   transformationRuns
  createWorkspaceRecordings()     →   createRecordings()
  createWorkspaceSettings()       →   createSettings()
  createWorkspaceTransformations()→   createTransformations()
  createWorkspaceTransformationSteps() → createTransformationSteps()
  createWorkspaceTransformationRuns()  → createTransformationRuns()
```

## Edge Cases

### Local Variable Name Collisions

Two files currently shadow the import with a local derived variable:

**`src/lib/components/settings/selectors/TransformationSelector.svelte`**:
```typescript
// BEFORE
import { workspaceTransformations, type Transformation } from '$lib/state/workspace-transformations.svelte';
const transformations = $derived(workspaceTransformations.sorted);

// AFTER: local variable must change to avoid collision
import { transformations, type Transformation } from '$lib/state/transformations.svelte';
const sortedTransformations = $derived(transformations.sorted);
// Then update all template references from `transformations` to `sortedTransformations`
```

**`src/lib/components/TransformationPickerBody.svelte`**:
```typescript
// Same pattern: same fix
import { transformations, type Transformation } from '$lib/state/transformations.svelte';
const sortedTransformations = $derived(transformations.sorted);
```

These are the only 2 collision sites. No other consumer files have `const recordings`, `const settings`, etc. as local variables that would shadow the new import names.

### Internal Cross-References Between State Modules

`workspace-transformations.svelte.ts` imports from `workspace-transformation-steps.svelte.ts`:

```typescript
// BEFORE (in workspace-transformations.svelte.ts)
import { workspaceTransformationSteps, type TransformationStep } from './workspace-transformation-steps.svelte';

// AFTER (in transformations.svelte.ts)
import { transformationSteps, type TransformationStep } from './transformation-steps.svelte';
```

All internal usages of `workspaceTransformationSteps` within that file must also update (e.g., inside `saveTransformationWithSteps`).

### JSDoc `@example` Blocks Inside State Files

Each state file has JSDoc examples referencing the old import paths and export names. All 5 files need their JSDoc updated:

```typescript
// BEFORE (in workspace-recordings.svelte.ts)
* import { workspaceRecordings } from '$lib/state/workspace-recordings.svelte';
* const recording = workspaceRecordings.get(id);

// AFTER (in recordings.svelte.ts)
* import { recordings } from '$lib/state/recordings.svelte';
* const recording = recordings.get(id);
```

### `settings` as a Generic Name

`settings` is a common word. However:
- No consumer file has a local `const settings` that would collide.
- `settings` and `deviceConfig` are semantically distinct: `settings` = user preferences (synced), `deviceConfig` = device-bound config (local). The naming asymmetry correctly communicates that `deviceConfig` is the exception.
- If ambiguity ever arises in a specific file, `appSettings` is a one-line alias.

### Comment References (Non-Import)

`src/lib/migration/migrate-settings.ts` has a comment referencing `workspaceSettings.observeAll`:
```typescript
// Batch into a single Yjs transaction so workspaceSettings.observeAll
```
This should update to `settings.observeAll`.

## Implementation Plan

### Phase 1: Rename State Files and Exports

All 5 file renames + export renames + internal factory function renames. This is the atomic unit. All must happen together.

- [x] **1.1** Rename `workspace-recordings.svelte.ts` → `recordings.svelte.ts`
  - Rename file
  - Rename `createWorkspaceRecordings` → `createRecordings`
  - Rename export `workspaceRecordings` → `recordings`
  - Update JSDoc `@example` blocks with new import path and export name
- [x] **1.2** Rename `workspace-settings.svelte.ts` → `settings.svelte.ts`
  - Rename file
  - Rename `createWorkspaceSettings` → `createSettings`
  - Rename export `workspaceSettings` → `settings`
  - Update JSDoc with new import path and export name
- [x] **1.3** Rename `workspace-transformations.svelte.ts` → `transformations.svelte.ts`
  - Rename file
  - Rename `createWorkspaceTransformations` → `createTransformations`
  - Rename export `workspaceTransformations` → `transformations`
  - Update internal import from `./workspace-transformation-steps.svelte` → `./transformation-steps.svelte`
  - Update all internal usages of `workspaceTransformationSteps` → `transformationSteps`
  - Update JSDoc and `saveTransformationWithSteps` / `generateDefaultTransformation` doc examples
- [x] **1.4** Rename `workspace-transformation-steps.svelte.ts` → `transformation-steps.svelte.ts`
  - Rename file
  - Rename `createWorkspaceTransformationSteps` → `createTransformationSteps`
  - Rename export `workspaceTransformationSteps` → `transformationSteps`
  - Update JSDoc `@example` blocks
- [x] **1.5** Rename `workspace-transformation-runs.svelte.ts` → `transformation-runs.svelte.ts`
  - Rename file
  - Rename `createWorkspaceTransformationRuns` → `createTransformationRuns`
  - Rename export `workspaceTransformationRuns` → `transformationRuns`
  - Update JSDoc `@example` blocks

### Phase 2: Update All Consumer Imports (48 Source Files)

Mechanical find-and-replace across all `.ts` and `.svelte` files that import from the old paths. Each file needs:
1. Import path update (`$lib/state/workspace-recordings.svelte` → `$lib/state/recordings.svelte`)
2. Import name update (`workspaceRecordings` → `recordings`)
3. All usage sites in the file body (`workspaceRecordings.sorted` → `recordings.sorted`)

#### 2.1: `workspaceSettings` consumers (28 files)

- [x] All `workspaceSettings` consumers updated (28 files)
- [x] All `workspaceRecordings` consumers updated (10 files)
- [x] All `workspaceTransformations` consumers updated (7 files)
- [x] All `workspaceTransformationSteps` consumers updated (3 files)
- [x] All `workspaceTransformationRuns` consumers updated (5 files)

#### 2.2: `workspaceRecordings` consumers (10 files)

- [x] All recording consumers updated

#### 2.3: `workspaceTransformations` consumers (7 files)

- [x] All transformation consumers updated

#### 2.4: `workspaceTransformationSteps` consumers (3 files)

- [x] All transformation step consumers updated

#### 2.5: `workspaceTransformationRuns` consumers (5 files)

- [x] All transformation run consumers updated

#### 2.6: Local variable collision fixes (2 files)

- [x] `src/lib/components/settings/selectors/TransformationSelector.svelte`: renamed `const transformations` → `const sortedTransformations`
- [x] `src/lib/components/TransformationPickerBody.svelte`: renamed `const transformations` → `const sortedTransformations`
- [x] `src/lib/utils/recording-actions.ts`: renamed `recordings` parameter → `toDelete` to avoid shadowing import
  > **Discovery**: The `deleteWithConfirmation(recordings: Recording | Recording[])` parameter shadowed the imported `recordings` module. Renamed parameter to `toDelete`.

### Phase 3: Update Live Documentation (6 files)

These files have code examples, headings, or prose referencing the old names and must be updated to reflect the current API.

- [x] **3.1** `apps/whispering/ARCHITECTURE.md`
- [x] **3.2** `apps/whispering/src/lib/state/README.md`
- [x] **3.3** `apps/whispering/src/lib/query/README.md`
- [x] **3.4** `apps/whispering/src/lib/components/settings/README.md`
- [x] **3.5** `docs/articles/module-level-singletons-dont-need-remove-event-listener.md`
- [x] **3.6** `docs/articles/your-spa-singleton-doesnt-need-effect-cleanup.md`

### Phase 4: Verification

- [x] **4.1** Run `bun run typecheck`: all errors are pre-existing (packages/ui, packages/workspace, unrelated action types)
- [x] **4.2** Run `lsp_diagnostics` on all 5 renamed state files: zero errors
- [x] **4.3** Run `lsp_diagnostics` on the 3 collision-fix files: zero errors
- [x] **4.4** Grep for old export names in `.ts`/`.svelte`: zero matches
- [x] **4.5** Grep for old file paths in live `.md` files: zero matches (only historical specs, as expected)

## Historical Specs (DO NOT Update)

The following specs reference the old `workspace-` prefixed names. These are historical documents that record decisions and work done at a point in time. **Do not modify them**: they remain accurate records of what was implemented when they were written.

- `specs/20260312T170000-whispering-workspace-polish-and-migration.md`
- `specs/20260312T210000-whispering-settings-separation.md`
- `specs/20260313T160000-per-key-device-config.md`
- `specs/20260313T163000-settings-data-migration.md`
- `specs/20260314T232643-migration-flow-cleanup.md`
- `specs/20260315T070000-query-layer-switch-to-workspace-tables.md`
- `specs/20260315T210229-clean-up-dead-rpc-db-code.md`

## Open Questions

1. **Should `TransformationSelector` and `TransformationPickerBody` use `transformations.sorted` directly in templates instead of an intermediate variable?**
   - Option (a): Rename local to `sortedTransformations` (keeps the derived variable for memoization)
   - Option (b): Remove the intermediate variable and use `transformations.sorted` directly in the template (`.sorted` is already `$derived`-memoized in the state module)
   - **Recommendation**: Option (a): keep the intermediate. It's explicit and won't break if the template iterates multiple times.

2. **Should the `README.md` for `$lib/state/` mention that these modules are workspace-backed?**
   - The README currently describes each module's backing store. After dropping the prefix, the README becomes the primary place where "this is Yjs-backed" is documented.
   - **Recommendation**: Yes, keep the storage-backend info in the README. Just update the headings and examples.

## Success Criteria

- [x] All 5 state files renamed (no `workspace-` prefix in filenames)
- [x] All 5 exports renamed (no `workspace` prefix in export names)
- [x] All 51 consumer source files updated with new imports and usage
- [x] 3 local variable/parameter collisions resolved
- [x] All 6 live documentation files updated
- [x] `bun run typecheck`: no new errors introduced (13 pre-existing errors in packages/ui, packages/workspace, and unrelated code)
- [x] Zero remaining references to old names in `.ts`, `.svelte`, and live `.md` files

## References

- `apps/whispering/src/lib/state/`: all 7 state module files
- `apps/whispering/ARCHITECTURE.md`: code examples referencing state modules
- `apps/whispering/src/lib/state/README.md`: state module documentation
- `apps/whispering/src/lib/query/README.md`: query layer documentation with state examples
- `apps/whispering/src/lib/components/settings/README.md`: settings component documentation
- `docs/articles/module-level-singletons-dont-need-remove-event-listener.md`: article with code example
- `docs/articles/your-spa-singleton-doesnt-need-effect-cleanup.md`: article with code example

## Review

**Completed**: 2026-03-15

### Summary

Removed the `workspace-` prefix from 5 state file names and the `workspace` prefix from their exported singletons. Updated 51 consumer source files, 6 live documentation files, and resolved 3 naming collisions. The spec executed cleanly in 3 commits across 4 waves.

### Deviations from Spec

- **3 collisions instead of 2.** The spec anticipated 2 collisions (`TransformationSelector` and `TransformationPickerBody`). A third was discovered during typecheck: `recording-actions.ts` had a `recordings` parameter that shadowed the now-renamed `recordings` import. Fixed by renaming the parameter to `toDelete`.
- **51 files instead of 48.** The original count missed a few files that only imported types (e.g., `type Recording`, `type TransformationStep`) from the old paths without importing the state singletons. These needed path updates too.
- **`bun run typecheck` instead of `bun check`.** The script is named `typecheck`, not `check`. 13 pre-existing errors in `packages/ui`, `packages/workspace`, and unrelated code were confirmed as not introduced by this change.
