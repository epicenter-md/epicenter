# Tab Actions & Quick Actions Cleanup

Files under review:
- `apps/tab-manager/src/lib/tab-actions.ts`
- `apps/tab-manager/src/lib/quick-actions.ts`

---

## Tier 1 — Clear Wins (no debate, minimal risk)

### 1. Remove unnecessary manual type predicates

TS 5.5+ auto-infers `.filter()` type predicates. These are noise.

**tab-actions.ts:119**
```typescript
// Before
.filter((id): id is number => id !== undefined)

// After
.filter((id) => id !== undefined)
```

**quick-actions.ts:147, 199, 272** — same pattern.

**quick-actions.ts:203**
```typescript
// Before
.filter((op): op is { domain: string; nativeIds: number[] } => op !== null)

// After
.filter((op) => op !== null)
```

Pure deletion. Zero behavior change.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/tab-actions.ts` and `apps/tab-manager/src/lib/quick-actions.ts`, remove all unnecessary manual type predicates from `.filter()` callbacks. TS 5.5+ infers these automatically.

Specifically:
- `tab-actions.ts:119` — `.filter((id): id is number => id !== undefined)` → `.filter((id) => id !== undefined)`
- `quick-actions.ts:147, 199, 272` — same `: id is number` removal
- `quick-actions.ts:203` — `.filter((op): op is { domain: string; nativeIds: number[] } => op !== null)` → `.filter((op) => op !== null)`

Pure deletion only. No behavior changes. Run `lsp_diagnostics` on both files after to confirm no type errors.
</details>

---

### 2. ~~Use `SavedTabId` brand constructor instead of double-cast~~ — SKIPPED

**Deferred to dedicated spec.** Investigation revealed that `SavedTabId` is an arktype validator (`type('string').pipe(...)`) used in `defineTable()` schema composition — not a callable brand constructor. Calling `SavedTabId(value)` returns `SavedTabId | ArkErrors`, which isn't directly assignable.

The double-cast `generateId() as string as SavedTabId` appeared in **7 sites across 4 files**. This was later resolved by extending `Id` instead of `string` in the type definition (`Id & Brand<'SavedTabId'>`), eliminating the double-cast entirely.

**Resolution**: A separate spec (`20260312T180000-branded-id-convention.md`) standardizes the three-part branded ID convention:
1. `type SavedTabId = Id & Brand<'SavedTabId'>` — branded type extending `Id` for single-cast
2. `const SavedTabId = type('string').as<SavedTabId>()` — arktype validator (zero-cost type cast)
3. `const generateSavedTabId = (): SavedTabId => generateId() as SavedTabId` — factory with single-cast

This applies to all branded IDs codebase-wide, not just `SavedTabId`.


### 3. Replace `try/catch` with `tryAsync` in `executeActivateTab`

**tab-actions.ts:68–73**
```typescript
// Before
try {
    await browser.tabs.update(id, { active: true });
    return { activated: true };
} catch {
    return { activated: false };
}

// After
const { error } = await tryAsync({
    try: () => browser.tabs.update(id, { active: true }),
    catch: () => Ok(undefined),
});
return { activated: !error };
```

Direct pattern swap. Matches every other Chrome API call in the file.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/tab-actions.ts`, replace the `try/catch` block in `executeActivateTab` (lines 68–73) with `tryAsync`. The file already imports `tryAsync` and `Ok` from `wellcrafted/result`. Use:

```typescript
const { error } = await tryAsync({
    try: () => browser.tabs.update(id, { active: true }),
    catch: () => Ok(undefined),
});
return { activated: !error };
```

This replaces the `try { ... return { activated: true } } catch { return { activated: false } }` block. Run `lsp_diagnostics` after to confirm no type errors.
</details>

---

### 4. Replace empty catch block with `tryAsync` in `sortAction`

**quick-actions.ts:175–179**
```typescript
// Before
try {
    await browser.tabs.move(parsed.tabId, { index: i });
} catch {
    // Tab may not exist
}

// After
await tryAsync({
    try: () => browser.tabs.move(parsed.tabId, { index: i }),
    catch: () => Ok(undefined),
});
```

Eliminates an anti-pattern (empty catch block). Same graceful swallow, consistent style.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/quick-actions.ts`, replace the `try/catch` with empty catch block in `sortAction.execute` (lines 175–179) with `tryAsync`. The file already imports `tryAsync` and `Ok` from `wellcrafted/result`. Use:

```typescript
await tryAsync({
    try: () => browser.tabs.move(parsed.tabId, { index: i }),
    catch: () => Ok(undefined),
});
```

This replaces `try { await browser.tabs.move(...) } catch { // Tab may not exist }`. Run `lsp_diagnostics` after to confirm no type errors.
</details>

---

### 5. Wrap unprotected Chrome API calls with `tryAsync`

Two exported functions have zero error handling on browser APIs that can throw.

**`executeOpenTab` (tab-actions.ts:54–55)**
```typescript
// Before
const tab = await browser.tabs.create({ url });
return { tabId: String(tab.id ?? -1) };

// After
const { data: tab, error } = await tryAsync({
    try: () => browser.tabs.create({ url }),
    catch: () => Ok(undefined),
});
if (error || !tab) return { tabId: String(-1) };
return { tabId: String(tab.id ?? -1) };
```

**`executeGroupTabs` (tab-actions.ts:142–151)** — both `browser.tabs.group()` and `browser.tabGroups.update()` need wrapping. Exact shape TBD during implementation—main point is neither call is protected today.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/tab-actions.ts`, wrap the unprotected Chrome API calls in `executeOpenTab` and `executeGroupTabs` with `tryAsync`. The file already imports `tryAsync` and `Ok` from `wellcrafted/result`.

For `executeOpenTab` (lines 54–55), wrap `browser.tabs.create({ url })`:
```typescript
const { data: tab, error } = await tryAsync({
    try: () => browser.tabs.create({ url }),
    catch: () => Ok(undefined),
});
if (error || !tab) return { tabId: String(-1) };
return { tabId: String(tab.id ?? -1) };
```

For `executeGroupTabs` (lines 142–151), wrap both `browser.tabs.group()` and `browser.tabGroups.update()` with `tryAsync`. Each call should gracefully handle failure — if `tabs.group()` fails, return a fallback `groupId: String(-1)`. If `tabGroups.update()` fails, swallow with `Ok(undefined)` (the group was already created, the title/color just didn't apply).

Run `lsp_diagnostics` after to confirm no type errors.
</details>

---

## Tier 2 — Solid improvements, small judgment calls

### 6. Fix `tab.url!` non-null assertion in `executeSaveTabs`

**tab-actions.ts:105**

The filter checks `!!r.value.url` but TypeScript can't narrow through the `PromiseFulfilledResult` wrapper + `.map()` boundary. Options:

- **Option A**: Combine filter + map into a single `.flatMap()` that extracts the url in the same step, eliminating the need for `!`.
- **Option B**: Leave the `!` with an inline comment explaining why it's safe.

Leaning toward A—it's cleaner and removes the assertion entirely.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/tab-actions.ts`, fix the `tab.url!` non-null assertion on line 105 inside `executeSaveTabs`. The current code filters `PromiseFulfilledResult` entries for truthy `.url` and then maps, but TypeScript can't narrow through that boundary.

Refactor the `results` → `validTabs` pipeline (lines 94–99) to use `.flatMap()` so the URL truthiness check and value extraction happen in the same step, eliminating the need for `!`. The resulting `validTabs` array entries should have `url: string` (not `string | undefined`).

Don't change any other logic in the function. Run `lsp_diagnostics` after to confirm no type errors.
</details>

---

### 7. Expand JSDoc on exported functions in `tab-actions.ts`

Current docs are bare one-liners (`/** Close the specified tabs. */`). Per AGENTS.md, exported functions should document:
- What the function does and when to use it
- Parameter semantics (especially `deviceId` scoping)
- Error behavior (what happens on Chrome API failure)
- `@example` block

Not urgent, but the file is a public API surface consumed by `workspace.ts`.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/tab-actions.ts`, expand the JSDoc on all exported functions (`executeCloseTabs`, `executeOpenTab`, `executeActivateTab`, `executeSaveTabs`, `executeGroupTabs`, `executePinTabs`, `executeMuteTabs`, `executeReloadTabs`). Load the `documentation` skill first.

Each function's JSDoc should include:
- A description of what the function does and when it's called (these are Chrome API execution functions used by `.withActions()` mutation handlers in workspace.ts)
- Parameter semantics — especially how `deviceId` scopes composite IDs to the local device
- Error behavior — what happens when Chrome API calls fail (graceful swallow, partial success count, etc.)
- An `@example` block with realistic usage

Don't change any code logic — JSDoc only.
</details>

---

### 8. Investigate `as TabCompositeId` casts in `quick-actions.ts`

Lines 146, 173, 198, 271 all cast `tab.id as TabCompositeId`. Two possibilities:

- **`browserState` already types `.id` as `TabCompositeId`** → casts are redundant noise, just remove them.
- **`browserState` types `.id` as `string`** → the upstream type is wrong. Fix it there, then remove the casts.

Needs a quick check of `browser-state.svelte.ts` to determine which case.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/quick-actions.ts`, lines 146, 173, 198, and 271 all cast `tab.id as TabCompositeId`. Investigate whether this cast is necessary.

1. Check the type of `tab.id` as returned by `browserState.tabsByWindow()` and `browserState.windows.flatMap(...)` in `$lib/state/browser-state.svelte.ts`.
2. If `tab.id` is already typed as `TabCompositeId` → remove all four `as TabCompositeId` casts (they're redundant).
3. If `tab.id` is typed as `string` → the upstream type in browser-state is wrong. Fix the type there so these casts become unnecessary, then remove them.

Run `lsp_diagnostics` on both files after to confirm no type errors.
</details>

---

## Tier 3 — More debatable (adds indirection or is a UX decision)

### 9. Extract duplicated native ID conversion into a shared helper

The pattern appears 6× in `tab-actions.ts`:
```typescript
const nativeIds = tabIds
    .map((id) => nativeTabId(id, deviceId))
    .filter((id) => id !== undefined);
```

And 3× in `quick-actions.ts` (using `parseTabId` instead):
```typescript
const nativeIds = tabIds
    .map((tabId) => parseTabId(tabId as TabCompositeId)?.tabId)
    .filter((id) => id !== undefined);
```

A helper like `toNativeIds(tabIds, deviceId)` would deduplicate both variants.

**Counterargument**: The pattern is 3 lines, immediately readable, and each call site is self-contained. Extracting adds a layer of indirection for a trivial operation. The duplication is repetitive but not error-prone—there's no logic to drift.

Include or skip based on taste.

<details>
<summary>Prompt</summary>

In `apps/tab-manager/src/lib/tab-actions.ts`, extract the repeated native ID conversion pattern into a helper function. The pattern appears 6 times:

```typescript
const nativeIds = tabIds
    .map((id) => nativeTabId(id, deviceId))
    .filter((id) => id !== undefined);
```

Create a private helper `toNativeIds(tabIds: string[], deviceId: DeviceId): number[]` that encapsulates this, and replace all 6 occurrences.

Then in `apps/tab-manager/src/lib/quick-actions.ts`, the same concept appears 3 times but using `parseTabId` directly:
```typescript
const nativeIds = tabIds
    .map((tabId) => parseTabId(tabId as TabCompositeId)?.tabId)
    .filter((id) => id !== undefined);
```

Create a similar helper `compositeToNativeIds(compositeIds: string[]): number[]` in quick-actions.ts (or export from tab-actions if it makes sense) and replace those 3 occurrences.

Run `lsp_diagnostics` on both files after to confirm no type errors.
</details>

---

### 10. `closeByDomainAction` silently picks the top domain

Current behavior: finds whichever domain has the most open tabs and offers to close those. The comment says `This action needs a domain picker`. This is a UX decision, not a code quality fix—leaving it here for awareness but it's out of scope for a cleanup pass.

---

## Review

### Summary

All 10 items addressed. 8 committed as individual refactors, 1 skipped (deferred), 1 out of scope.

| Item | Description | Status | Commit |
|------|-------------|--------|--------|
| 1 | Remove redundant type predicates | ✅ Committed | `f0b3f30b9` |
| 2 | SavedTabId double-cast cleanup | ⏭️ Skipped | Deferred to `20260312T180000-branded-id-convention.md` |
| 3 | `try/catch` → `tryAsync` in executeActivateTab | ✅ Committed | `06358567b` |
| 4 | Empty catch → `tryAsync` in sortAction | ✅ Committed | `42ffd84b9` |
| 5 | Wrap unprotected Chrome API calls | ✅ Committed | `88458d564` |
| 6 | Eliminate `tab.url!` non-null assertion | ✅ Committed | `ebe2e01bf` |
| 7 | Expand JSDoc on exported functions | ✅ Committed | `e11404b1f` |
| 8 | Fix upstream types, remove TabCompositeId casts | ✅ Committed | `be8837030` |
| 9 | Extract native ID conversion helpers | ✅ Committed | `fb6eb5522` |
| 10 | `closeByDomainAction` domain picker | 🚫 Out of scope | UX decision, not code quality |

### Key Discoveries

1. **TS 5.5+ type predicate inference**—Manual type predicates on `.filter()` are unnecessary noise. TypeScript infers them automatically.
2. **`SavedTabId` is an arktype validator**, not a simple brand—Calling it returns `SavedTabId | ArkErrors`. A separate spec (`20260312T180000-branded-id-convention.md`) standardizes the three-part pattern: branded type (extending `Id`) + arktype validator + `generate*` factory. The `Id & Brand<'SavedTabId'>` base type eliminates the double-cast.
3. **`Tab.id` was already `TabCompositeId`**—The casts in quick-actions.ts were caused by helper functions (`findDuplicates`, `getUniqueDomains`) widening return types to `string`. Fixed upstream.
4. **`toNativeIds()` and `compositeToNativeIds()`**—Extracted to replace 9 total inline occurrences of the map-filter-parse pattern across both files.
