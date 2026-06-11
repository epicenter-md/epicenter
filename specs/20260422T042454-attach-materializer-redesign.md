# Attach-Materializer Redesign

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive (continuing)

## Overview

Rename `create*Materializer` → `attach*Materializer`, align them with the `attachX(ydoc, opts)` convention every other primitive uses, drop the redundant `tables` / `definitions` / `whenReady` inputs, and switch registration to per-reference (`.table(tables.posts, config)`) instead of string-keyed lookup.

## Motivation

### Current State

Materializers use a shape that predates the `attach*` primitive family:

```ts
const sqlite = createSqliteMaterializer(
  { tables, definitions, whenReady },
  { db: new Database('app.db') },
)
  .table('posts', { fts: ['title'] })
  .table('notes');

const markdown = createMarkdownMaterializer(
  { tables, kv, whenReady },
  { dir: './data' },
)
  .table('posts', { serialize: slugFilename('title') })
  .kv();
```

This creates problems:

1. **Inconsistent signature**. Every other primitive is `attachX(ydoc, opts)`. Materializers are `createX({ observables }, { destination })`. Two-arg-object + different verb = cognitive cost for no benefit.
2. **`tables` + `definitions` is duplicative**. `tables` is derived from `definitions` via `attachTables(ydoc, definitions)`. Passing both means the caller tracks two things when one would do.
3. **`whenReady` is a caller-owned concept leaking into a provider**. No Yjs-world provider (`y-indexeddb`, `y-websocket`, `y-webrtc`) takes readiness as an input. Readiness is a *return* promise, not a gate.
4. **Manual disposal**. Materializers don't hook `ydoc.once('destroy', ...)`; callers must remember `materializer[Symbol.dispose]()`. Every other `attach*` primitive self-disposes: this is a leak footgun.
5. **String-keyed `.table('posts', ...)` is not type-safe**. A typo silently registers nothing. Per-reference registration (`.table(tables.posts, ...)`) type-checks.

### Desired State

```ts
const sqlite = attachSqliteMaterializer(ydoc, { db: new Database('app.db') })
  .table(tables.posts, { fts: ['title'] })
  .table(tables.notes);

const markdown = attachMarkdownMaterializer(ydoc, { dir: './data' })
  .table(tables.posts, { serialize: slugFilename('title') })
  .kv(kv.settings);
```

- Uniform `attachX(ydoc, opts)` signature.
- No `tables`, `definitions`, or `whenReady` in the input bag.
- Self-disposing via `ydoc.once('destroy', ...)`.
- Per-reference registration is typed.
- Readiness exposed as `materializer.whenFlushed` (already the case: now the only gate).

## Research Findings

### Yjs provider conventions (via deepwiki)

| Convention                          | Yjs-native example                                   | Our current materializer             | Proposed                          |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------ | --------------------------------- |
| First arg is `ydoc`                 | `new WebsocketProvider(url, room, ydoc)`             | No: takes `{ tables, ... }`         | Yes: `attachX(ydoc, opts)`       |
| Teardown via `ydoc.once('destroy')` | `IndexeddbPersistence` registers its own destroy hook | No: caller invokes `[Symbol.dispose]()` | Yes: hook inside factory         |
| Readiness as return promise         | `idb.whenSynced`, `ydoc.whenLoaded`                   | Input `whenReady` gate               | Return `whenFlushed` (existing)   |
| Observes a specific shared type     | `ySyncPlugin(ydoc.getXmlFragment('key'))`             | Bag of tables + string lookup        | `.table(tables.posts, ...)`       |

**Key finding**: The y-prosemirror / y-codemirror / y-monaco family takes the **specific shared resource directly**, not `(ydoc, 'key-name')`. Per-reference registration aligns with that idiom.

**Implication**: The `tables` / `kv` arguments were a leftover from our pre-`attach*` extension era. Yjs-native consumers don't take upfront resource bags.

### Call-site inventory

| File                                                             | Current use                                              | Migration        |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| `playground/opensidian-e2e/epicenter.config.ts`                  | `createMarkdownMaterializer` + `createSqliteMaterializer` | Rewrite (~30 lines) |
| `packages/workspace/src/document/materializer/markdown/materializer.test.ts` | `createMarkdownMaterializer` (still uses dead `createWorkspace`) | Port + rewrite |
| `packages/workspace/src/document/materializer/sqlite/sqlite.test.ts` | `createSqliteMaterializer` (still uses dead `createWorkspace`) | Port + rewrite |

Zero production-app consumers. Two tests + one playground. Small blast radius.

## Design Decisions

| Decision                                   | Choice                                              | Rationale                                                                   |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------- |
| Verb prefix                                | `attach*`                                           | Uniform with every other primitive; signals self-lifecycle.                 |
| First positional arg                       | `ydoc: Y.Doc`                                       | Matches Yjs provider convention; enables destroy-hook.                      |
| Drop `tables` / `definitions` inputs       | Register per-reference via `.table(ref, config)`    | Type-safe; matches y-prosemirror idiom; eliminates redundancy.              |
| Drop `whenReady` input                     | Materializer exposes `whenFlushed`; caller sequences | No Yjs provider takes readiness as input; caller controls its own ordering. |
| Add `name` + `definition` to `Table<TRow>` | Additive: `attachTable` already has the references | Materializer needs them for DDL; callers may find them useful too.          |
| Add `name` to `Kv<TDef>`                   | Additive: `attachKv` has the reference             | Markdown materializer's `.kv(kv.settings)` needs a filename basis.          |
| Keep `.table(...)` chaining                | Yes                                                 | Per-table autocomplete; clean composition inside `defineDocument`.          |
| Rename or expose `[Symbol.dispose]`        | Drop from return; `ydoc.destroy()` is the trigger   | Matches every other `attach*`; eliminates caller-remembered dispose.        |

## Architecture

### Table / Kv shape additions (additive)

```
┌───────────────────────────────────────────┐
│ Table<TRow>                               │
│   name: string          ← NEW             │
│   definition: TableDef  ← NEW             │
│   get / set / observe / ...  (unchanged)  │
└───────────────────────────────────────────┘

┌───────────────────────────────────────────┐
│ Kv<TDefinitions>                          │
│   name: string          ← NEW             │
│   get / set / observe / ...  (unchanged)  │
└───────────────────────────────────────────┘
```

`attachTable` / `attachTables` / `attachKv` already hold the name and definition in scope, just expose them.

### Materializer lifecycle (new)

```
attachSqliteMaterializer(ydoc, { db })
  ↓
  sync construction
  ├── register ydoc.once('destroy', teardown)
  ├── return builder { table(), kv?(), whenFlushed, ... }
  ↓
.table(tables.posts, config)
  ├── name = tables.posts.name
  ├── definition = tables.posts.definition  (sqlite only: DDL)
  ├── register observer: tables.posts.observe(...)
  └── return builder (chainable)
  ↓
  async initialize (inside whenFlushed)
  ├── DDL per registered table
  ├── bulk-load current rows (table.getAll())
  └── drain any observer events queued during DDL
  ↓
  ydoc.destroy()
  └── teardown: unsubscribe all observers, close db / flush files
```

### Signature comparison

```
BEFORE
──────
createSqliteMaterializer(
  { tables, definitions, whenReady },    ← 3 inputs, duplicative
  { db, debounceMs? }
)
  .table('posts', config)                ← string key, untyped

AFTER
─────
attachSqliteMaterializer(
  ydoc,                                   ← matches attach* convention
  { db, debounceMs? }
)
  .table(tables.posts, config)            ← reference, typed
```

## Implementation Plan

### Phase 1: Expose `name` + `definition` on `Table` and `Kv`

Non-breaking, additive.

- [ ] **1.1** Add `name: string` and `definition: TableDefinition<...>` to the `Table<TRow>` type in `packages/workspace/src/document/attach-table.ts`.
- [ ] **1.2** Update `attachTable(ydoc, definition, name?)` so the returned object includes `name` and `definition`. `attachTables` threads the key name through for each entry.
- [ ] **1.3** ~~Add `name` to `Kv`~~: dropped. There's only one `Kv` per workspace (single `KV_KEY` Y.Array), so there's no per-kv name to expose. Markdown materializer will take `.kv(kv, { filename? })` instead: filename is a per-materializer config concern, not a Kv property.
- [ ] **1.4** Typecheck workspace package. No consumer changes required: this is purely additive.

### Phase 2: Rename + restructure materializers

Breaking change, but blast radius is 3 files.

- [ ] **2.1** Rename `createMarkdownMaterializer` → `attachMarkdownMaterializer` in `packages/workspace/src/document/materializer/markdown/materializer.ts`.
  - Signature: `(ydoc: Y.Doc, { dir, ...opts })`: drop `{ tables, kv, whenReady }` bag.
  - `.table(table: Table<T>, config?)` instead of `.table(name: string, config?)`.
  - `.kv(kv: Kv<T>)` instead of `.kv()`.
  - Register `ydoc.once('destroy', teardown)` inside factory; remove exported `[Symbol.dispose]` from the builder.
- [ ] **2.2** Same refactor for `createSqliteMaterializer` → `attachSqliteMaterializer`. Pull `definition` from `table.definition` instead of requiring it in input. **Also fix a pre-existing bug**: the current `.table()` takes `tableConfig?: TableMaterializerConfig`: not generic over `TName`: so `fts: ['title']` isn't narrowed to `keyof Row`. Markdown's `.table()` already does this correctly; mirror its pattern. New signature:
  ```ts
  table<TRow extends BaseRow>(
    table: Table<TRow>,
    config?: { fts?: (keyof TRow & string)[]; serialize?: ... },
  ): MaterializerBuilder;
  ```
- [ ] **2.3** Update top-level barrel exports: `packages/workspace/src/document/index.ts` and `packages/workspace/src/index.ts`.
- [ ] **2.4** Update JSDoc examples in both materializer modules to show the new signature.

### Phase 3: Port call sites

- [ ] **3.1** Update `playground/opensidian-e2e/epicenter.config.ts`: switch both materializers to the new shape.
- [ ] **3.2** Port `materializer.test.ts`: was already a straggler on `createWorkspace`; now ports directly to the new `attachMarkdownMaterializer` signature. Use `using` or `afterEach` for disposal via `ydoc.destroy()`.
- [ ] **3.3** Port `sqlite.test.ts`: same pattern with `attachSqliteMaterializer`.
- [ ] **3.4** Fix `packages/workspace/scripts/yjs-benchmarks/persistence-growth.ts`: replace dead import path `'../../src/workspace/index.js'` with `'../../src/index.js'`. Unrelated to materializers but lumped for the same "finish the cleanup" commit.

### Phase 4: Documentation

- [ ] **4.1** Rewrite `.agents/skills/attach-primitive/SKILL.md`. The "Materializer variant" section currently calls materializers a special case with a different input shape; after this redesign they're regular `attachX(ydoc, opts)` primitives. Rewrite accordingly AND add newcomer-onboarding content:
  - **Mental-model sentence at the top**: "Think of primitives as *dependencies on the Y.Doc's lifecycle*. Attaching means: do setup now, hook teardown for later."
  - **ASCII diagram** showing the build-closure flow (`ydoc → tables/kv → materializers/sync`) with ordering constraint: materializers take `Table<T>` refs that must exist in scope.
  - **"Why input shapes differ"** paragraph: `attachIndexedDb(ydoc)` vs `attachTables(ydoc, defs)` vs `attachSqliteMaterializer(ydoc, { db }).table(tableRef, cfg)`. Rule: `ydoc` is always first (destroy-hook); after that, inputs depend on what the primitive *creates* vs. *observes*.
  - **Worked end-to-end example** readable top-to-bottom without needing to open other files.
- [ ] **4.2** Update `.agents/skills/workspace-api/SKILL.md` (if it mentions materializers) to the new API.

## Edge Cases

### Materializer attached pre-hydration (empty tables)

1. `attachSqliteMaterializer(ydoc, { db })` runs inside `defineDocument` build closure: before IDB/sync have hydrated.
2. `.table(tables.posts)` registers observer; `table.getAll()` returns `[]` at DDL time.
3. Initial bulk-load writes nothing; DDL runs.
4. IDB hydrates later → Y.Map emits events → observer fires → upserts flow through the debounced observer path (`debounceMs: 100`).
5. Final state matches hydrated tables. One transaction per debounce window instead of one bulk transaction: acceptable for initial hydration.

### Materializer attached post-hydration (populated tables)

1. Caller awaits `idb.whenLoaded` before calling `attachSqliteMaterializer`.
2. DDL + `table.getAll()` grabs full state in one transaction.
3. Observer handles subsequent deltas.

### Ydoc destroyed mid-initialization

1. `ydoc.destroy()` fires before `whenFlushed` resolves.
2. Teardown sets `isDisposed = true`, clears timeouts, unsubscribes observers.
3. Any in-flight DB operations resolve/reject naturally; observer upserts no-op when `isDisposed`.
4. Final DB state may be partial: that's fine; the materializer is derived data, not source of truth.

### Ydoc destroyed, materializer still referenced

1. `handle.ydoc.destroy()` runs: destroy handler fires.
2. Caller's reference to the materializer builder still works syntactically but `.table(...)` on a post-destroy builder is a no-op.
3. We may want to throw on post-destroy `.table()`: open question.

## Open Questions

1. **What happens to `[Symbol.dispose]` on the builder?**
   - Options: (a) keep as escape hatch for early teardown; (b) remove entirely: `ydoc.destroy()` is the only trigger.
   - **Recommendation**: (b). Uniformity with other primitives; callers who want early teardown destroy the ydoc. But note: materializers often outlive the ydoc in tests (test creates one ydoc, wants to close materializer between assertions): if that pattern matters, keep (a) as a non-idiomatic escape hatch.

2. **Should `.table()` after destroy throw, or silently no-op?**
   - Options: (a) throw `"materializer destroyed"`; (b) silently return the builder (Symbol.dispose idiom).
   - **Recommendation**: (a). Explicit error catches caller bugs; there's no legitimate reason to register a table on a destroyed materializer.

3. **Should `attachTables` migrate to return a fake-plural bag (per-table name) vs restructure entirely?**
   - Currently returns `{ posts: Table, notes: Table }`. Each Table carries its own name. This phase doesn't need to change `attachTables`: the return shape is fine.
   - **Recommendation**: Don't restructure; just expose `name` on each Table.

4. **Does materializer need `observe` directly on ydoc (for transaction-level events) or only `table.observe` (per-table)?**
   - Current sqlite uses `table.observe` exclusively. No ydoc-level listeners.
   - **Recommendation**: Keep `table.observe` only. If a future use case needs ydoc-level events, add it then.

5. **Is the markdown per-table config the right shape?** Currently `{ dir?, serialize, deserialize }` where `serialize` returns `{ filename, content }`. Two smells:
   - `serialize` conflates filename choice with body formatting. A clean split would be `{ filename: (row) => string, body: (row) => string }`.
   - `serialize` → `{ filename, content }` and `deserialize` takes `{ frontmatter, body }`: not true inverses; shapes don't match.
   - **Recommendation**: Out of scope for this redesign. Note as future work; the registration mechanism is orthogonal to the per-table config shape.

## Success Criteria

- [ ] `attachSqliteMaterializer(ydoc, { db }).table(tables.posts, ...)` compiles and runs.
- [ ] `attachMarkdownMaterializer(ydoc, { dir }).table(tables.posts, ...).kv(kv.settings)` compiles and runs.
- [ ] `Table<TRow>` exposes `name` and `definition`; `Kv<T>` exposes `name`.
- [ ] `ydoc.destroy()` triggers materializer teardown (observers unsubscribed, timeouts cleared) with no caller-side `[Symbol.dispose]()` needed.
- [ ] `materializer.test.ts` passes without `createWorkspace`: using `new Y.Doc` + `attachTables` + `attachMarkdownMaterializer`.
- [ ] `sqlite.test.ts` passes with the same pattern.
- [ ] `playground/opensidian-e2e/epicenter.config.ts` uses the new shape and `epicenter start playground/opensidian-e2e` continues to work.
- [ ] `persistence-growth.ts` benchmark script runs (unrelated import-path fix bundled).
- [ ] `packages/workspace` and `packages/cli` type-check clean (excluding any pre-existing unrelated stragglers).
- [ ] `attach-primitive` skill updated: "Materializer variant" section no longer describes a variant; it's just another primitive.

## References

- `packages/workspace/src/document/attach-indexed-db.ts`: canonical attach primitive (40 lines, reference shape).
- `packages/workspace/src/document/attach-sync.ts`: network variant with `whenConnected`.
- `packages/workspace/src/document/attach-table.ts:144-210`: current `Table<TRow>` type to extend.
- `packages/workspace/src/document/attach-kv.ts:60+`: current `Kv<TDef>` type to extend.
- `packages/workspace/src/document/materializer/markdown/materializer.ts`: rewrite target.
- `packages/workspace/src/document/materializer/sqlite/sqlite.ts`: rewrite target.
- `playground/opensidian-e2e/epicenter.config.ts`: consumer call site.
- `.agents/skills/attach-primitive/SKILL.md`: doc to update once redesign lands.
- Deepwiki Yjs reference: https://deepwiki.com/yjs/yjs: provider conventions + observer patterns.
