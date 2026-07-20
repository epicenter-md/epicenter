# 0162. Portability is a frozen editable projection of one selected owner

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)
- **Relates:** [ADR-0143](0143-account-open-never-consumes-device-data.md), [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md), and [ADR-0161](0161-each-local-owner-persists-one-sqlite-database-and-one-blob-directory.md)

## Context

Calling private runtime bytes portable would freeze replica tables, cursors,
indexes, and SQLite migrations as public compatibility obligations. Calling a
row-only JSON snapshot portable would omit row documents and owner blobs.

Users also benefit from ordinary tools being able to inspect and deliberately
edit their detached data. That does not require turning an export into a live
checkout or inventing generic merge semantics.

## Decision

Portability projects the complete durable current state of exactly one selected
owner into a fresh, frozen, versioned artifact:

```txt
My Epicenter.epicenter/
  epicenter.sqlite3
  blobs/
    <BlobId>
```

The directory is the canonical artifact. A ZIP may encode it for transport but
does not define another format. Export never copies the private live database or
blob directory in place.

Portable v1 identifies itself with SQLite `application_id` and `user_version`.
Its documented schema contains logical rows, typed KV, one compact Yjs 14
`updateV2` state per live row document, and a blob manifest. Manifest rows bind
each opaque `BlobId` to its ordinary file, byte length, content type when known,
and a SHA-256 integrity digest computed while exporting. The digest verifies the
artifact; it does not replace `BlobId` as application identity. The format ships
with a version-pinned reference reader and Yjs tooling.

An artifact is formally editable. Users may edit rows and KV with SQLite tools,
edit documents with the version-pinned Yjs tooling, and replace blob files when
they also update the manifest and digest. The format's validator rejects invalid
structure, JSON, Yjs bytes, addresses, manifests, missing files, extra files,
and digest mismatches.

## Consequences

- One stable artifact can outlive private SQLite layouts and application lens
  releases.
- Editing is data autonomy over detached state. Export completeness and import
  authority are separate decisions.
- Portable format v2 is required only when a platform primitive changes. An
  application adding fields or tables does not rev the format because rows stay
  schema-opaque.

## Considered alternatives

- **Copy the live SQLite file and blob directory.** Rejected because private
  replica identity and runtime layout would become public compatibility state.
- **Treat the ZIP as canonical.** Rejected because ZIP is a transport encoding,
  while an ordinary directory is directly inspectable and editable.
- **Make artifacts read-only.** Rejected because staging and whole-owner
  initialization can safely support deliberate edits without expanding into
  writeback.
