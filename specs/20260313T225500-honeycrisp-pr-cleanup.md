# Honeycrisp PR #1526 Cleanup — Eliminate Prop Drilling, Fix Patterns

**Date**: 2026-03-13
**Status**: Implemented
**Author**: AI-assisted
**Parent**: PR #1526 (`opencode/calm-forest` branch)

## Overview

PR #1526 correctly extracted state into a module singleton (`notesState`) but then prop-drilled it back through every component. This spec addresses the contradiction and fixes pattern violations, ordered by impact.

## Motivation

### Current State

The PR introduced `notesState` as a module singleton in `notes.svelte.ts`—following the established `saved-tab-state` / `browser-state` pattern. But `+page.svelte` immediately prop-drills it back down:

```svelte
<!-- +page.svelte — 30+ props forwarding notesState methods -->
<NoteList
  notes={isRecentlyDeletedView ? notesState.deletedNotes : notesState.filteredNotes}
  selectedNoteId={notesState.selectedNoteId}
  sortBy={notesState.sortBy}
  viewMode={isRecentlyDeletedView ? 'recentlyDeleted' : 'normal'}
  folders={notesState.folders}
  onSelectNote={(id) => notesState.selectNote(id)}
  onCreateNote={() => notesState.createNote()}
  onDeleteNote={(id) => notesState.softDeleteNote(id)}
  onPinNote={(id) => notesState.pinNote(id)}
  onSortChange={(v) => notesState.setSortBy(v)}
  onRestoreNote={(id) => notesState.restoreNote(id)}
  onPermanentlyDeleteNote={(id) => notesState.permanentlyDeleteNote(id)}
  onMoveToFolder={(noteId, folderId) => notesState.moveNoteToFolder(noteId, folderId)}
/>
```

This is the exact anti-pattern the codebase documented migrating away from in `docs/articles/migrating-tanstack-query-to-svelte-state-and-observers.md`:

> "Those two imports replace all nine mutations... Each button handler went from `$closeMutation.mutate(tabId)` to `browserState.actions.close(tabId)`."

### Problems

1. **Contradicts established pattern**: The codebase already documented moving FROM prop-drilled callbacks TO direct singleton imports. This PR does the opposite.
2. **`isRecentlyDeletedView` is orphaned**: Lives in `+page.svelte` but coordinates Sidebar, NoteList, and folder name. Won't sync across devices since it's not connected to Y.Doc.
3. **Type safety violation**: `generateId() as unknown as FolderId` bypasses TypeScript narrowing. The workspace-api skill specifies `as string as`.
4. **Duplicated utility**: `parseDateTime` is copy-pasted in NoteCard and NoteList.
5. **Pattern violations**: `handleContentChange` naming, unnecessary `as` casts in props, missing JSDoc on public API methods.

### Desired State

Components import `notesState` directly. `+page.svelte` is a thin layout shell. View state (`isRecentlyDeletedView`, `folderName`) lives in the state module where it belongs.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Component state access | Direct singleton import | Matches `browser-state` / `saved-tab-state` pattern documented in codebase articles |
| `isRecentlyDeletedView` location | Move to `notesState` | Coordinates 3+ components; should sync via Y.Doc if persisted |
| NoteCard viewMode branching | Keep single component | Splitting adds file count without reducing complexity; the branching is contained |
| `folderName` derivation | Move to `notesState` as getter | Business logic, not view logic |
| JSDoc depth | Detailed with `@example` | Per AGENTS.md requirements for public API methods |

## Architecture

### Before (Current PR)

```
+page.svelte (wiring harness)
│
├─→ Sidebar       (12 props: 6 data + 6 callbacks)
├─→ NoteList      (12 props: 5 data + 7 callbacks)
│   └─→ NoteCard  (7 props: 2 data + 5 callbacks + viewMode + folders)
├─→ CommandPalette (6 props: 2 data + 4 callbacks)
└─→ Editor        (2 props ✓)
```

### After (This Spec)

```
+page.svelte (layout shell)
│
├─→ Sidebar        (0 forwarded props — imports notesState directly)
├─→ NoteList       (0 forwarded props — imports notesState directly)
│   └─→ NoteCard   (note, isSelected — imports notesState for actions)
├─→ CommandPalette (open bindable only — imports notesState directly)
└─→ Editor         (yxmlfragment, onContentChange ✓)

notesState singleton (imported by all leaf components)
├── .folders, .notes, .filteredNotes, .deletedNotes
├── .selectedFolderId, .selectedNoteId, .selectedNote
├── .isRecentlyDeletedView, .folderName (NEW)
├── .createNote(), .softDeleteNote(), .pinNote(), ...
└── .selectRecentlyDeleted(), .selectFolder() (manages view state)
```

## Implementation Plan

### Tier 1 — Must Fix (correctness + pattern alignment)

These directly contradict established codebase conventions or have correctness issues.

- [x] **1.1** Move `isRecentlyDeletedView` into `notesState` as `$state(false)` with a getter. Add `selectRecentlyDeleted()` method that sets it to `true` and calls `selectFolder(null)`. Update `selectFolder()` to set it to `false`.
- [x] **1.2** Add `folderName` as a `$derived` getter on `notesState` (currently a ternary in +page.svelte).
- [x] **1.3** Refactor `Sidebar.svelte` to import `notesState` directly. Remove all forwarded data/callback props. Keep only props that are genuinely component-local (editing state).
- [x] **1.4** Refactor `NoteList.svelte` to import `notesState` directly. The only prop it should receive is potentially `viewMode` (or derive it from `notesState.isRecentlyDeletedView`).
  > **Note**: Zero props — derives notes list from `notesState.isRecentlyDeletedView` internally.
- [x] **1.5** Refactor `NoteCard.svelte` to import `notesState` directly. Props reduce to `note` and `isSelected`. Actions call `notesState.softDeleteNote(note.id)` etc. directly.
  > **Note**: Props reduced to just `note` — `isSelected` is now computed internally via `$derived`.
- [x] **1.6** Refactor `CommandPalette.svelte` to import `notesState` directly. Only prop: `open` (bindable).
- [x] **1.7** Slim down `+page.svelte` to layout + document handle `$effect` + keyboard shortcuts only.
  > **Note**: 164 lines → 103 lines. Only props remaining: Editor's yxmlfragment + onContentChange.
- [x] **1.8** Fix `generateId() as unknown as FolderId` → `generateId() as string as FolderId` in `notes.svelte.ts` (2 occurrences: `createFolder` and `createNote`).

### Tier 2 — Should Fix (code quality)

These improve maintainability but don't fix correctness issues.

- [x] **2.1** Extract `parseDateTime(dts: string): Date` to `$lib/utils/date.ts`. Remove duplicates from NoteCard and NoteList.
- [x] **2.2** Rename `handleContentChange` → `updateNoteContent` in `notesState` (and update the call site in +page.svelte / Editor).
- [x] **2.3** Remove unnecessary `as` casts in NoteCard prop defaults (`viewMode = 'normal' as 'normal' | 'recentlyDeleted'` → just `viewMode = 'normal'`).
  > **Note**: Resolved by removing all those props entirely — NoteCard now reads from notesState directly.
- [x] **2.4** Clean up `onSortChange` → `onSortChange` / `setSortBy` naming inconsistency (will be resolved by direct import in Tier 1, but verify).
  > **Note**: Resolved — components now call `notesState.setSortBy()` directly, no more prop indirection.

### Tier 3 — Nice to Have (polish)

These improve developer experience but don't affect behavior.

- [x] **3.1** Add JSDoc with `@example` to all public methods on `notesState`: `createFolder`, `renameFolder`, `deleteFolder`, `createNote`, `softDeleteNote`, `restoreNote`, `permanentlyDeleteNote`, `pinNote`, `selectFolder`, `selectNote`, `updateNoteContent`, `setSortBy`, `setSearchQuery`, `moveNoteToFolder`.
- [x] **3.2** Add JSDoc to `selectRecentlyDeleted` (new method from 1.1).

## Edge Cases

### Component still needs a prop it can't get from notesState

Some components may need genuinely local props (e.g., `open` bindable on CommandPalette). These stay as props. The rule: if the data comes from `notesState`, import it directly. If it's component-instance-specific (like which NoteCard in a list), pass it as a prop.

### NoteCard needs `note` and `isSelected` as props

NoteCard renders inside an `{#each}` loop. It can't derive "which note am I?" from `notesState`—that comes from the loop. So `note` stays as a prop. `isSelected` is `note.id === notesState.selectedNoteId` which NoteCard can compute internally from `note.id`, so it could technically be removed too. Implementer's call.

### Editor's `onContentChange` callback

The Editor component receives a Y.XmlFragment and fires content changes. This callback updates `notesState.updateNoteContent()`. Since `+page.svelte` manages the document handle lifecycle, this callback should stay as a prop on Editor OR Editor can import `notesState` directly. Either works—the document handle `$effect` is the more important coupling.

## Open Questions

1. **Should `isRecentlyDeletedView` be persisted to KV?**
   - If yes: add `defineKv(type('boolean'), false)` and observe it
   - If no: keep as plain `$state` in the factory (simpler, resets on reload)
   - **Recommendation**: No. It's ephemeral UI state—restarting the app should show All Notes, not Recently Deleted.

2. **Should NoteCard compute `isSelected` internally?**
   - It has access to `note.id` (prop) and `notesState.selectedNoteId` (singleton)
   - Passing `isSelected` as a prop is arguably more explicit
   - **Recommendation**: Let NoteCard compute it internally. Fewer props, and the logic is trivial.

3. **Should `+page.svelte` still import `workspaceClient` after refactoring?**
   - Currently needed for the document handle `$effect`
   - Could move document handle management into `notesState` too
   - **Recommendation**: Keep document handle in `+page.svelte` for now. It's genuinely view-lifecycle-coupled (mounting/unmounting the editor). Moving it to the singleton would conflate state management with component lifecycle.

## Success Criteria

- [ ] `+page.svelte` is under 80 lines (currently 164)
- [ ] No component receives `notesState` data or callbacks as props (except Editor's `onContentChange` and `yxmlfragment`)
- [ ] `NoteCard.svelte` props: `note` only (maybe `isSelected`)
- [ ] `CommandPalette.svelte` props: `open` (bindable) only
- [ ] `Sidebar.svelte` props: none
- [ ] `NoteList.svelte` props: none
- [ ] No `as unknown as` casts
- [ ] No duplicated `parseDateTime` function
- [ ] No `handle*` function names in `notesState`
- [ ] `bun check` passes
- [ ] Existing behavior preserved (soft delete, context menus, ⌘K, arrow nav all still work)

## References

- `apps/honeycrisp/src/lib/state/notes.svelte.ts` — State singleton to modify
- `apps/honeycrisp/src/routes/+page.svelte` — Layout shell to slim down
- `apps/honeycrisp/src/lib/components/NoteCard.svelte` — Heaviest prop reduction
- `apps/honeycrisp/src/lib/components/NoteList.svelte` — Remove forwarded props
- `apps/honeycrisp/src/lib/components/Sidebar.svelte` — Remove forwarded props
- `apps/honeycrisp/src/lib/components/CommandPalette.svelte` — Remove forwarded props
- `docs/articles/migrating-tanstack-query-to-svelte-state-and-observers.md` — The pattern we're aligning with
- `.agents/skills/svelte/SKILL.md` — Self-Contained Component Pattern, no `handle*` functions
- `.agents/skills/workspace-api/SKILL.md` — `generateId()` cast convention

## Review

**Completed**: 2026-03-13
**Branch**: `opencode/calm-forest`

### Summary

Eliminated prop drilling from all Honeycrisp components. Components now import the `notesState` singleton directly—matching the established `browser-state`/`saved-tab-state` pattern documented in `docs/articles/migrating-tanstack-query-to-svelte-state-and-observers.md`. `+page.svelte` went from 164 lines of wiring harness to 103 lines of pure layout + document handle lifecycle.

### Changes by Wave

**Wave 1** (state module): Added `isRecentlyDeletedView`, `folderName`, `selectRecentlyDeleted()` to notesState. Fixed `as unknown as` → `as string as`. Renamed `handleContentChange` → `updateNoteContent`. Extracted `parseDateTime` to `$lib/utils/date.ts`.

**Wave 2** (leaf components): Sidebar, NoteCard, CommandPalette all import notesState directly. Sidebar: 0 props. NoteCard: 1 prop (`note`), computes `isSelected` via `$derived`. CommandPalette: 1 prop (`open` bindable).

**Wave 3** (list + page): NoteList imports notesState directly (0 props), derives its note list from `isRecentlyDeletedView`. `+page.svelte` stripped to layout shell.

**Wave 4** (polish): Detailed JSDoc with `@example` blocks on all 15 public methods.

### Deviations from Spec

- **1.5**: Spec said "props reduce to `note` and `isSelected`". `isSelected` was moved to a `$derived` inside NoteCard instead—fewer props, trivial computation.
- **2.3/2.4**: Resolved implicitly by removing all affected props entirely rather than fixing their defaults/names.

### Follow-up Work

- Consider moving document handle lifecycle from `+page.svelte` into `notesState` (spec Open Question #3—deferred as recommended).
- Consider persisting `isRecentlyDeletedView` to KV if cross-device sync becomes desirable (spec Open Question #1—deferred as recommended).
