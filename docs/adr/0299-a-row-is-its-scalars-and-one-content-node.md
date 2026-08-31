# 0299. A row is its scalars and one content node

- **Status:** Superseded
- **Superseded by:** [ADR-0309](0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md). The shape decided here is unchanged and is restated there in the settled vocabulary: a row is its `id`, its values, and one node at `content`. Withdrawn: the words `scalars` and `prose` for the two kinds of field, including this record's own title.
- **Date:** 2026-08-30
- **Supersedes:** [ADR-0296](0296-rich-content-is-a-declared-field-and-a-table-owns-its-file-codec.md) at the codec's signature and at how rich content is declared. Its content rules are retained: one `<table>/<rowId>.md` per row, scalars as frontmatter, codec output as the body, `kv.json` beside them.
- **Amends:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) by fixing the count at one.
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md), [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md)

## Context

ADR-0296 gave a table a list of type fields and one whole-row file codec:
`serialize` took a row and returned a file, `deserialize` took a file and
returned a row. Two problems followed from that signature, and both were
visible in the only two codecs that existed.

**The codec had to prove values it never examined.** `deserialize`'s return
type was `NewRowOf<T>`, a fully typed row. A codec that passes frontmatter
through verbatim has no way to prove that, so both codecs in the repo ended in
an assertion. Replacing the assertion with hand-written per-field checks made
it worse: the checks restate the field schemas, and refusing a row on a bad
value turned one hand-edited file into a failed import of a person's entire
folder, which is exactly what ADR-0125 and ADR-0240 exist to prevent.

**`NewRowOf` served two callers with different needs.** Its `Partial<TypesOf>`
existed for `create`, which never passes a body and gets one minted empty. A
codec restoring a row from a file must produce the node. The permissive caller
set the type, and the strict one paid with the cast.

Underneath both: the codec was written in terms of a row, when the only thing
in it that a table actually knows is what its live node means.

## Decision

**A row is its `id`, its scalars, and exactly one live node at the reserved key
`content`.** A table declares its scalars and how its content node becomes the
text below the fence.

```ts
type ContentCodec = {
  encode: (node: Y.Type) => string;
  decode: (text: string) => Result<Y.Type, ContentError>;
};

notes: defineTable({
  title: field.string(),
  pinned: field.boolean(),
  createdAt: field.instant(),
  content: markdown(noteSchema),
})
```

Four refusals carry the decision.

**The frontmatter keys are the field names.** A table cannot rename a field on
its way to the file. The field name is already the durable attribute key in the
document (`row.setAttr(name, value)`), so renaming a field already orphans
stored, synced data; a file-level rename would only add a second durable name
for one thing, each unable to tell when it stopped matching the other.

**A row holds one node.** One file has one region below the fence, and an
export that could not write a second node would be losing data rather than
formatting it. Every table in the repository holds one. If a row ever needs
two, the export layout grows to a directory per row, which is a change to every
folder anyone has exported, not a change to a type.

**Every table declares its codec, and there is no default.** A `Y.Type` in v14
carries a sequence and attributes at once, so rendering one as text is not
universally safe. Measured on `@y/y@14.0.0-rc.24`: feeding `toString`'s output
back through `insert` turns one attribute into one literal string in the
sequence, and the two print identically. A default would have round-tripped
`packages/chat`'s message log into rubble while every rendered comparison
passed. `plainText()` is a codec a table opts into, not a fallback.

**No value is checked on the way in.** `decode` refuses text it cannot parse
and nothing else. Conformance stays one decision, made once, at read, for every
row from every direction, because import is not the only door: a peer on a
newer release syncs rows this one cannot name.

## Consequences

The node is **always present**, minted with the row, whether or not anything
writes to it. `RowOf<T>` is `{ id, content: Y.Type }` intersected with the
static values of every top-level scalar field, with no conditional and no
optionality anywhere in the lens.

Benched against `@y/y` directly, three arms over identical rows (no node, an
unwritten node, a written node):

| rows | no node | unwritten | written |
| --- | --- | --- | --- |
| 1,000 | 54.8 B/row | 63.8 | 85.8 |
| 10,000 | 56.8 | 65.8 | 87.8 |
| 100,000 | 58.8 | 67.8 | 89.8 |

**An unwritten node costs 9 bytes per row, flat at every scale**, against 31
for a written one. Time is +21 ms on 388 ms at 100,000 rows. The bench is about
twenty lines and easy to rebuild, so it is recorded here rather than kept.

Minting on first write would save those 9 bytes and cost correctness: reading
`row.content` on an unminted row would have to either generate operations and
sync them, or hand back a detached node that accumulates writes in a prelim
delta and **reads as empty** until integration, which is the trap
`evidence/detached-type.test.ts` already pins.

What this deletes: `RowFileCodec`, `RowFileCodecOf`, `RowValues`, `RowFile`,
`TypesOf`, `NewRowOf`, `RejectScalarCollision` (a mapped type over a tuple
carrying its error sentence in the element position, now a reserved-key
comparison), the duplicate-type-name check, `defineData`'s throw for a table
with type content and no codec, `packages/skills`'s generic codec factory, and
both assertions. The public table shape is one flat map: there is no `scalars`
wrapper and no `types` array.

The rule that a table with rich content must declare a codec stops being
enforced and starts being true: a codec is part of declaring a table.

`parseData` still accepts a definition with no codec, because it also reads an
app bundle's `database.json` and JSON cannot carry a function. What a missing
codec costs is still paid at the artifact boundary, where a node with content
and no codec is a refusal in both directions.

Executed as a clean break. Honeycrisp is on the store today with no users, so
the attribute key moved from `body` and `messages` to `content` with no
migration.
