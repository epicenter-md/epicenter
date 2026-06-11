# Workspace Awareness

**Date**: 2026-02-13
**Status**: Complete

> **Note (2026-02-14):** Fully implemented. `createAwareness()` exists at `src/static/create-awareness.ts` with the record-of-fields pattern. `AwarenessDefinitions`, `AwarenessState`, and `AwarenessHelper` types are in `src/static/types.ts`. Integrated into `defineWorkspace()` and `createWorkspace()`: awareness is a first-class concept alongside tables and KV.
> **Depends on**: `20260213T103000-request-dispatch.md`, `20260213T102800-chainable-extension-api.md`

## Overview

Add awareness as a first-class workspace concept alongside tables and KV. Define awareness as a **record of independently-typed fields**: `defineWorkspace({ awareness: { cursor: type('string'), name: type('string') } })`, and get typed helpers at `client.awareness`. Created in `createWorkspace()` the same way tables and KV are.

Awareness uses the same `Record<string, never>` empty-record pattern as tables and KV, eliminating the conditional type (`TAwareness extends StandardSchemaV1 | undefined ? X : Y`) that plagued v1 of this design. No `defineAwareness()` wrapper needed: awareness is ephemeral (not persisted), so the versioning/migration machinery that `defineTable()` and `defineKv()` provide is unnecessary. Each field is a raw `StandardSchemaV1`: even simpler than KV.

## Motivation

### Current State

Epicenter has no awareness concept. The only way to touch awareness today is reaching into the raw y-protocols `Awareness` instance that the Yjs sync provider creates as an internal implementation detail:

```typescript
// No Epicenter API: reaching through layers to use raw y-protocols directly
const provider = workspace.extensions.sync.provider;
provider.awareness.setLocalState({ deviceId, type: 'browser-extension' });

// Reading requires knowing the raw y-protocols API
const states = provider.awareness.getStates();
```

The workspace has no knowledge of awareness. Extensions receive a context of `{ id, ydoc, tables, kv, extensions }`: awareness is absent. Actions can't access it either.

This creates problems:

1. **No schema validation**: Any client can publish any shape. A typo in `deviceId` vs `device_id` breaks presence detection silently.
2. **No typed access**: Consumers work with `unknown` from `getStates()` and must cast manually.
3. **No Epicenter abstraction**: Awareness doesn't exist as an Epicenter concept. The only access path is through the sync provider's internal y-protocols `Awareness` instance: an implementation detail, not an API. If you switch providers, you have to figure out how to reach the raw instance all over again.
4. **Inconsistent with tables/KV**: Tables and KV are workspace-level data concerns defined in the schema and available everywhere. Awareness is the same kind of thing but has zero first-class support.

### v1 Design Problem (Why This Redesign)

The initial v1 design used a single `StandardSchemaV1` schema for the entire awareness state:

```typescript
// v1: single schema (PROBLEMATIC)
defineWorkspace({
	awareness: type({ deviceId: 'string', type: '"desktop" | "browser"' }),
});
```

This introduced a `TAwareness extends StandardSchemaV1 | undefined` generic parameter. When `createWorkspace()` needed to handle both cases (awareness defined vs not defined), TypeScript could not narrow the generic parameter based on runtime checks (`if (config.awareness === undefined)`). This is a known TypeScript limitation: generic type parameters don't narrow with control flow analysis.

The result: `as any` assertions throughout the implementation, two duplicated code branches (~200 lines each), and conditional types on `WorkspaceClient` and `ExtensionContext`.

### The Pattern Already Exists

Tables and KV follow a clear lifecycle:

```
define → schema → createWorkspace() creates helpers → available on client and context → destroyed with workspace
```

Crucially, both tables and KV use the **record-of-definitions** pattern:

```typescript
// Tables: Record<string, TableDefinition<any>>
tables: { posts: defineTable(...), users: defineTable(...) }

// KV: Record<string, KvDefinition<any>>
kv: { theme: defineKv(...), sidebar: defineKv(...) }

// Both default to Record<string, never> when empty
// No conditional types needed: empty record is still a record
```

Awareness should follow the same pattern: a record of independently-typed fields.

| Step            | Tables                                           | KV                                    | Awareness (proposed)                                 |
| --------------- | ------------------------------------------------ | ------------------------------------- | ---------------------------------------------------- |
| Define          | `defineTable(schema)`                            | `defineKv(schema)`                    | Raw `StandardSchemaV1` per field (no wrapper needed) |
| Schema location | `defineWorkspace({ tables })`                    | `defineWorkspace({ kv })`             | `defineWorkspace({ awareness })`                     |
| Schema shape    | `Record<string, TableDefinition>`                | `Record<string, KvDefinition>`        | `Record<string, StandardSchemaV1>`                   |
| Empty default   | `Record<string, never>`                          | `Record<string, never>`               | `Record<string, never>`                              |
| Created in      | `createWorkspace()` → `createTables(ydoc, defs)` | `createWorkspace()` → `createKv(...)` | `createWorkspace()` → `createAwareness(ydoc, defs)`  |
| On client       | `client.tables`                                  | `client.kv`                           | `client.awareness`                                   |
| On ext context  | `ctx.tables`                                     | `ctx.kv`                              | `ctx.awareness`                                      |
| Lifecycle       | Cleanup observers on destroy                     | Cleanup observers on destroy          | `awareness.raw.destroy()` on destroy                 |

### Desired State

```typescript
// 1. Define awareness as independent typed fields (like KV keys)
const definition = defineWorkspace({
  id: 'tab-manager',
  tables: BROWSER_TABLES,
  awareness: {
    deviceId: type('string'),
    deviceType: type('"browser-extension" | "desktop" | "server" | "cli"'),
  },
});

// 2. createWorkspace() creates Awareness + wraps in typed helpers
const workspace = createWorkspace(definition)
  .withExtension('sync', ySweetPersistSync({ ... }))
  .withActions((client) => ({
    closeTab: defineMutation({
      input: type({ url: 'string' }),
      handler: ({ url }) => {
        const peers = client.awareness.getAll();
        // ^? Map<number, { deviceId?: string; deviceType?: string }>
      },
    }),
  }));

// Atomic set: all fields at once
workspace.awareness.setLocal({
  deviceId: 'abc',
  deviceType: 'browser-extension',
});

// Field-level set: update one field
workspace.awareness.setLocalField('deviceType', 'desktop');

// Field-level get
const myType = workspace.awareness.getLocalField('deviceType');
// ^? 'browser-extension' | 'desktop' | 'server' | 'cli' | undefined

// Get all peers
const peers = workspace.awareness.getAll();
// ^? Map<number, { deviceId?: string; deviceType?: string }>
```

## Research Findings

### How Yjs Awareness Works

The `Awareness` class from `y-protocols/awareness.js`. **All methods are synchronous**: no promises, no async, no callbacks-to-wait-on.

| Method                             | Returns               | Behavior                                                                  |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `new Awareness(ydoc)`              | `Awareness`           | Creates instance, starts heartbeat timer, auto-sets initial state to `{}` |
| `setLocalState(state \| null)`     | `void`                | Replaces local state, broadcasts to peers. `null` = go "offline"          |
| `getLocalState()`                  | `Object \| null`      | Returns local state or `null`                                             |
| `setLocalStateField(field, value)` | `void`                | Convenience: merges one field into current state                         |
| `getStates()`                      | `Map<number, Object>` | Returns ALL clients' states (local + remote)                              |
| `destroy()`                        | `void`                | Sets state to `null`, clears heartbeat, cleans up listeners               |

**Two events** (important distinction):

- **`'change'`**: only fires when state _actually_ changed (deep equality check via `lib0/function.equalityDeep`). Use this for UI updates.
- **`'update'`**: fires on _every_ `setLocalState` call even if state is identical. Providers use this for network propagation.

Both events receive the same shape: `{ added: number[], updated: number[], removed: number[] }` (arrays of clientIDs) plus an `origin` parameter.

**Heartbeat / peer timeout:**

- Heartbeat interval runs every ~3 seconds (`outdatedTimeout / 10`)
- Auto-renews local state if not updated in 15 seconds (you don't need to keep calling `setLocalState`)
- Remote peers automatically removed after **30 seconds** of silence: fires `'change'` with them in `removed`

Awareness is NOT part of the Y.Doc CRDT. It's a separate protocol that rides alongside sync. Ephemeral, not persisted, not in CRDT history.

### Why No `defineAwareness()` Wrapper

`defineTable()` and `defineKv()` exist because of **versioning and migration**:

```typescript
// TableDefinition has schema + migrate: versioning is the whole point of the wrapper
type TableDefinition<TVersions> = {
  schema: StandardSchemaV1<...>;
  migrate: (row: OldVersion) => LatestVersion;
};
```

Awareness is ephemeral, never persisted, never has old data sitting around. Every time a client connects, it publishes fresh state. There's no version 1 that needs migrating to version 2. The `.version().migrate()` builder chain would be meaningless ceremony. Just pass raw `StandardSchemaV1` schemas directly: one per field.

### Why Record-of-Fields Instead of Single Schema (v1 → v2)

**v1 used a single schema:**

```typescript
// v1: one schema for the whole awareness state
awareness: type({ deviceId: 'string', type: '"desktop" | "browser"' });
```

This forced `TAwareness extends StandardSchemaV1 | undefined`, which TypeScript cannot narrow at runtime. The implementation required `as any` assertions and duplicated code branches.

**v2 uses a record of fields:**

```typescript
// v2: each field has its own schema
awareness: {
  deviceId: type('string'),
  deviceType: type('"desktop" | "browser"'),
}
```

This uses `TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>`: the same pattern as tables and KV. No conditional types, no `as any`, no duplicated branches.

**Why this works:**

| Dimension         | v1 (Single Schema)                      | v2 (Record of Fields)                     |
| ----------------- | --------------------------------------- | ----------------------------------------- |
| Generic parameter | `TAwareness extends SSV1 \| undefined`  | `TAwareness extends Record<string, SSV1>` |
| Empty default     | `undefined` (requires conditional type) | `Record<string, never>` (still a record)  |
| Type narrowing    | Cannot narrow generic in implementation | No narrowing needed: always a record     |
| Code branches     | Two duplicated ~200-line branches       | Single code path                          |
| Type assertions   | `as any` on awareness property          | None needed                               |
| API flexibility   | `setLocal(entireState)`                 | `setLocal({...})` + `setLocalField(k, v)` |
| Consistency       | Unique pattern in codebase              | Same pattern as tables/KV                 |

**Underlying y-protocols compatibility:**

The y-protocols `Awareness` stores state as a plain object (`Map<clientID, object>`). Our record-of-fields maps directly to this: each field becomes a key in that object. `setLocalField(key, value)` maps to `setLocalStateField(key, value)`. `setLocal(state)` maps to `setLocalState(state)`. No impedance mismatch.

### Who Creates the Awareness Instance Today

Currently: our local y-sweet fork creates it in its constructor.

```typescript
// packages/y-sweet/src/provider.ts line 135
this.awareness = new awarenessProtocol.Awareness(doc);
```

Our `YSweetProviderParams` does NOT accept an external `Awareness` instance.

**However, upstream y-sweet already supports this.** The upstream provider has:

```typescript
// Upstream y-sweet: already supports external awareness
this.awareness = extraOptions.awareness ?? new awarenessProtocol.Awareness(doc);
```

And upstream `YSweetProviderParams` already includes `awareness?: awarenessProtocol.Awareness`. Same pattern as y-websocket. So Phase 1 is just **catching our fork up to upstream**: not inventing new API surface.

**Key insight**: There's nothing stopping us from creating the `Awareness` in `createWorkspace()` and passing it _down_ to the provider. The provider just needs to accept it instead of creating its own. This inverts the ownership: the workspace owns the `Awareness`, the provider uses it.

### Validate on Read, Not on Write: Reasoning

**On write (`setLocal`, `setLocalField`)**: Your own code, your own TypeScript. If you write `setLocalField('deviceId', 123)` when the schema says `string`, TypeScript catches it at compile time. Runtime validation here only protects against bugs TypeScript already catches: pure overhead.

**On read (`getAll`)**: You're reading _remote peers'_ states. They could be running an older app version, a different app entirely, or a buggy client publishing garbage. You **cannot trust** remote data. So `getAll()` validates each field of each state against the schema and silently skips anything invalid: exactly what `getAllValid()` does for tables.

**Extra fields are fine**: Standard Schema (arktype, zod, etc.) typically allows extra fields by default. If desktop publishes `{ deviceId: 'abc', deviceType: 'desktop', version: 2 }` and browser expects `{ deviceId: string, deviceType: string }`, it passes: the extra `version` field gets ignored. This is desirable for forward compatibility.

### How Other Projects Handle Typed Awareness

Most Yjs projects don't type awareness at all. They use raw `setLocalState()/getStates()` with `unknown`. The Epicenter pattern of schema-validated, typed helpers is novel for awareness.

## Design Decisions

| Decision              | Choice                                                             | Rationale                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Define pattern        | Record of raw `StandardSchemaV1` fields: no `defineAwareness()`   | Awareness is ephemeral (no versioning/migration needed). Each field is independently typed, like KV keys.                                                                                 |
| Schema location       | `defineWorkspace({ awareness: { field: schema, ... } })`           | Same as tables and kv: record of definitions.                                                                                                                                            |
| Schema shape          | `Record<string, StandardSchemaV1>` (each field has its own schema) | Eliminates conditional types. Matches tables/KV `Record<string, never>` empty pattern. Enables both atomic and field-level APIs.                                                          |
| Empty default         | `Record<string, never>` (not `undefined`)                          | Same as tables/KV. No conditional type needed: empty record is still a record. `AwarenessHelper<Record<string, never>>` has zero accessible fields.                                      |
| Instance creation     | `createWorkspace()` creates `new Awareness(ydoc)`                  | Same as tables/kv: workspace owns the data, not extensions. Always created (even if empty: no overhead, Awareness constructor is trivial).                                              |
| Helper location       | `client.awareness`                                                 | First-class, same as `client.tables` and `client.kv`.                                                                                                                                     |
| Context inclusion     | `ctx.awareness`                                                    | Extensions and actions see it same as tables/kv.                                                                                                                                          |
| Provider integration  | Provider accepts external `Awareness` instance                     | Upstream y-sweet + y-websocket already support this pattern.                                                                                                                              |
| Validation on set     | Compile-time only (TypeScript)                                     | Local code, own TypeScript: runtime validation is pure overhead here.                                                                                                                    |
| Validation on read    | Per-field schema validation on `getAll()`                          | Remote peers can't be trusted. Validate each field independently.                                                                                                                         |
| Update API            | Both `setLocal()` (atomic) and `setLocalField()` (field-level)     | `setLocal` for initializing/replacing all fields. `setLocalField` for updating one field (maps directly to y-protocols `setLocalStateField`). Both available because the cost is nothing. |
| Always-present client | `awareness` always exists on client (not conditional)              | Same as `tables` and `kv`. When no fields defined, `AwarenessHelper<Record<string, never>>`: methods exist but accept no valid keys.                                                     |

## Architecture

### Ownership Inversion

**Before** (no first-class awareness):

```
createWorkspace(def)
  → no awareness concept

.withExtension('sync', factory)
  → provider internally creates new Awareness(ydoc) as a y-protocols implementation detail
  → reaching into provider.awareness is the only way to access it
```

**After** (workspace owns awareness):

```
createWorkspace(def)
  → new Awareness(ydoc)                    ← workspace owns it
  → wraps in AwarenessHelper<TDefs>
  → client.awareness available immediately

.withExtension('sync', (ctx) => {
  → ctx.awareness.raw is the Awareness instance
  → pass it to provider: createYjsProvider(ydoc, ..., { awareness: ctx.awareness.raw })
  → provider uses the workspace's Awareness, doesn't create its own
})
```

### Type Flow

```
{ cursor: type('string'), name: type('string') }    ← record of raw StandardSchemaV1 fields
       │
       ▼
defineWorkspace({ tables, kv, awareness: { cursor, name } })
       │
       ▼
WorkspaceDefinition<TId, TTables, TKv, TAwareness>
       │   where TAwareness = { cursor: Schema<string>; name: Schema<string> }
       │   defaults to Record<string, never> if omitted
       ▼
createWorkspace(definition)
       │  new Awareness(ydoc)
       │  createAwareness(raw, definitions)
       │  client.awareness: AwarenessHelper<TAwareness>
       │  ctx.awareness: AwarenessHelper<TAwareness>
       ▼
.withExtension('sync', (ctx) => {
  ctx.awareness.raw  // pass to provider
})
       │
       ▼
.withActions((client) => {
  client.awareness.setLocal({ cursor: 'line:5', name: 'Alice' })
  client.awareness.setLocalField('cursor', 'line:10')
  client.awareness.getAll()
})
```

### AwarenessHelper API

```typescript
/** Map of awareness field definitions. Each field has its own StandardSchemaV1 schema. */
type AwarenessDefinitions = Record<string, StandardSchemaV1>;

/** Extract the output type of an awareness field's schema. */
type InferAwarenessValue<T> = T extends StandardSchemaV1
	? StandardSchemaV1.InferOutput<T>
	: never;

/** The composed state type: all fields optional since peers may not have set every field. */
type AwarenessState<TDefs extends AwarenessDefinitions> = {
	[K in keyof TDefs]?: InferAwarenessValue<TDefs[K]>;
};

type AwarenessHelper<TDefs extends AwarenessDefinitions> = {
	/**
	 * Set this client's awareness state (merge into current state).
	 * Broadcasts to all connected peers via the awareness protocol.
	 * Accepts partial: only specified fields are set (merged into current state).
	 */
	setLocal(state: AwarenessState<TDefs>): void;

	/**
	 * Set a single awareness field.
	 * Maps directly to y-protocols setLocalStateField().
	 */
	setLocalField<K extends keyof TDefs & string>(
		key: K,
		value: InferAwarenessValue<TDefs[K]>,
	): void;

	/**
	 * Get this client's current awareness state.
	 * Returns null if not yet set.
	 */
	getLocal(): AwarenessState<TDefs> | null;

	/**
	 * Get a single local awareness field.
	 * Returns undefined if not set.
	 */
	getLocalField<K extends keyof TDefs & string>(
		key: K,
	): InferAwarenessValue<TDefs[K]> | undefined;

	/**
	 * Get all connected clients' awareness states.
	 * Returns Map from Yjs clientID to validated state.
	 * Each field is independently validated against its schema.
	 * Invalid fields are omitted from the result (valid fields still included).
	 */
	getAll(): Map<number, AwarenessState<TDefs>>;

	/**
	 * Watch for awareness changes.
	 * Callback receives a map of clientIDs to change type.
	 * Returns unsubscribe function.
	 */
	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;

	/**
	 * The raw y-protocols Awareness instance.
	 * Escape hatch for advanced use (custom heartbeats, direct protocol access).
	 * Pass to sync providers: createYjsProvider(ydoc, ..., { awareness: ctx.awareness.raw })
	 */
	raw: Awareness;
};
```

Note: `raw` is always present (not `null`). The workspace creates the `Awareness` in `createWorkspace()`, so it exists from the start: even when no awareness fields are defined. No disconnected state, no queueing, no deferred wiring.

### How Sync Extensions Use It

The sync extension receives awareness in context and passes `raw` to the provider:

```typescript
// Updated ySweetPersistSync: accepts awareness from context
export function ySweetPersistSync(
	config: YSweetPersistSyncConfig,
): ExtensionFactory {
	return (ctx) => {
		// Pass workspace's Awareness to provider instead of letting it create one
		const provider = createYjsProvider(ctx.ydoc, ctx.ydoc.guid, authEndpoint, {
			connect: false,
			awareness: ctx.awareness.raw, // ← workspace's Awareness instance (always present)
		});

		// ... persistence + sync orchestration unchanged
	};
}
```

This requires catching our `@epicenter/y-sweet` fork up to upstream: add `awareness?: Awareness` to `YSweetProviderParams` and use `extraOptions.awareness ?? new Awareness(doc)` in the constructor. Upstream y-sweet and y-websocket already support this pattern.

### Client Shape (No Conditional Types!)

```typescript
type WorkspaceClient<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown>,
> = {
	id: TId;
	ydoc: Y.Doc;
	tables: TablesHelper<TTableDefinitions>;
	kv: KvHelper<TKvDefinitions>;
	awareness: AwarenessHelper<TAwarenessDefinitions>; // ← Always present. No conditional.
	definitions: {
		tables: TTableDefinitions;
		kv: TKvDefinitions;
		awareness: TAwarenessDefinitions;
	};
	extensions: TExtensions;
	whenReady: Promise<void>;
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};
```

When `awareness` is not defined in the workspace definition, `TAwarenessDefinitions` defaults to `Record<string, never>`. The `AwarenessHelper<Record<string, never>>` has zero accessible field keys: `setLocalField`, `getLocalField` etc. accept no valid arguments. The `raw` Awareness instance still exists (zero overhead).

### Extension Context Shape

```typescript
type ExtensionContext<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown>,
> = {
	id: TId;
	ydoc: Y.Doc;
	tables: TablesHelper<TTableDefinitions>;
	kv: KvHelper<TKvDefinitions>;
	extensions: TExtensions;
	awareness: AwarenessHelper<TAwarenessDefinitions>; // ← Always present. Same instance as client.
};
```

### createWorkspace(): Single Code Path

```typescript
// No overloads needed! One signature, one implementation.
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
>(
	config: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	>,
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	Record<string, never>
> {
	const { id } = config;
	const ydoc = new Y.Doc({ guid: id });
	const tableDefs = (config.tables ?? {}) as TTableDefinitions;
	const kvDefs = (config.kv ?? {}) as TKvDefinitions;
	const awarenessDefs = (config.awareness ?? {}) as TAwarenessDefinitions;

	const tables = createTables(ydoc, tableDefs);
	const kv = createKv(ydoc, kvDefs);
	const awareness = createAwareness(ydoc, awarenessDefs); // ← Always called. Might be empty.
	const definitions = {
		tables: tableDefs,
		kv: kvDefs,
		awareness: awarenessDefs,
	};

	// Single buildClient function: no branches!
	function buildClient<TExtensions extends Record<string, unknown>>(
		extensions: TExtensions,
	) {
		// ... one code path for everything
		const client = {
			id,
			ydoc,
			tables,
			kv,
			definitions,
			extensions,
			awareness, // ← No type assertion needed!
			whenReady,
			destroy,
			[Symbol.asyncDispose]: destroy,
		};
		// ... withExtension, withActions
	}

	return buildClient({} as Record<string, never>);
}
```

## `createAwareness()`: Updated for Record-of-Fields

Mirrors `createTables()` and `createKv()`. Takes a Y.Doc and a record of `StandardSchemaV1` field schemas, returns an `AwarenessHelper`.

```typescript
function createAwareness<TDefs extends AwarenessDefinitions>(
	ydoc: Y.Doc,
	definitions: TDefs,
): AwarenessHelper<TDefs> {
	const raw = new Awareness(ydoc);

	return {
		setLocal(state) {
			// Merge with current state (setLocal is partial update, like setLocalStateField for each key)
			const current = raw.getLocalState() ?? {};
			raw.setLocalState({ ...current, ...state });
		},

		setLocalField(key, value) {
			raw.setLocalStateField(key, value);
		},

		getLocal() {
			return raw.getLocalState() as AwarenessState<TDefs> | null;
		},

		getLocalField(key) {
			const state = raw.getLocalState();
			if (state === null) return undefined;
			return (state as Record<string, unknown>)[key] as any;
		},

		getAll() {
			const result = new Map<number, AwarenessState<TDefs>>();
			const defEntries = Object.entries(definitions);

			for (const [clientId, state] of raw.getStates()) {
				if (state === null || typeof state !== 'object') continue;

				// Validate each field independently against its schema
				const validated: Record<string, unknown> = {};
				for (const [fieldKey, fieldSchema] of defEntries) {
					const fieldValue = (state as Record<string, unknown>)[fieldKey];
					if (fieldValue === undefined) continue;

					const fieldResult = fieldSchema['~standard'].validate(fieldValue);
					if (fieldResult instanceof Promise) continue; // Skip async schemas
					if (fieldResult.issues) continue; // Skip invalid fields

					validated[fieldKey] = fieldResult.value;
				}

				// Include client even if some fields are missing (they're all optional)
				// Only skip if the client has zero valid fields
				if (Object.keys(validated).length > 0) {
					result.set(clientId, validated as AwarenessState<TDefs>);
				}
			}
			return result;
		},

		observe(callback) {
			const handler = ({
				added,
				updated,
				removed,
			}: {
				added: number[];
				updated: number[];
				removed: number[];
			}) => {
				const changes = new Map<number, 'added' | 'updated' | 'removed'>();
				for (const id of added) changes.set(id, 'added');
				for (const id of updated) changes.set(id, 'updated');
				for (const id of removed) changes.set(id, 'removed');
				callback(changes);
			};
			raw.on('change', handler);
			return () => raw.off('change', handler);
		},

		raw,
	};
}
```

## Implementation Plan

### Phase 1: Y-Sweet Provider: Accept External Awareness

Our local fork hardcodes `new Awareness(doc)`. Upstream y-sweet already supports `extraOptions.awareness ?? new Awareness(doc)`. This phase catches our fork up.

- [ ] **1.1** Add `awareness?: Awareness` to `YSweetProviderParams` in `packages/y-sweet/src/provider.ts`
- [ ] **1.2** In `YSweetProvider` constructor: use `extraOptions.awareness ?? new Awareness(doc)` instead of always creating new
- [ ] **1.3** Update `createYjsProvider()` to pass through the option
- [ ] **1.4** Test: provider with external awareness uses it, provider without creates its own

### Phase 2: Types: Record-of-Fields Pattern

Replace `TAwareness extends StandardSchemaV1 | undefined` with `TAwarenessDefinitions extends AwarenessDefinitions`.

- [ ] **2.1** Define `AwarenessDefinitions` type (`Record<string, StandardSchemaV1>`) in `types.ts`
- [ ] **2.2** Define `InferAwarenessValue<T>` helper type in `types.ts`
- [ ] **2.3** Define `AwarenessState<TDefs>` composed state type in `types.ts`
- [ ] **2.4** Update `AwarenessHelper<T>` type: change from `<TState>` to `<TDefs extends AwarenessDefinitions>`, add `setLocalField`, `getLocalField`
- [ ] **2.5** Update `WorkspaceDefinition`: change `awareness?: StandardSchemaV1` to `awareness?: TAwarenessDefinitions` with `TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>`
- [ ] **2.6** Update `WorkspaceClient`: remove conditional type on `awareness`, always `AwarenessHelper<TAwarenessDefinitions>`
- [ ] **2.7** Update `ExtensionContext`: remove conditional type on `awareness`, always `AwarenessHelper<TAwarenessDefinitions>`
- [ ] **2.8** Update `WorkspaceClientBuilder`, `WorkspaceClientWithActions`: propagate the new generic parameter

### Phase 3: Runtime: createAwareness() and createWorkspace()

- [ ] **3.1** Rewrite `create-awareness.ts`: accept `Record<string, StandardSchemaV1>` instead of single schema, implement `setLocalField`, `getLocalField`, per-field validation in `getAll()`
- [ ] **3.2** Update `define-workspace.ts`: change awareness generic from `StandardSchemaV1 | undefined` to `AwarenessDefinitions`
- [ ] **3.3** Rewrite `createWorkspace()`: remove overloads, remove dual branches, single code path. Always call `createAwareness(ydoc, awarenessDefs)`. No type assertions needed.
- [ ] **3.4** Remove duplicate `buildClient` functions: only one needed now
- [ ] **3.5** Test: workspace without awareness has `awareness` on client with zero fields (TypeScript prevents accessing nonexistent keys)
- [ ] **3.6** Test: workspace with awareness has typed `setLocal`, `setLocalField`, `getLocalField`, `getAll`

### Phase 4: Update ySweetPersistSync

- [ ] **4.1** Update `ySweetPersistSync` to pass `ctx.awareness.raw` to `createYjsProvider` (no optional chaining needed: always present)
- [ ] **4.2** On `reconnect()`, create new provider with the same awareness instance

### Phase 5: Tab Manager Integration

- [ ] **5.1** Update tab-manager's `defineWorkspace()` call: change from single schema to record of fields
- [ ] **5.2** Update popup workspace to call `setLocal()` or `setLocalField()` on connect
- [ ] **5.3** Update background.ts to call `setLocal()` or `setLocalField()` on connect
- [ ] **5.4** Create `epicenter.config.ts` for tab-manager using the chaining API

### Phase 6: Request Dispatch Integration

- [ ] **6.1** Use `client.awareness.getAll()` for the awareness gate in request dispatch
- [ ] **6.2** Make `runtime` field on action definitions route to correct device type

## Edge Cases

### No Awareness Fields Defined

```typescript
const definition = defineWorkspace({ id: 'notes', tables: { notes } });
const client = createWorkspace(definition);

// client.awareness exists (AwarenessHelper<Record<string, never>>)
// client.awareness.raw is a live Awareness instance (zero overhead)
// client.awareness.setLocal({}): compiles (empty object is valid)
// client.awareness.setLocalField('x', ...): TypeScript error: 'x' not in Record<string, never>
// client.awareness.getAll(): returns Map<number, {}> (no fields to validate)
```

The Awareness instance still exists. Extensions can still use `ctx.awareness.raw` to pass to sync providers. There's just no schema to validate against.

### No Sync Extension Attached

1. Workspace created with awareness fields, no sync extension
2. `client.awareness.setLocal(state)` sets local state on the `Awareness` instance
3. `client.awareness.getAll()` returns a Map with only the local client (if set)
4. No peers because nothing is transporting awareness updates

This is correct. The `Awareness` object exists and works locally. It just has no peers until a sync provider connects and starts relaying awareness messages.

### Multiple Sync Extensions

1. Workspace has `.withExtension('syncA', ...).withExtension('syncB', ...)`
2. Both receive `ctx.awareness.raw`: the same `Awareness` instance
3. Both providers wire their WebSocket to the same `Awareness`

This is fine. Multiple sync providers sharing one `Awareness` is the standard y-protocols pattern. Each provider relays awareness messages from its connection; the `Awareness` instance merges them.

### Schema Mismatch Across Clients

1. Desktop publishes `{ deviceId: 'abc', deviceType: 'desktop', version: 2 }`
2. Browser extension defines `{ deviceId: type('string'), deviceType: type('string') }` (no `version`)
3. `getAll()` on browser extension validates each **defined field** independently

Result: `{ deviceId: 'abc', deviceType: 'desktop' }`: `version` field is ignored (not in the schema, not validated, not included). Each field validated independently: one invalid field doesn't discard the rest.

### Partial State from Peers

1. Peer A publishes `{ deviceId: 'abc' }` (only one field)
2. Local workspace expects `{ deviceId, deviceType }`
3. `getAll()` returns `{ deviceId: 'abc' }` for that peer: `deviceType` is just missing

This is fine because `AwarenessState<TDefs>` has all fields optional (`[K in keyof TDefs]?:`). Awareness is inherently partial: peers publish what they have.

### setLocal Behavior: Merge vs Replace

`setLocal()` does a **merge** (spread into current state), not a full replacement. This matches the mental model of "set these fields" rather than "replace everything". To remove a field, call `setLocal()` with the field explicitly set to `undefined`, or use the raw API.

`setLocalField()` maps directly to `raw.setLocalStateField(key, value)` which also merges.

Both are merge operations. This is consistent. You can't accidentally lose fields by forgetting to include them.

## Open Questions

1. **Should `getAll()` include the local client's state?**
   - Yjs `getStates()` includes the local client
   - Returning it from `getAll()` is consistent but might confuse consumers looking for "peers"
   - **Recommendation**: Include it (consistent with raw API). Add `getPeers()` convenience if needed later.

2. **Should `setLocal()` merge or replace?**
   - Merge: safer, can't accidentally lose fields. Matches `setLocalField` semantics.
   - Replace: simpler mental model, matches table `set()` which replaces entire rows.
   - **Recommendation**: Merge. Awareness fields are independent (each has its own schema). Replacing would be surprising: you'd lose cursor position when updating deviceType. If full replacement is needed, the raw API is available.

3. **Should `getAll()` skip clients with zero valid fields?**
   - A client with state `{ garbage: true }` against schema `{ deviceId: type('string') }` has zero matching fields.
   - Option A: Skip entirely (client not in Map)
   - Option B: Include as empty object `{}`
   - **Recommendation**: Skip. A client with zero recognized fields is indistinguishable from noise. Including it just adds empty entries that consumers must guard against.

4. **Should we validate `setLocal` fields at runtime too?**
   - Currently: compile-time only (TypeScript checks).
   - Concern: If someone bypasses TypeScript (e.g., `as any`), bad data gets broadcast.
   - **Recommendation**: No. Same philosophy as tables: writes trust TypeScript, reads validate. Adding runtime validation on write adds overhead for every cursor update with zero practical benefit when the code is properly typed.

## Success Criteria

- [ ] `defineWorkspace({ awareness: { field: type(...) } })` compiles and infers field types from raw schemas
- [ ] `client.awareness.setLocal({ field: value })` is type-checked per field
- [ ] `client.awareness.setLocalField('field', value)` is type-checked for key and value
- [ ] `client.awareness.getLocalField('field')` returns the correct type
- [ ] `client.awareness.getAll()` returns `Map<number, AwarenessState<TDefs>>` with per-field validated states
- [ ] `client.awareness.observe()` fires on peer state changes
- [ ] `client.awareness.raw` is the `Awareness` instance (passable to providers)
- [ ] Extension context includes `ctx.awareness` (same instance, same type)
- [ ] `ySweetPersistSync` passes `ctx.awareness.raw` to the provider
- [ ] Y-Sweet provider accepts external `Awareness` via params
- [ ] Tab-manager workspace uses the new API with `{ deviceId, deviceType }` field schemas
- [ ] Workspaces without awareness: `client.awareness` exists, `AwarenessHelper<Record<string, never>>`, zero accessible field keys
- [ ] `createWorkspace()` has a single code path: no overloads, no branches, no `as any`
- [ ] All existing tests pass (tables, KV, extensions: awareness change is additive)

## References

- `packages/epicenter/src/static/types.ts`: WorkspaceDefinition, WorkspaceClient, ExtensionContext, AwarenessHelper types
- `packages/epicenter/src/static/create-workspace.ts`: Factory with `.withExtension()` chain (to be simplified)
- `packages/epicenter/src/static/define-workspace.ts`: Pure definition passthrough (update awareness generic)
- `packages/epicenter/src/static/create-awareness.ts`: Awareness factory (to be rewritten for record-of-fields)
- `packages/epicenter/src/static/create-kv.ts`: Pattern to follow for record-of-definitions approach
- `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`: Sync extension to update
- `packages/y-sweet/src/provider.ts`: YSweetProvider constructor (needs `awareness?` param: upstream already supports it)
- `apps/tab-manager/src/lib/workspace-popup.ts`: Consumer that will adopt the new API
- `apps/tab-manager/src/entrypoints/background.ts`: Consumer that will set awareness on connect
- `specs/20260213T103000-request-dispatch.md`: Request dispatch needs awareness gate
- `specs/20260213T102800-chainable-extension-api.md`: Chainable `.withExtension()` API
