# 0131. Every durable records materialization carries its canonical descriptor

- **Status:** Accepted
- **Date:** 2026-07-13
- **Amends:** [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0122](0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md), [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)

## Context

The records schema hash proves identity but cannot explain the tables, fields,
or portable constraints it identifies. A SQLite replica that stores only the
hash remains understandable only while the application bundle that generated
the schema is available. That makes an obsolete replica durable but not
self-describing.

## Decision

Every durable records materialization stores the exact canonical records
descriptor beside its hash. This includes standalone and replica SQLite files
and the authority metadata for the current records epoch.

Authority discovery returns the descriptor, hash, and current epoch. Before a
replica binds or resumes, it compares both the descriptor and hash with its
application definition. The authority stores and returns the descriptor as
opaque bounded text; it does not interpret application schemas.

The descriptor explains portable record structure and code-independent
constraints. It does not contain executable actions, computed behavior,
permissions, child-document contents, synchronized KV, local indexes, cursors,
actor identity, or pending mutations.

## Consequences

- A person or tool can inspect a durable SQLite file and understand its record
  tables without loading the original application.
- A schema hash is no longer the only durable evidence of schema meaning.
- A physical SQLite file remains replica runtime state, not the portable import
  format. Its cursor, actor, quarantine, and outbox still must not be adopted as
  another replica's identity.
- The schema-blind authority stores more bounded metadata but gains no
  application-specific validation or query behavior.
- Self-description does not create a migration chain, replacement endpoint,
  executable schema format, or permission to replay old pending mutations.

## Considered alternatives

- **Store the descriptor only in explicit exports.** Rejected: an obsolete or
  copied SQLite file would still depend on application code before an export
  could be produced.
- **Store only the hash.** Rejected: identity without meaning does not satisfy
  the portable-data promise.
- **Make the SQLite file the portable import artifact.** Rejected: the file also
  carries private replica and engine state that must not cross identities.
