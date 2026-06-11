# Skills Editor: Filesystem → Domain Model Migration

**Date**: 2026-03-31
**Status**: Implemented
**Author**: AI-assisted

## Overview

Migrate `apps/skills` from a generic Yjs virtual filesystem (`@epicenter/filesystem`) to the purpose-built `@epicenter/skills` package. The app becomes a domain-specific skills editor instead of a filesystem editor that happens to edit skills.

## Motivation

### Current State

The skills editor uses `@epicenter/filesystem`'s `filesTable` as its data layer:

```typescript
// apps/skills/src/lib/workspace/definition.ts
import { filesTable } from '@epicenter/filesystem';
export const skillsEditorDefinition = defineWorkspace({
  id: 'epicenter.skills',
  tables: { files: filesTable },
});
```

```typescript
// apps/skills/src/lib/client.ts
export const ws = createSkillsEditor()
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqliteIndex', createSqliteIndex());

export const fs = createYjsFileSystem(ws.tables.files, ws.documents.files.content);
export const bash = new Bash({ fs, cwd: '/' });
```

This creates problems:

1. **Impedance mismatch**: Skills have typed fields (name, description, license, compatibility) but the editor treats them as raw markdown files. The `SkillMetadataForm` component parses frontmatter from file content on every load, then re-serializes on save.
2. **Unnecessary complexity**: The filesystem abstraction requires 367 lines of reactive state (`fs-state.svelte.ts`) with manual `requestAnimationFrame` coalescing, path-based navigation, and a tree walker. A flat skills list needs none of this.
3. **Disconnected from the package**: `packages/skills` already exports `createSkillsWorkspace()`, `skillsTable`, `referencesTable`, typed `Skill`/`Reference` types, and disk I/O actions. The editor doesn't use any of it.
4. **Dead weight**: The app ships a terminal emulator (`just-bash`), SQLite FTS index, and file-icon utilities. None of which a skills editor needs.

### Desired State

The editor imports `createSkillsWorkspace()` from `@epicenter/skills` and uses `fromTable()` for reactive state. The same pattern every other app in the monorepo follows. Skills are a flat list in a sidebar, not a file tree. The CodeMirror editor binds to `workspace.documents.skills.instructions` for collaborative editing. The metadata form reads/writes `workspace.tables.skills` directly.

## Research Findings

### How Other Apps in the Monorepo Wire Workspace Clients

Every app follows the same three-file pattern:

| Layer | File | Role |
|-------|------|------|
| Definition | `lib/workspace/definition.ts` | `defineWorkspace({ id, tables, kv })` |
| Factory | `lib/workspace/workspace.ts` | `createWorkspace(definition)`: returns builder |
| Client | `lib/client.ts` | Chains `.withExtension()` calls, exports singleton |

For `apps/skills`, the definition and factory live in the *package*:there's no need for a local `workspace/` directory at all.

Canonical patterns by app:

```typescript
// fuji: minimal
export const workspace = createFuji().withExtension('persistence', indexeddbPersistence);

// whispering: minimal
export const workspace = createWhispering().withExtension('persistence', indexeddbPersistence);

// honeycrisp: full stack
const workspace = createWorkspace(honeycrisp)
  .withEncryption({ userKeyStore: createIndexedDbKeyStore('honeycrisp:encryption-key') })
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ ... }));
```

### How Other Apps Create Reactive State from Tables

Two patterns exist:

**Pattern A: `fromTable()`** (honeycrisp, tab-manager, zhongwen, fuji): preferred for domain tables:

```typescript
const skillsMap = fromTable(workspace.tables.skills);
const skills = $derived(skillsMap.values().toArray().sort((a, b) => a.name.localeCompare(b.name)));
```

**Pattern B: Manual `SvelteMap` + `observe()`** (whispering): used when custom logic is needed on each change event. Not needed here.

All apps use the factory-function singleton pattern:

```typescript
function createSkillsState() {
  const skillsMap = fromTable(workspace.tables.skills);
  // ... $derived, methods
  return { get skills() { ... }, createSkill() { ... } };
}
export const skillsState = createSkillsState();
```

### What the Skills Package Already Provides

```
@epicenter/skills         : Browser-safe entry
├── createSkillsWorkspace() : Factory returning builder
├── skillsDefinition        : For embedding in custom workspaces
├── skillsTable             : defineTable with .withDocument('instructions')
├── referencesTable         : defineTable with .withDocument('content')
├── Skill, Reference        : Type exports

@epicenter/skills/node    : Server-side entry (NOT needed in browser)
├── createSkillsWorkspace() : Factory with importFromDisk/exportToDisk actions
```

The browser app only needs the base import. No `node.ts`, no disk I/O.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Local workspace dir | Delete entirely | `createSkillsWorkspace()` is the factory. No local definition needed |
| Reactive state | `fromTable()` from `@epicenter/svelte` | Canonical pattern; replaces 367 lines of manual observer code |
| Skill navigation | Flat list with expandable references | Skills aren't nested; tree walker is unnecessary |
| Terminal | Remove | No virtual filesystem = no shell needed |
| SQLite FTS | Remove | `fromTable` + `$derived` filtering is sufficient for ~50-100 skills |
| Tab bar | Remove | One skill editor at a time (like honeycrisp's note editor) |
| Path breadcrumb | Remove | No filesystem paths |
| File icons | Remove | No files |
| CodeMirror binding | Keep, change document path | `workspace.documents.skills.instructions.open(id)` instead of `ws.documents.files.content.open(id)` |
| Metadata form | Simplify. Read/write table directly | No more parsing frontmatter from file content |
| References editing | Keep CodeMirror for reference content | `workspace.documents.references.content.open(refId)` |

## Architecture

### After Migration

```
apps/skills/
├── src/lib/
│   ├── client.ts                    ← 3 lines: createSkillsWorkspace().withExtension(...)
│   ├── state/
│   │   └── skills-state.svelte.ts   ← fromTable() + $derived + CRUD methods
│   └── components/
│       ├── AppShell.svelte          ← sidebar + editor, no terminal
│       ├── SkillsList.svelte        ← flat list of skills
│       ├── SkillListItem.svelte     ← name + description, expandable references
│       ├── Toolbar.svelte           ← new skill, search
│       ├── CommandPalette.svelte    ← search across skills
│       ├── InlineNameInput.svelte   ← reused for renaming
│       ├── editor/
│       │   ├── SkillEditor.svelte   ← metadata form + instructions editor
│       │   ├── SkillMetadataForm.svelte  ← reads/writes table directly
│       │   ├── CodeMirrorEditor.svelte   ← Y.Text binding (unchanged API)
│       │   └── ReferencesPanel.svelte    ← list + edit references
│       └── dialogs/
│           ├── DeleteConfirmation.svelte ← kept
│           └── NewSkillDialog.svelte     ← extracted from Toolbar
└── package.json                     ← swap @epicenter/filesystem → @epicenter/skills
```

### Data Flow

```
┌───────────────────────┐     ┌─────────────────────────────┐
│  @epicenter/skills     │     │  @epicenter/svelte           │
│                        │     │                              │
│  createSkillsWorkspace │     │  fromTable(ws.tables.skills) │
│  skillsTable           │────▶│  → SvelteMap<id, Skill>      │
│  referencesTable       │     │  → $derived arrays            │
└───────────────────────┘     └──────────────┬──────────────┘
                                             │
                              ┌──────────────▼──────────────┐
                              │  skills-state.svelte.ts      │
                              │                              │
                              │  skills (sorted array)       │
                              │  selectedSkill               │
                              │  selectedReferences          │
                              │  createSkill / deleteSkill   │
                              └──────────────┬──────────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
           ┌────────▼───────┐    ┌───────────▼──────────┐  ┌────────▼────────┐
           │ SkillsList     │    │ SkillMetadataForm     │  │ CodeMirrorEditor│
           │ (sidebar)      │    │ (name, desc, etc.)    │  │ (instructions)  │
           └────────────────┘    └──────────────────────┘  └─────────────────┘
```

## Implementation Plan

### Phase 1: Data Layer Swap

- [x] **1.1** Update `apps/skills/package.json`: replace `@epicenter/filesystem` with `@epicenter/skills`, remove `just-bash`
- [x] **1.2** Delete `apps/skills/src/lib/workspace/` directory (definition.ts, workspace.ts, index.ts)
- [x] **1.3** Rewrite `apps/skills/src/lib/client.ts` to use `createSkillsWorkspace().withExtension('persistence', indexeddbPersistence)`. Remove `fs`, `bash`, and `createSqliteIndex` exports.
- [x] **1.4** Delete `apps/skills/src/lib/types.ts`: types come from `@epicenter/skills`. `validateSkill` moved to `utils/validation.ts`.
- [x] **1.5** Verify typecheck passes on data layer changes before touching UI

### Phase 2: State Layer

- [x] **2.1** Create `apps/skills/src/lib/state/skills-state.svelte.ts` using `fromTable()` pattern: `skillsMap`, `referencesMap`, `$derived` arrays, selected skill tracking, CRUD methods
- [x] **2.2** Delete `apps/skills/src/lib/state/fs-state.svelte.ts`
- [x] **2.3** Delete `apps/skills/src/lib/state/terminal-state.svelte.ts`
- [x] **2.4** Delete `apps/skills/src/lib/utils/file-icons.ts`

### Phase 3: UI: Remove Dead Components

- [x] **3.1** Delete `apps/skills/src/lib/components/terminal/` (TerminalPanel, TerminalInput, TerminalOutput)
- [x] **3.2** Delete `apps/skills/src/lib/components/editor/TabBar.svelte`
- [x] **3.3** Delete `apps/skills/src/lib/components/editor/PathBreadcrumb.svelte`

### Phase 4: UI: Rewrite Sidebar

- [x] **4.1** Rewrite `FileTree.svelte` → `SkillsList.svelte`: flat list from `skillsState.skills`, click to select
- [x] **4.2** Rewrite `FileTreeItem.svelte` → `SkillListItem.svelte`: show skill name + truncated description, context menu
- [x] **4.3** Keep `InlineNameInput.svelte` for renaming: removed icon prop

### Phase 5: UI: Rewrite Editor Panel

- [x] **5.1** Simplify `ContentPanel.svelte` → `SkillEditor.svelte`: remove tab bar and path breadcrumb, show metadata form + instructions editor for selected skill
- [x] **5.2** Rewrite `SkillMetadataForm.svelte` to read/write `workspace.tables.skills` directly instead of parsing frontmatter from file content
- [x] **5.3** Created `InstructionsEditor.svelte` to bind to `workspace.documents.skills.instructions.open(skillId)`. CodeMirrorEditor.svelte kept unchanged.
- [x] **5.4** Add `ReferencesPanel.svelte` to list and edit references for the selected skill

### Phase 6: UI: Update Shell Components

- [x] **6.1** Simplify `AppShell.svelte`: remove terminal pane, keep sidebar + editor layout
- [x] **6.2** Update `Toolbar.svelte`: remove file creation buttons, keep "New Skill" and search. Search filters `skillsState.skills` via `$derived` instead of SQLite FTS.
- [x] **6.3** Update `CommandPalette.svelte` to search skills by name/description
- [x] **6.4** Extract `NewSkillDialog.svelte` from Toolbar
- [x] **6.5** Update `DeleteConfirmation.svelte` to delete skill + cascade references

### Phase 7: Cleanup and Verify

- [x] **7.1** Run typecheck (`bun run check` in apps/skills): 0 errors in apps/skills code, 81 pre-existing errors in packages/ui and packages/workspace
- [ ] **7.2** Run dev server and verify: create skill, edit metadata, edit instructions, add reference, delete skill
- [x] **7.3** Remove unused dependencies from package.json: removed `@epicenter/filesystem`, `just-bash`, SQLite WASM config from vite.config.ts
- [x] **7.4** Add review section to this spec

## Edge Cases

### Empty State (No Skills)

First launch with no IndexedDB data. The sidebar shows an empty state with a "Create your first skill" prompt. The editor panel shows the same empty state pattern used across the monorepo (`Empty.Root` + `Empty.Title`).

### Skill with No References

Most skills have no `references/` directory. The references panel should either be hidden or show a minimal "Add reference" prompt. Not an empty list.

### CodeMirror Y.Text Binding Lifecycle

When the selected skill changes, the CodeMirror editor must unbind from the previous skill's Y.Text and bind to the new one. The current implementation already handles this via `{#key fsState.activeFileId}` which destroys and recreates the editor. The same pattern works with `{#key skillsState.selectedSkillId}`.

### Concurrent Editing

Since instructions are stored as Y.Text documents, two browser tabs editing the same skill will merge correctly via Yjs CRDT resolution. No special handling needed. This is what Yjs does.

## Open Questions

1. **Should the app support importing from disk in-browser?**
   - `importFromDisk` requires Node APIs (fs, path, crypto). The browser app can't call it directly.
   - Options: (a) CLI command imports to IndexedDB, (b) drag-and-drop SKILL.md files into the browser, (c) defer entirely. Edit in browser, export via CLI
   - **Recommendation**: Defer. The browser editor is for authoring and editing. Import/export is a CLI concern.

2. **Should references be editable inline or in a separate view?**
   - Options: (a) expandable panel below instructions, (b) separate tab/route per reference, (c) inline within the skill editor
   - **Recommendation**: Expandable panel below instructions. Keeps everything visible for the selected skill.

3. **Should we add sync (WebSocket) in this migration or defer?**
   - Options: (a) add `.withExtension('sync', ...)` now, (b) defer to a follow-up
   - **Recommendation**: Defer. Get the data layer right first. Sync is additive.

## Success Criteria

- [x] `apps/skills/package.json` has no `@epicenter/filesystem` or `just-bash` dependency
- [x] `apps/skills` imports `createSkillsWorkspace` from `@epicenter/skills`
- [x] State uses `fromTable()` from `@epicenter/svelte`: no manual observers
- [x] No filesystem concepts in the UI (no paths, no tree walker, no terminal)
- [x] Typecheck passes (0 errors in apps/skills; pre-existing errors in shared packages)
- [ ] Dev server runs and the editor works: create, edit metadata, edit instructions, delete

## References

- `packages/skills/src/tables.ts`: Table schemas and types
- `packages/skills/src/index.ts`: Public API exports
- `apps/honeycrisp/src/lib/client.ts`: Canonical workspace client pattern
- `apps/honeycrisp/src/lib/state/notes.svelte.ts`: Canonical `fromTable()` + state factory pattern
- `apps/whispering/src/lib/state/recordings.svelte.ts`: Manual `SvelteMap` + `observe()` pattern (reference, not used here)
- `packages/svelte-utils/src/fromTable.svelte.ts`: `fromTable` implementation
- `specs/20260330T120000-portable-skills-architecture.md`: Original architecture spec

## Review

**Completed**: 2026-03-31

### Summary

Full migration from `@epicenter/filesystem` to `@epicenter/skills`. The app dropped ~600 lines of filesystem infrastructure (367-line fs-state, 154-line terminal-state, workspace directory, bash integration, SQLite FTS index) and replaced it with ~250 lines of domain-specific code (153-line skills-state using `fromTable()`, 4-line client.ts). Every component now operates on typed `Skill` and `Reference` table rows instead of parsing frontmatter from virtual files.

### Files Changed

**Deleted (20 files)**:
- `src/lib/workspace/`: definition.ts, workspace.ts, index.ts
- `src/lib/state/fs-state.svelte.ts`: 367 lines of filesystem reactive state
- `src/lib/state/terminal-state.svelte.ts`: 154 lines of terminal emulator state
- `src/lib/types.ts`: SkillFrontmatter type (replaced by Skill from @epicenter/skills)
- `src/lib/utils/file-icons.ts`: extension-to-icon mapping
- `src/lib/components/terminal/`: TerminalPanel, TerminalInput, TerminalOutput
- `src/lib/components/editor/TabBar.svelte`: multi-tab bar
- `src/lib/components/editor/PathBreadcrumb.svelte`: filesystem path display
- `src/lib/components/editor/ContentPanel.svelte`: replaced by SkillEditor
- `src/lib/components/editor/ContentEditor.svelte`: replaced by InstructionsEditor
- `src/lib/components/tree/FileTree.svelte`: replaced by SkillsList
- `src/lib/components/tree/FileTreeItem.svelte`: replaced by SkillListItem

**Created (8 files)**:
- `src/lib/state/skills-state.svelte.ts`: fromTable() reactive state with CRUD
- `src/lib/utils/validation.ts`: validateSkill extracted from deleted types.ts
- `src/lib/components/SkillsList.svelte`: flat skill list sidebar
- `src/lib/components/SkillListItem.svelte`: skill name + description + context menu
- `src/lib/components/editor/SkillEditor.svelte`: metadata + instructions + references
- `src/lib/components/editor/InstructionsEditor.svelte`: Y.Doc binding for instructions
- `src/lib/components/editor/ReferencesPanel.svelte`: expandable reference editor
- `src/lib/components/dialogs/NewSkillDialog.svelte`: extracted from Toolbar

**Rewritten (5 files)**:
- `src/lib/client.ts`: 42 lines → 4 lines
- `src/lib/components/AppShell.svelte`: removed terminal, simplified layout
- `src/lib/components/Toolbar.svelte`: removed file ops, kept New Skill + search
- `src/lib/components/CommandPalette.svelte`: searches skills instead of files
- `src/lib/components/dialogs/DeleteConfirmation.svelte`: uses skillsState

**Updated (3 files)**:
- `src/lib/components/tree/InlineNameInput.svelte`: removed icon prop
- `package.json`: swapped deps, removed exports field
- `vite.config.ts`: removed SQLite WASM / COOP-COEP config

### Deviations from Spec

- **5.3**: Created a new `InstructionsEditor.svelte` instead of renaming `ContentEditor.svelte`, since the document path changed (`workspace.documents.skills.instructions` vs `ws.documents.files.content`).
- **1.4**: `validateSkill` was preserved in a new `utils/validation.ts` file rather than being inlined, since it's imported by both `SkillMetadataForm` and `NewSkillDialog`.
- Added `@epicenter/svelte` as a workspace dependency (required for `fromTable()` import).

### Follow-up Work

- **7.2**: Manual testing with dev server (create skill, edit metadata, edit instructions, references, delete)
- Sync extension (`.withExtension('sync', ...)`): deferred per open question #3
- Import/export from disk: deferred per open question #1
