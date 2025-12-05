# Flatten DB Namespace and Improve Table Iteration

## Problem

The current `db` API has two issues:

1. **Verbose table access**: `db.tables.posts.insert()` requires an unnecessary `.tables` namespace
2. **Unsafe iteration**: `db.getTableNames()` leads to unsafe TypeScript indexing:
   ```typescript
   for (const tableName of db.getTableNames()) {
       db.tables[tableName].clear();  // TypeScript can't verify this exists
       db.schema[tableName];          // Same issue
       db.validators[tableName]!;     // Requires non-null assertion
   }
   ```

## Solution

### Design Principle

**Everything with `$` is a utility. Everything without `$` is a table.**

This creates a clear, consistent rule. The only constraint is that table names cannot start with `$`.

### New API Shape

```typescript
// Tables (primary use case - 95% of usage)
db.posts.insert(...)
db.emails.getAll()

// Utilities (all prefixed with $)
db.$schema.posts           // Schema metadata (for typing)
db.$validators.posts       // Runtime validators
db.$transact(() => {...})  // Transaction wrapper
db.$ydoc                   // YJS document (advanced/internal)
db.$clearAll()             // Clear all tables
db.$tableEntries()         // Type-safe iteration
```

### Type Definition

```typescript
type TableEntry<TTableSchema extends TableSchema> = {
    name: string;
    table: TableHelper<TTableSchema>;
    schema: TTableSchema;
    validators: TableValidators<TTableSchema>;
};

type Db<TWorkspaceSchema extends WorkspaceSchema> = {
    // Flattened tables (spread directly)
    [K in keyof TWorkspaceSchema]: TableHelper<TWorkspaceSchema[K]>;
} & {
    // Utilities (all with $ prefix)
    $schema: TWorkspaceSchema;
    $validators: WorkspaceValidators<TWorkspaceSchema>;
    $transact: (fn: () => void, origin?: string) => void;
    $ydoc: Y.Doc;
    $clearAll: () => void;
    $tableEntries: () => TableEntry<TWorkspaceSchema[keyof TWorkspaceSchema]>[];
};
```

## Implementation Plan

### Phase 1: Update core.ts

- [ ] Add reserved name validation (throw if any table name starts with `$`)
- [ ] Add `$clearAll()` method that clears all tables in a transaction
- [ ] Add `$tableEntries()` method returning typed array of `{ name, table, schema, validators }`
- [ ] Rename `schema` to `$schema`
- [ ] Rename `validators` to `$validators`
- [ ] Rename `transact` to `$transact`
- [ ] Rename `ydoc` to `$ydoc`
- [ ] Spread table helpers directly onto returned object (flatten from `tables.x` to just `x`)
- [ ] Remove `getTableNames()` method
- [ ] Remove `tables` property
- [ ] Update `Db` type alias

### Phase 2: Update sqlite-index.ts

- [ ] Replace `db.getTableNames()` loops with `db.$tableEntries()`
- [ ] Replace manual clear loops with `db.$clearAll()`
- [ ] Update `db.tables[tableName]` to use entry's `table` property
- [ ] Update `db.schema` to `db.$schema`
- [ ] Update `db.transact` to `db.$transact`

### Phase 3: Update markdown-index.ts

- [ ] Replace `db.getTableNames()` with `db.$tableEntries()`
- [ ] Replace manual clear loop with `db.$clearAll()`
- [ ] Update the `tables` metadata builder to use `db.$tableEntries()`
- [ ] Update `db.schema` to `db.$schema`
- [ ] Update `db.validators` to `db.$validators`
- [ ] Update `db.transact` to `db.$transact`

### Phase 4: Update workspace config and index types

- [ ] Update `IndexContext` type in `indexes.ts`
- [ ] Update `WorkspaceConfig.exports` context type in `config.ts`
- [ ] Update any JSDoc examples

### Phase 5: Update examples and tests

- [ ] Update `examples/basic-workspace/epicenter.config.ts`
  - [ ] `db.tables.posts` → `db.posts`
  - [ ] `db.schema.posts` → `db.$schema.posts`
- [ ] Update `examples/content-hub/**/*.workspace.ts`
  - [ ] All `db.tables.x` → `db.x`
  - [ ] All `db.validators.x` → `db.$validators.x`
- [ ] Update `packages/epicenter/src/cli/*.test.ts`
- [ ] Update any `SerializedRow<typeof db.schema.x>` → `SerializedRow<typeof db.$schema.x>`

### Phase 6: Update documentation

- [ ] Update JSDoc in `core.ts`
- [ ] Update README examples if any
- [ ] Update `workspace/config.ts` examples in JSDoc

## Migration Examples

### User exports (most common change)

```typescript
// Before
exports: ({ db }) => ({
    getEmails: db.tables.emails.getAll,
    createEmail: db.tables.emails.insert,
})

// After
exports: ({ db }) => ({
    getEmails: db.emails.getAll,
    createEmail: db.emails.insert,
})
```

### Type annotations

```typescript
// Before
} satisfies SerializedRow<typeof db.schema.posts>;

// After
} satisfies SerializedRow<typeof db.$schema.posts>;
```

### Index iteration (sqlite-index.ts)

```typescript
// Before
for (const tableName of db.getTableNames()) {
    const drizzleTable = drizzleTables[tableName];
    if (!drizzleTable) throw new Error(`Drizzle table for "${tableName}" not found`);

    db.tables[tableName].observe({...});
}

// After
for (const { name, table } of db.$tableEntries()) {
    const drizzleTable = drizzleTables[name];
    if (!drizzleTable) throw new Error(`Drizzle table for "${name}" not found`);

    table.observe({...});
}
```

### Clearing all tables

```typescript
// Before
db.transact(() => {
    for (const tableName of db.getTableNames()) {
        db.tables[tableName].clear();
    }
});

// After
db.$clearAll();
```

### Building table metadata (markdown-index.ts)

```typescript
// Before
const tables = db.getTableNames().map((tableName) => {
    const table = db.tables[tableName];
    const tableSchema = db.schema[tableName];
    const validators = db.validators[tableName]!;
    // ...
}).filter(Boolean);

// After
const tables = db.$tableEntries().map(({ name, table, schema, validators }) => {
    // All guaranteed to exist, properly typed
    // ...
});
```

## Reserved Names

Table names cannot start with `$`. This is validated at schema creation time with a clear error message:

```typescript
// In createEpicenterDb()
for (const tableName of Object.keys(schema)) {
    if (tableName.startsWith('$')) {
        throw new Error(
            `Table name "${tableName}" is invalid: table names cannot start with "$" (reserved for utilities)`
        );
    }
}
```

## Review

### Implementation Summary

All phases completed successfully. The refactoring flattened the `db` API from `db.tables.tableName` to `db.tableName` and prefixed all utilities with `$`.

### Files Modified

**Core Package (`packages/epicenter/src`):**

1. **`core/db/core.ts`**: Implemented the new API shape with flattened tables and `$`-prefixed utilities. Added `$tableEntries()`, `$clearAll()`, and reserved name validation.

2. **`indexes/sqlite/sqlite-index.ts`**: Updated all table iteration to use `db.$tableEntries()`. Replaced manual clear loops with `db.$clearAll()`. Updated `db.schema` to `db.$schema` and `db.transact` to `db.$transact`.

3. **`indexes/markdown/markdown-index.ts`**: Updated to use `db.$tableEntries()` for iteration. Added `as any` casts with biome-ignore comments for union type compatibility when iterating tables. Updated all utility references to use `$` prefix.

4. **`core/indexes.ts`**: Updated JSDoc examples to use new API patterns.

5. **`core/workspace/config.ts`**: Updated JSDoc examples to use new API patterns.

**Examples:**

1. **`examples/basic-workspace/epicenter.config.ts`**: Bulk replaced `db.tables.` to `db.` and `db.schema.` to `db.$schema.`.

2. **`examples/content-hub/**/*.workspace.ts`** (19 workspace files): Updated all table access patterns and validator references.

3. **`examples/content-hub/scripts/03-migrate-from-epicenter.ts`**: Updated to use new API patterns.

4. **`examples/basic-workspace/README.md`** and **`examples/content-hub/README.md`**: Updated code examples.

### Union Type Handling

When iterating tables with `$tableEntries()`, TypeScript union types require `as any` casts for compatibility. These are documented with biome-ignore comments explaining the pattern:

```typescript
// biome-ignore lint/suspicious/noExplicitAny: union type compatibility via $tableEntries iteration
table.insert(row as any);
```

### API Changes

| Before | After |
|--------|-------|
| `db.tables.posts` | `db.posts` |
| `db.schema.posts` | `db.$schema.posts` |
| `db.validators.posts` | `db.$validators.posts` |
| `db.transact()` | `db.$transact()` |
| `db.ydoc` | `db.$ydoc` |
| `db.getTableNames()` | `db.$tableEntries()` |
| Manual clear loop | `db.$clearAll()` |

### Design Principle Achieved

"Everything with `$` is a utility. Everything without `$` is a table."

### Type Check Status

All errors related to this refactoring (`db.tables`, `db.schema`) are resolved. The following pre-existing errors remain unrelated to this work:

- `server.ts`: Symbol.dispose typing issue
- `epicenter.test.ts`: Argument count mismatch
- `arktype-yjs.test.ts`: Test-specific issues
- Various test files: Minor typing issues

These can be addressed in separate cleanup tasks.

---

## Follow-up: Simplify `$tableEntries()` to `$tables()`

### Context

After the initial refactoring, we identified that `TableEntry` was redundant because `TableHelper` already includes `name`, `schema`, and `validators` properties.

### Change

Renamed `$tableEntries()` to `$tables()` and simplified the return type:

```typescript
// Before
type TableEntry<TTableSchema extends TableSchema> = {
    name: string;
    table: TableHelper<TTableSchema>;
    schema: TTableSchema;
    validators: TableValidators<TTableSchema>;
};

$tableEntries(): TableEntry<TWorkspaceSchema[keyof TWorkspaceSchema]>[];

// After
$tables(): TableHelper<TWorkspaceSchema[keyof TWorkspaceSchema]>[];
```

### Migration

```typescript
// Before
for (const { name: tableName, table, schema, validators } of db.$tableEntries()) {
    // ...
}

// After
for (const table of db.$tables()) {
    table.name       // Table name
    table.schema     // Table schema
    table.validators // Table validators
    // ...
}
```

### Files Updated

- `packages/epicenter/src/core/db/core.ts`: Removed `TableEntry` type, renamed to `$tables()`
- `packages/epicenter/src/indexes/markdown/markdown-index.ts`: Updated iteration patterns
- `packages/epicenter/src/indexes/sqlite/sqlite-index.ts`: Updated iteration patterns
- `examples/content-hub/scripts/03-migrate-from-epicenter.ts`: Updated validator access
- `examples/content-hub/journal/journal.workspace.ts`: Updated JSDoc example
