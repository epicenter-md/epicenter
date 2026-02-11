# Unify Extension Naming Across Static API

**Status:** Implemented
**Created:** 2026-02-05
**Priority:** HIGH (Prerequisite for static-only server architecture)

## Problem Statement

The static and dynamic APIs use different terminology for the same concept:

**Static API:**
- Type: `CapabilityFactory`
- Map type: `CapabilityMap`
- Context: `CapabilityContext`
- Method: `.withExtensions()` ✓
- Client property: `client.capabilities`

**Dynamic API:**
- Type: `ExtensionFactory`
- Map type: `ExtensionFactoryMap`
- Context: `ExtensionContext`
- Method: `.withExtensions()` ✓
- Client property: `client.extensions`

**The Inconsistency:**
- The method is called `.withExtensions()` in BOTH APIs
- But static stores them as "capabilities" while dynamic stores them as "extensions"
- Users are confused: "Am I adding extensions or capabilities?"

## Goal

**Standardize on "extensions" terminology across the entire static API.**

This aligns with:
1. The method name `.withExtensions()`
2. Common terminology (VSCode extensions, Chrome extensions)
3. The dynamic API (for consistency if we ever need to reference both)
4. User expectations

## Scope

**Files to change:**
- `packages/epicenter/src/static/types.ts` - Type definitions
- `packages/epicenter/src/static/create-workspace.ts` - Implementation
- `packages/epicenter/src/static/index.ts` - Exports
- All files importing these types

**Breaking change:** Yes - this renames public API types and properties

## Detailed Changes

### 1. Rename Type Definitions

**File:** `packages/epicenter/src/static/types.ts`

**Find and replace (case-sensitive):**

| Old Name | New Name | Occurrences |
|----------|----------|-------------|
| `CapabilityFactory` | `ExtensionFactory` | ~10 |
| `CapabilityMap` | `ExtensionMap` | ~8 |
| `CapabilityContext` | `ExtensionContext` | ~5 |
| `InferCapabilityExports` | `InferExtensionExports` | ~6 |

**Before:**
```typescript
export type CapabilityFactory<
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
  TExports extends Lifecycle,
> = (
  context: CapabilityContext<TTableDefinitions, TKvDefinitions>,
) => TExports;

export type CapabilityMap = Record<string, CapabilityFactory<any, any, any>>;

export type CapabilityContext<
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
> = {
  id: string;
  ydoc: Y.Doc;
  tables: TablesHelper<TTableDefinitions>;
  kv: KvHelper<TKvDefinitions>;
};

export type InferCapabilityExports<TCapabilities extends CapabilityMap> = {
  [K in keyof TCapabilities]: ReturnType<TCapabilities[K]>;
};
```

**After:**
```typescript
export type ExtensionFactory<
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
  TExports extends Lifecycle,
> = (
  context: ExtensionContext<TTableDefinitions, TKvDefinitions>,
) => TExports;

export type ExtensionMap = Record<string, ExtensionFactory<any, any, any>>;

export type ExtensionContext<
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
> = {
  id: string;
  ydoc: Y.Doc;
  tables: TablesHelper<TTableDefinitions>;
  kv: KvHelper<TKvDefinitions>;
};

export type InferExtensionExports<TExtensions extends ExtensionMap> = {
  [K in keyof TExtensions]: ReturnType<TExtensions[K]>;
};
```

### 2. Rename WorkspaceClient Property

**File:** `packages/epicenter/src/static/types.ts`

**Before:**
```typescript
export type WorkspaceClient<
  TId extends string,
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
  TCapabilities extends CapabilityMap,
> = {
  id: TId;
  ydoc: Y.Doc;
  tables: TablesHelper<TTableDefinitions>;
  kv: KvHelper<TKvDefinitions>;
  capabilities: InferCapabilityExports<TCapabilities>;  // ← RENAME

  destroy(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
```

**After:**
```typescript
export type WorkspaceClient<
  TId extends string,
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
  TExtensions extends ExtensionMap,  // ← Rename type param
> = {
  id: TId;
  ydoc: Y.Doc;
  tables: TablesHelper<TTableDefinitions>;
  kv: KvHelper<TKvDefinitions>;
  extensions: InferExtensionExports<TExtensions>;  // ← RENAMED

  destroy(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
```

### 3. Update Generic Type Parameter Names

Throughout `types.ts`, rename the 4th type parameter from `TCapabilities` to `TExtensions`:

**Find and replace:**
- `TCapabilities extends CapabilityMap` → `TExtensions extends ExtensionMap`
- References to `TCapabilities` → `TExtensions`

**Affected types:**
- `WorkspaceClient<TId, TTableDefs, TKvDefs, TCapabilities>` → `WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions>`
- `WorkspaceClientBuilder<TId, TTableDefs, TKvDefs>` → (no change, it doesn't have extensions yet)
- `WorkspaceClientWithActions<..., TCapabilities, ...>` → `WorkspaceClientWithActions<..., TExtensions, ...>`
- `AnyWorkspaceClient` → (no change, uses `any` for all params)

### 4. Update Implementation

**File:** `packages/epicenter/src/static/create-workspace.ts`

**Changes:**

1. Rename `.withExtensions()` parameter type:
```typescript
// Before
withExtensions<TCapabilities extends CapabilityMap>(
  extensions: TCapabilities,
): WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TCapabilities>

// After
withExtensions<TExtensions extends ExtensionMap>(
  extensions: TExtensions,
): WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TExtensions>
```

2. Rename internal variable:
```typescript
// Before
const capabilities = Object.fromEntries(
  Object.entries(extensions).map(([key, factory]) => [
    key,
    factory(context),
  ])
) as InferCapabilityExports<TCapabilities>;

// After
const extensionExports = Object.fromEntries(
  Object.entries(extensions).map(([key, factory]) => [
    key,
    factory(context),
  ])
) as InferExtensionExports<TExtensions>;
```

3. Update return object:
```typescript
// Before
return {
  ...baseClient,
  capabilities,
  // ...
};

// After
return {
  ...baseClient,
  extensions: extensionExports,
  // ...
};
```

### 5. Update Exports

**File:** `packages/epicenter/src/static/index.ts`

**Find and replace in export list:**

```typescript
// Before
export type {
  // ...
  CapabilityContext,
  CapabilityFactory,
  CapabilityMap,
  InferCapabilityExports,
  // ...
} from './types.js';

// After
export type {
  // ...
  ExtensionContext,
  ExtensionFactory,
  ExtensionMap,
  InferExtensionExports,
  // ...
} from './types.js';
```

### 6. Update Extension Files (Optional - Can be separate PR)

**Files:** `/packages/epicenter/src/extensions/**/*.ts`

These files currently import from dynamic:
```typescript
import { ExtensionFactory } from '../../dynamic';
```

After this refactor, they can import from static:
```typescript
import { ExtensionFactory } from '../../static/types';
```

**But this is optional** - these files can be updated later when we make the server static-only.

### 7. Update Documentation and Comments

**Files:** Various

Search for mentions of "capability" in comments and documentation, update to "extension":

- JSDoc comments in `types.ts`
- README files mentioning the API
- Example code snippets
- Inline comments explaining the system

## Migration Guide for Users

**Breaking Change Notice:**

If you're using the static API, you'll need to update your code:

### Type Imports
```typescript
// Before
import type { CapabilityFactory, CapabilityMap } from '@epicenter/hq/static';

// After
import type { ExtensionFactory, ExtensionMap } from '@epicenter/hq/static';
```

### Client Property Access
```typescript
const client = createWorkspace(def)
  .withExtensions({ persistence });

// Before
client.capabilities.persistence.save();

// After
client.extensions.persistence.save();
```

### Extension Definitions
```typescript
// Before
export const myExtension: CapabilityFactory<TTableDefs, TKvDefs, MyExports> = (context) => {
  return { ... };
};

// After
export const myExtension: ExtensionFactory<TTableDefs, TKvDefs, MyExports> = (context) => {
  return { ... };
};
```

### Generic Type Parameters
```typescript
// Before
function useWorkspace<TCapabilities extends CapabilityMap>(
  client: WorkspaceClient<string, any, any, TCapabilities>
) { ... }

// After
function useWorkspace<TExtensions extends ExtensionMap>(
  client: WorkspaceClient<string, any, any, TExtensions>
) { ... }
```

## Testing Strategy

### 1. Type Tests
- Verify all type exports are renamed correctly
- Check that `WorkspaceClient` type has `extensions` property
- Ensure generic type parameters work with new names

### 2. Runtime Tests
- Run existing test suite - should pass with no changes
- Add test that accesses `client.extensions` property
- Verify `.withExtensions()` method still works

### 3. Integration Tests
- Build a workspace with extensions
- Access extension exports via `client.extensions`
- Verify `whenSynced` and `destroy` work on extensions

### 4. Example Apps
- Update tab-manager app if it uses static API with extensions
- Test that apps compile and run
- Verify no runtime errors

## Implementation Checklist

- [x] Find and replace type names in `types.ts`
  - [x] `CapabilityFactory` → `ExtensionFactory`
  - [x] `CapabilityMap` → `ExtensionMap`
  - [x] `CapabilityContext` → `ExtensionContext`
  - [x] `InferCapabilityExports` → `InferExtensionExports`
  - [x] `TCapabilities` → `TExtensions` (type param)

- [x] Rename `capabilities` property to `extensions` in `WorkspaceClient` type

- [x] Update implementation in `create-workspace.ts`
  - [x] Rename variables (`capabilityExports` → `extensionExports`, `clientWithCapabilities` → `clientWithExtensions`, etc.)
  - [x] Update return object property name

- [x] Update exports in `index.ts`

- [x] Update all imports throughout codebase
  - [x] Search for `CapabilityFactory` imports
  - [x] Search for `CapabilityMap` imports
  - [x] Search for `CapabilityContext` imports

- [x] Update JSDoc comments and documentation

- [x] Run type check: `bun run typecheck` (0 errors in static API; pre-existing errors in CLI/dynamic unrelated)

- [x] Run tests: `bun test` (96/96 pass)

- [x] Update tab-manager app (`client.capabilities.persistence` → `client.extensions.persistence`)

- [x] Update docs articles (`20260127T120000-static-workspace-api-guide.md`, `remove-default-generics-for-pass-through-types.md`)

- [ ] (Optional) Update extension files to import from static (deferred to static-only server migration)

## Rollback Plan

If this breaks too much:
1. Revert all commits from this change
2. Consider adding type aliases for backwards compatibility:
   ```typescript
   /** @deprecated Use ExtensionFactory */
   export type CapabilityFactory = ExtensionFactory;
   ```
3. Gradually deprecate old names over multiple versions

## Success Criteria

1. ✅ All type references use "Extension" terminology
2. ✅ `client.extensions` property replaces `client.capabilities`
3. ✅ All tests pass (96/96)
4. ✅ No TypeScript errors in static API
5. ✅ Documentation updated
6. ✅ Tab-manager app updated

## Estimated Effort

- **Find and replace:** 30 minutes
- **Testing:** 30 minutes
- **Documentation updates:** 30 minutes
- **Review:** 15 minutes

**Total:** ~2 hours

## Why This Matters

**Consistency:** Method is `.withExtensions()` but you access `.capabilities`? Confusing!

**Before:**
```typescript
.withExtensions({ persistence })  // Adding extensions...
client.capabilities.persistence   // ...but they're called capabilities?
```

**After:**
```typescript
.withExtensions({ persistence })  // Adding extensions...
client.extensions.persistence     // ...and they're called extensions! ✓
```

**User Experience:** Reduces cognitive load, aligns with ecosystem norms, makes API more intuitive.

## References

- Static types: `/packages/epicenter/src/static/types.ts`
- Static implementation: `/packages/epicenter/src/static/create-workspace.ts`
- Dynamic types (for reference): `/packages/epicenter/src/dynamic/workspace/types.ts`
