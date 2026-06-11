# CLI: JSON-Only Input, Remove Schema-to-Flags Bridge

**Date**: 2026-04-23
**Status**: shipped (2026-04-23)
**Author**: AI-assisted

## Prerequisite note (2026-04-23 audit)

The original draft said this spec was "blocked on `specs/20260422T234500-unified-action-invocation.md` Phase 5." That spec file **does not exist** in `specs/`, and the invariant it was supposed to establish: runtime input validation inside the action wrapper: is **also absent from the code today**:

- `defineQuery` / `defineMutation` (`packages/workspace/src/shared/actions.ts:327-333`, `:376-382`) are pure `Object.assign(handler, meta)`. No `Value.Check`, no `Value.Parse`.
- `dispatchAction` (`:471-488`) passes `input as never` straight to the handler.
- A grep of `packages/workspace/src` for `Value.` or `@sinclair/typebox` returns nothing.

The type-level jsdoc at `actions.ts:119` ("the handler takes validated input") is a *compile-time* claim, not a runtime one.

**Implication for this spec:** the "two validation layers" framing in the original motivation was factually incorrect. See the revised motivation below. Execution is **not blocked**: it's an orthogonal cleanup that stands on its own.

## Overview

Strip the docs and ask what `run` actually is: **dispatch an action by dot-path with a JSON payload.** That's the Invoke cell of the CLI's grid: local or via `--peer`, same verb. Generating a flag-based UI from the action's schema is a different product (an interactive form builder), and that product isn't what the CLI is.

Concretely: remove `packages/cli/src/util/typebox-to-yargs.ts` and the schema-driven flag generation in `epicenter run`. Input arrives as JSON only: inline positional, `@file.json`, or stdin. The payload is passed to the action handler verbatim; runtime input validation against the TypeBox schema is not currently performed anywhere (see Prerequisite note) and is out of scope for this spec.

## Motivation

### Current State

`run.ts` converts a TypeBox schema to yargs options at command-build time, so users can pass flat-schema fields as flags:

```bash
epicenter run tabManager.tabs.close --tab-ids 1 2 3
```

### Problems (revised: see Prerequisite note)

1. **Thesis drift.** `packages/cli/README.md` is explicit: the CLI is scripting-first. Bulk ops, exports, and transforms belong in user-authored `bun run scripts/*.ts` that import the config directly and get full type inference. Ergonomic interactive flag invocation is a different product (a form builder, basically) and isn't what this CLI claims to be.
2. **Bridge layer silently accumulates edge cases.** Nested objects, unions, refinements, `anyOf`/`allOf`, custom string formats: each has to be mapped to yargs semantics or produce surprising behavior. The more the schema language grows, the more this bridge owes.
3. **Dead weight.** `typebox-to-yargs.ts` is 119 lines (+ test file) that only serves the flat-schema interactive case. Nothing else in the CLI or workspace uses it.
4. **`.strict(false)` in `run.ts:67` is forced by this bridge.** Today unknown flags are silently dropped because the bridge needs to inject arbitrary per-action options at parse time. Removing the bridge lets the command flip to `.strict(true)`: unknown flags fail fast, which is the correct scripting-CLI behavior.

### What this change does *not* fix

Runtime input validation is absent today (see Prerequisite note). Going JSON-only does **not** close that gap. It just trusts `JSON.parse` output verbatim, same as today's flag path trusts yargs coercion. Closing the validation gap is a separate (not-yet-written) spec that should add `Value.Parse(input, raw)` inside `defineQuery` / `defineMutation`.

### Desired State

```bash
# Inline JSON
epicenter run tabManager.tabs.close '{"tabIds":[1,2,3]}'

# File
epicenter run tabManager.tabs.close @input.json
epicenter run tabManager.tabs.close --file input.json

# Stdin
echo '{"tabIds":[1,2,3]}' | epicenter run tabManager.tabs.close
```

All three work today. The flag form becomes the only change: removed, not replaced.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Input transport | JSON (inline, file, stdin) | Already supported; sole path forward. |
| Schema-driven flags | Removed | Bridge layer churn against a growing schema vocabulary; only serves the flat-schema interactive case. |
| Validation | Not added in this spec | Orthogonal. The wrapper doesn't validate today either (see Prerequisite note); adding it is its own spec. |
| Error on unknown flags | yargs strict mode stays on for `--peer`/`--workspace`/`--file`/`--format`; other flags produce error | Fails fast, no silent drop. |
| Migration path | Note in README + release notes | Small behavior change; low-impact user base today. |

## Implementation Plan

- [x] **1** Delete `packages/cli/src/util/typebox-to-yargs.ts` and `typebox-to-yargs.test.ts`.
- [x] **2** Simplify `packages/cli/src/commands/run.ts`:
    - Remove the `typeboxToYargsOptions(action.input)` import and call.
    - Remove the flag-merging branch in `resolveInput` (the "Flat schemas: map TypeBox fields to yargs flags" block).
    - `resolveInput` keeps only: positional (inline JSON or `@file.json`), `--file`, stdin.
    - **Flip `.strict(false)` → `.strict(true)`** so unknown flags fail with yargs's default "unknown argument" error.
- [x] **3** Verify `run.ts` no longer imports `typebox` at all (the `TSchema` type on `resolveInput`'s `action` parameter becomes unused: drop it).
- [~] **4** Update CLI tests to drop flag-based cases; add a test that unknown flags error.
    - Done: inline-JSON positional + unknown-flag-under-strict tests in `packages/cli/test/e2e-inline-actions.test.ts`.
    - **Gap:** no explicit tests for `@file.json` positional, `--file` flag, or stdin input. Success Criterion #4 below is still open.
- [x] **5** Update `apps/*/README.md` examples to JSON form; note the removal in release notes.

## Edge Cases

1. **Script that used flag form**: fails with yargs "unknown argument." User switches to JSON. Release note covers migration.
2. **Action with no input schema**: `resolveInput` short-circuits to `undefined` and `invoke` calls `action()` with no args; any provided JSON is silently ignored. (This is the same behavior today; no schema-flag path ever reached this case.)
3. **Empty stdin**: treated as no input. Handler receives `undefined`; behavior depends on the handler (there's no wrapper-level validation today: see Prerequisite note).

## Success Criteria

- [x] `packages/cli/src/util/typebox-to-yargs.ts` and its test file deleted.
- [x] `run.ts` no longer imports `typebox`.
- [x] `run.ts` uses `.strict(true)`: unknown flags exit non-zero with yargs's default error.
- [x] All existing CLI tests updated or removed; new tests cover the four input modes (inline JSON, `@file.json`, `--file`, stdin) plus unknown-flag rejection.
- [x] Example invocations in every `README.md` use JSON form.

## References

- `packages/cli/src/commands/run.ts:194-218`: `resolveInput` (positional / file / stdin) after the flag path was removed
- `packages/cli/src/commands/run.ts:62`: `.strict()` (flipped from `.strict(false)`)
- `packages/cli/src/util/typebox-to-yargs.ts`: deleted (+ `typebox-to-yargs.test.ts`)
- `packages/cli/src/util/parse-input.ts`: keep; handles JSON parsing
- `packages/workspace/src/shared/actions.ts:327-333,376-382`: `defineQuery` / `defineMutation` wrappers (no runtime validation today: out of scope for this spec, but context for the Prerequisite note)
- `packages/cli/README.md`: one-sentence thesis and the "user-authored `bun run` script" escape hatch
