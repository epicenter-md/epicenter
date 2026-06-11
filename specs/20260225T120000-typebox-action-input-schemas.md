# TypeBox for Action Input Schemas

**Created**: 2026-02-25
**Status**: Draft

## Summary

Switch action input schemas (`defineQuery`, `defineMutation`) from `CombinedStandardSchema` (arktype) to TypeBox `TSchema`. Document schemas (`defineTable`, `defineKv`) remain arktype via `CombinedStandardSchema`. Clean break, no backwards compatibility layer.

## Why

Action inputs flow to three consumers that all want JSON Schema:
1. **AI tools** (TanStack AI `toolDefinition`): needs `JSONSchema` objects
2. **CLI** (yargs): needs JSON Schema to generate flags
3. **Server** (Elysia): validates input, introspects schema

Today, arktype schemas go through `standardSchemaToJsonSchema()` which:
- Has lossy conversion (12 fallback codes in `arktype-fallback.ts`)
- Strips `undefined` from optional unions (the `unit` handler)
- Falls back to `{}` on catastrophic failure
- Logs warnings for unconvertible types

TypeBox schemas **are** JSON Schema objects. No conversion, no loss, no fallbacks.

### Bonus: Per-field UI annotations

TypeBox's schema options accept arbitrary keys, so every field can carry custom metadata that survives all the way to form renderers and AI tool definitions:

```typescript
Type.String({
  description: 'Post title',
  minLength: 1,
  'x-ui': { component: 'text-input', label: 'Title', autofocus: true },
})
```

This metadata is impossible to attach in arktype (only `.describe()` and `.configure()` exist). The `x-ui` convention shape is deferred. We'll define it when we build the form renderer.

## Decisions

| Question | Answer |
|----------|--------|
| TypeBox version | **1.x**: package name is `typebox` (not `@sinclair/typebox` which is 0.34.x legacy) |
| Backwards compatibility | **Clean break**: no `CombinedStandardSchema` bridge for actions |
| UI annotation shape | **Deferred**: define when building the form renderer |

## TypeBox 1.x imports

```typescript
// Core types and builders
import Type, { type TSchema, type TObject } from 'typebox'

// Static type inference (replaces StandardSchemaV1.InferOutput)
type Inferred = Type.Static<typeof MySchema>

// Runtime validation (replaces ~standard.validate())
import Value from 'typebox/value'
Value.Check(schema, data)       // returns boolean
Value.Errors(schema, data)      // returns iterator of errors
Value.Decode(schema, data)      // returns decoded value or throws
```

## Design

### Boundary

| Concern | Schema library | Why |
|---------|---------------|-----|
| Document schemas (`defineTable`, `defineKv`) | arktype via `CombinedStandardSchema` | Morphs, pipes, terse syntax, internal validation |
| Action input schemas (`defineQuery`, `defineMutation`) | TypeBox 1.x `TSchema` | 1:1 JSON Schema, UI annotations, zero conversion |

### Type changes

**Before:**
```typescript
// packages/epicenter/src/shared/actions.ts
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CombinedStandardSchema } from '../shared/standard-schema/types';

type ActionHandler<
  TInput extends CombinedStandardSchema | undefined,
  TOutput,
> = (
  ...args: TInput extends CombinedStandardSchema
    ? [input: StandardSchemaV1.InferOutput<TInput>]
    : []
) => TOutput | Promise<TOutput>;

type ActionConfig<
  TInput extends CombinedStandardSchema | undefined = undefined,
  TOutput = unknown,
> = {
  description?: string;
  input?: TInput;
  handler: ActionHandler<TInput, TOutput>;
};
```

**After:**
```typescript
// packages/epicenter/src/shared/actions.ts
import Type, { type TSchema } from 'typebox';

type ActionHandler<
  TInput extends TSchema | undefined,
  TOutput,
> = (
  ...args: TInput extends TSchema
    ? [input: Type.Static<TInput>]
    : []
) => TOutput | Promise<TOutput>;

type ActionConfig<
  TInput extends TSchema | undefined = undefined,
  TOutput = unknown,
> = {
  description?: string;
  input?: TInput;
  handler: ActionHandler<TInput, TOutput>;
};
```

### Validation changes

TypeBox validation replaces `~standard.validate()`:

```typescript
import Value from 'typebox/value'

// In server adapter:
if (action.input) {
  if (!Value.Check(action.input, args)) {
    const errors = [...Value.Errors(action.input, args)];
    // return 400 with errors
  }
}
```

## Files to change

### Tier 1: Core type system

| File | Change |
|------|--------|
| `packages/epicenter/src/shared/actions.ts` | Replace `CombinedStandardSchema` with `TSchema` from `typebox` in all action types (`ActionConfig`, `ActionHandler`, `ActionMeta`, `Action`, `Query`, `Mutation`). Replace `StandardSchemaV1.InferOutput<TInput>` with `Type.Static<TInput>`. Remove `@standard-schema/spec` import. |
| `packages/epicenter/src/index.ts` | Update exports if needed |

### Tier 2: Adapters

| File | Change |
|------|--------|
| `packages/ai/src/derive-tools.ts` | Remove `standardSchemaToJsonSchema` import. In `actionToToolDefinition`, pass `action.input` directly as `inputSchema`: it's already JSON Schema. In `toNormalizedJsonSchema`, accept `TSchema` instead of `StandardJSONSchemaV1`. The function just strips `$schema` and ensures `properties`/`required` exist, so it stays simple. |
| `packages/server/src/workspace/actions.ts` | Replace `action.input['~standard'].validate()` with `Value.Check()` from `typebox/value`. Use `Value.Errors()` for error details. |
| `packages/cli/src/command-builder.ts` | Replace `standardSchemaToJsonSchema(action.input)` with direct pass-through: `action.input` IS JSON Schema. Replace `action.input['~standard'].validate()` with `Value.Check()`. |

### Tier 3: Introspection

| File | Change |
|------|--------|
| `packages/epicenter/src/workspace/describe-workspace.ts` | For actions, skip `standardSchemaToJsonSchema()`: pass `action.input` directly as the `input` field of the action descriptor. |

### Tier 4: Tests

| File | Change |
|------|--------|
| `packages/server/src/workspace/actions.test.ts` | Replace `type({ title: 'string' })` with `Type.Object({ title: Type.String() })` |
| `packages/cli/src/command-builder.test.ts` | Same: arktype → TypeBox for action input schemas |
| `packages/cli/src/json-schema-to-yargs.test.ts` | Probably no change: tests JSON Schema objects directly |
| `packages/epicenter/src/workspace/describe-workspace.test.ts` | Change action input schemas from arktype to TypeBox |

### Tier 5: No change needed

| File | Why |
|------|-----|
| `packages/epicenter/src/workspace/define-table.ts` | Document schema, stays arktype |
| `packages/epicenter/src/workspace/define-kv.ts` | Document schema, stays arktype |
| `packages/epicenter/src/workspace/schema-union.ts` | Document schema, stays arktype |
| `packages/epicenter/src/workspace/table-helper.ts` | Document schema, stays arktype |
| `packages/epicenter/src/workspace/create-tables.ts` | Document schema, stays arktype |
| `packages/epicenter/src/workspace/create-kv.ts` | Document schema, stays arktype |
| `packages/epicenter/src/shared/standard-schema/arktype-fallback.ts` | Still needed for `describeWorkspace` table schema conversion |
| `packages/epicenter/src/shared/standard-schema/to-json-schema.ts` | Still needed for table schema conversion |
| `packages/epicenter/src/shared/standard-schema/types.ts` | Still needed for `defineTable`/`defineKv` |
| `packages/cli/src/json-schema-to-yargs.ts` | Already takes JSON Schema input |

### Tier 6: Tab manager (already manual)

| File | Change |
|------|--------|
| `apps/tab-manager/src/lib/ai/tools/definitions.ts` | Already defines tools manually. Could switch to TypeBox for input schemas but not required for this migration. |

## Migration order

1. **Install `typebox`** (1.x) as a dependency in `packages/epicenter` and `packages/server` and `packages/cli` and `packages/ai`
2. **Change core types** in `packages/epicenter/src/shared/actions.ts`
3. **Update adapters** (AI, server, CLI): these will have type errors after step 2
4. **Update introspection** in `describe-workspace.ts`
5. **Update tests**: change arktype `type()` calls to TypeBox `Type.Object()` calls
6. **Verify** with `bun run typecheck` and `bun test`

## Example: Before and after

### Before (arktype)
```typescript
import { type } from 'arktype';

const createPost = defineMutation({
  description: 'Create a new post',
  input: type({ title: 'string', 'tags?': 'string[]' }),
  handler: ({ title, tags }) => {
    client.tables.posts.upsert({ id: generateId(), title, tags: tags ?? [] });
  },
});
```

### After (TypeBox 1.x)
```typescript
import Type from 'typebox';

const createPost = defineMutation({
  description: 'Create a new post',
  input: Type.Object({
    title: Type.String({ description: 'Post title', minLength: 1 }),
    tags: Type.Optional(Type.Array(Type.String())),
  }),
  handler: ({ title, tags }) => {
    client.tables.posts.upsert({ id: generateId(), title, tags: tags ?? [] });
  },
});
```

---

## Agent prompt

Copy and paste this to a coding agent to implement the spec:

```
## Task: Switch action input schemas from arktype to TypeBox 1.x

Read the specification at `specs/20260225T120000-typebox-action-input-schemas.md` for full context.

### What you're doing

Action input schemas in Epicenter currently use arktype (via `CombinedStandardSchema`). Switch them to TypeBox 1.x (`TSchema` from `typebox`) because TypeBox schemas ARE JSON Schema objects, no conversion needed, and they support arbitrary per-field metadata for UI annotations.

Document schemas (`defineTable`, `defineKv`) stay on arktype. Only action schemas change. This is a clean break, no backwards compatibility layer.

### TypeBox 1.x imports

The package name is `typebox` (NOT `@sinclair/typebox` which is the 0.34.x legacy package):

```typescript
import Type, { type TSchema, type TObject } from 'typebox'
import Value from 'typebox/value'

// Static type inference:
type Inferred = Type.Static<typeof MySchema>

// Validation:
Value.Check(schema, data)    // boolean
Value.Errors(schema, data)   // iterator of errors
```

### Key files to modify (in order)

1. **Install `typebox` 1.x**: `bun add typebox` in each package that needs it (`packages/epicenter`, `packages/server`, `packages/cli`, `packages/ai`). Use the workspace catalog if this monorepo has one.

2. **`packages/epicenter/src/shared/actions.ts`**: Replace `CombinedStandardSchema` with `TSchema` from `typebox` in all action types. Replace `StandardSchemaV1.InferOutput<TInput>` with `Type.Static<TInput>` for handler input inference. Remove `@standard-schema/spec` import from this file.

3. **`packages/ai/src/derive-tools.ts`**: Remove `standardSchemaToJsonSchema` usage for actions. Pass `action.input` directly as `inputSchema` since TypeBox schemas are already JSON Schema. Update `toNormalizedJsonSchema` to accept the TypeBox schema directly instead of `StandardJSONSchemaV1`.

4. **`packages/server/src/workspace/actions.ts`**: Replace `action.input['~standard'].validate()` with TypeBox's `Value.Check()` from `typebox/value`. Use `Value.Errors()` for error details.

5. **`packages/cli/src/command-builder.ts`**: Replace `standardSchemaToJsonSchema(action.input)` with direct pass-through. Replace `action.input['~standard'].validate()` with `Value.Check()`.

6. **`packages/epicenter/src/workspace/describe-workspace.ts`**: For actions, pass `action.input` directly instead of converting through `standardSchemaToJsonSchema()`.

7. **Update all test files** that define actions with input schemas: change `type({ title: 'string' })` to `Type.Object({ title: Type.String() })`.

### Important constraints

- Do NOT touch document schemas (`defineTable`, `defineKv`): they stay on arktype
- Do NOT remove the standard-schema infrastructure (`to-json-schema.ts`, `arktype-fallback.ts`, `types.ts`): still needed for document schema conversion in `describeWorkspace`
- Use `typebox` 1.x (NOT `@sinclair/typebox` which is legacy 0.34.x)
- Run `bun run typecheck` and `bun test` to verify after changes
- Keep the `packages/epicenter/src/index.ts` exports clean
- This is a clean break: no `CombinedStandardSchema` compatibility for actions
```
