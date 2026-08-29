# 0284. The application document is an index, and a row's remaining fields live in its own document

- **Status:** Accepted
- **Date:** 2026-08-28
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) and [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) at what a row document holds. A row is still a Yjs type in the application document and still owns an independent document at a derived address; that document now holds scalars as well as prose.
- **Unbuilt:** all of it.

## Context

The application document holds every scalar field of every row of every table, and almost everything load-bearing rests on it staying small: boot before first paint (ADR-0278), the change feed that tells a device which rows moved, the completeness rule for a generation (ADR-0283), and the memory argument for one object per document (ADR-0282). That was a fact about a notes application with a thousand rows, and it had been promoted silently into a platform invariant.

Measurement, re-runnable as `bun run evidence/bench/memory.ts` and a probe over the shipped row model: **items per row equals the number of fields plus two**, and memory tracks item count rather than encoded size, at roughly 1 KB of resident memory per item. Encoded size is reassuring and irrelevant: a nine-field row model at 25,000 rows is 9.7 MB encoded and 275,000 items, which is about 249 MB resident. A two-field index at the same row count is 100,000 items, about 95 MB.

## Decision

**A table declares which fields are index and which are record. The index lives in the application document; the record lives in the row's own document, beside its prose.**

```ts
defineTable({
  index:  { title: field.string(), status: field.string(), updatedAt: field.instant() },
  record: { transcript: field.string(), durationMs: field.number() },
  document: { derive, file },
})
```

- **Two maps, disjoint.** A name in both fails parse. The `fields` keyword is retired rather than redefined, so a declaration written against the old shape fails loudly instead of silently meaning one half.
- **Index is what a list view needs**: what it displays, sorts by, and filters on. Everything else is record.
- **`manages` resolves against `index`.** A store-owned `updatedAt` must be an index field, because it is the change feed, and a change feed in a document the list cannot see is not one.
- **`derive` may write only index fields.** Its entire purpose is to be readable without opening the document.
- **The record lives under one reserved root** in the row document, beside the application's own named roots. `document.ts`'s row readers are reused over it.
- **The typed surface splits honestly.** `TableHandle.get`, `list`, and `update` are index-only and stay synchronous. The record is reached through the row document handle, which is already asynchronous and already a load. `create` still takes both halves and routes them, because a fresh row document needs no hydration.
- **Export merges the halves into one frontmatter block** and import splits them back by the declaration, since the key sets are disjoint. A copy writes the row document first, then the index entry, which is the same order a mint uses.

**Epicenter is for personal data at the scale of a person.** The stated ceiling is tens of thousands of rows per table. An index-only application document reaches roughly 30,000 rows before it costs about 100 MB resident, hydrated before first paint, on a phone, from cold, every boot. This rule is worth about three times, and it does not move the order of magnitude: a hundred thousand rows does not fit even at two fields.

## Consequences

- Filtering or sorting a list by a record field means opening every row document. The index declaration is an application's statement of what its lists need, and getting it wrong is a performance cliff rather than an error.
- The definition layer states the budget and does not enforce it. A rule in `defineData` that has to be right about "large" would be wrong, and it would put a field somewhere the application did not choose. `pressure()` is where the measurement surfaces.
- Applications with real churn are not served by this rule alone. A recording application at fifty thousand rows exceeds the ceiling with a lean index; its relief is compaction into a new generation, or a second data definition, not a smaller index.
- The change feed keeps working unchanged, because `updatedAt` is index by construction. An edit to a record field is still an edit to the row, so the stamp still lands where a device watching one socket can see it.
- Row documents stop being optional in practice for tables that have any record fields, though they remain zero-or-one physically: an unwritten document and an empty one are the same document, and nothing asks which.

## Considered alternatives

- **Let the definition layer refuse or divert large scalars.** Needs a correct definition of large, and silently relocates a field the author placed deliberately.
- **Say nothing and let applications discover the ceiling.** It cannot be caught by a gate, because it grows past you rather than arriving, and the fix at that point is a data-layout redesign.
- **Page the application document so it stops being the whole table.** The only thing that moves the order of magnitude, and it costs the complete local copy, offline search, the change feed, and boot before first paint. That is a different product.
