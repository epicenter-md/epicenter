# Schema System Improvements

**Status:** Complete
**Created:** 2025-12-31
**Branch:** `feat/static-defaults-constraint`

---

## Summary

This branch makes three improvements to the schema system:

1. **Static defaults only**: Remove function defaults from column schemas
2. **Library-agnostic JSON columns**: `JsonColumnSchema` now accepts any Standard Schema library
3. **Embedded Standard Schema types**: Remove `@standard-schema/spec` dependency

---

## 1. Static Defaults Constraint

**Commit:** `d33cb69bc`

### What Changed

Removed `| (() => T)` function types from all column schema defaults:

```typescript
// Before
type TextColumnSchema = {
	default?: string | (() => string);
};

// After
type TextColumnSchema = {
	default?: string;
};
```

Affected column types: `TextColumnSchema`, `IntegerColumnSchema`, `RealColumnSchema`, `BooleanColumnSchema`, `DateColumnSchema`, `JsonColumnSchema`

### Why

Defaults must be JSON-serializable for schema round-tripping (UI Schema → JSON Schema → JSON → reconstruct). Functions break this.

### Migration

```typescript
// Before (disallowed)
date({ default: () => new Date().toISOString() });

// After: Set at runtime in mutation handler
tables.posts.upsert({
	...data,
	createdAt: new Date().toISOString(),
});
```

---

## 2. Library-Agnostic JSON Columns

**Commit:** `98a4cb144`

### What Changed

`JsonColumnSchema` now uses `CombinedStandardSchema` instead of arktype's `Type`:

```typescript
// Before (arktype-specific)
type JsonColumnSchema<TSchema extends Type> = {
	schema: TSchema;
	// ...
};

// After (any Standard Schema library)
type JsonColumnSchema<TSchema extends CombinedStandardSchema> = {
	schema: TSchema;
	// ...
};
```

### Why

Allows using Zod, Valibot, or any Standard Schema-compliant library for JSON column validation, not just arktype.

### CombinedStandardSchema

A schema that implements both validation and JSON Schema conversion:

```typescript
type CombinedStandardSchema = {
	'~standard': StandardSchemaV1.Props & StandardJSONSchemaV1.Props;
};
```

ArkType, Zod (v4.2+), and Valibot (with adapter) all satisfy this.

---

## 3. Embedded Standard Schema Types

**Commit:** `0010b2cae`

### What Changed

Copied the Standard Schema spec types directly into the codebase instead of importing from `@standard-schema/spec`:

```
packages/epicenter/src/core/schema/standard-schema.ts
```

Contains:

- `StandardTypedV1`: Base type
- `StandardSchemaV1`: Validation interface
- `StandardJSONSchemaV1`: JSON Schema conversion interface
- `CombinedStandardSchema`: Combined type (our extension)

### Why

The Standard Schema spec recommends embedding the types rather than depending on the package. Reduces dependencies while maintaining full compatibility.

---

## Files Changed

### Created

- `packages/epicenter/src/core/schema/standard-schema.ts`: Embedded spec types

### Modified

- `packages/epicenter/src/core/schema/types.ts`: Updated column schema types
- `packages/epicenter/src/core/schema/columns.ts`: Updated column factories
- `packages/epicenter/src/core/schema/index.ts`: Updated exports
- `packages/epicenter/src/core/schema/converters/*.ts`: Updated imports
- `packages/epicenter/src/core/actions.ts`: Updated imports
- `packages/epicenter/src/cli/standard-json-schema-to-yargs.ts`: Updated imports

---

## Testing

All changes are type-level only. Typecheck passes with no new errors related to these changes.
