# 0005. Child docs are bound through the workspace, not the component

- **Status:** Superseded
- **Superseded by:** [ADR-0126](0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md)
- **Date:** 2026-06-15

## Context

Some table rows own a large or collaborative field that does not belong inline in
the parent workspace doc: a transcript, a long body, a rich-text document. These
are separate child Y.Docs. The earlier shape let each app derive child-doc identity
itself and guarded the parent doc against name collisions with a reserved-name
family (`RESERVED_TABLE_CHILD_DOC_NAMES` and friends). That pushed an invariant the
workspace owns (how a row maps to its child doc's guid) onto every app, and the
guard family existed only to police a namespace the workspace should own outright.

## Decision

Child docs are declared on the table with a `.docs({ field: layout })` builder
and reached through a bound accessor, `ws.tables.X.docs.field.open(rowId)`. The
workspace owns guid derivation; the app no longer computes it. The reserved-name
guard family is deleted. A field's `layout` is a closed palette (the field is a
SQLite-cell kind), not an open shape.

## Consequences

- Apps stop deriving child-doc guids and stop importing the guard family; one
  invariant now lives in one place.
- The accessor reads as a path from the row: table, then `docs`, then field, then
  `open(rowId)`. Identity derivation moved from the component into the binding.
- Child-doc layout is declared next to the table schema, so a reader sees a row's
  out-of-line fields where they see its columns.

## Considered alternatives

- **Keep per-app derivation plus the reserved-name guards.** Rejected: it scatters
  a workspace-owned invariant and keeps a guard family whose only job is to defend a
  namespace the workspace should own.
- **Open-shaped child-doc layouts (arbitrary structure per field).** Rejected: a
  field is a SQLite-cell kind, so its child-doc layout is a closed palette, not a
  free shape.
