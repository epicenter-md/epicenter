# 0171. Tables mutate rows through create, update, and delete

- **Status:** Proposed
- **Date:** 2026-07-19
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), [ADR-0164](0164-accepted-membership-gates-immutable-s3-blobs.md), and [ADR-0169](0169-scalar-convergence-retains-one-bounded-deletion-and-retry-horizon.md)

## Context

A sparse absolute field update needs one public name. Calling it `patch` imports
JSON Patch and JSON Merge Patch expectations that the API does not implement.
Exposing caller-selected row IDs would also undermine the non-reuse contract
that permits bounded deletion memory.

## Decision

Every table exposes exactly `create`, `update`, and `delete` as its public row
mutation vocabulary.

`create(fields)` validates complete required fields and mints a fresh generated
row ID. Live creation never accepts a caller-selected ID.

`update(id, changes)` applies sparse absolute field assignments. Omitted keys
remain unchanged. Supplying `undefined` for an optional field unsets it. The
operation does not interpret JSON Pointer paths, operation arrays, recursive
merge rules, or special `null` semantics.

`delete(id)` ends the scalar row lifetime and durably deletes its latent row
document in the same local owner transaction. It does not delete independently
addressed blobs.

There is no public `patch`, `set`, `replace`, `upsert`, or create-with-ID
variant. Artifact initialization may preserve row IDs only while initializing
an empty owner or replacing a whole owner generation; it is not a live table
mutation.

## Consequences

- The mutation vocabulary matches the actual absolute-assignment semantics.
- Applications that need merge patch, upsert, or aggregate blob cleanup own
  those policies above the table primitive.
- A recording aggregate must call blob purge and row deletion through its one
  product workflow; raw table deletion alone is not a complete recording delete.

## Considered alternatives

- **Call sparse assignment `patch`.** Rejected because it implies standardized
  patch semantics that are absent.
- **Expose create-with-ID.** Rejected because it makes intentional identity
  reuse part of the live API.
- **Cascade blobs from row deletion.** Rejected because blobs are independent
  owner resources and may have zero or many application citations.
