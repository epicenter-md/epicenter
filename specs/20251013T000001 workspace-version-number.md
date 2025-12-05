# Workspace Version Type Change: String to Number

## Problem

Currently, workspace versions are typed as `string` but treated as integers everywhere in the code:
- The comparison logic uses `parseInt(ws.version, 10)` to compare versions
- Documentation examples show simple numeric strings like `'1'`, `'2'`, `'3'`
- The type system lies: it says string but we always parse as int

This creates unnecessary ceremony and a type mismatch between declaration and usage.

## Why Numbers Are Better

For workspace configurations:
1. **Users are hobbyists**: They don't need semver complexity
2. **Every change is breaking**: Workspace configs typically change structure fundamentally
3. **Simpler mental model**: Just increment: 1 → 2 → 3 → 4
4. **Type honesty**: Code and types match actual usage
5. **Less ceremony**: No more parseInt calls

## Changes

### Type Definition Changes

**File: `packages/epicenter/src/core/workspace/config.ts`**

- [ ] Change generic parameter: `TVersion extends string` → `TVersion extends number` (line 89)
- [ ] Change default type: `TVersion extends string = string` → `TVersion extends number = number` (line 144)
- [ ] Update validation: `typeof workspace.version !== 'string'` → `typeof workspace.version !== 'number'` (line 112)
- [ ] Update error message: "valid string version" → "valid number version" (line 113)
- [ ] Update JSDoc example: `@example '1', '2', '1.0.0', '2.0.0'` → `@example 1, 2, 3, 4` (line 164)
- [ ] Update code example: `version: '1',` → `version: 1,` (line 35)

### Runtime Changes

**File: `packages/epicenter/src/core/workspace/client.ts`**

- [ ] Remove parseInt calls (lines 160-161):
  ```typescript
  // Before:
  const wsVersion = parseInt(ws.version, 10);
  const existingVersion = parseInt(existing.version, 10);

  // After:
  const wsVersion = ws.version;
  const existingVersion = existing.version;
  ```

### Test Data Changes

**File: `packages/epicenter/src/core/workspace.test.ts`**
- [ ] Change all `version: '1'` → `version: 1`
- [ ] Change all `version: '3'` → `version: 3`

**File: `packages/epicenter/src/core/epicenter.test.ts`**
- [ ] Change all `version: '1'` → `version: 1`

**File: `packages/epicenter/src/core/epicenter.ts`**
- [ ] Change `version: '1'` → `version: 1`

## Verification

After changes:
- [ ] Run tests: `bun test`
- [ ] Verify no TypeScript errors
- [ ] Check that version comparison logic still works correctly

## Review

All changes completed successfully:

### Files Changed
1. **config.ts**: Updated type definitions, validation, JSDoc, and examples
2. **client.ts**: Removed parseInt calls (versions are already numbers)
3. **workspace.test.ts**: Updated all test data (10 instances)
4. **epicenter.test.ts**: Updated test data (2 instances)
5. **epicenter.ts**: Updated composite workspace definition (1 instance)

### Key Changes
- Changed `TVersion extends string` to `TVersion extends number` in all type definitions
- Updated validation from `typeof workspace.version !== 'string'` to `typeof workspace.version !== 'number'`
- Removed unnecessary `parseInt` calls in version comparison logic
- Updated JSDoc to clarify version resolution behavior (highest version wins)
- Changed all test data from `version: '1'` to `version: 1`

### Test Results
- All workspace and epicenter tests pass
- No TypeScript errors related to version changes
- Type system now matches actual runtime behavior

### Benefits
- **Type honesty**: Type system matches implementation
- **Simpler API**: Users just increment numbers (1 → 2 → 3)
- **No ceremony**: No more parseInt calls
- **Clearer semantics**: Numbers make it obvious every change is breaking
