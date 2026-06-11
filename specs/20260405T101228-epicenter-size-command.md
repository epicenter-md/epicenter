# `epicenter size` CLI Command

**Date**: 2026-04-05
**Status**: Implemented
**Author**: AI-assisted

## Overview

Add an `epicenter size` command that reports the encoded byte size and per-table row counts for every workspace in an `epicenter.config.ts`. Useful for debugging bloat, monitoring growth, and general diagnostics.

## Motivation

### Current State

The workspace client exposes `encodedSize()` which returns the full Y.Doc byte count:

```typescript
// packages/workspace/src/workspace/create-workspace.ts:323-325
encodedSize(): number {
    return Y.encodeStateAsUpdate(ydoc).byteLength;
},
```

Per-table row counts are available via `table.count()`. But there's no CLI surface to access either. The only way to check workspace size today is to write a throwaway script or run one of the benchmark scripts in `packages/workspace/scripts/`.

### Problems

1. **No terminal-level diagnostics**: Can't quickly check if a workspace is bloating without writing code.
2. **Multi-workspace blind spot**: If a config exports multiple workspaces, there's no way to compare their sizes at a glance.

### Desired State

```bash
$ epicenter size

blog (14.2 KB)
  posts        12 rows
  comments     47 rows
  tags          5 rows

shop (8.7 KB)
  products     23 rows
  orders       91 rows
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Show all workspaces by default | Yes | The whole point is "each client's size": filtering to one defeats the purpose. Use `--workspace` to narrow. |
| Don't use `runCommand` helper | Custom handler using `loadConfig` directly | `runCommand` resolves to a single client. We need to iterate all clients. |
| Human-readable default output | Custom formatting (not JSON) | `output()` only does JSON. A human-readable table with formatted byte sizes is more useful for quick checks. |
| Per-table byte size | Not available: show row counts instead | Yjs stores all tables in a single `Y.Doc`. There's no per-table byte measurement without deep Yjs internals. Row counts via `table.count()` are the next best thing. |
| `--format json` support | Yes | Machine-readable output for scripting. Raw byte counts, not formatted strings. |

## Architecture

```
epicenter size [--workspace <id>] [--dir <path>] [--format json]
        │
        ▼
  loadConfig(dir)
        │
        ▼
  clients: AnyWorkspaceClient[]
        │
        ├── (filter by --workspace if provided)
        │
        ▼
  for each client:
    ├── await client.whenReady
    ├── client.encodedSize()  →  total bytes
    ├── Object.keys(client.definitions.tables)
    │     └── client.tables[name].count()  →  row count per table
    └── format and print
        │
        ▼
  dispose all clients
```

### Human-readable output format

```
<workspace-id> (<formatted-size>)
  <table-name>  <padded-count> rows

<workspace-id> (<formatted-size>)
  <table-name>  <padded-count> rows
```

Row counts are right-aligned. Workspaces separated by blank lines.

### JSON output format

```json
[
  {
    "id": "blog",
    "encodedSize": 14532,
    "tables": {
      "posts": { "rows": 12 },
      "comments": { "rows": 47 }
    }
  }
]
```

## Implementation Plan

### Phase 1: Create the command (single wave)

- [x] **1.1** Create `packages/cli/src/commands/size.ts` with `sizeCommand` export
- [x] **1.2** Register `sizeCommand` in `packages/cli/src/cli.ts`
- [x] **1.3** Update `packages/cli/src/README.md` with `epicenter size` documentation
- [x] **1.4** Verify with type-check (`bun run tsc --noEmit` in packages/cli or equivalent)
  > **Note**: `tsc --noEmit` shows pre-existing errors (missing Bun/node type declarations). No new errors from size command. LSP diagnostics clean except `argv: any` which matches all existing commands.

## Edge Cases

### No workspaces in config

1. `loadConfig()` already throws `No workspace clients found in epicenter.config.ts` with a helpful hint.
2. No special handling needed: the error propagates naturally.

### Single workspace with `--workspace` flag

1. Works fine: `--workspace` filters to the matching one.
2. If the ID doesn't match, print an error listing available IDs (same pattern as `resolveWorkspace`).

### Workspace with no tables

1. Print the workspace ID and encoded size.
2. Print nothing under it (no table lines). This is a valid state.

### Workspace with encrypted tables

1. `table.count()` returns `ykv.decryptedSize`: this may be 0 if encryption keys haven't been applied.
2. Acceptable: the total `encodedSize()` still reflects the real Y.Doc size.

## Success Criteria

- [x] `epicenter size` prints all workspaces with encoded size and per-table row counts
- [x] `epicenter size -w <id>` filters to one workspace
- [x] `epicenter size --format json` outputs machine-readable JSON
- [x] `epicenter size -C <dir>` works from a different directory
- [x] Type-check passes (no new errors introduced)
- [x] No new dependencies added

## References

- `packages/cli/src/commands/describe.ts`: Simplest existing command to use as template
- `packages/cli/src/util/command.ts`: `defineCommand`, `withWorkspaceOptions`, `loadConfig` import, error handling patterns
- `packages/cli/src/load-config.ts`: `loadConfig()` for getting all clients
- `packages/cli/src/util/format-output.ts`: `output()`, `outputError()`, `formatYargsOptions()`
- `packages/cli/src/cli.ts`: Registration point (`.command(sizeCommand)`)
- `packages/cli/src/commands/data.ts`: Pattern for iterating tables (`exportCommand`)
- `packages/workspace/src/workspace/create-workspace.ts:323-325`: `encodedSize()` implementation

## Review

**Completed**: 2026-04-05

### Summary

Added `epicenter size` command that reports encoded byte size and per-table row counts for all workspaces in an `epicenter.config.ts`. Three files changed: one new (`size.ts`), two modified (`cli.ts`, `README.md`). Implementation follows established command patterns exactly. Same error handling, same dispose pattern, same option flags.

### Deviations from Spec

None. Implementation matches the spec exactly.

### Follow-up Work

- None identified.
