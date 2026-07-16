# 0123. Bounded metadata uses record authority; merge-sensitive state uses lazy child documents

- **Status:** Superseded
- **Date:** 2026-07-11
- **Superseded by:** [ADR-0124](0124-workspace-documents-are-top-level-parameterized-resources.md)
- **Relates:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md), [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md), [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md)

## Context

The record plane gives Epicenter a complete, typed, directly queryable SQLite
replica. Its server authority resolves concurrent assignments to one cell by
acceptance order. That is the right cost for bounded metadata, but it is the
wrong algebra for values where independent contributions must survive: a
counter, collaborative text, rich prose, or a nested structure edited at
independent keys.

Putting those values into more record fields would either lose intent or force
the record protocol to grow a configurable family of counters, sets, sequences,
and merge policies. Putting every value into Yjs would give small metadata the
history, memory, and eager-loading costs that the SQLite record plane exists to
avoid.

## Decision

The merge unit chooses the storage plane. Store a value in records when
server-ordered replacement of the whole cell preserves acceptable intent. Use
a child document when independent edits inside one value must survive and
converge.

This ADR owns storage placement and the lazy child-document lifecycle.
[ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md)
owns the underlying record-cell replacement semantics and persisted field
vocabulary.

The record authority owns bounded, queryable metadata whose cells may be
replaced atomically. Merge-sensitive state lives in a separately addressed,
lazily loaded Yjs child document. A record may carry the child document's stable
identity and summary metadata, but it does not mirror the child's live state or
pretend to resolve its operations.

Choose a child-document capability from the concurrency semantics:

- Use `document.plainText` for collaboratively edited plain text or code.
- Use `document.xmlFragment` for editor-owned document structure. The raw XML
  fragment does not claim a canonical rich-text node vocabulary.
- Use `document.keyed(schema)` for a bounded keyed collection whose independent
  entries should compose and whose complete values conform to one runtime
  schema.

Applications do not author raw `Y.Text`, `Y.XmlFragment`, or `Y.Map` layouts in
table definitions. A distributed counter is deliberately absent from the
catalog. It must earn a framework-owned capability after a product specifies
writer identity, decrement and reset behavior, precision, and compaction.
Ordinary collections that need row-level creation, patching, querying, and
deletion remain record tables; a keyed child document is not a second default
table system.

Child documents use the existing child-document identity, persistence, and sync
lifecycle. They are loaded when a surface opens the content, not as part of the
complete metadata replica. Their provider stores and relays Yjs updates; it does
not reinterpret them through the record authority's server-order conflict rule.

## Consequences

- The complete SQLite replica stays bounded and directly queryable while large
  or merge-sensitive state is paid for only when opened.
- Schema authors decide whether replacement is acceptable before choosing a
  storage primitive. A UI label such as "counter" or "todo list" is not enough;
  the required concurrent operations decide the model.
- Large values do not automatically become child documents, and offline use
  does not require Yjs. Records already work offline; a child document earns
  its cost only when edits below the cell boundary must compose.
- Server-order replacement remains one honest rule for record cells. Yjs owns
  the smaller set of values where commutative or structural merging is worth its
  memory, history, persistence, and lifecycle costs.
- Record queries may use deliberately maintained summaries such as a title,
  preview, or approximate count. Those summaries are projections, not a second
  authority for the child document.
- A grow-only counter accumulates one component per durable writer. Products
  with unbounded writer churn, deletion, reset, exact audit, or transactional
  invariants must define compaction and domain semantics rather than treating
  the map pattern as a universal numeric field.
- Cross-plane operations are not automatically atomic. A command that must
  update a record and a child document as one invariant needs an explicit owner
  and recovery protocol; application code must not assume one SQLite/Yjs
  transaction spans both planes.

## Considered alternatives

- **Add merge policies to record fields.** Rejected: this turns one record
  protocol into a configurable CRDT framework and multiplies wire, snapshot,
  migration, and editor behavior.
- **Store every value in Yjs.** Rejected: bounded metadata loses direct SQLite
  storage and pays CRDT costs without earning collaborative semantics.
- **Use one shared numeric cell for a counter.** Rejected: concurrent
  read-modify-write increments contend on the same key and can lose a
  contribution.
- **Use `Y.Doc.clientID` as permanent application identity.** Rejected: it is an
  instance identifier, not a durable replica identity.
- **Use child documents as generic tables.** Rejected: record tables already own
  queryable collections. Child documents are the deliberate escape hatch for
  merge-sensitive content, not a parallel application database.
