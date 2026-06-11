# Centralize Recording Management Actions

## Problem

Recording management actions (delete, transcribe, download) are copy-pasted across multiple UI surfaces with no shared abstraction. The "confirm → delete → notify" pattern is duplicated verbatim in 3 files:

- `RecordingRowActions.svelte` (single delete)
- `recordings/+page.svelte` (bulk delete)
- `EditRecordingModal.svelte` (single delete from modal)

The existing `actions.ts` centralizes recording **lifecycle** actions (start/stop/cancel/upload) but recording **management** actions have no equivalent.

## Solution

Create `recording-actions.ts` in `$lib/utils/` that exports a `recordingActions` object with `deleteWithConfirmation()`. This is a UI orchestration helper. Composing confirmation dialog + rpc call + notification. Not a query-layer primitive.

Components import `recordingActions` directly. It does not live on the `rpc` namespace because it reaches into the UI layer (`confirmationDialog`) and doesn't use `defineQuery`/`defineMutation`.

## Todo

- [x] Write spec
- [x] Create `$lib/utils/recording-actions.ts` with `deleteWithConfirmation`
- [x] Components import directly (not via rpc namespace)
- [x] Replace delete pattern in `RecordingRowActions.svelte`
- [x] Replace delete pattern in `recordings/+page.svelte` (bulk)
- [x] Replace delete pattern in `EditRecordingModal.svelte`
- [x] Verify LSP diagnostics clean on all changed files

## Decisions

- **New file vs extending actions.ts**: New file. `actions.ts` is 780 lines of recording lifecycle. Clean separation.
- **Home page actions**: Minimal surface is intentional. No changes needed.
- **RecordingRowActions decomposition**: Not worth it. The duplication is in action logic, not component structure.
- **utils/ vs query/isomorphic/**: `utils/`. The function imports `confirmationDialog` (a UI singleton) and doesn't use `defineQuery`/`defineMutation`. Placing it in `isomorphic/` would break both conventions of that directory. `utils/` already has similar UI-boundary helpers like `createCopyFn`.

## Review

### Changes Made

**New file**: `apps/whispering/src/lib/utils/recording-actions.ts`
- Exports `recordingActions.deleteWithConfirmation(recordings, options?)`
- Accepts single `Recording` or `Recording[]` (same signature as `rpc.db.recordings.delete`)
- Optional `onSuccess` callback for post-deletion UI cleanup (e.g., closing a modal)
- Optional `skipConfirmation` flag (passthrough to `ConfirmationDialog`)
- UI orchestration helper: composes confirmation dialog + rpc call + notification

**Modified files** (4 existing, net -75 lines / +12 lines):
- `RecordingRowActions.svelte`: 22-line inline delete → single function call, removed unused `confirmationDialog` import
- `recordings/+page.svelte`: 26-line bulk delete → single function call, removed unused `confirmationDialog` import
- `EditRecordingModal.svelte`: 25-line inline delete → single function call with `onSuccess` to close modal (kept `confirmationDialog` import. Still used for unsaved changes prompt)
- `isomorphic/index.ts`: Removed `recordingActions` from rpc namespace

### Behavioral Notes

- The `notify` calls in `recording-actions.ts` use `rpc.notify.success(...)` and `rpc.notify.error(...)`. These go through the defineMutation pattern in notify.ts which handles both toast + OS notification.
- The `throw error` pattern in `onConfirm` is preserved. This keeps the `ConfirmationDialog` open on failure (its built-in behavior).
- Slight wording normalization: all three sites now use the same messages ("Are you sure you want to delete this recording?" / "these recordings?") instead of the slightly different strings they had before.
