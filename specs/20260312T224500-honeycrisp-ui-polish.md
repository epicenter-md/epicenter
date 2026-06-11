# Honeycrisp UI Polish: Closer to Apple Notes

**Date**: 2026-03-12
**Status**: Implemented
**Author**: AI-assisted
**Branch**: `origin/main` (Honeycrisp merged via PR #1509)

## Overview

Improve Honeycrisp's three-column notes app to look and feel closer to macOS Apple Notes by leveraging existing shadcn-svelte components from `packages/ui/`, adding a formatting toolbar, and fixing editor typography. While avoiding custom Tailwind classes wherever a shadcn component already handles the job.

## Motivation

### Current State

Honeycrisp (3 components + page) is structurally correct. Three-column layout, folder CRUD, note CRUD, Tiptap + Yjs. But visually it reads as a generic developer scaffold, not a polished notes app.

**Editor.svelte**: bare Tiptap with `prose prose-sm`:
```typescript
editorProps: {
  attributes: {
    class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full',
  },
},
```

**NoteList.svelte**: raw `div` elements with inline Tailwind, no search:
```svelte
<div class="group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent/50 {selectedNoteId === note.id ? 'bg-accent' : ''}">
```

**Sidebar.svelte**: functional but missing `Sidebar.Input` for search (Fuji uses it, Honeycrisp doesn't).

### Problems

1. **Editor text is too small**: `prose-sm` renders body at ~14px. Apple Notes uses ~16px body, ~28px title.
2. **No formatting toolbar**: Zero way to bold, italic, create headings, or add checklists without knowing keyboard shortcuts.
3. **No title styling**: The first line of a note is visually identical to body text. Apple Notes renders it large and bold.
4. **No search**: Neither the sidebar nor the note list has a search field. The `sortBy` KV exists but has no UI.
5. **Visible resizable handle**: `<Resizable.Handle withHandle />` shows a chunky drag indicator. Apple Notes has invisible column dividers.
6. **Unused shadcn components**: `Toggle`, `ToggleGroup`, `Separator`, `Tooltip`, `Sidebar.Input`, `Sidebar.Trigger` all exist in `packages/ui/` but aren't used.

### Desired State

A notes app where someone opening it for the first time thinks "this feels like Apple Notes". System fonts, large title, formatting toolbar, seamless column layout, search. All built from existing shadcn components. Prefer component props and composition over raw Tailwind utility classes.

## Research Findings

### Font Situation

The `--font-sans` variable in `packages/ui/src/app.css` references Manrope:
```css
--font-sans: "Manrope Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

However, the actual font import is **commented out**:
```css
/* @import '@fontsource-variable/manrope'; */
```

**Key finding**: Manrope isn't actually loading. Browsers fall through to `system-ui` → `-apple-system` → `BlinkMacSystemFont`. On macOS, that's **SF Pro**: exactly what Apple Notes uses.

**Implication**: No font changes needed for Honeycrisp. The system font stack already produces the right result on macOS. Don't add custom fonts. Don't override `--font-sans`. Just use what's there.

### shadcn Component Audit

| Component | In `packages/ui/` | Used by Honeycrisp | Recommended |
|-----------|-------------------|--------------------|----|
| Sidebar.* (26 sub-components) | ✅ | ✅ Partial (14 of 26) | Add: `Input`, `Trigger`, `Separator` |
| SidebarProvider | ✅ | ✅ |: |
| Resizable.* | ✅ | ✅ | Remove `withHandle` |
| ScrollArea | ✅ | ✅ |: |
| Button | ✅ | ✅ |: |
| DropdownMenu | ✅ | ✅ |: |
| Tooltip.Provider | ✅ | ✅ (layout only) | Add `Tooltip.Root/Trigger/Content` for toolbar |
| **Toggle** | ✅ | ❌ | **Use for formatting toolbar** |
| **ToggleGroup** | ✅ | ❌ | **Use for grouped toolbar buttons** |
| **Separator** | ✅ | ❌ | **Use in toolbar between button groups** |
| **Tooltip** | ✅ | ❌ | **Use for toolbar button labels** |
| **Input** | ✅ | ❌ | **Use for search field** |
| Command | ✅ | ❌ | Future: ⌘K search palette |
| ContextMenu | ✅ | ❌ | Future: right-click on notes |
| Badge | ✅ | ❌ | Future: note metadata indicators |
| Card | ✅ | ❌ | Not needed |
| Sheet | ✅ | ❌ | Handled by SidebarProvider internally |

### Existing Toolbar Patterns

**Key finding**: No formatting toolbar exists anywhere in this codebase. Neither Honeycrisp nor Fuji has one. Both editors use bare StarterKit + Placeholder. No `@tiptap/extension-*` packages beyond core are installed.

**Implication**: The toolbar is new work, but it's straightforward. Tiptap's `editor.chain().focus().toggleBold().run()` API + shadcn `Toggle`/`ToggleGroup` components.

### Apple Notes Visual Reference

| Element | Apple Notes | Honeycrisp Current | Gap |
|---------|------------|-------------------|-----|
| Title | ~28px, bold (700), system font | Same size as body (14px) | **Critical** |
| Body | ~16px, regular (400), 1.6 line-height | 14px (`prose-sm`) | **Critical** |
| Formatting toolbar | Persistent bar above editor | None | **Critical** |
| Column dividers | Hairline, barely visible | Visible drag handle | Medium |
| Note list search | Search field at top | None | Medium |
| Selection | Rounded, subtle blue tint | Block `bg-accent` | Low: already decent |
| Sidebar search | Not in sidebar (in toolbar area) | None | Low |

### Fuji Comparison

Fuji's EntryEditor has:
- Separate title `<input>` above the editor (not inside Tiptap)
- Type/tag inputs below title
- Same bare `prose prose-sm` editor
- Back button + timestamp footer

Fuji's Sidebar has `Sidebar.Input` for search. Honeycrisp should follow this pattern.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Font** | Keep system font stack as-is | Manrope isn't loading; system fonts are already SF Pro on macOS. No change needed. |
| **Title styling** | CSS on `.tiptap > *:first-child` | Keep title inside the editor (Apple Notes behavior) vs separate input (Fuji approach). Title-as-first-line matches how Apple Notes works. Type and it becomes the title. |
| **Body size** | `prose` instead of `prose-sm` | The existing `prose.css` in `packages/ui/src/` already defines good sizes for headings, body, lists. Just remove the `sm` modifier. |
| **Toolbar** | shadcn `Toggle` + `Separator` | Use existing components. No custom toolbar CSS. Toggle's `data-[state=on]` handles active formatting states automatically. |
| **Tiptap extensions** | Add `task-list`, `task-item`, `underline` | Minimum extensions to match Apple Notes formatting options. Don't over-engineer. |
| **Search** | `Sidebar.Input` in Sidebar header | Follow Fuji's pattern. One line of code. Filters `filteredNotes` client-side. |
| **Resizable handle** | Remove `withHandle` | Produces hairline divider matching Apple Notes. Zero custom CSS. |
| **Custom CSS** | Minimal: only title first-child + Tiptap placeholder | Everything else uses shadcn component props and composition. No custom colors, no custom spacing tokens, no raw Tailwind where a component exists. |
| **Tailwind classes** | Minimize | If a shadcn component handles the behavior (e.g., `Separator` for a divider, `ScrollArea` for overflow), use the component instead of a Tailwind utility class. Only reach for Tailwind for layout primitives (`flex`, `h-full`, `overflow-hidden`) that have no component equivalent. |
## Architecture

### Component Changes

```
apps/honeycrisp/src/
├── routes/+page.svelte          ← Add search state, pass to NoteList
├── lib/components/
│   ├── Editor.svelte            ← Add toolbar, fix prose size, title CSS
│   ├── NoteList.svelte          ← Add search input in header
│   └── Sidebar.svelte           ← Add Sidebar.Input
```

### Editor Layout (after changes)

```
┌─ Editor ─────────────────────────────────────────────────────┐
│ ┌─ Toolbar ────────────────────────────────────────────────┐ │
│ │ [B] [I] [U] [S] │ [H1] [H2] │ [•] [1.] [☐] │ ["]      │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  Meeting prep                          ← 28px, bold (CSS)   │
│  ─────────────────────────────────────                       │
│                                                              │
│  Rich text body at 16px with           ← prose (not prose-sm)│
│  comfortable line-height...                                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Toolbar Component Structure (all shadcn)

```svelte
<!-- All shadcn components, no custom divider/button styling needed -->
<div class="flex items-center gap-1 border-b px-4 py-1">
  <ToggleGroup type="multiple" size="sm">   <!-- Bold, Italic, Underline, Strike -->
    <ToggleGroup.Item value="bold"><BoldIcon /></ToggleGroup.Item>
    <ToggleGroup.Item value="italic"><ItalicIcon /></ToggleGroup.Item>
    <ToggleGroup.Item value="underline"><UnderlineIcon /></ToggleGroup.Item>
    <ToggleGroup.Item value="strike"><StrikethroughIcon /></ToggleGroup.Item>
  </ToggleGroup>
  <Separator orientation="vertical" class="h-6" />
  <ToggleGroup type="single" size="sm">     <!-- Heading levels -->
    <ToggleGroup.Item value="h1">H1</ToggleGroup.Item>
    <ToggleGroup.Item value="h2">H2</ToggleGroup.Item>
  </ToggleGroup>
  <Separator orientation="vertical" class="h-6" />
  <ToggleGroup type="single" size="sm">     <!-- List types -->
    <ToggleGroup.Item value="bullet"><ListIcon /></ToggleGroup.Item>
    <ToggleGroup.Item value="ordered"><ListOrderedIcon /></ToggleGroup.Item>
    <ToggleGroup.Item value="checklist"><ListChecksIcon /></ToggleGroup.Item>
  </ToggleGroup>
  <Separator orientation="vertical" class="h-6" />
  <Toggle size="sm">                         <!-- Blockquote -->
    <QuoteIcon />
  </Toggle>
</div>
```

**Key principle**: Every visible UI element is a shadcn component. The only Tailwind on this wrapper `div` is layout (`flex`, `items-center`, `gap-1`) and the border. Structural, not decorative.

## Implementation Plan

### Wave 1: Editor: Title + Body Typography
- [x] **1.1** In `Editor.svelte`, change `prose prose-sm dark:prose-invert` → `prose dark:prose-invert` (remove `prose-sm`)
- [x] **1.2** Add CSS rule: `:global(.tiptap > *:first-child) { font-size: 1.75rem; font-weight: 700; line-height: 1.2; }`: makes first block render as title. Also updated placeholder CSS to match title styling.
- [x] **1.3** Verify editor padding is adequate. Current `p-8` is fine at full `prose` size. No change needed.

### Wave 2: Formatting Toolbar
- [x] **2.1** Install Tiptap extensions: `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/extension-underline` (pinned to ^2.12.0 for core compat)
- [x] **2.2** Add extensions to the Tiptap `Editor` config in `Editor.svelte`
- [x] **2.3** Create toolbar markup in `Editor.svelte` above the editor div using `Toggle`, `ToggleGroup`, `Separator` from `@epicenter/ui/`
- [x] **2.4** Wire toolbar buttons to Tiptap commands (`editor.chain().focus().toggleBold().run()`, etc.)
- [x] **2.5** Sync toolbar active state from `editor.isActive('bold')` etc. using `onTransaction` callback
- [x] **2.6** Add `Tooltip` wrappers on each toolbar button showing keyboard shortcut (e.g., "Bold (⌘B)")

### Wave 3: Search + Layout Polish
- [x] **3.1** Add `Sidebar.Input` to `Sidebar.svelte` header for folder/note search (follows Fuji pattern)
- [x] **3.2** In `+page.svelte`, add `searchQuery` state and filter `filteredNotes` by title/preview matching
- [x] **3.3** Remove `withHandle` from `<Resizable.Handle>` in `+page.svelte`: produces clean hairline divider
- [x] **3.4** Add `Sidebar.Trigger` in sidebar header for toggling sidebar on mobile

### Wave 4: NoteList Header
- [x] **4.1** Add sort dropdown in NoteList header (Date Edited / Date Created / Title) wired to the existing `sortBy` KV using DropdownMenu
- [x] **4.2** Apply sort to `filteredNotes` derived state in `+page.svelte` with KV observation

## Edge Cases

### Title Extraction with CSS-styled First Line

1. User types in a fresh note. The first paragraph renders large/bold via CSS.
2. `extractTitleAndPreview()` already takes the first line as title and first 100 chars as preview.
3. No change needed in extraction logic. CSS handles rendering; the data model is unchanged.

### Toolbar State When No Editor

1. The toolbar renders inside `Editor.svelte` which only mounts when a note is selected.
2. No toolbar appears in the empty/loading states. This is correct.

### ToggleGroup Type for Formatting

1. Bold/Italic/Underline/Strikethrough are independent (can all be active). Use `type="multiple"`.
2. Heading levels are mutually exclusive (H1 or H2, not both). Use `type="single"`.
3. List types are mutually exclusive (bullet or ordered or checklist). Use `type="single"`.

### Sidebar Search vs Note List Search

1. Fuji puts search in Sidebar. Apple Notes puts it above the note list.
2. For v1, put it in the Sidebar (following Fuji's pattern): simpler, one component change.
3. Can move it to the note list header later if desired.

## Open Questions

1. **Search location: Sidebar vs NoteList header?**
   - Fuji uses `Sidebar.Input`. Apple Notes has it above the note list.
   - **Recommendation**: Sidebar for v1 (simpler, follows Fuji pattern). Revisit if it feels wrong.

2. **Should the toolbar be persistent or appear on focus?**
   - Apple Notes: persistent toolbar at the top of the window.
   - Bear: floating bubble toolbar on text selection.
   - **Recommendation**: Persistent. Simpler to implement, discoverable, matches Apple Notes.

3. **Heading levels: H1+H2 or Title+Heading+Subheading?**
   - Apple Notes uses "Title / Heading / Subheading / Body" as styles (not HTML heading levels).
   - **Recommendation**: Map to H1/H2/H3. Simpler, works with StarterKit's heading extension already. Rename labels to "Title / Heading / Subheading" if desired.

4. **Should sort dropdown use `Select` or `DropdownMenu`?**
   - Both exist in packages/ui.
   - **Recommendation**: `DropdownMenu` (lighter, already imported in Sidebar). `Select` is heavier with combobox behavior that's unnecessary here.

## Guiding Principle

**Prefer shadcn components over Tailwind utilities.** If `packages/ui/` has a component for it, use it. Only use raw Tailwind for structural layout (`flex`, `h-full`, `overflow-hidden`, `border-b`) that no component covers. This keeps the codebase consistent with the rest of the monorepo and makes future theme changes trivial.

## Deliberately Excluded

- ❌ Custom colors or theme overrides: use base shadcn theme as-is
- ❌ Custom fonts: system font stack is correct
- ❌ Custom Tailwind utility classes for decoration: always check if a shadcn component exists first
- ❌ Animations/transitions: not necessary for v1 polish
- ❌ ⌘K command palette: future feature, not this wave
- ❌ Right-click context menus: future feature
- ❌ Drag-and-drop folder reordering: future feature
- ❌ Mobile-specific layout changes: SidebarProvider handles this automatically

## Success Criteria

- [x] Editor title (first line) renders at ~28px bold
- [x] Editor body renders at ~16px (prose, not prose-sm)
- [x] Formatting toolbar with B/I/U/S, H1/H2, bullet/ordered/checklist, blockquote
- [x] Toolbar active states reflect current cursor formatting
- [x] Search field in sidebar filters notes by title/preview
- [x] Resizable handle is a clean hairline (no visible drag indicator)
- [x] All new UI uses shadcn components. No custom component CSS beyond title first-child rule
- [x] `bun typecheck` passes for `apps/honeycrisp` (5 pre-existing errors in packages/workspace and packages/ui unrelated to Honeycrisp)

## References

- `apps/honeycrisp/src/routes/+page.svelte`: Main page with layout, state, actions
- `apps/honeycrisp/src/lib/components/Editor.svelte`: Tiptap editor (primary changes)
- `apps/honeycrisp/src/lib/components/NoteList.svelte`: Note list with date grouping
- `apps/honeycrisp/src/lib/components/Sidebar.svelte`: Folder sidebar
- `apps/fuji/src/lib/components/FujiSidebar.svelte`: Reference for Sidebar.Input usage
- `packages/ui/src/toggle-group/`: ToggleGroup component for toolbar
- `packages/ui/src/toggle/`: Toggle component for toolbar
- `packages/ui/src/separator/`: Separator for toolbar dividers
- `packages/ui/src/sidebar/`: 26 sub-components including Input, Trigger
- `packages/ui/src/prose.css`: Existing prose styles (used by editor)
- `packages/ui/src/app.css`: Design tokens, font stack, color variables

## Review

**Completed**: 2026-03-12

### Summary

All four waves implemented as specified. Honeycrisp now has Apple Notes. Style typography (1.75rem bold title, 16px body), a persistent formatting toolbar built entirely from shadcn Toggle/ToggleGroup/Separator/Tooltip components, sidebar search following Fuji's Sidebar.Input pattern, clean hairline resizable dividers, a sort dropdown persisted to KV, and a Sidebar.Trigger for mobile toggle.

### Deviations from Spec

- **Toolbar padding**: Spec suggested `px-4 py-1`, implementation uses `p-2`: visually equivalent, slightly more compact.
- **Inline formatting**: Used individual Toggle components instead of ToggleGroup type="multiple" for Bold/Italic/Underline/Strike. Simpler value management since each is an independent on/off state.
- **Tiptap extension versions**: Pinned to `^2.12.0` range instead of latest v3.x to match existing `@tiptap/core@^2.12.0`.
- **Toolbar active state sync**: Used `onTransaction` callback instead of `$effect` on editor updates. OnTransaction fires on every editor state change, which is the correct Tiptap pattern for toolbar state.

### Follow-up Work

- ⌘K command palette (spec: deliberately excluded for v1)
- Right-click context menus on notes
- Drag-and-drop folder reordering
- Move search field from sidebar to note list header (Apple Notes position)
