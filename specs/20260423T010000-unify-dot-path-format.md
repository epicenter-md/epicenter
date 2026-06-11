# Unify CLI and RPC Dot-Path Format

**Date**: 2026-04-23
**Status**: shipped (commit `ba95256`)
**Author**: AI-assisted

## Overview

Today the CLI addresses actions as `exportName.namespace.action` (walks into `epicenter.config.ts` exports first), while RPC addresses them as `namespace.action`. Unify both on the RPC form: CLI drops the leading `exportName` prefix; dispatch uses the config's single root entry implicitly.

## Motivation

### Current State

```bash
# CLI: path includes the entry export name from epicenter.config.ts
epicenter run tabManager.tabs.close --tab-ids 1 2 3
```

```ts
// RPC: path is just action-relative
await ws.peer(id).actions.tabs.close({ tabIds: [1, 2, 3] })
```

The `tabManager` prefix comes from `packages/cli/src/commands/run.ts:67`:

```ts
const exportName = segments[0]!       // required: resolve into epicenter.config exports
const entry = entries.find((e) => e.name === exportName)
const resolved = resolvePath(entry.handle, segments.slice(1))
```

### Problems

1. **Two address formats for the same thing.** Documentation, script examples, and AI-tool prompts have to pick one and translate.
2. **CLI paths aren't portable.** A script calling `ws.peer(id).actions.tabs.close(...)` and a CLI user invoking the same action have to know about the export-name prefix difference.
3. **The export name is a CLI-layer implementation detail** (how we find the handle in a user's config). Leaking it into the action address conflates "which config entry" with "which action."

### Desired State

```bash
# Single-entry config (the common case): no prefix needed
epicenter run tabs.close --tab-ids 1 2 3

# Multi-entry config: disambiguate with --workspace, not the path
epicenter run tabs.close --workspace tabManager --tab-ids 1 2 3
```

CLI path format matches RPC path format exactly. Entry selection is a CLI concern, handled by an explicit flag when ambiguous.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Path format | `namespace.action` | Matches RPC exactly. |
| Single-entry inference | Auto-select the lone config entry | Common case for single-app configs. No ambiguity. |
| Multi-entry disambiguation | `--workspace <name>` flag | Explicit, fails fast on ambiguity. |
| Multi-entry with no flag | Error with list of available entries | Never pick silently. |
| Backwards compat | None | Clean break; short grace period in a release note. |

## Implementation Plan

- [x] **1** Update `packages/cli/src/commands/run.ts` so `segments[0]` is no longer consumed as export name.
- [x] **2** Auto-select when `entries.length === 1`. Error when `> 1` and no `--workspace` flag.
- [x] **3** Add `--workspace <name>` option (per-command, matching `--dir`/`-C` convention: not global).
- [x] **4** Update CLI tests and examples.
- [ ] **5** Update docs in `apps/*/README.md` and any example scripts.

## Edge Cases

1. **Two entries, no flag**: error: "Specify `--workspace <name>`. Available: tabManager, fuji."
2. **Flag with unknown name**: error: "No workspace 'foo'. Available: tabManager, fuji."
3. **Flag with single-entry config**: flag is redundant but accepted; doesn't conflict.

## Success Criteria

- [ ] `epicenter run tabs.close` works in a single-entry config.
- [ ] `epicenter run tabs.close --workspace tabManager` works in a multi-entry config.
- [ ] Path strings are identical between CLI, RPC, and AI tool prompts.
- [ ] README examples updated.

## References

- `packages/cli/src/commands/run.ts:60-76`: current entry resolution
- `specs/20260422T234500-unified-action-invocation.md`: prerequisite (Phase 1 consolidates the resolver)
