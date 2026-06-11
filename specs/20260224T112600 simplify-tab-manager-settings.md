# Simplify Tab Manager Settings: Delete Unused Reactive Layer

## Problem

`apps/tab-manager/src/lib/state/` has two files for server URL settings:

1. **`settings.ts`** (73 lines): defines 2 `storage.defineItem` items + re-exports `createReactiveSettings` from the other file
2. **`reactive-storage.svelte.ts`** (208 lines): generic `createReactiveStorageItem<T>` utility + `createReactiveSettings()` factory

**`createReactiveSettings()` has zero consumers.** Nothing imports it.

The only actual usage is `chat.svelte.ts` importing `getHubServerUrl` from settings. A function that doesn't exist (stale import from a previous iteration). It works around this by caching a default URL and updating it with a one-shot `.getValue()`.

### What's wrong

- 281 lines across 2 files for 0 consumers
- Circular-import dance (settings re-exports from reactive-storage, which dynamically imports settings)
- `createSubscriber` bridge is correct pattern for async external state, but nothing needs it reactively right now
- `getHubServerUrl` import in `chat.svelte.ts` references a non-existent export

## Approach

Lean into WXT's native `storage.defineItem` primitives. Delete the reactive layer entirely. Add simple async getters where needed.

## Todo

- [x] Delete `reactive-storage.svelte.ts`
- [x] Simplify `settings.ts`: keep `defineItem` declarations, add `getServerUrl()` and `getHubServerUrl()` async helpers, remove the re-export
- [x] Fix `chat.svelte.ts`: import resolves correctly now that `getHubServerUrl` exists
- [x] Verify: `lsp_diagnostics` clean on all changed files
- [x] Verify: typecheck: 79 pre-existing errors (all in packages/ui + packages/epicenter), 0 from our changes

## Files Touched

| File                                                        | Action                             |
| ----------------------------------------------------------- | ---------------------------------- |
| `apps/tab-manager/src/lib/state/reactive-storage.svelte.ts` | Delete                             |
| `apps/tab-manager/src/lib/state/settings.ts`                | Simplify: keep items, add getters |
| `apps/tab-manager/src/lib/state/chat.svelte.ts`             | Import should self-heal; verify    |

## What We're Preserving

- `createReactiveStorageItem` pattern is documented in `docs/articles/createsubscriber-cache-for-async-external-state.md`: if a component later needs live-reactive storage reads, reintroduce it then
- WXT `storage.defineItem` items with their `fallback` values
- The async getter pattern that `chat.svelte.ts` already uses

## Review

### Changes Made

1. **Deleted `reactive-storage.svelte.ts`** (208 lines): the entire `createSubscriber` bridge and `createReactiveSettings` factory. Zero consumers existed.
2. **Simplified `settings.ts`** (73 → 80 lines): kept the two `storage.defineItem` declarations (now `const` instead of `export const` since they're implementation details), added thin `getServerUrl()` and `getHubServerUrl()` async getters that wrap `.getValue()`, removed the re-export of `createReactiveSettings`.
3. **`chat.svelte.ts` unchanged**: its existing `import { getHubServerUrl } from '$lib/state/settings'` now resolves to the actual function we added.

### Net effect

- **281 → 80 lines** (−72%)
- **2 files → 1 file**
- Circular import dance eliminated
- `createSubscriber` pattern preserved in docs (`docs/articles/createsubscriber-cache-for-async-external-state.md`) for when a component actually needs live-reactive storage reads