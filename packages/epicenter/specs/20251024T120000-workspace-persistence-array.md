# Refactor Workspace Persistence Configuration

## Overview

Refactor the workspace configuration to support multiple persistence strategies instead of a single `setupYDoc` function. This change renames `setupYDoc` to `persistence` and changes it from a single function to an array of functions, allowing workspaces to configure multiple persistence mechanisms simultaneously (e.g., IndexedDB + filesystem, or multiple remote providers).

## Current State

Workspaces have an optional `setupYDoc` function:

```typescript
type WorkspaceConfig = {
	// ...other properties
	setupYDoc?: (ydoc: Y.Doc) => void;
};
```

Usage in workspace definitions:

```typescript
const workspace = defineWorkspace({
	// ...
	setupYDoc: (ydoc) => setupPersistenceDesktop(ydoc),
});
```

Invocation in `client.ts:313`:

```typescript
workspaceConfig.setupYDoc?.(ydoc);
```

## Proposed State

Rename to `persistence` and change to array of functions with destructured parameters:

```typescript
type WorkspaceConfig = {
	// ...other properties
	persistence?: Array<({ ydoc }: { ydoc: Y.Doc }) => void | Promise<void>>;
};
```

Usage in workspace definitions:

```typescript
const workspace = defineWorkspace({
	// ...
	persistence: [({ ydoc }) => setupPersistenceDesktop(ydoc)],
});
```

Or with multiple persistence strategies:

```typescript
const workspace = defineWorkspace({
	// ...
	persistence: [
		({ ydoc }) => setupPersistenceDesktop(ydoc),
		({ ydoc }) => setupPersistenceIndexedDB(ydoc),
	],
});
```

Invocation in `client.ts`:

```typescript
if (workspaceConfig.persistence) {
	for (const setup of workspaceConfig.persistence) {
		await setup({ ydoc });
	}
}
```

## Rationale

1. **Multiple persistence strategies**: Some applications may want to persist to multiple locations simultaneously (e.g., local file + remote sync)
2. **Consistent API**: Destructured parameters align with how `actions` and `indexes` receive their context
3. **Future extensibility**: Later we can add more context properties (e.g., `context`, `db`, `indexes`) without breaking changes
4. **Async support**: Supporting `Promise<void>` enables async persistence setup

## Implementation Plan

### Phase 1: Type Definition Updates

- [ ] Update `WorkspaceConfig` type in `config.ts:204` to use `persistence` array
- [ ] Update JSDoc example in `config.ts:71-74` to show array syntax
- [ ] Update JSDoc documentation to explain multiple persistence strategies

### Phase 2: Workspace Definitions

Find and update all workspace definitions that use `setupYDoc`:

- [ ] `packages/epicenter/examples/basic-workspace/epicenter.config.ts:168`
- [ ] `packages/epicenter/examples/content-hub/epicenter.config.ts:48`
- [ ] `packages/epicenter/examples/content-hub/epicenter.config.ts:181`
- [ ] `packages/epicenter/examples/e2e-tests/epicenter.config.ts`
- [ ] Any test files with `setupYDoc` references

### Phase 3: Client Initialization Logic

- [ ] Update `client.ts:310-313` to loop through `persistence` array
- [ ] Handle both sync and async persistence functions
- [ ] Update comments to reference `persistence` instead of `setupYDoc`

### Phase 4: Documentation Updates

- [ ] Update workspace README (`src/core/workspace/README.md`) if it references `setupYDoc`
- [ ] Update main README files that show workspace examples
- [ ] Update example app documentation
- [ ] Update YJS persistence guide (`docs/yjs-persistence-guide.md`)
- [ ] Update handoff docs (`docs/handoff-yjs-persistence-rollout.md`)

### Phase 5: Test Updates

- [ ] Update `src/core/workspace.test.ts` to use `persistence` array
- [ ] Update `tests/integration/blog-workspace.test.ts`
- [ ] Update `tests/integration/markdown-bidirectional.test.ts`
- [ ] Update any other test files that create workspace configs

### Phase 6: Verification

- [ ] Run all tests to ensure nothing breaks
- [ ] Test basic-workspace example app
- [ ] Test content-hub example app
- [ ] Verify e2e tests pass

## Affected Files

Based on grep results, these files reference `setupYDoc`:

### Core Implementation

- `packages/epicenter/src/core/workspace/config.ts:204` (type definition)
- `packages/epicenter/src/core/workspace/client.ts:313` (invocation)

### Example Workspaces

- `packages/epicenter/examples/basic-workspace/epicenter.config.ts:168`
- `packages/epicenter/examples/content-hub/epicenter.config.ts:48`
- `packages/epicenter/examples/content-hub/epicenter.config.ts:181`
- `packages/epicenter/examples/e2e-tests/epicenter.config.ts` (needs verification)

### Tests

- `packages/epicenter/src/core/workspace.test.ts`
- `packages/epicenter/tests/integration/blog-workspace.test.ts`
- `packages/epicenter/tests/integration/markdown-bidirectional.test.ts`
- `packages/epicenter/src/cli/integration.test.ts`
- `packages/epicenter/src/cli/cli-end-to-end.test.ts`

### Documentation

- `packages/epicenter/src/core/workspace/README.md`
- `packages/epicenter/examples/basic-workspace/README.md`
- `packages/epicenter/examples/web-app/README.md`
- `docs/yjs-persistence-guide.md`
- `docs/handoff-yjs-persistence-rollout.md`
- Various spec documents that may reference the old API

### Helper Functions

- `packages/epicenter/src/persistence/web.ts` (exports `setupPersistenceWeb`)
- `packages/epicenter/src/persistence/desktop.ts` (exports `setupPersistenceDesktop`)

Note: These helper functions don't need to change; they still accept `ydoc` and return void. They'll just be called from within the array.

## Example Changes

### Type Definition Change

**Before:**

```typescript
export type WorkspaceConfig<...> = {
  // ...
  setupYDoc?: (ydoc: Y.Doc) => void;
  // ...
};
```

**After:**

```typescript
export type WorkspaceConfig<...> = {
  // ...
  persistence?: Array<({ ydoc }: { ydoc: Y.Doc }) => void | Promise<void>>;
  // ...
};
```

### JSDoc Example Change

**Before:**

````typescript
/**
 * @example
 * ```typescript
 * const blogWorkspace = defineWorkspace({
 *   // ...
 *   setupYDoc: (ydoc) => {
 *     // Optional: Set up persistence
 *     new IndexeddbPersistence('blog', ydoc);
 *   },
 * });
 * ```
 */
````

**After:**

````typescript
/**
 * @example
 * ```typescript
 * const blogWorkspace = defineWorkspace({
 *   // ...
 *   persistence: [
 *     ({ ydoc }) => {
 *       // Set up persistence
 *       new IndexeddbPersistence('blog', ydoc);
 *     }
 *   ],
 * });
 * ```
 */
````

### Workspace Definition Change

**Before:**

```typescript
const blogWorkspace = defineWorkspace({
	id: 'blog',
	name: 'blog',
	schema: {
		/* ... */
	},
	indexes: {
		/* ... */
	},
	exports: ({ db, indexes }) => ({
		/* ... */
	}),
	setupYDoc: (ydoc) => setupPersistenceDesktop(ydoc),
});
```

**After:**

```typescript
const blogWorkspace = defineWorkspace({
	id: 'blog',
	name: 'blog',
	schema: {
		/* ... */
	},
	indexes: {
		/* ... */
	},
	exports: ({ db, indexes }) => ({
		/* ... */
	}),
	persistence: [({ ydoc }) => setupPersistenceDesktop(ydoc)],
});
```

### Client Initialization Change

**Before:**

```typescript
// Set up YDoc synchronization and persistence (if user provided a setupYDoc function)
// IMPORTANT: This must run BEFORE createEpicenterDb so that persisted data is loaded
// into the YDoc before table initialization
workspaceConfig.setupYDoc?.(ydoc);
```

**After:**

```typescript
// Set up YDoc synchronization and persistence (if user provided persistence functions)
// IMPORTANT: This must run BEFORE createEpicenterDb so that persisted data is loaded
// into the YDoc before table initialization
if (workspaceConfig.persistence) {
	for (const setup of workspaceConfig.persistence) {
		await setup({ ydoc });
	}
}
```

## Multiple Persistence Example

One of the key benefits of this refactor is supporting multiple persistence strategies:

```typescript
const workspace = defineWorkspace({
	// ...
	persistence: [
		// Local persistence for offline support
		({ ydoc }) => setupPersistenceDesktop(ydoc),

		// Remote sync for collaboration
		({ ydoc }) => {
			const provider = new WebsocketProvider(
				'ws://localhost:1234',
				'my-room',
				ydoc,
			);
			return provider;
		},

		// Debug/audit logging
		({ ydoc }) => {
			ydoc.on('update', (update) => {
				console.log('YDoc updated:', update);
			});
		},
	],
});
```

## Breaking Changes

This is a breaking change for any workspace definitions using `setupYDoc`. However, the migration is straightforward:

1. Rename `setupYDoc` to `persistence`
2. Wrap the function in an array: `[...]`
3. Change parameter from `(ydoc)` to `({ ydoc })`

Migration example:

```typescript
// Old
setupYDoc: (ydoc) => setupPersistenceDesktop(ydoc);

// New
persistence: [({ ydoc }) => setupPersistenceDesktop(ydoc)];
```

## Notes

- The helper functions `setupPersistenceDesktop` and `setupPersistenceWeb` still accept `ydoc` directly and return void, so they work perfectly when called from within the array
- The async support (`Promise<void>`) enables persistence functions that need to do async setup (e.g., checking if IndexedDB is available, loading remote config)
- Later we can extend the destructured object to include `context`, `db`, `indexes` etc. for more powerful persistence strategies
