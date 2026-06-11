2025-02-13T10:28:00.000Z

# Types Should Be Computed, Not Declared

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. Code examples below use the original names. See `specs/20260213T014300-rename-suspended-to-saved.md`.

## `types.ts` is a code smell

I've written before about [co-locating types with their implementations](./type-co-location-pattern.md) and [not using generic type buckets](./type-colocation-pattern.md). Both of those are about where types should live. This one is about whether they should exist at all.

Most types in a well-designed TypeScript codebase aren't original creations. They're shadows of runtime values. Your Zod schema is the source of truth; the type is `z.infer<typeof userSchema>`. Your table definition declares the columns; the type is `InferTableRow<typeof BROWSER_TABLES.tabs>`. Your factory function returns a value; the type is `ReturnType<typeof createWorkspace>`.

When a type is derived from runtime code, declaring it manually in a separate file isn't just a co-location problem. It's duplication. You're writing down something that already exists as a consequence of the code above it. And manual declarations can drift from the runtime truth in a way that computed types never can.

## A real refactor

I had a browser extension with this layout:

```
lib/
├── schema/
│   ├── tables.ts        ← defineTable() calls, BROWSER_TABLES, type exports
│   ├── row-converters.ts
│   └── index.ts         ← barrel re-export + BrowserDb type alias
├── workspace.ts         ← defineWorkspace() + createWorkspace()
```

The `schema/` folder existed because I thought table definitions and their derived types were a separate concern from the workspace. Three files, a barrel, and a type alias nobody imported:

```typescript
// schema/tables.ts
const tabs = defineTable(
	type({ id: TabCompositeId, deviceId: 'string' /* ... */ }),
);
const windows = defineTable(type({ id: WindowCompositeId /* ... */ }));

export const BROWSER_TABLES = {
	devices,
	tabs,
	windows,
	tabGroups,
	suspendedTabs,
};

export type Tab = InferTableRow<typeof BROWSER_TABLES.tabs>;
export type Window = InferTableRow<typeof BROWSER_TABLES.windows>;
export type BrowserTables = typeof BROWSER_TABLES;
```

```typescript
// schema/index.ts
export * from './tables';
export type BrowserDb = TablesHelper<BrowserTables>; // zero imports of this anywhere
```

```typescript
// workspace.ts
import { BROWSER_TABLES } from '$lib/schema';

const definition = defineWorkspace({
	id: 'tab-manager',
	tables: BROWSER_TABLES,
});
export const popupWorkspace = createWorkspace(definition);
```

And `background.ts` had its own `defineWorkspace({ id: 'tab-manager', tables: BROWSER_TABLES })` call. Same definition, duplicated because the "schema" was in one place and the "workspace" was in another.

After:

```typescript
// workspace.ts: single source of truth
const tabs = defineTable(
	type({ id: TabCompositeId, deviceId: 'string' /* ... */ }),
);
const windows = defineTable(type({ id: WindowCompositeId /* ... */ }));

export const BROWSER_TABLES = {
	devices,
	tabs,
	windows,
	tabGroups,
	savedTabs,
};

export const definition = defineWorkspace({
	id: 'tab-manager',
	tables: BROWSER_TABLES,
});

export type Tab = InferTableRow<typeof BROWSER_TABLES.tabs>;
export type Window = InferTableRow<typeof BROWSER_TABLES.windows>;
```

The `schema/` folder is gone. The dead `BrowserDb` type alias is gone. The duplicated `defineWorkspace()` call is gone. Both background and popup import `definition` from the same file. The types sit directly below the runtime values they're computed from, because they're the same thing viewed from the type level.

## The pattern

This isn't specific to my workspace library. It's how all schema-first TypeScript works:

```typescript
// Zod
const userSchema = z.object({ id: z.string(), email: z.string().email() });
type User = z.infer<typeof userSchema>;

// Arktype
const User = type({ id: 'string', email: 'string.email' });
type User = typeof User.infer;

// Drizzle
const users = sqliteTable('users', { id: text('id'), email: text('email') });
type User = InferSelectModel<typeof users>;
```

In every case the runtime definition is the source of truth and the type is derived from it. There's no reason for the type to live in a different file from the definition it's computed from. And there's no reason to hand-write a type that a utility can infer.

## When you see a `types.ts` full of derived types

Ask: can each of these be expressed as `typeof X`, `z.infer<typeof X>`, `ReturnType<typeof X>`, or some schema-specific inference utility? If yes, move each type next to the runtime value it derives from and delete the file.

The exceptions are real but narrow: vocabulary types like `ColumnSchema` that genuinely span unrelated modules, branded primitives with no runtime companion, or protocol types that exist purely as contracts. Those earn a file. But `Tab = InferTableRow<typeof BROWSER_TABLES.tabs>` does not.

If every type in your `types.ts` can be derived from a runtime value, the file is redundant. Delete it. The types belong with the values that define them.
