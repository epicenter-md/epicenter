# 0146. Row documents use one Yjs 14 major and runtime-native update logs

- **Status:** Proposed
- **Date:** 2026-07-17
- **Amends:** [ADR-0135](0135-row-documents-have-application-owned-roots.md)

## Context

The repository currently contains both `yjs` 13 and `@y/y` 14 release-candidate
families. The available `y-indexeddb` package requires Yjs 13, while the new row
document API and editor path already target Yjs 14. Preserving both majors would
create duplicate providers, wire tests, persisted formats, and compatibility
policy before the new workspace runtime ships.

## Decision

Row documents use only the Yjs 14 line through `@y/y`. Epicenter provides no
Yjs 13 dependency, compatibility reader, dual wire, alias, migration lane, or
fallback. The exact release-candidate version is a build pin recorded in the
implementation spec and package manifests, not a permanent ADR claim.

Epicenter owns one update-log store and one per-open-document lease:

```ts
type DocumentStore = {
	attach(address: RowAddress, doc: Y.Doc): DocumentPersistenceLease;
	capture(address: RowAddress): Promise<Uint8Array | undefined>;
	delete(address: RowAddress): Promise<void>;
	deleteAll(): Promise<void>;
};

type DocumentPersistenceLease = {
	whenLoaded: Promise<void>;
	whenDurable(): Promise<void>;
	dispose(): Promise<void>;
};
```

Browser persistence implements it over one versioned IndexedDB database per
workspace with per-document indexed update logs. Native persistence implements
the same semantics over private SQLite. Both replay Yjs 14 updates, append every
observed update, compact to a complete update at bounded thresholds, expose an
invocation-time local durability barrier, and fail closed on storage corruption
or eviction. `attach()` installs update capture synchronously before replay
begins, and `document.open()` awaits `whenLoaded`. Destructive row or workspace
cleanup first disposes active leases and then calls the store; an active lease
does not expose `clear()`.

The document network protocol has its own explicit wire major and is implemented
only against `@y/y` 14 encoding. Existing Yjs 13 room and provider code is
algorithmic precedent, not a compatibility surface.

The authority bounds accepted document state. If a locally valid document grows
beyond that bound, local persistence and logical export remain available while
its connection becomes terminal `too-large`. Epicenter never reports that
content as remotely synchronized and never silently drops an oversized update.

The application still receives the restricted native-shaped `RowDocument` from
ADR-0144. It owns root names and interpretations. Epicenter owns Yjs document
construction, provider attachment, hydration, synchronization, revocation,
compaction, and destruction.

## Consequences

- `yjs`, `y-indexeddb`, their old `lib0` and protocol family, and the patched
  IndexedDB provider leave the final dependency graph.
- Browser and native providers share conformance semantics without sharing a
  storage implementation.
- Persisted Yjs 13 stores are abandoned under the authorized pre-user reset and
  are never opened by the new runtime.
- Export, revocation, Device Add, and workspace reset can address documents that
  are not currently open without inventing a second provider registry.
- Adopting a later Yjs 14 release is an ordinary deliberate dependency upgrade;
  an incompatible persisted or wire format requires a new explicit format
  decision, not a permanent previous-major branch.

## Considered alternatives

- **Peer-override `y-indexeddb`.** Rejected because its public package and
  implementation are tied to the Yjs 13 dependency family.
- **Wait for an official Yjs 14 IndexedDB provider.** Rejected because no such
  package currently exists and the required append/replay/durability contract
  is small and product-specific.
- **Retain Yjs 13 for providers only.** Rejected because two CRDT majors in one
  document lifecycle are not a simplification.
- **Put deletion on the active lease.** Rejected because destructive storage
  ownership must wait until every writer is disposed and belongs to the
  workspace-scoped store.
