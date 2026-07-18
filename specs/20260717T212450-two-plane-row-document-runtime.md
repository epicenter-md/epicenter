# Two-plane row document runtime

- **Status:** In Progress
- **Date:** 2026-07-17 (destination revised 2026-07-18)
- **Branch:** `codex/sqlite-sync-architecture`
- **Reset policy:** Account replicas, authority databases, Yjs 13 provider
  stores, and old room storage may be discarded. Device data requires explicit
  user consent before deletion.

## One sentence

One authenticated principal is one authority actor and one SQLite database
containing every named workspace; reads register nothing, the first accepted
write creates workspace, replica record, and data in one transaction,
synchronization of known replicas is economically unconditional, deletion is a
bounded feed event backed by acquisition, and each opened row document carries
its own dedicated WebSocket into the same account actor.

## Decision owners

- [ADR-0144](../docs/adr/0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md): independent scalar and document client planes.
- [ADR-0145](../docs/adr/0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md): one account authority, no catalog or enrollment, bounded deletion markers, one socket per open row document.
- [ADR-0146](../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): Yjs 14-only provider and wire boundary.
- [ADR-0147](../docs/adr/0147-cross-plane-transfer-and-recovery-use-logical-coordination-not-atomic-snapshots.md): coordinated export, transfer, and recovery.
- [ADR-0122](../docs/adr/0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md): SQLite rows, TEMP views, read-only SQL, and the initial no-index refusal.
- [ADR-0092](../docs/adr/0092-identity-is-the-partition.md): the authenticated principal is the partition, and under ADR-0145 also the actor.

ADR-0145 carries Proposed amendments to Accepted
[ADR-0137](../docs/adr/0137-hosted-storage-is-one-eventually-enforced-physical-account-allowance.md)
(issuance vocabulary becomes first-write binding plus blob grants; the
"never consults storage state" sentence gains the physical-wall exception) and
[ADR-0141](../docs/adr/0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md)
(first-push registration replaces the enrollment paragraph; bounded deletion
markers plus acquisition replace the permanent retired-identity rule; receipts
stay permanent). Those Accepted bodies receive their dated amendment notes when
ADR-0145 is Accepted at the production flip.

## External grounding

Cloudflare (official docs, verified 2026-07-18): `idFromName` is pure
computation; objects activate on first request; idle hibernation-eligible
objects bill no duration; SQLite-backed objects store up to 10 GB, expose
`sql.databaseSize`, support atomic `deleteAll()`, and own hibernating
WebSockets (`getWebSockets()` enumerates without tags; 32,768 sockets max;
16,384-byte attachments); namespaces are not enumerable; an empty database is
roughly 12 KB; storage bills about $0.20/GB-month plus rows read/written
units. Billing catalog (apps/api/worker/billing/catalog.ts): free 100 MB,
paid tiers 5 to 50 GB, blob-dominated with R2 outside the authority.

Yjs: `@y/y@14.0.0-rc.24` pin; updateV2, applyUpdateV2, encodeStateAsUpdateV2,
state vectors, and provider origins are the required primitives. No official
Yjs 14 IndexedDB provider exists; the browser store is Epicenter-owned.

## Execution state

Proven earlier on this branch (evidence in the focused suites): scalar-only
`@epicenter/row-sync` with exact retry, digests, folding, and admission; the
neutral `@epicenter/sqlite` adapters; the server workspace authority schema
and transactions with FK-cascading document storage; the document-blind scalar
replica, browser Worker, Bun owner, and settlement; Browser IndexedDB and
native SQLite Yjs 14 document stores behind one lease contract; the
provider-owned `RowDocument` runtime with scalar-owned revocation; the
three-kind document-v3 codec and connection retry machine; the document hub
core.

Rejected after the 2026-07-18 collapse passes (built on this branch, now being
removed): the workspace catalog and grants, opaque `WorkspaceAuthorityKey`,
the `PUT` creation route, client `createWorkspace`, the enrollment wire
operation, per-workspace Durable Objects, the permanent tombstone table,
`pending-row` and `row-deleted` close codes with transient admission, the
authority live document cache, and socket-tag indexing.

## Recognition criteria

- `RowIntent`, scalar pull, acquisition, and `workspace.sync.settle()` contain
  no document bytes or document scheduling metadata.
- One Durable Object per principal; one authority SQLite database per account;
  workspaces are `workspace_id`-scoped rows. Self-host: one instance
  principal, one database, many workspaces.
- No catalog, grant, authority key, lifecycle index, enrollment operation, or
  workspace-creation route exists anywhere.
- Reads create no logical workspace, replica receipt, or user-data state; the
  first accepted push binds `(workspace, replica)` under the allowance gate.
- No permanent tombstone table; deletion is a bounded marker plus acquisition
  beyond the retention floor; replica receipts are permanent.
- Each open row document has one WebSocket to the account authority; the only
  document-specific wire verdict is terminal `too-large` (1009); the server
  retains no live `Y.Doc`.
- Arbitrary `/api/rooms/:roomId`, per-document or per-workspace actors, Yjs 13
  providers, and the combined scalar/document path are absent from production.
- Scalar rows remain available to arbitrary read-only SQL and TEMP views.

## Final ownership

```txt
Application
  table row API          table.document.open(rowId)       read-only SQL
        |                           |                           |
Browser Worker                  Browser page                    |
  OPFS SQLite scalar replica      IndexedDB Yjs 14 log           |
  scalar sync supervisor          BroadcastChannel               |
        |                         one socket per open document    |
        +---------------------------+-----------------------------+
                                    |
                      one ACCOUNT authority (per principal)
                        scalar HTTP protocol
                        row-addressed Yjs 14 WebSockets
                        one SQLite database, workspaces as namespaces
```

## Public contract

```ts
type WorkspaceSync = {
	status: WorkspaceSyncStatus;
	settle(): Promise<WorkspaceSettleResult>; // scalar rows and KV only
};

type RowDocument = {
	get: Y.Doc['get'];
	transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T;
	whenDurable(): Promise<void>; // local document provider only
	connection: DocumentConnectionStatus; // terminal reasons: too-large, auth, upgrade
	[Symbol.dispose](): void;
};
```

## Wire and lifecycle

```txt
POST /api/workspaces/:workspaceId/records/{push|pull|acquire}
GET  /api/workspaces/:workspaceId/tables/:table/rows/:rowId/document
Sec-WebSocket-Protocol: epicenter-document-v3, bearer.<token>

sync-request(stateVector)  sync-response(updateV2)  update(updateV2)
```

- The authority address derives from the authenticated principal alone; the
  route workspaceId scopes data inside it. No request can address another
  principal's state.
- There is no enroll operation. A push from an unknown `(workspace, replica)`
  pair is the allowance-gated first-write admission; refusal returns the
  pending storage-limit verdict and leaves zero durable state. Receipt and
  digest semantics are otherwise exactly ADR-0141.
- Known pairs synchronize economically unconditionally. The physical wall (a
  fixed headroom below 10 GB, margin greater than the largest admissible
  operation) refuses whole rounds retryably and refuses document appends by
  closing retryably; reads, downstream document sync, export, and workspace
  and account deletion remain available there.
- Document admission: one atomic store read (liveness plus committed updates);
  a not-live row closes retryably with no reserved code; too-large closes
  terminally with 1009; deletion closes sockets after commit with an ordinary
  close, and the client's scalar plane ends the retry loop by revoking the
  document when the deletion marker installs.
- The hibernation attachment stores the fixed structured address and protocol
  major; fanout enumerates sockets and compares complete addresses; no tags.

## Storage contracts

Authority (one database per principal): workspace rows; per-workspace current
rows, change markers, bounded deletion markers, head and retention floor;
permanent per-replica receipts; document snapshots and update logs with FK
cascade to live rows; `databaseSize`-based wall check and telemetry.

Client: unchanged from the proven checkpoints — the scalar replica keeps
confirmed state, open/sealed intents, retired receipt, checkpoint, and replica
id; document stores implement the `DocumentStore` lease contract (ADR-0146).

## Clean-break waves

### Wave A: remove the catalog family — DONE 2026-07-18

- [x] Routes resolve records backends with `(principalId, workspaceId)`
  (`CurrentStateRecordsPartition`); the `PUT` route and
  `CreateWorkspace`/`AuthorizeWorkspace` seams are deleted.
- [x] Both catalogs deleted (hosted Postgres schema plus drizzle 0006 and its
  journal entry, self-host `workspace-catalog/`), with
  `WorkspaceAuthorityKey` and `WorkspaceAccessDecision`, the self-host
  `WORKSPACE_CATALOG` binding, and its v3 migration entry.
- [x] Client `createWorkspace` transport op and flags deleted; the document
  route passes the partition directly.

Proof: 430 tests green across row-sync, sqlite, server, workspace sqlite and
document-provider slices; all five package typechecks green; the stale-symbol
audit finds no catalog vocabulary outside git history (remaining
`createWorkspace` matches are the unrelated legacy Yjs 13 workspace factory,
Wave H territory).

### Wave B: collapse the document lifecycle — DONE 2026-07-18

- [x] `DOCUMENT_CLOSE_CODE` is `{ 'too-large': 1009 }` only; `pending-row`,
  `row-deleted`, and the transition-era `auth-refresh`/`workspace-denied`
  codes are gone (credential expiry closes with an ordinary 1000).
- [x] Hub store contract: `openIfLive` plus `appendIfLive` returning
  `appended | refused | too-large`; live cache deleted; disposable hydration
  for connect and acceptance; exact bytes broadcast; `closeAll` replaces
  `evictTombstoned` in the core; Cloudflare runtime accepts sockets without
  tags and restores by enumerating attachments.
- [x] Connection verdicts: retry reason `network` only; terminal `too-large`,
  `auth`, `upgrade`.

Proof: 103 tests green across document-v3, document-hub, workspace-authority,
and document-provider under the new contract with no reintroduced codes.

### Wave C: dissolve enrollment into first-push admission — DONE 2026-07-18

- [x] Enroll request/response removed from the wire protocol, routes,
  authority, and replica (`ensureEnrolled`, enrollment parsers, the
  `IssueCurrentStateEnrollment` seam all deleted).
- [x] First push from an unknown replica registers the receipt and folds
  round one in one transaction; an unknown later round returns
  recovery-required without registration or mutation; the route-level
  `admitFirstContact` seam carries the hosted allowance gate; `storage-limit`
  keeps sealed work pending with zero durable authority state.
- [x] Pull and acquire require no registration and return fresh round-zero
  receipts for unknown replicas.

Proof: 431 tests green including relocated lost-response retry,
restored-replica recovery halt, storage-limit pending, pull-only fresh
replica, and explicit no-/enroll-route coverage; row-sync, server, and
workspace typechecks green.

### Wave D: one account authority — DONE 2026-07-18

- [x] `openAccountRowAuthority({ database, readDatabaseSize? })` with cached
  `.workspace(workspaceId)` facades; every table workspace-scoped (storage
  version 9) with FK cascade from the per-workspace meta row; Bun layout
  `principals/<principal>/authority.sqlite`; Cloudflare actors named from the
  encoded principal alone; document headers, attachments, and hub keys carry
  `workspaceId`.
- [x] Hosted storage accounting is one account `databaseSize` read
  (`structured/account` observation); the physical wall is
  `10 GiB - 64 MiB`, refusing pushes whole-round retryably and document
  appends as `refused` while reads, pulls, acquire, and openIfLive stay
  available.
- [x] `deleteWorkspace(workspaceId)` is one transaction, closing that
  workspace's sockets after commit (including not-yet-handshaken upgrades).
  Account deletion via `deleteAll()` plus R2 prefix remains deployment wiring
  in Wave G.

Proof: 438 tests green including two-workspace isolation, independent
deletion, wall retryability, readable-under-wall, and pending-socket closure;
server, workspace, and sync typechecks green; license graph clean.

### Wave E: bounded deletion markers replace permanent tombstones — DONE 2026-07-18

- [x] `row_authority_tombstones` dropped (storage version 10); deletion
  removes the live row and inserts a `deleted = 1` change marker atomically,
  cascading document state; markers compact at the retention floor with a
  partial address index guarding retained-marker create refusal.
- [x] Wire major 9 renames deletion entries to
  `{ kind: 'deleted', table, rowId, deletedSequence }`; pull joins markers to
  current rows (live: postimage; absent plus deletion marker: deleted entry;
  absent plus earlier ordinary marker: nothing — the later deletion marker
  owns removal).
- [x] Complete acquisition removes confirmed local rows absent from authority
  state, fires the existing rows-deleted revocation, and preserves open and
  sealed intents; update and delete against absence stay no-ops; a create at
  a compacted-away deleted address establishes a fresh row (documented
  self-harm acceptance).

Proof: 444 tests green including pull-window deletion ownership,
post-compaction recreation, acquisition removal with document revocation,
pending-create survival, and non-resurrecting pending updates; all five
package typechecks green.

### Wave F1: collapse the authority seam — DONE 2026-07-18

Seam destination accepted 2026-07-18 (Candidate A of the account-authority
runtime seam memo, deleted as spent when this wave landed): one principal
resolves once to one `AccountAuthority`; `workspaceId` is an operation
argument, never part of the authority address; each deployment binds one
authority locator.

- [x] One route-facing `AccountAuthorities` seam: `authority(principalId)`
  returns the handle carrying `hasReplica`, `push`, `pull`, `acquire`,
  `deleteWorkspace`, `databaseSize`, and `acceptDocumentUpgrade`;
  `rejectDocumentUpgrade` (accept-then-close) sits beside the locator as
  deployment transport policy. Both mounts inject the same single
  `resolveAuthorities`.
- [x] Deleted `CurrentStateRecordsPartition`, the `resolveRecords`/
  `resolveDocuments` injection pair, `WorkspaceDocuments`,
  `createCurrentStateDurableObjectDocuments`,
  `readCurrentStateAccountDatabaseSize`, and the dead `CurrentStateBunRecords`,
  `DocumentHubCore`, `AccountRowAuthority`, `DocumentAppendResult` aliases.
  `AdmitFirstContact` receives the already-resolved `AccountAuthority` (hosted
  account sizing reads `authority.databaseSize()`);
  `apps/api/worker/storage/service.ts` changed in the same commit.
- [x] Cloudflare: the two factories merged into
  `createDurableObjectAccountAuthorities(namespace)` over the unchanged
  `CurrentStateRowAuthorityDurableObject`. Bun:
  `createBunAccountAuthorityRuntime` returns
  `{ authorities, websocket, bindServer, close }`; `authority(pid)` stays a
  thin wrapper that re-enters `load(pid)` per operation so the closed-state
  guard keeps firing; `close()` also closes active document sockets (1001)
  and is wired into both Bun entrypoints on SIGINT/SIGTERM.
- [x] Authenticated workspace deletion mounted as
  `DELETE /api/workspaces/:workspaceId`, entering
  `authority(pid).deleteWorkspace(ws)`. Account deletion stays a separate
  operation because it coordinates authority storage, the R2 prefix, and
  authentication-owned records (Wave G wiring).
- [x] Fixed the stale pair-model comment on the RECORDS binding
  (`apps/api/wrangler.jsonc`) and deleted the spent seam memo.

Proof: 950 tests green across the five packages; row-sync, sqlite, server,
sync, workspace, api, and self-host typechecks green; the mounted deletion
route dispatches through the one resolved authority (route tests); workspace
deletion closes pre-handshake sockets on both runtimes; Bun shutdown closes
sockets with 1001 and refuses later operations (runtime test).

### Wave F2: wire document clients — BLOCKED on the document decision

The document architecture is under greenfield review; this wave does not start
until that decision is explicitly settled.

- [ ] Wire browser and native document connections through the accepted
  document model against the mounted routes.

Proof: live socket smoke on Bun and wrangler dev; hibernation restore;
deletion racing update; wall behavior on the document path.

### Wave G: coordinated product operations

- [ ] Export scalar cuts plus available document states with explicit
  omissions; Device Add persists both planes, settles, verifies canonical
  liveness, then permits source deletion; recovery captures logical content.

### Wave H: flip, delete, and name

- [ ] Flip Browser, Tauri, hosted, and self-hosted production paths together.
- [ ] Delete `/api/rooms`, the room backends, Yjs 13, `y-indexeddb`, old
  `lib0`/`y-protocols` families, the `y-prosemirror@1` and `y-codemirror.next`
  bindings, persisted readers, and transition-era `CurrentState`/`Canonical`
  names.
- [ ] Run the iPhone Safari and installed-PWA Private Relay smoke at 1, 2, 4,
  and 8 sockets; failure selects one workspace socket as the sole topology.
- [ ] Collapse, fresh-context, and post-implementation reviews; accept ADRs
  0144 through 0147 with the 0137/0141 amendment notes; delete this spec.

## Refusals

- No Yjs 13 compatibility. No document bytes in scalar sync.
- No catalog, grants, authority keys, lifecycle index, enrollment, or
  workspace-creation operation.
- No per-workspace or per-document actors; no multiplexing until measured.
- No permanent tombstone table; no row-id reuse by conforming runtimes;
  post-compaction re-mint by a non-conforming client is accepted self-harm.
- No economic refusal inside ordered synchronization; no growth classification
  of intents; no delete-first reordering or second deletion route.
- No `pending-row`/`row-deleted` verdicts; no transient accept-then-close.
- No authority live-document cache; no socket tags.
- No first-contact retry protocol: hosted admission keeps the two authority
  round trips (`hasReplica`, then `push`) until telemetry demonstrates a
  problem at human cadence.
- No portable Hono `upgradeWebSocket` adoption: verified unable to absorb
  hibernation or the bearer-subprotocol contract; it would relocate platform
  code, not delete it.
- No initial public indexes, FTS, or materialized projections.
- No global remote document settlement or exact cross-plane snapshot.
- No structured account data beyond the wall headroom below 10 GB.

## Final verification

```sh
bun test packages/row-sync packages/sqlite packages/server packages/sync packages/workspace
bun run --filter @epicenter/row-sync typecheck
bun run --filter @epicenter/sqlite typecheck
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/sync typecheck
bun run --filter @epicenter/workspace typecheck
bun run check:licenses
bun scripts/check-doc-hygiene.ts
rg -n "authorityKey|WorkspaceAuthorityKey|createWorkspace|enroll|pending-row|row-deleted|tombstone" packages apps
rg -n "from 'yjs'|from \"yjs\"|y-indexeddb|/api/rooms|documentUpdate" packages apps package.json bun.lock
```

Classify remaining matches: final behavior, historical evidence, fixture, or
deletion debt. History and benchmarks may legitimately retain vocabulary.
