# 0235. Ark collections are ordered predicates over pages

- **Status:** Proposed
- **Date:** 2026-08-10
- **Amends:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md) at the Ark's application-level use of its projection.
- **Relates:** [ADR-0234](0234-the-ark-owns-living-pages-and-markdown-is-an-explicit-checkout.md)

## Context

Tags and resonance are authored properties of a page. The Ark needs a single
way to gather pages from those properties for navigation, following, and public
distribution. Separate facet, identity, and collection objects would require
several classifications of the same work and would make delivery a second
manually maintained system.

SQLite already evaluates the Ark's projected `pages` table. A collection only
needs to name the predicate that selects from it; it does not need to hold a
second membership list or a materialized SQLite view.

## Decision

The Ark owns a `collections` table beside `pages`. Every collection has a stable
row id, a display name, a fractional `sort_key`, a read-only SQL `WHERE`
expression, and zero or more literal outlet bindings.

The Ark evaluates a collection as:

```sql
SELECT page.*
FROM pages AS page
WHERE (<collection.where_sql>);
```

The expression is the authored definition. It must parse as one read-only
boolean expression in this context; it may use SQLite's ordinary expression
power, including read-only subqueries. A malformed expression stays in the
Yjs row and is reported as invalid. It is never discarded or repaired.

The normal collection editor lets a person describe filters and writes the
resulting `WHERE` expression. An advanced editor exposes and edits that same
expression. There is no stored filter AST beside `where_sql`. When an advanced
expression cannot round-trip through the visual editor, the Ark leaves it intact
and presents it as an advanced expression rather than replacing it.

Collection order is the Ark's navigation sequence. The collection with the
lowest `sort_key` is selected when someone first opens the Ark; its stable row
id breaks a concurrent tie. The Ark presents the ordered collections as one
left-to-right row of selectable badges. Selecting a badge changes the one
collection currently shown. Moving a collection changes that default selection,
not page membership, routing, or a hidden collection role.

Collections are the one general mechanism. An outlet-free collection is an Ark
lens. A collection with outlet bindings derives delivery for each matching
release. A usual one-account-per-platform mapping is a convention, not a schema
restriction: collections may be Ark-only, platform-asymmetric, or have several
literal outlets.

## Consequences

- Tags and resonance are the authored page facts. Collection membership is
  always derived and is never stored as a second page property.
- No collection is canonical. Resonance has no implicit routing or landing-page
  behavior; a collection may query it only when its author says so.
- SQLite views and materialized membership tables are not created initially.
  They are optional future caches or developer conveniences, never collection
  sources.
- The Vault's facet and account-bearing-facet model must retire rather than run
  beside collections.

## Considered alternatives

- **A separate facet or identity object.** Refused: it duplicates what an
  ordered collection and its optional outlets already say.
- **A hand-maintained page-to-collection membership list.** Refused: a page's
  authored properties already determine its membership.
- **A smaller custom query language.** Refused: the read-only SQLite expression
  boundary is both more expressive and already the Ark's projection language.
- **One SQLite view per collection.** Refused initially: the collection row is
  already the saved query, and view lifecycle adds no product behavior.
