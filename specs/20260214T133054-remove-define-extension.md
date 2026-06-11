# Remove `defineExtension`: Flatten Extension Return Type

**Date**: 2026-02-14
**Status**: Complete
**Author**: AI-assisted
**PR**: [#1359](https://github.com/EpicenterHQ/epicenter/pull/1359): Merged 2026-02-14. Shipped alongside FS Explorer v0 scaffold.

## Overview

Remove the `defineExtension()` wrapper function and its `Extension<T>` return type from the public API. Extension factories will return a flat `{ exports?, whenReady?, destroy? }` object directly. The framework normalizes internally.

## Motivation

### Current State

Extension factories must call `defineExtension()` to restructure a flat bag of fields into the framework's internal `{ exports, lifecycle: { whenReady, destroy } }` shape:

```typescript
// Every extension author writes this today:
return defineExtension({
	exports: { db, pullToSqlite },
	whenReady: initPromise,
	destroy: () => db.close(),
});

// defineExtension restructures it to:
// { exports: { db, pullToSqlite }, lifecycle: { whenReady: initPromise, destroy: () => db.close() } }
```

The function also provides defaults (`whenReady: Promise.resolve()`, `destroy: () => {}`).

This creates problems:

1. **Unnecessary indirection**: `defineExtension` is a normalizer that converts `{ exports?, whenReady?, destroy? }` → `{ exports, lifecycle: { whenReady, destroy } }`. Every caller thinks in the flat shape. Nobody thinks about the `{ exports, lifecycle }` split: that's a framework implementation detail.
2. **Type inference gymnastics**: Because `exports` is optional, a single generic can't distinguish "no exports → `Record<string, never>`" from "has exports → infer T." This required function overloads to fix, which is a type-level symptom of the design trying to be two functions in one.
3. **Extra import and boilerplate**: Every extension file must import `defineExtension` and wrap its return value. Lifecycle-only extensions still need `return defineExtension()` or `return defineExtension({ whenReady })`.

### Desired State

Extension factories return a plain object. The framework handles normalization:

```typescript
// Extension with exports + lifecycle
.withExtension('sqlite', (ctx) => ({
  exports: { db, pullToSqlite, pushFromSqlite },
  whenReady: initPromise,
  destroy: () => db.close(),
}))

// Lifecycle-only (no exports)
.withExtension('persistence', (ctx) => ({
  whenReady: loadFromDisk(),
  destroy: () => flush(),
}))

// Exports-only (no lifecycle)
.withExtension('helpers', () => ({
  exports: { compute: (x: number) => x * 2 },
}))
```

No wrapper function. No import. No overloads. TypeScript infers `T` from the object literal naturally.

## Research Findings

### Real Extension Call Sites (Production Code)

Every production extension was audited to determine which fields they actually use:

| Extension              | `exports` | `whenReady` | `destroy` |
| ---------------------- | --------- | ----------- | --------- |
| SQLite                 | Yes       | Yes         | Yes       |
| Markdown               | Yes       | Yes         | Yes       |
| IndexedDB (web)        | Yes       | Yes         | Yes       |
| Revision History       | Yes       | No          | Yes       |
| Desktop persistence    | No        | Yes         | No        |
| App workspace persist. | No        | Yes         | Yes       |

**Key findings**:

- All three fields are genuinely independent: all four quadrants of the exports/lifecycle matrix are occupied (including exports-only in test code).
- When `exports` is present in production, `destroy` is always present (4/4). This is a natural correlation (resources need cleanup), not a constraint worth encoding in types.
- `whenReady` is the most independent axis: some extensions are synchronously ready, others need async init.
- The defaults `defineExtension` provides (`whenReady: Promise.resolve()`, `destroy: noop`) are rarely exercised in production: most extensions provide all the fields they need.

### How the Framework Consumes Extensions

Both `static/create-workspace.ts` and `dynamic/workspace/create-workspace.ts` do the exact same thing with the `Extension<T>` return value:

```typescript
const result = factory(client);
extensionCleanups.push(() => result.lifecycle.destroy());
whenReadyPromises.push(result.lifecycle.whenReady);
// ...
[key]: result.exports,
```

That's it. Three field accesses. The normalization can trivially move here.

## Design Decisions

| Decision                              | Choice                 | Rationale                                                                                                                    |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| All three fields optional             | Yes                    | All four quadrants of exports/lifecycle are occupied in real usage. Requiring any field adds noise for valid use cases.      |
| `exports` field name                  | Keep `exports`         | Distinguishes "what consumers see" from lifecycle concerns. Returning bare methods at the top level would blur the boundary. |
| Where normalization happens           | Inside `withExtension` | The framework already destructures the result. Adding three `?? default` lines is trivial.                                   |
| Remove `Extension<T>` from public API | Yes                    | It can remain internal if needed, but extension authors should never see it.                                                 |
| Remove `defineExtension` entirely     | Yes                    | Zero runtime value. The function is `{ exports: x ?? {}, lifecycle: { whenReady: y ?? resolved, destroy: z ?? noop } }`.     |

## Architecture

### Before (Current)

```
Extension Author                    Framework
─────────────────                   ─────────

{ exports, whenReady, destroy }
        │
        ▼
  defineExtension()
  (normalizes to Extension<T>)
        │
        ▼
  { exports, lifecycle }  ────────► withExtension() reads
                                    result.lifecycle.destroy
                                    result.lifecycle.whenReady
                                    result.exports
```

### After (Proposed)

```
Extension Author                    Framework
─────────────────                   ─────────

{ exports?, whenReady?, destroy? }
        │
        └──────────────────────────► withExtension() reads
                                    result.destroy ?? noop
                                    result.whenReady ?? Promise.resolve()
                                    result.exports ?? {}
```

One fewer layer. The split between exports and lifecycle is internal bookkeeping, not an authoring concern.

## Implementation Plan

### Phase 1: Define the New Return Type

- [ ] **1.1** In `shared/lifecycle.ts`, define a new type for what extension factories return:

```typescript
/**
 * What extension factories return: a flat object with optional exports and lifecycle hooks.
 * The framework normalizes defaults internally.
 */
export type ExtensionReturn<
	T extends Record<string, unknown> = Record<string, never>,
> = {
	exports?: T;
	whenReady?: Promise<unknown>;
	destroy?: () => MaybePromise<void>;
};
```

- [ ] **1.2** Keep `Lifecycle` and `MaybePromise` types: they're used elsewhere (providers). Only `Extension<T>` and `defineExtension` are being removed.

### Phase 2: Update `withExtension` in Both Workspace Systems

Both files do the same thing. Update them identically.

- [ ] **2.1** In `static/create-workspace.ts`, change the `withExtension` method:
  - Change the factory return type from `Extension<TExports>` to `ExtensionReturn<TExports>` (or inline the shape).
  - Replace `result.lifecycle.destroy()` → `result.destroy?.() ?? undefined` (or normalize once at the top).
  - Replace `result.lifecycle.whenReady` → `result.whenReady ?? Promise.resolve()`.
  - Replace `result.exports` → `result.exports ?? ({} as TExports)`.

- [ ] **2.2** Do the same in `dynamic/workspace/create-workspace.ts`.

### Phase 3: Update Type Declarations

- [ ] **3.1** In `static/types.ts`:
  - Update `WorkspaceClientBuilder.withExtension` signature: factory returns the flat shape instead of `Extension<TExports>`.
  - Update `ExtensionFactory` type alias to use the new return type.
  - Update JSDoc examples to show plain object returns.

- [ ] **3.2** In `dynamic/workspace/types.ts`:
  - Same changes as above for the dynamic workspace system.

### Phase 4: Handle the Type Inference for `withExtension`

This is the trickiest part. When a factory returns `{ whenReady }` (no `exports`), TypeScript must infer `TExports` as `Record<string, never>`. When it returns `{ exports: { db } }`, `TExports` must be `{ db: ... }`.

**Recommended approach**: Two overloads on `withExtension` (moves the overloads from `defineExtension` to where they belong: the framework boundary):

```typescript
// Overload 1: factory returns object WITH exports: T inferred from exports value
withExtension<TKey extends string, TExports extends Record<string, unknown>>(
  key: TKey,
  factory: (context: ExtensionContext) => {
    exports: TExports;
    whenReady?: Promise<unknown>;
    destroy?: () => MaybePromise<void>;
  },
): WorkspaceClientBuilder<..., TExtensions & Record<TKey, TExports>>;

// Overload 2: factory returns object WITHOUT exports: empty exports
withExtension<TKey extends string>(
  key: TKey,
  factory: (context: ExtensionContext) => {
    exports?: undefined;
    whenReady?: Promise<unknown>;
    destroy?: () => MaybePromise<void>;
  } | void,
): WorkspaceClientBuilder<..., TExtensions & Record<TKey, Record<string, never>>>;
```

This keeps the overloads inside the framework (where they belong) instead of in a helper function that every extension author calls. The type complexity is hidden from consumers.

**Alternative**: A single signature with a conditional type to extract exports. Try this first: if it works, it's simpler:

```typescript
withExtension<TKey extends string, TResult extends ExtensionReturn<Record<string, unknown>>>(
  key: TKey,
  factory: (context: ExtensionContext) => TResult,
): WorkspaceClientBuilder<..., TExtensions & Record<TKey,
  TResult extends { exports: infer E extends Record<string, unknown> } ? E : Record<string, never>
>>;
```

Either approach works. The overloads are more explicit; the conditional type is more concise. Use whichever gives better IDE hover types.

### Phase 5: Update All Call Sites

- [ ] **5.1** Remove all `defineExtension(...)` wrappers: just return the inner object directly.

**Files to update (production)**:

- `packages/epicenter/src/extensions/sqlite/sqlite.ts`: has exports + whenReady + destroy
- `packages/epicenter/src/extensions/markdown/markdown.ts`: has exports + whenReady + destroy
- `packages/epicenter/src/extensions/revision-history/local.ts`: has exports + destroy
- `packages/epicenter/src/extensions/sync/desktop.ts`: has whenReady only
- `packages/epicenter/src/extensions/sync/web.ts`: has exports + whenReady + destroy
- `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: has whenReady + destroy

**Files to update (tests)**: many call sites, mechanical replacement:

- `packages/epicenter/src/static/define-workspace.test.ts`
- `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`

For each, the change is:

```typescript
// Before
return defineExtension({
	exports: { db },
	whenReady: initPromise,
	destroy: () => db.close(),
});

// After
return {
	exports: { db },
	whenReady: initPromise,
	destroy: () => db.close(),
};
```

For lifecycle-only extensions:

```typescript
// Before
return defineExtension({ whenReady });

// After
return { whenReady };
```

For bare extensions:

```typescript
// Before
return defineExtension();

// After
return {};
```

- [ ] **5.2** Remove the `defineExtension` import from all files.

### Phase 6: Remove `defineExtension` and Clean Up Exports

- [ ] **6.1** In `shared/lifecycle.ts`: Delete `defineExtension` function (all overloads + implementation). Delete `Extension<T>` type (or rename to `_NormalizedExtension<T>` if needed internally).
- [ ] **6.2** In `static/index.ts`: Remove `defineExtension` and `Extension` from exports. Export `ExtensionReturn` if useful for extension authors typing their factories.
- [ ] **6.3** In `dynamic/index.ts`: Same as above.
- [ ] **6.4** In `src/index.ts` (root): Same as above.
- [ ] **6.5** Update JSDoc throughout `shared/lifecycle.ts`, type files, and README files that reference `defineExtension`.

### Phase 7: Verify

- [ ] **7.1** Run `bun tsc --noEmit` (or equivalent type check): zero type errors.
- [ ] **7.2** Run all tests: `bun test` from packages/epicenter.
- [ ] **7.3** Run the app build if applicable.
- [ ] **7.4** Grep the entire repo for any remaining `defineExtension` references (imports, JSDoc, comments, READMEs). Clean up any stragglers.

## Edge Cases

### Factory returning `void` or `undefined`

Some test extensions return `defineExtension()` with no args (bare lifecycle). After this change, they'd return `{}`. The framework should also handle factories that return `void` / `undefined`: normalize to empty exports + resolved whenReady + noop destroy. Check that the `withExtension` overload/type handles `void` returns.

### Factory returning only `{ whenReady }`

Desktop persistence returns only `{ whenReady }`. No exports, no destroy. After the change, this is just `return { whenReady }`. The framework must handle missing `destroy` (use noop) and missing `exports` (use `{}`).

### Type inference when `exports` is a getter-based object

Some extensions use getters in exports (e.g., `get provider() { return currentProvider }`). Verify that TypeScript still infers the correct type from the plain object literal. This should work fine since TypeScript infers getter types from object literals.

## Open Questions

1. **Should `ExtensionReturn<T>` be exported for extension authors to type their factories?**
   - It's useful for: `const myExtension: (ctx: ExtensionContext) => ExtensionReturn<{ db: Database }> = ...`
   - But most authors won't need it: TypeScript infers the return type from the object literal.
   - **Recommendation**: Export it but don't emphasize it. It's there if you need explicit typing.

2. **Overloads vs conditional type on `withExtension`?**
   - Overloads: More explicit, better error messages, proven pattern (we used them on `defineExtension`).
   - Conditional type: Single signature, less code, but IDE hover types can be ugly.
   - **Recommendation**: Try conditional type first. If hover types are bad, fall back to overloads.

## Success Criteria

- [ ] `defineExtension` is completely removed: zero references in the codebase (code, imports, JSDoc, READMEs)
- [ ] `Extension<T>` is removed from the public API (not exported)
- [ ] All existing extension factories return plain objects (no wrapper function)
- [ ] Type inference works: `withExtension('x', () => ({ exports: { n: 1 } }))` infers `extensions.x.n` as `number`
- [ ] Type inference works: `withExtension('x', () => ({ whenReady }))` infers `extensions.x` as `Record<string, never>`
- [ ] All tests pass
- [ ] Type check passes with zero errors

## References

- `packages/epicenter/src/shared/lifecycle.ts`: `defineExtension`, `Extension<T>`, `Lifecycle` (keep Lifecycle)
- `packages/epicenter/src/static/create-workspace.ts`: `withExtension` implementation (static)
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: `withExtension` implementation (dynamic)
- `packages/epicenter/src/static/types.ts`: `WorkspaceClientBuilder`, `ExtensionFactory`, `ExtensionContext`
- `packages/epicenter/src/dynamic/workspace/types.ts`: same types for dynamic system
- `packages/epicenter/src/static/index.ts`: public exports (static)
- `packages/epicenter/src/dynamic/index.ts`: public exports (dynamic)
- `packages/epicenter/src/index.ts`: root public exports
