# Merge `@epicenter/document` into `@epicenter/workspace`

**Date**: 2026-04-21
**Status**: Completed (2026-04-21)
**Shipped via**: `da1a58146 refactor(workspace): merge src/workspace/ into src/document/` (implemented with the opposite directional rename: `src/workspace/` merged into `src/document/` inside the workspace package: tighter than the original spec proposed).
**Author**: AI-assisted (design discussion with Braden)
**Branch**: `braden-w/document-primitive`

## Overview

Collapse `@epicenter/document` and `@epicenter/workspace` into a single `@epicenter/workspace` package. `@epicenter/document` is always imported alongside `@epicenter/workspace` in every production consumer, so the package boundary is historical accident rather than meaningful layering. One package, one import surface, one vocabulary doc.

## Motivation

### Current state

Two packages with a tight dependency relationship:

```
packages/document/         @epicenter/document (v0.0.0)
├── src/attach-table.ts    plaintext primitives
├── src/attach-kv.ts        (consumed only alongside @epicenter/workspace)
├── src/attach-indexed-db.ts
├── src/attach-sqlite.ts
├── src/attach-sync.ts
├── src/define-document.ts
├── src/internal.ts         (subpath: createTable, createKv)
├── src/y-keyvalue/         (subpath: plaintext YKeyValueLww)
└── ...

packages/workspace/         @epicenter/workspace (v0.1.0)
├── src/shared/             (actions, crypto, encrypted y-keyvalue wrapper)
├── src/workspace/          (attach-encryption, attach-encrypted, create-workspace)
├── src/extensions/         (persistence, sync, materializer providers)
└── ...                     (depends on @epicenter/document: workspace:*)
```

Every app and sibling package imports from **both**:

```ts
// apps/whispering/src/lib/client.ts (representative)
import {
  attachBroadcastChannel,
  attachIndexedDb,
  defineDocument,
} from '@epicenter/document';
import {
  attachEncryptedKv,
  attachEncryptedTables,
  attachEncryption,
} from '@epicenter/workspace';
```

This creates problems:

1. **Import ambiguity at call sites**: developers have to remember which primitive lives in which package. `attachTable` (plaintext) is in document; `attachEncryptedTable` is in workspace. The rule "plaintext = document, encrypted = workspace" is learnable, but it's a cognitive tax on every import.
2. **Duplicated vocabulary docs**: the `define*` / `attach*` / `create*` prefix table appears in two READMEs (deliberate, self-contained) but the underlying verb system is one thing described twice.
3. **Zero real layering**: no production app uses `@epicenter/document` without `@epicenter/workspace`. The packages always ship together. The separate version numbers (`0.0.0` vs `0.1.0`) can't diverge in meaningful ways because the dependency is always `workspace:*`.
4. **Four-place mix-hazard warning**: the plaintext-vs-encrypted slot-collision warning repeats in attach-encryption JSDoc, attach-encrypted JSDoc, workspace README, and skill reference: partly because the two-package split makes the confusion likelier in the first place.
5. **Extra subpath complexity**: document exposes 8+ subpath exports (`./internal`, `./y-keyvalue`, `./attach-sync`, etc.). Workspace will need to mirror most of these.

### Desired state

One package, one import surface:

```ts
// apps/whispering/src/lib/client.ts (after merge)
import {
  attachBroadcastChannel,
  attachEncryptedKv,
  attachEncryptedTables,
  attachEncryption,
  attachIndexedDb,
  defineDocument,
} from '@epicenter/workspace';
```

Directory layout:

```
packages/workspace/src/
├── document/                ← absorbed from packages/document/src/
│   ├── attach-awareness.ts
│   ├── attach-broadcast-channel.ts
│   ├── attach-indexed-db.ts
│   ├── attach-kv.ts         ← plaintext
│   ├── attach-plain-text.ts
│   ├── attach-rich-text.ts
│   ├── attach-sqlite.ts
│   ├── attach-sync.ts
│   ├── attach-table.ts      ← plaintext + attachTables batch
│   ├── attach-timeline/
│   ├── create-per-row-doc.ts
│   ├── define-document.ts
│   ├── doc-guid.ts
│   ├── internal.ts          ← subpath: ./internal
│   ├── keys.ts
│   ├── on-local-update.ts
│   ├── sqlite-update-log.ts
│   ├── standard-schema.ts
│   └── y-keyvalue/          ← subpath: ./y-keyvalue (plaintext store)
├── shared/                  ← unchanged (crypto, encrypted y-keyvalue wrapper, actions, errors, id, datetime-string)
├── workspace/               ← unchanged (encryption, encrypted primitives, create-workspace, extensions scaffolding)
├── extensions/              ← unchanged (persistence/sync/materializer providers)
├── ai/, rpc/, __benchmarks__/, __tests__/, links.ts
└── index.ts                 ← one unified public surface
```

## Research findings

### Scope: who imports `@epicenter/document`?

53 files across the monorepo, 10 `package.json`s. Broken down:

| Consumer | Files | Notes |
|---|---|---|
| `apps/*/src/lib/client.ts` | 7 | All apps; ~4 imports each |
| `apps/breddit/src/lib/.../workspace.ts` | 1 | Plaintext-only importer |
| `packages/workspace/src/**` | ~15 | Self-consumption; becomes relative after merge |
| `packages/skills/src/` | 3 | `index.ts`, `node.ts`, content-docs |
| `packages/filesystem/src/` | 2 | `file-content-docs.ts`, `file-system.ts` types |
| `packages/cli/src/` | 3 | `load-config.ts`, `connect.ts`, etc. |
| `packages/svelte-utils/src/` | 1 | `from-document.svelte.ts` |
| Benchmarks / scripts | ~10 | Internal to workspace |

### Subpath exports to preserve

`packages/document/package.json` exports:

```jsonc
"./define-document"      → callers: none found (root export is used)
"./on-local-update"      → callers: none found
"./attach-indexed-db"    → callers: none found (root export)
"./attach-sqlite"        → callers: none found (root export)
"./sqlite-update-log"    → YES: used by shared/y-keyvalue/y-keyvalue-lww-encrypted.ts
"./content-attachment"   → content-attachment.ts does not exist (already deleted); export is stale
"./attach-rich-text"     → none
"./attach-plain-text"    → none
"./attach-sync"          → none
"./attach-timeline"      → none
"./y-keyvalue"           → YES: workspace's encrypted wrapper imports from here
"./internal"             → YES: createTable, createKv, reentrance primitives (historical)
```

**Key finding**: only three subpaths are actually used by any consumer (`./sqlite-update-log`, `./y-keyvalue`, `./internal`). Most of the subpath exports in document's package.json are aspirational or stale.

**Implication**: workspace only needs to add 2-3 new subpath exports after merge. The rest can drop.

### `createWorkspace`: is it still needed?

Separate but adjacent question the user raised. Investigation:

| Consumer | Uses `createWorkspace`? |
|---|---|
| Every app (`apps/*/`) | **No**: all 7 apps use `defineDocument` + inline attach composition |
| `packages/filesystem/` | Test files only; production code imports types from workspace but doesn't call `createWorkspace` |
| `packages/workspace/` extensions | Yes: `persistence/*`, `sync/*`, `materializer/*` extensions are designed to plug into `createWorkspace`'s extension builder |
| `packages/workspace/` tests + benchmarks | Yes |
| `packages/cli/` | Likely yes (not verified in this pass) |

**Implication**: `createWorkspace` is used by extensions and by tests, not by apps. Its extension builder pattern (`.withExtension`, `.withActions`) has no production consumers in app code. Removing it would also remove the entire `extensions/` directory as a separate concept: apps already compose those behaviors inline.

**Recommendation**: keep `createWorkspace` untouched in the merge. Removing it is a **separate, larger** refactor (the extensions directory, filesystem tests, benchmarks all need migration). Scope this merge narrowly to the package boundary; `createWorkspace` removal is scoped in the follow-up spec `20260421T170000-collapse-document-and-workspace-primitives.md`, which sequences after this merge lands.

### `@epicenter/document`'s own dependencies

From `packages/document/package.json`:

```jsonc
"dependencies": {
  "@epicenter/sync": "workspace:*",
  "@standard-schema/spec": "catalog:",
  "lib0": "catalog:",
  "nanoid": "catalog:",
  "wellcrafted": "catalog:"
}
```

Cross-reference with workspace's deps (verified earlier): `@standard-schema/spec`, `lib0`, `nanoid`, `wellcrafted` are all already listed. `@epicenter/sync`: need to verify workspace depends on it (likely yes via transitivity; explicit add needed after merge).

**Implication**: minimal new deps; mostly de-duplication.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Target package | `@epicenter/workspace` | Larger, already has `0.1.0` version history, more descriptive name for the unified surface |
| Document source location | `packages/workspace/src/document/` subdirectory | One-rename diff, preserves file organization, defers "flatten into existing dirs" to a follow-up |
| Subpath exports | Only keep the 3 with real consumers (`./internal`, `./y-keyvalue`, `./sqlite-update-log`) + re-export everything else from root | Smaller surface, honest about what's consumed |
| `createWorkspace` fate | **Not touched** in this spec | Orthogonal concern; larger scope; evaluate after merge lands |
| Transition shim | **None**: delete `@epicenter/document` in the same PR | Big-bang avoids parallel surface; all consumers updated in one sweep |
| Consumer migration | Import string flip (`@epicenter/document` → `@epicenter/workspace`) + package.json dep removal | Mechanical, typecheck catches regressions |
| `packages/document/` directory | Deleted entirely | No reason to keep an empty package directory |
| Version bump | `@epicenter/workspace` → `0.2.0` | Breaking change for any external consumer (unlikely given internal monorepo) |
| README strategy | Delete `packages/document/README.md`; update `packages/workspace/README.md` vocabulary section to reflect unified surface | One canonical doc |
| Skill reference | Rename `.agents/skills/workspace-api/references/document-primitive.md`: file name becomes misleading after merge | `primitive-api.md` or similar |

## Architecture

### Import-flow diagram (before → after)

```
BEFORE
──────
app/client.ts
├── from '@epicenter/document'    ── plaintext primitives
│                                    defineDocument, attach*
└── from '@epicenter/workspace'   ── encrypted primitives
                                     attachEncryption, attachEncrypted*

                  ↓           ↓
         @epicenter/document   @epicenter/workspace
                                 └─ depends on @epicenter/document


AFTER
─────
app/client.ts
└── from '@epicenter/workspace'   ── everything

                  ↓
         @epicenter/workspace
           ├── src/document/        (was packages/document/src/)
           ├── src/shared/          (unchanged)
           ├── src/workspace/       (unchanged)
           └── src/extensions/      (unchanged)
```

### Internal import path translation table

| Before (inside workspace pkg) | After |
|---|---|
| `import X from '@epicenter/document'` | `import X from '../document/index.js'` (path varies by source file location) |
| `import X from '@epicenter/document/internal'` | `import X from '../document/internal.js'` |
| `import X from '@epicenter/document/y-keyvalue'` | `import X from '../document/y-keyvalue/index.js'` |
| `import X from '@epicenter/document/sqlite-update-log'` | `import X from '../document/sqlite-update-log.js'` |

For external consumers (apps + other packages):

| Before | After |
|---|---|
| `from '@epicenter/document'` | `from '@epicenter/workspace'` |
| `from '@epicenter/document/internal'` | `from '@epicenter/workspace/internal'` |
| `from '@epicenter/document/y-keyvalue'` | `from '@epicenter/workspace/y-keyvalue'` |
| `from '@epicenter/document/sqlite-update-log'` | `from '@epicenter/workspace/sqlite-update-log'` |

## Implementation plan

### Phase A: prepare workspace to host document's surface

- [ ] **A.1** Update `packages/workspace/package.json`:
  - Add subpath exports: `./internal`, `./y-keyvalue`, `./sqlite-update-log`
  - Add `@epicenter/sync` to dependencies if not already present
  - Bump version to `0.2.0` (or a pre-release tag)
- [ ] **A.2** Update `packages/workspace/src/index.ts` to re-export everything `packages/document/src/index.ts` currently exports. This is a **type-only** change at this phase; the imports still resolve to the old document package. Proves the surface is coverable.

### Phase B: move files

- [ ] **B.1** `git mv packages/document/src/ packages/workspace/src/document/`
- [ ] **B.2** Verify: workspace builds are now broken (internal imports point at `@epicenter/document` which is now empty); external consumers still reference the old package path.
- [ ] **B.3** Commit as **"refactor(workspace): move @epicenter/document sources into src/document/"**: intentionally broken intermediate state; next commit fixes.

### Phase C: fix workspace-package internal imports

- [ ] **C.1** Inside `packages/workspace/src/`, rewrite every `@epicenter/document*` import to a relative path based on source location. Files to touch (audit list):
  - `src/workspace/attach-encryption.ts`
  - `src/workspace/attach-encrypted.ts`
  - `src/workspace/create-workspace.ts`
  - `src/workspace/define-table.ts`, `define-kv.ts`, `schema-union.ts`
  - `src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`
  - `src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts`
  - `src/extensions/**` (materializer, persistence, sync)
  - `src/workspace/index.ts`
  - `src/index.ts`
- [ ] **C.2** Update `packages/workspace/package.json` to remove `@epicenter/document` from dependencies.
- [ ] **C.3** Run `bun run --cwd packages/workspace typecheck`. Must be clean.
- [ ] **C.4** Run `bun test --cwd packages/workspace`. Must be all green.
- [ ] **C.5** Commit as **"refactor(workspace): rewire internal imports to src/document/ relative paths"**.

### Phase D: migrate external consumers

For each consumer package, in dependency order (sibling packages first, apps last):

- [ ] **D.1** `packages/svelte-utils/`
  - Flip `from '@epicenter/document'` → `from '@epicenter/workspace'` (1 file: `from-document.svelte.ts`)
  - Remove `@epicenter/document` from `package.json` dependencies
- [ ] **D.2** `packages/skills/`
  - Flip imports in `src/index.ts`, `src/node.ts`, `src/reference-content-docs.ts`, `src/skill-instructions-docs.ts`
  - Remove from `package.json`
- [ ] **D.3** `packages/filesystem/`
  - Flip imports in `src/file-content-docs.ts`, `src/file-system.ts`
  - Remove from `package.json`
- [ ] **D.4** `packages/cli/`
  - Audit + flip any imports
  - Remove from `package.json`
- [ ] **D.5** `apps/*`: one commit per app for reviewability, or one batch commit. All 7 apps flip imports + drop `package.json` dep.
- [ ] **D.6** Run monorepo typecheck; must be clean on all files touched.
- [ ] **D.7** Commit as **"refactor: migrate every consumer from @epicenter/document to @epicenter/workspace"**.

### Phase E: delete `packages/document/`

- [ ] **E.1** `rm -rf packages/document/`
- [ ] **E.2** Remove any `packages/document` reference from `pnpm-workspace.yaml`, root `package.json` workspaces field, `turbo.json`, `bun.lock`, etc.
- [ ] **E.3** Run `bun install` from repo root to refresh the lockfile.
- [ ] **E.4** Commit as **"chore: delete @epicenter/document package"**.

### Phase F: documentation + skill reference

- [ ] **F.1** Delete `packages/document/README.md` (already gone via E.1; confirm).
- [ ] **F.2** Update `packages/workspace/README.md`:
  - Remove the "Plaintext vs encrypted: lives in different packages" framing
  - Update Prefix vocabulary section with the full merged surface
  - Keep the slot-collision warning (still applies: same package, same hazard)
- [ ] **F.3** Rename `.agents/skills/workspace-api/references/document-primitive.md` → `.agents/skills/workspace-api/references/primitive-api.md`
- [ ] **F.4** Update skill reference content to reflect unified package.
- [ ] **F.5** Update the skill's `SKILL.md` if it references `document-primitive.md` by path.
- [ ] **F.6** Update `AGENTS.md` / `CLAUDE.md` if they reference package structure.
- [ ] **F.7** Commit as **"docs: unify vocabulary after document/workspace merge"**.

### Phase G: verification

- [ ] **G.1** `bun run typecheck` across monorepo: clean on all files we touched.
- [ ] **G.2** `bun test` in `packages/workspace`: all green.
- [ ] **G.3** `bun test` in `packages/filesystem`, `packages/skills`: all green (or same pre-existing failures as before the merge).
- [ ] **G.4** Pick one app (whispering), `bun run --cwd apps/whispering build`: clean.
- [ ] **G.5** Verify `rg "@epicenter/document"` in the monorepo returns zero hits (outside of spec/doc files referencing history).

## Edge cases

### Circular dependency risk

**Scenario**: after merging document into workspace, `src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` imports from `src/document/y-keyvalue/`. Both are in the same package; no circular concern within the monorepo dep graph.

**Verification**: `bun run typecheck` will catch any self-referential import loop.

### Stale subpath consumers

**Scenario**: some internal script references `@epicenter/document/define-document` (legitimate but rare subpath). After merge, that subpath doesn't exist on workspace because we trimmed the list.

**Resolution**: typecheck catches it; add the subpath to workspace's package.json OR flip to root import. Decide per case.

### Import order conventions

**Scenario**: some ESLint / biome rule enforces import ordering. After merge, multiple imports from `@epicenter/workspace` that used to be split may now be collapsible.

**Resolution**: run biome's auto-fix after the migration batch. Unrelated cleanup commit.

### Package manager lockfile

**Scenario**: `bun.lock` or `pnpm-lock.yaml` has `@epicenter/document` entries. After deletion, lockfile is stale.

**Resolution**: `bun install` regenerates. Include lockfile in commit E.

### `apps/api/package.json` already using `@epicenter/document`

**Scenario**: any app's `package.json` lists `@epicenter/document` in dependencies even if unused at runtime (dev-only imports?).

**Resolution**: grep all `package.json`s, remove the dep, re-lock.

### Svelte-utils subpath export

**Scenario**: `packages/svelte-utils` imports `@epicenter/document` for one file. Verify the subpath structure still works after renaming the import.

**Resolution**: typecheck.

## Open questions

1. **Drop or keep `./define-document`, `./attach-sync`, etc. subpaths?**
   - Options: (a) keep all existing document subpaths on workspace, (b) drop subpaths with no real consumers, (c) root-export everything, no subpaths at all.
   - **Recommendation**: (b): preserve only `./internal`, `./y-keyvalue`, `./sqlite-update-log`. Everything else re-exports from root. Simpler surface; apps already import from root anyway.

2. **Flatten `document/` subdir into existing workspace directories?**
   - Options: (a) keep `src/document/` subdir as a coherent bucket (proposed), (b) move `attach-*` to `src/primitives/`, `define-document` to `src/`, `y-keyvalue` into `src/shared/y-keyvalue/`, etc.
   - **Recommendation**: defer to a follow-up spec. The merge itself is the value; internal reorganization can iterate.

3. **Version bump strategy**
   - Options: (a) bump workspace to `0.2.0`, (b) stay at `0.1.0` since internal consumers all use `workspace:*`, (c) tag `1.0.0` to mark the stable unified surface.
   - **Recommendation**: (a): breaking surface change deserves a minor bump even for internal consumers; `1.0.0` is premature.

4. **`createWorkspace` removal**
   - Orthogonal to this spec. Zero apps call it, but extensions + filesystem tests do.
   - **Resolved**: scoped in `specs/20260421T170000-collapse-document-and-workspace-primitives.md`, which sequences after this merge lands. That spec migrates the 10 remaining consumers (CLI + playgrounds + tests + bench) to direct `defineDocument` composition and deletes `createWorkspace` plus the extensions scaffolding.

5. **Rename `document/` subdir to something else after merge?**
   - Options: (a) `src/document/`, (b) `src/primitives/`, (c) `src/core/`, (d) flatten into existing dirs.
   - **Recommendation**: start with `src/document/`; easy to rename later.

## Success criteria

- [ ] Every import of `@epicenter/document` flipped to `@epicenter/workspace` (verified via `rg`)
- [ ] `packages/document/` directory deleted
- [ ] No `package.json` in the monorepo declares `@epicenter/document` as a dependency
- [ ] Every package with tests passes its test suite
- [ ] `bun run typecheck` clean on all touched files (pre-existing errors in unrelated files acceptable)
- [ ] Root `packages/workspace/src/index.ts` exports the union of both packages' former public surfaces
- [ ] Workspace README's vocabulary section describes the unified surface (no "plaintext lives in another package" framing)
- [ ] Skill reference under `.agents/skills/workspace-api/` renamed and updated
- [ ] Commit history shows 5-7 logical commits, each of which leaves the repo typecheck-clean

## References

### Files consumed by the merge

**Document source (to move):**
- `packages/document/src/attach-awareness.ts` (+ test)
- `packages/document/src/attach-broadcast-channel.ts`
- `packages/document/src/attach-indexed-db.ts`
- `packages/document/src/attach-kv.ts`
- `packages/document/src/attach-plain-text.ts` (+ test)
- `packages/document/src/attach-rich-text.ts` (+ test)
- `packages/document/src/attach-sqlite.ts`
- `packages/document/src/attach-sync.ts` (+ test)
- `packages/document/src/attach-table.ts`
- `packages/document/src/attach-timeline/` (subdir)
- `packages/document/src/create-per-row-doc.ts`
- `packages/document/src/define-document.ts` (+ test)
- `packages/document/src/doc-guid.ts`
- `packages/document/src/index.ts`
- `packages/document/src/internal.ts`
- `packages/document/src/keys.ts`
- `packages/document/src/on-local-update.ts`
- `packages/document/src/sqlite-update-log.ts`
- `packages/document/src/standard-schema.ts`
- `packages/document/src/y-keyvalue/` (subdir)

**Workspace files that import `@epicenter/document` (need internal rewire):**
- `packages/workspace/src/index.ts`
- `packages/workspace/src/workspace/index.ts`
- `packages/workspace/src/workspace/attach-encryption.ts`
- `packages/workspace/src/workspace/attach-encrypted.ts`
- `packages/workspace/src/workspace/create-workspace.ts`
- `packages/workspace/src/workspace/define-table.ts`
- `packages/workspace/src/workspace/define-kv.ts`
- `packages/workspace/src/workspace/schema-union.ts`
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` (+ test)
- `packages/workspace/src/extensions/persistence/indexeddb.ts`
- `packages/workspace/src/extensions/persistence/sqlite.ts`
- `packages/workspace/src/extensions/sync/websocket.ts`
- `packages/workspace/src/extensions/sync/broadcast-channel.ts`
- `packages/workspace/src/extensions/materializer/markdown/materializer.ts`
- `packages/workspace/src/extensions/materializer/sqlite/sqlite.ts`
- Benchmarks in `packages/workspace/src/__benchmarks__/`
- Tests across `packages/workspace/src/**/*.test.ts`

**External consumers (need import string flip + package.json update):**
- `apps/whispering/src/lib/client.ts`
- `apps/tab-manager/src/lib/client.ts`
- `apps/zhongwen/src/lib/client.ts`
- `apps/honeycrisp/src/lib/client.ts`
- `apps/fuji/src/lib/client.ts`
- `apps/opensidian/src/lib/client.ts`
- `apps/breddit/src/lib/workspace/ingest/reddit/workspace.ts`
- `packages/svelte-utils/src/from-document.svelte.ts`
- `packages/skills/src/{index,node,reference-content-docs,skill-instructions-docs}.ts`
- `packages/filesystem/src/{file-content-docs,file-system}.ts`
- `packages/cli/src/{load-config,connect,extensions}.ts`

**Docs to update:**
- `packages/workspace/README.md` (vocabulary + plaintext/encrypted sections)
- `packages/document/README.md` (delete)
- `.agents/skills/workspace-api/references/document-primitive.md` (rename + rewrite)
- `.agents/skills/workspace-api/SKILL.md` (update path references if any)
- `AGENTS.md` (update package listing if present)

### Related specs / history

- `specs/20260421T170000-collapse-document-and-workspace-primitives.md`: **the sequenced follow-up**: deletes `createWorkspace` + extensions chain, adds `DocumentBundle` type. Runs after this merge lands.
- `specs/20260421T140000-encryption-primitive-refactor.md`: the shipped predecessor work that created the current encrypted-variant API surface. This merge does not change that API; it only collapses where it lives.
- `specs/20260420T230100-collapse-document-framework.md`: earlier exploration around document/workspace boundaries (context for current state).
- Commit `65221f1b0 refactor(document): remove reentrance guards from attach primitives`: relevant to why the plaintext-vs-encrypted warning matters: with no runtime guards, the verb is the only defense.

### Tooling

- `rg "@epicenter/document"`: authoritative consumer list
- `bun run typecheck` from repo root: catches missed imports
- `bun test` per-package: catches runtime regressions
- Git `--find-renames` ensures `git mv` preserves file history
