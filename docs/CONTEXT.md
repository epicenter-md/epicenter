# Context: shared vocabulary

The words Epicenter uses for its own concepts, so humans and agents name the same
thing the same way. Keep entries to one or two lines. When a design pass coins or
sharpens a term, update it here in the same change. For the decisions behind these
shapes, see `docs/adr/`.

## Platform and topology

- **Workspace**: a Y.Doc that is at once a sync room and an access-policy atom. The
  unit apps compose; an app may compose several workspaces.
- **Room**: the server side of a workspace. One Cloudflare Durable Object with an
  embedded SQLite `updates` table.
- **Anchor**: the always-on node a workspace syncs through. Who runs the anchor is
  the privacy question: user-run gives topology privacy, Epicenter-run is trusted
  plaintext.
- **Trusted relay**: the server reads workspace plaintext. Zero-knowledge was
  evaluated and rejected; the encryption layer was removed (see `docs/adr/`).
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
  swappable by base URL: Epicenter's metered gateway (house key, billed), a
  self-hosted gateway (your key or a local model), or any third-party
  OpenAI-compatible endpoint. A BYOK key is handed to an inference server, never
  to a daemon.
- **Deployable vs library**: one library, `packages/server`, consumed by two
  deployables: `apps/api` (hosted personal cloud) and `apps/self-host` (the
  community shared-wiki reference, not Epicenter-operated).
- **`personal()` / `shared({ admit })`**: the `packages/server` seam that splits
  the two deployables. Billing is hosted-only and lives in `apps/api/worker/billing/`.

## Workspace API

- **`defineTable` / `defineKv`**: schema builders for a workspace's tables and
  key-value store.
- **`satisfiesWorkspace`**: the bundle-conformance helper (renamed from the older
  `defineWorkspaceBundle`).
- **`scan()`**: the single bulk table read. Returns three buckets, conforming,
  nonconforming, and newer-writer, plus point probes. The valid-only read family
  (`getAllValid`, `getAllInvalid`, `getAll`, `conformance`, `filter`) was deleted.
- **`_v`**: the per-row schema version tuple; conformance is judged against it.
- **Conformance**: whether a stored row matches the current schema. Nonconforming
  rows surface in `scan()`, never silently dropped.
- **Child doc**: a separate Y.Doc per row field (for example a transcript), reached
  through `ws.tables.X.docs.field.open(rowId)`. The workspace owns guid derivation.
- **Worker**: running behavior that observes workspace state and writes results
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
- **Materializer**: a local, addressless worker that projects workspace data into
  another store (markdown, sqlite).
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## App composition

- **`create<App>`**: the isomorphic doc factory for an app.
- **`open<App>Browser` / `open<App>Extension` / tauri**: environment factories.
- **`#platform/*`**: the build-time platform DI seam for multi-platform (Tauri) apps.
- **`session`**: the singleton holding the signed-in workspace lifecycle.
- **deviceConfig vs workspace KV**: per-device settings (global shortcuts, machine
  collisions) versus synced settings (local shortcuts). The asymmetry is deliberate.
- **Vault**: an encrypted, shared workspace for secrets only. Blind relay;
  passphrase derives the key via Argon2.

## CLI and daemon

- **Epicenter root**: a directory whose `epicenter.config.ts` declares one mount.
  Discovery walks up to the nearest one. One root, one daemon.
- **Daemon**: the long-lived foreground process started by `epicenter daemon up`.
  It opens the root's mount and exposes it over a Unix socket as a callable peer.
- **Mesh peer**: a device whose daemon is online and reachable. `run --peer <id>`
  dispatches RPC to a remote peer; `peers` lists connected peers (presence).
- **Mandatory-daemon commands**: `run`, `list`, `peers`. They require a live local
  daemon (`getDaemon` returns `Required` otherwise); there is no cold-path
  fallback (see `docs/adr/`).
- **Library script**: a `bun ./script.ts` that calls a running daemon's actions
  through `connectDaemonActions` (a type-only proxy: it holds no Y.Doc and runs no
  workspace code) and composes/loops/dispatches RPC. Reads default to query
  actions; bulk reads drop to the read-only SQLite materializer. The automation
  surface; the CLI is a one-shot shell shortcut, not a place to build automation.

## Whispering dictation

- **Dictionary**: a flat `string[]` of words Whispering should know (proper nouns,
  domain terms). Injection-only: composed into every AI prompt, never find/replace.
  See `docs/adr/0041-...`.
- **Polish**: the always-on, meaning-preserving AI pass run after transcription.
  On by default, gated on a configured key. Not a Recipe.
- **Speed mode**: Polish turned off. The raw transcript ships instantly, no AI.
- **Recipe**: a named reshape (`name` + one instruction), text in and text out,
  run on demand over already-polished text. Built-ins live in code; the `recipes`
  table holds customs. Replaces the old "Transformation" and "Format".
- **take**: one Recipe's output. **picker**: the palette over the Recipe library.
- **source / trigger / delivery**: the per-host adapter around a Recipe (where the
  text comes from, what fires it, where the take lands).
