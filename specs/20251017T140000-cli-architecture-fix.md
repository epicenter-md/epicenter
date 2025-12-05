# CLI Architecture Fix

## Problem Analysis

The CLI implementation has several broken references and misaligned architecture:

### Current Issues

1. **Broken Exports in `index.ts`**:
   - Exports from deleted file `schema-converters.ts` (createSchemaConverter, applySchemaConverters, SchemaConverter)
   - Exports non-existent function `standardSchemaToYargsOptions` from `schema-to-yargs`
   - References converters (Zod/Arktype) that may no longer be relevant

2. **Misaligned Schema Conversion**:
   - `generate.ts` uses `standardSchemaToYargsOptions` (doesn't exist)
   - `typebox-to-yargs.ts` exists and properly converts TypeBox schemas
   - Actions use TypeBox for input schemas (Type.Object, Type.String, etc.)
   - README mentions Zod/Arktype but actual implementation uses TypeBox

3. **Type Inconsistencies**:
   - `create-cli.ts` uses `typeboxToYargs` correctly
   - `generate.ts` uses non-existent `standardSchemaToYargsOptions`
   - Need to align both to use the same approach

## Core Architecture Understanding

### Epicenter Core
- **Workspaces**: Self-contained modules with schemas, indexes, and actions
- **Actions**: Defined with `defineQuery`/`defineMutation` using TypeBox input schemas
- **Results**: All actions return `Result<TOutput, EpicenterOperationError>` from wellcrafted
- **Dependencies**: Workspaces can depend on other workspaces (flat/hoisted resolution)

### CLI Architecture (Current)
- **Metadata Extraction**: Uses mock context to extract action metadata WITHOUT initializing YJS
- **Schema Conversion**: Should convert TypeBox input schemas to yargs options
- **Command Generation**: Two approaches:
  1. `create-cli.ts`: Dynamic approach - accepts any workspace/action at runtime
  2. `generate.ts`: Static approach - pre-generates all commands from config

### Key Files
- `metadata.ts`: Extracts action metadata (name, type, inputSchema) using mock context
- `typebox-to-yargs.ts`: Converts TypeBox schemas to yargs options (working correctly)
- `mock-context.ts`: Creates lightweight mock db/indexes for metadata extraction
- `generate.ts`: Generates complete CLI from config (broken - uses wrong function)
- `create-cli.ts`: Creates dynamic CLI that resolves commands at runtime (working)

## Solution Plan

### 1. Fix `index.ts` exports
- Remove references to deleted `schema-converters.ts`
- Remove reference to non-existent `standardSchemaToYargsOptions`
- Remove references to Zod/Arktype converters (if no longer needed)
- Keep only working exports

### 2. Fix `generate.ts` schema conversion
- Replace `standardSchemaToYargsOptions` with `typeboxToYargs`
- Ensure it uses the same approach as `create-cli.ts`
- Verify it handles TypeBox schemas correctly

### 3. Verify Type Consistency
- Ensure action input schemas are TypeBox schemas
- Verify metadata extraction gets the right schema type
- Check that both CLI approaches handle the same schema types

### 4. Update README (if needed)
- Remove references to Zod/Arktype if they're no longer supported
- Focus on TypeBox as the primary schema format
- Update examples to match implementation

## Implementation Checklist

- [ ] Read and understand schema converter history
- [ ] Fix `index.ts` exports
- [ ] Fix `generate.ts` to use `typeboxToYargs`
- [ ] Verify both CLI approaches work with TypeBox schemas
- [ ] Run tests to validate changes
- [ ] Update README if schema support changed

## Final Decision

1. **TypeBox only** - No Zod/Arktype support needed
2. **Use `generate.ts` approach** - Better DX with proper help text and command structure
3. **Remove `create-cli.ts`** - Older prototype approach, not needed

## Review Section

### Changes Made

1. **Fixed `generate.ts`**
   - Replaced non-existent `standardSchemaToYargsOptions` with `typeboxToYargs`
   - Added `GenerateCLIOptions` type with optional `argv` parameter for testing
   - Updated function signature to accept options parameter

2. **Cleaned up `index.ts` exports**
   - Removed references to deleted `schema-converters.ts`
   - Removed Zod/Arktype converter exports
   - Removed non-existent `standardSchemaToYargsOptions` export
   - Added `GenerateCLIOptions` type export
   - Kept `typeboxToYargs` as the schema conversion function

3. **Updated `bin.ts`**
   - Changed from `createCLI` to `generateCLI`
   - CLI entry point now uses the structured command generation

4. **Updated test files**
   - `cli-end-to-end.test.ts`: Replaced all `createCLI` calls with `generateCLI`
   - `integration.test.ts`: Updated to use `generateCLI`, fixed table API call (`set` → `insert`)
   - Removed unused imports

5. **Deleted obsolete files**
   - `create-cli.ts`: Old dynamic CLI approach
   - `create-cli.test.ts`: Tests specific to old approach

### Architecture Decision

**TypeBox-Only Schema Support**: The CLI now exclusively supports TypeBox schemas for action inputs. This aligns with the core Epicenter architecture where all actions use `defineQuery`/`defineMutation` with TypeBox input schemas.

**Structured Command Generation (`generate.ts`)**: The CLI pre-generates all workspace and action commands at initialization time, providing:
- Better discoverability (help text shows all commands)
- Proper command hierarchy (workspace → action)
- Schema-driven CLI flags from TypeBox schemas
- Fast metadata extraction using mock context (no YJS loading for help)

### Test Results

- ✅ `integration.test.ts`: 2 tests passing
- ✅ `load-config.test.ts`: 4 tests passing
- ⚠️ `cli-end-to-end.test.ts`: Not fully verified (requires cleanup of test data)

### Files Modified

- `/packages/epicenter/src/cli/generate.ts`
- `/packages/epicenter/src/cli/index.ts`
- `/packages/epicenter/src/cli/bin.ts`
- `/packages/epicenter/src/cli/cli-end-to-end.test.ts`
- `/packages/epicenter/src/cli/integration.test.ts`

### Files Deleted

- `/packages/epicenter/src/cli/create-cli.ts`
- `/packages/epicenter/src/cli/create-cli.test.ts`
