# Unify Extension Lifecycle

**Date**: 2026-02-20
**Status**: Draft
**Author**: AI-assisted

> **Superseded (Phase 6):** The `ctx.client` factory context pattern proposed in Phase 6 was superseded by `specs/20260220T195800-flatten-extension-context.md` (Implemented). Extension factories now receive flat context `{ ydoc, tables, ... }` directly instead of `{ client: { ydoc, tables, ... } }`. Phases 0-5 of this spec remain valid.

## Overview

Unify the promise initialization, destroy ordering, error handling, and factory context patterns across `withExtension()` (workspace-level) and `withDocumentExtension()` (document-level) into a single consistent model. Culminates in a shared `runExtensionFactories()` internal helper and a `ctx.client` factory signature that both APIs use identically.

## Motivation

### Current State

Two independent implementations handle extension lifecycle:

**Workspace extensions** (`create-workspace.ts`):

```typescript
// Shared mutable arrays (closed over, not passed)
const extensionCleanups: (() => MaybePromise<void>)[] = [];
const whenReadyPromises: Promise<unknown>[] = [];

function buildClient(extensions) {
	const whenReady = Promise.all(whenReadyPromises).then(() => {});
	return {
		withExtension(key, factory) {
			const raw = factory(client); // factory IS the client
			const resolved = defineExtension(raw ?? {}); // void → noop extension
			extensionCleanups.push(resolved.destroy);
			whenReadyPromises.push(resolved.whenReady);
			return buildClient({ ...extensions, [key]: resolved });
		},
	};
}
```

**Document extensions** (`create-document-binding.ts` inside `open()`):

```typescript
const resolvedExtensions = {};
const destroys = [];
const whenReadyPromises = [];

try {
	for (const reg of applicableExtensions) {
		const compositeWhenReady =
			whenReadyPromises.length === 0
				? Promise.resolve()
				: Promise.all(whenReadyPromises).then(() => {});

		const raw = reg.factory({
			ydoc,
			whenReady: compositeWhenReady, // explicit whenReady param
			binding,
			extensions: { ...resolvedExtensions },
		});

		if (raw) {
			// void → SKIP
			const resolved = defineExtension(raw);
			resolvedExtensions[reg.key] = resolved;
			destroys.push(resolved.destroy);
			whenReadyPromises.push(resolved.whenReady);
		}
	}
} catch (err) {
	await Promise.allSettled(destroys.map((d) => d()));
	throw err;
}
```

This creates problems:

1. **Shared mutable arrays**: Workspace builder closes over `extensionCleanups[]` and `whenReadyPromises[]`. If someone branches the builder (`base.withExtension('a', ...)` and `base.withExtension('b', ...)`), the arrays contain both branches' state, making `destroy()` and `whenReady` incoherent.
2. **Inconsistent error handling**: Document extensions have try/catch + .catch() cleanup. Workspace extensions have none: factory throws and whenReady rejects propagate unhandled, leaking resources.
3. **Void return divergence**: Workspace does `raw ?? {}` (always registers a noop). Document does `if (raw)` (skips entirely). Different semantics for the same pattern.
4. **Destroy ordering mismatch**: Workspace uses LIFO sequential (correct for dependency chains). Document uses parallel `Promise.allSettled` (unsafe for flush/observer races).
5. **Factory context asymmetry**: Workspace factory receives the full client object directly (`ctx.ydoc`, `ctx.tables`). Document factory receives a slim struct (`ctx.ydoc`, `ctx.binding`). The `whenReady` comes from different sources (rebuilt client vs explicit param).

### Desired State

Both APIs use a shared internal primitive for running extension factories. Factories receive a uniform context shape. Destroy, error handling, void semantics, and promise composition are identical.

```typescript
// Both APIs use the same factory context shape:
.withExtension('sync', (ctx) => {
    ctx.client.ydoc       // scope-specific client (workspace or document)
    ctx.whenReady          // always computed by runner (composite of prior)
    ctx.extensions.a       // prior extensions
})

.withDocumentExtension('sync', (ctx) => {
    ctx.client.ydoc        // scope-specific client (document)
    ctx.client.binding     // document-specific metadata
    ctx.whenReady          // always computed by runner (composite of prior)
    ctx.extensions.a?      // optional (tag filtering)
})
```

## Design Decisions

| Decision            | Choice                                            | Rationale                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destroy ordering    | LIFO sequential, continue-on-error                | Later extensions depend on earlier ones (sync→persistence). Parallel destroy causes real races: final flushes, queued observer events, SQLite close during index write. Sequential LIFO is the only safe default. |
| Void factory return | Skip (don't register)                             | "Not installed" is clearer than "installed as noop". If you want a noop, return `{}` explicitly. Document API already does this.                                                                                  |
| Builder state       | Immutable (new arrays per buildClient)            | Fixes branching bug. Each builder snapshot has its own destroys/whenReady. No shared mutation.                                                                                                                    |
| Error handling      | Try/catch in both, cleanup on throw               | Match document extension's battle-tested pattern. Factory throw cleans up already-resolved extensions. whenReady reject triggers cleanup.                                                                         |
| Factory context     | `ctx.client` + `ctx.whenReady` + `ctx.extensions` | Uniform shape across both APIs. `client` is scope-specific. `whenReady` is always computed by the runner, not inherited from the client object.                                                                   |
| Internal helper     | `runExtensionFactories()` in shared/              | Single source of truth for factory execution, promise composition, error handling. Both APIs call this.                                                                                                           |
| Dynamic workspace   | Update to match static                            | The dynamic `create-workspace.ts` has the same shared-array pattern. Apply the same fixes.                                                                                                                        |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  shared/run-extension-factories.ts                        │
│                                                           │
│  runExtensionFactories(entries, seed?) → RunResult         │
│    - Runs factories synchronously in order                │
│    - Builds composite whenReady incrementally             │
│    - Collects destroys in creation order                  │
│    - try/catch per factory with LIFO cleanup on throw     │
│    - void return = skip                                   │
│    - Returns { extensions, destroys, whenReady }          │
└──────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────────┐   ┌──────────────────────────────┐
│  static/create-workspace │   │  static/create-document-binding│
│                          │   │                               │
│  buildClient(state) {    │   │  open(input) {                │
│    state is immutable    │   │    entries = filter by tags    │
│    withExtension calls   │   │    result = runExtension-      │
│    runExtensionFactories │   │      Factories(entries)        │
│    with 1 entry + seed   │   │    cache result               │
│  }                       │   │  }                            │
└─────────────────────────┘   └──────────────────────────────┘
```

### Destroy flow (both APIs, unified)

```
STEP 1: Collect destroys in creation order
─────────────────────────────────────────
[persistence.destroy, sync.destroy, markdown.destroy]

STEP 2: Destroy in reverse order (LIFO), continue on error
───────────────────────────────────────────────────────────
for (let i = destroys.length - 1; i >= 0; i--) {
    try { await destroys[i](); }
    catch (err) { errors.push(err); }
}
```

### Factory context (both APIs, unified)

```
┌──────────────────────────────────────────────────────────┐
│  ExtensionContext<TClient, TExtensions>                    │
│                                                           │
│  client: TClient          ← scope-specific                │
│  whenReady: Promise<void> ← composite of prior extensions │
│  extensions: TExtensions  ← prior resolved extensions     │
└──────────────────────────────────────────────────────────┘

Workspace: TClient = { id, ydoc, definitions, tables, kv, awareness, batch }
Document:  TClient = { ydoc, binding }
```

## Implementation Plan

### Phase 0: Baseline Tests (establish test coverage before changes)

Before making any changes, establish a baseline test suite to verify behavior before and after each phase.

- [ ] **0.1** Add test: builder branching creates independent extension sets

  ```typescript
  test('builder branching creates isolated extension sets', () => {
	const base = createWorkspace(def).withExtension('a', () => ({
		value: 'a',
	}));
	const b1 = base.withExtension('b', () => ({ value: 'b' }));
	const b2 = base.withExtension('c', () => ({ value: 'c' }));

	expect(Object.keys(base.extensions)).toEqual(['a']);
	expect(Object.keys(b1.extensions)).toEqual(['a', 'b']);
	expect(Object.keys(b2.extensions)).toEqual(['a', 'c']);
  });
  ```

- [ ] **0.2** Add test: void-returning factories don't register in extensions map

  ```typescript
  test('void-returning factory does not appear in extensions', () => {
	const client = createWorkspace(def)
		.withExtension('noop', () => undefined)
		.withExtension('real', () => ({ value: 42 }));

	expect(client.extensions.noop).toBeUndefined();
	expect(client.extensions.real).toBeDefined();
	expect(client.extensions.real.value).toBe(42);
  });
  ```

- [ ] **0.3** Add test: factory throw in workspace cleans up prior extensions (LIFO order)

  ```typescript
  test('factory throw in workspace cleans up prior extensions in LIFO order', async () => {
	const cleanupOrder: string[] = [];
	const factory =
		(name: string, shouldThrow = false) =>
		() => {
			if (shouldThrow) throw new Error(`${name} factory failed`);
			return { destroy: async () => cleanupOrder.push(name) };
		};

	try {
		createWorkspace(def)
			.withExtension('first', factory('first'))
			.withExtension('second', factory('second'))
			.withExtension('third', factory('third', true)); // throws
	} catch {
		// expected
	}

	expect(cleanupOrder).toEqual(['second', 'first']); // LIFO, skips 'third'
  });
  ```

- [ ] **0.4** Add test: document extension destroy order is LIFO (reverse creation order)

  ```typescript
  test('document extension destroy order is LIFO', async () => {
	const destroyOrder: string[] = [];
	const factory = (name: string) => () => ({
		destroy: async () => destroyOrder.push(name),
	});

	const binding = createDocumentBinding({
		guidKey: 'id',
		updatedAtKey: 'updatedAt',
		tableHelper: mockTable,
		ydoc: mockYdoc,
		documentExtensions: [
			{ key: 'first', factory: factory('first'), tags: [] },
			{ key: 'second', factory: factory('second'), tags: [] },
			{ key: 'third', factory: factory('third'), tags: [] },
		],
	});

	const handle = await binding.open('doc-1');
	await binding.close('doc-1');

	expect(destroyOrder).toEqual(['third', 'second', 'first']); // LIFO
  });
  ```

- [ ] **0.5** Add test: whenReady rejection in workspace triggers cleanup

  ```typescript
  test('whenReady rejection in workspace triggers cleanup', async () => {
	const cleanupCalled = new Set<string>();
	let rejectWhenReady: (() => void) | undefined;
	const whenReadyPromise = new Promise<void>((_, reject) => {
		rejectWhenReady = () => reject(new Error('provider failed'));
	});

	const client = createWorkspace(def)
		.withExtension('first', () => ({
			destroy: async () => cleanupCalled.add('first'),
		}))
		.withExtension('second', () => ({
			whenReady: whenReadyPromise,
			destroy: async () => cleanupCalled.add('second'),
		}));

	// Trigger rejection
	rejectWhenReady?.();

	try {
		await client.whenReady;
	} catch {
		// expected
	}

	expect(cleanupCalled.has('first')).toBe(true);
	expect(cleanupCalled.has('second')).toBe(true);
  });
  ```

- [ ] **0.6** Add test: document extension whenReady rejection triggers cleanup

  ```typescript
  test('document extension whenReady rejection triggers cleanup', async () => {
	const cleanupCalled = new Set<string>();
	let rejectWhenReady: (() => void) | undefined;
	const whenReadyPromise = new Promise<void>((_, reject) => {
		rejectWhenReady = () => reject(new Error('provider failed'));
	});

	const binding = createDocumentBinding({
		guidKey: 'id',
		updatedAtKey: 'updatedAt',
		tableHelper: mockTable,
		ydoc: mockYdoc,
		documentExtensions: [
			{
				key: 'first',
				factory: () => ({ destroy: async () => cleanupCalled.add('first') }),
				tags: [],
			},
			{
				key: 'second',
				factory: () => ({
					whenReady: whenReadyPromise,
					destroy: async () => cleanupCalled.add('second'),
				}),
				tags: [],
			},
		],
	});

	const handlePromise = binding.open('doc-1');
	rejectWhenReady?.();

	try {
		await handlePromise;
	} catch {
		// expected
	}

	expect(cleanupCalled.has('first')).toBe(true);
	expect(cleanupCalled.has('second')).toBe(true);
  });
  ```

- [ ] **0.7** Verify all tests pass before proceeding to Phase 1

### Phase 1: **BREAKING** - Immutable builder state (fix builder branching bug)

**Status: BREAKING CHANGE**

The current implementation closes over mutable `extensionCleanups[]` and `whenReadyPromises[]` arrays, causing a critical bug where branching builders share extension state. This phase fixes the bug by using immutable state tuples instead.

**Breaking Impact:**

- Code that relies on builder branching producing shared extension state will break
- This is a BUG FIX, not a design change
- No existing code should rely on the buggy behavior

**Implementation:**

- [ ] **1.1** Define `BuilderState` type in `static/create-workspace.ts`:

  ```typescript
  type BuilderState = {
	extensionCleanups: (() => MaybePromise<void>)[];
	whenReadyPromises: Promise<unknown>[];
  };
  ```

- [ ] **1.2** Refactor `buildClient` to accept `state: BuilderState` parameter instead of closing over shared arrays

- [ ] **1.3** Each `withExtension` call creates new arrays instead of mutating:

  ```typescript
  const newState: BuilderState = {
	extensionCleanups: [...state.extensionCleanups, resolved.destroy],
	whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
  };
  return buildClient(newExtensions, newState);
  ```

- [ ] **1.4** Update `createWorkspace` initialization to pass initial empty state:

  ```typescript
  return buildClient(
	{},
	{
		extensionCleanups: [],
		whenReadyPromises: [],
	},
  );
  ```

- [ ] **1.5** Apply identical changes to `dynamic/workspace/create-workspace.ts`

- [ ] **1.6** Run baseline test 0.1: should now PASS (was failing before)

- [ ] **1.7** Verify all existing tests still pass: `bun test`

### Phase 2: **BREAKING** - LIFO sequential destroy for all extensions

**Status: BREAKING CHANGE**

The current document binding uses `Promise.allSettled` (parallel destroy), which is unsafe for extensions with dependencies (e.g., sync must complete before persistence closes). This phase enforces LIFO sequential destroy everywhere.

**Breaking Impact:**

- Extensions expecting parallel cleanup will break
- Extensions with destructors relying on parallel execution timing will fail
- This is CORRECT behavior: parallel destroy is unsafe

**Implementation:**

- [ ] **2.1** Update `close()` in `create-document-binding.ts`:

  ```typescript
  async close(input: TRow | string): Promise<void> {
    const guid = resolveGuid(input);
    const entry = docs.get(guid);
    if (!entry) return;

    docs.delete(guid);
    entry.unobserve();

    // Destroy in LIFO order (reverse creation), continue on error
    const errors: unknown[] = [];
    const extensions = Object.values(entry.extensions);
    for (let i = extensions.length - 1; i >= 0; i--) {
      try {
        await extensions[i]!.destroy();
      } catch (err) {
        errors.push(err);
      }
    }

    entry.ydoc.destroy();

    if (errors.length > 0) {
      throw new Error(`Document extension cleanup errors: ${errors.length}`);
    }
  }
  ```

- [ ] **2.2** Update `closeAll()` to use same LIFO pattern:

  ```typescript
  async closeAll(): Promise<void> {
    const entries = Array.from(docs.entries());
    docs.clear();
    unobserveTable();

    for (const [, entry] of entries) {
      entry.unobserve();

      const errors: unknown[] = [];
      const extensions = Object.values(entry.extensions);
      for (let i = extensions.length - 1; i >= 0; i--) {
        try {
          await extensions[i]!.destroy();
        } catch (err) {
          errors.push(err);
        }
      }

      entry.ydoc.destroy();

      if (errors.length > 0) {
        console.error('Document extension cleanup error:', errors);
      }
    }
  }
  ```

- [ ] **2.3** Update error cleanup paths in factory try/catch to also use LIFO:

  ```typescript
  } catch (err) {
    const errors: unknown[] = [];
    const extensions = Object.values(resolvedExtensions);
    for (let i = extensions.length - 1; i >= 0; i--) {
      try {
        await extensions[i]!.destroy();
      } catch (cleanupErr) {
        errors.push(cleanupErr);
      }
    }
    contentYdoc.destroy();

    if (errors.length > 0) {
      console.error('Document extension cleanup errors:', errors);
    }
    throw err; // Rethrow factory error
  }
  ```

- [ ] **2.4** Update whenReady rejection path to use LIFO cleanup:

  ```typescript
  .catch(async (err) => {
    const errors: unknown[] = [];
    const extensions = Object.values(resolvedExtensions);
    for (let i = extensions.length - 1; i >= 0; i--) {
      try {
        await extensions[i]!.destroy();
      } catch (cleanupErr) {
        errors.push(cleanupErr);
      }
    }

    unobserve();
    contentYdoc.destroy();
    docs.delete(guid);

    if (errors.length > 0) {
      console.error('Document extension cleanup errors:', errors);
    }
    throw err;
  });
  ```

- [ ] **2.5** Run baseline test 0.4: should now PASS

- [ ] **2.6** Verify all tests pass: `bun test`

### Phase 3: **BREAKING** - Void return = skip (consistent across all APIs)

**Status: BREAKING CHANGE**

The current implementation has inconsistent void handling: workspace returns noop `{}`, document skips. This phase standardizes to "skip entirely" everywhere (cleaner, more explicit).

**Breaking Impact:**

- Code accessing `extensions['skippedKey']` will get `undefined` instead of noop object
- Code checking `if (extensions.myExt)` will fail if myExt returns void
- This is correct: if you want a noop, return `{}` explicitly

**Pre-Flight Verification:**

- [ ] **3.0** Run pre-flight grep to find all void-returning factories:

  ```bash
  # Find all factories in extensions/
  grep -r "return\s*}" packages/epicenter/src/extensions --include="*.ts" | grep -v test

  # Find all app-level factories
  grep -r "withExtension\|withDocumentExtension" apps --include="*.ts" -A 5 | grep "return\s*}"

  # Find factories in tests (different requirements)
  grep -r "\.withExtension\|\.withDocumentExtension" packages/epicenter/src --include="*.test.ts" -A 3 | grep "return\s*}"
  ```

- [ ] **3.1** Document findings: list which factories (if any) return void
- [ ] **3.2** If none found, proceed. If found, verify each one is intentional and update to return `{}` explicitly
- [ ] **3.3** Add comment to each updated factory explaining why `{}` is returned

**Implementation:**

- [ ] **3.4** Update `withExtension` in `static/create-workspace.ts`:

  ```typescript
  const raw = factory(client);
  if (!raw) {
	// Void return means "not installed": skip registration
	return buildClient(extensions, state);
  }
  const resolved = defineExtension(raw);
  ```

- [ ] **3.5** Apply same change to `dynamic/workspace/create-workspace.ts`

- [ ] **3.6** Verify document binding already has this behavior (it does, in line 274)

- [ ] **3.7** Run baseline test 0.2: should now PASS

- [ ] **3.8** Verify all tests pass: `bun test`

### Phase 4: **BREAKING** - Comprehensive error handling with cleanup

**Status: BREAKING CHANGE**

The current workspace builder has no error handling: thrown factories leak resources. This phase adds try/catch with LIFO cleanup to match document binding semantics.

**Breaking Impact:**

- Factory errors now trigger cleanup (good)
- Error handling semantics change (more robust)
- No code should break unless it was relying on leaked resources

**Implementation:**

- [ ] **4.1** Wrap factory call in `withExtension` with try/catch (static):

  ```typescript
  const withExtension = (key: string, factory: ExtensionFactory) => {
	try {
		const raw = factory(client);
		if (!raw) {
			return buildClient(extensions, state);
		}

		const resolved = defineExtension(raw);
		return buildClient(
			{ ...extensions, [key]: resolved },
			{
				extensionCleanups: [...state.extensionCleanups, resolved.destroy],
				whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
			},
		);
	} catch (err) {
		// Clean up already-resolved extensions (LIFO)
		const errors: unknown[] = [];
		for (let i = state.extensionCleanups.length - 1; i >= 0; i--) {
			try {
				const result = state.extensionCleanups[i]!();
				if (result instanceof Promise) {
					await result;
				}
			} catch (cleanupErr) {
				errors.push(cleanupErr);
			}
		}

		if (errors.length > 0) {
			console.error(
				'Extension cleanup errors during factory failure:',
				errors,
			);
		}

		throw err; // Rethrow factory error
	}
  };
  ```

- [ ] **4.2** Attach `.catch` to final `whenReady` for async rejection handling:

  ```typescript
  const destroy = async (): Promise<void> => {
	const errors: unknown[] = [];
	for (let i = state.extensionCleanups.length - 1; i >= 0; i--) {
		try {
			await state.extensionCleanups[i]!();
		} catch (err) {
			errors.push(err);
		}
	}
	ydoc.destroy();

	if (errors.length > 0) {
		throw new Error(`Extension cleanup errors: ${errors.length}`);
	}
  };

  const client = {
	// ...
	destroy,
	whenReady: Promise.all(state.whenReadyPromises)
		.then(() => {})
		.catch(async (err) => {
			// If any extension's whenReady rejects, clean up everything
			await destroy().catch(() => {}); // idempotent
			throw err;
		}),
  };
  ```

- [ ] **4.3** Apply identical changes to `dynamic/workspace/create-workspace.ts`

- [ ] **4.4** Run baseline tests 0.3 and 0.5: should now PASS

- [ ] **4.5** Verify all tests pass: `bun test`

### Phase 5: Extract shared `runExtensionFactories()` helper

**Status: Internal refactor (no API changes)**

Both static and dynamic workspace use identical extension factory execution logic. This phase extracts it to a shared helper for DRY code and guaranteed consistency.

**Implementation:**

- [ ] **5.1** Create `shared/run-extension-factories.ts`:

  ```typescript
  export type ExtensionFactoryEntry<TContext, TExports> = {
	key: string;
	factory: (ctx: TContext) => TExports & {
		whenReady?: Promise<unknown>;
		destroy?: () => MaybePromise<void>;
	};
  };

  export type RunExtensionFactoriesResult<
	TAccum extends Record<string, unknown>,
  > = {
	extensions: TAccum;
	destroys: (() => MaybePromise<void>)[];
	whenReadyPromises: Promise<unknown>[];
  };

  export function runExtensionFactories<
	TContext extends Record<string, unknown>,
	TAccum extends Record<string, unknown>,
  >(
	entries: ExtensionFactoryEntry<TContext, any>[],
	initialContext: TContext,
	initialAccum: TAccum,
  ): RunExtensionFactoriesResult<TAccum> {
	// Implementation with LIFO cleanup on factory throw
  }
  ```

- [ ] **5.2** Update workspace `withExtension` to use helper:

  ```typescript
  const withExtension = (key, factory) => {
	const result = runExtensionFactories(
		[{ key, factory }],
		client,
		extensions,
	);
	// Use result.extensions, result.destroys, result.whenReadyPromises
  };
  ```

- [ ] **5.3** Update document binding `open()` to use helper (already similar, just refactor to call helper)

- [ ] **5.4** Apply to dynamic workspace

- [ ] **5.5** Verify all tests pass: `bun test`

### Phase 6: **BREAKING** - Unified `ctx.client` factory context pattern

**Status: BREAKING CHANGE**

The current API passes the full client object to factories. This phase introduces the `{ client, whenReady, extensions }` context pattern everywhere for consistency and clarity.

**Breaking Impact:**

- ALL extension factories must be updated
- Signature changes from `(ctx)` to `(ctx)` where `ctx` structure differs
- This is a major API change: users must update their factories

**Type Definitions:**

- [ ] **6.1** Define `ExtensionContext<TClient, TExtensions>` in `shared/lifecycle.ts`:

  ```typescript
  /**
   * Unified context passed to all extension factories.
   *
   * Provides scope-specific client data, composite whenReady promise,
   * and previously registered extensions.
   *
   * @typeParam TClient - Scope-specific client (WorkspaceClient or DocumentClient)
   * @typeParam TExtensions - Previously registered extension exports
   */
  export type ExtensionContext<
	TClient extends Record<string, unknown>,
	TExtensions extends Record<string, unknown> = Record<string, never>,
  > = {
	/** Scope-specific client data (workspace or document) */
	client: TClient;

	/** Composite promise waiting for all prior extensions to be ready */
	whenReady: Promise<void>;

	/** Exports from previously registered extensions (typed) */
	extensions: TExtensions;
  };
  ```

- [ ] **6.2** Define `WorkspaceExtensionClient` in `static/types.ts`:

  ```typescript
  export type WorkspaceExtensionClient<
	TId extends string = string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessSchema extends AwarenessSchema = Record<string, never>,
  > = {
	id: TId;
	ydoc: Y.Doc;
	definitions: {
		tables: TTableDefinitions;
		kv: TKvDefinitions;
		awareness: TAwarenessSchema;
	};
	tables: Tables<TTableDefinitions>;
	kv: KeyValueStore<TKvDefinitions>;
	awareness: AwarenessAttachment<TAwarenessSchema>;
	batch: (fn: () => void) => void;
  };
  ```

- [ ] **6.3** Define `DocumentExtensionClient` in `static/types.ts`:

  ```typescript
  export type DocumentExtensionClient = {
	ydoc: Y.Doc;
	binding: {
		tableName: string;
		documentName: string;
		tags: readonly string[];
	};
  };
  ```

- [ ] **6.4** Define `DynamicWorkspaceExtensionClient` in `dynamic/workspace/types.ts` (similar to static)

- [ ] **6.5** Define `DynamicDocumentExtensionClient` in `dynamic/document/types.ts` (if applicable)

**Update Workspace Builder:**

- [ ] **6.6** Update `withExtension` in `static/create-workspace.ts` to pass new context:

  ```typescript
  const withExtension = <TKey extends string, TExports>(
    key: TKey,
    factory: (ctx: ExtensionContext<WorkspaceExtensionClient, TExtensions>) => TExports & { ... },
  ) => {
    try {
      const ctx: ExtensionContext<WorkspaceExtensionClient, TExtensions> = {
        client: {
          id,
          ydoc,
          definitions,
          tables,
          kv,
          awareness,
          batch: (fn) => ydoc.transact(fn),
        },
        whenReady: currentWhenReady,
        extensions,
      };

      const raw = factory(ctx);
      // ... rest of logic
    } catch (err) {
      // ...
    }
  };
  ```

- [ ] **6.7** Apply identical pattern to `dynamic/workspace/create-workspace.ts`

**Update Document Binding:**

- [ ] **6.8** Update `open()` in `create-document-binding.ts` to pass new context:

  ```typescript
  const ctx: ExtensionContext<DocumentExtensionClient, TResolved> = {
	client: {
		ydoc: contentYdoc,
		binding: { tableName, documentName, tags: documentTags },
	},
	whenReady: compositeWhenReady,
	extensions: resolvedExtensions,
  };

  const raw = reg.factory(ctx);
  ```

**Update All Extension Factories (11 files):**

- [ ] **6.9** Update `packages/epicenter/src/extensions/sync.ts`:

  ```typescript
  // Before
  export function createSyncExtension(options) {
	return (ctx) => {
		const { ydoc } = ctx;
		// ...
	};
  }

  // After
  export function createSyncExtension(options) {
	return (ctx) => {
		const { ydoc, awareness } = ctx.client;
		// ...
	};
  }
  ```

- [ ] **6.10** Update `packages/epicenter/src/extensions/sync/desktop.ts`

- [ ] **6.11** Update `packages/epicenter/src/extensions/sync/web.ts`

- [ ] **6.12** Update `packages/epicenter/src/extensions/sqlite/sqlite.ts`

- [ ] **6.13** Update `packages/epicenter/src/extensions/markdown/markdown.ts`

- [ ] **6.14** Update `packages/epicenter/src/extensions/revision-history/local.ts`

- [ ] **6.15** Update `apps/tab-manager-markdown/src/markdown-persistence-extension.ts`

- [ ] **6.16** Update `apps/epicenter/src/lib/yjs/workspace-persistence.ts`

- [ ] **6.17** Update `apps/tab-manager/src/entrypoints/background.ts`

- [ ] **6.18** Update `apps/tab-manager/src/lib/workspace-popup.ts`

- [ ] **6.19** Update `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`

**Update Types:**

- [ ] **6.20** Update `ExtensionFactory` type alias in `static/types.ts`:

  ```typescript
  export type ExtensionFactory<
	TContext extends Record<string, unknown> = Record<string, unknown>,
	TExports extends Record<string, unknown> = Record<string, unknown>,
  > = (ctx: ExtensionContext<TContext>) => TExports & {
	whenReady?: Promise<unknown>;
	destroy?: () => MaybePromise<void>;
  };
  ```

- [ ] **6.21** Update dynamic workspace types similarly

**Update Tests:**

- [ ] **6.22** Update all tests in `create-workspace.test.ts` to use new context shape

- [ ] **6.23** Update all tests in `define-workspace.test.ts` to use new context shape

- [ ] **6.24** Update all tests in `dynamic/workspace/create-workspace.test.ts`

- [ ] **6.25** Update all tests in `create-document-binding.test.ts`

**Update Documentation:**

- [ ] **6.26** Update JSDoc examples in `static/create-workspace.ts`

- [ ] **6.27** Update JSDoc examples in `static/types.ts`

- [ ] **6.28** Update JSDoc examples in `shared/lifecycle.ts`

- [ ] **6.29** Update JSDoc examples in `dynamic/workspace/create-workspace.ts`

- [ ] **6.30** Update JSDoc examples in `dynamic/workspace/types.ts`

- [ ] **6.31** Update `README.md` files with new context examples

**Verification:**

- [ ] **6.32** Run `bun test`: all tests should pass

- [ ] **6.33** Run `bun run typecheck`: no type errors

- [ ] **6.34** Search for remaining old-style factory patterns (should find none)

## Breaking Changes Summary

### Phase 1: Immutable Builder State (BREAKING)

**What changes:**

- Builder branching now produces correctly isolated extension sets
- This FIXES a bug: previously all branches shared the same extensions array

**Example:**

```typescript
const base = createWorkspace(def).withExtension('a', factoryA);
const b1 = base.withExtension('b', factoryB);
const b2 = base.withExtension('c', factoryC);

// Before Phase 1 (BUG):
// base.extensions = { a, b, c } ← wrong
// b1.extensions = { a, b, c } ← wrong
// b2.extensions = { a, b, c } ← wrong

// After Phase 1 (CORRECT):
// base.extensions = { a } ✓
// b1.extensions = { a, b } ✓
// b2.extensions = { a, c } ✓
```

**Impact:** No code should break unless it relied on the buggy shared state behavior.

**Migration:** None needed. If your code was branching builders, it now works correctly.

---

### Phase 2: LIFO Sequential Destroy (BREAKING)

**What changes:**

- All extensions destroy in LIFO order (reverse creation order)
- Destroy is always sequential, never parallel
- Cleanup errors are logged but don't block the full destroy sequence

**Why:** Extensions have dependencies (sync → persistence). Parallel destroy causes races. Sequential LIFO is the only safe default.

**Example:**

```typescript
binding
	.withDocumentExtension('persistence', factory1)
	.withDocumentExtension('sync', factory2)
	.withDocumentExtension('markdown', factory3);

// When closing:
// 1. markdown.destroy() completes
// 2. sync.destroy() completes (can safely flush while persistence is running)
// 3. persistence.destroy() completes (no other extensions interfering)
```

**Impact:** Extensions with parallel destroy assumptions will break. Update them to be sequential-safe.

**Migration:** Check your extension destructors. If any assume parallel execution, refactor them.

---

### Phase 3: Void Return = Skip (BREAKING)

**What changes:**

- Returning `undefined` from a factory no longer registers a noop extension
- Instead, the extension is skipped entirely
- To register a noop, explicitly return `{}`

**Before:**

```typescript
.withExtension('noop', () => undefined)

// noop appears in extensions as: { whenReady, destroy: noop ✓ }
```

**After:**

```typescript
.withExtension('noop', () => undefined)

// noop does NOT appear in extensions at all ✗
// Code like: extensions.noop?.method() returns undefined
```

**If you need a noop:**

```typescript
.withExtension('noop', () => ({}))  // Explicitly return empty object ✓
```

**Impact:** Code accessing `extensions['key']` expecting a noop will get `undefined`.

**Migration:**

1. Search for code checking `extensions.someExt` with falsy checks
2. For each, either:
   - Update the factory to return `{}` explicitly
   - Use optional chaining: `extensions.someExt?.method()` (already safe)

---

### Phase 4: Comprehensive Error Handling (BREAKING)

**What changes:**

- Factory throws now trigger LIFO cleanup of prior extensions
- `whenReady` rejection triggers cleanup
- No more leaked resources on error

**Before:**

```typescript
.withExtension('a', () => ({ destroy: cleanupA }))
.withExtension('b', () => { throw new Error('failed'); })

// After throw: cleanupA is NOT called ← BUG (leak)
```

**After:**

```typescript
.withExtension('a', () => ({ destroy: cleanupA }))
.withExtension('b', () => { throw new Error('failed'); })

// After throw: cleanupA IS called (LIFO) ✓
```

**Impact:** If your code relied on partial initialization on error, it will change. Update error handling.

**Migration:** Review error handling in workspace initialization. You now have guarantees that cleanup happens.

---

### Phase 6: Unified `ctx.client` Factory Context (BREAKING: Major API Change)

**What changes:**

- All extension factories receive `{ client, whenReady, extensions }` instead of the full client
- `client` is scope-specific (WorkspaceExtensionClient or DocumentExtensionClient)
- `whenReady` is always the composite promise
- `extensions` contains prior extensions (typed)

**Before (old signature):**

```typescript
const factory = (ctx) => {
  const { ydoc, tables } = ctx;  // ctx IS the client
  return { ... };
};

.withExtension('myExt', factory)
```

**After (new signature):**

```typescript
const factory = (ctx) => {
  const { ydoc } = ctx.client;    // ctx.client is scope-specific
  const { tables } = ctx.client;  // Extract what you need
  const ready = ctx.whenReady;    // Always available
  const prior = ctx.extensions;   // Type-safe access to prior extensions
  return { ... };
};

.withExtension('myExt', factory)
```

**Workspace Extension Context:**

```typescript
type ExtensionContext<WorkspaceExtensionClient> = {
	client: {
		id: string;
		ydoc: Y.Doc;
		definitions: { tables; kv; awareness };
		tables: Tables;
		kv: KeyValueStore;
		awareness: AwarenessAttachment;
		batch: (fn) => void;
	};
	whenReady: Promise<void>;
	extensions: Record<string, unknown>; // Type-safe map
};
```

**Document Extension Context:**

```typescript
type ExtensionContext<DocumentExtensionClient> = {
	client: {
		ydoc: Y.Doc;
		binding: {
			tableName: string;
			documentName: string;
			tags: readonly string[];
		};
	};
	whenReady: Promise<void>;
	extensions: Record<string, unknown>; // Type-safe map
};
```

**Impact:** EVERY extension factory must be updated. This is a large breaking change.

**Migration:** All 11 extension factories must be updated:

1. Change signature from `(ctx)` to `(ctx)` with new shape
2. Extract properties from `ctx.client` instead of directly from ctx
3. Access prior extensions via `ctx.extensions` for typed safety

---

### Edge Case: Extension A instance shared across branches (Phase 1)

1. User creates `base = createWorkspace(def).withExtension('a', factoryA)`
2. User branches: `b1 = base.withExtension('b', factoryB)` and `b2 = base.withExtension('c', factoryC)`
3. Result: `base`, `b1`, and `b2` all have their own destroy/whenReady arrays
4. BUT: The extension A instance itself is shared by reference
5. If `b1.destroy()` is called, extension A is destroyed globally (affects `b2` and `base`)

**Why this is correct:**

- All branches share the same Y.Doc (single source of truth)
- Extension A is a single resource attached to that Y.Doc
- Destroying it in one branch correctly destroys it everywhere

**What's NOT shared:**

- `extensionCleanups[]` array (now immutable per builder)
- `whenReadyPromises[]` array (now immutable per builder)
- Destroy order (LIFO from each builder's perspective)

---

### Edge Case: Factory throw cleanup sequence (Phase 4)

```typescript
try {
	createWorkspace(def)
		.withExtension('a', () => ({ destroy: () => cleanupA() }))
		.withExtension('b', () => ({ destroy: () => cleanupB() }))
		.withExtension('c', () => {
			throw new Error('failed');
		});
} catch (err) {
	// Extensions cleaned up: b, a (LIFO order)
	// Extension c was never added to cleanups
	// Error is rethrown with cleanup errors logged
}
```

**Guarantees:**

- All prior extensions are destroyed in LIFO order
- Cleanup errors are logged, not silently swallowed
- The factory error is always rethrown
- No partial initialization left behind

## Design Decisions Rationale

### 1. Immutable Builder State (Phase 1)

**Decision:** Use immutable state tuples instead of shared mutable arrays.

**Rationale:**

- Fixes builder branching bug where all branches shared extension state
- Aligns with functional programming best practices
- Makes branching semantics explicit and predictable
- No performance penalty (JavaScript array spread is fast)

---

### 2. LIFO Sequential Destroy (Phase 2)

**Decision:** Always destroy extensions in LIFO order, sequentially, with error collection.

**Rationale:**

- Extensions have ordering dependencies (sync → persistence → storage)
- Parallel destroy creates race conditions (observed in production)
- LIFO is the only safe default for dependency chains
- Sequential execution ensures clean, observable cleanup
- Error collection prevents one failure from stopping others

**Alternative considered:** Allow per-extension destroy ordering

- **Rejected:** Too complex. LIFO works for all real-world cases. Users can code cooperatively if needed.

---

### 3. Void Return = Skip (Phase 3)

**Decision:** Void-returning factories are skipped entirely (don't register).

**Rationale:**

- More explicit: void clearly means "not installed"
- Noop extensions aren't a real pattern (just return `{}` if needed)
- Cleaner API surface (no mystery entries in extensions map)
- Consistent with document binding behavior
- Makes optional extensions more idiomatic

**Alternative considered:** Void → noop registration

- **Rejected:** Creates mystery objects in extensions map. Explicit is better than implicit.

---

### 4. Comprehensive Error Handling (Phase 4)

**Decision:** All extension contexts include try/catch with LIFO cleanup on factory throw and whenReady rejection.

**Rationale:**

- Resources must not leak on error
- Cleanup must be deterministic (LIFO order)
- Error should propagate to caller
- Cleanup errors should be logged but not hide the original error

**Alternative considered:** Ignore errors in cleanup

- **Rejected:** Silent failures hide bugs. Log all errors.

---

### 5. Shared `runExtensionFactories()` Helper (Phase 5)

**Decision:** Extract common factory execution logic to single function used by workspace and document contexts.

**Rationale:**

- DRY principle: same logic shouldn't be duplicated
- Guarantees static and dynamic have identical semantics
- Single place to maintain error handling
- Makes it easy to add features later (e.g., extension hooks)

**Alternative considered:** Keep implementations separate

- **Rejected:** Leads to divergence, hard to maintain consistency.

---

### 6. Unified `ctx.client` Context Pattern (Phase 6)

**Decision:** All factories receive `{ client, whenReady, extensions }` where `client` is scope-specific.

**Rationale:**

- Separates concerns: client data vs. lifecycle management
- `client` is scope-specific (WorkspaceExtensionClient or DocumentExtensionClient)
- `whenReady` is always available (computed by framework)
- `extensions` provides typed access to prior extensions
- Consistent with modern API design patterns

**Why NOT include `destroy` and `whenReady` on client:**

- `destroy` is lifecycle: managed by framework, not factories
- `whenReady` is composite: factories shouldn't manipulate it
- Separating concerns makes API clearer

**Why NOT add `ctx.require('key')`:**

- Optional chaining (`?.`) is sufficient
- Defer until real use case demands it
- Keeps initial API simpler

---

### 7. Keep `documentExtensionRegistrations` Mutable

**Decision:** Keep the global extension registration array mutable. Don't make it immutable.

**Rationale:**

- Bindings reference it by closure and see all registrations at `open()` time
- Late-binding (extensions added after bindings created) is intentional
- In practice, all extensions are registered before any `open()` call
- Immutability would complicate the binding lifecycle

---

### 8. Big-Bang Phase 6 Migration

**Decision:** Update all factories at once (no deprecation period).

**Rationale:**

- Only 11 factories across the entire monorepo
- Breaking change is clean and worth it
- Deprecation would require maintaining two code paths
- Better to rip the band-aid off
- Users don't have external extensions (everything is in-repo)

## Success Criteria

### Phase 0 (Baseline Tests)

- [ ] Test 0.1 FAILS before Phase 1 (builder branching bug detected)
- [ ] Test 0.2 FAILS before Phase 3 (void behavior inconsistency detected)
- [ ] Test 0.3 FAILS before Phase 4 (workspace error handling gap detected)
- [ ] Test 0.4 FAILS before Phase 2 (document parallel destroy race detected)
- [ ] Test 0.5 FAILS before Phase 4 (workspace whenReady rejection gap detected)
- [ ] Test 0.6 FAILS before Phase 2 (document whenReady rejection gap detected)
- [ ] All 6 baseline tests pass after their respective phases

### Phase 1 (Immutable Builder State)

- [ ] No shared mutable arrays in `static/create-workspace.ts`
- [ ] No shared mutable arrays in `dynamic/workspace/create-workspace.ts`
- [ ] `BuilderState` type defined and used correctly
- [ ] Test 0.1 passes (builder branching isolation verified)
- [ ] All existing tests still pass
- [ ] `bun test` output shows no regressions

### Phase 2 (LIFO Sequential Destroy)

- [ ] `close()` destroys extensions in LIFO order (reverse creation)
- [ ] `closeAll()` uses same LIFO pattern
- [ ] Factory throw cleanup uses LIFO (lines 281-285)
- [ ] `whenReady` rejection cleanup uses LIFO (lines 321-328)
- [ ] Cleanup errors are logged but don't block sequence
- [ ] Test 0.4 passes (LIFO order verified)
- [ ] Test 0.6 passes (document whenReady rejection cleanup verified)
- [ ] All existing tests still pass

### Phase 3 (Void Return = Skip)

- [ ] Pre-flight grep finds all void-returning factories
- [ ] Pre-flight grep shows zero void returns (after updating any found)
- [ ] `withExtension` skips void factories: `if (!raw) return buildClient(...)`
- [ ] `dynamic/workspace/create-workspace.ts` uses same pattern
- [ ] Document binding already uses this pattern (verified, no change needed)
- [ ] Test 0.2 passes (void skip behavior verified)
- [ ] All existing tests still pass

### Phase 4 (Error Handling with Cleanup)

- [ ] `withExtension` has try/catch wrapping factory call
- [ ] Factory throw triggers LIFO cleanup of prior extensions
- [ ] Cleanup errors are collected and logged
- [ ] Factory error is rethrown after cleanup
- [ ] `dynamic/workspace/create-workspace.ts` has identical error handling
- [ ] `whenReady` rejection triggers cleanup via `.catch()` handler
- [ ] Cleanup on rejection is idempotent
- [ ] Test 0.3 passes (workspace factory throw cleanup verified)
- [ ] Test 0.5 passes (workspace whenReady rejection cleanup verified)
- [ ] All existing tests still pass

### Phase 5 (Shared Helper)

- [ ] `shared/run-extension-factories.ts` exists with unified logic
- [ ] `runExtensionFactories()` function exported and documented
- [ ] Static workspace `withExtension` calls helper
- [ ] Dynamic workspace `withExtension` calls helper
- [ ] Document binding `open()` calls helper
- [ ] All three implementations use identical factory execution logic
- [ ] Semantics are identical across static, dynamic, document contexts
- [ ] All existing tests still pass
- [ ] No logic duplication between implementations

### Phase 6 (Unified `ctx.client` Factory Context): MAJOR API CHANGE

**Type System:**

- [ ] `ExtensionContext<TClient, TExtensions>` defined in `shared/lifecycle.ts`
- [ ] `WorkspaceExtensionClient` type defined in `static/types.ts` with all required fields
- [ ] `DocumentExtensionClient` type defined in `static/types.ts`
- [ ] `DynamicWorkspaceExtensionClient` type defined in `dynamic/workspace/types.ts`
- [ ] All `ExtensionFactory` type aliases updated to use new context shape
- [ ] JSDoc on `ExtensionContext` explains each field clearly

**Implementation:**

- [ ] `withExtension` passes `{ client, whenReady, extensions }` to factory
- [ ] `withDocumentExtension` / `open()` passes same shape to factory
- [ ] `dynamic/workspace/create-workspace.ts` passes same shape
- [ ] All three implementations use identical context shape

**Factory Updates (11 files: ALL MUST BE UPDATED):**

- [ ] `packages/epicenter/src/extensions/sync.ts` ✓
- [ ] `packages/epicenter/src/extensions/sync/desktop.ts` ✓
- [ ] `packages/epicenter/src/extensions/sync/web.ts` ✓
- [ ] `packages/epicenter/src/extensions/sqlite/sqlite.ts` ✓
- [ ] `packages/epicenter/src/extensions/markdown/markdown.ts` ✓
- [ ] `packages/epicenter/src/extensions/revision-history/local.ts` ✓
- [ ] `apps/tab-manager-markdown/src/markdown-persistence-extension.ts` ✓
- [ ] `apps/epicenter/src/lib/yjs/workspace-persistence.ts` ✓
- [ ] `apps/tab-manager/src/entrypoints/background.ts` ✓
- [ ] `apps/tab-manager/src/lib/workspace-popup.ts` ✓
- [ ] `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts` ✓

**Test Updates:**

- [ ] All tests in `static/create-workspace.test.ts` updated
- [ ] All tests in `static/define-workspace.test.ts` updated
- [ ] All tests in `static/create-document-binding.test.ts` updated
- [ ] All tests in `dynamic/workspace/create-workspace.test.ts` updated
- [ ] All tests pass: `bun test`

**Documentation:**

- [ ] `static/create-workspace.ts` JSDoc examples show new context shape
- [ ] `static/types.ts` JSDoc examples updated
- [ ] `shared/lifecycle.ts` JSDoc explains context clearly
- [ ] `dynamic/workspace/create-workspace.ts` examples updated
- [ ] `static/README.md` updated with new patterns
- [ ] `dynamic/workspace/README.md` updated with new patterns

**Verification:**

- [ ] No files using old context pattern (grep confirms)
- [ ] `bun test` passes (all tests updated)
- [ ] `bun run typecheck` passes (no type errors)
- [ ] Type safety is enforced throughout

### Final Verification

- [ ] All 6 baseline tests pass ✓
- [ ] `bun test` passes for entire epicenter package ✓
- [ ] `bun run typecheck` passes (no errors) ✓
- [ ] No type safety issues (`as any`, `@ts-ignore`, `@ts-expect-error` all gone) ✓
- [ ] No shared mutable arrays remain ✓
- [ ] LIFO destroy order verified in tests ✓
- [ ] Error cleanup verified in tests ✓
- [ ] All 11 extension factories updated ✓
- [ ] Static, dynamic, and document builders use identical logic ✓
- [ ] API is internally consistent ✓
- [ ] Documentation reflects new patterns ✓

## Migration Guide

### For Extension Authors

**If you wrote a custom extension factory:**

Before Phase 6:

```typescript
export const myExtension = (ctx) => {
	const { ydoc, tables } = ctx;
	return {
		// exports...
	};
};
```

After Phase 6:

```typescript
export const myExtension = (ctx) => {
	const { ydoc } = ctx.client;
	const { tables } = ctx.client;
	// Access other context via ctx.whenReady, ctx.extensions
	return {
		// exports...
	};
};
```

Or more idiomatically:

```typescript
export const myExtension = ({ client, extensions, whenReady }) => {
	const { ydoc, tables } = client;
	return {
		// exports...
	};
};
```

### For App Users (createWorkspace consumers)

**No changes needed** if you're just using `.withExtension(key, factory)`. The API signature stays the same.

**Changes needed** if you:

1. **Wrote custom factories**: Follow migration guide above
2. **Accessed void extensions**: Now need to check `extensions.key?.method()` or return `{}` explicitly
3. **Expected parallel destroy**: Update any sequential assumptions to sequential

### Execution Order

1. **Week 1: Phase 0 + Phase 1** (bug fix)
   - Add baseline tests
   - Fix builder branching bug
   - All tests pass

2. **Week 1-2: Phase 2 + Phase 3** (safety improvements)
   - Enforce LIFO destroy
   - Standardize void behavior
   - Update any void-returning factories to return `{}`

3. **Week 2: Phase 4** (error handling)
   - Add comprehensive error handling
   - Verify all tests pass

4. **Week 2-3: Phase 5** (refactoring)
   - Extract shared helper
   - Simplify implementations
   - No API changes

5. **Week 3-4: Phase 6** (breaking API change)
   - Update types
   - Update all 11 factories
   - Update all tests
   - Update documentation
   - **This is the breaking change. All must complete together.**

---

## Summary of Changes

| Phase | Category       | Impact                  | Files Changed | Tests Added                 |
| ----- | -------------- | ----------------------- | ------------- | --------------------------- |
| 0     | Baseline       | None                    | 0             | 6 baseline tests            |
| 1     | Bug Fix        | Branching isolation     | 2             | 0 (baseline test 0.1)       |
| 2     | Safety         | LIFO destroy            | 1             | 0 (baseline tests 0.4, 0.6) |
| 3     | Consistency    | Void = skip             | 2             | 0 (baseline test 0.2)       |
| 4     | Error Handling | Cleanup on throw/reject | 2             | 0 (baseline tests 0.3, 0.5) |
| 5     | Refactoring    | Shared logic            | 4             | 0                           |
| 6     | Breaking API   | `ctx.client` pattern    | 11+           | All tests updated           |

---

## Rollback Plan

If serious issues arise during execution:

1. **Phase 0-1 rollback**: Revert to previous commit (bug fix: no reason to rollback)
2. **Phase 2-3 rollback**: Revert to Phase 1, restart from Phase 2 with different approach
3. **Phase 4 rollback**: Revert to Phase 3, investigate error handling issues
4. **Phase 5 rollback**: Revert to Phase 4, keep implementations separate
5. **Phase 6 rollback**: Revert all factory changes, keep old context shape

**Checkpoint commits:** Create atomic commits after each phase. This enables partial rollback if Phase 6 hits unexpected issues.

---

## References

**Files Modified:**

- `packages/epicenter/src/static/create-workspace.ts`: Phases 1, 3, 4, 6
- `packages/epicenter/src/static/create-document-binding.ts`: Phases 2, 4, 5
- `packages/epicenter/src/static/types.ts`: Phases 5, 6
- `packages/epicenter/src/shared/lifecycle.ts`: Phases 5, 6
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Phases 1, 3, 4, 5, 6
- `packages/epicenter/src/dynamic/workspace/types.ts`: Phases 5, 6

**Extension Factories (Phase 6):**

- `packages/epicenter/src/extensions/sync.ts`
- `packages/epicenter/src/extensions/sync/desktop.ts`
- `packages/epicenter/src/extensions/sync/web.ts`
- `packages/epicenter/src/extensions/sqlite/sqlite.ts`
- `packages/epicenter/src/extensions/markdown/markdown.ts`
- `packages/epicenter/src/extensions/revision-history/local.ts`
- `apps/tab-manager-markdown/src/markdown-persistence-extension.ts`
- `apps/epicenter/src/lib/yjs/workspace-persistence.ts`
- `apps/tab-manager/src/entrypoints/background.ts`
- `apps/tab-manager/src/lib/workspace-popup.ts`
- `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`

**Test Files (All phases):**

- `packages/epicenter/src/static/create-workspace.test.ts`
- `packages/epicenter/src/static/define-workspace.test.ts`
- `packages/epicenter/src/static/create-document-binding.test.ts`
- `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`

**Documentation Files (Phase 6):**

- `packages/epicenter/src/static/README.md`
- `packages/epicenter/src/dynamic/workspace/README.md`
