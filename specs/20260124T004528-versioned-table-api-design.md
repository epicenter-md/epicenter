# Versioned Table API Design for YJS Local-First Apps

> **⚠️ PARTIALLY SUPERSEDED**
>
> This spec has been partially superseded by [`specs/20260124T162638-stable-id-schema-pattern.md`](./20260124T162638-stable-id-schema-pattern.md).
>
> **What changed**: The Stable ID pattern sidesteps the entire versioning problem. Instead of tracking `_v` per row and running migrations, each field has a stable internal ID that never changes. The developer-facing key can be renamed freely; the data is untouched.
>
> **What's still valuable here**:
> - The analysis of YJS Y.Map LWW conflicts (the "Migration Disaster Scenario")
> - The comparison of Full Row Transform vs Patch-Based approaches
> - The "Deep Dive" section (line 650+) which correctly concludes per-row `_v` is overkill
> - The recommendation to use epochs for breaking changes
>
> **What's obsolete**:
> - The `versionedTable` API with `_v` tracking
> - The `addFields` migration pattern
> - Legacy key fallback approaches (mentioned but not recommended)
>
> **Read this spec for**: Understanding why CRDT migrations are dangerous. **Read the Stable ID spec for**: How to avoid migrations entirely.

---

**Status**: Research & Design (Partially Superseded)
**Date**: 2026-01-24
**Context**: Designing a `versionedTable` abstraction for schema migrations in YJS-backed local-first applications

---

## Problem Statement

Local-first apps using YJS need to evolve their data schemas over time. Unlike traditional databases:

- Data can arrive from any peer at any schema version
- YJS uses last-write-wins (LWW) at the **field level**, not row level
- Old clients may sync with new clients indefinitely
- There's no single "migration window": migrations must be safe to run anytime

We need an API that:

1. Makes common schema changes easy (add field, rename, etc.)
2. Preserves type safety through the migration chain
3. Works correctly with YJS's conflict resolution
4. Follows the 80/20 rule: easy for common cases, possible for rare cases

---

## Schema Change Frequency (From Developer Simulations)

We simulated realistic schema evolution for TODO and voice recording apps:

| Change Type            | Frequency | YJS Safety               |
| ---------------------- | --------- | ------------------------ |
| Add nullable field     | ~25%      | Safe                     |
| Add field with default | ~25%      | Safe                     |
| Rename field           | ~15%      | **Unsafe**               |
| Change field type      | ~15%      | **Unsafe**               |
| Remove field           | ~10%      | **Unsafe** (hard remove) |
| Extract to new table   | ~10%      | Complex                  |

**Key insight**: ~50% of migrations are "add field" which is safe. The other 50% involve touching existing fields, which conflicts with YJS LWW.

---

## The YJS Conflict Problem

### Scenario: Migration vs Concurrent Edit

```
Device A (offline): Reads row v1, migrates to v2, writes entire row back
Device B (offline): Edits just the "title" field on v1
Both sync...
```

**Result**: If A's migration wrote the `title` field (even with its old value), A and B both wrote to the same key. YJS picks one: B's edit may be lost.

### Root Cause

YJS Y.Maps resolve conflicts **per field**. When you do:

```typescript
// This writes EVERY field, creating conflicts on ALL of them
rowMap.set('title', row.title);
rowMap.set('status', row.status);
rowMap.set('_v', 2);
```

You're competing with any concurrent edits to those fields.

---

## Two API Approaches

We present two approaches with different trade-offs:

| Aspect             | Approach A: Full Row Transform | Approach B: Patch-Based |
| ------------------ | ------------------------------ | ----------------------- |
| Ergonomics         | Excellent                      | Good                    |
| Type Safety        | Excellent                      | Moderate                |
| YJS Safety         | **Poor**                       | Excellent               |
| Rename/Type Change | Supported                      | Not supported           |
| Complexity         | Simple                         | More complex            |

---

## Approach A: Full Row Transform (Simpler, Less YJS-Safe)

### Philosophy

Treat migrations like pure functions: `(oldRow) => newRow`. Simple, type-safe, easy to understand.

### API Design

```typescript
import { type } from 'arktype';

const TodoV1 = type({
	_v: '1',
	id: 'string',
	text: 'string',
	done: 'boolean',
});

const TodoV2 = type({
	_v: '2',
	id: 'string',
	title: 'string', // renamed from 'text'
	done: 'boolean',
	status: "'active' | 'completed'", // new field
});

const TodoV3 = type({
	_v: '3',
	id: 'string',
	title: 'string',
	status: "'active' | 'completed' | 'archived'", // type changed
	priority: '1 | 2 | 3', // new field
});

const todosTable = versionedTable('todos')
	.v(1, TodoV1)
	.v(2, TodoV2, (row) => ({
		_v: 2 as const,
		id: row.id,
		title: row.text, // rename
		done: row.done,
		status: row.done ? 'completed' : 'active',
	}))
	.v(3, TodoV3, (row) => ({
		_v: 3 as const,
		id: row.id,
		title: row.title,
		status: row.status,
		priority: 2, // default to medium
	}))
	.build();
```

### Type Signatures

```typescript
type Migrator<From, To> = (row: From) => To;

type VersionedTableBuilder<Name, Prev, Latest> = {
	v<V extends number, Next>(
		version: V,
		schema: Type<Next>,
		migrate?: Migrator<Prev, Next>,
	): VersionedTableBuilder<Name, Next, Next>;

	build(): VersionedTable<Name, Latest>;
};

type VersionedTable<Name, Latest> = {
	name: Name;
	latestVersion: number;

	// Runtime: detect version, apply migrations, return latest
	upgrade(raw: unknown): Latest;

	// For inspection/debugging
	versions: Record<number, { schema: Type<any> }>;
};
```

### Usage with YJS

```typescript
// Reading
function getRow(id: string): Todo {
	const raw = rowsMap.get(id)?.toJSON();
	return todosTable.upgrade(raw); // Always returns TodoV3
}

// Writing (DANGER: overwrites concurrent edits)
function saveRow(id: string, row: Todo): void {
	const rowMap = rowsMap.get(id) ?? new Y.Map();
	for (const [key, value] of Object.entries(row)) {
		rowMap.set(key, value); // Writes ALL fields
	}
	rowsMap.set(id, rowMap);
}
```

### Pros

- **Excellent ergonomics**: Migration is just a function
- **Full type safety**: `(TodoV1) => TodoV2` is fully typed
- **Supports all operations**: Rename, type change, restructure: anything goes
- **Easy to understand**: No special rules, just transform data

### Cons

- **YJS unsafe**: Writing entire rows creates conflicts on all fields
- **Can lose concurrent edits**: If peer A migrates while peer B edits, B's edit may be lost
- **Encourages bad patterns**: Developers might not realize the conflict danger

### When to Use

- **Non-collaborative apps**: Single user, no sync: conflicts impossible
- **Epoch-based migrations**: Bumping epoch means new Y.Doc, no concurrent edits
- **Infrequent migrations**: If migrations are rare, conflict window is small

---

## Approach B: Patch-Based (YJS-Safe, More Restrictive)

### Philosophy

Migrations should only **add new fields**, never touch existing ones. This guarantees no conflicts with concurrent edits.

### API Design

```typescript
import { type } from 'arktype';

const TodoV1 = type({
	_v: '1',
	id: 'string',
	text: 'string',
	done: 'boolean',
});

const TodoV2 = type({
	_v: '2',
	id: 'string',
	text: 'string', // can't rename in this approach
	done: 'boolean',
	status: "'active' | 'completed'", // new field
});

const TodoV3 = type({
	_v: '3',
	id: 'string',
	text: 'string',
	done: 'boolean',
	status: "'active' | 'completed' | 'archived'",
	priority: '1 | 2 | 3', // new field
});

const todosTable = versionedTable('todos')
	.v(1, TodoV1)
	.v(2, TodoV2, {
		// Only specify NEW fields to add
		addFields: (row) => ({
			status: row.done ? ('completed' as const) : ('active' as const),
		}),
	})
	.v(3, TodoV3, {
		addFields: () => ({
			priority: 2 as const,
		}),
	})
	.build();
```

### Type Signatures

```typescript
type PatchMigration<From, Added> = {
	// Returns only the NEW fields to add
	addFields: (row: From) => Added;
};

type VersionedTableBuilder<Name, Prev, Latest> = {
	v<V extends number, Next, Added>(
		version: V,
		schema: Type<Next>,
		migration?: PatchMigration<Prev, Added>,
	): VersionedTableBuilder<Name, Next, Next>;

	build(): VersionedTable<Name, Latest>;
};
```

### Usage with YJS (Safe Pattern)

```typescript
// Reading: migrate in-memory only
function getRow(id: string): Todo {
	const raw = rowsMap.get(id)?.toJSON();
	return todosTable.upgrade(raw);
}

// Writing: patch only new fields + version
function ensureMigrated(rowMap: Y.Map<any>): void {
	const currentVersion = rowMap.get('_v') ?? 1;

	if (currentVersion < 2) {
		// Only set NEW fields, don't touch existing ones
		if (!rowMap.has('status')) {
			const done = rowMap.get('done');
			rowMap.set('status', done ? 'completed' : 'active');
		}
		rowMap.set('_v', 2);
	}

	if (currentVersion < 3) {
		if (!rowMap.has('priority')) {
			rowMap.set('priority', 2);
		}
		rowMap.set('_v', 3);
	}
}

// User edit: migrate + apply changes in same transaction
function updateRow(id: string, changes: Partial<Todo>): void {
	ydoc.transact(() => {
		const rowMap = rowsMap.get(id);
		ensureMigrated(rowMap); // Safe: only adds new fields

		for (const [key, value] of Object.entries(changes)) {
			rowMap.set(key, value); // User's actual edit
		}
	});
}
```

### Pros

- **YJS safe**: Only writes new fields, never conflicts with existing data
- **Concurrent edit safe**: Peer A migrating won't clobber peer B's edit
- **Idempotent**: Running migration twice is safe
- **No "ping-pong"**: Devices don't keep re-migrating each other's data

### Cons

- **Cannot rename fields**: `text` stays `text` forever (or use both names)
- **Cannot change field types**: Must keep backward-compatible types
- **Cannot remove fields**: Old fields persist (soft delete only)
- **More verbose**: Migration specifies patches, not full transforms
- **Type safety is harder**: Ensuring `addFields` returns exactly the new fields is tricky

### When to Use

- **Collaborative apps**: Multiple peers editing simultaneously
- **Long-lived data**: Data may exist for years across many app versions
- **Strict consistency requirements**: Can't afford to lose any edits

---

## Operations Comparison

| Operation              | Approach A                                                | Approach B                                      |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Add nullable field     | `(row) => ({ ...row, field: null })`                      | `addFields: () => ({ field: null })`            |
| Add field with default | `(row) => ({ ...row, field: 'default' })`                 | `addFields: () => ({ field: 'default' })`       |
| Add computed field     | `(row) => ({ ...row, field: compute(row) })`              | `addFields: (row) => ({ field: compute(row) })` |
| Rename field           | `(row) => ({ ...row, newName: row.oldName })`             | **Not supported**: use alias or epoch          |
| Change field type      | `(row) => ({ ...row, field: convert(row.field) })`        | **Not supported**: use epoch                   |
| Remove field           | `(row) => { const {field, ...rest} = row; return rest; }` | **Not supported**: soft delete only            |

---

## Hybrid Approach: Patch by Default, Epoch for Breaking Changes

### Recommended Strategy

1. **Use Approach B (patch-based)** for additive changes:
   - Add nullable field
   - Add field with default
   - Add computed field

2. **Use epoch bump** for breaking changes:
   - Rename field
   - Change field type
   - Remove field
   - Restructure data

### Epoch-Based Migration

When you need breaking changes, bump the epoch (create new Y.Doc):

```typescript
// Migration script (runs once, coordinated)
async function migrateToEpoch2() {
	const head = createHeadDoc({ workspaceId });
	const oldEpoch = head.getEpoch();
	const newEpoch = oldEpoch + 1;

	const oldClient = await workspace.create({ epoch: oldEpoch });
	const newClient = await workspaceV2.create({ epoch: newEpoch });

	// Full transform is safe here: new doc, no concurrent edits
	for (const todo of oldClient.tables.todos.getAll()) {
		newClient.tables.todos.upsert({
			...todo,
			title: todo.text, // rename is safe
			// text field doesn't exist in new schema
		});
	}

	head.bumpEpoch();
}
```

---

## Version Field Design

### Should every row store `_v`?

**Yes, recommended.** Explicit version makes detection O(1):

```typescript
const row = rowMap.toJSON();
const version = row._v ?? 1; // Default to 1 for legacy data
```

### Should developers write version numbers explicitly?

**Yes.** Explicit is clearer:

```typescript
.v(1, TodoV1)
.v(2, TodoV2, migrate)
.v(3, TodoV3, migrate)
```

The builder can validate:

- Versions must be positive integers
- Versions must be ascending
- First version has no migration
- Subsequent versions require migration

### Version field rules

- `_v` is **monotonic**: only ever increases
- `_v` is **deterministic**: same input always produces same version
- Old clients should **never downgrade** `_v`

---

## Forward Compatibility

### Scenario: New Client Creates v3 Row, Old Client Edits It

```
Device A (app v2.0): Creates row with _v: 3, has 'priority' field
Device B (app v1.0): Syncs row, doesn't understand 'priority'
Device B: Edits 'title' field
Sync back to A...
```

**This works IF** Device B only patches fields it knows about:

```typescript
// Good: only touch known fields
rowMap.set('title', newTitle);

// Bad: rewrite entire row as understood schema
const myRow = { _v: 1, id, title, done }; // loses 'priority'!
for (const [k, v] of Object.entries(myRow)) {
	rowMap.set(k, v);
}
```

### Rule: Old clients must only patch known fields

This is an application-level concern. The `versionedTable` API can't enforce it, but documentation should emphasize it.

---

## Implementation Sketch

### Approach A: Full Row Transform

```typescript
export function versionedTable<Name extends string>(name: Name) {
	const versions: Map<number, { schema: Type<any>; migrate?: Function }> =
		new Map();
	let latestVersion = 0;

	const builder = {
		v<V extends number, T>(
			version: V,
			schema: Type<T>,
			migrate?: (prev: any) => T,
		) {
			if (version <= latestVersion) {
				throw new Error(
					`Version ${version} must be greater than ${latestVersion}`,
				);
			}
			if (latestVersion > 0 && !migrate) {
				throw new Error(`Version ${version} requires a migration function`);
			}
			versions.set(version, { schema, migrate });
			latestVersion = version;
			return builder;
		},

		build() {
			return {
				name,
				latestVersion,
				versions: Object.fromEntries(versions),

				upgrade(raw: unknown) {
					let current = raw as any;
					let currentVersion = current._v ?? 1;

					// Apply migrations sequentially
					for (let v = currentVersion + 1; v <= latestVersion; v++) {
						const { migrate } = versions.get(v)!;
						if (migrate) {
							current = migrate(current);
						}
					}

					// Validate against latest schema
					const result = versions.get(latestVersion)!.schema(current);
					if (result instanceof type.errors) {
						throw new Error(`Invalid data after migration: ${result.summary}`);
					}

					return current;
				},
			};
		},
	};

	return builder;
}
```

### Approach B: Patch-Based

```typescript
export function versionedTable<Name extends string>(name: Name) {
	const versions: Map<
		number,
		{
			schema: Type<any>;
			addFields?: (row: any) => Record<string, any>;
		}
	> = new Map();
	let latestVersion = 0;

	const builder = {
		v<V extends number, T>(
			version: V,
			schema: Type<T>,
			migration?: { addFields: (prev: any) => Record<string, any> },
		) {
			versions.set(version, { schema, addFields: migration?.addFields });
			latestVersion = version;
			return builder;
		},

		build() {
			return {
				name,
				latestVersion,
				versions: Object.fromEntries(versions),

				// In-memory upgrade (for reading)
				upgrade(raw: unknown) {
					let current = { ...(raw as any) };
					let currentVersion = current._v ?? 1;

					for (let v = currentVersion + 1; v <= latestVersion; v++) {
						const { addFields } = versions.get(v)!;
						if (addFields) {
							const newFields = addFields(current);
							current = { ...current, ...newFields, _v: v };
						} else {
							current._v = v;
						}
					}

					return current;
				},

				// YJS-safe patch (for writing)
				ensureMigrated(rowMap: Y.Map<any>) {
					const currentVersion = rowMap.get('_v') ?? 1;

					for (let v = currentVersion + 1; v <= latestVersion; v++) {
						const { addFields } = versions.get(v)!;
						if (addFields) {
							const row = rowMap.toJSON();
							const newFields = addFields(row);
							for (const [key, value] of Object.entries(newFields)) {
								if (!rowMap.has(key)) {
									rowMap.set(key, value);
								}
							}
						}
						rowMap.set('_v', v);
					}
				},
			};
		},
	};

	return builder;
}
```

---

## Recommendations

### For Epicenter HQ

1. **Start with Approach B (patch-based)** for the core `versionedTable` API
2. **Document clearly** that rename/type-change require epoch bumps
3. **Provide migration helpers** for epoch-based migrations separately
4. **Consider Approach A as opt-in** for single-user or epoch-migration contexts

### Decision Matrix

| Your Situation              | Recommended Approach      |
| --------------------------- | ------------------------- |
| Building collaborative app  | Approach B (patch)        |
| Building single-user app    | Either works              |
| Mostly adding fields        | Approach B (patch)        |
| Need to rename fields often | Approach A + epoch bumps  |
| Migrating between epochs    | Approach A (safe context) |

---

## Open Questions

1. **Should `upgrade()` write back to YJS?**
   - Current recommendation: No, keep reads pure. Write-back on user edit only.

2. **How to handle unknown fields from future versions?**
   - Preserve them. Don't delete fields you don't recognize.

3. **Should defaults be functions or values?**
   - Functions allow computed defaults: `addFields: (row) => ({ computed: derive(row) })`
   - Values are simpler: `addFields: { status: 'active' }`
   - Probably support both.

4. **Cross-table migrations (extract/normalize)?**
   - Out of scope for `versionedTable`. Handle in epoch migration scripts.

---

## Related Documents

- `specs/20260116T082500-schema-migration-patterns.md` - Broader migration strategy
- `specs/20250528T000000-transformation-schema-versioning.md` - Whispering's current approach
- `apps/whispering/src/lib/services/isomorphic/db/models/transformation-steps.ts` - Real implementation

---

## Deep Dive Analysis: Do Local-First Apps Actually Need Per-Row Versioning?

**Date**: 2026-01-24
**Status**: Research Complete

### Executive Summary

After extensive analysis consulting multiple perspectives (app developer use cases, YJS CRDT internals, industry practices), the recommendation is:

**Per-row `_v` versioning is OVERKILL for most local-first apps.** The 80/20 solution is:

1. **App-level schema version** (stored once, not per-row)
2. **Lazy migration on read/write** with Arktype pipes (Whispering's current pattern)
3. **Additive-only field changes** with deprecation layers
4. **Epoch bumps** for breaking changes (Epicenter's existing pattern)

### Research Sources

1. **Oracle analysis**: Local-first app versioning use cases across 7 app types
2. **Oracle analysis**: YJS Y.Map LWW conflict edge cases and mitigation
3. **YJS Community**: Real developer discussions on migration pain points
4. **Codebase exploration**: Whispering's existing patterns (Arktype pipes, epoch system)

---

### Analysis by App Type

| App Type                       | Realistic Schema Changes (2-3 years)                   | Per-Row `_v` Needed?                                  |
| ------------------------------ | ------------------------------------------------------ | ----------------------------------------------------- |
| **Whispering** (transcription) | Add fields (language, model, timestamps), rare renames | No - lazy migration on open works                     |
| **Notes app** (Notion-like)    | Add block types, block attributes                      | No - typed blocks + tolerant decoding                 |
| **Todo app**                   | Add fields (due, tags, priority), recurrence changes   | No - add-only, dual fields for transitions            |
| **Personal CRM**               | Add social profiles, custom fields                     | No - property bag model handles it                    |
| **Habit tracker**              | Add metrics, schedule rules                            | No - streaks can be recomputed                        |
| **Bookmark manager**           | Add tags, metadata, annotations                        | No - optional fields pattern                          |
| **Calendar**                   | Recurrence rule evolution                              | _Maybe_ - but dual fields + invariant tests preferred |

**Key insight**: ~50% of schema changes are "add field" (safe). The problematic 50% (rename, type change, delete) should use **epoch bumps**, not per-row versioning.

---

### YJS Y.Map LWW: The Core Problem

#### How Y.Map Conflict Resolution Actually Works

1. **"Last" is NOT wall-clock time**: it's deterministic order from Yjs internal operation IDs
2. **Any `set(key, value)` creates a new operation**, even if value is identical
3. **Concurrent writes to same key**: higher `clientID` tends to win (deterministic but arbitrary)
4. **No "read without touching"**: the only way to not write is to not call `set()`

#### The Migration Disaster Scenario

```
Device A (offline): Reads row v1, migrates to v2, writes ENTIRE row back
Device B (offline): Edits just the "title" field on v1
Both sync...

Result: A wrote `title = oldTitle` even though unchanged.
        B wrote `title = newTitle` (user's actual edit).
        Higher clientID wins. B's edit MAY BE LOST.
```

**This is why the "Full Row Transform" approach (Approach A) is DANGEROUS.**

#### Evidence from YJS Community

From [discuss.yjs.dev](https://discuss.yjs.dev/t/what-is-the-correct-way-to-apply-document-migrations/2321):

> "Migrations are a huge pain... pretty much the biggest glaring flaw with Yjs. I've lost many days designing around the migration problem. Supporting local-first back compat probably makes dev take 50% longer."

> "A migration can randomly erase data... we wait until server is synced before applying any migration, but then we lose offline-first."

**Kevin Jahns (YJS author) warning on clientID hacks:**

> "THIS CODE IS DISCOURAGED AND WILL LIKELY BREAK YOUR Yjs DOCUMENTS... once a client initializes state slightly differently, you will break all documents."

---

### What Actually Works (Safe Patterns)

#### Pattern 1: Patch-Based Migration (Only Write What Changes)

```typescript
// SAFE: Only writes NEW fields
doc.transact(() => {
	const row = table.get(id) as Y.Map<any>;
	const v = row.get('_v') ?? 1;
	if (v >= 2) return;

	// Only add if missing
	if (!row.has('foo')) row.set('foo', 'default');

	// Only rewrite if value actually differs
	const curTitle = row.get('title');
	const nextTitle = transform(curTitle);
	if (nextTitle !== curTitle) row.set('title', nextTitle);

	row.set('_v', 2);
});
```

#### Pattern 2: Lazy Migration on Read (Whispering's Current Approach)

```typescript
// transformation-steps.ts - ALREADY DOING THIS RIGHT
export const TransformationStep = TransformationStepV1.or(
	TransformationStepV2,
).pipe((step): TransformationStepV2 => {
	if (step.version === 1) {
		return { ...step, version: 2 /* add new fields */ };
	}
	return step;
});
```

This is **in-memory only**. Old data stays in old format until explicitly saved.

#### Pattern 3: Epoch System for Breaking Changes (Epicenter's Approach)

```typescript
// head-doc.ts - Full transform is SAFE in new Y.Doc
async function migrateToEpoch2() {
	const newClient = await workspace.create({ epoch: newEpoch });

	// Safe: new doc, no concurrent edits possible
	for (const todo of oldClient.tables.todos.getAll()) {
		newClient.tables.todos.upsert({
			...todo,
			title: todo.text, // rename is safe here
		});
	}

	head.bumpEpoch();
}
```

---

### What Whispering/Epicenter Already Has

| Layer               | Pattern                              | Where                     |
| ------------------- | ------------------------------------ | ------------------------- |
| **Record-level**    | Arktype `.pipe()` for lazy migration | `transformation-steps.ts` |
| **Workspace-level** | Epoch bump system                    | `head-doc.ts`             |
| **Storage-level**   | Dexie IndexedDB versioning           | `web.ts`, `desktop.ts`    |
| **Settings**        | Key renaming migration               | `settings.ts`             |

**This is already the right architecture.** Per-row `_v` would add complexity without proportional benefit.

---

### Revised Recommendations

#### For Epicenter Framework

1. **DO NOT mandate per-row `_v`** as a core primitive
2. **DO provide:**
   - App-level schema version (root metadata)
   - Migration pipeline (`migrate(fromVersion, toVersion)`)
   - Lazy entity migration hooks (Arktype pipes pattern)
   - Documentation: "add-only, dual-field transitions, tolerant readers"
3. **Keep epoch system** for breaking changes
4. **Make per-row `_v` an opt-in advanced pattern** for rare cases

#### When Per-Row Versioning IS Justified

Only if you can say "yes" to MOST of these:

- Shared docs with many concurrent collaborators
- Long periods where old and new app versions co-edit same data
- Partial replication (can't migrate everything deterministically)
- Very large datasets where full migration is expensive
- Frequent deep restructures of same entity types

For Whispering (mostly single-user, recordings are immutable-ish), **none of these apply**.

---

### Danger Patterns to Avoid

| Pattern                               | Why It's Dangerous                                       |
| ------------------------------------- | -------------------------------------------------------- |
| Full-row rewrites during migration    | Creates conflicts on EVERY field                         |
| Setting defaults blindly (`foo = ""`) | Can erase real data from concurrent peers                |
| Rename/delete migrations              | Concurrent edits can resurrect deleted keys              |
| `clientID = 0` hacks                  | Can corrupt documents if any divergence                  |
| Bumping `_v` early                    | Advertises completion even if some fields lost conflicts |

---

### Final Verdict

**The `versionedTable` API as designed (Approach A) should NOT be the default.**

The spec's own Approach B (patch-based) combined with Epicenter's existing epoch system is the correct architecture. The framework should:

1. Embrace the patterns Whispering already uses (Arktype pipes for lazy migration)
2. Keep epoch bumps for breaking changes (already implemented)
3. NOT add per-row `_v` complexity to every table
4. Document the "add-only + deprecation layer" pattern as the recommended approach

**Effort to implement "right" approach: Already done.** Whispering and Epicenter have the correct architecture. This spec should be updated to recommend _against_ per-row versioning as a default and instead document the existing patterns as best practices.

---

## Changelog

- 2026-01-24: Initial draft with both approaches documented
- 2026-01-24: Added deep dive analysis with Oracle research, YJS community evidence, and revised recommendations
