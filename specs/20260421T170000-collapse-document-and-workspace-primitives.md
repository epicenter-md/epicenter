---
title: Delete `createWorkspace`, document `DocumentBundle` contract
status: Completed (2026-04-21)
date: 2026-04-21
sequence: runs after `20260421T170000-merge-document-into-workspace.md`
supersedes: 20260421T010000-collapse-defineworkspace-into-definedocument.md (completes it)
shipped_commits:
  - b62cc5ae3 refactor(workspace):delete createWorkspace + extension chain
  - 01e0270fa docs:update vocabulary + rewrite SyncView after createWorkspace removal
  - 577cbfcd6 refactor(cli):migrate to DocumentBundle, drop describe command
  - 338c2557a docs(apps):update marketing code strings to defineDocument pattern
---

# Delete `createWorkspace`, document `DocumentBundle` contract

## TL;DR

Two changes, no renames, no app rewrites:

1. **Delete `createWorkspace`** and the entire extensions chain (`~700 lines`). Ten consumers migrate to direct `defineDocument` composition: the pattern seven apps already use in production.
2. **Export a `DocumentBundle` type** from `@epicenter/workspace` and have `defineDocument`'s generic constrain to it. Formalizes the contract that already exists implicitly.

```text
                BEFORE                                        AFTER
 ┌──────────────────────────────────┐      ┌──────────────────────────────────┐
 │ createWorkspace({id, tables,…})  │      │         (deleted)                 │
 │   .withExtension(...)            │ ──▶  │                                   │
 │   → 459-line builder chain       │      │                                   │
 │   + ExtensionFactory             │      │                                   │
 │   + WorkspaceClientBuilder       │      │                                   │
 │   + RawExtension                 │      │                                   │
 ├──────────────────────────────────┤      ├──────────────────────────────────┤
 │ defineDocument(build, opts?)     │      │ defineDocument(build, opts?)      │
 │  .open(id) / .close / .closeAll  │      │  .open(id) / .close / .closeAll   │
 │  (unchanged: already universal) │      │  + constrained to DocumentBundle  │
 └──────────────────────────────────┘      └──────────────────────────────────┘
```

## Why narrower than the original draft

Earlier drafts of this spec proposed splitting `defineDocument` into two primitives (`build*` for singletons, `createDocumentCache` for multi-doc), renaming app-level bindings, and imposing a three-tier taxonomy. After a call-site ergonomics shootout across whispering, fuji, and the other five app clients:

- The split forced a fake distinction. `defineDocument` already serves both cases: singletons just call `.open()` once, multi-doc calls `.open()` N times.
- Every concrete rename (`createDocumentCache`, `createDocumentPool`, `createDocumentRegistry`) was honest for multi-doc but dishonest for singletons, and vice versa.
- The "before → after" diff per app was 4 characters of net change. Not worth touching seven stable files.

`defineDocument` is abstract enough to cover both cases honestly: matching the ecosystem's `define*` pattern (Vue's `defineComponent`, Astro's `defineCollection`, Pinia's `defineStore`), which also commit to neither "one" nor "many." The primitive names the definition; how many instances get opened is usage, not design.

This spec therefore does two things and nothing else.

## Survey (grounding)

**`createWorkspace` call sites: 10 total.**

| Consumer                                  | Extensions used          | Migration path                                                                 |
|-------------------------------------------|--------------------------|--------------------------------------------------------------------------------|
| 5 test files (`create-workspace.test.ts`, materializer tests, bench) | none | Inline to `new Y.Doc({ guid })` + `attachTable`/`attachKv`.                     |
| `packages/cli/src/connect.ts`             | `unlock`, `sync`         | Inline composition: `attachEncryption` + `applyKeys(keyring)` + `attachSync`.  |
| `playground/opensidian-e2e/*` (×3)        | `persistence`            | Inline: `attachEncryption` + `attachEncryptedTables` + `attachSqlite`.         |
| 1 bench (`operations.bench.test.ts`)      | none                     | Trivial `{ id, tables, kv }` inline.                                           |

Zero production-app consumers. Every `apps/*/src/lib/client.ts` already uses `defineDocument` directly.

**`defineDocument` call sites: 15 total.**

| Shape                   | Count | Examples                                                      |
|-------------------------|-------|---------------------------------------------------------------|
| Singleton, `gcTime: ∞`  | 10    | fuji, opensidian, whispering, tab-manager, zhongwen, honeycrisp, old skills factories (×2), breddit |
| Multi-doc (dynamic ids) | 5     | `createFileContentDocs`, `createSkillInstructionsDocs`, `createReferenceContentDocs`, entry/note content docs |

**No changes to any of these call sites.** Naming stays, shape stays, `.open(id)` stays.

## The invariant we're formalizing

`defineDocument` already requires a builder returning `{ ydoc: Y.Doc } & Disposable` and optionally `whenDisposed`. That's today's implicit contract. Surface it as a named type:

```ts
// packages/workspace/src/document/types.ts (post-merge location)
export type DocumentBundle = {
  ydoc: Y.Doc;
  [Symbol.dispose](): void;
  whenReady?: Promise<void>;     // user convention; cache never reads
  whenDisposed?: Promise<void>;  // cache awaits in close() / closeAll()
};

export function defineDocument<
  Id extends string,
  T extends DocumentBundle,
>(
  build: (id: Id) => T,
  opts?: { gcTime?: number },
): DocumentFactory<Id, T> { /* unchanged */ }
```

Zero runtime change. Pure additive type constraint. Everything already satisfies it; the constraint just lets TypeScript catch a future builder that forgets `[Symbol.dispose]` at definition site instead of at first consumer.

## What dies

```text
packages/workspace/src/workspace/create-workspace.ts     ~459 lines
packages/workspace/src/workspace/create-workspace.test.ts  ~750 lines (test file: large)
packages/workspace/src/workspace/lifecycle.ts            : ExtensionFactory, RawExtension, ExtensionContext
                                                             WorkspaceClientBuilder, SharedExtensionContext
packages/workspace/src/extensions/                       : entire directory (persistence, sync, materializer)
                                                             if no other consumer remains after migration
```

Plus exports in `packages/workspace/src/index.ts` and `workspace/index.ts`:

```diff
- export { createWorkspace } from './workspace/create-workspace';
- export type { ExtensionContext, ExtensionFactory, RawExtension,
-               WorkspaceClientBuilder, SharedExtensionContext } from './workspace/types';
```

## What stays: explicitly

| Thing                          | Stays? | Why                                                                 |
|--------------------------------|:------:|---------------------------------------------------------------------|
| `defineDocument` name          |   ✅   | Abstract enough to cover singleton + multi-doc honestly             |
| `.open(id)` / `.close(id)` / `.closeAll()` | ✅ | Reads fine for both cases; no replacement needed                    |
| All 7 app clients (`client.ts`)| ✅   | Zero API changes visible to them                                    |
| All 5 multi-doc factories      |   ✅   | Pattern is already correct                                          |
| `whisperingFactory` / `fuji` / etc. variable names | ✅ | Bikeshed; not worth touching                                       |
| `defineTable`, `defineKv`      |   ✅   | Untouched                                                           |
| `attachEncryption`, `attachEncrypted*` | ✅ | Untouched                                                           |
| `gcTime` option on `defineDocument` | ✅ | Multi-doc consumers may eventually use it                           |

## Migration plan

### Phase 1: migrate the 10 `createWorkspace` consumers

One commit per consumer group for reviewability. Each migration is mechanical:

**CLI** (`packages/cli/src/connect.ts`):
```ts
// BEFORE
const client = createWorkspace({ id, tables, kv })
  .withExtension('unlock', unlock({ keyring }))
  .withExtension('sync',   sync({ url, getToken }));
await client.whenReady;

// AFTER
const ydoc       = new Y.Doc({ guid: id, gc: false });
const encryption = attachEncryption(ydoc);
const tables     = attachEncryptedTables(ydoc, encryption, tableDefs);
const kv         = attachEncryptedKv(ydoc, encryption, kvDefs);
encryption.applyKeys(keyring);
const sync       = attachSync(ydoc, { url, getToken });
await sync.whenConnected;
const client     = { ydoc, tables, kv, encryption, sync,
                     [Symbol.dispose]() { ydoc.destroy(); } };
```

**Playgrounds** (`playground/opensidian-e2e/*`): same shape as CLI but with `attachSqlite` instead of `attachSync`.

**Tests** (5 files): trivial: they only use `createWorkspace` for `{ id, tables, kv }`, so they flip to `new Y.Doc({ guid: id })` + `attachEncryptedTables` + `attachEncryptedKv`.

**Bench** (`operations.bench.test.ts`): already migrated in commit `730cf72e6`. Verify no re-introduction.

Commits: 4 (CLI, playgrounds, tests, bench-verify).

### Phase 2: delete `createWorkspace` machinery

- Delete `create-workspace.ts`, `create-workspace.test.ts`.
- Delete `lifecycle.ts` types (`ExtensionFactory`, `RawExtension`, `ExtensionContext`, `WorkspaceClientBuilder`, `SharedExtensionContext`).
- Audit `packages/workspace/src/extensions/`: if every extension module only exports functions consumed by `createWorkspace`, delete the directory. If any extension has a non-createWorkspace consumer (`attachSqlite` etc.), keep it and move it to `document/` (merge spec terminology).
- Update `packages/workspace/src/index.ts` + `workspace/index.ts`: remove `createWorkspace`, extension types, any builder-pattern re-exports.
- Run `bun run typecheck` from repo root: clean.
- Run `bun test --cwd packages/workspace`: all green.

Commits: 1.

### Phase 3: add `DocumentBundle` type

- Export `DocumentBundle` from `@epicenter/workspace` root.
- Tighten `defineDocument`'s generic signature: `T extends { ydoc: Y.Doc } & Disposable` → `T extends DocumentBundle`.
- No call-site changes; every existing builder already satisfies.
- Run typecheck to confirm zero breakage.

Commits: 1.

### Phase 4: documentation + dependent consumer cleanup

- Update `packages/workspace/README.md`: remove the `createWorkspace` section; add a one-paragraph note on `defineDocument` serving both singleton and multi-doc.
- Update `.agents/skills/workspace-api/SKILL.md`: drop `createWorkspace` references.
- Update `AGENTS.md` if it mentions the extension chain.
- **Rewrite `SyncView` in `packages/svelte-utils/src/account-popover/account-popover.svelte`** (lines ~18-43). The current docstring frames the structural type as "intersection of the legacy extension-chain client (`workspace.extensions.sync`) and a direct `defineDocument` closure bundle (`workspace.sync`), so apps can migrate incrementally without a compat shim." Once `createWorkspace` dies, there is no extension-chain shape: only `workspace.sync`. Collapse the docstring, and if no structural flexibility is still needed, replace `SyncView` with `SyncAttachment` (imported from `@epicenter/workspace`) and update callers. Left in place during the merge because the narrative still held; this phase is the first moment it stops holding.

Commits: 1.

### Phase 5: directory collapse (optional, low-risk)

After `createWorkspace` is gone, `src/workspace/` shrinks to a handful of primitive files that belong alongside the document primitives: `define-kv.ts`, `define-table.ts`, `attach-encryption.ts`, `attach-encrypted.ts`, `encryption-key.ts`, `describe-workspace.ts` (if retained). The `src/document/` vs `src/workspace/` split was load-bearing during the merge; post-createWorkspace it just forces arbitrary pathing decisions on new contributors.

Two options, pick one:

| Option | Shape | Effort |
|---|---|---|
| **A. Merge** `src/workspace/*` into `src/document/` (kept as umbrella for all primitives). | Everything primitive lives in one directory. | ~1 commit of moves + import rewrites. |
| **B. Flatten** both into `src/` (no primitive subdir). | `src/attach-*.ts`, `src/define-*.ts`, `src/y-keyvalue/` at top level. | ~1 commit; touches more files but tree is flatter. |

**Recommendation: Option A.** Option B churns every import in the repo; Option A is internal-only. The `document/` name stays because `defineDocument` is the flagship primitive (and it matches the subdir name).

If this phase grows beyond a single-commit move + ripgrep sweep, punt to a dedicated follow-up spec.

Commits: 1 (if Option A).

**Total: 8 commits, ~700 lines deleted, one type exported, one directory collapsed.**

## Relationship to other specs

### `20260421T170000-merge-document-into-workspace.md` (merge)

The merge spec consolidates `@epicenter/document` into `@epicenter/workspace`. **Run the merge first.**

Sequencing rationale:

| If order is…                | CLI + playgrounds touched |  Conflicts  | Risk  |
|-----------------------------|:------------------------:|:----------:|:-----:|
| Merge → this spec (recommended) |          Once          |    None    | Low   |
| This spec → merge           |          Twice          | Minor (imports) | Medium |
| Single PR combining both    |          Once          |    None    | Higher: bigger blast radius for review |

The merge spec's "createWorkspace fate" section already names this spec as its planned follow-up: its Open Question #4 is exactly the scope of this document.

### `20260421T010000-collapse-defineworkspace-into-definedocument.md` (predecessor, done)

That spec collapsed `defineWorkspace` into `createWorkspace`. This spec completes the job by killing `createWorkspace` itself. Mark the predecessor spec as fully superseded once this lands.

### `20260421T140000-encryption-primitive-refactor.md` (done)

Not affected. The encryption attach API stays unchanged: `attachEncryption(ydoc)` + `attachEncryptedTable(ydoc, encryption, …)` are exactly what the new inline-composition consumers will use.

## Design decisions

| Decision                                       | Choice                                         | Rationale                                                                                      |
|------------------------------------------------|------------------------------------------------|------------------------------------------------------------------------------------------------|
| Rename `defineDocument`                        | **No**                                          | Every concrete candidate was honest for one case and dishonest for the other. `define*` is abstract. |
| Rewrite app clients                            | **No**                                          | Zero visible API change. Seven stable files untouched.                                         |
| Export `DocumentBundle` type                   | **Yes**                                         | Additive, formalizes the implicit contract, catches builder bugs at definition site.           |
| Delete `createWorkspace`                       | **Yes**                                         | 459 lines of dead-in-production code.                                                          |
| Delete extensions scaffolding                  | **Yes** (audit first)                           | If no non-`createWorkspace` consumers remain, delete. If any remain, preserve.                 |
| Keep `defineDocument`'s `{ gcTime }` option    | **Yes**                                         | Multi-doc consumers may need it; singleton consumers are free to ignore.                       |
| Sequence after merge spec                      | **Yes**                                         | Halves the migration surface on CLI/playgrounds.                                               |
| Combine with merge spec into one PR            | **No**                                          | Easier review, lower blast radius, each commit keeps the tree green.                           |

## Success criteria

- [ ] `createWorkspace` not referenced anywhere in the repo except historical specs (`rg "createWorkspace"` outside `specs/` and `docs/articles/` returns zero hits).
- [ ] `ExtensionFactory`, `RawExtension`, `ExtensionContext`, `WorkspaceClientBuilder`, `SharedExtensionContext` types not exported.
- [ ] `DocumentBundle` exported from `@epicenter/workspace` root.
- [ ] `defineDocument`'s signature reflects the new constraint.
- [ ] CLI and playgrounds compile and pass their tests using inline composition.
- [ ] All 7 app clients unchanged (verify via `git diff apps/*/src/lib/client.ts`).
- [ ] All 5 multi-doc factories unchanged (verify via `git diff packages/filesystem/src/ packages/skills/src/`).
- [ ] `bun run typecheck` clean.
- [ ] `bun test` clean across `packages/workspace`, `packages/cli`, playgrounds.

## Open questions

1. **Does anything outside `createWorkspace` consume the `extensions/` directory?**
   Need to grep before Phase 2's audit. If `attachSqlite` or `attachMaterializer` have consumers elsewhere, move them to `document/` rather than delete.

2. **Do the CLI migration details survive review?**
   The `unlock` extension today wraps key rotation and passphrase prompting. The inline version just calls `encryption.applyKeys(keyring)`. Verify with a pass over `packages/cli/src/extensions.ts` that nothing else is doing load-bearing work under the extension wrapper.

3. **Should `DocumentBundle` live in `@epicenter/workspace` root or in a subpath?**
   Recommendation: root. It's a vocabulary-tier type, same stratum as `Table`, `Kv`, `Awareness`.

4. **`defineDocument` vs `defineDocuments`** (plural)?
   Plural would hint "multi-instance factory." But the ecosystem uses singular (`defineComponent`, `defineStore`) and it reads better inline. Keep singular.

5. **`SyncView` in `account-popover.svelte`: structural type or direct `SyncAttachment`?**
   The current structural shape intersects `workspace.extensions.sync` with `workspace.sync` for migration. Once createWorkspace dies, the only producer is `attachSync`. If every consumer passes an `attachSync` result directly, just type it as `SyncAttachment` and delete `SyncView`. Verify by tracing the prop at every call site during Phase 4.

6. **`src/document/` vs `src/workspace/` after the collapse** (Phase 5): merge or flatten?
   Recommended Option A (merge `workspace/` primitives into `document/`) in the spec above, but the call isn't final until Phase 4 closes and we see what's left in `src/workspace/`. If the remaining files all match the `attach-*` / `define-*` primitive grammar, Option A is obvious. If an oddball survives, it may warrant its own file and the question reopens.

## Out of scope: track separately

- **`packages/workspace/src/document/y-keyvalue/_reference/y-keyvalue.ts`** is marked `@internal Not used in production` in its own JSDoc, yet `y-keyvalue/index.ts` re-exports `YKeyValue` from it. Repo-wide production consumers: zero. References: benchmarks + the LWW variant's tests. Pre-existing from before the merge, not created by it. Separate cleanup: either stop re-exporting from the public barrel or move the file under `scripts/yjs-benchmarks/`. Noted here because Phase 5's directory collapse will walk the `y-keyvalue/` subtree and may tempt the agent to bundle this: don't.

## References

- `packages/workspace/src/workspace/create-workspace.ts`: the 459-line file being deleted
- `packages/document/src/define-document.ts`: the primitive being kept (post-merge: `packages/workspace/src/document/define-document.ts`)
- `packages/cli/src/connect.ts`: largest consumer migration
- `apps/whispering/src/lib/client.ts`: representative singleton call site (unchanged)
- `packages/filesystem/src/file-content-docs.ts`: representative multi-doc call site (unchanged)
- `specs/20260421T170000-merge-document-into-workspace.md`: the merge spec this sequences after
- `specs/20260421T010000-collapse-defineworkspace-into-definedocument.md`: the predecessor (completed)
