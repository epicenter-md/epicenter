# 0252. KV is one structured value with whole-value reads and conformance results

- **Status:** Accepted
- **Date:** 2026-08-19
- **Provisional number.** The merge owner reconciles this number against other
  open ADRs before merge.
- **Relates:** [ADR-0125](0125-fields-validate-present-values-and-table-lenses-own-presence.md),
  [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md),
  and [ADR-0251](0251-one-transaction-coordinator-backs-direct-operations-and-explicit-compositions.md).
- **Amended by:** [ADR-0253](0253-schema-lenses-interpret-stored-json-on-read-and-writes-admit-storage-valid-facts.md) at KV write admission. `kv.update` writes supplied storage-valid values and returns no schema Result; `kv.get` remains the conformance boundary.

## Context

The database's `kv` section is a small, schema-declared settings value stored
at one reserved Yjs root. Its fields are independently mergeable attributes,
but callers do not need independent loading or synchronization for them. A
read can therefore return the whole value while still reporting when the
stored value no longer conforms to the current declaration.

## Decision

**`kv` is one structured value. Its canonical API is whole-value `get`, partial
`update`, and whole-root `subscribe`; field handles such as `kv.theme.get()` and
`kv.theme.set()` are not part of the surface.**

```ts
const result = db.kv.get();
db.kv.update({ theme: 'dark' });
db.kv.subscribe(() => {
	// Re-read the whole value.
});
```

`kv.get()` returns `Result<TValues, NonconformingValue>` because the stored raw
object can be valid Yjs state while failing the current schema declaration. This
can happen after a declaration changes or when a peer carries data this release
cannot interpret. The error contains `raw`, the fields that still conform, and
the conformance issues so the application can choose its recovery. Missing KV
is not an error: the reserved root always exists and declared defaults fill
unwritten fields.

Store lifecycle failure is a different boundary. A disposed store throws
`StoreUnusableError`; persistence trouble is reported through the persistence
capability. Neither is disguised as a KV read result.

The same whole-value surface appears inside an explicit transaction as
`tx.kv.get()` and `tx.kv.update(...)`. A future field-level convenience facade
would need a separate decision and must not become a second canonical mutation
path.

## Consequences

- Callers read settings with one predictable result shape and update only the
  fields they intend to change.
- Whole-root subscription is the notification boundary, while the underlying
  Yjs root still merges individual attributes independently.
- Schema evolution remains visible. The store never silently repairs or hides
  a value that the current declaration cannot fully interpret.
- KV remains appropriate for compact shared settings. Large or independently
  loaded data belongs in a table or an independent document.

## Considered alternatives

- **Expose `kv.theme.get/set`:** refused because it would add a second public
  mutation surface over the same root without a separate loading or sync need.
- **Make `kv.get()` throw for nonconforming data:** refused because the caller
  can often recover from the conforming fields, and the invalidity belongs to
  the stored value relative to the declaration, not to store lifecycle.
- **Return `undefined` for KV absence:** refused because the reserved KV root is
  a singleton and defaults make an unwritten field readable.
