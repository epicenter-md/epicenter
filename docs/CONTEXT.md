# Context: shared vocabulary

The words Epicenter uses for its own concepts, so humans and agents name the same
thing the same way. Keep entries to one or two lines. When a design pass coins or
sharpens a term, update it here in the same change. For the decisions behind these
shapes, see `docs/adr/`.

Two layers live in this file. The destination vocabulary names the accepted
one-Epicenter model (Proposed ADRs 0160 through 0182); design work and new
documentation use it. The transitional vocabulary names shipped code still
built around the older Workspace noun; it leaves the tree wave by wave as the
clean break lands (`specs/20260719T222716-one-epicenter-clean-break.md`). When
the two disagree about where we are going, the destination vocabulary wins.

## One Epicenter (destination)

- **Epicenter**: one person's whole durable state: current rows, typed KV, one
  latent row-owned Yjs document per ordinary row, and immutable blobs. One
  selected owner has exactly one; there is no `WorkspaceId`, `DatabaseId`,
  named logical database, or second platform store beneath a person
  (ADR-0160).
- **Owner**: the selected local Epicenter or one principal's server Epicenter.
  Owner selection is the boot and storage decision (ADR-0181); applications
  never choose local versus account storage independently.
- **Replica**: one device's private durable copy of the selected Epicenter:
  `epicenter.sqlite3` plus a `blobs/` sibling, with bounded sync state
  (ADR-0161). On desktop and Bun the live database is readable in place,
  read-only, through the stable `rows` relation; synchronized mutations enter
  only through the typed TypeScript API, and a direct live-file write never
  synchronizes.
- **Lens**: the identity-free, release-local typed interpretation
  (`defineEpicenter({ tables, kv })`) a trusted application brings to the
  selected owner (ADR-0172). Several lenses read the same rows concurrently. A
  lens is not an identity, a permission boundary, or a storage lifecycle, and
  it cannot mint a named logical database.
- **Row**: one generated ID under a permanent table key carrying schema-opaque
  scalar fields. Projects, notebooks, folders, and collections are application
  rows, never platform stores.
- **Row document**: the latent Yjs 14 document whose lifetime is owned by one
  row. It synchronizes on its own plane, independent of scalar rows
  (ADR-0144).
- **Blob**: immutable owner-scoped bytes addressed by an opaque `BlobId`. Rows
  and KV may reference blobs; documents are bounded interactive CRDT state,
  not a media plane.
- **`rows` relation**: the one stable, lens-independent read-only SQL surface,
  `rows(table_key, row_id, fields_json)` (ADR-0163). It replaces the
  transitional `records` relation and every per-lens TEMP view.
- **Portable artifact**: the detached `.epicenter` directory, a frozen editable
  projection of one selected owner (ADR-0162, ADR-0165). The live replica is
  never the portable format; deliberate editing happens on the artifact, not
  the live file.
- **Authority** (role): the hosted or self-hosted server side that orders
  accepted scalar state, persists documents, and accepts blobs. Hosted
  accepted state lives in one `EpicenterDurableObject` per principal
  (ADR-0175); owner-data routes are ID-free and specific to each
  synchronization plane (ADR-0179). Authority is a protocol role, never a
  public product noun.

## Platform and topology

- **Deployment**: one reachable Epicenter installation, hosted or self-hosted,
  with a canonical base URL and its own auth, storage, sync, and billing policy.
- **Connection**: the authenticated transport a client uses to reach one
  deployment. It carries credentials, cookies, or bearer behavior, but is not the
  data identity.
- **Principal**: the authenticated identity Epicenter uses as the partition key
  (ADR-0092). Cloud resolves many principals from Better Auth users; a
  self-hosted instance resolves every valid operator bearer to the literal
  `instance` principal. Durable namespaces use `principals/<principalId>/...`.
  Billing is hosted-only and lives in `apps/api/worker/billing/`. One principal
  owns exactly one Epicenter (ADR-0160).
- **Account**: the runtime handle for one resolved principal inside one
  deployment. Credentials may rotate, but deployment identity plus `principalId`
  is the stable data identity; transport is how the runtime syncs.
- **Epicenter Home**: the trusted shell above the selected Epicenter. It owns
  navigation, assistant sessions, commands, approvals, and live interface
  state; durable data such as conversations lives in ordinary rows of the
  selected owner (ADR-0180).
- **Trusted app catalog**: the validated static SPAs Epicenter serves from one
  origin and grants one fixed app-window authority. Bundled output supplies the
  default catalog; user-built output may replace a member by app ID.
- **App composition repository**: an ordinary user-owned Git tree whose
  `apps/<id>` source members build the trusted app catalog. It is source, not
  Epicenter app data, runtime installation state, or a permission registry.
- **Row-document connection**: one authenticated Yjs 14 WebSocket for one
  currently open `(table key, row id)` of the synchronized Epicenter. Its
  structured route address is lifecycle identity, not a secret; it is separate
  from scalar push, pull, acquisition, and settlement.
- **Row liveness**: the authority-local fact that a row address is currently
  live. Absence is a derived query, not durable state; deletion is a bounded
  feed marker backed by acquisition, and conforming runtimes never re-mint a
  deleted row id. Liveness is a lifecycle invariant, not a per-row ACL.
- **Star**: the one runnable program that holds your data, composing anchor,
  store, sync, and identity/auth into a deployment (ADR-0069). The star is the
  unit of self-host and the entire privacy question: Epicenter runs it (hosted)
  or you run it (self-host). Distinct from a **service you call** (inference,
  blob URLs): a service is addressed by `{baseUrl, token?}`, sees only the one
  payload you hand it, and is never part of the star's topology. "Single-user /
  sovereign" is a preset over the star's credential source and principal
  resolver, not a mode (ADR-0070, amended by ADR-0092).
- **Anchor**: the always-on node that holds synchronized state so a sleeping
  device can catch up. Who runs the anchor is the whole privacy question (ADR-0068):
  user-run gives topology privacy, Epicenter-run is trusted plaintext. Privacy moves
  by relocating the anchor, never by a setting in the app.
- **Relay**: moves bytes between a person's devices when they cannot reach each
  other directly, then forgets. Blind to content in principle. *Fused with the anchor
  today*: the hosted relay is one Cloudflare Durable Object that also holds and reads
  your plaintext (ADR-0035); separating the relay role from the anchor (ADR-0035) would
  let a blind relay route to an anchor you hold.
- **Store**: the anchor's app-blind sibling for big binaries (audio, images),
  `put` / `get` / `has` by reference; the doc carries the reference, never the bytes
  (ADR-0035). Any S3-compatible endpoint (versitygw for dev, Garage for self-host).
- **Trusted relay**: the server reads workspace plaintext. Zero-knowledge was
  evaluated and rejected; the encryption layer was removed (ADR-0004).
- **Node roles**: four distinct roles, separable even when one machine plays
  several (ADR-0049): *client* runs the agent loop and binds the others;
  *inference server* turns a prompt into tokens; *daemon* holds data and runs
  dispatched tools but never infers; *relay/anchor* is content-blind coordination
  and never infers.
- **Inference server**: the only node role that infers (ADR-0049). One stateless
  turn per request: given a prompt plus a tool catalog it streams tokens, returns
  the model's tool calls, and stops, leaving the client loop to execute them
  (ADR-0047). It sees the prompt and tools as accepted egress to the model
  (ADR-0033), so it is *not* content-blind, unlike the relay, but it owns no loop,
  tool, or transcript. The wire is OpenAI-compatible (ADR-0050), so the box is
  swappable by base URL: Epicenter's metered gateway (house key, billed; it never
  accepts a provider key), a self-hosted gateway (your key or a local model), or
  any third-party OpenAI-compatible endpoint. A BYOK key is handed to a custom
  inference server (self-hosted or local), never to the Epicenter gateway or a
  daemon (ADR-0054).
- **Deployable vs library**: one library, `packages/server`, consumed by two
  deployables: `apps/api` (hosted personal cloud) and `apps/self-host` (the
  community single-partition instance reference, not Epicenter-operated; ADR-0075).
- **Cross-device planes**: cross-device work splits by responsibility. *Inference* (the
  chat brain) streams tokens from an OpenAI-compatible endpoint (ADR-0050),
  over the inference seam. *Scalar sync* carries queryable rows and KV through
  the owner's authority. *Document sync* carries lazy Yjs history and row-scoped
  presence over row-document connections. *Invoke* (the agent's hands) is local
  to the host that owns the tool process, unless a future product re-earns a
  direct URL-addressed box surface.
- **Infisical project**: the owner and access-control boundary. Each secret-using
  runnable surface owns its own `.infisical.json`: `apps/api` and `ops` point
  at Epicenter's hosted/operator project, and personal local apps use ignored
  app-local configs that point at the operator's personal project. The ignored
  configs are per-person bring-your-own provider setup; the committed configs
  are shared Epicenter infrastructure. A single-provider local app may instead
  cache its BYO client credentials to a machine-tier 0600 file after first
  connect (Local Mail's <data-dir>/provider.json), so it reads no per-worktree
  Infisical config on the run path; Infisical then only ever populates the
  environment for that first connect.
- **Infisical environment**: a value-stakes tier inside a project, not an
  owner. In the Epicenter project, `dev` holds substitute values that can hurt
  nothing (the local `wrangler dev` bindings) and `prod` holds hosted
  production/operator credentials. In a personal local-app project, `prod`
  holds the real provider credentials for the person running the tool. The path
  groups by app or surface (`/api`, `/ci`, `/ops`, `/apps/<app>`). The provider
  target rides in the qualified secret name (ADR-0108), never in the
  environment. The monorepo root has no Infisical config, so local apps cannot
  silently inherit Epicenter's hosted/operator project.

## Data API

These entries describe the typed data surface. Most survive the clean break
unchanged because they were already identity-free; entries marked transitional
are replaced by a destination concept above.

- **Workspace KV** (transitional name; destination: the Epicenter's typed KV):
  declared owner-level singleton values with no public row identity, lifecycle,
  or query surface. Internally it may use a reserved row, but application code
  treats it as owner-owned KV.
- **Table key**: the permanent storage key that partitions rows. A
  release-local table name is not a rename lens over another key.
- **Row**: one identified application value in a table. It is the public
  lifecycle aggregate. Server deletion atomically tombstones its address and
  removes its document state; disconnected clients revoke handles and clean up
  retained local document bytes when they observe that deletion.
- **Field key**: the exact permanent JSON key named by a table lens. There is no
  fallback key, alias, automatic rename, or storage default.
- **Table lens**: a release-local `defineTable({ fields, optional })`
  declaration that validates and projects canonical JSON. It does not migrate,
  heal, rewrite, or version stored rows.
- **Field**: one `field.*` validator for a present JSON value. Required versus
  optional presence belongs to the table lens, not the field definition.
- **Row-owned document**: the latent collaborative document owned by a row.
  It has no public id, authority, or lifecycle independent from the row. Its
  runtime-native provider persists and synchronizes it independently from
  scalar row sync.
- **Record**: not a platform lifecycle noun in the canonical model. Use row for
  the durable application aggregate, fields for JSON values, and document for
  the row-owned CRDT state. Historical docs and transitional code may still
  use record while they migrate.
- **Conforming row**: a canonical row that satisfies the opened release's table
  lens. `get()` returns a typed row or `undefined` inside `Result`, or a
  `NonconformingRow` error; `scan()` returns conforming rows and
  nonconforming diagnostics without hiding canonical data.
- **Optional field unset**: patching an optional field with `undefined` removes
  that key. Canonical JSON never stores `undefined`; `null` remains an ordinary
  value when its field accepts null.
- **Application repair**: ordinary bounded reads and typed patches authored by
  the application. Repair is explicit, retryable application work, not a
  platform migration API or an effect of reading.
- **Logical workspace copy** (transitional): coordinated scalar rows, KV,
  compact Yjs 14 document states, and explicit document-availability
  diagnostics. The destination replaces it with the portable `.epicenter`
  artifact (ADR-0162, ADR-0165).
- **Connection-local SQL view** (transitional): one read-only explicit-column
  `TEMP VIEW` installed from the current table lens when a SQLite connection
  opens. The destination refuses per-lens views and exposes only the stable
  `rows` relation (ADR-0163).
- **Row document handle**: the revocable handle returned by a lazy row document
  open. It exposes application roots, local provider durability, and document
  connection status. Releasing the final handle may unload live Yjs state but
  never deletes persisted or synchronized content.
- **Row intent**: one schema-blind `create`, `update`, or `delete` sync unit. It
  carries scalar fields or the reserved KV representation, never document
  updates. The owner's authority orders accepted intents and folds them into
  confirmed scalar state.
- **Worker**: running behavior that observes Epicenter state and writes results
  back. Workers may be local (every node runs them) or agent-bound (one
  configured agent answers). A conversation is answered by the client agent loop
  in the open tab, for every agent (ADR-0047); the daemon contributes data and
  side effects as dispatched actions (tools), never by running the loop.
- **Agent**: the durable address a row or conversation binds to (an immutable
  id). An agent names who should answer; the peer that answers as it is the
  client tab or a daemon, set by the agent's **trust location** (ADR-0030/0043).
- **Trust location**: where an agent's data and tools live, and therefore where
  its side effects run (ADR-0030, ADR-0047). The reasoning loop always runs in
  the client, which drives an inference server (ADR-0049); what varies is the
  agent's capability. A **capability-free** agent (Vocab) has no tools. A
  **local-data** agent (Local Books) keeps its data and action handlers on the
  user's own always-on daemon, which the client loop reaches by dispatching
  actions; data leaves the daemon only as a tool result. The relay is
  content-blind; the inference server is a stateless turn that sees the prompt as
  accepted egress (not content-blind). Trust is per-agent, not global.
- **Conversation loop**: the client-side loop that answers every conversation,
  streams the live turn into a snapshot the UI renders, and persists finished
  messages as records (ADR-0047). It replaces the older doc-observing *answerer*
  (a daemon that wrote the reply into the doc), which ADR-0047 removed. Two
  implementations exist, chosen by transcript reach (ADR-0048): a transcript that
  syncs across a person's peers uses the workspace loop (`createConversation`,
  finished messages in a Yjs child doc); a deliberately device-local transcript
  uses TanStack `createChat` (tab-manager, IndexedDB).
- **Materializer**: a local, addressless worker that projects Epicenter data into
  another store (markdown, sqlite).
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## Transitional workspace vocabulary (shipped code, leaving)

The shipped runtime still keys storage, synchronization, and routes by
Workspace ID. These entries describe that code truthfully so it can be
maintained until each replacement wave lands; do not design new surfaces
against them.

- **Workspace**: the shipped app-defined local-first data and sync unit; it
  owns workspace KV and tables. In the destination, applications bring
  identity-free lenses over the one selected Epicenter instead (ADR-0160,
  ADR-0172).
- **Storage owner**: the Device or one Account that owns a local workspace
  store. Device and Account with the same Workspace ID remain separate owners;
  owner-wide lifecycle never crosses between them.
- **Workspace store**: the runtime-private SQLite family for one storage owner
  and Workspace ID. Bun stores it at
  `workspaces/device/<WorkspaceId>/store.sqlite3` or
  `workspaces/accounts/<AccountKey>/<WorkspaceId>/store.sqlite3`. The
  destination layout is one `epicenters/<owner>/epicenter.sqlite3` plus
  `blobs/` per selected owner (ADR-0161).
- **Device workspace**: a signed-out workspace owned only by the current device.
  Runtime-native SQLite owns its scalar rows; a runtime-native provider owns its
  row documents. It has no deployment, principal, credential, or sync transport.
  The destination equivalent is the explicit local owner (ADR-0181).
- **Account workspace**: a signed-in workspace inside the authenticated
  principal's own partition. The route workspace id is a name in that
  partition; no catalog, grant, or authorization lookup exists. The destination
  removes the name axis entirely: one principal, one Epicenter (ADR-0160).
- **Adoption**: explicit Add, Delete, or Keep after sign-in. Add transfers
  logical scalar state and documents through their native planes; source
  deletion is a separate action after both destination stores are locally
  durable. The destination replaces Device Add with empty initialization or
  whole-owner replacement (ADR-0166).
- **Account authority**: the shipped server runtime owner for everything an
  authenticated principal stores: one actor and one SQLite database containing
  every named workspace as a logical namespace. The destination actor is
  `EpicenterDurableObject`, with authority as a protocol role only (ADR-0175).
- **Canonical workspace runtime**: the greenfield two-plane lane. Runtime-native
  SQLite owns queryable scalar rows and read-only SQL. Runtime-native
  Yjs 14 providers own lazy row documents. The public handle composes
  them without promising cross-plane atomicity. This lane uses `@y/y` 14 only;
  it has no Yjs 13 dependency, persisted reader, alias, dual wire, or fallback.
  Its remaining Workspace-ID plurality is what the one-Epicenter waves delete.
- **Transitional root-Yjs workspace**: the still-active `@epicenter/workspace`
  lane used by apps not yet migrated. Its `defineKv`, definition-owned
  `create/connect/mount`, `.docs`, and `_v` behavior remain compatibility
  surfaces for those apps, not the canonical SQLite design.
- **Transitional `satisfiesWorkspace`**: the root-Yjs bundle-conformance helper
  (renamed from the older `defineWorkspaceBundle`).
- **Transitional actions and collaboration**: actions remain part of the
  root-Yjs workspace bundle; collaboration is sync and presence only.
- **Transitional root-Yjs child document**: a separate, lazy Y.Doc owned by one
  row and reached through `ws.tables.X.docs.name.open(rowId)`. The workspace
  derives its address from the workspace, table, a collision-resistant digest
  of the full row ID, document name, and document format hash; the format
  capability attaches the typed content handle after the runtime opens the doc.
- **Vault**: the designated, not-yet-built home for the one encryption that
  survives ADR-0004: an explicitly encrypted, shared workspace for secrets only
  (blind relay, Argon2-derived key). Its primitives were removed with the
  encryption layer; it returns minimally if a secrets path is built. Distinct
  from the Matter vault (a folder of Markdown).

## Transitional root-Yjs app composition

- **`create<App>`**: the isomorphic doc factory for an app.
- **`open<App>Browser` / `open<App>Extension` / tauri**: environment factories.
- **`#platform/*`**: the build-time platform DI seam for multi-platform (Tauri) apps.
- **`session`**: the singleton holding the signed-in workspace lifecycle.
- **deviceConfig vs workspace KV**: per-device settings (global shortcuts, machine
  collisions) versus synced settings (local shortcuts). The asymmetry is deliberate.

## CLI and watcher

- **Epicenter root**: a directory whose `epicenter.config.ts` declares one mount.
  Discovery walks up to the nearest one. One root, one watcher.
- **Watcher**: the long-lived foreground process started by `epicenter up`.
  It opens the root's mount, owns the lease, joins sync when signed in, and keeps
  materializers alive. It is not a callable action server. Internal code still
  uses `daemon` names (`DaemonMetadata`, `claimDaemonLease`) for this process.
- **Peer**: a device currently present in the same row-document subscription.
  Presence is server-owned and carried by that document's connection, then
  surfaced by app UI or watcher logs, not a generic CLI query.
- **Watcher lifecycle commands**: `up`, `down`, `status`, and `logs`. They use
  metadata, pid liveness, logs, and OS signals. No Unix socket or daemon action
  client exists.
- **Library script**: a `bun ./script.ts` that reads materialized SQLite or
  Markdown directly. Generic off-process writes are deliberately absent; real
  write workflows should earn an app-specific command or in-process script.
