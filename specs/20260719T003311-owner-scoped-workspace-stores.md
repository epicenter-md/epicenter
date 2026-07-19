# Owner-scoped workspace stores and Epicenter Home

**Date**: 2026-07-19
**Status**: In Progress
**Owner**: Epicenter

## One Sentence

The desktop host opens every built-in workspace through one canonical runtime
whose owner-first directories sit beside global blobs and models, while
Epicenter Home remains a shell above those workspaces.

## Overview

This clean break replaces Query-owned and hash-hidden local persistence with
the owner-scoped tree in [ADR-0151](../docs/adr/0151-local-workspace-stores-use-owner-first-directories.md), then migrates the remaining host-owned root-Yjs workspaces so the Home model in [ADR-0152](../docs/adr/0152-epicenter-home-is-a-shell-above-workspaces.md) has one storage plane. Existing app data is deliberately not migrated.

## Completion

The work is complete when Epicenter creates only this durable app-data shape,
all built-in structured data enters through the host-owned canonical workspace
runtime, and no live code names or opens Query storage or a persisted node id:

```txt
<appData>/
  blobs/<BlobId>/{data,metadata.json}
  workspaces/
    device/<WorkspaceId>/store.sqlite3
    accounts/<AccountKey>/{account.json,<WorkspaceId>/store.sqlite3}
  models/<ModelId>/<Version>/...
```

## Current State

Rust passes two roots to the Bun sidecar:

```txt
EPICENTER_DATA_DIR=<appData>
EPICENTER_QUERY_DATA_DIR=<appData>/query
```

The sidecar uses `<appData>/blobs` for blobs but passes the Query directory to
the Query host and desktop workspace owner. The canonical Bun runtime then
derives another hashed persistence directory and opens flat
`<WorkspaceId>.records.sqlite3` files. Query and Todos separately use
root-Yjs persistence and `query/node-id`.

```txt
<appData>/
  blobs/...
  query/
    node-id
    yjs/...
    <device-hash>/epicenter-honeycrisp.records.sqlite3
    workspace-runtime/<device-hash>/
      epicenter-skills.records.sqlite3
      epicenter-whispering.records.sqlite3
```

This creates three problems:

1. **The shell appears to own data.** Query is an interface and orchestration
   service, not a durable storage owner.
2. **One process has two Device runtime owners.** Query opens Honeycrisp in one
   canonical runtime while the desktop API opens Skills and Whispering in
   another.
3. **Account derivation can drift silently.** The opaque directory hash has no
   versioned witness tying it back to canonical deployment and principal
   inputs.

## Target Ownership

```txt
Rust/Tauri
  owns application identity, native lifecycle, models, and native recording

Bun application host
  owns one Device canonical runtime
    opens every built-in Device workspace
    exposes registered workspaces to trusted SPAs
    supplies typed handles to host services

Epicenter Home
  owns live assistant and command state
  persists durable history through epicenter-conversations

Trusted SPA
  addresses a registered Workspace ID through same-origin routes
  never receives a SQLite path or raw database handle
```

## Research Findings

### The owner model already belongs to the workspace package

`createDeviceBunWorkspaceRuntime`, `createAccountBunWorkspaceRuntime`,
`devicePersistenceKey`, and `accountPersistenceKey` already live in the MIT
workspace package. Moving the literal `device` and `accounts` path grammar into
that runtime strengthens an existing general local-first boundary; it does not
move Epicenter-only policy into the toolkit.

### Conversation migration is a separate representation change

`@epicenter/chat` currently exports a transitional root-Yjs table with a named
`messages` child doc. Epicenter, Vocab, and Tab Manager consume it. The canonical
runtime instead gives every row one runtime-native Yjs 14 document. Migrating
conversation storage therefore changes the shared table and message-store API,
not just a path. It follows the physical-layout slice rather than sharing its
rollback point.

### Cloud Code adversarial review

The independent review agreed that the runtime should own the owner-first path
grammar and that conversations should migrate in a later slice. Its strongest
correction was to retain a versioned Account witness: deterministic hashing
without a witness turns normalization drift into silent data orphaning.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Physical workspace layout | 2 coherence | Owner-first directories from ADR-0151 | Makes Device and Account isolation structural |
| SQLite filename | 3 taste | `store.sqlite3` | Durable implementation store without implying portability |
| Account key | 2 coherence | Deterministic full SHA-256 | Avoids a second durable lookup registry |
| Account witness | 2 coherence | Versioned `account.json` | Detects key-derivation drift before opening a wrong store |
| Device witness | 2 coherence | None | The literal `device/` directory already states the identity |
| Existing app data | 2 coherence | No migration or fallback | The user explicitly chose a greenfield clean break |
| Runtime ownership | 2 coherence | One Device runtime per Bun host | Prevents duplicate file owners and gives SPAs one entry |
| Conversation migration | 2 coherence | Canonical SQLite schema plus frozen legacy export | Home moves cleanly without forcing unrelated app workspace migrations into this wave |
| Third-party allocation | Deferred | Reserve `epicenter-*` only | Installation and permissions have no product consumer yet |

## Execution Plan

### Slice A: Canonical physical layout

- [x] Add golden and shape tests for Device and Account paths, Account key
  derivation, witness mismatch, cross-owner isolation, and Workspace ID path
  safety.
- [x] Replace `storageRoot` plus `persistenceKey` with owner-specific
  `workspacesRoot` resolution inside the Bun runtime.
- [x] Open each workspace at `<owner>/<WorkspaceId>/store.sqlite3` and remove
  `.epicenter-runtime.json`.
- [x] Write and verify `accounts/<AccountKey>/account.json` before opening an
  Account workspace.
- [x] Make the desktop workspace owner the one Device runtime owner and expose
  registered typed handles to Bun host services.
- [x] Register Honeycrisp beside Skills and Whispering; stop creating a second
  canonical runtime inside the Home host.
- [x] Pass `<appData>/workspaces` from the Epicenter entrypoint.
- [x] Stop importing the old canonical path shape.
- [x] Run focused workspace and Epicenter tests, package typechecks, a desktop
  storage smoke test, and stale-path searches.
- [x] Delete the unused hashed-root and flat-file implementation.

Slice A exited with every canonical SQLite workspace under `workspaces/`.
Slice B then removed the transitional Home and Todos root-Yjs lane; no datum
has two representations.

### Slice B: Epicenter Home and conversations

- [x] Define canonical `epicenter-conversations` storage in `@epicenter/chat`
  using the row-owned Yjs 14 document.
- [x] Adapt the agent message store to that document without a second message
  representation.
- [x] Move Epicenter Home to the canonical schema. Freeze the older root-Yjs
  definition behind `@epicenter/chat/legacy-root-yjs` for Vocab, Tab Manager,
  and app-shell until their owning workspaces migrate.
- [x] Move Todos or remove it from the built-in Home catalog; do not preserve a
  root-Yjs-only host lane for one sample app.
- [x] Rename Query product, route, API, environment, and code vocabulary to
  Epicenter Home vocabulary.
- [x] Stop importing root-Yjs Bun persistence and persisted NodeId from the
  Epicenter host.
- [x] Verify restart durability, conversation resumption, direct commands,
  approvals, and two trusted surfaces opening one registered workspace.
- [x] Delete `query/`, `node-id`, old Query workspace definitions, and obsolete
  tests and documentation.

### Slice C: Close the decision scaffolding

- [ ] Run repository typecheck, focused tests, doc hygiene, license checks, and
  stale-name searches.
- [ ] Flip ADR-0151 and ADR-0152 to Accepted.
- [ ] Add the completed spec to `docs/spec-history.md` through the generator,
  then delete this spec.

## Verification

### Physical invariants

- The same Workspace ID under Device and Account opens different files.
- Two accounts with the same principal on different deployments do not share a
  directory.
- A fixed account input derives one pinned Account key.
- An Account witness mismatch refuses before SQLite opens.
- SQLite WAL and SHM files remain inside the workspace directory.
- No Device open creates an identity marker.
- Account removal cannot touch `workspaces/device`.

### Product invariants

- Whispering and another trusted surface can read the same registered
  workspace through the host route.
- A complete restart preserves canonical rows, KV, and row documents.
- Conversation history survives a complete restart and replacement of the Home
  interface.
- Epicenter creates no `workspace-runtime`, Query storage, or persisted node id
  after Slice B.

### Commands

```sh
bun test packages/workspace/src/sqlite apps/epicenter/src
bun run --cwd packages/workspace typecheck
bun run --cwd apps/epicenter typecheck
bun run check:doc-hygiene
bun run check:licenses
```

Run targeted package tests after each wave. Run the full repository checks only
after the old imports are stopped and again after deletion.

## Explicit Refusals

- No old-path reader, migration, dual write, alias, or fallback.
- No caller-supplied Account key or raw workspace path callback.
- No Account ID allocation registry.
- No Device identity marker.
- No persisted node identity in the Epicenter app-data tree.
- No physical SQLite file as an export or cross-surface capability.
- No third-party app-data namespace before installation is designed.

## Open Questions

There are no product forks blocking Slice A. Slice B may delete Todos from the
Home catalog instead of migrating it if no durable product behavior depends on
that sample app; decide from call-site evidence before implementation.
