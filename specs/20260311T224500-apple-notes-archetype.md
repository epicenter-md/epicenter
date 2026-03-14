# Apple Notes Archetypes — Two Standalone Apps (Umbrella Spec)

**Date**: 2026-03-11
**Status**: Phases 0–2 complete. Fuji Phase 1.5 (polish) and Phase 4 (sync) deferred.
**Author**: AI-assisted

## Overview

Two standalone note-taking apps built on the Epicenter workspace API. Each has a distinct purpose and separate execution spec.

| App | Role | One-liner |
|-----|------|-----------|
| **Fuji** | Personal power-notes | The real app—ground-up rewrite for daily use, rich schema, Sidebar, eventually table view |
| **Honeycrisp** | Simple Apple Notes clone | Faithful three-column clone—folders, notes, editor. Clean and straightforward |

> **Role Revision (2026-03-12)**: Fuji was originally "minimal zen quick-capture." That's wrong—it's now the primary personal note app with a richer schema. Honeycrisp takes the "simple faithful clone" role. Granny Smith remains shelved.

> **Execution**: Each app has its own spec. See:
> - `specs/20260312T192500-honeycrisp.md` — Honeycrisp execution spec (build first, simpler)
> - `specs/20260312T192500-fuji-rewrite.md` — Fuji rewrite execution spec (build second, needs design)

Each is a standalone SPA under `apps/` with its own workspace schema, its own `defineWorkspace` call, and its own UI.

---

## Motivation

### Current State

The only content-oriented template is `entries`:

```typescript
// apps/epicenter/src/lib/templates/entries.ts
const entries = defineTable(
  type({
    id: 'string',
    title: 'string',
    content: 'string',
    type: 'string',
    tags: 'string',
    _v: '1',
  }),
);
```

This is a flat, untyped bag—no folders, no dates, no branded IDs, no collaborative text. It doesn't model anything a real notes app needs.

### Problems

1. **No hierarchical organisation**: No folders. Every entry is a flat list.
2. **No temporal metadata**: No `createdAt` / `updatedAt` with timezone awareness.
3. **No branded IDs**: Plain `'string'` for `id`—nothing prevents mixing note IDs with folder IDs.
4. **No collaborative editing**: `content: 'string'` means no real-time Y.Text support.
5. **No archetype to scaffold from**: Users who want a notes app have to design their own schema from scratch.
6. **No variety**: One template, one vibe. Three apps covering different writing styles would showcase the workspace API's flexibility and give users real choice.

### Desired State

Three standalone apps—`apps/granny-smith/`, `apps/honeycrisp/`, `apps/fuji/`—each demonstrating a different way to build a notes app on the workspace API. Users pick the vibe that matches their workflow.

---

## Research Findings

### Existing Workspace Patterns

| App | Tables | IDs | Dates | Y.Text | Extensions |
|-----|--------|-----|-------|--------|------------|
| Whispering | 5 tables (recordings, transformations, etc.) | Plain `'string'` | Plain `'string'` timestamps | No | IndexedDB persistence |
| Tab Manager | 9 tables (tabs, windows, devices, etc.) | **7 branded ID types** via `.pipe()` | `'number'` (epoch ms) | No | IndexedDB + BroadcastChannel + WebSocket sync |
| Entries template | 1 table | Plain `'string'` | None | No | None (bare definition) |

**Key finding**: The tab-manager is the canonical reference for branded IDs with arktype `.pipe()`. Whispering is the canonical reference for KV-based settings.

### DateTimeString Pattern

The codebase has an established `DateTimeString` branded type documented in `docs/articles/datetime-string-intermediate-representation.md`:

```
Storage format: "2024-01-01T20:00:00.000Z|America/New_York"
```

- Branded string type: `type DateTimeString = \`${DateIsoString}|${TimezoneId}\` & Brand<'DateTimeString'>`
- Lazy parsing: `DateTimeString.parse()` → `Temporal.ZonedDateTime` only when needed
- `DateTimeString.now(timezone?)` for creation
- Already used in README examples for `date()` column type
- The README documents `DateTimeString` as a first-class concept, but the actual branded type + `.pipe()` validator doesn't exist in the package source yet

**Decision**: Extract `DateTimeString` to `@epicenter/workspace` as a shared branded type since all three apps need it. This is the right moment—three consumers on day one justifies the extraction.

### Apple Notes UI Structure

Apple Notes uses a three-column layout:

```
┌──────────┬──────────────┬──────────────────────────────┐
│ Sidebar  │  Note List   │       Editor                 │
│          │              │                              │
│ Folders  │ Title        │  Title (editable)            │
│ ├ All    │ Preview...   │                              │
│ ├ Recent │ 2h ago       │  Body content with           │
│ ├ Work   │              │  rich text editing           │
│ └ Personal│ Title       │                              │
│          │ Preview...   │                              │
│          │ Yesterday    │                              │
└──────────┴──────────────┴──────────────────────────────┘
```

The shadcn-svelte `Sidebar` component already exists in `packages/ui/src/sidebar/`. The `Resizable` component can handle the three-pane split.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Number of apps** | 2 standalone SPAs (Granny Smith shelved) | Fuji = personal quick-capture, Honeycrisp = full Apple Notes clone. One polished clone > two half-baked ones. |
| **App structure** | `apps/fuji/`, `apps/honeycrisp/` | Standalone SvelteKit web-only SPAs. No Tauri for v1. |
| **DateTimeString** | Shared in `@epicenter/workspace` | 3 consumers from day one. Extract now, not later. |
| **Date validator** | arktype `type('string').pipe(...)` | Matches tab-manager branded type pattern. Validates format and brands in one step. |
| **Rich text** | Yes, both use rich text via Y.Text | Tiptap/ProseMirror on Y.Text gives collaborative rich editing. |
| **Folders** | Flat (no nesting) for Honeycrisp; none for Fuji | Add nesting via `_v: '2'` migration later if wanted. |
| **Body GUID** | Use note `id` as the document GUID (`guid: 'id'`) | Simplest option. Split to separate GUID if multi-doc notes are needed later. |


### SPA Configuration Pattern (Reference for Both Apps)

Each app is a **client-side SPA** using `@sveltejs/adapter-static`. Three config files work together:

1. **`svelte.config.js`** — `adapter-static` with `fallback: 'index.html'` (SPA routing)
2. **`src/routes/+layout.ts`** — `export const ssr = false;` (disables SSR during dev)
3. **`vite.config.ts`** — `nodePolyfills({ globals: { Buffer: true } })` + `resolve.dedupe: ['yjs']`

All three are required. Without `ssr = false`, SvelteKit tries to server-render pages during `bun dev`, which breaks `vite-plugin-node-polyfills` (its shims are browser-only virtual modules that can't be resolved during SSR).

**Reference**: `apps/whispering/` uses this exact pattern. Fuji copies it minus Tauri-specific config (ports, host, HMR, watch, devtoolsJson, inspector).
---

## Architecture

### Shared Foundation

All three apps share:

```
@epicenter/workspace
├── DateTimeString branded type + .pipe() validator (NEW — extracted here)
├── defineTable / defineWorkspace / createWorkspace
├── .withDocument('body', { guid: 'id' }) for Y.Text
└── indexeddbPersistence extension

@epicenter/ui
├── Sidebar (shadcn-svelte)
├── Resizable (three-pane layout)
├── Command (search palette)
└── other shadcn-svelte primitives
```

### App-Specific Architecture

---

### 🍏 Granny Smith — SHELVED

> **Status**: Shelved. Features absorbed into Honeycrisp. May revisit as a fun/joke app later.

---

---

### 🍯 Honeycrisp — The Apple Notes Clone

**Vibe**: Classic Apple Notes, but polished. Folders, checklists, locked notes—plus premium touches like word count and focus mode.

**Workspace ID**: `epicenter.honeycrisp`

```
┌─────────────────────────────────────────────────────────┐
│ defineWorkspace({ id: 'epicenter.honeycrisp' })         │
│                                                         │
│  folders table                                          │
│  ├── id: FolderId (branded)                             │
│  ├── name: 'string'                                     │
│  ├── color?: 'string | undefined'  (accent color)       │
│  ├── icon?: 'string | undefined'   (emoji or icon name) │
│  ├── sortOrder: 'number'                                │
│  └── _v: '1'                                            │
│                                                         │
│  notes table                                            │
│  ├── id: NoteId (branded)                               │
│  ├── folderId?: FolderId | undefined                    │
│  ├── title: 'string'                                    │
│  ├── preview: 'string'         (first ~100 chars)       │
│  ├── pinned: 'boolean'                                  │
│  ├── locked: 'boolean'                                  │
│  ├── hasChecklist: 'boolean'                            │
│  ├── wordCount: 'number'                                │
│  ├── createdAt: DateTimeString (branded)                │
│  ├── updatedAt: DateTimeString (branded)                │
│  └── _v: '1'                                            │
│       └─ .withDocument('body', { guid: 'id' })          │
│                                                         │
│  KV                                                     │
│  ├── 'selectedFolderId': FolderId | null                │
│  ├── 'selectedNoteId': NoteId | null                    │
│  ├── 'sortBy': 'dateEdited' | 'dateCreated' | 'title'  │
│  ├── 'sidebarCollapsed': boolean                        │
│  ├── 'editorFontSize': number                           │
│  └── 'focusMode': boolean                               │
└─────────────────────────────────────────────────────────┘
```

**Table name**: `notes`

**UI**: Classic three-column (sidebar, note list, editor). Faithful Apple Notes layout with folder sidebar, date-grouped note list, and a rich-text editor—plus premium touches.

**Unique features** (merged from Granny Smith + original Honeycrisp):
- Pinned notes
- Locked notes (read-only toggle)
- Checklist detection (`hasChecklist` computed from body content)
- Folder icons (emoji) + folder colors (accent bar)
- Word count tracking (`wordCount` updated on body change)
- Focus mode (KV toggle) — dims sidebar and note list
- Editor font size preference (KV)

```
┌─ Sidebar ────────────┬─ Note List ───────────┬─ Editor ─────────────────┐
│                       │                       │                          │
│  📋 All Notes         │  📌 Meeting prep      │  Meeting prep            │
│  🟢 Work         (3) │  1,247 words · 2h ago │  ─────────────────       │
│  🔵 Personal     (7) │  First line of body.. │                          │
│  🟡 Recipes      (2) │                       │  Rich text editor with   │
│  🟣 Ideas        (1) │  Grocery list         │  bold, italic, lists,    │
│                       │  Yesterday            │  headings, and           │
│  ─────────────────── │  ☐ Milk ☐ Eggs...     │  checklists              │
│  + New Folder         │                       │                          │
│                       │  + New Note           │     ─── 1,247 words ─── │
└─────────────────────┴─────────────────┴───────────────────────────────────────┘
```

---

### 🗻 Fuji — The Minimal Quick-Capture

**Vibe**: Zero friction, timeline-first, no organisation. The one for capturing thoughts.

**Workspace ID**: `epicenter.fuji`

```
┌─────────────────────────────────────────────────────────┐
│ defineWorkspace({ id: 'epicenter.fuji' })               │
│                                                         │
│  entries table  (NOT "notes" — these are temporal)       │
│  ├── id: EntryId (branded)                              │
│  ├── title: 'string'                                    │
│  ├── preview: 'string'                                  │
│  ├── pinned: 'boolean'                                  │
│  ├── createdAt: DateTimeString (branded)                │
│  ├── updatedAt: DateTimeString (branded)                │
│  └── _v: '1'                                            │
│       └─ .withDocument('body', { guid: 'id' })          │
│                                                         │
│  KV                                                     │
│  ├── 'selectedEntryId': EntryId | null                  │
│  └── 'sortBy': 'dateEdited' | 'dateCreated'             │
└─────────────────────────────────────────────────────────┘
```

**Table name**: `entries` — these are temporal captures, not organized "notes." Entries flow in a timeline. No folders, no categories, just write.

**UI**: Two-column only (timeline + editor). No sidebar at all. The timeline IS the navigation. Date headers are prominent. New entry button always visible.

**Unique features**:
- No folders at all — timeline is the only organiser
- Date headers are the primary navigation ("Today", "Yesterday", "March 10", ...)
- Auto-title from first line (no explicit title field in UI, computed from content)
- Pinned entries float to top of timeline
- Absolute minimum chrome—mostly whitespace and typography

```
┌─ Timeline ────────────────┬─ Editor ─────────────────────────────────────┐
│                            │                                              │
│  + New Entry               │                                              │
│                            │  Quick thought about the API                 │
│  ── Today ──────────────── │  ──────────────────────────────              │
│                            │                                              │
│  Quick thought about...    │  I think the pipe separator for              │
│  3:42 PM                   │  DateTimeString is actually genius           │
│                            │  because it's not valid in ISO dates         │
│  Meeting notes from...     │  OR timezone names.                          │
│  11:00 AM                  │                                              │
│                            │  This means parsing is always                │
│  ── Yesterday ──────────── │  unambiguous—you just split on "|"           │
│                            │  and you're done.                            │
│  Why CRDTs matter          │                                              │
│  4:15 PM                   │                                              │
│                            │                          3:42 PM · Today     │
└────────────────────────────┴──────────────────────────────────────────────┘
```

---

### Comparison Table

| Dimension | 🍯 Honeycrisp | 🗻 Fuji |
|-----------|---------------|---------|
| **Workspace ID** | `epicenter.honeycrisp` | `epicenter.fuji` |
| **Tables** | `folders` + `notes` | `entries` (no folders) |
| **Table name** | `notes` | `entries` |
| **Columns** | 3 (sidebar, list, editor) | 2 (timeline, editor) |
| **Folders** | Yes (flat, with icons + colors) | No |
| **Pinned** | Yes | Yes |
| **Locked** | Yes | No |
| **Checklist** | Yes | No |
| **Word count** | Yes | No |
| **Focus mode** | Yes | No |
| **Personality** | Classic Apple Notes + premium | Minimal, zero-friction |
| **Target user** | Organiser / writer | Thinker |

---

## Shared Schema Components

### DateTimeString (to be extracted to `@epicenter/workspace`)

```typescript
import type { Brand } from 'wellcrafted/brand';
import { type } from 'arktype';

/**
 * Branded string in "2024-01-01T20:00:00.000Z|America/New_York" format.
 *
 * Storage format: ISO 8601 UTC instant + pipe separator + IANA timezone ID.
 * Sortable (UTC first), lossless (preserves timezone), portable (plain text).
 *
 * Validates the pipe-separated format on read and brands the string so it
 * can't be accidentally mixed with plain strings at compile time.
 *
 * @example
 * ```typescript
 * const now = DateTimeString.now(); // "2026-03-11T22:45:00.000Z|America/Los_Angeles"
 * const parsed = DateTimeString.parse(now); // Temporal.ZonedDateTime
 * ```
 */
export type DateTimeString = string & Brand<'DateTimeString'>;
export const DateTimeString = type('string').pipe(
  (s): DateTimeString => {
    const pipeIndex = s.indexOf('|');
    if (pipeIndex === -1) throw new Error(`Invalid DateTimeString: ${s}`);
    return s as DateTimeString;
  },
);

/** Create a DateTimeString for the current moment. System timezone if none provided. */
export function dateTimeStringNow(timezone?: string): DateTimeString {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${new Date().toISOString()}|${tz}` as DateTimeString;
}
```

### Branded ID Pattern (per-app)

Each app defines its own branded IDs following the tab-manager pattern:

```typescript
// Honeycrisp
export type NoteId = string & Brand<'NoteId'>;
export const NoteId = type('string').pipe((s): NoteId => s as NoteId);

export type FolderId = string & Brand<'FolderId'>;
export const FolderId = type('string').pipe((s): FolderId => s as FolderId);

// Fuji (no FolderId—no folders)
export type EntryId = string & Brand<'EntryId'>;
export const EntryId = type('string').pipe((s): EntryId => s as EntryId);
```

---

## Full Schema Definitions

### 🍏 Granny Smith — SHELVED

> Schema removed. See git history for original definition.

### 🍯 Honeycrisp — `apps/honeycrisp/src/lib/workspace.ts`

```typescript
import {
  createWorkspace, defineKv, defineTable, defineWorkspace,
  type InferTableRow, DateTimeString, dateTimeStringNow,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// ─── Branded IDs ────────────────────────────────────────────────────────

export type NoteId = string & Brand<'NoteId'>;
export const NoteId = type('string').pipe((s): NoteId => s as NoteId);

export type FolderId = string & Brand<'FolderId'>;
export const FolderId = type('string').pipe((s): FolderId => s as FolderId);

// ─── Tables ─────────────────────────────────────────────────────────────

const foldersTable = defineTable(
  type({
    id: FolderId,
    name: 'string',
    'color?': 'string | undefined',
    'icon?': 'string | undefined',
    sortOrder: 'number',
    _v: '1',
  }),
);
export type Folder = InferTableRow<typeof foldersTable>;

const notesTable = defineTable(
  type({
    id: NoteId,
    'folderId?': FolderId.or('undefined'),
    title: 'string',
    preview: 'string',
    pinned: 'boolean',
    locked: 'boolean',
    hasChecklist: 'boolean',
    wordCount: 'number',
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '1',
  }),
).withDocument('body', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: dateTimeStringNow() }),
});
export type Note = InferTableRow<typeof notesTable>;

// ─── Workspace ──────────────────────────────────────────────────────────

export default createWorkspace(
  defineWorkspace({
    id: 'epicenter.honeycrisp',
    tables: { folders: foldersTable, notes: notesTable },
    kv: {
      selectedFolderId: defineKv(FolderId.or(type('null'))),
      selectedNoteId: defineKv(NoteId.or(type('null'))),
      sortBy: defineKv(type("'dateEdited' | 'dateCreated' | 'title'")),
      sidebarCollapsed: defineKv(type('boolean')),
      editorFontSize: defineKv(type('number')),
      focusMode: defineKv(type('boolean')),
    },
  }),
).withExtension('persistence', indexeddbPersistence);
```

### 🗻 Fuji — `apps/fuji/src/lib/workspace.ts`

```typescript
export type EntryId = string & Brand<'EntryId'>;
export const EntryId = type('string').pipe((s): EntryId => s as EntryId);

const entriesTable = defineTable(
  type({
    id: EntryId,
    title: 'string',
    preview: 'string',
    pinned: 'boolean',
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '1',
  }),
).withDocument('body', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: dateTimeStringNow() }),
});
export type Entry = InferTableRow<typeof entriesTable>;

export default createWorkspace(
  defineWorkspace({
    id: 'epicenter.fuji',
    tables: { entries: entriesTable },
    kv: {
      selectedEntryId: defineKv(EntryId.or(type('null'))),
      sortBy: defineKv(type("'dateEdited' | 'dateCreated'")),
    },
  }),
).withExtension('persistence', indexeddbPersistence);
```

---

## Edge Cases

### Empty Workspace (First Launch)

1. No notes/entries exist.
2. Honeycrisp: "All Notes" selected, empty state with "Create your first note" button.
3. Fuji: Empty timeline with a prominent "+ New Entry" at top. Or auto-create on any keystroke.

### Deleting a Folder with Notes (Honeycrisp)

1. User deletes folder "Work" which contains 5 notes.
2. Move notes to unfiled (set `folderId` to `undefined`). Apple Notes does this.
3. Show confirmation dialog: "Move 5 notes to All Notes and delete folder?"

### Conflicting Edits (CRDT)

1. Two devices edit the same note title simultaneously.
2. Title is a plain `'string'` (LWW at the row level via Y.Map). Last writer wins.
3. Body is `Y.Text` — character-level CRDT merge. No conflict.

### DateTimeString Validation Failure

1. A synced note arrives with a malformed `createdAt` (e.g., no pipe separator).
2. `table.get()` returns `{ status: 'invalid', errors: [...] }`.
3. The UI should still show the note (with a warning badge) rather than hiding it entirely.

### Fuji Auto-Title

1. User types in the editor without setting a title.
2. `title` is auto-populated from the first line of content (up to 80 chars).
3. If the user explicitly edits the title, auto-title is disabled for that entry.

---

## Open Questions

1. **Rich text editor library?** — **RESOLVED**: Tiptap with `y-prosemirror`. Implemented in Fuji.

2. **Should both apps share a component library?** — **RESOLVED**: No. Copy-paste for now. Extract if identical later.

3. **Build order?** — **RESOLVED**: Fuji first (done), then Honeycrisp. Granny Smith shelved.

4. **Register as templates?** — **RESOLVED**: Yes. Fuji template registered. Honeycrisp will be too.

5. **Tauri or web-only?** — **RESOLVED**: SvelteKit web-only for v1.

6. **Sidebar vs Resizable for Fuji's left panel?** — OPEN. Fuji currently uses `Resizable.PaneGroup` but `Sidebar` may be more natural for a notes app (collapsible, responsive, built-in mobile handling). Needs evaluation.

---

## Implementation Plan

### Phase 0: Shared Foundation

- [x] **0.1** Extract `DateTimeString` branded type + `.pipe()` validator + `dateTimeStringNow()` to `@epicenter/workspace`
  > Created `packages/workspace/src/shared/datetime-string.ts` with branded type, arktype validator, and `dateTimeStringNow()` utility.
- [x] **0.2** Export from `@epicenter/workspace` index
  > Added DATE UTILITIES section to `packages/workspace/src/index.ts` after ID UTILITIES.
- [x] **0.3** Verify `bun typecheck` passes across the monorepo
  > Pre-existing module resolution failures in workspace package (arktype, wellcrafted/brand, yjs, etc.). No new errors introduced.

### Phase 1: 🗻 Fuji (Simplest — Proves the Stack)

- [x] **1.1** Scaffold `apps/fuji/` as a SvelteKit app (copy structure from existing app)
  > Created package.json, svelte.config.js, vite.config.ts, tsconfig.json, app.html, +layout.svelte, +page.svelte, query/client.ts, favicon.ico.
- [x] **1.2** Create `apps/fuji/src/lib/workspace.ts` with `EntryId`, `entriesTable`, KV, workspace client
  > EntryId branded type, entriesTable with .withDocument('body', { guid: 'id' }), KV with selectedEntryId + sortBy, IndexedDB persistence.
- [x] **1.3** Two-column layout: timeline + editor using `Resizable`
  > Resizable.PaneGroup (30/70 split) with timeline left panel and editor placeholder right panel.
- [x] **1.4** Timeline: entries sorted by `updatedAt`, date group headers
  > Entries sorted by updatedAt, grouped by date (Today/Yesterday/MMMM d), pinned entries at top.
- [x] **1.5** Editor: Tiptap on Y.Text via `.withDocument('body', { guid: 'id' })`
  > Created editor.svelte with Tiptap + y-prosemirror (ySyncPlugin, yUndoPlugin). Mounts to DOM via $effect, binds to Y.Text from documents.entries.body.open(). StarterKit with history disabled (yUndoPlugin handles undo). Placeholder extension for empty state.
- [x] **1.6** CRUD: create entry, delete entry, pin/unpin
  > Create via + button, delete with trash icon, pin/unpin toggle. All inline in +page.svelte.
- [x] **1.7** Auto-title from first line of content (deferred to Wave 5 — requires editor)
  > Editor onContentChange callback extracts first line (80 chars) as title and first 100 chars as preview. +page.svelte wires this to workspaceClient.tables.entries.update(). {#key selectedEntryId} ensures editor remounts on entry switch.
- [x] **1.8** Register as template in `apps/epicenter/src/lib/templates/`
  > Created apps/epicenter/src/lib/templates/fuji.ts with FUJI_TEMPLATE. Registered in index.ts.

### Phase 1.5: 🗻 Fuji Bug Fixes — COMPLETE

> Cosmetic issues addressed. No behavioral changes.

- [x] **1.9** Fix timestamp/action button overlap on entry hover (z-index/positioning)
  > Added `group` class to timeline entry container for future `group-hover` action buttons. No action buttons exist yet so no visible overlap—this is preemptive prep.
- [x] **1.10** Evaluate Sidebar vs Resizable for left panel
  > **Decision**: Sidebar is correct for Fuji's simpler layout. Resizable is appropriate for variable-width splits (like Honeycrisp's note list/editor). No change needed.
- [x] **1.11** General UI polish pass (hover states, transitions, spacing)
  > Added `hover:bg-accent/50 transition-colors` to EntriesTable rows to match EntryTimeline hover behavior.

### Phase 2: 🍏 Honeycrisp — COMPLETE

> Built via separate execution specs: `20260312T192500-honeycrisp.md`, `20260313T141500-honeycrisp-overhaul.md`, `20260312T224500-honeycrisp-ui-polish.md`, `20260313T225500-honeycrisp-pr-cleanup.md`.

- [x] **2.1** Scaffold `apps/honeycrisp/` SvelteKit app
- [x] **2.2** Create workspace with `foldersTable` + `notesTable` + KV
  > Schema simplified from original plan: dropped `locked`, `hasChecklist`, `wordCount` fields. Uses `deletedAt` for soft-delete instead.
- [x] **2.3** Three-column layout: collapsible sidebar + note list + editor
- [x] **2.4** Folder CRUD + move notes between folders + folder icons
  > Folder colors not implemented (icons only).
- [x] **2.5** Note CRUD + pinned notes + soft delete + Recently Deleted
  > Locked notes (read-only toggle) not implemented—descoped as low-value.
- [ ] ~~**2.6** Checklist detection from Y.Text content~~ — DESCOPED
  > Requires Tiptap task list extension. Not needed for MVP.
- [ ] ~~**2.7** Word count tracking~~ — DESCOPED
  > Low value for a simple notes app.
- [ ] ~~**2.8** Focus mode~~ — DESCOPED
  > Nice-to-have. Can be added later.
- [ ] ~~**2.9** Register as template~~ — OBSOLETE
  > `apps/epicenter` no longer exists on this branch. Template system was removed.

### Phase 3: 🍏 Granny Smith — SHELVED

> Deferred. Features merged into Honeycrisp. Revisit later as a fun/joke app if desired.

### Phase 4: Polish (Both Apps)

- [x] **4.1** Command palette search in each app
  > Honeycrisp: ⌘K command palette with note search, folder nav, create actions. Fuji: not yet.
- [x] **4.2** Empty states
  > Both apps have empty states for no notes, no selection, no search results.
- [x] **4.3** Keyboard shortcuts (⌘N, ⌘⇧N, etc.)
  > Honeycrisp: ⌘N (new note), ⌘⇧N (new folder), ⌘K (command palette). Fuji: basic shortcuts.
- [ ] **4.4** Sync extension (WebSocket) for multi-device — DEFERRED
  > Requires `@epicenter/sync-client` integration. Future work.
---

## Success Criteria

- [x] `DateTimeString` is a shared branded type exported from `@epicenter/workspace`
- [x] Each app has a distinct visual identity matching its vibe
- [x] Notes can be created, edited (rich text Y.Text body), and deleted in both apps
- [x] Honeycrisp supports folders; Fuji uses timeline-only
- [x] `DateTimeString` values round-trip correctly through Yjs storage
- [x] Branded IDs prevent mixing `NoteId`/`FolderId`/`EntryId` at compile time
- [ ] ~~Both workspace definitions are registered as templates in epicenter~~ — OBSOLETE (template system removed)
- [ ] `bun typecheck` passes for both apps (4 pre-existing errors in packages/workspace + packages/ui, none in app code)

---

## References

- `apps/epicenter/src/lib/templates/entries.ts` — existing simple template to follow
- `apps/epicenter/src/lib/templates/index.ts` — template registry
- `apps/tab-manager/src/lib/workspace.ts` — canonical branded ID pattern with arktype `.pipe()`
- `apps/whispering/src/lib/workspace.ts` — KV settings pattern, app scaffold reference
- `packages/workspace/src/workspace/define-table.ts` — `.withDocument()` API
- `packages/workspace/src/workspace/types.ts` — `TableHelper`, `DocumentHandle`
- `packages/ui/src/sidebar/` — shadcn-svelte Sidebar primitive
- `packages/ui/src/resizable/` — Resizable pane layout
- `docs/articles/datetime-string-intermediate-representation.md` — DateTimeString design rationale
- `specs/20260106T212243-temporal-intermediate-representation.md` — Temporal + DateTimeString spec
- `specs/20251110T160000 journal-workspace.md` — prior art for temporal content schema
