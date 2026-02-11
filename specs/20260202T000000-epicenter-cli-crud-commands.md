# Epicenter CLI Architecture Plan

**Date**: 2026-02-02
**Status**: 🚧 Partially Implemented
**Related**: `20260202T100000-single-workspace-simplification.md`

## Implementation Status

### ✅ Completed

1. **Static TableHelper `update()` method** - Added fetch-merge-set logic to `table-helper.ts`
2. **Command factories** - Implemented `buildTableCommands()`, `buildKvCommands()`, and `buildMetaCommands()`
3. **Input parsing** - Added `parse-input.ts` with JSON/file/stdin support
4. **Output formatting** - Added `format-output.ts` with TTY detection
5. **CLI integration** - Commands registered in `cli.ts`
6. **Single workspace mode** - Simplified to single client architecture (see related spec)

### 🚧 In Progress / Future Work

1. **Dynamic table support** - Currently only static tables implemented
2. **Batch operations** - `set-many`, `delete-many` not yet implemented
3. **Advanced update features** - `--patch` flag for complex nested updates
4. **Table output formatting** - Using JSON, could add `cli-table3` for better display
5. **Testing** - Unit tests for command handlers

### 📝 Architecture Changes

The original plan assumed multi-workspace support. The actual implementation uses:
- Single workspace per config (see `20260202T100000-single-workspace-simplification.md`)
- `-C`/`--dir` flag for multiple workspaces in subdirectories
- Default export convention: `export default createWorkspaceClient({...})`

## Overview

Transform the Epicenter CLI from a simple server launcher into a comprehensive workspace management tool with:
- ~~Automatic single/multi workspace detection~~ → Single workspace per config with `-C` flag
- CRUD commands for tables and KV stores ✅
- Multiple input methods (inline JSON, files, stdin, property flags) ✅
- TTY-aware output formatting ✅

**Scope**: Start with static tables, then extend to dynamic tables.

## Design Decisions

### 1. Config File: Keep `epicenter.config.ts`
Matches ecosystem conventions (vite.config.ts, drizzle.config.ts). Clear intent.

### 2. Export Pattern: Named Exports Only
```typescript
// Single workspace
export const blog = createWorkspaceClient({...});

// Multiple workspaces
export const blog = createWorkspaceClient({...});
export const shop = createWorkspaceClient({...});
```

Auto-detect mode based on number of WorkspaceClient exports found.

### 3. Command Structure: Automatic Mode Detection

**Single workspace mode:**
```bash
epicenter posts list
epicenter posts get abc123
epicenter posts set '{"id":"1","title":"Hello"}'
epicenter posts update abc123 --title "New"
epicenter kv set theme dark
epicenter serve
```

**Multiple workspace mode:**
```bash
epicenter blog posts list
epicenter blog posts get abc123
epicenter shop products set @product.json
epicenter serve
```

### 4. Reserved Commands
Cannot be workspace names: `serve`, `tables`, `workspaces`, `kv`, `help`, `version`, `init`

**Table name collisions**: If a table is named `tables` or `kv`, the reserved command wins. Document this limitation. Users should avoid naming tables after reserved commands.

### 5. Table Commands

| Command | Description | Static | Dynamic |
|---------|-------------|--------|---------|
| `list` | List valid rows | `getAllValid()` | `getAllValid()` |
| `list --all` | Include invalid | `getAll()` | `getAll()` |
| `get <id>` | Get by ID | `get(id)` | `get(id)` |
| `set <json>` | Upsert full row | `set(row)` | `upsert(row)` |
| `set-many <json>` | Bulk upsert | batch | `upsertMany()` |
| `update <id> --flags` | Partial update | `update()` (new) | `update()` |
| `delete <id>` | Delete row | `delete(id)` | `delete(id)` |
| `delete-many <ids>` | Bulk delete | batch | `deleteMany()` |
| `clear` | Clear table | `clear()` | `clear()` |
| `count` | Count rows | `count()` | `count()` |

### 6. Update Command Design (Flag-Based)

Following [gh CLI patterns](https://cli.github.com/manual/gh_issue_edit) and [CLIG best practices](https://clig.dev/):

```bash
# Single field update
epicenter posts update abc123 --title "New Title"

# Multiple field update
epicenter posts update abc123 --title "New" --status published

# JSON fallback for complex nested data
epicenter posts update abc123 --patch '{"tags":["a","b"]}'
```

**Why flags over positionals:**
- Discoverable via `--help`
- Order-independent
- Scriptable
- Industry standard (gh, Heroku, kubectl)

### 7. Static Table `update()` Method (NEW)

Add `update(id, partial)` to static TableHelper:

```typescript
update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow> {
  const current = this.get(id);
  if (current.status !== 'valid') {
    return { status: current.status };
  }
  const merged = { ...current.row, ...partial };
  this.set(merged);
  return { status: 'updated', row: merged };
}
```

**Rationale**: Fetch-merge-set is a common pattern that belongs in the library, not CLI.

### 8. KV Commands
```bash
epicenter kv list
epicenter kv get <key>
epicenter kv set <key> <value>
epicenter kv reset <key>
```

### 9. JSON Input Methods
1. **Inline**: `epicenter posts set '{"id":"1"}'`
2. **File**: `epicenter posts set --file row.json` or `epicenter posts set @row.json`
3. **Stdin**: `cat row.json | epicenter posts set`
4. **Property flags** (update): `epicenter posts update abc123 --title "New"`

### 10. Output Formats
- **TTY (interactive)**: JSON pretty-print (simplest)
- **Pipe (non-TTY)**: JSON compact
- **Override**: `--format json|jsonl`

Keep it simple for now. Can add `cli-table3` for table formatting later if needed.

---

## Implementation Plan

### Phase 1: Static TableHelper `update()` Method
**File:** `packages/epicenter/src/static/table-helper.ts`

1. Add `update(id, partial)` method with fetch-merge-set logic
2. Add `UpdateResult` type to `types.ts`
3. Add `count()` method if not present
4. Add tests for new methods

### Phase 2: Discovery Mode Detection
**File:** `packages/epicenter/src/cli/discovery.ts`

1. Modify `loadClients()` to return `{ clients, mode: 'single' | 'multi' }`
2. Accept single client export (not just array)
3. Determine mode: single if 1 client, multi if >1

### Phase 3: CLI Command Structure
**File:** `packages/epicenter/src/cli/cli.ts`

1. Pass mode to command builder
2. Single mode: `<table> <command>` structure
3. Multi mode: `<workspace> <table> <command>` structure
4. Add reserved command detection

### Phase 4: Table Commands Factory
**New file:** `packages/epicenter/src/cli/commands/table-commands.ts`

1. Create `buildTableCommands(client, mode)` function
2. Generate commands for each table in workspace
3. Commands: `list`, `get`, `set`, `update`, `delete`, `clear`, `count`
4. Generate `--field` flags from table schema for `update` command
5. Support `--patch` JSON fallback for complex updates

### Phase 5: KV Commands Factory
**New file:** `packages/epicenter/src/cli/commands/kv-commands.ts`

1. Create `buildKvCommands(client, mode)` function
2. Commands: `list`, `get`, `set`, `reset`

### Phase 6: Input Parsing
**New file:** `packages/epicenter/src/cli/input/parse-input.ts`

1. Priority: positional JSON > `--file` > `@file` > stdin
2. Property flag extraction for `update` command
3. JSON parsing with helpful error messages

### Phase 7: Output Formatting
**New file:** `packages/epicenter/src/cli/output/format.ts`

1. TTY detection for pretty vs compact JSON
2. JSON/JSONL formatters
3. `--format` flag handler
4. (Future: add cli-table3 for table formatting)

### Phase 8: Meta Commands
1. `epicenter tables` - list table names
2. `epicenter workspaces` - list workspaces (multi mode only)

---

## File Structure

```
packages/epicenter/src/cli/
├── bin.ts                      # Entry point (existing)
├── cli.ts                      # CLI factory (modify)
├── discovery.ts                # Config loading (modify)
├── command-builder.ts          # Action commands (existing)
├── commands/
│   ├── serve.ts                # Server command (extract)
│   ├── table-commands.ts       # Table CRUD factory (new)
│   ├── kv-commands.ts          # KV CRUD factory (new)
│   └── meta-commands.ts        # tables, workspaces (new)
├── input/
│   └── parse-input.ts          # JSON/file/stdin parsing (new)
├── output/
│   └── format.ts               # JSON formatting (new)
└── index.ts                    # Public exports
```

---

## Critical Files to Modify

1. **`packages/epicenter/src/static/table-helper.ts`** - Add `update()` and `count()` methods
2. **`packages/epicenter/src/static/types.ts`** - Add `UpdateResult` type
3. **`packages/epicenter/src/cli/discovery.ts`** - Add mode detection, support single export
4. **`packages/epicenter/src/cli/cli.ts`** - Restructure for table/KV commands

---

## Verification Plan

1. **Unit tests for static TableHelper**:
   - `update()` merges partial data correctly
   - `update()` returns `not_found` for missing rows
   - `count()` returns correct count

2. **CLI integration tests**:
   - `epicenter tables` lists all table names
   - `epicenter <table> list` returns rows as JSON
   - `epicenter <table> set '{"id":"1",...}'` creates row
   - `epicenter <table> get <id>` retrieves row
   - `epicenter <table> update <id> --field value` updates row
   - `epicenter <table> delete <id>` removes row
   - `epicenter kv list/get/set` works

3. **Multi-workspace test**:
   - Config with 2 workspaces
   - `epicenter blog posts list` vs `epicenter shop products list`

---

## Example Usage

```bash
# List all tables
epicenter tables
# Output: posts, comments, users

# List rows in posts table
epicenter posts list
# Output: [{"id":"1","title":"Hello"},{"id":"2","title":"World"}]

# Get specific row
epicenter posts get 1
# Output: {"id":"1","title":"Hello","body":"..."}

# Create/replace row (full row required)
epicenter posts set '{"id":"3","title":"New Post","body":"Content"}'

# Partial update (only specified fields changed)
epicenter posts update 1 --title "Updated Title"
epicenter posts update 1 --title "New" --status published

# Delete row
epicenter posts delete 1

# KV operations
epicenter kv list
epicenter kv get theme
epicenter kv set theme dark
```
