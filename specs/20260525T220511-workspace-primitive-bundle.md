# Workspace Primitive Bundle

**Date**: 2026-05-25
**Status**: Draft
**Owner**: Braden
**Branch**: braden-w/pull-origin-main
**Builds on**: `braden-w/attach-encryption-named-slots` (30643db63)

## One Sentence

Introduce a `Workspace<TTables, TKv>` type bundling `{ ydoc, tables, kv, [Symbol.dispose] }` and a `createWorkspace` primitive that subsumes the three-line `new Y.Doc + attachEncryption + createActions` ritual; migrate **only the three materializers** (`attachBunSqliteMaterializer`, `attachTursoMaterializer`, `attachMarkdownMaterializer`) to take Workspace, because they're the only primitives that read `tables` or `kv`; persistence (`attachLocalStorage`, `attachIndexedDb`, `attachBroadcastChannel`, etc.), log (`attachYjsLog`), and sync (`openCollaboration`, `attachDaemonInfrastructure`) keep their Y.Doc-shaped signatures and callers pass `workspace.ydoc`.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  The Workspace contract
  Migration table

Read if making API decisions:
  Design Decisions
  Open Questions
  Edge Cases

Read if implementing:
  Implementation Plan (waves)
  Call sites: before and after
  Success Criteria
```

## Overview

After the `attach-encryption-named-slots` refactor (commit 30643db63), every workspace-backed app opens with the same three-line ritual, then re-threads `ydoc` and `tables` (and sometimes `kv` and `actions`) into four to six downstream attachments. This spec collapses the ritual into one `createWorkspace` call and converts every root-doc primitive to take a `workspace` parameter. Sub-doc primitives (rich text, plain text, timeline) keep their `(ydoc, ...)` shape because they operate on per-row child Y.Docs, not on the workspace root.

## Motivation

### Current State

Every browser and daemon mount opens with the same three lines, repeated across 15 call sites:

```ts
// apps/honeycrisp/browser.ts:48
const ydoc = new Y.Doc({ guid: HONEYCRISP_ID, gc: true });
const { tables, kv } = attachEncryption(ydoc, {
  keyring: signedIn.keyring,
  tables: honeycrispTables,
  kv: {},
});
const actions = createHoneycrispActions(tables);
```

Then `ydoc`, `tables`, and `actions` get threaded into downstream attachments:

```ts
// apps/honeycrisp/daemon.ts:55-75
attachBunSqliteMaterializer(ydoc, { filePath, log, tables });
attachMarkdownMaterializer(ydoc, {
  dir: markdownPath(projectDir, ydoc.guid),
  tables: { notes: tables.notes },
  perTable: { notes: { filename: slugFilename('title') } },
});
return attachDaemonInfrastructure(ydoc, {
  projectDir, ownerId, deviceId, openWebSocket, onReconnectSignal,
  actions,
});
```

### Problems

1. **Ritual duplication**: the three-line construct-ydoc / attach-encryption / build-actions sequence is identical at 15 sites across apps, examples, playgrounds, and tests. Forgetting one line (typically `attachEncryption`'s `kv: {}` slot) is a silent footgun.
2. **Re-threading**: `ydoc` and `tables` are passed as separate arguments to every downstream attachment, even though they're co-defined. The materializer needs `ydoc` for the destroy hook and `tables` for the row mirror; today it asks for both.
3. **Identity drift surface**: `ydoc.guid` and an explicit `workspaceId` are sometimes both in play. `attachEncryption` chose to read `ydoc.guid` to avoid drift; the rest of the surface doesn't have that discipline yet.
4. **Lifecycle ownership ambiguity**: each attachment hooks `ydoc.once('destroy', ...)` itself. The caller has no single value to dispose. `using` syntax doesn't help because nothing owns the bundle.

### Desired State

```ts
// apps/honeycrisp/browser.ts (target)
using workspace = createHoneycrispWorkspace({ keyring: signedIn.keyring });
const actions = createHoneycrispActions(workspace);

const idb = attachLocalStorage(workspace, { server, ownerId });
openCollaboration(workspace, { url, actions, openWebSocket, onReconnectSignal });
```

Three lines collapse to two. Every downstream attachment takes `workspace` instead of `(ydoc, { tables, kv })`. `using` makes lifecycle obvious.

## Research Findings

### Primitive surface (audited)

`packages/workspace/src/` exports ~20 `attach*` / `open*` primitives. Split into three categories by what they bind to:

| Category | Examples | Migration |
|---|---|---|
| **Root-doc attachments** | attachLocalStorage, attachBroadcastChannel, attachIndexedDb, attachEncryptedIndexedDb, attachYjsLog, attachYjsLogReader, attachBunSqliteMaterializer, attachTursoMaterializer, attachMarkdownMaterializer, attachDaemonInfrastructure, openCollaboration | `(ydoc, ...)` → `(workspace, ...)` |
| **Sub-doc attachments** | attachRichText, attachPlainText, attachTimeline | Stay `(ydoc, ...)`. Operate on per-row child Y.Docs. Do NOT take Workspace. |
| **Reader free functions** | openSqliteReader, openWorkspaceSqlite | Stay `(options)`. No Y.Doc, no workspace identity. |
| **Folded primitives** | attachEncryption, attachTable, attachTables, attachKv | Move inside `createWorkspace`; no longer exported as standalone primitives. Slot definitions go onto the `createWorkspace` options bag. |

### Call-site inventory (audited)

15 root-doc construction sites across the repo. 11 use encryption (apps with auth), 3 use plaintext (whispering, breddit, skills), 1 is a child-doc factory.

| App | Sites | Encrypted? | Wrapper would live at |
|---|---|---|---|
| honeycrisp | browser, daemon | ✓ | `apps/honeycrisp/workspace.ts` |
| fuji | browser, daemon | ✓ | `apps/fuji/src/lib/workspace.ts` |
| opensidian | browser, daemon | ✓ | `apps/opensidian/workspace.ts` |
| zhongwen | daemon | ✓ | `apps/zhongwen/workspace.ts` |
| tab-manager | extension | ✓ | `apps/tab-manager/src/lib/workspace/definition.ts` |
| whispering | index | ✗ (plaintext) | `apps/whispering/src/lib/workspace.ts` |
| breddit | reddit importer | ✗ (plaintext) | `apps/breddit/src/lib/workspace/ingest/reddit/workspace.ts` |
| skills | browser | ✗ (child doc) | `apps/skills/src/lib/skills/browser.ts` |
| examples/fuji | config | ✓ | n/a (uses fuji wrapper) |
| playgrounds | opensidian-e2e, tab-manager-e2e | ✓ | n/a (uses app wrappers) |

**Implication**: the primitive must support both encrypted and plaintext modes. Three production apps (whispering, breddit, skills) construct plaintext workspaces directly via `attachTables`/`attachKv` today.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Bundle ydoc + tables + kv | 2 coherence | Yes | Each is co-defined; the three materializers read at least two of them. |
| Bundle actions | 2 coherence | **No** | Only `openCollaboration` reads actions. Actions are platform-augmentable (browser ≠ daemon ≠ test). Keep external. |
| Encryption optional | 1 evidence | `keyring?` | Three apps construct plaintext workspaces today. Optional keyring degenerates `createWorkspace` to plaintext when absent. |
| Fold attachEncryption | 2 coherence | Yes | Five production sites do `new Y.Doc + attachEncryption + createActions` in lockstep. No site uses `attachEncryption` standalone. |
| Fold attachTable / attachTables / attachKv as exports | 2 coherence | Yes | After fold, the only legitimate caller is `createWorkspace` itself. Keep as internal helpers (`createTable`, `createKv`). |
| **Which primitives take Workspace** | 1 evidence | **Only the three materializers** | Test: does it read `tables` / `kv`? Only sqlite + markdown materializers do. Persistence / log / sync read only `ydoc`. Sub-doc and root-doc call sites then share identical Y.Doc-shaped signatures. |
| Sub-doc primitives take Workspace? | 1 evidence | **No** | `attachRichText` / `attachPlainText` / `attachTimeline` operate on child Y.Docs (one per note body). Same answer as the row above, by extension: nothing sub-doc takes Workspace. |
| Sub-doc shim around Y.Doc? | 2 coherence | **No** | Not needed. Persistence/sync primitives stay Y.Doc-shaped; sub-doc call sites pass their own Y.Doc; root call sites pass `workspace.ydoc`. The "same function on two semantically different things" tension dissolves once Workspace coupling narrows to materializers. |
| `attachLocalStorage` reads keyring from workspace? | 3 taste | **No** | Local-storage IDB encrypts under owner-scoped derivation, not workspace-scoped. Stays `{ server, ownerId, keyring }`. Caller reuses the same closure passed to `createWorkspace`. |
| `attachDaemonInfrastructure` reads ownerId from workspace? | 1 evidence | **No** | `ownerId` is auth context, not workspace. Stays an explicit parameter. |
| Materializer format pluggability | Deferred | Defer | Out of scope. Separate spec when the first Obsidian-vs-plain markdown debate lands. |
| `id` field on Workspace | 2 coherence | No, use `workspace.ydoc.guid` | Same anti-drift argument as `attachEncryption` reading `ydoc.guid`. |
| Markdown materializer `tables` selection | 2 coherence | **`perTable[name]` presence is the selection** | Mirrors the existing `fts: { posts: [...] }` presence-as-selection idiom. No separate `mirror` slot. To skip a table, omit its `perTable` entry. To mirror with defaults, write `perTable: { notes: {} }`. |
| Markdown materializer KV mirroring | 2 coherence | **Drop the feature** | KV is app-internal state (sort orders, last-opened folder) without a useful markdown shape. Defer; add only when a real call site asks. |
| SQLite materializer table selection | 2 coherence | **All of `workspace.tables`, no opt-out** | Today's behavior already mirrors what you pass. Tomorrow it mirrors what's there. Same outcome, smaller surface. |

## The Workspace contract

```ts
// packages/workspace/src/document/workspace.ts

export type Workspace<
  TTables extends TableDefinitions,
  TKv extends KvDefinitions,
> = {
  readonly ydoc: Y.Doc;
  readonly tables: Tables<TTables>;
  readonly kv: Kv<TKv>;
  [Symbol.dispose](): void;
};

export type CreateWorkspaceOptions<
  TTables extends TableDefinitions,
  TKv extends KvDefinitions,
> = {
  id: string;
  tables: TTables;
  kv: TKv;
  /** When present, all stores activate encryption derived from this owner keyring. */
  keyring?: () => Keyring;
};

export function createWorkspace<TTables, TKv>(
  options: CreateWorkspaceOptions<TTables, TKv>,
): Workspace<TTables, TKv>;
```

### Behavior

```txt
createWorkspace(opts)
  1. new Y.Doc({ guid: opts.id, gc: true })
  2. if opts.keyring:
       derive per-workspace keyring once via HKDF(opts.keyring(), opts.id)
       for each opts.tables entry:  createEncryptedYkvLww → activate
       for opts.kv:                  createEncryptedYkvLww → activate
     else:
       for each opts.tables entry:  createYkvLww
       for opts.kv:                  createYkvLww
  3. ydoc.once('destroy', dispose all stores)
  4. return { ydoc, tables, kv, [Symbol.dispose]: () => ydoc.destroy() }
```

### Why this shape

- **Three fields**: `ydoc`, `tables`, `kv`: each load-bearing for at least two downstream primitives. `actions` failed the test (one consumer) and stays external.
- **Optional `keyring`**: same factory handles encrypted and plaintext apps. Absence is the encryption switch, not a flag.
- **`id` is the constructor input, `ydoc.guid` is the canonical read**: by construction `ydoc.guid === id`; downstream code reads `workspace.ydoc.guid` only.
- **Disposal owns ydoc**: `using workspace` triggers `ydoc.destroy()`, which cascades through every store's `ydoc.once('destroy', ...)` hook. No separate disposer surface.

## Per-app wrapper pattern

Every app exposes a `createXWorkspace` adjacent to its schema:

```ts
// apps/honeycrisp/workspace.ts

export function createHoneycrispWorkspace(opts: { keyring: () => Keyring }) {
  return createWorkspace({
    id: HONEYCRISP_ID,
    keyring: opts.keyring,
    tables: honeycrispTables,
    kv: {},
  });
}
export type HoneycrispWorkspace = ReturnType<typeof createHoneycrispWorkspace>;
```

Plaintext apps drop `keyring`:

```ts
// apps/whispering/src/lib/workspace.ts

export function createWhisperingWorkspace() {
  return createWorkspace({
    id: WHISPERING_ID,
    tables: whisperingTables,
    kv: whisperingKv,
  });
}
```

Actions are constructed **outside** the workspace, **on the workspace**:

```ts
// apps/honeycrisp/workspace.ts (or wherever actions live today)

export function createHoneycrispActions(workspace: HoneycrispWorkspace) {
  return defineActions({
    folders_delete: defineMutation({ ... }),
  });
}
```

Platform-augmented actions wrap shared actions:

```ts
// apps/honeycrisp/browser.ts

const actions = {
  ...createHoneycrispActions(workspace),
  uploadFile: defineMutation({ ... }),    // browser-only
};
```

## Migration table: per primitive

The honest test: does this primitive read `tables`, `kv`, or anything workspace-specific beyond `ydoc.guid`?

### Take Workspace (materializers only)

These three read `workspace.tables` (and markdown reads kv if asked). They genuinely need the bundle.

| Primitive | File | Today | After |
|---|---|---|---|
| attachBunSqliteMaterializer | document/materializer/sqlite/bun-sqlite.ts:95 | `(ydoc, { filePath, tables, fts?, ... })` | `(workspace, { filePath, fts?, ... })`: drops `tables`; mirrors all of `workspace.tables` |
| attachTursoMaterializer | document/materializer/sqlite/turso.ts:110 | `(ydoc, { path, tables, fts?, ... })` | `(workspace, { path, fts?, ... })`: drops `tables`; mirrors all of `workspace.tables` |
| attachMarkdownMaterializer | document/materializer/markdown/materializer.ts:253 | `(ydoc, { dir, tables, kv?, perTable })` | `(workspace, { dir, perTable })`: drops `tables` and `kv`; `perTable[name]` presence is the selection |

### Keep Y.Doc-shaped (persistence, log, sync)

These bind to a Y.Doc and need no workspace fields. They work uniformly on the root doc (`workspace.ydoc`) and on sub-docs (note body Y.Docs). Same signature, same call shape, no shim, no overload.

| Primitive | File | Signature | Why no Workspace |
|---|---|---|---|
| attachBroadcastChannel | document/attach-broadcast-channel.ts:22 | `(ydoc, key?)` | uses `ydoc.guid` only |
| attachIndexedDb | document/attach-indexed-db.ts:23 | `(ydoc)` | uses `ydoc.guid` only |
| attachEncryptedIndexedDb | document/attach-encrypted-indexed-db.ts:84 | `(ydoc, { databaseName, keyring, log? })` | owner-scoped, not workspace-scoped |
| attachLocalStorage | document/attach-local-storage.ts:54 | `(ydoc, { server, ownerId, keyring })` | owner-scoped (per `(server, ownerId)`) |
| attachYjsLog | document/attach-yjs-log.ts:63 | `(ydoc, { filePath, log? })` | pure persistence of Y.Doc updates |
| attachYjsLogReader | document/attach-yjs-log-reader.ts:59 | `(ydoc, { filePath })` | pure replay |
| openCollaboration | document/open-collaboration.ts:158 | `(ydoc, { url, actions?, ... })` | doc-level sync; `actions` is optional and sub-docs pass `{}` |
| attachDaemonInfrastructure | daemon/attach-daemon-infrastructure.ts:65 | `(ydoc, { projectDir, ownerId, deviceId, ..., actions })` | composes Y.Doc-level primitives + auth context |

Callers pass `workspace.ydoc` to these. Sub-doc call sites are unchanged.

### Removed exports

`attachEncryption`, `attachTable`, `attachTables`, `attachReadonlyTable`, `attachReadonlyTables`, `attachKv` are no longer exported from `@epicenter/workspace`. Their construction helpers (`createTable`, `createKv`, `createEncryptedYkvLww`) remain as internal modules consumed by `createWorkspace`.

### Untouched (sub-doc and reader)

| Primitive | Reason |
|---|---|
| attachRichText | per-row child Y.Doc, not workspace root |
| attachPlainText | per-row child Y.Doc |
| attachTimeline | per-row child Y.Doc |
| openSqliteReader | reads mirror file directly, no Y.Doc |
| openWorkspaceSqlite | reads mirror file directly, no Y.Doc |

## Call sites: before and after

### honeycrisp/browser.ts

**Before** (`apps/honeycrisp/browser.ts:48-70`):

```ts
const ydoc = new Y.Doc({ guid: HONEYCRISP_ID, gc: true });
const { tables, kv } = attachEncryption(ydoc, {
  keyring: signedIn.keyring,
  tables: honeycrispTables,
  kv: {},
});
const actions = createHoneycrispActions(tables);

const idb = attachLocalStorage(ydoc, {
  server: signedIn.server,
  ownerId: signedIn.ownerId,
  keyring: signedIn.keyring,
});
const collaboration = openCollaboration(ydoc, {
  url: roomWsUrl({ ... }),
  openWebSocket: signedIn.openWebSocket,
  onReconnectSignal: signedIn.onReconnectSignal,
  waitFor: idb.whenLoaded,
  actions,
});
```

**After**:

```ts
using workspace = createHoneycrispWorkspace({ keyring: signedIn.keyring });
const actions = createHoneycrispActions(workspace);

const idb = attachLocalStorage(workspace.ydoc, {
  server: signedIn.server,
  ownerId: signedIn.ownerId,
  keyring: signedIn.keyring,
});
const collaboration = openCollaboration(workspace.ydoc, {
  url: roomWsUrl({ ... }),
  openWebSocket: signedIn.openWebSocket,
  onReconnectSignal: signedIn.onReconnectSignal,
  waitFor: idb.whenLoaded,
  actions,
});
```

**Semantic shifts to flag**:
- Persistence and sync primitives still take `Y.Doc`. Pass `workspace.ydoc`, not `workspace`. (Materializers are the exception: they take `workspace`.)
- `tables` and `kv` destructured from the old bundle disappear from local scope; downstream uses `workspace.tables.*` and `workspace.kv.*`.
- `using workspace` replaces the explicit `Symbol.dispose` block at the end of `openHoneycrispBrowser`. The `wipe()` method still lives on the *outer* return value (it needs `server` + `ownerId`).
- Sub-doc call sites (`attachRichText(childYdoc)`, `attachLocalStorage(childYdoc, ...)`) are unchanged.

### honeycrisp/daemon.ts

**Before** (`apps/honeycrisp/daemon.ts:48-75`):

```ts
const ydoc = new Y.Doc({ guid: HONEYCRISP_ID, gc: true });
ydoc.clientID = yDocClientId;
const encryption = attachEncryption(ydoc, { keyring });
const tables = encryption.attachTables(honeycrispTables);
encryption.attachKv({});
const actions = createHoneycrispActions(tables);

attachBunSqliteMaterializer(ydoc, { filePath, log, tables });
attachMarkdownMaterializer(ydoc, {
  dir, tables: { notes: tables.notes },
  perTable: { notes: { filename: slugFilename('title') } },
});
return attachDaemonInfrastructure(ydoc, { projectDir, ownerId, deviceId, ..., actions });
```

**After**:

```ts
using workspace = createHoneycrispWorkspace({ keyring });
workspace.ydoc.clientID = yDocClientId;
const actions = createHoneycrispActions(workspace);

attachBunSqliteMaterializer(workspace, { filePath, log });
attachMarkdownMaterializer(workspace, {
  dir,
  perTable: { notes: { filename: slugFilename('title') } },
});
return attachDaemonInfrastructure(workspace.ydoc, { projectDir, ownerId, deviceId, ..., actions });
```

**Semantic shifts to flag**:
- `attachBunSqliteMaterializer` no longer takes `tables`; it materializes all of `workspace.tables` unconditionally.
- `attachMarkdownMaterializer` no longer takes `tables` or `kv`. `perTable[name]` presence is the selection: `perTable: { notes: { filename: ... } }` means "mirror notes." No `perTable` entry for `folders` means folders is skipped. KV mirroring is dropped.
- `attachDaemonInfrastructure` takes `workspace.ydoc`, not `workspace` (it doesn't read tables or kv).

### whispering/index.ts (plaintext path)

**Before** (`apps/whispering/src/lib/whispering/index.ts:6`):

```ts
const ydoc = new Y.Doc({ guid: 'whispering' });
const tables = attachTables(ydoc, whisperingTables);
const kv = attachKv(ydoc, whisperingKv);
```

**After**:

```ts
const workspace = createWhisperingWorkspace();
// workspace.ydoc, workspace.tables, workspace.kv
```

**Semantic shift**: same three values, one source. Plaintext (no `keyring`) is the exact behavior; the encryption branch is skipped at construction.

## Implementation Plan

Waves run sequentially. Each wave ends at a typecheck + test + smoke checkpoint.

### Wave 1: Build the primitive

- [ ] **1.1** Create `packages/workspace/src/document/workspace.ts` exporting `Workspace<T, K>`, `CreateWorkspaceOptions`, `createWorkspace`.
- [ ] **1.2** Internalize `createTable` / `createKv` / `createEncryptedYkvLww` / `deriveWorkspaceKeyring` as the construction helpers `createWorkspace` consumes.
- [ ] **1.3** Export `createWorkspace` and the `Workspace` type from `@epicenter/workspace`'s public entry. Leave the old `attach*` exports in place during this wave.
- [ ] **1.4** Add a test in `packages/workspace/src/document/workspace.test.ts` covering: encrypted construction, plaintext construction, `using` disposal cascades to stores, `workspace.ydoc.guid === options.id`.

### Wave 2: Migrate the three materializers

Only the three materializers change signature; everything else stays Y.Doc-shaped (callers pass `workspace.ydoc`).

- [ ] **2.1** attachBunSqliteMaterializer: drop `tables` from options; iterate `workspace.tables` internally. No selection model.
- [ ] **2.2** attachTursoMaterializer: same as 2.1.
- [ ] **2.3** attachMarkdownMaterializer: drop `tables` and `kv`. `perTable[name]` presence becomes the selection (mirrors `fts: { ... }` idiom). Drop KV mirroring entirely.
- [ ] **2.4** Update each materializer's tests to construct via `createWorkspace`.

### Wave 3: Migrate call sites

Each app gets its `createXWorkspace` wrapper alongside its schema, then its browser / daemon / extension entry points switch to the new shape.

- [ ] **3.1** honeycrisp: `createHoneycrispWorkspace`, browser, daemon, tests
- [ ] **3.2** fuji: `createFujiWorkspace`, browser, daemon, tests, examples/fuji
- [ ] **3.3** opensidian: `createOpensidianWorkspace`, browser, daemon, playground, tests
- [ ] **3.4** zhongwen: `createZhongwenWorkspace`, daemon
- [ ] **3.5** tab-manager: `createTabManagerWorkspace`, extension, playground
- [ ] **3.6** whispering: `createWhisperingWorkspace`, index (plaintext path)
- [ ] **3.7** breddit: `createBredditWorkspace`, importer (plaintext path)
- [ ] **3.8** skills: `createSkillsWorkspace`, browser (plaintext, child-doc context)
- [ ] **3.9** Update `createXActions(tables)` factories to `createXActions(workspace)` across all apps.

### Wave 4: Prove

- [ ] **4.1** `bun run typecheck` across the monorepo
- [ ] **4.2** `bun test` across all packages and apps
- [ ] **4.3** Smoke test: honeycrisp browser, honeycrisp daemon, opensidian browser, opensidian daemon
- [ ] **4.4** Manually exercise `using` disposal in a test that asserts every store's destroy hook fires.

### Wave 5: Remove

After Wave 4 passes:

- [ ] **5.1** Remove `attachEncryption`, `attachTable`, `attachTables`, `attachReadonlyTable`, `attachReadonlyTables`, `attachKv` from the public entry point.
- [ ] **5.2** Remove the corresponding `AttachEncryptionOptions` / `EncryptionAttachment` / etc. exports.
- [ ] **5.3** Delete dead-code paths in materializers that branched on missing `tables` options.
- [ ] **5.4** Update `.agents/skills/workspace-api/` skill content and any spec references.

## Edge Cases

### Mid-mount Y.Doc identity tweaks

honeycrisp/daemon.ts sets `ydoc.clientID = yDocClientId` between encryption and the rest. Workspace's `ydoc` is mutable; this still works via `workspace.ydoc.clientID = ...`. Confirm no other apps touch `ydoc` between construction and downstream attachments in a way that breaks ordering.

### Sub-doc construction inside `openHoneycrispBrowser`

Resolved: persistence and sync primitives keep their Y.Doc-shaped signatures. `noteBodyDocs` continues calling `attachRichText(childYdoc)`, `attachLocalStorage(childYdoc, ...)`, `openCollaboration(childYdoc, ...)` unchanged. No shim, no overload.

### Plaintext apps and `defineKv` requirements

`createWorkspace`'s `kv` slot accepts `KvDefinitions`. Apps with no KV pass `{}`. Confirm `Kv<{}>` is a coherent type that doesn't trip any consumer.

### Tests that construct workspaces inline

Tests in `playground/opensidian-e2e/workspace.test.ts` and similar build Y.Docs directly. They should switch to `createWorkspace({ id: 'test', tables: ..., kv: {} })` for parity. Any test that intentionally exercises non-canonical Y.Doc options needs grandfathering.

### Daemon's `attachDaemonInfrastructure` already mutates `ydoc.clientID` indirectly

Verify no consumer ordering changes when `workspace.ydoc` is identity-stable but `workspace` is a fresh object reference per call.

## Open Questions

All five open questions resolved before execution. Recorded here for traceability:

1. **Materializer `tables` selection**: **resolved**: SQLite materializes all of `workspace.tables` unconditionally. Markdown uses `perTable[name]` presence as the selection (no separate `mirror` slot). Same idiom as `fts: { posts: [...] }`.

2. **Sub-doc primitives and Workspace shape**: **resolved by narrowing**: only the three materializers take `Workspace`. Persistence / sync / log primitives stay Y.Doc-shaped. Sub-doc call sites are unchanged; no shim or overload needed. Callers pass `workspace.ydoc` to Y.Doc-shaped primitives.

3. **`actions` factory signature**: **resolved**: switch to `(workspace)`. Tests construct via `createWorkspace` after Wave 3.

4. **Materializer KV mirroring**: **resolved**: drop the feature. KV is app-internal state without a useful markdown shape. Add only when a real call site asks.

5. **`createWorkspace`'s `ydocOptions` escape hatch**: **resolved**: do not expose one. Workspace roots always use `gc: true`; specialized docs that need different Y.Doc behavior should construct `new Y.Doc(...)` directly with a local explanation. Daemon's `workspace.ydoc.clientID = ...` tweak stays a post-construction mutation.

## Decisions Log

- **Drop**: `createWorkspace`'s `ydocOptions` escape hatch.
  Constraint: the workspace primitive owns root-doc construction, and runtime workspaces should all use `gc: true`. Keeping a generic Y.Doc option bag mostly invites accidental `gc` drift without a current call site. Specialized docs that need retained deleted structs or other nonstandard Y.Doc behavior should stay explicit at the direct `new Y.Doc(...)` call site.
  Revisit when: a production root workspace has a concrete need for a nondefault Y.Doc constructor option that cannot be expressed as a clear post-construction mutation.

- **Narrow**: only the three materializers take `Workspace`; persistence, log, and sync primitives stay Y.Doc-shaped.
  Constraint: a primitive should take Workspace only if it reads `tables` or `kv`. Materializers do; nothing else does. Forcing a Workspace parameter on a Y.Doc-shaped primitive duplicates information (`workspace.ydoc` is the same Y.Doc) and breaks sub-doc call sites that don't have a workspace.
  Revisit when: a non-materializer primitive starts genuinely needing `tables` or `kv` (e.g., a future "tables-aware" sync layer).

- **Keep**: `attachLocalStorage` accepts its own `keyring` parameter rather than reading from workspace.
  Constraint: local-storage IDB uses owner-scoped derivation (per `(server, ownerId)`), not workspace-scoped. Wiring through workspace would either misderive or force workspace to expose an owner keyring it doesn't own.
  Revisit when: encryption layer collapses owner and workspace scopes (unlikely; they exist for legitimate separation).

- **Keep**: `attachDaemonInfrastructure` takes `ownerId` and `deviceId` as explicit parameters.
  Constraint: both are auth/runtime concerns outside the workspace identity. Bundling them into workspace would couple workspace construction to authentication.
  Revisit when: workspace identity formally expands to include "the owner mounting this workspace right now," which is a different design.

- **Keep**: sub-doc primitives (`attachRichText`, `attachPlainText`, `attachTimeline`) take a raw `Y.Doc`.
  Constraint: they operate on child Y.Docs that exist outside the workspace's table/kv shape. Forcing them into `Workspace` is a category error.
  Revisit when: sub-doc body content becomes a first-class table column type instead of a side-channel Y.Doc.

- **Drop**: markdown materializer's `kv` mirror slot.
  Constraint: no production call site uses it; KV is app-internal state without a useful markdown shape.
  Revisit when: a real call site needs to expose KV as a readable file (e.g., a settings export for git diffs).

- **Drop**: explicit `mirror` slot on materializers.
  Constraint: presence of `perTable[name]` (markdown) or unconditional materialization (sqlite) covers every existing call site. A separate selection slot would be redundant logic.
  Revisit when: an app needs to materialize *some* tables to markdown with default behavior (no `perTable` config). Trivial to add `perTable: { x: {} }` until then.

## Success Criteria

- [ ] `createWorkspace` and `Workspace<T, K>` exported from `@epicenter/workspace`
- [ ] 15 call sites collapsed to per-app `createXWorkspace({ keyring? })` invocations
- [ ] `attachEncryption`, `attachTable`, `attachTables`, `attachKv` removed from public exports
- [ ] The three materializers (`attachBunSqliteMaterializer`, `attachTursoMaterializer`, `attachMarkdownMaterializer`) take `(workspace, options)` with no `tables` or `kv` option keys
- [ ] All other root-doc primitives unchanged: persistence, log, and sync remain `(ydoc, options)`. Callers pass `workspace.ydoc`.
- [ ] Sub-doc primitives unchanged
- [ ] Markdown materializer KV mirroring is removed (no `kv` option)
- [ ] `using workspace` syntax works at every call site; no manual `Symbol.dispose` blocks remain for workspace root
- [ ] `bun run typecheck` passes monorepo-wide
- [ ] `bun test` passes for every workspace-backed app
- [ ] Skill docs (`.agents/skills/workspace-api/`) and spec references updated

## References

- `packages/workspace/src/document/attach-encryption.ts`: the primitive `createWorkspace` subsumes
- `packages/workspace/src/document/attach-table.ts`: table construction; `createTable` becomes internal
- `packages/workspace/src/document/attach-kv.ts`: KV construction; `createKv` becomes internal
- `packages/workspace/src/document/derive-workspace-keyring.ts`: per-workspace HKDF derivation
- `apps/honeycrisp/browser.ts`, `apps/honeycrisp/daemon.ts`: canonical migration targets
- `apps/whispering/src/lib/whispering/index.ts`: canonical plaintext migration
- Commit `30643db63` (attach-encryption-named-slots): direct predecessor
- `specs/20260513T200000-workspace-surface-clean-break-vision.md`: earlier vision pass
- `specs/20260525T212249-sqlite-fts-primitive-split.md`: sibling primitive-shape spec
