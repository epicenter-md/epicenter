# App-owned workspace lenses clean break

**Date**: 2026-07-19
**Status**: In Progress
**Owner**: Epicenter workspace and desktop runtime
**Branch**: `codex/sqlite-sync-architecture`
**Decision owners**: [ADR-0156](../docs/adr/0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), [ADR-0157](../docs/adr/0157-read-only-sql-exposes-one-schema-opaque-row-relation.md), [ADR-0158](../docs/adr/0158-installed-apps-declare-workspace-ids-but-run-no-bun-modules.md)

## One Sentence

Separate the raw workspace owner from every application-owned lens, keep lens
values and result schemas on the calling JavaScript side of each transport, and
derive only static Workspace ID inventory from installed applications.

## How to read this spec

Read first:

```txt
One Sentence
Recognition Criteria
Current State
Target Shape
Clean-Break Waves
Verification
```

Read when changing architecture:

```txt
Decision Boundaries
SQL Contract
Installed-App Contract
Deletion Ledger
```

This spec maps the replacement. It does not authorize deletion of existing
Device data. Existing unrelated edits in the main worktree are outside this
change and must remain untouched.

## Recognition Criteria

- Public application code says `await runtime.open(lens)` and receives
  `Workspace<TLens>`.
- `WorkspaceLens` and `Workspace` are the only SQLite workspace public nouns;
  `WorkspaceDefinition` and `WorkspaceHandle` have no compatibility aliases.
- One raw persistence, synchronization, settlement, and document owner exists
  per Workspace ID in each runtime.
- Two different lens objects with the same ID can stay open concurrently and
  observe the same canonical mutations.
- Browser Worker messages and desktop HTTP operations contain no table lens,
  KV lens, serialized definition, result schema, hash, or fingerprint.
- Opening performs no conformance scan. Nonconforming row and KV results appear
  only when the value is read through a lens.
- Read-only SQL exposes only `records(table_key, row_id, fields_json)`;
  no lens-shaped named table views exist.
- Schema-opaque capture, add, delete, export, synchronization, and document
  lifecycle accept Workspace IDs rather than lens values.
- An installed app may derive static `workspaces: string[]` metadata from
  `src/epicenter.ts`; the runtime imports no app `host.mjs`.
- Catalog replacement is atomic and activates only after restart. Uninstall
  never deletes workspace data.

## Current State

### Ownership is fused to the first definition

`packages/workspace/src/sqlite/runtime-definition.ts` defines
`WorkspaceDefinition`. It contains the stable ID and the release-local tables
and KV lenses in one value.

`packages/workspace/src/sqlite/runtime.ts` stores this value in each
`RuntimeEntry`. Its `rowsFor` path passes the definition to
`createCanonicalRows`, and its KV path passes the definition to
`createCanonicalKv`. The resulting typed `WorkspaceHandle` is also the object
that exposes synchronization, documents, capture-related state, and disposal.

The runtime map is keyed by Workspace ID, but `open` rejects a second object:

```txt
Map<workspaceId, { definition, owner, handle }>
                           ^
                           one privileged lens
```

`packages/workspace/src/sqlite/runtime.test.ts` asserts the rejection text
`already bound to another definition`.

### Browser sends the lens into the Worker

`packages/workspace/src/sqlite/browser-runtime-protocol.ts` defines
`BrowserWorkspaceManifest`, serialized table lenses, and KV lens data.

`packages/workspace/src/sqlite/browser-runtime.ts` creates that manifest and
rejects another definition for the same ID. The main-thread handle proxies
typed operations but does not own the complete validation boundary.

`packages/workspace/src/sqlite/browser-runtime-worker.ts` reconstructs table
definitions, creates `CanonicalRows` and `CanonicalKv`, compares manifests, and
rejects another release-local lens. The Worker owns both the OPFS connection
and application interpretation.

### Desktop pre-registers full definitions

`packages/workspace/src/sqlite/desktop-owner.ts` accepts
`definitions: readonly WorkspaceDefinition[]`, builds a closed catalog, opens
typed handles in Bun, and executes typed operations server-side.

`apps/epicenter/src/workspace-owner.ts` statically imports the Honeycrisp,
Skills, Whispering, and Conversations definitions for that catalog.

`packages/workspace/src/sqlite/desktop-runtime.ts` keeps its own one-definition
assertion. It sends table and KV operations to the desktop owner while relying
on the Bun definition for validation. `apps/epicenter/src/desktop-workspace.test.ts`
asserts the rejection.

The desktop record wire is already schema-opaque. The violation is the Bun
owner's statically linked definition catalog and server-side interpretation,
not the serialized operation shape. The synchronization wire is also already
conformant and needs no lens-removal change.

### SQL installs the privileged lens

`packages/workspace/src/sqlite/canonical-rows.ts` combines canonical row
mutation, typed projection, validation, and SQL view installation.
For synchronized visible state, `Workspace.sql` materializes per-lens temporary
projection state on each call and queries lens-shaped named views over it.
The replacement targets are `installTemporaryViews`,
`refreshTemporaryProjections`, `projectedSqlColumn`, `sqlJsonTypes`, and
`projectionTableName`.

Production code has no SQLite `Workspace.sql` caller. Current uses are tests in
`packages/workspace/src/sqlite/runtime.test.ts`,
`apps/epicenter/src/desktop-workspace.test.ts`,
`packages/skills/src/skills.test.ts`, and
`apps/whispering/src/lib/workspace/greenfield-slice.test.ts`.

The current statement guard blocks `__epicenter*`, `sqlite_*`, and
`pragma_*`, but it does not hide every physical runtime relation. The new
single-relation contract therefore closes an existing private-layout leak in
addition to removing per-lens projection state.

### The derived app catalog has no workspace inventory

`apps/epicenter/src/static-assets.ts` derives only app ID, title, and static
asset resolution from the validated output directory.

`apps/epicenter/src/main.ts` constructs the closed workspace owner before it
loads the derived static app catalog. `apps/epicenter/src/host.ts` composes
statically linked built-in action catalogs and explicit external tool catalogs.
No installed app host entry is imported today.

## Target Shape

### Ownership diagram

```txt
Honeycrisp JavaScript                   Reporting JavaScript
  honeycrispWorkspace: WorkspaceLens      reportingWorkspace: WorkspaceLens
           |                                        |
           +------------- runtime.open -------------+
                                  |
                       raw owner cache by ID
                                  |
              +-------------------+-------------------+
              |                   |                   |
       canonical rows/KV       row documents      sync/settlement
              |
        one local replica

Browser:  typed views in page    -> raw messages -> OPFS Worker
Desktop:  typed views in webview -> raw HTTP     -> Bun SQLite owner
Remote:                              raw sync     -> account authority
```

The lens never moves right across an arrow.

### Public API

```ts
export const honeycrispWorkspace = defineWorkspace({
  id: 'epicenter-honeycrisp',
  tables: { notes },
  kv: honeycrispKv,
});

const workspace = await runtime.open(honeycrispWorkspace);
```

Conceptual types:

```ts
type WorkspaceLens<
  TTables extends TableLensDefinitions,
  TKv extends KvDefinitions,
> = {
  readonly id: WorkspaceId;
  readonly tables: TTables;
  readonly kv: TKv;
};

type Workspace<TLens extends WorkspaceLens> = {
  readonly id: TLens['id'];
  readonly tables: WorkspaceTables<TLens>;
  readonly kv: WorkspaceKv<TLens>;
  readonly sync: WorkspaceSync;
  sql<T>(query: string, parameters: SqlParameters, result: StandardSchemaV1<T>): Promise<T[]>;
};
```

`Workspace.sql` retains a local result-schema argument for inference and
validation. Browser and desktop clients strip it before transport, receive raw
rows, and validate them locally.

Raw lifecycle methods are ID-shaped:

```ts
await runtime.capture(workspaceId);
await runtime.add(workspaceId, copy);
await runtime.delete(workspaceId);
```

Exact names may follow existing runtime grouping, but none of these operations
accept or inspect a `WorkspaceLens`.

### Internal split

The package needs two cohesive layers, not a public two-step API:

```txt
RawWorkspaceOwner
  id
  canonical row and KV commands
  raw read-only SQL
  row document runtime
  sync and settle
  capture/add/delete primitives
  dispose

createWorkspaceView(owner, lens)
  typed tables
  typed KV
  local SQL-result validation
  optional lens-identity memoization
```

The raw owner cache is keyed by ID. Typed-view memoization may use lens object
identity, but correctness must not depend on memoization. Typed views own no
resources and have no disposal API; they remain usable until runtime disposal
closes the one ID-owned raw owner.

### Raw operation boundary

Transport operations use only permanent storage vocabulary:

```txt
read-current-row  { workspaceId, tableKey, rowId }
list-rows         { workspaceId, tableKey, cursor, limit }
admit-intent      { workspaceId, intent: WireRowIntent }
kv-read-map       { workspaceId }
sql               { workspaceId, query, parameters }
```

The client mints row IDs, validates declared values, and constructs raw intents
before mutation. The owner validates bounded JSON, keys, identifiers, row
lifecycle, read-only SQL, and transport limits. Unknown keys remain preserved
by patch semantics.

## SQL Contract

Each connection installs one runtime-owned logical relation:

```sql
CREATE TEMP VIEW records(table_key, row_id, fields_json) AS
SELECT /* private canonical projection */;
```

The public contract is the relation and its three columns, not the private
`SELECT`. It exposes visible current application rows, including the optimistic
intent overlay for synchronized replicas, and excludes the reserved KV row.
Application queries must filter or join by `table_key` explicitly.

The executor must prevent access to private schemas and reject all mutation.
It compiles each bound query with SQLite `EXPLAIN`, permits only `OpenRead`
targets belonging to `records`, and rejects `OpenWrite` and `VOpen`. Therefore
table-valued and virtual-table reads such as `json_each` and `json_tree` are
refused; scalar JSON functions remain supported. SELECT and WITH scalar queries
that open no relation remain valid. No result schema is serialized into a
Worker manifest or desktop request.

The runtime reserves every physical relation. `records` is the only relation
addressable through `Workspace.sql`; application table keys never become SQL
relation names.

## Installed-App Contract

Source tree:

```txt
apps/<id>/
  package.json
  bun.lock
  src/
    epicenter.ts       optional build-time declaration
    workspace.ts       optional ordinary shared application module
  dist/
    index.html
    ...static assets
```

`bun run build` still has one canonical SPA output: `dist/index.html`. The
Epicenter catalog build separately evaluates the optional declaration during
the confirmed build step and emits host-owned JSON metadata.

```ts
export default defineEpicenter({
  workspaces: ['epicenter-honeycrisp'],
});
```

Derived generation:

```txt
catalog-candidate/
  catalog.json          app presentation plus Workspace ID inventory
  apps/
    <id>/               copied static output
      index.html
      ...assets
```

There is no `host.mjs`. An executable module imported by Bun would have ambient
Bun authority, so request-scoped installed actions are deferred rather than
described as sandboxed. Built-in action catalogs in `apps/epicenter/src/host.ts`
remain first-party code. Explicit external MCP processes retain their existing
trust ceremony and lifecycle.

## Decision Boundaries

| Concern | Owner | Refusal |
| --- | --- | --- |
| Durable workspace identity | Runtime, by Workspace ID | No lens fingerprint or provider |
| Typed row and KV meaning | Calling application | No lens over Worker, HTTP, or sync |
| Physical SQLite layout | Raw owner | No physical table contract |
| Advanced reads | `records` plus app result schema | No lens-shaped named SQL views |
| Installed app inventory | Derived catalog JSON | No authored app manifest duplication |
| Installed app actions | Deferred | No fake capability sandbox around Bun modules |
| Catalog activation | Complete restart | No hot reload or live generations |
| Uninstall | Catalog membership only | No implicit data deletion |

## Clean-Break Waves

Each wave follows build, stop importing, verify, delete. Do not retain old and
new public APIs as selectable modes.

### Wave A: establish raw canonical owners

- [x] Extract schema-opaque row and KV commands from
  `canonical-rows.ts` and `canonical-kv.ts` without changing persistence or sync
  behavior.
- [x] Create one raw owner entry keyed only by Workspace ID in
  `runtime.ts`.
- [x] Keep synchronization, settlement, capture, row documents, and disposal on
  that entry.
- [x] Prove two raw callers share mutations and one lifecycle.
- [x] Stop constructing canonical storage from table or KV definitions.
- [x] Delete the definition field from the raw entry.
  > **Note**: The core/Bun runtime now constructs one `CanonicalStore` from the
  > ID-owned SQLite owner. The definition-bound row and KV constructors remain
  > active only for the untouched browser and desktop transports;
  > Waves C and D stop those imports before Wave G deletes the constructors.

### Wave B: put typed views on the caller side

- [x] Rename `WorkspaceDefinition` to `WorkspaceLens` and
  `WorkspaceHandle` to `Workspace` in one clean-break change.
  > **Note**: Landed first, ahead of Wave A, because the pure rename compiles
  > independently across the repo (including `examples/sqlite-workspace-browser`,
  > which the consumer list above missed). `runtime-definition.ts` is now
  > `workspace-lens.ts`.
- [x] Build table and KV adapters that validate/project around a raw owner.
- [x] Keep `runtime.open(lens)` as the only typed opening call.
- [x] Add same-ID, different-lens tests covering reads, patches, KV, documents,
  synchronization identity, view memoization, and one runtime-owned lifetime.
- [x] Replace rejection tests with read-time nonconformance tests.
  > **Note**: These completed Wave B items cover the core/Bun runtime. Browser
  > and desktop retain their explicit lens-conflict assertions until their
  > transport-specific cutovers in Waves C and D.
- [ ] Migrate every application and script import.
- [ ] Delete old exported names and equality assertions without aliases.

### Wave C: make browser transport schema-opaque

- [ ] Replace `BrowserWorkspaceManifest` lens fields with Workspace ID and raw
  runtime configuration only.
- [ ] Move table, KV, and SQL-result validation into `browser-runtime.ts`.
- [ ] Make `browser-runtime-worker.ts` own only OPFS, raw commands,
  synchronization, and documents.
- [ ] Stop sending serialized table and KV lenses.
- [ ] Verify Worker restart, two views over one ID, sync settlement, document
  revocation, capture, add, and delete.
- [ ] Delete `serializeTableLenses`, Worker definition reconstruction, manifest
  equality, and the Worker lens-conflict error.

### Wave D: make desktop transport schema-opaque

- [ ] Replace `openDesktopWorkspaceOwner({ definitions })` with a raw owner plus
  the derived static Workspace ID allowlist.
- [ ] Move table, KV, and SQL-result validation into `desktop-runtime.ts` in the
  webview realm.
- [ ] Make desktop operations carry raw addresses and bounded JSON only.
- [ ] Stop importing application lenses from
  `apps/epicenter/src/workspace-owner.ts`.
- [ ] Verify same-origin windows share one SQLite owner and different lenses
  can coexist.
- [ ] Delete the definition catalog, desktop definition conflict assertion,
  and server-side typed handles.

### Wave E: replace lens-shaped SQL views

- [x] Install `records` on every workspace connection.
  > **Note**: Pulled into the core owner checkpoint because leaving per-lens
  > TEMP views on a shared connection made Wave A/B behavior depend on which
  > lens queried first. `CanonicalStore` now owns the schema-opaque relation
  > and raw SQL execution; typed views only validate returned rows.
- [ ] Route browser and desktop SQL calls as raw text, parameters, and rows.
- [ ] Validate result rows in the calling JavaScript realm.
- [x] Rewrite the current test-only callers against `records`.
  > **Note**: Core runtime, Skills, Whispering, and the browser example now use
  > `records`. The desktop `UPDATE skills` assertion remains intentionally: it
  > proves that non-SELECT statements are refused and does not depend on a
  > lens-shaped relation.
- [ ] Verify private table access, writes, DDL, attachment, and mutating pragmas
  remain refused.
- [ ] Delete per-table view generation, safe view-name machinery that no other
  feature uses, result-schema serialization, and every
  `__epicenter_projection_` name.
  > **Note**: Core per-table view generation and every projection name are
  > deleted. Browser result-schema serialization remains for Wave C, so this
  > combined item stays unchecked.

### Wave F: derive installed-app workspace inventory

- [ ] Add `defineEpicenter` as a build-only helper whose accepted output is
  serializable `workspaces: string[]`.
- [ ] Teach the catalog build to find optional `src/epicenter.ts`, evaluate it
  only during the confirmed source build, validate IDs, and emit plain JSON.
- [ ] Validate the complete candidate before atomic replacement.
- [ ] Make startup load the ID union before constructing the desktop raw owner.
- [ ] Add Home inventory and dormant-workspace diagnostics without provider
  semantics.
- [ ] Verify restart activation, duplicate declarations, malformed IDs,
  replacement, uninstall, reinstall, export, and explicit deletion.
- [ ] Keep installed executable actions out; delete any experimental `host.mjs`
  loader rather than retaining a hidden second mode.

### Wave G: stop, verify, delete the old family

- [ ] Run all focused and package-level proofs below with no old-path imports.
- [ ] Use exact symbol greps to prove the compatibility family is unreachable.
- [ ] Delete old implementation files or collapse them into the new cohesive
  owner/view files.
- [ ] Update package READMEs and `docs/CONTEXT.md` only where their current
  vocabulary still names definitions as runtime owners.
- [ ] Flip ADRs 0156 through 0158 to Accepted, add dated relationship metadata
  to amended ADRs where required, add the spec to `docs/spec-history.md`, and
  delete this spec in the same landing change.

## Deletion Ledger

Delete or remove these responsibilities after their replacements are proven:

```txt
packages/workspace/src/sqlite/runtime-definition.ts
  WorkspaceDefinition noun and nominal identity

packages/workspace/src/sqlite/runtime.ts
  definition-bearing RuntimeEntry
  one-definition-per-ID refusal
  typed canonical owner construction

packages/workspace/src/sqlite/browser-runtime-protocol.ts
  SerializedTableLens
  serialized KV lens data
  result-schema transport

packages/workspace/src/sqlite/browser-runtime-worker.ts
  definition reconstruction
  CanonicalRows/CanonicalKv typed projection
  manifest equality and lens refusal

packages/workspace/src/sqlite/browser-runtime.ts
  one-definition assertion

packages/workspace/src/sqlite/desktop-owner.ts
  definitions catalog
  server-side WorkspaceHandle values

packages/workspace/src/sqlite/desktop-runtime.ts
  one-definition assertion

packages/workspace/src/sqlite/canonical-rows.ts
  per-lens named TEMP views
  typed projection mixed with raw persistence

apps/epicenter/src/workspace-owner.ts
  statically imported application definition catalog

tests
  already-bound-to-another-definition expectations
  FROM <lens-table-name> SQL expectations
```

The file itself need not be deleted when a remaining cohesive responsibility
earns the filename. The listed responsibility must be absent.

## Verification

Focused proofs during implementation:

```sh
bun test packages/workspace/src/sqlite/runtime.test.ts
bun test packages/workspace/src/sqlite/browser-runtime.test.ts
bun test packages/workspace/src/sqlite/canonical-rows.test.ts
bun test packages/workspace/src/sqlite/canonical-kv.test.ts
bun test apps/epicenter/src/desktop-workspace.test.ts
bun test apps/epicenter/src/static-assets.test.ts
bun run --filter '@epicenter/workspace' typecheck
bun run --filter '@epicenter/epicenter' typecheck
```

Repository gates:

```sh
bun scripts/check-doc-hygiene.ts
bun run check:licenses
```

Stale-family audit after the final cutover:

```sh
rg 'WorkspaceDefinition|WorkspaceHandle|serializeTableLenses' packages/workspace/src/sqlite apps
rg 'already bound to another definition|another release-local lens' packages apps
rg 'host\.mjs' apps/epicenter packages
rg 'CREATE TEMP VIEW' packages/workspace/src/sqlite
```

Expected results: the old public nouns, conflict assertions, serialized lenses,
runtime app-module loader, and per-lens SQL views have no production matches.
Historical ADRs and git history may retain the old vocabulary.

## Proof Tests That Must Exist

1. Open lens A and lens B with the same ID in one Bun runtime. A write through A
   is immediately visible through B, subject to B's read lens.
2. Repeat the proof through one browser Worker and through one desktop Bun
   owner.
3. A row valid under A and invalid under B does not prevent either open; B
   returns a nonconforming read containing the raw value.
4. Disposing A leaves B, synchronization, and an open row document alive.
5. Worker and desktop protocol snapshots contain no lens or result schema.
6. A SQL join over two `table_key` values works through `records`, and
   local result validation rejects a malformed result.
7. An installed app declaring an existing ID appears as another interpreter,
   not a provider conflict.
8. Uninstall plus restart removes the app and its declarations while preserving
   export and reinstall access to the raw workspace.

## Deferred Work

Installable actions are intentionally outside this replacement. A future ADR
must choose and name one honest model:

```txt
fully trusted Bun module
real sandboxed runtime with enforced capabilities
external MCP process with explicit launch trust
browser-side execution tied to a live surface
```

The future design must not call ambient Bun code request-scoped or inert merely
because its exported TypeScript function receives a small context object.
