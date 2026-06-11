# Collapse Browser Converters into Schema Constructors

**Status**: Obsolete (target files deleted)

> **Note (2026-02-14):** `browser-helpers.ts` no longer exists and `createBrowserConverters` has zero references in the codebase. The code this spec targeted was removed during prior refactoring. Nothing to do.

## Problem

`browser-helpers.ts` has a `createBrowserConverters(deviceId)` factory that returns device-scoped ID constructors (`toTabId`, `toWindowId`, `toGroupId`) and row converters (`tabToRow`, `windowToRow`, `tabGroupToRow`). Meanwhile, `browser.schema.ts` has branded type + const pairs (`TabCompositeId`, `WindowCompositeId`, `GroupCompositeId`) that currently just assert strings. They don't do any real work.

The ID constructor logic (joining `${deviceId}_${nativeId}`) belongs in the schema constructors. The factory indirection is unnecessary.

## Plan

### 1. Upgrade schema constructors to accept `(deviceId, nativeId)` and do the join

Replace the current assert-only arktype pipes with real constructor functions:

```typescript
// BEFORE
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').pipe(
	(s): TabCompositeId => s as TabCompositeId,
);

// AFTER
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export function TabCompositeId(
	deviceId: string,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}
```

Same for `WindowCompositeId` and `GroupCompositeId`.

> NOTE: The arktype pipe form is still needed in the table definitions for runtime schema validation (deserialization from Y.Doc). We'll keep a private/inline arktype pipe for the `defineTable` calls, and the exported value becomes the constructor function.

Actually. The `defineTable` calls use `TabCompositeId` as a schema value. If we change the const to a function, those table definitions break. We need the arktype schema for table definitions.

**Solution**: Create separate arktype schemas for table use (private), and export the constructor functions as the public value-side:

```typescript
// Private arktype schemas for table definitions
const tabCompositeIdSchema = type('string').pipe(
	(s): TabCompositeId => s as TabCompositeId,
);

// Public constructor function (the exported value)
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export function TabCompositeId(
	deviceId: string,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}
```

Then in table definitions, use `tabCompositeIdSchema` instead of `TabCompositeId`.

### 2. Move row converters to `browser.schema.ts`

Move `tabToRow`, `windowToRow`, `tabGroupToRow` from `browser-helpers.ts` into `browser.schema.ts` as exported functions. They take `(deviceId, browserObject)` directly, no factory needed.

### 3. Update all call sites

Replace:

```typescript
const { toTabId, tabToRow } = createBrowserConverters(deviceId);
toTabId(123);
tabToRow(tab);
```

With:

```typescript
TabCompositeId(deviceId, 123);
tabToRow(deviceId, tab);
```

### 4. Delete `browser-helpers.ts`

### 5. Update article

Add the constructor-that-does-work pattern alongside the existing assert-only pattern.

## Todo

- [ ] Upgrade `TabCompositeId`, `WindowCompositeId`, `GroupCompositeId` in `browser.schema.ts` to constructor functions + keep private schemas for table defs
- [ ] Move `tabToRow`, `windowToRow`, `tabGroupToRow` to `browser.schema.ts` as standalone functions taking `(deviceId, browserObject)`
- [ ] Update `background.ts`: replace all `createBrowserConverters` usage with direct calls
- [ ] Update `query/tabs.ts`: replace all `createBrowserConverters` usage with direct calls
- [ ] Delete `browser-helpers.ts`
- [ ] Update `epicenter/index.ts` exports if needed
- [ ] Update `same-name-for-type-and-value.md` article with both patterns
- [ ] Verify no LSP diagnostics / type errors

## Review

### Changes Made

1. **`browser.schema.ts`**: Added `createTabCompositeId`, `createWindowCompositeId`, `createGroupCompositeId` constructor functions. Moved `tabToRow`, `windowToRow`, `tabGroupToRow` from `browser-helpers.ts` as standalone `(deviceId, browserObject)` functions. Kept `TabCompositeId`/`WindowCompositeId`/`GroupCompositeId` const validators unchanged (used in `defineTable` calls). Updated JSDoc on the branded types.

2. **`background.ts`**: Replaced all 15 `createBrowserConverters(deviceId)` call sites with direct `createTabCompositeId`/`createWindowCompositeId`/`createGroupCompositeId`/`tabToRow`/`windowToRow`/`tabGroupToRow` calls.

3. **`query/tabs.ts`**: Same: replaced 3 `createBrowserConverters` usages with direct imports.

4. **Deleted `browser-helpers.ts`**: No longer needed.

5. **`same-name-for-type-and-value.md`**: Added "Shadowed type with a validator + separate constructor" section documenting the `Type`, `Type`, `createType` three-part pattern. Updated the summary table.

### Decision: `create` prefix vs shadowed name

Per user preference, constructor functions use the `create` prefix (`createTabCompositeId`) rather than shadowing the PascalCase name. The PascalCase name stays reserved for the arktype validator which is used in `defineTable` schema definitions.
