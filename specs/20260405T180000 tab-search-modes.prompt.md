# Execution Prompt: Tab Search Modes

> Hand this prompt to an agent with the spec at `specs/20260405T180000 tab-search-modes.md`.

## Task

Implement VS Code-style search mode toggles and a field scope selector for the tab manager's search input. The spec has the full design. Read it first.

## Context

- **Monorepo**: Bun-based, Svelte 5 with runes, shadcn-svelte (bits-ui primitives), Tailwind CSS
- **Skills to load**: `svelte`, `styling`, `typescript`, `monorepo`
- **Primary changes**: 5 files (1 new, 4 modified)
- **Storage**: Chrome extension uses WXT's `@wxt-dev/storage` (wraps `chrome.storage.local`), NOT `localStorage`. See `storage-state.svelte.ts` for the reactive wrapper.

## Execution Order

Work in this exact order. Each step is atomic. Verify before moving on.

### Step 1: Create Search Preferences (`search-preferences.svelte.ts`)

Create a new file at `apps/tab-manager/src/lib/state/search-preferences.svelte.ts`.

This file persists the four search toggle states via `createStorageState`, which uses WXT's `@wxt-dev/storage` to persist to `chrome.storage.local` with reactive Svelte 5 state and arktype schema validation.

Follow the exact pattern from `settings.svelte.ts`:

```ts
/**
 * Persisted search preferences backed by chrome.storage.local.
 *
 * Toggle states survive panel close/reopen and sync across extension
 * contexts (popup, sidebar) via chrome.storage.onChanged.
 *
 * @see {@link ./storage-state.svelte}: chrome.storage reactive wrapper
 */

import { type } from 'arktype';
import { createStorageState } from './storage-state.svelte';

/** Whether search matching is case-sensitive. */
export const searchCaseSensitive = createStorageState('local:search.case.sensitive', {
  fallback: false,
  schema: type('boolean'),
});

/** Whether the search query is interpreted as a regular expression. */
export const searchRegex = createStorageState('local:search.regex', {
  fallback: false,
  schema: type('boolean'),
});

/** Whether to match whole words (titles) or exact URLs. */
export const searchExactMatch = createStorageState('local:search.exact.match', {
  fallback: false,
  schema: type('boolean'),
});

/** Which fields to search: all, title only, or URL only. */
export const searchField = createStorageState('local:search.field', {
  fallback: 'all' as const,
  schema: type("'all' | 'title' | 'url'"),
});
```

**MUST DO**:
- Follow the JSDoc style from `settings.svelte.ts` and `auth.ts`
- Use `local:search.*` key prefix to namespace under "search"
- Use arktype schemas for validation

**Verify**: Run `lsp_diagnostics` on the new file.

### Step 2: Export normalizeUrl (`tab-helpers.ts`)

In `apps/tab-manager/src/lib/utils/tab-helpers.ts`, `normalizeUrl` is currently a private function. Add `export` to it:

```ts
export function normalizeUrl(url: string): string {
```

That's the only change to this file.

**Verify**: Run `lsp_diagnostics` on the file.

### Step 3: State + Filter Logic (`unified-view-state.svelte.ts`)

Read the existing file at `apps/tab-manager/src/lib/state/unified-view-state.svelte.ts`.

Add imports for the search preferences and normalizeUrl:

```ts
import {
  searchCaseSensitive,
  searchRegex,
  searchExactMatch,
  searchField,
} from '$lib/state/search-preferences.svelte';
import { normalizeUrl } from '$lib/utils/tab-helpers';
```

Add a regex escape utility inside `createUnifiedViewState()`, above `matchesFilter`:

```ts
/** Escape special regex characters for safe use in `new RegExp()`. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

Rewrite `matchesFilter`. The logic:

1. If not filtering, return true (unchanged)
2. Read `searchField.current` to determine which fields to test
3. For each field being tested, apply the match mode:
   - **Regex mode** (`searchRegex.current`): construct `new RegExp(searchQuery, searchCaseSensitive.current ? '' : 'i')`. Wrap in try/catch. Return `false` on invalid regex. Test against the raw field value.
   - **Exact match mode** (`searchExactMatch.current`):
     - For **title**: whole-word boundary match using `new RegExp('\\b' + escapeRegex(q) + '\\b', flags)`
     - For **URL**: exact match after normalization: `normalizeUrl(url) === normalizeUrl(searchQuery)`
   - **Default mode**: substring `includes` (current behavior, but now respecting `searchCaseSensitive.current`)
4. Return true if ANY tested field matches

Add an `isRegexInvalid` derived for the UI:

```ts
const isRegexInvalid = $derived.by(() => {
  if (!searchRegex.current || !isFiltering) return false;
  try { new RegExp(searchQuery); return false; }
  catch { return true; }
});
```

Update the return object. Add proxy getters/setters that:
- Read/write `.current` on the corresponding `createStorageState` export
- Enforce mutual exclusivity: setting `isRegex = true` sets `searchExactMatch.current = false` and vice versa

```ts
return {
  // ... existing properties ...

  /** Whether search matching is case-sensitive. Persisted to chrome.storage. */
  get isCaseSensitive() { return searchCaseSensitive.current; },
  set isCaseSensitive(value: boolean) { searchCaseSensitive.current = value; },

  /** Whether the query is interpreted as a regular expression. Persisted. Mutually exclusive with exactMatch. */
  get isRegex() { return searchRegex.current; },
  set isRegex(value: boolean) {
    searchRegex.current = value;
    if (value) searchExactMatch.current = false;
  },

  /** Whether to match whole words (titles) or exact URLs. Persisted. Mutually exclusive with regex. */
  get isExactMatch() { return searchExactMatch.current; },
  set isExactMatch(value: boolean) {
    searchExactMatch.current = value;
    if (value) searchRegex.current = false;
  },

  /** Which fields to search. Persisted. */
  get searchField() { return searchField.current; },
  set searchField(value: 'all' | 'title' | 'url') { searchField.current = value; },

  /** Whether the current regex pattern is invalid. */
  get isRegexInvalid() { return isRegexInvalid; },
};
```

**MUST DO**:
- Keep the `flatItems` derivation completely unchanged. It already calls `matchesFilter`, so it picks up the new behavior automatically
- The `$derived` chain will reactively pick up `.current` changes from `createStorageState` because the wrapper uses `$state` internally
- Do NOT add any `$state` for the toggle values. They live in `search-preferences.svelte.ts`

**MUST NOT DO**:
- Don't change the `FlatItem` type
- Don't change `flatItems` derivation logic
- Don't change section expansion behavior
- Don't use `localStorage`: this is a Chrome extension, use the `createStorageState` pattern

**Verify**: Run `lsp_diagnostics` on the file after changes.

### Step 4: UI: Search Toggles + Field Scope (`App.svelte`)

Read `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`.

Add imports:

```ts
import { Toggle } from '@epicenter/ui/toggle';
import * as ToggleGroup from '@epicenter/ui/toggle-group';
import * as Tooltip from '@epicenter/ui/tooltip';
import CaseSensitiveIcon from '@lucide/svelte/icons/case-sensitive';
import RegexIcon from '@lucide/svelte/icons/regex';
import WholeWordIcon from '@lucide/svelte/icons/whole-word';
```

Note: `Tooltip` is already available via `@epicenter/ui/tooltip` and the app is wrapped in `<Tooltip.Provider>`.

Restructure the search input area. The current layout is:

```
<div class="relative flex-1">
  <SearchIcon ... />
  <Input ... class="h-8 pl-8 pr-8 ..." />
  {#if searchQuery} <button (clear)> {/if}
</div>
```

The new layout should be:

```
<div class="relative flex-1">
  <SearchIcon ... />
  <Input ... class="h-8 pl-8 pr-24 ..." />  <!-- more right padding -->
  <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
    {#if unifiedViewState.searchQuery}
      <button (clear)> ... </button>
    {/if}
    <!-- Three toggles with tooltips -->
  </div>
</div>
```

For each toggle, use the honeycrisp pattern (Toggle wrapped in Tooltip):

```svelte
<Tooltip.Root>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      <Toggle
        size="sm"
        bind:pressed={unifiedViewState.isCaseSensitive}
        aria-label="Match Case"
        class="size-6 rounded-sm p-0"
        {...props}
      >
        <CaseSensitiveIcon class="size-3.5" />
      </Toggle>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content>Match Case</Tooltip.Content>
</Tooltip.Root>
```

Repeat for regex ("Use Regular Expression") and whole word ("Match Whole Word").

**IMPORTANT**: The Toggle wrapping in Tooltip requires the `{#snippet child({ props })}` pattern to forward trigger props. This is how bits-ui tooltip triggers work with custom components. Look at how `Button` does it in `packages/ui/src/button/button.svelte` for reference.

Add the field scope ToggleGroup. Place it after the search input `<div>` and before the Commands button:

```svelte
<ToggleGroup.Root
  type="single"
  size="sm"
  variant="outline"
  bind:value={unifiedViewState.searchField}
  class="h-7"
>
  <ToggleGroup.Item value="all" class="px-1.5 text-xs h-7">All</ToggleGroup.Item>
  <ToggleGroup.Item value="title" class="px-1.5 text-xs h-7">Title</ToggleGroup.Item>
  <ToggleGroup.Item value="url" class="px-1.5 text-xs h-7">URL</ToggleGroup.Item>
</ToggleGroup.Root>
```

**MUST DO**:
- Increase input `pr-*` padding to make room for toggles (calculate based on 3 toggles × size-6 + gaps + clear button)
- Keep all existing keyboard shortcuts (/, @, Escape) working. They're in the `onkeydown` handler on the Input, which doesn't change
- Keep the existing Commands, AI Chat, and Sync buttons unchanged
- Ensure toggles are vertically centered within the input

**MUST NOT DO**:
- Don't remove any existing functionality
- Don't change the Tooltip.Provider wrapping. It already exists at the top of the template
- Don't add any new dependencies

**Verify**: Run `lsp_diagnostics` on App.svelte.

### Step 5: Empty State Update (`UnifiedTabList.svelte`)

Read `apps/tab-manager/src/lib/components/tabs/UnifiedTabList.svelte`.

Update the "No matching tabs" empty state to hint about regex when relevant:

```svelte
{#if unifiedViewState.isFiltering}
  <Empty.Title>No matching tabs</Empty.Title>
  <Empty.Description>
    {#if unifiedViewState.isRegex && unifiedViewState.isRegexInvalid}
      Check your regular expression syntax
    {:else}
      No tabs match "{unifiedViewState.searchQuery}"
    {/if}
  </Empty.Description>
{/if}
```

**Verify**: Run `lsp_diagnostics` on the file.

### Step 6: Final Verification

- Run `lsp_diagnostics` on all changed files
- Verify no TypeScript errors were introduced
- List all changes made as a summary

## Files Changed (Expected)

1. `apps/tab-manager/src/lib/state/search-preferences.svelte.ts`: **NEW**: Persisted search toggle states via `createStorageState`
2. `apps/tab-manager/src/lib/utils/tab-helpers.ts`: Export `normalizeUrl`
3. `apps/tab-manager/src/lib/state/unified-view-state.svelte.ts`: Import preferences, updated `matchesFilter`, proxy getters/setters
4. `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: Toggle UI, field scope ToggleGroup
5. `apps/tab-manager/src/lib/components/tabs/UnifiedTabList.svelte`: Regex hint in empty state

## Key Patterns to Follow

- **Storage**: `createStorageState` from `storage-state.svelte.ts` (NOT `localStorage`)
- **Toggle + Tooltip**: honeycrisp editor pattern (`apps/honeycrisp/src/lib/editor/Editor.svelte`)
- **ToggleGroup**: whispering app pattern (`apps/whispering/src/routes/(app)/+page.svelte`)
- **Settings file**: `settings.svelte.ts` for `createStorageState` usage
- **Import style**: `@epicenter/ui/toggle`, `@lucide/svelte/icons/case-sensitive`
