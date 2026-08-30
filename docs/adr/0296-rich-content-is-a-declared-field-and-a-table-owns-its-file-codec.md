# 0296. Rich content is a declared field and a table owns its file codec

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the codec's signature and placement. Its content rules are retained: one `<table>/<rowId>.md` per row, scalars as frontmatter, codec output as the body, `kv.json` beside them.
- **Amends:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) by naming how a rich field is declared and serialized.
- **Relates:** [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md), [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md), [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md)
- **Unbuilt:** the "must declare `file`" rule is enforced at `defineTable`'s
  parameter type and again at `defineData`, which is the authoring boundary. It
  is deliberately NOT enforced in `parseData`: that same function reads an app
  bundle's `database.json`, and JSON cannot carry a function, so a codec's
  absence there says nothing. What a missing codec costs is paid at the
  artifact boundary, where an uncoded body is a refusal in both directions.

## Context

Once a row's rich content lives in the row (ADR-0295), the separate `document`
declaration block has nothing left to point at. It existed because the body was
a different Yjs document with its own address, handle, and lifecycle.

Yjs 14 removed the type classes. There is no `Y.XmlFragment`, `Y.Text`, or
`Y.Map`: one `YType` is simultaneously map, list, and rich text
(`@y/y@14.0.0-rc.24`, `ytype.js:681`), and `Doc.get(key, name)`'s second
argument is an optional node name rather than a constructor. So "prose" is a
fact about a codec and an editor binding, not about storage, and a field
declaration that names a concrete rich-text class would be inventing a
distinction the engine no longer makes.

Separately, the artifact needs an owner for two different problems. Frontmatter
is fully described by the declaration and the platform can guarantee its
round-trip. The body is not: the same `Y.Type` becomes different Markdown under
different ProseMirror schemas, and a folder written by another tool carries
frontmatter that only the application knows how to coerce.

## Decision

**A rich field is declared like any other field, and the table declares one
codec for its file.**

```ts
notes: defineTable({
  fields: {
    title:  field.string(),
    pinned: field.boolean(),
    body:   field.type(),
    agenda: field.type(),
  },
  file: { serialize, deserialize },
})
```

`field.type()` declares that the attribute holds a nested `Y.Type`. It surfaces
in `RowOf<T>` as `Y.Type` where a scalar field surfaces as its JSON type. There
is no reserved key, no `document` block, and no limit on how many a table
declares.

**The platform owns the file format; the table owns the mapping.** The platform
splits the fence, parses the frontmatter into a record, and joins it back. The
codec maps that record and the body text to and from a row:

```ts
type RowFile = {
  data:    Record<string, JsonValue>   // frontmatter, parsed
  content: string                      // everything below the fence
}

file: {
  serialize: (row: Row) => RowFile

  deserialize: (
    file:  RowFile,
    types: { body: Y.Type; agenda: Y.Type },   // minted, attached, empty
  ) => Result<{ title: string; pinned: boolean }, RowFileError>
}
```

**Scalars are returned; rich fields are filled in place.** The asymmetry is
forced by the engine, not by taste. A detached `Y.Type` accumulates its edits in
a single prelim delta replayed at `_integrate` (`ytype.js:922-928`), and a delta
is positional: it describes edits against the state it was computed against.
Measured on `14.0.0-rc.24`, one operation survives and more than one does not.
`insert(0, ['hello ']); insert(6, ['world'])` throws `Exceeded content range`
from `formatText`; a child built with two inserts throws; `push` twice returns
silently reordered content. A Markdown-to-ProseMirror conversion is inherently
many sequential writes, so the codec must be handed a type that is already
attached. This is an RC, and it may be a defect rather than a design; a future
version that fixes it does not by itself justify reopening the signature.

**The platform validates what `deserialize` returns against the declaration**
before writing it. The codec decides how to read a file; the declaration still
decides what a row is, and a returned value of the wrong type is reported through
the existing nonconforming machinery.

**A table that declares any `field.type()` must declare `file`.** A table with no
rich field may omit it and exports its scalars as frontmatter with an empty body.

**The codec must be idempotent after the first pass.**
`serialize(deserialize(x)) === x` for anything the codec itself produced. Losses
on foreign Markdown are accepted (ADR-0268); losses on the codec's own output
are not, because every generation is born from an import and a lossy round trip
degrades a database each time it is minted.

## Consequences

- The `document: { derive, file }` block is deleted, and with it `derive`,
  `DocumentDeclaration`, `DocumentReader`, and the parse rule refusing a document
  without a file codec.
- A row may carry any number of rich fields, and the artifact layout does not
  branch: the table's codec composes them into one body and parses them back.
- `deserialize` runs once per row for every database that will ever exist, since
  import is the only way a generation comes into being. It is rare in frequency
  and absolute in role, which is an argument for testing it directly.
- A folder written by another tool can be imported, because the codec sees the
  parsed frontmatter and can coerce it. Under the previous rule those files were
  simply nonconforming.
- The platform can no longer guarantee frontmatter round-trip by construction; it
  guarantees instead that a mismatch is reported. A codec that drops a declared
  field is visible rather than silent.
- `field.type()` says what is true of storage and nothing more. An application
  that wants prose, an outline, or a table gets the same declaration and differs
  only in its codec and its editor binding.

## Considered alternatives

- **`field.prose({ file })`, one per table, platform composes the body.**
  Refused. It names a use Yjs 14 does not distinguish, and it forces a refusal
  (one rich field per table) that moving the codec to the table does not need.
- **A reserved `!document` or `content` slot.** Refused. It makes rich content
  categorically special at the moment the engine stopped treating it that way,
  and it burns a field name or reintroduces a reserved namespace with no other
  member.
- **The codec owns the whole file, including YAML.** Refused. Every application
  would reimplement frontmatter parsing and the platform could no longer tell a
  malformed file from an application-specific one, which matters more here than
  usual because import is the birth path.
- **`deserialize` constructs and returns the `Y.Type`s.** Refused on
  measurement, not principle; see the prelim-delta finding above.
- **`deserialize` returns engine-free deltas for the store to apply.** Refused
  for ergonomics. It is the purest shape and it depends on the ProseMirror
  binding being able to emit a delta with no target type, which is unverified.
