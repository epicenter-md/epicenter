# Immutable application data generations

**Date**: 2026-07-13
**Status**: In Progress
**Owner**: Epicenter workspace and app shell
**Branch**: `codex/records-epoch-clean-break`

## One Sentence

An application build opens one immutable locked data generation, asks before
initializing over a possible predecessor, and leaves all cross-generation
copying to application code.

## Overview

Replace in-place application schema evolution with append-only data generations.
Each generation derives one exact workspace namespace across records, KV,
child documents, and application-owned blobs; the current build discovers that
state without creating it and asks before entering a new generation.

The durable decisions live in proposed [ADR-0134](../docs/adr/0134-application-data-generations-own-immutable-workspace-namespaces.md)
and [ADR-0135](../docs/adr/0135-new-builds-ask-before-initializing-a-new-data-generation.md).
This spec is the temporary execution spine and is deleted when those decisions
land.

## Current State

The SQLite definition uses one authored ID for several durable responsibilities:

```ts
type WorkspaceDefinition = {
	readonly id: string;
	readonly recordsDescriptor: string;
	readonly recordsSchemaHash: string;
	readonly kvDocumentGuid: string;
};
```

`definition.id` stamps local SQLite metadata, binds the server workspace,
derives the KV document, and roots child-document addresses. It is authored
independently from any application or data-generation identity, so the API can
express contradictory values. This is an unreleased path with no user data to
preserve; the implementation can replace those IDs cleanly.

Records have a coherent epoch fence and self-describing recovery checkpoint,
but [ADR-0130](../docs/adr/0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)
still describes schema change as same-workspace replacement. No replacement
endpoint exists in the branch. The missing operation is an opportunity to
withdraw the promise instead of implementing it.

The application contract also extends beyond records:

- synchronized KV uses `<workspaceId>.kv`;
- child-document addresses include the workspace ID and format hash;
- Whispering web audio uses the unversioned IndexedDB name `RecordingDB`;
- Tauri audio artifacts are addressed by recording ID in app-owned storage.

There is no generation lock, non-creating namespace discovery API, historical
build boot gate, generic active-workspace exporter, or cross-generation seed.

## Target Shape

```txt
developer publishes build for data generation N
  |
  +-> append-only generation lock
  |     appId
  |     dataGeneration
  |     derived workspaceId
  |     recordsSchemaHash
  |     KV / child-doc / blob identity tokens
  |
  `-> build boot
        |
        +-> N initialized locally -> open N
        |
        +-> no predecessors -> initialize N, open N
        |
        `-> predecessor is possible -> ask before creating N
              |
              +-> start current version
              `-> continue previous version when available
```

The records authority remains schema-blind. It receives the derived workspace ID
and knows nothing about app IDs, generation numbers, predecessor order, current
builds, or historical routes.

### Identity axes

| Identity | Owner | Purpose |
| --- | --- | --- |
| `appId` | Developer | Stable product identity |
| `dataGeneration` | Developer | Ordered immutable durable contract |
| `workspaceId` | Generation lock | Framework-generated storage and sync namespace |
| `recordsSchemaHash` | Framework | Canonical records acceptance identity |
| `recordsEpoch` | Authority | One records history incarnation inside a generation |
| build identity | Release system | Executable UI compatible with one data generation |

The framework derives `<appId>-g<number>`, records it in the append-only lock,
and stores it in durable identity metadata. Runtime code consumes the validated
lock entry and never parses the ID; applications cannot override it. Recording
the generated value makes a future derivation-rule change fail CI instead of
silently renaming storage.

## Comparable Flows

| Surface | Relevant behavior | Decision |
| --- | --- | --- |
| Epicenter sign-in migration | Durable source state triggers a repeated prompt without a migrated flag | Borrow state-derived prompting, not its same-schema copier |
| Obsidian vaults | An empty vault still has identity | Use complete namespace identity, never row count |
| 1Password import | Copy and source disposal are separate decisions | Keep source removal separate |
| Notion workspace switching | A preference remembers the selected workspace | Refuse because generation order plus local identity determines normal boot |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Generation boundary | 2 coherence | Any durable contract change creates a new generation | [ADR-0134](../docs/adr/0134-application-data-generations-own-immutable-workspace-namespaces.md) refuses compatibility classification across every plane |
| Runtime workspace identity | 2 coherence | Derive it from `appId` and `dataGeneration`; do not accept an independent ID | A third authored identity can disagree and earns no user-visible capability |
| Boot owner | 2 coherence | The current build probes and prompts | [ADR-0135](../docs/adr/0135-new-builds-ask-before-initializing-a-new-data-generation.md) removes the neutral shell and manifest service |
| Initialization evidence | 1 evidence | Complete root identity metadata written in the schema transaction | Current SQLite initialization already writes DDL and identity in one transaction |
| Remote predecessor uncertainty | 2 coherence | Ask whenever predecessors exist and current local state is absent | Local absence cannot prove cloud absence; the server remains generation-blind |
| Initial actions | 2 coherence | Start current or continue previous; use only existing app exports | Copy is not honest until one app proves all durable planes |
| Previous generation writes | 2 coherence | Remain independent and writable | Read-only retirement would require distributed cutover machinery |
| Historical builds | 3 taste | Best-effort execution; require app-owned inspection/export before retirement | Same-origin old code is a security cost, while permanent runnable history is not required for storage sovereignty |

## Product Flow

### Current generation already initialized

The build validates the local root identity and opens normally. It does not scan
rows, inspect older planes, or read a selected-generation preference.

### Current generation absent, no predecessors

The build initializes its namespace. SQLite creates the schema and writes the
complete identity in one transaction. KV, documents, and blobs remain lazy and
must use generation-qualified identities when first opened.

### Current generation absent, predecessor possible

The build creates nothing and shows a blocking gate:

```txt
Whispering has a new data version

The current version uses separate storage. Your previous data will not be
deleted, and changes made in one version will not appear in the other.

[Start current version]  [Continue with previous version]
```

The exact user-facing words belong to the app. The contract is that continuing
does not initialize the current generation, while starting it creates or opens
the current namespace. If the current synchronized authority already exists,
normal bootstrap pulls it after the user chooses the current version.

### Invalid or partial local namespace

A file without complete matching identity is not initialized and is never
silently adopted or overwritten. The first implementation may offer file
download and explicit deletion; it does not repair metadata or infer intent.

## Refusals

The first implementation adds none of the following:

- in-place schema replacement;
- automatic cross-generation Copy;
- a `Seed`, importer, transform registry, or migration chain;
- imports into nonempty targets;
- predecessor or compatibility graphs beyond ordered lock entries;
- selected-generation local storage;
- a neutral shell or fetched generation manifest;
- a server route for generation discovery;
- server knowledge of app IDs or generation numbers;
- a read-only fence for older generations;
- shared mutable blobs, content-addressed blob infrastructure, or blob GC;
- automatic source deletion;
- permanent historical-bundle execution guarantees;
- subdomain-per-generation routing;
- arbitrary runtime workspace IDs or a workspace catalog.

## Implementation Plan

### Wave 1: Capture immutable generation identity

- [x] Audit every adopting app's durable planes before changing construction
  APIs.
- [x] Choose the smallest committed append-only lock representation and create
  a generation-one entry for each adopting app.
- [x] Add a CI check that refuses edits or removals of published lock entries
  and refuses records-schema or declared plane-token drift inside a generation.
- [x] Change the SQLite workspace definition to receive one validated
  generation identity carrying `appId`, `dataGeneration`, and the generated
  `workspaceId`. Delete the independently authored `id` input and do not add an
  override.
- [x] Derive `<appId>-g<number>` through one function used by database, sync,
  KV, child-document, and browser-storage identities.

Proof: every adopting application has one generation-one namespace, and no old
fixed workspace ID or compatibility alias remains on the new SQLite path.

### Wave 2: Add non-creating local discovery

- [ ] Add an identity inspection path that distinguishes absent, initialized,
  and invalid without initializing storage.
- [ ] Implement browser OPFS inspection without `create: true` behavior or an
  eager worker that creates the file being probed.
- [ ] Preserve the existing single-transaction DDL and identity stamp; make the
  valid identity the only initialized marker.
- [ ] Cover an absent file, empty foreign file, incomplete metadata, wrong
  workspace ID, wrong records descriptor, and valid user-empty database.

Proof: discovery has no durable side effects, and a crash before the identity
transaction cannot select a generation.

### Wave 3: Build one browser boot gate

- [ ] Put predecessor discovery in one current application build, not a shared
  neutral shell process.
- [ ] Implement the three boot branches from ADR-0135.
- [ ] Serve historical web builds from same-origin versioned paths. Keep route
  details internal to the Previous versions surface.
- [ ] Offer only Start current and Continue previous in the shared contract.
  Reuse an app's existing exporter only when it already covers the data being
  described.
- [ ] Do not persist dismissal or selection. Reopening the current build repeats
  the gate until its namespace is initialized.

Proof: with only generation one initialized, opening generation two creates no
generation-two storage until the user chooses Start current.

### Wave 4: Prove two independent generations

- [ ] Use a small browser fixture with intentionally different generation-one
  and generation-two records schemas.
- [ ] Verify the generations use different local SQLite files, KV identities,
  child-document address roots, and synchronized workspace IDs.
- [ ] Verify generation one remains readable, writable, and synchronizable
  after generation two starts.
- [ ] Verify generation two never opens generation-one tables or replays its
  outbox.
- [ ] Verify a new device with no local generation receives the consent gate
  rather than silently creating the latest namespace when predecessors exist.

Proof: the latest UI contains no historical schema reader and the sync server
contains no generation branch.

### Wave 5: Stop importing direct boot, verify, then remove

- [ ] Route the fixture entirely through generation-aware boot while leaving
  its old direct boot helper on disk but unused.
- [ ] Run record-sync, SQLite, app-shell, browser, typecheck, and documentation
  hygiene checks.
- [ ] Revert to the old import if the new path fails before deleting anything.
- [ ] Delete the unused direct boot helper, obsolete fixtures, and docs only
  after verification passes.
- [ ] Re-run searches for schema replacement, independently authored workspace
  IDs, migration chains, selected-generation flags, and seed/import vocabulary
  on this path.

### Wave 6: Land the durable decision

- [ ] Change ADR-0134 and ADR-0135 from Proposed to Accepted.
- [ ] Update `docs/CONTEXT.md`: application data generation, generation lock,
  workspace ID, records epoch, and generation-aware boot.
- [ ] Remove current-truth language that says a schema change replaces records
  inside one workspace. Keep historical ADR and spec references intact.
- [ ] Delete this spent spec and add its path to `docs/spec-history.md`.

## Stop Conditions

Stop this spec after the browser fixture proves the lifecycle. Do not continue
into Whispering or automatic Copy.

Open a separate application spec only when an app commits to a real durable
contract change. That spec must first inventory every durable plane. Whispering
cannot offer Copy until its browser and Tauri audio storage are
generation-qualified and the app can state exactly which snapshot it copies.

Reopen the platform boundary only if a real application proves one of these:

- several user-created workspace instances are a product requirement;
- an app cannot remain usable without coordinated cross-generation cutover;
- an existing export cannot preserve a durable plane the app promises users;
- historical web code must be sandboxed while retaining old-origin storage;
- one concrete Copy flow can be made retry-safe without a platform staging
  protocol.

## Edge Cases

### Existing development storage uses the old fixed ID

The SQLite path is unreleased and this plan assumes no users. Delete or reset
development storage and use the derived generation-one namespace. Do not add an
alias, fallback probe, or import bridge.

### No local data but an older remote authority may exist

The current build still asks because local absence is not evidence of remote
absence. Choosing the previous version lets its ordinary sync path discover the
remote authority. Choosing the current version does the same for the current
authority.

### Current authority exists on another device

The local namespace remains absent, so the build asks once. Choosing the current
version initializes the local replica and bootstraps the existing authority.
No server generation lookup is required.

### User opens an older generation after starting the current one

The old generation remains independent and writable. The UI states that later
edits do not cross generations. Opening it does not change the current build's
default because the current local identity still exists.

### Historical build must be withdrawn

Same-origin old code may be removed for security. Before retirement, the app
must provide an inspection or export path for each durable plane it owns. The
platform does not claim that the canonical records descriptor can export KV,
child documents, or blobs.

## Open Questions

1. **What committed lock representation keeps published entries append-only
   while allowing the current records hash to be checked mechanically?**
   - Recommendation: prefer one small app-owned TypeScript or JSON artifact and
     one repository check. Do not introduce a runtime registry or generated
     compatibility API.

2. **Which browser fixture should prove generation-aware boot first?**
   - Recommendation: use the smallest existing SQLite browser example whose
     storage can be inspected visually. Do not make Whispering's Yjs-to-SQLite
     adoption a prerequisite for proving the generation boundary.

3. **How should a corrupt unidentified OPFS file be offered for recovery?**
   - Recommendation: raw file download plus explicit deletion is enough for the
     first proof. Do not repair or adopt it automatically.

## Success Criteria

- [ ] Published generation entries are append-only and CI refuses identity
  drift without a new generation.
- [ ] Apps author no workspace ID independently from `appId` and
  `dataGeneration`.
- [ ] Every declared durable plane in the proof is generation-qualified.
- [ ] Discovery distinguishes absent, initialized, and invalid without creating
  storage.
- [ ] A valid user-empty database counts as initialized; row count is never a
  generation selector.
- [ ] A current build asks before first local initialization whenever its lock
  has predecessors.
- [ ] No selected-generation preference or migration-complete flag exists.
- [ ] Starting the current generation leaves every predecessor untouched.
- [ ] Old generations remain independent; no cross-generation read-only fence
  or outbox replay exists.
- [ ] The server sync path receives only the derived workspace ID and records
  epoch, with no application generation behavior.
- [ ] Automatic Copy, source deletion, blob sharing, and historical-bundle
  retirement remain outside this implementation.
- [ ] Targeted tests, typechecks, browser smoke coverage, and documentation
  hygiene pass before the old direct boot path is deleted.

## References

- `packages/workspace/src/sqlite/definition.ts`: current workspace ID and
  records-definition ownership.
- `packages/workspace/src/sqlite/database.ts`: atomic schema and identity stamp.
- `packages/workspace/src/sqlite/browser-worker.ts`: current OPFS owner and file
  creation boundary.
- `packages/workspace/src/sqlite/replica.ts`: workspace binding and epoch fence.
- `packages/server/src/routes/records.ts`: schema-blind workspace route.
- `packages/app-shell/src/sign-in-migration/`: flag-free prompt reference, not a
  cross-generation copier.
- `apps/whispering/src/lib/services/blob-store/web/dexie-database.ts`:
  unversioned browser audio database that blocks an honest Whispering Copy.
- `docs/CONTEXT.md`: current vocabulary to update only after implementation.
