# Tab Search Modes

**Date**: 2026-04-05
**Status**: Implemented
**Author**: AI-assisted

## Overview

Add VS Code-style search mode toggles (case-sensitive, regex, whole word/exact) and a field scope selector to the tab manager's search input. Currently, search is a single case-insensitive substring match across title and URL with no way to refine matching behavior.

## Motivation

### Current State

```ts
// unified-view-state.svelte.ts: the entire filter logic
function matchesFilter(title: string | undefined, url: string | undefined): boolean {
  if (!isFiltering) return true;
  const lower = searchQuery.toLowerCase();
  const t = title?.toLowerCase() ?? '';
  const u = url?.toLowerCase() ?? '';
  return t.includes(lower) || u.includes(lower);
}
```

One mode, no options, no way to:

1. **Match case**: Searching `React` also matches `react-router` and `reactive`: can't distinguish
2. **Use regex**: Can't search for URL patterns like `github.com/*/pull/*`
3. **Match precisely**: Searching `log` matches `dialog`, `catalog`, `blog`: no word boundary support
4. **Target a field**: Can't search only URLs (e.g., find all tabs on a specific domain) without title noise polluting results

### Desired State

Three inline toggles next to the search input plus a field scope selector:

```
┌──────────────────────────────────────────────────────────────┐
│ 🔍  Search tabs...              [All ▾]  [Aa] [.*] [ab|]   │
│                                  ↑        ↑    ↑    ↑       │
│                       field scope┘  case──┘    │    │       │
│                                       regex────┘    │       │
│                                 exact/whole word────┘       │
└──────────────────────────────────────────────────────────────┘
```

## Research Findings

### Components Available in packages/ui

| Component | Import | Relevant Props | Notes |
|---|---|---|---|
| Toggle | `@epicenter/ui/toggle` | `pressed` (bindable), `size`, `variant` | `data-[state=on]:bg-accent` styling built-in |
| ToggleGroup | `@epicenter/ui/toggle-group` | `value` (bindable), `type`, `size`, `variant` | For field scope selector |
| Button | `@epicenter/ui/button` | `tooltip`, `variant`, `size` | Has built-in `tooltip` prop |
| Input | `@epicenter/ui/input` | `value` (bindable), `type` | Current search input |
| Tooltip | `@epicenter/ui/tooltip` | Provider/Root/Trigger/Content | Already wrapping the app |

### Lucide Icons Available

All three VS Code search icons exist in `@lucide/svelte`:

| Icon | Import path | Visual | Purpose |
|---|---|---|---|
| CaseSensitive | `@lucide/svelte/icons/case-sensitive` | `Aa` | Case-sensitive toggle |
| Regex | `@lucide/svelte/icons/regex` | `.*` | Regex toggle |
| WholeWord | `@lucide/svelte/icons/whole-word` | `ab\|` | Whole word / exact match toggle |

### Existing Toggle Patterns in the Codebase

The honeycrisp editor already uses Toggle + Tooltip for formatting buttons:

```svelte
<!-- apps/honeycrisp/src/lib/editor/Editor.svelte -->
<Toggle size="sm" {pressed} onPressedChange={onToggle}>
  <svelte:component this={icon} class="size-4" />
</Toggle>
```

The whispering app uses ToggleGroup for mode switching:

```svelte
<!-- apps/whispering/src/routes/(app)/+page.svelte -->
<ToggleGroup.Root type="single" size="sm" bind:value={mode}>
  <ToggleGroup.Item value="manual">...</ToggleGroup.Item>
</ToggleGroup.Root>
```

### Whole Word vs Exact Match Behavior

The `ab|` icon in VS Code means "whole word" (word boundary match). But word boundaries behave differently for titles vs URLs:

| Field | "Whole word" behavior | Why |
|---|---|---|
| **Title** | Word boundary (`\bterm\b`) | Titles are natural language-`log` should match "error log" but not "dialog" |
| **URL** | Full URL exact match (with normalization) | URLs don't have word boundaries in a meaningful way; exact URL match is what's useful |

The `normalizeUrl()` function in `tab-helpers.ts` already handles URL normalization (strips fragments, sorts params).

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Individual Toggles vs ToggleGroup for modes | Individual `Toggle` components | Modes are composable (regex + case-sensitive); ToggleGroup enforces mutual exclusivity |
| Field scope selector | ToggleGroup with `type="single"` | Mutually exclusive (All / Title / URL); ToggleGroup is the right primitive |
| Tooltip on toggles | Wrap with Tooltip (honeycrisp pattern) | Toggle doesn't have a built-in `tooltip` prop like Button does |
| Regex error handling | Show no results on invalid regex | Don't surface regex syntax errors in the UI; typing `/[/` mid-edit shouldn't flash error banners |
| Whole word for titles, exact for URLs | Different behavior per field type | Word boundary makes sense for natural language (titles); full match makes sense for structured data (URLs) |
| Position of toggles | Inside search input, right-aligned | Follows VS Code pattern; keeps header compact |
| Position of field scope | Between input and toggles | Groups "where to search" before "how to search" |

## Architecture

### Persistence

Toggle states persist via `createStorageState` from `storage-state.svelte.ts`: the existing
pattern used by `serverUrl`, `remoteServerUrl`, and `session`. This uses WXT's `@wxt-dev/storage`
which wraps `chrome.storage.local` with reactive Svelte 5 state, schema validation via arktype,
and cross-context sync (changes in popup reflect in sidebar).

A new file `search-preferences.svelte.ts` exports four persisted states:

```ts
// search-preferences.svelte.ts
import { type } from 'arktype';
import { createStorageState } from './storage-state.svelte';

export const searchCaseSensitive = createStorageState('local:search.case.sensitive', {
  fallback: false,
  schema: type('boolean'),
});

export const searchRegex = createStorageState('local:search.regex', {
  fallback: false,
  schema: type('boolean'),
});

export const searchExactMatch = createStorageState('local:search.exact.match', {
  fallback: false,
  schema: type('boolean'),
});

export const searchField = createStorageState('local:search.field', {
  fallback: 'all' as const,
  schema: type("'all' | 'title' | 'url'"),
});
```

`unified-view-state.svelte.ts` reads `.current` from these instead of local `$state`. The
`.current` accessor is already reactive, so the existing `$derived` chain picks it up automatically.

### State Shape

```
search-preferences.svelte.ts (NEW: persisted via chrome.storage.local)
├── searchCaseSensitive.current: boolean
├── searchRegex.current: boolean
├── searchExactMatch.current: boolean
└── searchField.current: 'all' | 'title' | 'url'

unified-view-state.svelte.ts (reads from search-preferences)
├── searchQuery: string              (existing, local $state, NOT persisted)
├── isFiltering: boolean             (existing, derived)
├── matchesFilter(title, url)        (existing, updated to read preferences)
└── flatItems: FlatItem[]            (existing, unchanged)

### Filter Logic Flow

```
searchQuery + modes + field
        │
        ▼
┌─────────────────────────┐
│   matchesFilter(t, u)   │
│                         │
│  1. Select fields based │
│     on searchField      │
│  2. Apply match mode:   │
│     - regex → RegExp    │
│     - exact → boundary  │
│       or === by field   │
│     - default → includes│
│  3. Case sensitivity    │
│     applied throughout  │
└─────────────────────────┘
        │
        ▼
  flatItems (unchanged consumer)
```

### UI Layout

```
┌─ header ──────────────────────────────────────────────────────────┐
│ ┌─ relative flex-1 (search container) ──────────────────────────┐ │
│ │ 🔍  [        search input        ] [scope] [Aa] [.*] [ab|]   │ │
│ │  ↑                                   ↑      └─ toggles ──┘   │ │
│ │  search icon (existing)              field scope (new)        │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ [⌘] [⚡] [sync]  ← existing buttons, unchanged                   │
└───────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Persistence + State

- [x] **1.1** Create `apps/tab-manager/src/lib/state/search-preferences.svelte.ts` with four `createStorageState` exports (see Architecture > Persistence)
- [x] **1.2** Export `normalizeUrl` from `tab-helpers.ts` (add `export` keyword to the existing function)
- [x] **1.3** Add `escapeRegex(str)` utility to `unified-view-state.svelte.ts` (escape special regex chars for whole-word boundary construction)
- [x] **1.4** Import the four search preferences into `unified-view-state.svelte.ts` and read `.current` inside `matchesFilter`
- [x] **1.5** Rewrite `matchesFilter` to respect all modes:
  - Read `searchField.current` to determine which fields to test
  - Read `searchRegex.current`: construct `RegExp` from query, catch invalid patterns, return `false` on error
  - Read `searchExactMatch.current`: whole-word (`\bterm\b`) for titles, normalized exact match (`===` after `normalizeUrl`) for URLs
  - Default mode: substring `includes` (current behavior)
  - `searchCaseSensitive.current` applied at every level
- [x] **1.6** Add `isRegexInvalid` derived for the UI to hint at bad regex
- [x] **1.7** Expose preferences via getters/setters in the return object that proxy to the `createStorageState` `.current` accessor, with mutual exclusivity logic (setting regex=true sets exactMatch=false and vice versa)

### Phase 2: UI: Toggles

- [x] **2.1** Import `Toggle` from `@epicenter/ui/toggle` and the three Lucide icons in `App.svelte`
- [x] **2.2** Add three `Toggle` components inside the search input's relative container, right-aligned
- [x] **2.3** Bind each toggle's `pressed` to the corresponding state: `unifiedViewState.isCaseSensitive`, etc.
- [x] **2.4** Wrap each toggle with `Tooltip.Root`/`Tooltip.Trigger`/`Tooltip.Content` for labels: "Match Case", "Use Regular Expression", "Match Whole Word"
- [x] **2.5** Style toggles to fit inside the input: `class="size-6 rounded-sm p-0"`; compact feel matching existing icon buttons
- [x] **2.6** Adjust input padding-right to `pr-[5.5rem]` to make room for the toggles
- [x] **2.7** Keep the clear (X) button; position it before the toggles

### Phase 3: UI: Field Scope

- [x] **3.1** Import `ToggleGroup` from `@epicenter/ui/toggle-group` in `App.svelte`
- [x] **3.2** Add a compact ToggleGroup with three items: All / Title / URL
- [x] **3.3** Bind `value` to `unifiedViewState.searchField`
- [x] **3.4** Position between the search input area and the existing header buttons
- [x] **3.5** Use `size="sm"` and `variant="outline"` to keep it subtle

### Phase 4: Polish

- [x] **4.1** Verify that toggling modes on/off while typing updates results reactively (they should: `$derived` chain)
- [x] **4.2** Verify keyboard shortcuts still work (/, @, Escape) with toggles present
- [x] **4.3** Update the empty state message: when regex is active and no results, hint that the regex might be invalid
- [x] **4.4** Run `lsp_diagnostics` on changed files
- [ ] **4.5** Manual smoke test: try each mode combination, verify results make sense

## Edge Cases

### Invalid Regex

1. User enables regex toggle
2. Types `[` (incomplete regex)
3. `new RegExp('[')` throws
4. Catch and return `false`: no results shown, no error banner
5. As they finish typing `[a-z]`, results appear naturally

### Regex + Case-Sensitive Interaction

1. Regex mode: flags come from `isCaseSensitive`: `new RegExp(query, isCaseSensitive ? '' : 'i')`
2. Both toggles compose naturally

### Exact Match + Field Scope Interaction

1. Field = "All": whole-word on title OR exact on URL (either matches)
2. Field = "Title": whole-word on title only
3. Field = "URL": exact URL match only
4. Exact match + regex are mutually exclusive in behavior. If both are on, regex takes priority (regex is the more powerful mode)

### Empty Query with Toggles Active

1. Toggle states persist when query is cleared
2. This is intentional. User expects modes to be "sticky" for the next search
3. `isFiltering` is still derived from `searchQuery.trim().length > 0`, so empty query = show all regardless of toggle state

### Clear Button Interaction

1. Clear (X) button clears the search query only, does NOT reset toggle states
2. This matches VS Code behavior. Clearing the search text doesn't reset case-sensitive/regex/whole-word toggles

## Resolved Decisions

1. **Regex and exact match are mutually exclusive.** Turning on regex turns off exact match and vice versa. Implemented via `onPressedChange` callbacks + the `createStorageState` setters.

2. **Field scope selector is always visible.** It's three short labels (All / Title / URL) and the header has room.

3. **Toggle states persist via `chrome.storage.local`** using WXT's `@wxt-dev/storage` through the existing `createStorageState` pattern (see Architecture > Persistence above). NOT `localStorage`: this is a Chrome extension, so `chrome.storage.local` is the correct API. The `createStorageState` wrapper handles reactive Svelte 5 state, arktype schema validation, and cross-context sync.
## Success Criteria

- [ ] Case-sensitive toggle filters correctly (verified with mixed-case tab titles)
- [ ] Regex toggle accepts valid patterns and produces correct results
- [ ] Invalid regex shows no results (not an error)
- [ ] Whole word matches `log` in "error log" but not in "dialog" (title)
- [ ] Exact URL match finds an exact page but not partial matches (URL)
- [ ] Field scope restricts search to the selected field
- [ ] All toggle combinations compose correctly
- [ ] Existing keyboard shortcuts (/, @, Escape) still work
- [ ] No TypeScript errors (`lsp_diagnostics` clean)
- [ ] UI feels native. Toggles are compact, discoverable via tooltips, and follow the existing header style
- [ ] Toggle states persist across panel close/reopen (chrome.storage.local)

## References

- `apps/tab-manager/src/lib/state/unified-view-state.svelte.ts`: State + filter logic (primary change)
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: Search UI (primary change)
- `apps/tab-manager/src/lib/components/tabs/UnifiedTabList.svelte`: Renders filtered results (empty state message update)
- `apps/tab-manager/src/lib/utils/tab-helpers.ts`: `normalizeUrl()` for exact URL matching
- `packages/ui/src/toggle/toggle.svelte`: Toggle component API
- `packages/ui/src/toggle-group/toggle-group.svelte`: ToggleGroup component API
- `apps/honeycrisp/src/lib/editor/Editor.svelte`: Toggle + Tooltip usage pattern to follow
- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`: `createStorageState` utility for chrome.storage.local persistence
- `apps/tab-manager/src/lib/state/settings.svelte.ts`: Existing usage pattern for `createStorageState`
- `apps/tab-manager/src/lib/auth.ts`: Another `createStorageState` consumer (session persistence)

## Review

**Completed**: 2026-04-05

### Summary

Added VS Code-style search mode toggles (case-sensitive, regex, whole-word) and a field scope selector (All/Title/URL) to the tab manager search input. Toggle states persist to `chrome.storage.local` via the existing `createStorageState` pattern. The `matchesFilter` function now supports regex matching, whole-word boundary matching for titles, normalized exact URL matching, and field-scoped search. All composable with case sensitivity.

### Deviations from Spec

- Toggle sizing landed at `size-6 rounded-sm p-0` rather than the originally estimated `size-5`. Looks better at this size in the actual header context.
- Input padding-right is `pr-[5.5rem]` (arbitrary Tailwind value) to accommodate the 3 toggles + clear button.

### Follow-up Work

- **4.5**: Manual smoke test still needed. Try each mode combination in the actual extension to verify results make sense.
- Consider adding match highlighting in tab titles/URLs when search is active (bold the matched substring).
- Consider adding a keyboard shortcut to cycle through search modes (e.g., Alt+C for case, Alt+R for regex).
