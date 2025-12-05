# Table Helpers Query/Mutation Integration Plan

**Date**: November 1, 2025
**Status**: Planning
**Objective**: Wrap table helper methods with `defineQuery`/`defineMutation` and add arktype schema generation

## Problem Statement

Currently, table helper methods (insert, update, upsert, delete, get, etc.) are raw functions that:
- Don't have input validation
- Throw errors instead of returning Results
- Aren't typed for the query layer
- Lack metadata (descriptions, input schemas)

We want to transform them into query/mutation actions that:
- Have arktype validators for input
- Return `Result<T, TableHelperError>` instead of throwing
- Are directly usable in the query layer via `defineQuery`/`defineMutation`
- Include auto-generated descriptions

## Architecture

### Three-Layer System

```
UI Components
    ↓
Query Layer (defineQuery/defineMutation with arktype validation)
    ↓
Service Layer (table helpers returning Results)
    ↓
YJS Storage
```

### Key Design Decisions

1. **Table helpers return `Result` instead of throwing**
   - Use `createTaggedError` to define table operation errors
   - Errors flow naturally through the Result type

2. **Standard Schema validators for input**
   - `schema.toStandardSchema()` → full `SerializedRow<TSchema>` validator
   - `schema.toPartialStandardSchema()` → partial `SerializedRow<TSchema>` validator (id required)
   - Both implement `StandardSchemaV1` for compatibility

3. **Methods wrapped with defineQuery/defineMutation**
   - Wrap in `createTableHelper` function
   - Keep utility methods (observe, find, filter, clear, count, has) as direct functions
   - Auto-generate descriptions based on method name and table schema

4. **Return types remain same**
   - Methods still look callable as before
   - Metadata attached via properties (type, input, description)
   - UI code doesn't change

## Decisions (Approved ✅)

1. **get(id) → get({id})**:
   - Change signature from `get(id: string)` to `get({ id }: { id: string })`
   - Wrap with `defineQuery` with arktype input: `type({ id: 'string' })`
   - Makes it consistent with mutations and enables input validation

2. **clear() and count()**:
   - Wrap both with defineQuery/defineMutation
   - Don't include `input` key (no input validation needed)
   - `clear()`: `defineMutation({ handler, description })`
   - `count()`: `defineQuery({ handler, description })`

3. **delete() signature**:
   - Change from `delete(id: string)` to `delete({ id }: { id: string })`
   - Input validation: `type({ id: 'string' })`
   - Same pattern as `get`

4. **deleteMany() signature**:
   - Input: `type({ ids: 'string[]' })`
   - Array of IDs wrapped in object

5. **Array mutations (insertMany, updateMany, upsertMany)**:
   - Use `.array()` on base validators
   - `insertMany`: input is `schema.toStandardSchema().array()` (wait, arktype doesn't work like this...)
   - Actually: input is arktype array validator for SerializedRow[]

## Implementation Plan

### Phase 1: Error Definition

**Task 1.1**: Create table helper error types
- Location: `packages/epicenter/src/db/errors.ts` (new file)
- Create `createTaggedError` for table operations
- Define error variants:
  - `RowAlreadyExists`: Insert/upsert on existing id
  - `RowNotFound`: Update/delete on missing id
  - `ValidationError`: Schema validation failed
  - `TransactionError`: YJS transaction failed

**Task 1.2**: Update table helper throws to return Results
- Location: `packages/epicenter/src/db/table-helper.ts`
- Replace all `throw` statements with Result errors
- Import error constructors
- Ensure all methods have consistent error handling

### Phase 2: ArkType Schema Generation

**Task 2.1**: Add `toStandardSchema()` method to TableSchemaWithValidation
- Location: `packages/epicenter/src/core/schema.ts`
- Implement converter from ColumnSchema to ArkType type strings
- Handle:
  - Primitives (text, integer, real, boolean, id)
  - Y.Text → string in serialized form
  - Y.Array → array in serialized form
  - Dates → DateWithTimezoneString
  - Select → literal union `"option1" | "option2"`
  - Multi-select → array of literals `("option1" | "option2")[]`
  - Nullable fields → union with undefined
- Return: `StandardSchemaV1` compatible ArkType validator

**Task 2.2**: Add `toPartialStandardSchema()` method to TableSchemaWithValidation
- Variant where `id` is required, all other fields optional
- Use same type conversion as `toStandardSchema()`
- Return: `StandardSchemaV1` compatible ArkType validator

**Task 2.3**: Test arktype generation
- Verify generated validators match SerializedRow types
- Test nullable/optional field handling
- Test select/multi-select generation
- Test partial variant

### Phase 3: Wrapper Infrastructure

**Task 3.1**: Create auto-description generator
- Location: `packages/epicenter/src/db/descriptions.ts` (new file)
- Function: `generateMethodDescription(method: string, tableName: string, schema: TableSchema): string`
- Examples:
  - `get(id)` → "Get a single row from posts table by ID"
  - `insert()` → "Create a new row in posts table"
  - `update(id)` → "Update specific fields in posts table row"
  - `upsert()` → "Create or update a row in posts table"
  - `delete(id)` → "Remove a row from posts table"
  - etc.

**Task 3.2**: Create method wrapper factory
- Location: `packages/epicenter/src/db/table-helper.ts`
- Helper functions that wrap table methods with `defineQuery`/`defineMutation`
- Three variants:
  - `wrapQuery(method, schema)` - for `get`, `getAll`
  - `wrapMutation(method, schema)` - for mutations with input
  - `wrapMutationNoInput(method)` - for mutations without input (delete, clear)

### Phase 4: Integrate into createTableHelper

**Task 4.1**: Refactor createTableHelper to use wrappers
- Location: `packages/epicenter/src/db/table-helper.ts`
- Change method signatures to accept objects where needed
- Wrap each method:
  - `get({id})`: defineQuery with `{id: 'string'}` input validator
  - `getAll()`: defineQuery with no input
  - `insert(row)`: defineMutation with `toStandardSchema()` input
  - `update(partial)`: defineMutation with `toPartialStandardSchema()` input
  - `upsert(row)`: defineMutation with `toStandardSchema()` input
  - `delete({id})`: defineMutation with `{id: 'string'}` input
  - `deleteMany(ids)`: defineMutation with `string[]` input
  - `insertMany(rows)`: defineMutation with `toStandardSchema().array()` input
  - `updateMany(partials)`: defineMutation with `toPartialStandardSchema().array()` input
  - `upsertMany(rows)`: defineMutation with `toStandardSchema().array()` input
  - `clear()`: defineMutation with no input
  - `count()`: defineQuery with no input
  - Keep utilities: observe, find, filter, has

**Task 4.2**: Remove console.log debug statements
- Location: `packages/epicenter/src/db/table-helper.ts` lines 538, 541, 570, 573

### Phase 5: Integration Testing

**Task 5.1**: Unit tests for error handling
- Verify Result<Ok, Err> flows correctly
- Test each error type

**Task 5.2**: Unit tests for arktype generation
- Test schema conversion for each column type
- Test partial variants
- Test validation passes/fails correctly

**Task 5.3**: Integration test
- Create sample table schema
- Verify wrapper functions have correct metadata
- Verify input schemas are callable and validate correctly
- Verify wrapped methods can be used as defineQuery/defineMutation in actions

## Design Decisions (User-Approved)

1. **get(id) input handling**:
   - **Decision**: Change signature from `get(id: string)` to `get({id: string})`
   - Wrap with `defineQuery({ input: schema.toStandardSchema() with only id, handler })`
   - Enables consistent input validation

2. **Clear/count methods**:
   - **Decision**: Wrap both, but omit `input` key
   - `defineQuery({ handler: () => ..., description: "..." })`
   - `defineMutation({ handler: () => ..., description: "..." })`

3. **Delete by ID**:
   - **Decision**: Input should be `{ id: string }`
   - Wraps as: `defineMutation({ input: { id: 'string' }, handler })`

4. **Array inputs**: For `insertMany/updateMany`, should input validation be:
   - Arktype array validator like `type({ id: 'string', ... }).array()`?
   - **Recommendation**: Yes, use `.array()` on the base validator

## Success Criteria

- [ ] All table helper methods return `Result<T, TableHelperError>`
- [ ] `schema.toStandardSchema()` generates correct validators
- [ ] `schema.toPartialStandardSchema()` generates correct partial validators
- [ ] All wrapped methods have metadata (type, input, description)
- [ ] Descriptions are auto-generated and sensible
- [ ] Unit tests pass for error handling
- [ ] Unit tests pass for Standard Schema generation
- [ ] Integration test passes showing query layer compatibility
- [ ] No console.log statements remain in table-helper.ts
- [ ] TypeScript compilation succeeds with no errors

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking existing code that calls table helpers | Wrapped methods are still callable, just return Results |
| Complex ArkType generation for all column types | Research done, patterns identified in Phase 2 |
| Performance impact from Result wrapping | Results are zero-cost abstractions, negligible impact |
| Partial vs full validators confusion | Clear naming: `toStandardSchema()` vs `toPartialStandardSchema()` |

## Timeline Estimate

- Phase 1 (errors): 2-3 hours
- Phase 2 (arktype): 3-4 hours
- Phase 3 (wrappers): 2-3 hours
- Phase 4 (integration): 2-3 hours
- Phase 5 (testing): 3-4 hours
- **Total**: 12-17 hours

## Next Steps

1. User review and approval of this plan
2. Clarification of questions above
3. Begin Phase 1
