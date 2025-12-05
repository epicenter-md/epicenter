# Migration Plan: Replace DateWithTimezone Objects with DateWithTimezoneString in YJS Maps

**Timestamp**: 20251101T000000
**Status**: Planning
**Priority**: Medium
**Impact**: Schema storage optimization, reduced CRDT overhead

## Problem Statement

Currently, `DateWithTimezone` objects (with `date` and `timezone` properties) are stored directly in YJS maps. This creates several inefficiencies:

1. **CRDT Overhead**: YJS tracks each field separately; two fields = double tracking overhead
2. **Sync Size**: Objects take more bytes to serialize and sync across clients
3. **Atomicity Issues**: Concurrent edits could create inconsistent states (date updates from user A, timezone from user B)
4. **Schema Complexity**: Unnecessary complexity for what should be a simple value

**Solution**: Store `DateWithTimezoneString` (atomic string format: `"2024-01-01T20:00:00.000Z|America/New_York"`) in YJS. Parse to `DateWithTimezone` objects only when needed on the client side.

## Current Implementation Map

### Type Definitions (schema.ts)
- **DateWithTimezone** (lines 60-64): Runtime object with `date`, `timezone`, and `toJSON()`
- **DateWithTimezoneString** (lines 814-815): Branded type for string format
- **Factory**: `DateWithTimezone()` (lines 97-111) creates the object
- **Parser**: `DateWithTimezoneFromString()` (lines 157-169) parses string back to object
- **Validators**:
  - `isDateWithTimezone()` (lines 69-80)
  - `isDateWithTimezoneString()` (lines 133-141)

### Schema Validation (schema.ts)
- `DateColumnSchema` (lines 230-234): Defaults use `DateWithTimezone` objects
- Validation methods:
  - `validateRow()` (uses `isDateWithTimezone`)
  - `validateYRow()` (uses `isDateWithTimezone`)
  - `validateSerializedRow()` (uses `isDateWithTimezoneString`)

### YJS Integration (utils/yjs.ts)
- `updateYRowFromSerializedRow()` (lines 235-241): Converts serialized format to YJS
  - Currently creates `DateWithTimezone` objects from strings
  - Should store strings directly instead

### Database Integration (builders.ts, schema-converter.ts)
- Custom Drizzle type with TEXT storage
- Automatic conversion: `.toJSON()` for writes, `DateWithTimezoneFromString()` for reads

## Detailed Scope

### Phase 1: Identify All Usage Sites
**Files to Search**:
- `/packages/epicenter/src/core/schema.ts` - Schema definitions
- `/packages/epicenter/src/utils/yjs.ts` - YJS conversion
- `/packages/epicenter/src/db/schema-converter.ts` - Database schema conversion
- `/packages/epicenter/src/db/indexes/sqlite/builders.ts` - Database builders
- Any files with conditional checks: `if (col.type === "date")` or similar
- Any files storing/reading from YJS maps

**Search Patterns**:
- `dateWithTimezone` (variable/function names)
- `isDateWithTimezone` (type guards)
- `DateColumnSchema`
- String literals: `'date'` and `"date"` in conditional expressions
- `.toJSON()` calls related to dates
- `DateWithTimezoneFromString` usage

### Phase 2: Update Schema Builders
**What**: The `date()` builder function should configure schemas differently for YJS vs serialized storage
**Current**: Stores `DateWithTimezone` objects in both contexts
**Target**:
- YJS: Store `DateWithTimezoneString`
- Serialized: Keep `DateWithTimezoneString` (no change needed)
- Runtime: Parse to `DateWithTimezone` only when needed

### Phase 3: Update Validation Methods
**Methods to Update**:
1. `validateRow()` (lines ~1450): Check what it currently does for dates
2. `validateYRow()` (lines ~1500): Should validate `DateWithTimezoneString` instead of `DateWithTimezone`
3. `validateSerializedRow()` (lines ~1550): Already validates strings, may need minor updates

**Pattern**:
- Replace `isDateWithTimezone(value)` checks with `isDateWithTimezoneString(value)` in YJS contexts
- Keep `isDateWithTimezone()` for client-side runtime validation only

### Phase 4: Update YJS Conversion Utils
**File**: `/packages/epicenter/src/utils/yjs.ts`
**Function**: `updateYRowFromSerializedRow()` (lines 235-241)

**Current Flow**:
```
Serialized string → DateWithTimezoneFromString() → DateWithTimezone object → Store in Y.Map
```

**New Flow**:
```
Serialized string → Store directly in Y.Map
```

**Impact**: Remove the conversion step entirely for dates; store strings as-is.

### Phase 5: Update Database Builders
**File**: `/packages/epicenter/src/db/indexes/sqlite/builders.ts`
**Section**: Custom Drizzle type for dates (lines 234-243)

**Current**: Creates `DateWithTimezone` objects on read
**New**: Keep as-is for database layer (this is fine for database); client code parses on demand

### Phase 6: Update All Type Guard Checks
**Search for**:
- `isDateWithTimezone(value)` calls
- Replace with `isDateWithTimezoneString(value)` in YJS contexts
- Keep `isDateWithTimezone(value)` in client/UI contexts where you need the object

**Conditional Patterns**:
- `if (col.type === 'date')` - check if this needs updated logic
- `if (schema.type === 'date')` - same

### Phase 7: Remove/Update Exports
**Consider**:
- Remove `DateWithTimezone` export if it's only used for YJS (but keep if used in UI)
- Keep `DateWithTimezoneFromString()` - clients need to parse strings to objects
- Keep both validators - different contexts use different types

## Implementation Strategy

### Step 1: Create Plan (THIS DOCUMENT)
- Define scope and impact
- Identify all change sites
- Get user approval

### Step 2: Search & Document
- Run comprehensive search for all usage sites
- Document exact line numbers
- Categorize changes (schema, validation, utils, etc.)

### Step 3: Update Core Schema (schema.ts)
1. Update `validateYRow()` to use `isDateWithTimezoneString` for date columns
2. Update `DateColumnSchema` if it stores defaults
3. Keep factory functions and validators as-is

### Step 4: Update YJS Utils (utils/yjs.ts)
1. Change `updateYRowFromSerializedRow()` to store strings directly instead of converting

### Step 5: Test & Verify
1. Run existing tests
2. Verify serialization/deserialization still works
3. Check that parsing on client side works

### Step 6: Update Documentation
1. Update JSDoc comments
2. Add note about string storage in YJS
3. Document that client code should parse strings to objects as needed

## Todo Checklist

- [ ] **Research & Document**: Read schema.ts thoroughly, identify all sites
- [ ] **Create comprehensive search results**: Find all usage patterns
- [ ] **Review with user**: Confirm approach before implementation
- [ ] **Update validateYRow()**: Change type guard to use `isDateWithTimezoneString`
- [ ] **Update updateYRowFromSerializedRow()**: Store strings directly
- [ ] **Update any conditional checks**: Replace `isDateWithTimezone` with `isDateWithTimezoneString` in YJS contexts
- [ ] **Verify database integration**: Ensure database layer still works
- [ ] **Run tests**: Ensure nothing breaks
- [ ] **Update JSDoc comments**: Reflect new behavior
- [ ] **Final validation**: Spot-check all modified files

## Risk Assessment

**Low Risk**:
- String storage is already the serialized format
- Parser already exists to convert back
- YJS doesn't care about object structure

**Potential Issues**:
- Any code assuming `DateWithTimezone` objects in YJS will break
- Type checking might flag issues (good; catch bugs early)
- Database layer works differently (but that's okay; database stores strings too)

## Success Criteria

1. All YJS date columns store `DateWithTimezoneString` instead of objects
2. Validation passes with new string format
3. Client code can parse strings to objects when needed
4. No runtime errors
5. Tests pass
6. CRDT size reduced (fewer tracked fields per date)

## Files to Modify

1. `/packages/epicenter/src/core/schema.ts` - Main changes
2. `/packages/epicenter/src/utils/yjs.ts` - Conversion logic
3. Any test files that validate dates
4. Any files that construct `DateWithTimezone` objects for YJS storage

## Notes

- The `DateWithTimezone` object will still be useful for UI/client code
- This change is about *storage* in YJS, not about removing the utility
- Database layer can stay mostly unchanged (it already stores strings in TEXT columns)
- The `.toJSON()` method on `DateWithTimezone` is specifically for serialization; objects won't exist in YJS anymore

---

## Review Section

**Status**: COMPLETED
**Merge Strategy**: Ready for main

### Summary of Changes

Successfully migrated YJS date storage from `DateWithTimezone` objects to `DateWithTimezoneString` (atomic strings). This reduces CRDT overhead and eliminates potential inconsistency issues from concurrent edits.

### Files Modified

1. **`packages/epicenter/src/core/schema.ts`**:
   - Updated `CellValue<DateColumnSchema>` type to return `DateWithTimezoneString` instead of `DateWithTimezone` objects (lines 407-410)
   - Updated `validateYRow()` method to use `isDateWithTimezoneString()` instead of `isDateWithTimezone()` for validation (line 1416)
   - Updated `validateRow()` method similarly for consistency (line 743)
   - Removed dead code in `serializeCellValue()` - now strings are returned as-is (lines 938-939)
   - Updated JSDoc comments on `CellValue` type and `serializeCellValue()` function to reflect new behavior

2. **`packages/epicenter/src/utils/yjs.ts`**:
   - Updated `updateYRowFromSerializedRow()` to store `DateWithTimezoneString` directly instead of converting to `DateWithTimezone` objects (lines 239-240)
   - Removed the `DateWithTimezoneFromString()` conversion step for date columns

3. **`packages/epicenter/src/core/schema.test.ts`**:
   - Updated "validates date types" test to store and expect string format instead of object format (lines 258-278)

### Impact

**Positive Outcomes**:
- CRDT reduces tracking overhead - now one field per date instead of two (date + timezone)
- Atomic storage - eliminates risk of inconsistent partial updates from concurrent edits
- Smaller sync messages and network traffic
- Type system now accurately reflects what's stored in YJS (strings, not objects)

**Type Safety**:
- Type errors caught immediately by TypeScript
- `CellValue` type now correctly describes what's in YJS for dates
- All validations use appropriate type guards for strings

**Compatibility**:
- Database layer unchanged - still stores strings in TEXT columns
- Serialization to/from client still works - no changes needed
- Backwards compatible data format (string format unchanged)

### Test Results

- Date validation test passes with new string storage
- No regressions in other tests
- Migration is backwards compatible with existing data format

### Implementation Details

The migration follow a simple pattern:

1. **Client receives**: `DateWithTimezoneString` from database/sync
2. **Stores in YJS**: String directly (no conversion)
3. **On read**: Applications parse string to `DateWithTimezone` object if needed
4. **Validation**: Checks for string format using `isDateWithTimezoneString()`

This cleanly separates storage format (strings in YJS) from runtime format (objects in application code).

### Future Considerations

- `DateWithTimezone` objects can still be created by application code - useful for client-side operations
- `DateWithTimezoneFromString()` remains available for parsing
- No need to remove `DateWithTimezone` type or factory function - still valuable for non-storage contexts
