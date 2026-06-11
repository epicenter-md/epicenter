# Opensidian Command Palette Search

**Date**: 2026-04-06
**Status**: Implemented
**Author**: AI-assisted

## Overview

Wire opensidian's command palette to search file content via the existing `sqliteIndex.search()` FTS5 engine, add a three-state scope toggle (names / content / both), and display snippets with highlighted matches.

## Motivation

### Current State

The command palette collects all files via `fsState.walkTree()` and passes them to `CommandPalette` which uses bits-ui's built-in substring filter:

```svelte
<!-- apps/opensidian/src/lib/components/AppShell.svelte -->
const allFiles = $derived.by((): FileEntry[] => {
  if (!paletteOpen) return [];
  return fsState.walkTree<FileEntry>((id, row) => {
    if (row.type === 'file') {
      const fullPath = fsState.getPath(id) ?? '';
      const lastSlash = fullPath.lastIndexOf('/');
      const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
      return { collect: { id, name: row.name, parentDir }, descend: false };
    }
    return { descend: true };
  });
});
```

This creates problems:

1. **No content search.** Users can only find files by name, not by what's written inside them. "Find the note where I wrote about X" requires opening files one by one.
2. **No ranking.** Results appear in tree-walk order, not relevance order. The first result for "meeting" might be deep in an archive folder.
3. **Scales linearly.** Every palette open re-walks the entire file tree. At 10,000+ files this becomes noticeable.

### Desired State

```
┌──────────────────────────────────────────────────────┐
│  🔍 [standup_____________________________]          │
│                                                      │
│  ○ File names    ○ File content    ● Both            │
│                                                      │
│  📄 standup-template.md              ← name match    │
│     templates                                        │
│                                                      │
│  📄 meeting-notes.md                 ← content match │
│     docs/work                                        │
│     ...discussed the <mark>standup</mark> format...  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Content matches show an FTS5 snippet with `<mark>` highlighted terms. Name matches show path only. Both are sorted. Name matches first (exact intent), then content matches (ranked by FTS5 relevance).

## Research Findings

### Tab-manager search pattern

Tab-manager has toggles for **Match Case**, **Use Regex**, **Match Whole Word**, and a **field scope** dropdown (All/Title/URL). These are persisted to storage and mutually exclusive (regex ↔ whole-word).

**Key finding**: The regex and whole-word toggles don't translate to FTS5. FTS5 uses its own query syntax (MATCH expressions, prefix queries with `*`, phrase queries with `"..."`, boolean AND/OR/NOT). Case sensitivity isn't configurable in FTS5. Whole-word is the FTS5 default (it tokenizes on word boundaries).

**Implication**: Don't port tab-manager's toggles directly. The only meaningful toggle for opensidian is the **search scope**: what fields to search against.

### Existing sqliteIndex.search()

The filesystem sqlite-index already implements FTS5 search with snippets:

```typescript
// packages/filesystem/src/extensions/sqlite-index/index.ts
async function search(query: string): Promise<SearchResult[]> {
  const result = await client.execute({
    sql: `SELECT fts.file_id, f.name, f.path,
            snippet(files_fts, 2, '<mark>', '</mark>', '...', 64) AS snippet
          FROM files_fts fts
          JOIN files f ON f.id = fts.file_id
          WHERE files_fts MATCH ?
          ORDER BY rank LIMIT 50`,
    args: [trimmed],
  });
  // returns { id, name, path, snippet }
}
```

This searches both `name` and `content` columns simultaneously (FTS5 matches across all indexed columns by default).

**Key finding**: To search ONLY names or ONLY content, FTS5 supports column filters: `name:standup` searches only the name column. `content:standup` searches only content. The unqualified `standup` searches both.

### CommandPalette component

`CommandPalette` from `@epicenter/ui` accepts `items: CommandPaletteItem[]` and uses bits-ui's `Command` primitive for filtering. It supports `shouldFilter={false}` to disable built-in filtering. This is how we'll take over with FTS5.

`CommandPaletteItem` already has `description` (for path), `icon` (for file type icon), and `keywords` (for extra search tokens). It doesn't currently have a `snippet` field for HTML content.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Search scope toggle | Three radio buttons: Names / Content / Both | Only meaningful search dimension. Regex/case/whole-word don't apply to FTS5. |
| Default scope | "Both" | Most useful default. User doesn't need to know where the text lives. |
| Name-only search | Keep using `walkTree` + in-memory filter | Instant, no async, no SQLite dependency. FTS5 tokenization isn't ideal for filename matching (splits on dots, hyphens). |
| Content-only search | `sqliteIndex.search()` with `content:` prefix | FTS5 column filter restricts to content only. |
| Both search | Merge name matches + FTS content matches | Name matches first (exact intent), then FTS content matches (ranked). Dedupe by file ID. |
| Debounce | 150ms for content/both modes, none for name mode | Content search hits SQLite. Debounce prevents thrashing. Name search is instant. |
| Snippet display | Extend `CommandPaletteItem` with optional `snippet` field | Render below description as muted HTML. |
| shouldFilter | `false` when scope is Content or Both | We manage filtering ourselves. `true` for Names mode (bits-ui handles it). |
| Result limit | 50 for FTS, unlimited for names (bits-ui truncates visually) | FTS5 LIMIT 50 matches the existing search. Names are cheap to render. |
| Persist scope preference | `localStorage` via state rune | Match tab-manager's `createStorageState` pattern. |

## Architecture

### Data flow by search scope

```
┌─────────────────────────────────────────────────────────────────┐
│  User types in palette input                                    │
│  Scope: ○ Names   ○ Content   ● Both                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────────┐
            ▼                   ▼                       ▼
     Names only          Content only              Both
     ───────────         ─────────────          ──────────
     walkTree()          sqliteIndex             walkTree()
     in-memory             .search()            + sqliteIndex
     filter              (debounced)              .search()
     (instant)                                  (debounced)
            │                   │                       │
            ▼                   ▼                       ▼
     CommandPalette      CommandPalette          CommandPalette
     shouldFilter=true   shouldFilter=false      shouldFilter=false
     (bits-ui filters)   (we provide items)      (merged + deduped)
```

### Component changes

```
apps/opensidian/src/lib/components/AppShell.svelte
  └── CommandPalette  (from @epicenter/ui)
        ├── Scope toggle (new: 3 radio buttons above input)
        ├── Command.Input  (existing)
        └── Command.List
              ├── Name matches group (file icon + name + path)
              └── Content matches group (file icon + name + path + snippet)
```

### New/modified files

| File | Change |
|---|---|
| `apps/opensidian/src/lib/state/search-state.svelte.ts` | **NEW**: search scope preference, debounced FTS query, merged results |
| `apps/opensidian/src/lib/components/AppShell.svelte` | Wire new search state, pass scope toggle, use `shouldFilter={false}` for content/both |
| `packages/ui/src/command-palette/command-palette.svelte` | Add optional `snippet` rendering + slot/prop for header content (scope toggle) |
| `packages/ui/src/command-palette/index.ts` | Extend `CommandPaletteItem` with optional `snippet: string` |

## Implementation Plan

### Phase 1: Extend CommandPalette to support snippets and header content

- [x] **1.1** Add optional `snippet?: string` to `CommandPaletteItem` type
- [x] **1.2** Render snippet below description in `command-palette.svelte`: use `{@html snippet}` since FTS5 returns `<mark>` tags. Sanitize with a simple allowlist (only `<mark>` and text).
- [x] **1.3** Add `headerContent` snippet prop to `CommandPalette`: rendered between the title area and the input. This is where the scope toggle goes.

### Phase 2: Create search state for opensidian

- [x] **2.1** Create `apps/opensidian/src/lib/state/search-state.svelte.ts` with:
  - `searchScope: 'names' | 'content' | 'both'`: persisted to localStorage via `createPersistedState`
  - `searchQuery: string`: bound to palette input
  - `searchResults: CommandPaletteItem[]`: derived from scope + query
- [x] **2.2** Implement name search: filter `fsState.walkTree()` results by substring match on file name. No debounce.
- [x] **2.3** Implement content search: call `workspace.extensions.sqliteIndex.search(query)` with 150ms debounce. Map `SearchResult` → `CommandPaletteItem` with snippet.
- [x] **2.4** Implement "both" search: run name search (instant) + content search (debounced) in parallel. Merge results: name matches first, then content matches. Deduplicate by file ID (name match wins if both return same file).

### Phase 3: Wire into AppShell

- [x] **3.1** Replace current `allFiles`/`fileItems` derivation with `searchState.searchResults`
  > **Note**: Kept `allFileItems` for names-only mode since bits-ui needs all items to filter from internally.
- [x] **3.2** Add scope toggle UI (segmented control, not radio buttons) via `headerContent` snippet
- [x] **3.3** Set `shouldFilter={false}` when scope is "content" or "both" (we manage filtering). Set `shouldFilter` to default (true) for "names" mode.
- [x] **3.4** Bind `value` to `searchState.searchQuery` for debounced FTS queries

### Phase 4: Polish

- [ ] **4.1** ~~Keyboard shortcut to cycle scope~~: Removed. Cmd+Shift+F conflicts with standard "Find in Files" convention. The segmented control is more discoverable.
  > **Note**: Scope toggle UI was upgraded from custom buttons to shadcn-svelte `ToggleGroup` component.
- [x] **4.2** Empty state messages per scope ("No files found." / "No content matches." / "No results.")
- [x] **4.3** Loading indicator for content search ("Searching…" text shown during debounce + FTS query)

## Edge Cases

### FTS5 query syntax errors

1. User types `local-first` (hyphen = NOT operator in FTS5)
2. `sqliteIndex.search()` catches the error and returns `[]`
3. The palette shows "No content matches": no crash

### Large vaults (10,000+ files)

1. Name search walks entire tree synchronously
2. Could become slow at extreme sizes
3. **Mitigation**: walkTree already skips trashed files. If needed, cache the file list and invalidate on observer callback instead of re-walking on every keystroke.

### sqliteIndex not ready yet

1. User opens palette before `sqliteIndex.whenReady` resolves
2. Content search returns empty (the search function awaits whenReady internally)
3. Name search still works immediately

### Empty content column

1. Folders have `content = null` in the index
2. FTS still indexes folder names (inserted with `content ?? ''`)
3. Folder results will have no snippet: show path only

## Open Questions

1. **Should the scope toggle be radio buttons or a segmented control?**
   - Options: (a) Radio buttons, (b) Segmented control (like a button group), (c) Dropdown
   - **Recommendation**: Segmented control: more compact, visually distinct states, fits the palette width

2. **Should content search debounce on the first character or require a minimum length?**
   - Options: (a) Debounce from first char, (b) Require 2+ chars for content, (c) Require 3+ chars
   - **Recommendation**: Require 2+ chars for content/both mode. Single-character FTS queries return too many results to be useful.

3. **Should snippet HTML be sanitized before rendering with `{@html}`?**
   - The snippets come from SQLite FTS5 `snippet()` function which only adds `<mark>` tags to the matched terms. The source content is user-authored (file content).
   - **Recommendation**: Yes, sanitize. Strip everything except `<mark>` and `</mark>` tags. The content itself could contain HTML if the user has HTML files.

## Success Criteria

- [ ] User can search file names (instant, no SQLite needed)
- [ ] User can search file content (FTS5, debounced, shows snippets)
- [ ] User can search both simultaneously (merged results)
- [ ] Scope preference persists across sessions
- [ ] FTS5 syntax errors don't crash the palette
- [ ] Content matches show highlighted snippet text

## References

- `apps/opensidian/src/lib/components/AppShell.svelte`: current palette wiring
- `apps/opensidian/src/lib/state/fs-state.svelte.ts`: walkTree and getPath
- `packages/filesystem/src/extensions/sqlite-index/index.ts`: existing FTS5 search
- `packages/ui/src/command-palette/command-palette.svelte`: palette component
- `packages/ui/src/command-palette/index.ts`: CommandPaletteItem type
- `apps/tab-manager/src/lib/state/search-preferences.svelte.ts`: localStorage persistence pattern for search toggles
- `apps/tab-manager/src/lib/state/unified-view-state.svelte.ts`: search filter implementation reference

## Review

**Completed**: 2026-04-06
**Branch**: feat/fix-dashboard

### Summary

Implemented FTS5-powered content search in opensidian's command palette with a three-mode scope toggle (Names / Content / Both). Name search remains instant via in-memory `walkTree` filtering. Content search debounces at 150ms and queries the existing `sqliteIndex.search()` FTS5 engine, returning snippets with `<mark>`-highlighted match terms. "Both" mode merges name matches (first) with content matches (deduped by file ID).

### Deviations from Spec

- **Segmented control instead of radio buttons**: per Open Question #1 resolution, used styled button group instead of radio inputs.
- **`allFileItems` retained for names mode**: bits-ui's built-in filter needs the full item list to filter from, so we kept a walkTree-based derivation that only runs in names mode. The spec implied replacing `allFiles` entirely, but this was necessary for the `shouldFilter=true` path.
- **"Searching…" text instead of spinner**: used plain text indicator for the loading state rather than importing the Spinner component. Keeps the palette lightweight.

### Follow-up Work

- Consider caching the file list for names mode (invalidate on observer callback) for large vaults with 10,000+ files.
- The FTS5 column filter syntax (`content:query`) doesn't support phrases: may need query escaping for complex searches.
- Could add a visual indicator showing which result came from name vs content match in "Both" mode.
