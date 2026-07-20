# 0161. Each local owner persists one SQLite database and one blob directory

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md)
- **Amends:** [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md) by changing the file owner from each Workspace ID to the one selected Epicenter owner.
- **Relates:** [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md) and [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md)

## Context

The previous layout nested one SQLite database per Workspace ID beneath a
Device or Account directory and added `account.json` to remember account
metadata. With one Epicenter per selected owner, the extra directory level and
metadata file have no durable fact to represent. A top-level shared blob store
would also make export, deletion, and replacement depend on reference discovery
across owners.

## Decision

Every selected local owner has one private runtime root:

```txt
<AppData>/
  epicenters/
    local/
      epicenter.sqlite3
      blobs/
    accounts/
      <AccountKey>/
        epicenter.sqlite3
        blobs/
```

`AccountKey` is an opaque expected-account binding for local path selection. It
is not portable identity and does not appear in exports. No `account.json`,
workspace subdirectory, shared top-level blob directory, lens file, or
application manifest exists.

`epicenter.sqlite3` is the selected owner's private live database. It contains
canonical rows, typed KV values, row-document baselines and bounded update
tails, and private replica state when the owner synchronizes. It may also
contain runtime indexes and schema versions. The `blobs/` sibling contains
ordinary immutable media and attachment bytes for that owner. Document CRDT
bytes always remain in SQLite; media and attachments always remain outside it.

The boundary is semantic, never size-based. Yjs document bytes do not move into
`blobs/` when large, and a small recording does not move into SQLite. Private
physical tables and the live file itself are not the portable format.

The live database is directly inspectable but never directly writable. On
desktop and Bun, a person or external tool may open `epicenter.sqlite3`
read-only and query the one stable, lens-independent `rows` relation that
ADR-0163 defines; every other relation in the file stays private and free to
change. Synchronized mutations enter only through Epicenter's typed TypeScript
API. A direct write to the live file is unsupported and never synchronizes;
deliberate offline editing belongs to the detached portable artifact
(ADR-0162).

Browser storage uses the same ownership model through its platform-native
SQLite and blob backends even when it cannot expose this literal filesystem
tree. The browser preserves the same read-only `rows` semantics through the
SQL API; it promises semantic access, not a filesystem path.

## Consequences

- Selecting, exporting, deleting, resetting, or replacing one owner has one
  complete local root and never scans another owner.
- Identical blobs under two owners consume bytes twice. This prevents
  cross-owner reachability, refcounting, and deletion coordination.
- Runtime SQLite migrations remain private implementation work because users
  receive a freshly projected portable artifact instead of a copy of this
  database.
- Account metadata that can be derived from the authenticated session stays in
  the session. Durable values that belong to the Epicenter use typed KV.

## Considered alternatives

- **Keep `account.json`.** Rejected because owner selection already supplies the
  opaque account key and portable data must not carry account identity.
- **Share one top-level blob store.** Rejected because every owner lifecycle
  would need a reachability graph or reference counts spanning independent
  portability boundaries.
- **Store every byte in SQLite.** Rejected because large media would turn row
  locking, database backup, and object transfer into one mechanism.
- **Store row documents as ordinary files.** Rejected because their durability,
  liveness, compaction, and scalar-row deletion belong to the SQLite owner.
