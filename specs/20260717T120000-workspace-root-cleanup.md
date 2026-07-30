# Workspace root cleanup after the SQLite proof

- **Status:** In Progress
- **Date:** 2026-07-17
- **Depends on:** ADR-0132 and Proposed ADR-0144 through ADR-0147

Proposed ADRs 0144 through 0147 own the two-plane synchronization lifecycle,
workspace document hub, Yjs 14-only boundary, and explicit Device-to-Account
coordination. This cleanup follows that public surface and does not preserve the
old automatic Device-addition or combined scalar/document assumptions.

## Recommendation

`@epicenter/workspace` should own the ADR-0130 application contract. Apps enter
through `defineWorkspace`, typed table and KV lenses, and row-document handles.
Environment-specific runtime construction stays on explicit subpaths.
`@epicenter/row-sync` continues to own the wire protocol, authority fold,
admission, and physical sync storage.

ADR-0143 retains the Device and Account identity vocabulary introduced by
ADR-0138: a connection authenticates to a deployment, the deployment resolves a
principal, auth passes an account handle into the runtime, and one workspace
authority governs each synchronized workspace. Account open never reads Device
storage. Products offer explicit Add, Delete, or Keep.

The final root export should be the current app-facing surface from
`packages/workspace/src/sqlite/index.ts`:

- `defineWorkspace`, `WorkspaceDefinition`, `defineTable`
- row, field-change, lens, value, and validation error types
- `WorkspaceHandle`, `WorkspaceTables`, `WorkspaceKv`, and the final row/table
  operation surface
- `RowDocument`

`WorkspaceRecords` is a stale transitional name. The target surface should
expose row/table operations without making `Record` a platform lifecycle noun.

Runtime constructors should move to `@epicenter/workspace/browser`, `/bun`, and
`/desktop`. The desktop owner is host infrastructure, not an app API. Keep it
package-private if the Epicenter host can import it internally; otherwise expose
it from an explicitly internal subpath.

`@epicenter/workspace/sqlite` is a proof location, not a durable product noun.
After migrating its current callers, remove the `/sqlite` exports in the same
clean-break wave. Physical files may remain under `src/sqlite/` temporarily.
Only use deprecated aliases if release coordination proves an atomic caller
migration impossible, and delete those aliases after one named release.

## Document clean-break target

The two-plane runtime in
[`20260717T212450-two-plane-row-document-runtime.md`](20260717T212450-two-plane-row-document-runtime.md)
changes this cleanup boundary. Delete the old root-Yjs workspace database and
every Yjs 13 implementation, but port the earned provider behavior to the Yjs
14 row-document plane instead of deleting collaboration wholesale.

After every production caller has moved, delete:

- old `defineWorkspace`, `defineTable`, `defineKv`, table, KV, and action code
- `.docs(...)`, document declarations, child-document identity and cache wiring
- root-workspace `connect(...)`, `mount(...)`, and `connect-doc` ownership
- Yjs 13 collaboration, presence, IndexedDB, file-log, and room implementations
  after their required behavior is proven in Yjs 14 replacements
- `attachIndexedDb`, `attachLocalStorage`, `attachRecords`, `attachPlainText`,
  `attachRichText`, and related update listeners
- legacy document SQLite readers, writers, materializers, wipe helpers, tests,
  benchmarks, examples, and root exports
- old `y-keyvalue` implementations once their remaining direct callers move
- arbitrary room ids and per-document room actors after the workspace document
  hub owns production traffic

This deletion is not yet safe. Current production callers still include the
daemon and agent paths plus apps such as Honeycrisp, Todos, Vocab, Tab Manager,
Opensidian, Wiki, Chat, and Filesystem. Server room presence also imports the old
document world. Its presence and reconnect semantics are evidence for the
replacement workspace document hub, not a reason to retain its Yjs 13 package
or per-document actor topology.

## Neutral utilities

- Move `node-id` and `agent-id` to `@epicenter/identity` if their daemon callers
  survive.
- Move `nullable` to `@epicenter/field` only if a surviving schema needs
  required nullable values. ADR-0130 absence uses table `optional` fields.
- Keep row ID generation inside the new runtime. Do not root-export legacy
  `generateId` for application row creation.
- Move `createDisposableCache` to a generic or Svelte lifecycle owner only if a
  new async row-document adapter proves it is still useful.
- Move generic Svelte helpers such as debounce to `@epicenter/svelte` when they
  have surviving callers.
- Keep SHA-256, safe path segments, SQLite adapters, canonical stores, owner
  factories, and protocol helpers private to their runtime owners.
- Keep agent, daemon, markdown, links, and materializer capabilities on explicit
  subpaths or in dedicated packages. They do not belong in the workspace root.

## Honeycrisp cutover

Honeycrisp is not a mechanical import rewrite. Its end-to-end cutover owns:

1. [x] An async reactive table adapter or app-owned refresh state to replace
   synchronous `fromTable` observation.
2. [x] Browser Device/Account runtime composition based on the SQLite runtime, HTTP
   row sync semantics, async readiness, auth namespace changes, and runtime
   disposal. This replaces `connect(toConnection(...))`, `NodeId`, room
   WebSockets, and `storage.whenLoaded`.
3. [x] An async row-document Svelte cache with loading, disposal, revocation, and
   reopen behavior. ProseMirror uses the native Yjs 14 type
   from an application-owned root such as Honeycrisp's current `body` root; that
   root name is not a platform noun.
4. [x] Keep folder deletion as a best-effort application service: list the folder's
   notes, issue ordinary updates that unset `folderId`, then delete the folder.
   Honeycrisp does not require this multi-row convenience to be one authority
   transaction.
5. [x] Make document-edit metadata explicit application policy. The editor's
   existing content-change operation updates `title`, `preview`, `wordCount`,
   and `updatedAt`; the workspace runtime has no implicit touch declaration.

Legacy storage is not a blocker. The first SQLite release starts with an empty
Honeycrisp workspace and does not inspect, import, map, clear, or fall back to
the old root Y.Doc, child documents, rooms, or IndexedDB databases. Those stores
become unreachable and may remain until normal browser eviction. This is an
explicit pre-user clean break, not an unfinished migration assignment.

## Next implementation goal

With ADR-0130 through ADR-0139 accepted, migrate the current `/sqlite`
application callers to the new root and runtime subpaths in one wave, remove
the `/sqlite` exports, and leave the old document implementation reachable only
through its remaining explicit legacy subpaths. Then migrate or retire those
callers in dependency order before deleting `src/document/`.

Before that migration, run the naming cleanup in narrow waves:

1. Done: replace public `authorityKey` and `storageScopeKey` runtime identity
   with Device/Account constructors. Do not restore automatic addition on
   Account open.
2. Rename the public in-memory workspace vocabulary from records to rows where
   the names are not durable routes, protocol strings, filenames, or external
   compatibility surfaces.
