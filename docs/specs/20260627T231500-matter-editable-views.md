# Matter editable views

State: In Progress

## Thesis

Matter's invariant is "disk is truth," not "views are read-only." The grid already
writes markdown through a pure, per-file-serialized primitive
(`editField` -> `write` -> `write_entry` -> watcher rebuild). The grid is just the
first caller. So a view reads the same in-memory classified rows the grid renders and
writes edits back through the *same* `saveField`/`saveBody`.

## Doctrine (ADR-0101)

Views are a **family of native typed-row projections** over the schema (board over a
select field, calendar over a date field, gallery over an image field), but each view
type earns its persisted spec surface **serially**: no view type enters `matter.json`
until its renderer is being built, because a spec authored before its renderer guesses
the shape wrong and then locks the guess into user config.

- **This wave is board-only.** Board goes first because it is the cheapest complete
  proof of an editable projection: the simplest renderer (columns of cards), the
  simplest write (drag writes a select value verbatim), and it funds the one-time
  pattern cost (per-table view routing, the switcher, a read-only field renderer,
  view -> `saveField` -> optimistic settle) that every later view inherits.
- **Calendar is the presumptive next native projection.** It is deferred, not
  rejected. It re-enters as an additive `ViewSpec` union member, spec'd fresh against
  its real renderer; expect a shape closer to `dateField + titleField + summaryFields`
  than the deleted Wave 1 guess (`card[]`), which drifted from what a card surface
  actually needs. The month/week chrome, day-overflow, and date-shaping write
  semantics are the real cost; the persisted spec and `bucketRowsByDate` grouping
  (~30 pure lines, recoverable from git) never were.
- **Form is not a view.** Create/edit should return as a **schema-derived capability**:
  the contract already fully determines a form (fields, kinds, `required`, `check`),
  so a create sheet renders straight off the contract with no persisted `form` spec.
  The real cost is the create-mode field components and a `createEntry` primitive
  widened through the table handle; pay it once, when the capture pipeline actually
  needs creation. `buildNewEntry`/`slugifyStem` were built and tested in the original
  Wave 1 and are recoverable from git history.
- **Custom/long-tail views** (map, bookshelf, anything outside typed schema
  projections) belong to a later agent-authored HTML surface, not new native code.
  See "Deferred."

## Ground truth (verified against code; do not re-derive)

- Contract (`packages/matter-core/src/core/contract.ts:68`): `Contract = { fields: ContractField[]; untyped; unmatchedOptional; searchable; views; viewErrors }`. `parseContract` only classifies; field resolution is in `validateContract`. A `{}` / no-`fields` marker returns `{ kind: 'untyped' }` with NO `Contract` object. Tests assert `{"views":...}` on an untyped table stays untyped; preserve that.
- Field kinds (`packages/field/src/field.ts:172`): `string reference integer number boolean date instant datetime url select multiSelect tags json`. Each `Field` carries `.check(value) => boolean`; the contract precompiles it.
- Write primitives (`apps/matter/src/lib/table.svelte.ts`): private `write(fileName, edit)`, `saveField(fileName, key, value)`, `saveBody(fileName, body)`, per-file lock `serializeWrite(fileName, run)`. `write` applies its own bytes to memory synchronously on success. **The grid receives only the narrowed `TableView = Pick<TableHandle, 'folderName'|'read'|'saveField'|'saveBody'>`; it has NO folder path and NO create primitive.**
- Read: `query_mirror(root, sql, limit?) -> { columns, rows }` (`src-tauri/src/mirror.rs`). `buildStemQuery` emits `SELECT "stem"` only; `runQuery` maps rows to stems. `createTableQuery` owns interactive `where`/`match`/`toggleSort` -> `orderedStems`, debounced 200ms.
- Rows reach the grid as in-memory CLASSIFIED rows: `TableGrid` renders `view.conformance` cells, looked up by stem in the order `orderedStems` gives. Frontmatter values live ONLY in these in-memory rows, never in the mirror result.
- Field rendering: `FIELD_COMPONENTS[kind]` renders AND edits one existing cell. There is no read-only renderer and no create/draft mode.
- Route axes are split. `?table=X` picks the table. `?view=Y` picks a
  table-scoped projection from that table's `contract.views`; absent `?view`
  means grid. `?panel=sql|db` picks a vault-wide panel that eclipses the table
  pane. During implementation, rename `VaultView` to `VaultPanel`.
- Path safety: `write_entry`/`read_entry` reject `file_name` containing a separator or `..` (`safe_file_name` in `src-tauri/src/entry.rs`, landed with the e2e harness wave).

## Design

### A view = classified rows in, `saveField` out

```
order/filter: mirror -> orderedStems (existing createTableQuery)
rows:         in-memory classified rows (view.conformance), looked up by stem
render:       per view.type, grouping board rows with groupRowsByField over the
              in-memory rows, plus a new read-only renderer for card display
save:         gesture -> saveField(`${stem}.md`, column, value)  // identical to grid
settle:       optimistic from in-memory write (NOT the mirror; mirror is debounced)
```

Crucial correction from review: the board groups and settles off the **in-memory
rows** with `groupRowsByField`, because the mirror only returns stems and its
re-query is debounced ~200ms. A view that re-grouped from SQLite/mirror rows
would visibly snap a dragged card back. The mirror is used only to order/filter
the stem list.

### `matter.json` gains a `views` array (typed tables only)

Additive, optional. Parsed in `validateContract` so it can see field kinds. A `views`
key on an untyped (`{}`) table is ignored and the table stays untyped. A malformed
entry is dropped with a `ViewError` diagnostic; the grid and valid views still work.
Unknown `type` values degrade per-entry, which is exactly how a future view type stays
backward-compatible with older builds.

```jsonc
{
  "fields": { "status": { "enum": ["idea","drafting","edited","scheduled","posted"] },
              "publish_at": { "type": "string", "format": "date-time" },
              "platform": { "type": "string" } },
  "views": [
    { "id": "pipeline", "type": "board", "groupBy": "status",
      "columns": ["idea","drafting","edited","scheduled","posted"],
      "card": ["title","platform"], "query": { "sort": { "column": "publish_at", "dir": "asc" } } }
  ]
}
```

### matter-core surface (Wave 1, built)

`packages/matter-core/src/core/view.ts`: `ViewSpec` (board-only union), `ViewError`,
`parseViews(raw, fields)` (slug-safe unique ids; `groupBy` kind must be
select/string/reference; `card` names must be real fields; `query` is the grid's own
`StemQuery` shape), and `groupRowsByField(rows, groupBy, columns) -> BoardBucket[]`
(declared columns first and present even when empty; stray values get trailing
buckets; absent/null rows land in a trailing Unassigned `null` bucket). A drop writes
its bucket's `value` through `saveField`; `null` clears (the nullish contract), and
the caller guards allowed values with `field.check` before writing.

`Contract` carries `views: ViewSpec[]` and `viewErrors: ViewError[]`. The grid never
reads `views`.

### Field surfaces

- In-place edit of an EXISTING row's cell (board card expanded): reuse the current
  editors via `FIELD_COMPONENTS` + `saveField`. No change.
- Read-only card display (`card` fields on a board card): NEW `<FieldValue
  {kind} {value}>` component, or equivalent props object `{ kind, value }`.
  It formats a value per kind and owns no controls. It does not take a `Cell`;
  board cards already have the row's raw frontmatter value and the field kind.
  The current widgets are editors; they cannot be reused read-only.

### Per-table view routing

Resolve `?table=X&view=Y` against the ACTIVE typed table's `contract.views` (not
a single global list). Unknown or absent `?view` means grid. The switcher row is
rebuilt per active typed table from its `contract.views` (by `title ?? id`).

Refuse one overloaded `?view` param for both vault panels and table projections.
`?view` is the projection axis. `?panel=sql|db` is the vault-wide panel axis.
This avoids collisions with board ids such as `sql` or `db`, keeps route helpers
honest, and leaves future calendar projections on the same table-scoped axis as
grid and board.

## Waves

- Wave 0 (done): harden `write_entry`/`read_entry` against traversal. Rust unit test.
- Wave 1 (done, board-only): `view.ts` + `Contract.views`, parsed in
  `validateContract`, untyped tables unaffected. Bun unit tests. No UI.
- Wave 2: route param split (`?view` for table projections, `?panel=sql|db` for
  vault panels), pure surface resolver, switcher sourced from the active typed
  table's `contract.views`, `<FieldValue {kind} {value}>`, and a read-only board
  renderer grouped from in-memory rows with `groupRowsByField`. Grid stays
  default and UNCHANGED. No calendar or form implementation enters this wave.
- Wave 3: add drag/write to the board through `saveField`, with optimistic
  settle. This is the first user-visible editable view and the proof point for
  the whole doctrine.

Each wave ships alone. Nothing beyond Wave 3 is scheduled by this spec; later views
are new specs under the ADR-0101 doctrine.

## Testing

Stack today: `bun test` pure-function tests; Rust `cargo test`; the Playwright
`mockIPC` + cargo integration harness from the e2e wave (`bun run test:matter`,
`bun run test:e2e` in `apps/matter`). No tauri-driver on macOS, so the real
disk -> watcher -> mirror loop stays covered by the cargo integration test plus
manual Tauri smoke.

- Wave 1: bun unit on `parseViews` (valid/invalid/degrade, untyped-table ignore) and
  `groupRowsByField`. Done.
- Wave 2 acceptance (manual + harness): select a board view on Pipeline -> cards
  render in columns from the in-memory classified rows; selecting `?panel=sql`
  or `?panel=db` opens the vault-wide panel without occupying the table
  projection namespace; an unknown or absent `?view` renders grid.
- Wave 3 acceptance (manual + harness): drag a card on Pipeline -> `status:` in that
  file changes on disk -> reopen preserves it; a bucket value outside the `status`
  enum is rejected with no write; a malformed `views` entry drops that view and
  surfaces a contract error while the grid still works. The board drag e2e reuses the
  existing Playwright write-assertion pattern (`window.__E2E_WRITES__`).

## Deferred

- **Calendar view**: presumptive next native projection; new additive `ViewSpec`
  member + fresh spec once its renderer is scheduled. See Doctrine.
- **Schema-derived create/edit surface**: not a view type. Needs `createEntry`
  widened through the table handle (filename from a slugged title + timestamp,
  through `serializeWrite`) and create-mode field components; validate drafts with a
  resurrected `buildNewEntry`. Build when the capture pipeline needs it.
- **`ViewSurface` extraction** (grid + views behind one interface): only after board
  AND a second view exist and the shared shape is observed. Refactoring the grid
  first, with no component regression harness, is high risk for zero user value.
- **Agent-authored sandboxed HTML views**: the escape hatch for views outside typed
  schema projections (maps, bookshelves, bespoke dashboards). Later spec. Reuses the
  edit primitives but adds a typed postMessage broker (no raw writes, no path into
  the iframe), capability grant in `matter.json` (never in the HTML), `sha256(html)`
  pinning (injected rewrite -> read-only), and a write journal for undo. Matter's
  asymmetric advantage over the Hubble.md precedent is `matter.query(sql)` + typed
  column-scoped writes instead of read-all-files. Do not build until native editable
  views prove demand.
