# Matter (typed markdown folder editor)

**Date**: 2026-06-04
**Status**: Draft (grilled: self + Codex; co-designed to model-first: data / model / layout)
**Owner**: Braden
**Confines**: `20260602T200000-vault-read-only-projection-agent-mutation.md` (read-only projection applies only inside declared regions; mechanism deferred)
**Reuses**: closed PR #1897 `wiki-page-body-write-actions` (lift the lens + `ColumnSpec.schema` = raw `TSchema`), `packages/workspace` `column.*` (authoring) + `deriveStorage` / `isNullable` from the `column.* -> SQLite` materializer

## One Sentence

Open a folder of markdown, give it a model, and see every file sorted into valid, invalid, and unparseable against that model, fixing any cell in place, in a table (later board and calendar) view, where for your drafts "valid" means "ready to publish."

## How to read this spec

```
Read first:
  One Sentence
  The three layers (data / model / layout)
  Conformance (valid / invalid / extra / unparseable)
  The KINDS registry
  Requiredness and emptiness (one axis: nullable or not)
  Conformance (compile per column, classify per cell) + Rendering (the widget floor)
  Implementation Plan

Read if changing the architecture:
  Design Decisions
  Materialized SQLite
  Round-trip identity (never mangle)
  Edge Cases

Deferred (designed, not built in v1):
  board / calendar / gallery views, the TS DSL, read-only regions, wiki absorption
```

## The three layers

The product is model-first. Inference exists only as an on-ramp to a model, never as the foundation.

```
markdown files = data        the truth. never mangled.
matter.json    = model       the contract: each field is a JSON Schema. NEVER gates a write.
(deferred)     = layout       views (order / width / hidden / sort / filter) return with board/calendar; v1 layout is ephemeral.
```

`matter.json` is one folder-local file with both concerns kept as separate keys:

```jsonc
// folder/matter.json  : app-, agent-, and raw-editable. JSON is canonical (no eval).
{
  "fields": {                                            // field name -> JSON Schema (the column.* subset)
    "title":  { "type": "string" },                      // required by default (no null in the schema)
    "status": { "type": "string", "enum": ["draft","published","archived"] },
    "tags":   { "type": "array", "items": { "type": "string" } },
    "url":    { "anyOf": [ { "type": "string", "format": "uri" }, { "type": "null" } ] }  // nullable = null in the schema
  }
}
```

### Why JSON is canonical (and where it stops)

The app's UI edits the model, agents edit it, you edit it raw. JSON round-trips through all three with **no eval step**; a `.ts` file needs a bundler or the bun daemon and cannot be safely UI-rewritten.

```
JSON Schema handles the DECLARATIVE parts     it stops at LOGIC (-> optional TS DSL, later)
  type / format / enum / null per field         computed fields (wordCount from body)
  app + agent + UI all edit it                  custom validators, derived columns
```

The optional `defineMarkdownModel({ fields: { title: column.string() } })` DSL is authoring sugar that compiles to this JSON and is the only place logic could ever live. Not needed for v1. Caveats: the model is app-owned and comment-free (the app rewrites it); a hand-authored `.ts` and UI-editing cannot both own the same model.

### Each field IS a JSON Schema (the column.* subset)

The at-rest truth is a plain JSON Schema per field, the same artifact `column.*` produces. There is NO `{kind}` descriptor and NO `buildColumnSchema` deserializer: TypeBox 1.0 `Schema.Compile` validates a stored JSON Schema directly (`~kind` is for introspection, not validation). `kind` is DERIVED from the schema's shape, never stored.

```
authoring (any of)         at rest (the one truth)                derived (3 pure readers)
column.string()            { "type":"string" }                    deriveKind     -> UI cell/editor
column.enum / `enum` kw     { "type":"string","enum":[…] }         Schema.Compile -> validate (conformance)
UI add-column popover       { "type":"string","format":"uri" }     deriveStorage  -> SQLite column
```

`column.*` (or the native `enum` keyword, or the UI popover, or the later TS DSL) is an AUTHORING path that emits the schema; the runtime only reads the schema. This matches `apps/wiki` (`ColumnSpec.schema` is the raw `TSchema`, no `kind` field). Field name = the frontmatter key; no separate id; optional `title` annotation overrides the display label.

## Conformance (the core job)

The app's job, stated once: **show me how this folder conforms to its model, and let me fix what doesn't.** Each file is classified against the model:

```
VALID         every present value satisfies its field's schema; every required field is present;
              a nullable field (schema admits null) may be empty (absent key OR explicit null both read as empty)
              -> the main grid. projects cleanly into SQLite.   == getValid() == SELECT * FROM <folder>
INVALID       a required (non-nullable) field is empty, OR a present value fails its schema
              -> a "Needs attention" section. kept verbatim, EDITABLE IN PLACE, never deleted/rejected.
UNPARSEABLE   conflict markers / broken YAML
              -> a "Can't read" section. the grid NEVER writes it; opens raw.

EXTRA (orthogonal)   frontmatter keys not in the model. a VALID or INVALID row may have them.
              -> a per-row "•••" expander + a folder-level "unmodeled keys" nudge ("add to the model?").
              -> always allowed; never affects validity (an extra key never blocks publish-readiness).
```

Three rules keep this honest:

```
1. the model NEVER gates a write.  you can always save a draft missing its title; it just shows as INVALID.
2. validity is a property of (data x model), NOT of the data.  change the model and rows reclassify;
   files never change.  prefer the label "Needs attention" over "Invalid".
3. required by DEFAULT; a field is empty-OK only if its SCHEMA admits null (the `anyOf`-with-null shape).
   no silent "optional" middle state: a bare field must be present + valid, or you put null in its schema.
```

It must stay an EDITOR, not a linter: clicking an invalid cell fixes it in place. A read-only conformance report is something you run; this is something you live in.

## The KINDS registry (schema -> UI, the app's renderer)

`kind` is not stored; it is what the UI layer DERIVES from a schema to pick a renderer. The registry is an ORDERED list of recognizers, each pairing a `match(schema)` shape test with a cell + editor:

```ts
const KINDS = [
  { match: s => s.enum !== undefined,                            cell: EnumCell,   editor: EnumEditor },
  { match: s => s.type === 'boolean',                            cell: BoolCell,   editor: BoolEditor },
  { match: s => s.type === 'integer' || s.type === 'number',     cell: NumberCell, editor: NumberEditor },
  { match: s => s.type === 'string' && s.format === 'uri',       cell: UrlCell,    editor: UrlEditor },
  { match: s => s.type === 'string' && s.format === 'date-time', cell: DateCell,   editor: DateEditor },
  { match: s => s.type === 'string',                             cell: StringCell, editor: StringEditor },
  { match: s => s.type === 'array',                              cell: ChipsCell,  editor: ChipsEditor },
];
// deriveKind(schema) = unwrap nullable, then KINDS.find(k => k.match(schema)) ?? jsonFallback
```

This is the inversion of control: the data contract (the schema) never names a widget; the APP decides. `deriveKind` first UNWRAPS a nullable (an `anyOf` containing `{type:'null'}` -> recurse on the non-null branch, carry a nullable flag), then walks the list, falling back to the read-only `json` cell for any shape `column.json()` emitted. An optional inline `x:widget` keyword (preserved by TypeBox, ignored by `Value.Check`) overrides the match when one schema needs two looks; `format` already covers the value-semantic cases (uri, date-time), so this is deferred. Adding a kind = one recognizer row + one `column.*`/native authoring shape.

**Inference uses the SAME schemas, never a parallel predicate.** A value's kind is the narrowest `column.*` schema whose `Schema.Compile(s).Check(v)` passes; "what is a datetime" has ONE definition (the schema), shared by the inferred preview and conformance, so they cannot drift.

```
register the 'uri' / 'date-time' formats first, or column.url / column.dateTime are no-ops that accept EVERY string
  (so every string would infer 'url'). Increment 1 uses conservative regex stand-ins until the formats are registered.
enum and string stay OUT of the inference lattice: string is the floor that always matches; enum is opt-in, never
  inferred (a string set infers as 'string'; you opt in, and it harvests the column's distinct values).
```

`array` is a composable wrapper (`{type:'array', items: <kind schema>}`, rendered as chips); `json` is the read-only fallback for any non-scalar `column.json()` shape. Nullability lives IN the schema (the `anyOf`-with-null shape, what `column.nullable` emits), not as a flag, and is the SAME primitive the CRDT path uses (no `Type.Optional`), so `packages/workspace` and `constraint.ts:91` are untouched.

## Requiredness and emptiness: one axis, not two

JSON Schema has TWO independent axes for "can this be empty," and conflating them is what made earlier drafts complicated:

```
axis          question                       mechanism
PRESENCE      must the KEY be present?        the object's `required[]` array (Type.Optional removes a key from it)
VALUE-NULL    may the VALUE be null?          a null member in the value union (column.nullable)
```

A general object can mix all four combos (present+nonnull, present+null, absent+nonnull, absent+null). Matter does NOT need that surface. It COLLAPSES the presence axis by treating an absent key and an explicit `null` identically (one nullish check, per field). The author never touches presence. That leaves exactly ONE knob, the value axis:

```
bare field        column.X()                   null NOT allowed  -> "must have a value"  (== required)
nullable: true    column.nullable(column.X())  null allowed      -> "may be empty"
```

So "required" is not a flag or a presence rule. **Required just means "not nullable."** Empty is an absent key or an explicit `null` (nullish), and the nullable knob alone decides: a non-nullable field treats empty as INVALID ("needs attention"), a nullable field treats it as VALID (empty cell). Absent and explicit-null land on the same cell.

The asymmetric win: refusing the one rare combo (key-may-be-absent-but-must-be-non-null-when-present, meaningless when markdown omits keys freely) deletes an entire axis, `Type.Optional`, the `required` flag, AND the missing-key-vs-wrong-type error split. `column.nullable` becomes the ONE emptiness primitive for both substrates, so `packages/workspace` and `constraint.ts:91` (bans optional keys in CRDT rows) are untouched.

```
at rest (the schema)                                                    SQLite
url value     { "type":"string","format":"uri" }                        TEXT NOT NULL
url nullable  { "anyOf":[ {"type":"string","format":"uri"}, {"type":"null"} ] }   TEXT (nullable)
              ^ isNullable sees the null branch -> drop NOT NULL; deriveStorage reads the non-null type -> TEXT
```

The stored schema feeds `deriveStorage` (non-null `type` -> TEXT/INTEGER/REAL) and `isNullable` (a `null` branch -> drop `NOT NULL`) directly, per field. Same nullable shape the CRDT path uses, so `packages/workspace` and `constraint.ts:91` are untouched.

Inference honors this: a field present in every file -> bare/required; missing from some files -> the nullable shape, so "Create model from folder" never invalidates the folder it just modeled.

## Conformance = compile per column, classify per cell

Build and compile each field's validator ONCE when the model loads, then check every cell against the precompiled validator. Do NOT rebuild a schema inside the row loop (schemas are per COLUMN, not per cell).

```
// once, on model load (the stored schema IS the artifact, no rebuild):
cols = Object.entries(fields).map(([name, schema]) => ({
  name, nullable: isNullable(schema), check: Schema.Compile(schema).Check,   // typebox/schema; JIT, CSP auto-fallback
}))

// per cell (the 3-way split the renderer needs):
v     = frontmatter[name]
state = v == null ? (nullable ? EMPTY : NEEDS_VALUE)    // absent OR explicit null (one nullish check)
                  : check(v) ? OK : INVALID
row valid = every cell OK or EMPTY
extras    = keys(frontmatter) \ keys(fields)            // "..." expander; never affects validity
```

The `v == null` branch is NOT a smell to remove: it is the genuine three-way split (EMPTY vs NEEDS_VALUE vs INVALID) the renderer needs, and TypeBox cannot express "absent" for a bare value (`Check(undefined)` just fails, collapsing empty and invalid). What WAS a smell, now fixed, was building the schema per cell.

This ADAPTS the wiki lens (`apps/wiki/src/lib/workspace/lens.ts` match/missing/excess) with ONE deliberate change: the lens decides "missing" via `Object.hasOwn` and validates an explicit `null` if present; Matter treats absent and `null` as the same empty (nullish), because a bare `title:` in YAML parses to `null` and must mean the same as an omitted `title`. That equivalence is a tested contract (`title:` empty scalar == absent == EMPTY).

No `buildColumnSchema`, no descriptor: the stored schema IS the validator's input (`Schema.Compile(schema)` directly). The parser only has to ACCEPT the schema (reject shapes outside the supported subset, with diagnostics) and ensure the `uri` / `date-time` formats are REGISTERED before any check (else `column.url` / `column.dateTime` silently pass every string).

SQLite (increment 4) derives PER FIELD too: `deriveStorage(schema)` -> TEXT/INTEGER/REAL and `isNullable(schema)` -> nullability, assembled into `CREATE TABLE` by a thin matter-owned emitter. NO `deriveCheck` and NO composed object schema: the projection is read-only and inserts only rows that already passed `Check`, so a SQL CHECK constraint would guard nothing (and `deriveCheck`'s nullable-enum bug at `derive.ts:77` never arises). Validation lives in exactly one place.

No fill, in memory OR on disk: the file stays sparse. Clearing a cell REMOVES the key (it never writes `null`); a no-op read/write preserves an existing `key: null` verbatim. See "Round-trip identity".

Caveat (Class 1): the `uri` / `date-time` formats only enforce if registered in TypeBox's `FormatRegistry` on Matter's path; otherwise `column.url` / `column.dateTime` accept any string. Register before increment 2 (already flagged in 2.1).

## Rendering conformance: the widget floor

The editor surface follows one rule: **raw editable text is the floor; the typed widget is an upgrade you get only when the field is modeled AND the current value is valid.** Every cell state falls out of it.

```
                         | present & valid       | present & invalid        | absent
-------------------------+-----------------------+--------------------------+----------------------------
modeled field (in model) | typed widget          | raw text + error badge   | required: empty widget + "required"
                         | (date / enum / url)   | (keep bad value, edit    | nullable: empty widget, no badge
                         |                       |  until it validates)     |
-------------------------+-----------------------+--------------------------+----------------------------
extra field (unmodeled)  | raw text, no error    |      impossible          |      impossible
```

Why each cell is forced, not chosen:

```
invalid value -> raw text   the value is outside the widget's domain (an enum dropdown can't show
                            status: "bananna"); raw text preserves it so you can fix the typo, then
                            it snaps back to the widget once it validates.
absent        -> widget     you still know the type from the model, so show the empty typed widget
                            (empty date picker), nicer than a blank box.
extra         -> raw text   no model = no widget = no validity rule; raw text is the only honest option.
```

### The three tiers (rows that line up vs rows that cannot)

Columns come from the MODEL, not the row, so every PARSED row is rectangular against the model no matter how broken it is. Only unparseable files cannot be placed in columns.

```
unparseable   broken YAML / conflict markers          -- cannot be a row; SEPARATE list, opens raw file
invalid       parses; a required field is empty or a value is bad  -+ SAME table, same columns;
valid         every required field has a valid value               -+ invalid rows just carry error decoration
```

Default to ONE table for valid + invalid with per-cell error styling and a row-level flag (fix in place, sort/filter across all). The "Needs attention" cleanup view is a LENS over that same table (a filter), not a different layout. Extras live in a per-row "..." expander / side sheet as raw key:value editors, never as table columns.

## Inference is the on-ramp, not the foundation

No `matter.json` in a folder:

```
show an inferred PREVIEW table (YAML types + light string refinement: date? url?)
banner: "No model for this folder"
action: "Create model from folder"  -> writes matter.json from the discovered frontmatter
```

This keeps the zero-config first impression without making inference the source of truth. Inference is thin (the YAML parser already gives number/boolean/string/list; refinement only touches strings) and deterministic (same files -> same preview).

### The on-ramp invariant (may under-claim, never over-claim)

```
inferValueKind(v) = k   ⟹   Schema.Compile(schemaFor(k)).Check(v)
```

Inference is allowed to fall to `string`; it is never allowed to suggest a kind whose schema would reject the value. The trap this rules out is concrete: a bare `date: 2026-06-04`, the most common frontmatter shape, is **not** a `datetime`. `column.dateTime` is full RFC 3339 and rejects the bare date. If inference claimed `datetime`, "Create model from folder" would write a model that instantly marks every one of those rows invalid: the on-ramp invalidating its own folder. So a bare date, and any looser timestamp (space separator, missing offset, no seconds), infers as `string`. Only a full instant (`2026-06-04T10:30:00Z`) infers `datetime`.

A dedicated `date` kind is deferred, not refused. It arrives as a full vertical slice (`column.date` in the shared library + cell + editor + classify) alongside the calendar view, rather than as a half-member that only inference can produce.

## Materialized SQLite (the query surface and the definition of valid)

Each view materializes a SQLite table you can query with raw SQL. It also gives `valid` its precise meaning: a row is valid iff it projects into the typed table. 1:1:1:

```
model field   ⟷   grid column   ⟷   SQLite column
     kind ─ column.* ─ derive.ts / materializer/sqlite/ddl.ts ─▶ SQLite type + CHECK   (EXISTING, reuse)
table per folder:  { path PK, ...typed columns..., _extra JSON of unmodeled keys }
```

Reuse the `column.* -> SQLite` derivation (`packages/workspace/src/document/{column/derive.ts, materializer/sqlite/ddl.ts}`); write a thin file-driven projector, skipping the Yjs log/room writer. **Derived + disposable** (delete -> rebuild from files), **read-only** (SELECT; mutations go through editors -> markdown). `getValid()` is `SELECT * FROM <folder>`. SQL write-back is a separate hard problem, deferred.

## Round-trip identity (by value, never mangle)

> Read a file, write it back with no user edit -> VALUE-identical. The frontmatter is the typed-column layer the app normalizes; the body is the one rich field, preserved byte-for-byte.

Frontmatter is columns, so the app OWNS its formatting and re-emits it canonically (eemeli `yaml` `stringify`, NOT a CST splice). This is the deliberate clean break from surgical byte-preservation: "frontmatter is columns" and "byte-identical frontmatter" are in tension, and the column reading wins. The write reads a FRESH parse of disk (not the projection), edits one field, and re-emits.

```
write mechanism              canonical re-serialize from a fresh parse: parseMarkdown(disk) -> edit the
                             frontmatter object -> serializeEntry(frontmatter, body). Body verbatim.
frontmatter formatting       NORMALIZED on save (key order = disk order; a set key appends). Comments,
                             exact quoting, whitespace, trailing zeros are NOT preserved (they are prose;
                             prose belongs in the body). Blast radius = only files you actually edit.
value identity               a parseable file round-trips to the SAME values (YAML 1.2 core, no Norway
                             coercion). That is all a typed table needs.
invalid-against-the-model    a bad-vs-model value (`status: bananna`, `duration: "1240s"`) is still a valid
                             YAML scalar -> survives by value, shown INVALID, editable in place. Only
                             UNPARSEABLE files lose, and the grid NEVER writes those (so no regression).
unknown / unmodeled key      preserved on write (it is just a key in the object; never dropped)
empty / absent field         clearing DELETES the key (never `key: null`); an existing `key: null` round-trips
body vs frontmatter          strict separation; editing one never touches the other
```

## Architecture: live vault, unidirectional flow

A plain Tauri + SvelteKit app. **Not** a workspace app: no `createWorkspace`, no Yjs, no relay, no auth, no session.

The folder on disk is the ONE source of truth, and other processes write it (your editor, agents, git). So the app is not a one-shot read: it holds a live projection driven entirely by a native watcher. The client `SvelteMap` is **pure derived state**, the only thing that mutates it is a delta from the watcher. Even the app's own edits come back through that path.

```
WRITE (a fire-and-forget command):
  edit a cell/body -> read_entry (FRESH disk bytes) -> parse -> edit one field
                   -> serializeEntry(frontmatter, body) (canonical, in JS) -> write_entry (atomic)
                      NEVER mutate the SvelteMap directly. The map is the read-side projection,
                      never a write-side source (so a stale projection can't clobber a fresh disk edit).

READ (the only path that mutates the map):
  disk change -> native watcher (notify) -> debounce + dedup -> ONE Channel, delta batch
              -> applyDeltas -> SvelteMap.set / .delete -> $derived classify -> UI
```

The one editing exception to "everything is one-directional derived from the file": an OPEN editor cell/body owns a local draft (a keystroke buffer for a stateful session, detached from the projection while open, committed on change). It is the single justified island of local state; everything closed is pure projection.

This is CQRS-shaped: writes are commands to disk; the map is a projection. There is exactly one way the UI state changes, so "what the UI shows" provably equals "what is on disk." No dual-write, no drift.

### The native watcher protocol (Rust = a faithful byte-streamer)

One Rust command owns the whole live-folder protocol; Rust never knows what a column or schema is.

```
watch_folder(path, channel) -> watchId
   1. arm the notify debouncer BEFORE scanning      (closes the read-then-watch race)
   2. emit current contents as the first delta batch (the seed; same path as updates)
   3. stream a debounced batch per change            (~300ms; dedup by basename within the tick)
unwatch_folder(watchId)                              (drop the handle = stop the OS watch)

FileDelta (serde tagged union; maps 1:1 to a SvelteMap op):
   { kind: content,    name, text }   -> map.set(name, parseEntry(text))   (content shipped WITH the change; no re-read)
   { kind: removed,    name }         -> map.delete(name)
   { kind: unreadable, name }         -> map.set(name, <Can't read>)        (a bad file is a DELTA, not a stream failure)
```

Parse + classify stay in JS, because the model (schema-as-truth, `deriveKind`, conformance) is one TS source of truth, shared with the write path. Rust ships bytes; JS interprets them.

### Two refinements considered and REFUSED

Both were in earlier drafts; both fail the "earn its keep" test.

```
echo policy   REFUSED. "Remember the hash, drop the matching echo" is incompatible with the invariant:
              the map mutates ONLY from a delta, so for the UI to reflect your own write the echo MUST
              apply. Dropping it leaves the projection STALE (it never learned the write landed), which is
              the very desync it claims to prevent. The "stomp an in-progress edit" worry is an EDITOR
              concern (the open cell owns its draft), not a watcher concern. So: no suppression, the echo
              flows through (idempotent), drafts protect in-progress edits.
batch seq     REFUSED. A JS-side batch counter only detects Channel MESSAGE LOSS, which Tauri's ordered IPC
              does not do; it does NOT detect the failure that can happen (a silently missed FS event), and
              it is redundant because every Content delta re-reads the file's CURRENT full state
              (self-healing). The honest recovery primitive, if drift is ever observed, is a manual re-scan
              (re-run the seed), trivial to add then.
```

### Lifecycle

Explicit and page-owned: `watch()` starts the watcher and returns a stop function; the page drives it with `$effect(() => vault.watch())`, so switching folders stops the old watcher. Reads (`read` / `status` / `error`) are pure getters and never start anything.

### Routes (SvelteKit)

```
/                       vault home: folder tree + recents
/[...folder]            a folder -> conformance grid (table view; ?view= later)
/[...folder]/[file]     a file -> document view (property panel + body textarea); peek over the grid
```

## Why build this and not use Obsidian Bases (honest)

Bases renders database-views over discovered frontmatter, non-enforcing. The typed-table feature is not the differentiator. Matter is worth building only because it is: (1) open and ownable, code-extensible `KINDS` registry, agent-editable JSON, vs a closed plugin; (2) a **conformance / publish-readiness** view (validate a folder against a contract, group by ready/broken) that Bases does not do; (3) the authoring front-end of the capture-to-post pipeline; (4) on a path to real-time collaboration file-level sync cannot reach. If it decouples from shipping content, it is a worse, unfinished Bases.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Source of truth | 2 | markdown files; the model never enforces a write | data is truth; only side where conformance can be non-destructive |
| Model first | 2 | explicit `matter.json`; inference is the on-ramp | explicit > magic for a durable tool; gives the app a pass/fail job |
| File shape | 3 | one file, `{ fields, views }` | fewer artifacts; separation is two keys, not two files |
| Model format | 2 | JSON canonical; TS DSL optional/later | only format the UI + agents can both read and write without eval |
| Field = JSON Schema | 2 | store the raw `column.*` JSON Schema; derive kind + SQLite from it | one artifact, no `{kind}` descriptor, no `buildColumnSchema`; matches `apps/wiki` `ColumnSpec.schema`; `Schema.Compile` validates it directly |
| Conformance | 2 | valid / invalid / unparseable; extras orthogonal + ALWAYS allowed (strict mode dropped) | an extra key never blocks publish-readiness, so strict was a knob without a use case |
| Requiredness model | 2 | collapse the presence axis (absent == null, one nullish check per field); only knob is `nullable` (value-null union); "required" == not nullable; NO `Type.Optional`, NO `required` flag | one axis not two; empty needs no special primitive; reuses CRDT `column.nullable` so `packages/workspace` + `constraint.ts:91` untouched; absent and explicit-null land on the same cell |
| Conformance mechanism | 2 | compile each column's validator once (`Schema.Compile`), classify per cell (NO whole-row `Type.Object`, NO fill) | adapts the lens (absent==null nullish); per-field schemas drive classify + inference; object schema composed ONLY for SQLite DDL; `v==null` ternary is the genuine 3-way split |
| JSON Schema -> validator | 1 | TypeBox 1.0 `Schema.Compile` (typebox/schema), compiled once per column | DeepWiki-verified: `~kind` is introspection not validation; native `enum` keyword, `type` arrays, and custom annotation keywords all supported + preserved |
| Widget annotation | 2 | derive UI from schema shape; optional inline `x:widget` keyword overrides | invert control to the app; `format` covers value-semantic widgets; TypeBox preserves the keyword, `Check` ignores it; deferred until a 2nd widget per shape is needed |
| Cell rendering | 2 | raw-text floor; typed widget only when modeled + valid; invalid -> raw text + badge | the only honest render for out-of-domain values and unmodeled extras |
| Conformance views | 3 | unparseable = separate list; valid + invalid = one table + "Needs attention" filter | parsed rows are rectangular against the model; difference is decoration, not relayout |
| Materialized SQLite | 2 | per-view, read-only raw SQL (increment 4) | a capability (raw SQL) + defines validity; reuses the existing materializer |
| App shape | 2 | new lean Tauri app `apps/matter`, not folded into Fuji | two truth models in one app branch its core forever; share only leaf UI |
| Body editor v1 | 3 | textarea + whole-body save | proves the round-trip; CodeMirror/WYSIWYG later |
| Read-only regions / wiki absorption | Deferred | Deferred | no materialized region yet; introduce a storage seam from two real backends |

## Implementation Plan

**Status (2026-06-04):** Increments 1 to 3 shipped (read -> model + conformance -> edit in place), except **2.5** ("Create model from folder", deferred) and **3.3** (model-editing UI, not built). Increment 4 (SQLite) is not started. The unmodeled view is RAW (no type inference: a folder without a model shows plain text), which supersedes 1.3's "infer a preview table". See 3.4 / 3.5 for how the per-kind branching was collapsed into one `Field` registry.

### Increment 1: read (open folder -> table)

- [x] **1.1** Scaffold `apps/matter` as a plain Tauri + SvelteKit app (no workspace machinery); Tauri fs module
- [x] **1.2** Vault tree, open a folder; parse `.md` -> `Row = { path, frontmatter, body }`; graceful unparseable state
- [x] **1.3** The `KINDS` registry (read cells + `infer`); infer a preview table; deterministic order

### Increment 2: model + conformance

- [x] **2.1** Runtime `matter.json` parser/validator (`validateModel`): the top level is `{ fields: Record<name, JsonSchema> }` where each field is a raw JSON Schema (the `column.*` subset), NOT a `{kind, nullable?, values?}` descriptor; `kind` and `nullable` are DERIVED from the schema, never stored. Reject any field whose shape falls outside the supported subset (i.e. `deriveKind` resolves it to the `json` catch-all) with a diagnostic; junk (bad JSON / wrong top-level shape) degrades to the raw untyped view
- [x] **2.2** REGISTER the `uri` / `date-time` formats (add a test proving an UNREGISTERED format FAILS, else `column.url` / `column.dateTime` silently pass every string); compile each stored field schema once via `Schema.Compile`; write `deriveKind(schema)` (unwrap nullable, ordered shape-match, json fallback) for the UI registry
- [x] **2.3** Define the conformance result type (cell states `OK | EMPTY | NEEDS_VALUE | INVALID`, plus `extras`, plus `rowValid`); classify per cell against the precompiled validators (`v == null` -> EMPTY/NEEDS_VALUE; nullish unifies absent + empty scalar); adapt the lens; replace the increment-1 inference regexes with `Schema.Compile(<column.* schema>).Check` so infer and classify share one definition
- [x] **2.4** Classification UI: one table with per-cell error decoration + a "Needs attention" filter; unparseable stays a separate list; extras in the "..." expander
- [ ] **2.5** (DEFER per collapse B, pending) "No model" banner + "Create model from folder" (writes `matter.json` from discovered frontmatter)

### Increment 3: edit (fix in place)

- [x] **3.1** Inline cell editors per kind following the widget-floor rule (typed widget when modeled + valid; raw text + badge otherwise; raw text for extras); frontmatter write-back preserving unmodeled keys (fidelity per Open Q1)
- [x] **3.2** Fix an invalid cell -> the row reclassifies live; document/peek view + body textarea
- [ ] **3.3** Model editing UI: add/retype a field; `enum` harvests distinct values
- [x] **3.4** Collapse the two `kind` ladders into the single `KINDS` registry this plan keeps assuming (1.3, 2.2, Later). Inc 2 shipped it as TWO parallel ladders: the match (schema -> kind) in `matchKind` (`schema.ts`, pure + tested + Svelte-free) and the render (kind -> widget) as an `{#if}` chain in `ConformanceCell.svelte`. Adding a kind touches both, and they drift silently (forget the render branch and the kind falls through to raw text with no error). The split was deliberate, not lazy: no `editor` existed to anchor a unified row, and folding `cell` into a `.ts` registry drags `.svelte` component refs into the model layer. Inc 3 supplies the `editor` referent, so resolve it ONE of two ways: (a) one `{ match, cell, editor }` table (keep `match` in `.ts`; put the `{ cell, editor }` lookup in `.svelte` so the model layer stays Svelte-free), or (b) keep the ladders but turn `ConformanceCell`'s `{:else}` into a `kind satisfies never` exhaustiveness guard, so a new `Kind` without a branch is a compile error instead of a silent fallthrough. Prefer (b) if the coupling cost outweighs the drift risk; the whole point is that match and render can no longer disagree.
  - **Resolved (closer to (a), and stronger):** `Kind` now derives from a single ordered `KINDS` recognizer array in `schema.ts` (`type Kind = (typeof KINDS)[number]['kind']`), and per-kind render+edit lives in one `Field` component each behind `FIELD_COMPONENTS satisfies Record<Kind, FieldComponent>` (`components/fields/registry.ts`). That `satisfies` IS the exhaustiveness guard, stronger than (b)'s `kind satisfies never`: a new kind fails to compile at BOTH the registry literal and the `ModeledCell` index, not at one fallthrough. The interim (b) guard shipped first (in `ConformanceCell`), then was subsumed. `ConformanceCell` and `EditableCell` are deleted.
- [x] **3.5** Typed DISPLAY widgets that retire the raw-text floor for in-domain values. `datetime` currently `String()`s the raw ISO string at `ConformanceCell`'s `{:else}`: that is the widget floor working as designed (correct + readable), not a bug, just unformatted; inc 3 gives it a real `DateCell`. Same move for `array`: today every element renders as a plain muted chip ignoring `derivedKind.items`, so a `url[]` shows text not links and an object element shows `[object Object]`; chips should render per `items` kind. The rule is unchanged (floor for unknown/invalid; typed widget for recognized + valid). NOTE: `json` needs NO widget here, the model gate in `model.ts` rejects any json-kind field (json == "unsupported"), so a json cell never reaches the renderer; do not "fix" that unreachable path.
  - **Resolved:** each kind is a `Field` component (`components/fields/*Field.svelte`). `ArrayField` renders chips per the items kind (`url[]` -> link chips) via `deriveKind(items)`; `NumericField` serves both `number` and `integer`. The shared text-edit lifecycle is the `createCellEdit` rune helper. `INVALID` cells route to a universal `JsonRepairEditor` (kind-agnostic), so kind dispatch is gated behind validity and no `Field` handles `INVALID`. `coerce()` and the `INLINE` set are gone. STILL DEFERRED to Later: the `datetime` value widget is a plain text input (`DateTimeField` is the seam for the `NaturalLanguageDateInput` picker), and inline `array` EDITING (add/remove chips) is not built (an invalid array is editable via the repair editor).

### Increment 4: SQLite + raw SQL

- [ ] **4.1** File-driven SQLite projector reusing `column/derive.ts` + `materializer/sqlite/ddl.ts`; one table per view
- [ ] **4.2** Raw `SELECT` surface; `getValid()` == `SELECT * FROM <folder>`; rebuild-from-files yields the same table

### Later (designed, not scheduled)

- [ ] views: board (group-by status = a publishing pipeline), calendar (group-by date = a content calendar), gallery
- [ ] a first-class `date` kind (bare calendar date): `column.date` + cell + editor + classify, landing with the calendar view; until then bare dates infer as `string`
- [ ] the TS DSL (`defineMarkdownModel`) + computed/derived fields; cross-folder SQL; SQL write-back
- [ ] `strict` mode (extras-as-invalid): deferred; no use case yet (extras are shown + preserved, never block publish-readiness)
- [ ] the `x:widget` annotation (the first multi-UI-per-schema case): a `{ "type":"string" }` rendered as a single-line input by default but as a TEXTAREA when annotated `{ "type":"string", "x:widget":"textarea" }`. The schema is identical, so `deriveKind` cannot distinguish them; the inline keyword is the override. TypeBox preserves it, `Check` ignores it. Deferred until the second look is actually needed; `format` covers the value-semantic cases (uri, date-time) without it
- [ ] read-only-region enforcement; Fuji adopts the `KINDS` registry; storage seam + wiki absorption

## Edge Cases

### Draft missing its required title
Classified INVALID (not ready), but the save still succeeds and the file is untouched. The model never blocks a write.

### A value stops matching after a model change
`duration` retyped to `number` while a row holds `"1240s"` -> reclassifies to INVALID, kept verbatim, editor offers a typed replacement. The file did not change; the model did.

### YAML type coercion (the real looseness risk)
Inference and parsing lean on the YAML parser; YAML 1.1 coerces (`NO` -> false, `1.10` -> 1.1). Use a YAML 1.2 parser; round-trip identity (read-write-unchanged = value-identical) is the backstop. This, not markdown prose (the body is opaque text we never AST-parse), is where "markdown is too loose" applies to us.

### `matter.json` is junk / names an unknown kind
Falls back to the inferred preview with a non-blocking banner; unknown kinds rejected by the closed `ColumnKind` set. Deleting `matter.json` always recovers a working preview; data untouched.

### Empty scalar vs absent key (the nullish contract)
A bare `title:` parses to `null`; an omitted `title` is absent. Both classify as EMPTY (or NEEDS_VALUE if required). Tested contract, since it silently merges a common YAML authoring pattern. Clearing a cell saves as an ABSENT key (never `title: null`); a no-op read/write preserves an existing `title: null` verbatim.

### Why Matter emits no SQLite CHECK (increment 4)
The shared `deriveCheck` (`derive.ts:77`) only emits a CHECK for a top-level `anyOf`-of-`const`, so `column.nullable(column.enum(...))` would silently lose its `col IN (...)`. Matter sidesteps this entirely: the projection is read-only and inserts ONLY rows that already passed `Check`, so it emits NO CHECK (storage + nullability only). The constraint lives once, in `Value.Check` at classify. (If a writable-SQLite need ever appears, fix `deriveCheck` to unwrap the null branch upstream rather than working around it here.)

## Open Questions

1. **Frontmatter write-back fidelity** (sizes increment 3 + the round-trip invariant): byte-identical (preserve comments/order/quotes) or value-identical (canonical re-serialize)?
   - **RESOLVED (greenfield clean break): value-identical, canonical re-serialize.** The earlier "surgical" recommendation is withdrawn.

   ```
   Candidate:        surgical per-field write-back (eemeli Document-tier splice; preserve every untouched byte)
   Refusal:          "frontmatter is columns" and "byte-identical frontmatter" are in tension. A typed-column
                     layer that preserves your exact quoting/whitespace/comments is acting like a prose store.
                     The earlier refusal of canonical was based on a FALSE premise: it claimed canonical
                     "cannot preserve a bad value for raw-text editing." Untrue. An invalid-AGAINST-THE-MODEL
                     value is still a valid YAML scalar; parse->stringify keeps its value and the grid shows it
                     INVALID to fix. Only UNPARSEABLE files lose, and the grid never writes those either way.
                     The spec conflated "invalid against the model" with "invalid YAML".
   Asymmetric win:   refuse ~15% (byte preservation) to delete ~85%: the eemeli Document tier, the regex-splice,
                     two functions (setField/setBody) collapse to one serializeEntry(frontmatter, body).
   User loss:        frontmatter comments + exact formatting on files you EDIT (body comments/prose preserved;
                     untouched files never reformatted; values always identical).
   Decision:         canonical serialize FROM A FRESH DISK PARSE (keep read_entry: the file is the value owner,
                     so the write reads from the owner, not the projection; also closes the concurrent-edit race).
   Trigger to revisit: a real user with frontmatter comments / hand-tuned YAML they need byte-stable -> reintroduce
                     a CST splice behind the same serializeEntry seam (the caller does not change).
   ```

2. **Dogfood target** (grounds increment 1): point Matter at the capture-to-post drafts folder, so the first model is the post contract and `valid` = the publish queue.
   - **Recommendation**: yes; this is the weld that justifies the app.

3. **v1 scope** (resolved this session):
   - (A) APPLIED: `views` dropped from v1 -> `matter.json = { fields }`; table layout ephemeral; views return with board/calendar.
   - (B) APPLIED: "Create model from folder" deferred (plan 2.5); dogfood with a hand-authored `matter.json`.
   - (C) OVERRIDDEN, keep `array`: the dogfood drafts use `tags` / `destinations`, so `array` is load-bearing, not deferrable. Bridge = `{ "type":"array", "items": <kind schema> }`, rendered as chips (already in increment 1).

## Success Criteria

- [ ] **Inc 1**: open a folder; it renders as a table with kinds inferred (deterministic order); unparseable files degrade gracefully
- [ ] **Inc 2**: a runtime-validated `matter.json` (unknown kinds rejected) classifies files into valid / invalid / unparseable, per cell, against once-compiled validators; URL/date formats proven to enforce
- [ ] **Inc 3**: editing an invalid cell reclassifies the row live; round-trip identity holds (no-op edit = value-identical file; unmodeled keys survive)
- [ ] **Inc 4**: each view materializes a SQLite table; raw `SELECT` returns valid rows; rebuild-from-files is identical
- [ ] `deriveKind` maps every supported schema shape to one renderer (json fallback otherwise); `valid` means a row projects into the typed table

## References

- `apps/fuji/src/routes/(signed-in)/components/EntriesTable.svelte` - the TanStack Table + `@epicenter/ui` pattern to mirror
- `packages/workspace/src/document/column/sugar.ts` - the `column.*` builders (authoring path) that emit the stored field schemas
- `packages/workspace/src/document/{column/derive.ts, materializer/sqlite/ddl.ts}` - reuse `deriveStorage` + `isNullable` PER FIELD; Matter does NOT use `deriveCheck` or the whole-object `generateDdl` (read-only projection emits no CHECK)
- `packages/workspace/src/document/column/constraint.ts:91` - the guard that BANS optional keys in CRDT rows ("use column.nullable"); Matter follows the same rule, so it reuses `column.nullable` rather than introducing `Type.Optional`
- `packages/workspace/src/document/table.ts` (`parseRow`) - the whole-row `Value.Check` pattern for CRDT rows; the CONTRAST that explains why Matter classifies per-field instead (sparse files, not rectangular rows)
- closed PR #1897 `apps/wiki/src/lib/workspace/{lens,schema}.ts` - lift the lens + `ColumnSpec` (schema = raw `TSchema`, no `kind` field: the model Matter follows)
- `packages/ui/src/{table,tree-view,popover,select,natural-language-date-input}` - components for the grid and editors
- `specs/20260602T200000-vault-read-only-projection-agent-mutation.md` - the read-only-projection contract this confines
