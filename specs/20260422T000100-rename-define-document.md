# Rename `defineDocument` → `createDocumentFactory`

**Status:** Complete (2026-04-22)
**Created:** 2026-04-22
**Related:** specs/20260422T000000-apply-session-unification.md (independent; can land in either order)

## Problem

The primitive is called `defineDocument`. It doesn't define anything. It returns a ref-counted factory with `.open(id)`, `.close(id)`, `.closeAll()`. A reader encountering `const entryContentDocs = defineDocument(...)` reasonably expects "defines" to mean "registers a schema" or "creates a persistent thing." It doesn't. The return value is a factory you call later.

Post-invert-readiness (spec `20260422T000000-define-document-invert-readiness.md`), the primitive is stable and small (~128 lines). Good moment to fix the naming before more call sites accumulate.

## Decision

Rename: `defineDocument` → `createDocumentFactory`.

Keep unchanged:
- Builder parameter name: `build: (id: Id) => T`. (Do NOT rename to `open`: conflicts with the factory's `.open(id)` method and reads worse inside the closure.)
- Factory methods: `.open(id)`, `.close(id)`, `.closeAll()`.
- `DocumentBundle` contract.
- `DocumentFactory<Id, T>` return type (the type name stays; "factory" now aligns with the function name).

## Why `createDocumentFactory`

- Matches the `create*` verb already used by every wrapper in this codebase (`createFileContentDocs`, `createSkillInstructionsDocs`, `createReferenceContentDocs`).
- Says what it is: a factory constructor.
- Asymmetric and honest about the shape: you `create` a factory once, you `open` from it many times.

Rejected alternatives:
- `createDocumentCache`: emphasizes caching over the primary identity/factory semantics; misleads readers into thinking it's LRU-style.
- `createDocumentStore`: "store" collides with Svelte/Pinia vocabulary.
- `documentFactory` (noun): would then conflict with existing `createFileContentDocs` style; verb consistency wins.
- Keep `defineDocument`: defensible via Vue/Pinia precedent, but their `defineStore`/`defineComponent` return the *usable thing directly*, not a cache wrapper. The analogy doesn't hold.

## Scope

Single mechanical rename. No behavior change. No signature change. No file moves (keep it at `packages/workspace/src/document/define-document.ts`: renaming the file is optional and not required; the export rename is the meaningful change. If you do rename the file, also rename `define-document.test.ts`).

### Files touched

Primitive:
- `packages/workspace/src/document/define-document.ts`: rename `export function defineDocument` → `export function createDocumentFactory`. The JSDoc example blocks also need the function name updated.
- `packages/workspace/src/document/define-document.test.ts`: update `import { defineDocument }` and any inline references in test descriptions.
- `packages/workspace/src/index.ts` (or wherever the public export lives): update the re-export name.

Call sites (raw `defineDocument`):
- `apps/fuji/src/lib/entry-content-docs.ts:22`: `defineDocument((entryId) => ...)` → `createDocumentFactory((entryId) => ...)`
- `apps/honeycrisp/src/lib/note-body-docs.ts:22`: same

Call sites (inside wrappers):
- `packages/filesystem/src/file-content-docs.ts:44`: `return defineDocument(...)` → `return createDocumentFactory(...)`
- `packages/skills/src/skill-instructions-docs.ts:28`: same
- `packages/skills/src/reference-content-docs.ts:28`: same

Type imports:
- Any `import type { DocumentFactory }` stays as-is (the type name doesn't change).
- Any `import { defineDocument }` updates to `import { createDocumentFactory }`.

Documentation / specs:
- Update prose references in recent specs only if they meaningfully change the reader's understanding. Historical specs referencing `defineDocument` stay (they describe the history). New docs should use the new name.
- Update `packages/workspace/README.md` if it names the function.

## Acceptance criteria

1. `grep -r "defineDocument" --include="*.ts"` across the repo returns zero hits outside of historical spec files in `specs/`.
2. `bun run check` passes.
3. `bun test` passes (especially `packages/workspace/src/document/define-document.test.ts`, though note the file name may or may not be renamed).
4. No behavior changes. Git diff should show only identifier renames, no logic edits.

## Out of scope

- `createRowFieldDocs` higher-level primitive. The five wrappers (`entry-content-docs`, `note-body-docs`, `file-content-docs`, `skill-instructions-docs`, `reference-content-docs`) share ~30 lines of near-identical boilerplate (deterministic guid via `docGuid` + text attachment + persistence + sync + `onLocalUpdate` updatedAt bump + disposal). Five is the threshold where extraction *starts* being worth it, but each wrapper has small shape differences (text primitive variant, persistence story, presence of sync) that would force 4-5 callbacks. Punt until a sixth instance exists or the boilerplate demonstrably causes a bug.
- No rename of the file `define-document.ts` is required. Optional; do it only if it feels important for directory scanability.
- No rename of `DocumentFactory` type, `DocumentBundle` contract, or `DocumentHandle` type.
- No per-open `gcTime` override (deferred in earlier spec).

## Handoff prompt

Execute the rename specified in `specs/20260422T000100-rename-define-document.md`.

This is a single mechanical rename: `defineDocument` → `createDocumentFactory`. No signature change, no behavior change. The builder parameter stays named `build`. The `.open(id)` method name is unchanged. The `DocumentFactory<Id, T>` return type name is unchanged.

Touch these files (full list in the spec): the primitive at `packages/workspace/src/document/define-document.ts`, its test, the workspace package barrel export, two raw call sites (`apps/fuji/src/lib/entry-content-docs.ts:22`, `apps/honeycrisp/src/lib/note-body-docs.ts:22`), three wrapper internals (`packages/filesystem/src/file-content-docs.ts:44`, `packages/skills/src/skill-instructions-docs.ts:28`, `packages/skills/src/reference-content-docs.ts:28`), and any JSDoc example blocks that reference the old name.

Verify with: `grep -r "defineDocument" --include="*.ts"` returns zero hits outside `specs/`. Run `bun run check` and `bun test`.

Do not rename the file `define-document.ts` (optional cleanup, not required). Do not rename `DocumentFactory`, `DocumentBundle`, or `DocumentHandle` types. Do not attempt to extract a higher-level `createRowFieldDocs`: that's explicitly out of scope.
