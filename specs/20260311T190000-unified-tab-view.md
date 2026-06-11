# Unified Tab View with Search, Commands, and Bookmarks

**Date**: 2026-03-11
**Status**: Draft
**Author**: AI-assisted

## Overview

Restructure the tab manager's side panel from a 3-tab layout (Tabs, Saved, AI) into a unified scrollable view. Open tabs and saved-for-later tabs merge into one virtualized list. A search input at the top filters tabs instantly, while dedicated `⌘` and `⚡` buttons open a command palette and AI drawer respectively. Keeping each feature in its own clear surface. Quick actions like duplicate removal run via the command palette. A new "bookmarks" concept adds permanent, non-consumable URL references.

## Motivation

### Current State

The side panel has three top-level tabs:

```svelte
<!-- App.svelte -->
<Tabs.Root value="windows" class="flex flex-col h-full">
  <Tabs.List class="mt-2 w-full">
    <Tabs.Trigger value="windows">Tabs</Tabs.Trigger>
    <Tabs.Trigger value="saved">Saved</Tabs.Trigger>
    <Tabs.Trigger value="ai">AI</Tabs.Trigger>
  </Tabs.List>
  <!-- ... three separate Content panes ... -->
</Tabs.Root>
```

Each lives in its own `Tabs.Content`, rendered by separate components (`FlatTabList`, `SavedTabList`, `AiChat`).

This creates problems:

1. **Context switching to find things.** To check saved tabs, you leave the tabs view. To ask AI about tabs, you leave both. There's no way to see open tabs and saved tabs at the same time.
2. **No search.** The only way to find a tab is scrolling or asking AI (which requires switching to the AI tab). With 50+ tabs across windows, this is painful. The `tabs.search` AI query exists in `workspace.ts` but has no direct UI.
3. **No quick actions.** Duplicate removal, "close all by domain," and "group by domain" have no UI. The AI can do some of these, but it's slow for simple operations.
4. **AI is hidden.** Chat lives behind a tab switch. Users can't ask AI about their tabs while looking at them. The AI chat is a tool, not a content view. It shouldn't compete for the same slot.
5. **Tab bar won't scale.** Adding bookmarks, sessions, or settings as more top-level tabs would overflow the narrow side panel.

### Desired State

- One scrollable view with collapsible sections (open tabs, saved for later, bookmarks)
- A search input at the top: plain text = instant filter across all sections
- A `⌘` button next to search to open a command palette overlay (dedup, group, close by domain)
- A `⚡` button next to search to open an AI drawer, usable while viewing tabs
- Hidden power-user shortcuts: `/` in empty input opens commands, `@` opens AI (discoverable via tooltips)
- Bookmarks as a permanent, non-consumable counterpart to "save for later"

## Research Findings

### Save for Later vs Bookmarks

| Dimension | Save for Later (`savedTabs`) | Bookmarks (proposed) |
|---|---|---|
| On save | Closes the browser tab | Tab stays open |
| On open/use | Opens tab + **deletes** record | Opens tab, record **persists** |
| Lifetime | Consumed on restore | Permanent |
| Organization | Flat list by time | Flat list initially, folders later |
| Cross-device | Yes (Yjs CRDT) | Yes (same Yjs pattern) |

**Key finding:** The current `savedTabs` model is a transient parking lot: `save` closes the tab, `restore` deletes the record. This is semantically distinct from bookmarks, which persist indefinitely. Both are needed.

**Implication:** Bookmarks need a new table (`bookmarks`) with no delete-on-open semantics. The `savedTabs` table and state module stay unchanged.

### Unified Search/Command Patterns

| App | Pattern | Behavior |
|---|---|---|
| Arc | Single URL bar | Plain text = search, URLs = navigate |
| Raycast | Single input | Text = search, commands via keyword |
| VS Code | `Ctrl+K` | Command palette with `>` prefix for commands |
| Linear | `Ctrl+K` | Search + commands in one overlay |
| Notion | `/` slash commands | In-document command palette |

**Key finding:** Three specialist agents (visual-engineering, Oracle, librarian) independently evaluated three approaches and unanimously rejected prefix-based mode switching for a narrow (360px) side panel. Prefixes are undiscoverable, create ambiguity ("close youtube tabs" = filter or AI command?), and impose cognitive overhead of choosing a mode before typing.

**Winning approach (C+):** The search input has ONE job. Plain text filtering. Commands and AI live behind dedicated buttons (`⌘` and `⚡`) next to the input. This gives each feature its own clear surface: filter is inline, commands are an overlay (using existing `@epicenter/ui/command`), and AI is a drawer. Hidden power-user shortcuts (`/` and `@` in an empty input) exist for keyboard-heavy users but are not the primary interaction.

**Implication:** Use a plain search input + two icon buttons in the header bar. No prefix detection in the input itself. Prefixes are handled as shortcuts that open the appropriate surface.
### Existing Infrastructure

Already available in the codebase:

| Component | Location | Status |
|---|---|---|
| `Command` palette (Dialog, Input, List, Item, Group) | `@epicenter/ui/command` | ✅ Exists, unused in tab manager |
| `ConfirmationDialog` | `@epicenter/ui/confirmation-dialog` | ✅ Already used |
| `VList` (virtualized list) | `virtua/svelte` | ✅ Used in FlatTabList, SavedTabList |
| `tabs.search` AI query | `workspace.ts` | ✅ Searches by URL/title |
| `browserState` reactive state | `browser-state.svelte.ts` | ✅ All tab data in SvelteMaps |
| `savedTabState` reactive state | `saved-tab-state.svelte.ts` | ✅ All saved tabs |
| `aiChatState` multi-conversation chat | `chat-state.svelte.ts` | ✅ Full AI chat system |
| `CollapsibleSection` component | `CollapsibleSection.svelte` | ✅ Exists |

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Merge tabs + saved into one view | Yes | Eliminates context switching; both are "my tabs" (live vs parked) |
| AI as slide-over drawer | Drawer, not tab | AI is a tool used across contexts; shouldn't replace the content view |
| Command palette trigger | `⌘` button next to search input | Dedicated button is always visible and discoverable; hidden `/` shortcut for power users |
| AI trigger | `⚡` button next to search input | Dedicated button avoids mode confusion; hidden `@` shortcut for power users |
| Bookmarks table | New `bookmarks` Yjs table | Permanent URLs need different semantics than consumable `savedTabs` |
| Bookmarks organization | Flat list (v1), folders later | Simplest first; tags/folders are a future enhancement |
| Quick actions execution | Functions that read `browserState` + call browser APIs | Same pattern as existing `commands/actions.ts`; AI can also call them |
| Unified input placement | Top of side panel, always visible | Highest-value real estate; replaces the h1 header |
| Filter behavior | Instant client-side, no API call | Tabs are already in `browserState` SvelteMaps; filtering is O(n) |
| Search result rendering | Filter existing VList items | Simpler than a separate results list; shows results in context |
| Remove duplicate mechanism | `/dedup` command with confirmation dialog | Occasional action, not a permanent button; keeps UI clean |
| VList item model | Discriminated union with `kind` field | Matches existing `FlatTabList` pattern; extend with new kinds |

## Architecture

### Unified Flat Item Model

The current `FlatTabList` uses a two-variant discriminated union:

```typescript
// Current
type FlatItem =
  | { kind: 'window'; window: Window }
  | { kind: 'tab'; tab: Tab };
```

The unified view extends this to cover all sections:

```typescript
// Proposed
type FlatItem =
  | { kind: 'section-header'; section: 'open-tabs' | 'saved' | 'bookmarks'; label: string; count: number }
  | { kind: 'window-header'; window: Window }
  | { kind: 'tab'; tab: Tab }
  | { kind: 'saved-tab'; savedTab: SavedTab }
  | { kind: 'bookmark'; bookmark: Bookmark };
```

### Flat Item Derivation (pseudocode)

```
flatItems = $derived(() => {
  const items: FlatItem[] = [];

  // ── Open Tabs section ──
  items.push({ kind: 'section-header', section: 'open-tabs', ... });
  if (expanded.has('open-tabs')) {
    for (window of browserState.windows) {
      items.push({ kind: 'window-header', window });
      if (expanded.has(window.id)) {
        for (tab of browserState.tabsByWindow(window.id)) {
          if (matchesFilter(tab, searchQuery)) {
            items.push({ kind: 'tab', tab });
          }
        }
      }
    }
  }

  // ── Saved for Later section ──
  items.push({ kind: 'section-header', section: 'saved', ... });
  if (expanded.has('saved')) {
    for (savedTab of savedTabState.tabs) {
      if (matchesFilter(savedTab, searchQuery)) {
        items.push({ kind: 'saved-tab', savedTab });
      }
    }
  }

  // ── Bookmarks section (future) ──

  return items;
});
```

### Search Input + Action Buttons (Approach C+)

```
┌──────────────────────────────────────────────┐
│  Search Input (ALWAYS plain text filter)      │
│  One job: filter tabs by title/URL match      │
│                                               │
│  [⌘] Button ──► Opens Command.Dialog overlay  │
│                  Uses @epicenter/ui/command    │
│                  Quick actions: dedup, group,  │
│                  close by domain, sort, etc.   │
│                                               │
│  [⚡] Button ──► Opens AI drawer (Sheet)       │
│                  Wraps existing AiChat.svelte  │
│                  Bottom sheet on narrow panel  │
│                                               │
│  Hidden shortcuts (empty input only):          │
│  "/" ──► Opens command palette                 │
│  "@" ──► Opens AI drawer                       │
│                                               │
│  Empty filter + no results state:              │
│  "No tabs found. ✦ Ask AI to help"             │
│  (CTA links to AI drawer with query prefilled) │
└──────────────────────────────────────────────┘
```

### Side Panel Layout

```
CURRENT                          PROPOSED
┌──────────────────┐             ┌──────────────────────┐
│ Tab Manager   🔄 │             │ 🔍 Search... [⌘][⚡]🔄│
│ ┌────┬────┬────┐ │             ├──────────────────────┤
│ │Tabs│Save│ AI │ │             │ ▾ Open Tabs (47)     │
│ └────┴────┴────┘ │             │   ▸ Window 1 (12)    │
│                  │             │   ▸ Window 2 (8)     │
│ [one view at     │             │                      │
│  a time]         │             │ ▾ Saved for Later (5)│
│                  │             │   tab-a • 2h ago     │
│                  │             │   tab-b • 1d ago     │
│                  │             │                      │
│                  │             │ ▸ Bookmarks (0)      │
└──────────────────┘             └──────────────────────┘
                                 [⌘] = Command palette
                                 [⚡] = AI drawer toggle
```

### AI Drawer

When AI is triggered (via `⚡` button or `@` shortcut in empty input), a sheet/drawer slides up from the bottom:

```
┌──────────────────────────────────┐
│ 🔍 Search...       [⌘][⚡]🔄│
│ ▾ Open Tabs (47)                │
│   ▸ Window 1 (12)              │
├──────────────────────────────────┤
│ AI Chat                       ✕ │
│ [messages...]                   │
│ [input............] [Send]      │
└──────────────────────────────────┘
```

### Bookmarks Table Schema

```typescript
const bookmarksTable = defineTable(
  type({
    id: BookmarkId,           // nanoid, generated on bookmark
    url: 'string',            // The bookmarked URL
    title: 'string',          // Title at time of bookmark
    'favIconUrl?': 'string | undefined',
    'description?': 'string | undefined',  // Optional user note
    createdAt: 'number',      // Timestamp (ms since epoch)
    sourceDeviceId: DeviceId, // Device that created the bookmark
    _v: '1',
  }),
);
```

### Quick Actions Registry

```typescript
// apps/tab-manager/src/lib/commands/quick-actions.ts

type QuickAction = {
  id: string;
  label: string;
  description: string;
  icon: Component;
  keywords: string[];       // For command palette filtering
  execute: () => Promise<void> | void;
  dangerous?: boolean;      // Show confirmation dialog
};
```

Built-in actions for v1:

| Command | Action | Confirmation? |
|---|---|---|
| `/dedup` | Close duplicate tabs (same URL) | Yes: "Found N duplicates. Close them?" |
| `/close <domain>` | Close all tabs matching domain | Yes: "Close N tabs from domain?" |
| `/group` | Group tabs by domain | No |
| `/sort` | Sort tabs by title within each window | No |
| `/save-all` | Save all tabs for later + close | Yes: "Save and close N tabs?" |

### Duplicate Detection Logic

```typescript
function findDuplicates(tabs: Tab[]): Map<string, Tab[]> {
  const byUrl = new Map<string, Tab[]>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    // Normalize: strip trailing slash, query params, and hash
    const normalized = normalizeUrl(tab.url);
    const group = byUrl.get(normalized) ?? [];
    group.push(tab);
    byUrl.set(normalized, group);
  }
  // Only return groups with 2+ tabs (actual duplicates)
  return new Map([...byUrl].filter(([, group]) => group.length > 1));
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}
```

## Implementation Plan

### Phase 1: Unified View (no search, no commands, no bookmarks)

Merge the existing two views into one scrollable list. No new features. Just restructure.

- [x] **1.1** Create `UnifiedTabList.svelte`: single VList with section headers for "Open Tabs" and "Saved for Later", using the `FlatItem` discriminated union. Reuses existing `TabItem.svelte` and per-item rendering from `SavedTabList`.
- [x] **1.2** Update `App.svelte`: replace the 3-tab Tabs.Root with the unified view. Remove Tabs component usage. Keep AI as a button/trigger (not rendered as content yet).
- [x] **1.3** Create `unified-view-state.svelte.ts`: manages expanded sections (`SvelteSet`), derives the flat item array from `browserState` + `savedTabState`. Follows the `createXxxState()` factory pattern.
- [x] **1.4** Add section header rendering in VList: collapsible headers for "Open Tabs (N)" and "Saved for Later (N)" with chevron toggle. Window headers remain as sub-collapsibles.
- [x] **1.5** Preserve existing "Restore All" / "Delete All" for saved tabs: move these to the saved section's header or a context menu.

### Phase 2: Instant Search Filter
Add the search input with plain-text filtering. The input has ONE job: filter.

- [x] **2.1** Add search input + action buttons to the header area: replace the h1 "Tab Manager" with a search input flanked by `⌘` (command palette) and `⚡` (AI drawer) icon buttons. Show "Search tabs..." as placeholder.
- [x] **2.2** Wire filter into `unified-view-state`: when `searchQuery` is non-empty, filter `flatItems` by title/URL match (case-insensitive `includes`). Auto-expand all sections when filtering.
- [x] **2.3** Handle empty results: show inline "No matching tabs" state with a CTA: "✦ Ask AI about [query]" that opens the AI drawer with the query prefilled.
- [x] **2.4** Add hidden `/` shortcut: when input is empty and user types `/`, open the command palette (Phase 3) and clear the input. Power-user enhancement.
### Phase 3: Command Palette

Add `⌘` button that opens a Command.Dialog overlay with quick actions.

- [x] **3.1** Create `quick-actions.ts`: registry of `QuickAction` objects with `id`, `label`, `execute`, `dangerous`. Start with `dedup` only.
- [x] **3.2** Create `CommandPalette.svelte`: uses `Command.Dialog`, `Command.Input`, `Command.List`, `Command.Item`, `Command.Group` from `@epicenter/ui/command`. Opens when `⌘` button is clicked (or `/` shortcut from Phase 2.4).
- [x] **3.3** Implement `dedup`: `findDuplicates()` logic + confirmation dialog + `browserState.actions.close()` for each duplicate.
- [x] **3.4** Add more commands: `close <domain>`, `group`, `sort`, `save-all`.
### Phase 4: AI Drawer

Add `⚡` button that opens a bottom sheet with the existing AI chat.

- [x] **4.1** Create `AiDrawer.svelte`: wrap existing `AiChat.svelte` in a `Sheet` or `Drawer` from `@epicenter/ui`. Triggered by the `⚡` button in the header (or `@` shortcut in empty input).
- [x] **4.2** Wire `@` shortcut: when input is empty and user types `@`, open the AI drawer and focus the AI chat input. Clear the search input.
- [x] **4.3** Wire empty-state CTA: the "Ask AI about [query]" link from Phase 2.3 opens the drawer with the query prefilled in the AI chat input.
- [x] **4.4** Ensure AI streams in background: when drawer is closed, active streams continue (already supported by `aiChatState`'s per-conversation `ChatClient`).
### Phase 5: Bookmarks

Add permanent, non-consumable bookmarks.

- [x] **5.1** Add `BookmarkId` branded type and `bookmarksTable` to `workspace.ts`. Follow `savedTabsTable` pattern.
- [x] **5.2** Create `bookmark-state.svelte.ts`: follows `savedTabState` pattern: `createBookmarkState()` factory, Y.Doc observer, CRUD actions. Key difference: `open(bookmark)` calls `browser.tabs.create()` but does NOT delete the record.
- [x] **5.3** Add "Bookmark" action to `TabItem.svelte`: alongside existing "Save for later" button. Different icon (e.g. `StarIcon` vs `ArchiveIcon`).
- [x] **5.4** Add "Bookmarks" section to `UnifiedTabList`: new section header + bookmark items in the flat item array.
- [x] **5.5** Rename "Save for Later" icon from `BookmarkIcon` to `ArchiveIcon` or `InboxIcon`: fixes the current UX mismatch where the icon says "bookmark" but the behavior is "stash and close."

## Edge Cases

### Filter with empty sections

1. User types "github" in search
2. No saved tabs match, but 5 open tabs match
3. Expected: "Saved for Later" section header still shows with "(0 matching)" or is hidden entirely. Open Tabs section shows the 5 matches.
4. **Recommendation:** Hide empty sections during active filtering.

### `/dedup` with tabs across multiple windows

1. User has `github.com` open in Window 1 and Window 2
2. Which tab is the "original" and which is the "duplicate"?
3. **Recommendation:** Keep the most recently accessed tab (highest `lastAccessed`). If not available, keep the first by index. Always show the user which tabs will be closed before confirming.

### AI drawer open while filtering

1. User has AI drawer open, then clicks the search input and types
2. The search filters the main list; the AI drawer stays open above it
3. These are independent. No conflict. The bottom sheet overlays the lower content area while the filter applies to the list visible above.
### Bookmark and Save for Later the same URL

1. User bookmarks a tab AND saves it for later
2. Both records coexist. Different tables, different semantics
3. Restoring the saved tab opens it and deletes the saved record. The bookmark persists. This is correct.

### Large tab count performance

1. User has 200+ tabs across 10 windows
2. VList handles this fine: `virtua` virtualizes rendering (only visible items are in the DOM)
3. Filtering is O(n) over `browserState` SvelteMaps, which is fast for hundreds of items
4. No concern until thousands of items

## Open Questions

1. **Should the AI drawer be a side sheet or bottom sheet?**
   - Options: (a) Right sheet (splits the panel horizontally), (b) Bottom sheet (slides up from bottom), (c) Full overlay (replaces content)
   - **Recommendation:** Bottom sheet. The side panel is already narrow (~360px): splitting it horizontally makes both halves unusable. A bottom sheet gives the AI a comfortable input area while keeping the tab list partially visible above.

2. **How aggressive should URL normalization be for `/dedup`?**
   - Options: (a) Exact URL match, (b) Ignore query params + hash, (c) Ignore query params + hash + trailing slash
   - **Recommendation:** (c) for v1. `https://github.com/foo` and `https://github.com/foo/` and `https://github.com/foo?ref=bar` should all be considered the same page. Can add a "strict mode" later.

3. **Should bookmarks support folders/tags in v1?**
   - Options: (a) Flat list only, (b) Flat list + tags, (c) Folder hierarchy
   - **Recommendation:** (a) Flat list only. Adding organization is a separate feature. Ship the core "permanent save" behavior first. The schema can add a `folderId` field in v2 without breaking changes.

4. **Should the search input support keyboard shortcuts (Ctrl+K)?**
   - **Recommendation:** Yes, but in a later phase. The input is always visible, so there's no dialog to toggle. `Ctrl+K` could focus the input from anywhere, similar to how Spotlight works.

5. **What happens to the existing `/ai` tab route / deep links?**
   - Any Chrome extension pages or external links pointing to the AI tab will need to open the AI drawer instead.
   - **Recommendation:** Defer. Check if any deep links exist first.

## Success Criteria

- [x] Side panel shows one unified scrollable view (no tab switcher)
- [x] Open tabs and saved tabs visible simultaneously with collapsible sections
- [x] Typing in search input instantly filters tabs by title/URL
- [x] `⌘` button opens command palette overlay with quick actions
- [x] `dedup` command removes duplicate tabs with confirmation
- [x] `⚡` button opens AI drawer without leaving the tab view
- [x] Hidden `/` and `@` shortcuts work in empty input for power users
- [x] Bookmarks persist after opening (not consumed like saved tabs)
- [ ] `bun run typecheck` passes in `apps/tab-manager/`
- [x] `bun run build` succeeds in `apps/tab-manager/`
- [ ] VList performance is unchanged (no jank with 100+ tabs)

## References

- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: Current 3-tab layout to replace
- `apps/tab-manager/src/lib/components/tabs/FlatTabList.svelte`: Existing VList + flatItems pattern to extend
- `apps/tab-manager/src/lib/components/tabs/SavedTabList.svelte`: Saved tabs rendering to merge
- `apps/tab-manager/src/lib/components/tabs/TabItem.svelte`: Per-tab actions (pin, mute, save, close)
- `apps/tab-manager/src/lib/state/browser-state.svelte.ts`: Reactive browser state
- `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts`: Saved tab state pattern to follow for bookmarks
- `apps/tab-manager/src/lib/state/chat-state.svelte.ts`: AI chat state (stays unchanged)
- `apps/tab-manager/src/lib/workspace.ts`: Workspace schema (add bookmarks table)
- `apps/tab-manager/src/lib/commands/actions.ts`: Existing command execution pattern
- `packages/ui/src/command/`: Command palette components (Dialog, Input, List, Item, Group)
- `packages/ui/src/sheet/` or `packages/ui/src/drawer/`: Sheet/drawer for AI overlay
- `specs/20260213T003200-suspended-tabs.md`: Original "save for later" design decisions
- `specs/20260221T190252-ai-chat-tab.md`: AI chat tab design (being restructured)
