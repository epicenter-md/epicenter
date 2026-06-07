# Matter

A grid view over a folder of markdown files. Each `.md` file is a row, its
frontmatter is the typed columns (declared in `matter.json`), and the body is the
one rich field.

> **One line:** Rust is a race-free, schema-blind streamer of file changes over a
> caller-supplied channel; TypeScript owns all meaning and funnels every change,
> external or self-inflicted, through a single path into the grid and a disposable
> SQLite mirror.

## The catch: you are not the only writer

Agents, `git`, and your own text editor all edit these files too. So the app
cannot "read the folder once", it has to stay live as the folder changes
underneath it. The naive read-then-watch approach has a famous bug:

```
read folder ────▶ [✏  someone edits a file HERE] ────▶ start watching
                       (this change happened after the read and
                        before the watch: it is lost, silently)
```

Read first, watch second, and any edit in that gap vanishes. The grid is then
permanently wrong until some unrelated edit happens to refresh it.

## How Rust closes the race (`src-tauri/src/watch.rs`)

`watch_folder` does the three steps in the safe order, inside one command:

```
watch_folder(path, channel):
  1. ARM the watcher        ← nothing can slip through after this point
  2. SCAN the folder        ← the "seed": current contents
  3. SEND the seed on the channel
  → return a watch id
```

Arming before scanning means any edit during the scan is already captured. The
race is gone by construction, not by luck.

**The key choice: the `Channel` is passed _into_ `watch_folder`.** The frontend
hands Rust a pipe, and Rust pushes both the seed and every later change down that
same pipe. There is no separate "subscribe" step that could run too late and miss
the seed.

> This is also why the IPC layer uses `ts-rs` (type-only codegen) and not
> `tauri-specta`: tauri-specta cannot type `Channel<T>`, and switching to
> broadcast events would reopen exactly this subscribe-then-emit race.

After the seed, Rust is a dumb, faithful byte-streamer. On a change it:

- waits **100ms** (debounce) to let a burst settle,
- dedups by filename,
- reads each changed file fresh,
- sends a `FileDelta[]` batch, where each delta is self-contained:
  `content` (the bytes), `removed`, or `unreadable`.

Rust never learns what a "column" or a "schema" is. All meaning lives in
TypeScript. `FileDelta` is the one wire contract, defined once in Rust and
generated into `src/lib/bindings/FileDelta.ts` by `ts-rs` (run `cargo test` in
`src-tauri` to regenerate), so the two sides cannot drift.

## How TypeScript consumes it (`src/lib/vault.svelte.ts`)

Every batch, from the seed and from every later change, flows through one
function:

```
channel batch ─▶ applyDeltas(deltas)
                   ├─ mutate the `files` SvelteMap   → grid repaints instantly
                   └─ setTimeout(reconcileMirror, 0) → rebuild matter.sqlite after paint
```

One funnel, one store, two projections of it. The **view** is the in-memory,
reactive, editable one (`read`: a pure `$derived` that classifies each row against
the loaded model); it drives the grid. The **mirror** (`matter.sqlite`) is the
on-disk, disposable, queryable one you can run raw SQL against, from an
**out-of-process** reader (a coding agent) or in-app (see [Querying](#querying-the-mirror)).
The mirror is rebuilt as a full `DROP + CREATE + INSERT` so it is always a pure
function of the folder, never a drifting incremental cache, and deferred off the
paint task because a large projection should never delay the grid.

## The twist: the app's own edits

When you edit a cell, the app writes the file to disk. Originally it then waited
for that write to echo back through the 100ms watcher before the grid updated, a
visible lag. Now it short-circuits:

```
your edit ─▶ atomic write ─▶ on success: feed the bytes into applyDeltas yourself (instant)
                             the watcher's later echo re-applies identical bytes (harmless)
```

So the mental model is clean:

- **Your edits** are applied immediately by the writer itself.
- **Everyone else's edits** arrive through the watcher.
- Both land in the same `applyDeltas` funnel, so the grid and the SQLite mirror
  never care where a change came from.

Writes are **read-modify-write** (read the freshest bytes, transform in JS, write
atomically) so a concurrent external edit to a _different_ field is preserved, not
clobbered. Writes to one file are **serialized** (`serializeWrite`) so two quick
edits to the same file cannot interleave their read-modify-write and drop one.

## Querying the mirror

The mirror is read-only from the app's side: one Rust command, `query_mirror`, opens
`matter.sqlite` `SQLITE_OPEN_READ_ONLY`, runs a caller-supplied `SELECT`, and returns
generic `{ columns, rows }` (capped by an optional `limit`, or every row when omitted).
Read-only means a query can never mutate the disposable mirror; `busy_timeout` lets it
wait out an in-flight rebuild. Rust stays schema-blind: it runs the statement and hands
back values it never interprets.

Two surfaces ride that one command:

- **The WHERE filter** (folder header): you type a predicate like
  `status = 'ready' and word_count > 500`; the page calls `vault.matchingNames(clause)`
  (which runs `SELECT "name" FROM "<folder>" WHERE <your clause>`) and hands the grid the
  matched row names, which the grid intersects to narrow its live rows, still typed, still
  editable. The filter is owned by the page (where the live vault is), not the grid,
  so the grid never holds a query engine, it just renders the rows it is told to. It
  matches only valid rows (the only ones in the mirror); invalid rows are the separate
  "needs attention" axis.
- **A SQL console** (planned): the full `SELECT ...` shown as a raw result table,
  for aggregations and for seeing exactly what an agent sees.

The filter is debounced and re-runs when the data changes, so a small lag exists
between editing a value and a row leaving or entering the filtered set: the value
updates instantly, only set membership waits for the reconcile plus the re-query.

## Invariants worth protecting

- The grid never blocks on `matter.sqlite`; the index is a pure side channel.
- The store equals disk after every settled write (apply only on success).
- Switching folders never lands a write for the wrong folder (the path is
  captured per vault).
- `matter.sqlite` is a pure function of the folder's valid rows; an unmodeled
  folder has no typed table.

## Where things live

| Concern | File |
| --- | --- |
| Live vault: funnel, store, writes, queries, watch lifecycle | `src/lib/vault.svelte.ts` |
| Folder watcher + race-free seed (Rust) | `src-tauri/src/watch.rs` |
| Atomic read/write of one entry (Rust) | `src-tauri/src/entry.rs` |
| `matter.sqlite` mirror: write + read-query executor (Rust) | `src-tauri/src/mirror.rs` |
| Wire contract, generated from Rust | `src/lib/bindings/FileDelta.ts` |
| Classify rows against the model | `src/lib/core/folder.ts` |
| Project valid rows to SQL | `src/lib/core/sqlite.ts` |
| Parse one `.md` entry / the model | `src/lib/core/parse.ts` |
| The grid UI | `src/lib/components/FolderGrid.svelte` |
| Page: vault lifecycle + the WHERE filter | `src/routes/+page.svelte` |

## Developing

```sh
bun run tauri dev      # desktop app (talks to Tauri directly, no platform seam)
cargo test             # in src-tauri: runs Rust tests AND regenerates FileDelta.ts
bun run typecheck
```
