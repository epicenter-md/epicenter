# 0126. Child documents use format capabilities and evolve outside records databases

- **Status:** Proposed
- **Date:** 2026-07-12
- **Supersedes:** [ADR-0005](0005-child-docs-are-bound-through-the-workspace.md)
- **Relates:** [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0125](0125-record-schemas-are-immutable-evolution-creates-a-successor-database.md)

## Context

ADR-0005 correctly moved child-document identity and opening into the workspace,
but its `.docs({ field: layout })` builder accepts executable attachment
functions and leaves format compatibility implicit. The first SQLite definition
prototype replaced those functions with strings and included the strings in the
records schema hash. That makes independently stored Yjs formats depend on a
central switch and forces an unrelated records-database succession whenever a
document declaration changes.

## Decision

Epicenter exposes a small closed catalog of child-document format capabilities.
Each capability owns a canonical JSON format descriptor, a framework-derived
format hash, and the function that attaches its typed handle to a supplied
`Y.Doc`. The initial catalog is plain text, canonical rich text, and validated
keyed records. Keyed records require a runtime value schema; an erased generic
is not a format contract. Applications do not supply raw attachment functions,
arbitrary internal Yjs root keys, or custom format identifiers.

Tables use one declaration shape:

```ts
defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
		updatedAt: field.instant(),
	},
	documents: {
		body: document.xmlFragment,
	},
	touchOnDocumentEdit: 'updatedAt',
});
```

The workspace still owns the public opener path
`tables.<table>.docs.<name>.open(rowId)`. Opening owns Y.Doc creation,
persistence, synchronization, readiness, caching, and disposal. The format
capability only attaches its declared Yjs roots and typed handle after the
document is open.

Child-document formats have compatibility identity independent of the SQLite
records database. The records schema hash contains record tables and fields
only. A child-document address includes its format hash in addition to the
workspace, table, row, and document name, so incompatible formats cannot enter
one Yjs room. Changing a document format creates a new child document. An
explicit capability-specific application converter may open one old room and
initialize its new format-addressed room. This is per-document conversion, not
records-schema succession. Old room bytes remain retained. Version one has no
generic document migration registry, cross-format graph, or workspace-wide scan
that discovers and opens every lazy child document.

Moving data between child documents and records is a different operation again:
an explicit app-owned authority transfer. Applications may use ordinary typed
readers and writers, but the maintenance operation must choose exactly one
authoritative plane after cutover. Version one provides no generic or atomic
cross-plane migration, permanent dual write, automatic rollback, generic
reconciliation, or server-executed application conversion. Transfers such as a
counter document into a SQLite cell, a SQLite cell into an initialized counter
document, or a Yjs keyed collection into a SQLite table do not enter
`defineRecordsMigration`. Source bytes remain retained until a separate explicit
cleanup, but retention never makes the old plane authoritative after cutover.

The cohesion rule is: same plane and same authority may earn a framework
migration API. Moving between planes changes authority and remains an explicit
application operation.

This is an asymmetric refusal. Epicenter gives each storage plane one honest
evolution path while applications may explicitly transfer authority between
planes. It refuses to discover, coordinate, atomically migrate, and reconcile
arbitrary data across records and Yjs documents. That deletes the universal
migration registry, cross-plane transaction protocol, document enumeration,
dual writers, generic rollback, cross-format graph, and server-executed
application conversion. The cost is explicit application maintenance work that
cannot claim atomicity across SQLite and Yjs.

Touch policy belongs to the table-to-document relationship, not the document
format. A table may name one instant field that local edits to any of its child
documents update on a coalesced, best-effort basis. Touch behavior enters
neither records identity nor document-format identity.

## Consequences

- `.docs(...)`, symbolic layout strings, raw table-level attachment functions,
  per-document touch objects, and the central layout switch disappear.
- Adding or changing a child document does not create a successor records
  database.
- A format implementation may be refactored without changing identity when its
  accepted stored content remains compatible. A format change changes its
  descriptor and therefore its address.
- Text to rich text is document conversion. Rich text to text is a potentially
  lossy document projection. Neither operation is records-schema succession.
- A cross-plane transfer cannot claim atomicity across SQLite and Yjs. The app
  owns its cutover and one final authority; old bytes remain retained until
  separate explicit cleanup.
- Epicenter must own the persisted node and mark vocabulary before calling a
  format `richText`; reserving a bare `Y.XmlFragment` alone is insufficient.
- The closed catalog deliberately refuses arbitrary application-defined Yjs
  layouts until another real format earns a safe descriptor and typed handle.
- Old child-document bytes remain available for explicit import or export; the
  runtime never deletes them automatically.

## Considered alternatives

- **Keep raw attachment functions.** Rejected because functions provide runtime
  behavior but no byte-stable compatibility identity.
- **Map string layout names through a central switch.** Rejected because the
  switch is manual dependency injection and makes every new format a framework
  branch.
- **Expose `defineDocumentType` publicly.** Rejected for now because the shipped
  formats form a small closed set and arbitrary descriptors let applications
  claim compatibility the framework cannot verify.
- **Keep document layouts in the records schema hash.** Rejected because Yjs
  rooms and SQLite records databases have independent storage and evolution
  lifecycles.
- **Provide one universal migration system across records and documents.**
  Rejected because it would require a migration registry, document enumeration,
  cross-plane transactions, dual writers, rollback, reconciliation, a
  cross-format graph, and server execution of application conversion code.
- **Require developers to rename a document on format change.** Rejected because
  convention does not fence stale binaries from the old room.
