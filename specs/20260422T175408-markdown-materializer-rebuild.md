# Markdown Materializer `rebuild` Action

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: (target: braden-w/document-primitive or successor)

## Overview

Add a `rebuild` mutation to `attachMarkdownMaterializer` that clears the output directory and re-materializes every registered table + optional KV from the workspace source of truth. Matches the shape of sqlite's `rebuild` action.

## Motivation

### Current State

The markdown materializer exposes `push` and `pull` as `defineMutation` actions. `pull` re-serializes every valid row, but it **doesn't remove orphaned files**: a file left on disk from a row that was later deleted stays forever.

Sqlite's `rebuild` doesn't have this problem because its full-load runs inside a `DELETE` → `INSERT` transaction:

```ts
// sqlite.ts: rebuild() semantics
await db.run(`DELETE FROM ${name}`);
await fullLoadTable(name, table);
```

Markdown has no equivalent. There's no way to force a clean reconciliation between Yjs state and the on-disk mirror.

### Problems

1. **Orphan accumulation.** Delete a row → observer fires `unlink` (works). But if observers were disconnected (e.g., app crashed mid-sync, materializer was attached with a stale filter), the orphan stays.
2. **Config changes don't retro-apply.** Change the `serialize` function → new rows use new format, existing files stay in the old format. `pull` doesn't overwrite orphans-by-name, only valid rows.
3. **No "start clean" primitive.** Tests / scripts currently work around this by `rm -rf ./data && pull()`. Clunky and not CLI-accessible.

### Desired State

```ts
const result = await materializer.rebuild({ table: 'posts' });
// → { deleted: 3, written: 17 }

const allResult = await materializer.rebuild({});
// → { deleted: 8, written: 42 }
```

## Research Findings

### Comparison with sqlite

| Concern                        | sqlite                      | markdown (today)            | markdown (proposed)       |
| ------------------------------ | --------------------------- | --------------------------- | ------------------------- |
| "Drop and re-materialize"      | `rebuild(tableName?)`       |: (absent)                  | `rebuild({ table? })`     |
| Orphan cleanup                 | atomic via SQL transaction  | observer-driven unlink only | rm subdirectory + re-pull |
| Per-table vs. all              | both                        | n/a                         | both                      |
| Action shape                   | `defineMutation` with input | n/a                         | `defineMutation` with input |

### Implementation sketch

```ts
// Inside attachMarkdownMaterializer factory
async function rebuildImpl(tableName?: string) {
  const baseDir = await resolveDir();
  let deleted = 0;
  let written = 0;

  const targets = tableName
    ? [registered.get(tableName)].filter(Boolean) as RegisteredTable[]
    : [...registered.values()];
  if (tableName && targets.length === 0) {
    throw new Error(`rebuild: "${tableName}" not registered`);
  }

  for (const entry of targets) {
    const directory = join(baseDir, entry.config.dir ?? entry.table.name);
    // Clear any existing files
    try {
      const files = await readdir(directory);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        await unlink(join(directory, f));
        deleted++;
      }
    } catch { /* directory doesn't exist yet: fine */ }
    // Re-pull
    await mkdir(directory, { recursive: true });
    const serialize = entry.config.serialize ?? defaultSerialize;
    for (const row of entry.table.getAllValid()) {
      const result = await serialize(row);
      await writeFile(join(directory, result.filename), result.content);
      written++;
    }
  }

  return { deleted, written };
}

// Surface as action
rebuild: defineMutation({
  title: 'Rebuild markdown files',
  description: 'Delete existing .md files and re-serialize all valid rows',
  input: Type.Object({ table: Type.Optional(Type.String()) }),
  handler: ({ table }) => rebuildImpl(table),
}),
```

## Design Decisions

| Decision                     | Choice                                          | Rationale                                                |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Verb                         | `rebuild`                                       | Matches mental model ("rebuild the index") and doesn't collide with `rebuild` (sqlite). Alternatives: `rebuild`, `resync`, `refresh`: `rebuild` fits markdown-as-index-of-rows best. |
| Scope                        | `{ table?: string }`: per-table or all        | Mirrors sqlite `rebuild`.                                |
| KV handling                  | Always re-materialize KV if registered          | KV is a single file; always safe to overwrite. Could add `{ includeKv?: boolean }` if over-eager, but YAGNI for now. |
| Orphan detection             | `unlink` every `.md` in the target subdirectory | Aggressive but simple. Alternative: track written filenames and only unlink orphans: more complex, same end state. |
| Behavior on unregistered table | Throw                                         | Matches sqlite's rebuild behavior; catches caller typos. |
| Return shape                 | `{ deleted: number; written: number }`          | Symmetric with `push`'s `{ imported, skipped, errors }` and `pull`'s `{ written }`. |
| Input schema                 | `Type.Object({ table: Type.Optional(Type.String()) })` | Same as sqlite rebuild. Keeps surfaces parallel.  |
| Lifecycle                    | Callable any time after `whenFlushed` resolves  | No special gate: caller sequences however they want.    |

## Architecture

```
Caller
  │
  ▼
materializer.rebuild({ table?: 'posts' })    [defineMutation]
  │
  ├── if table given: validate it's registered
  │
  ├── for each target table:
  │     ├── readdir → unlink every .md
  │     ├── mkdir -p target dir
  │     └── for each row in getAllValid(): serialize + writeFile
  │
  └── return { deleted, written }
```

Non-atomic. If the process crashes mid-rebuild, the output dir may be partially wiped. That's fine: rerunning the same command cleans up.

## Implementation Plan

### Phase 1: Core rebuild

- [ ] **1.1** Add `rebuildImpl(tableName?: string)` function inside `attachMarkdownMaterializer`. Iterates registered tables (or a single one), removes `.md` files, re-writes from `getAllValid()`.
- [ ] **1.2** Add `rebuild` action to the `api` object via `defineMutation` with `input: Type.Object({ table: Type.Optional(Type.String()) })`.
- [ ] **1.3** Throw on `table` argument that doesn't match a registered table name: use the same error-string convention as sqlite's `rebuild`.

### Phase 2: Tests

- [ ] **2.1** Test: rebuild removes orphan files and rewrites existing valid rows.
- [ ] **2.2** Test: rebuild with `table` argument only touches that table's subdirectory.
- [ ] **2.3** Test: rebuild throws on unknown table name.
- [ ] **2.4** Test: rebuild is idempotent (running twice produces identical filesystem state).
- [ ] **2.5** Test: rebuild after `config.dir` change updates files in the new subdirectory (and: open question: leaves the old dir or cleans it up?).

### Phase 3: Documentation

- [ ] **3.1** Update JSDoc on `attachMarkdownMaterializer` to list `rebuild` alongside `push` / `pull`.
- [ ] **3.2** Add a note to the attach-primitive skill that materializers expose `rebuild`-style reset actions for orphan cleanup.

## Edge Cases

### Output directory doesn't exist

1. Caller has never written to disk (materializer constructed but `whenFlushed` hasn't resolved).
2. `readdir` throws ENOENT.
3. Catch, continue: `deleted: 0`. `mkdir -p` creates it, writes proceed.

### Row has custom `serialize` returning non-existent filename

1. `pull` had generated `abc.md` under the old serialize.
2. Config swapped to a serialize that now returns `xyz.md`.
3. rebuild: `unlink abc.md` (as orphan), write `xyz.md`. Correct.

### Process crash mid-rebuild

1. Some old files unlinked, no new writes yet.
2. Filesystem is in a valid-but-incomplete state.
3. Rerun rebuild → fully consistent.

Not atomic; callers who need atomicity should use sqlite, not markdown.

### Subdirectory change between runs

1. Table config's `dir` was `posts`, now `blog`.
2. rebuild under new config: reads only `blog/`, writes `blog/`, leaves `posts/` as orphan directory.
3. **Open question**: should rebuild recognize the old dir? Unclear how (config history isn't tracked).

## Open Questions

1. **What should `rebuild` do about the subdirectory if `config.dir` changed since last flush?**
   - Options: (a) ignore: only touch current dir; (b) accept a `cleanDirs?: string[]` input to nuke old paths; (c) store a registry of "dirs written to" and clean them all.
   - **Recommendation**: (a). Caller who changes `dir` can `rm -rf` the old one themselves. Keep rebuild predictable.

2. **Should `rebuild` include KV?**
   - Options: (a) always include when registered; (b) add `includeKv?: boolean` (default true); (c) add a separate `rebuildKv` action.
   - **Recommendation**: (a). KV materialization is cheap (one JSON file); no need to gate.

3. **Is `rebuild` semantically different from `pull` + orphan-sweep, or should `pull` itself sweep orphans?**
   - Rewriting `pull` to always sweep would be a breaking behavior change: current callers rely on `pull` being additive.
   - **Recommendation**: Keep distinct. `pull` is idempotent-additive; `rebuild` is destructive-clean.

4. **Return shape:** `{ deleted, written }` vs `{ removed, written }` vs reusing `push`'s `{ imported, skipped, errors }`?
   - **Recommendation**: `{ deleted, written }`. `deleted` is precise; `written` matches `pull`'s return.

## Success Criteria

- [ ] `materializer.rebuild({})` removes all `.md` files in the base dir's table subdirectories and re-creates them from `getAllValid()`.
- [ ] `materializer.rebuild({ table: 'posts' })` only touches `posts/`.
- [ ] Passes `epicenter run <export>.materializer.rebuild` via the CLI dot-path surface.
- [ ] Throws with a helpful error on unregistered table names.
- [ ] 4+ new tests pass covering: orphan removal, single-table scope, unknown-table throw, idempotence.

## References

- `packages/workspace/src/document/materializer/markdown/materializer.ts`: target for new action.
- `packages/workspace/src/document/materializer/sqlite/sqlite.ts:190-225`: `rebuild` action for the pattern to mirror.
- `packages/workspace/src/document/materializer/markdown/materializer.test.ts`: where new tests go.
- `.agents/skills/attach-primitive/SKILL.md`: skill doc for the noting in phase 3.
