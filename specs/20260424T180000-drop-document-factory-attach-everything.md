# Drop `createDocumentFactory`: domain attaches and inline composition

**Date**: 2026-04-24
**Status**: shipped (PR #1705, merged 2026-04-26 at `252dced47`). The v4 reasoning landed; the v5 amendment to Layer 4 below covers the iso/env/client reversal. The always-async-Result section was reversed by `specs/20260425T200000-actions-passthrough-adr.md`.
**Author**: AI-assisted, pairing with Braden

> **Path note (2026-05-22)**: The `epicenterPaths.persistence(...)` code example below predates the current path policy. The `epicenterPaths` symbol was removed; project-local persistence now lives under `<projectDir>/.epicenter/sqlite/` via `attachSqlite` and machine state under `env-paths('epicenter')`. See `specs/20260522T203209-top-level-epicenter-path-cleanup.md`.

> ⚠ **v5 amendment: read this before relying on the Overview, the Design decisions table, or any Layer text.**
>
> The "no `openFuji()` wrapper function: the module IS the workspace" axiom that runs through the [thesis](#one-sentence-thesis), the [Overview](#overview), the [Design decisions table](#design-decisions), and the original Layer 4 was **reversed within hours** when a Node consumer needed to construct the workspace's Y.Doc without dragging in `y-indexeddb`. Bundle bleed prevention required restoring the wrapper as a *seam* between iso construction and env binding.
>
> **Terminal shape**: every app is split into three files: `index.ts` (iso doc factory), `<binding>.ts` (env factory), `client.ts` (singleton + auth + lifecycle). The convention is specced at `specs/20260425T225350-app-workspace-folder-env-split.md` and codified at `.claude/skills/workspace-app-layout/SKILL.md`. The Layer 4 section below carries the corrected example; the Overview and Design decisions table are preserved as the v3 reasoning that produced the reversal: historical context, not a template.
>
> The v4 reasoning (delete `Document` / `DocumentBundle` / `DocumentHandle` / `createDocumentFactory` / `ActionIndex` / etc., keep `createDisposableCache` for the refcount-cache problem) **landed unchanged**. v5 is only about the wrapper-deletion axiom.
>
> The article `docs/articles/workspaces-were-documents-all-along.md` walks the v3 → v4 → v5 narrative end-to-end.

---

## One-sentence thesis

> The framework is `attach*` functions. Domains contribute schemas and action factories (and an `attach*` helper only if they need one). Lifecycle, persistence, sync, and actions are wired explicitly inline by the caller. There is no `Document` contract, no factory, no handle brand, and no `ActionIndex`.

## Naming convention for the workspace export

The `epicenter.config.ts` file exports the workspace under a **domain name** (lowercase noun: `fuji`, `honeycrisp`, `tabManager`), not a generic `workspace`. The export name becomes the dot-path root in CLI invocations:

```bash
$ epicenter run fuji.entries.create '{...}'        # ← reads naturally
$ epicenter run workspace.entries.create '{...}'   # ← awkward "workspace" prefix is noise
```

Action registry keys stay relative to the workspace (`'entries.create'`, not `'fuji.entries.create'`). The CLI composes `${exportName}.${actionPath}` at dispatch time. Multi-workspace configs use multiple named exports: same uniform rule. (See `cli-scripting-first-redesign` spec for the prior decision against `export default`.)

## Sync ordering: dispatch callback at construction, not back-patched

A two-step `attachSync(...) → sync.serveRpc(actions)` is a smell: sync is half-configured between the two calls, and forgetting the second call silently breaks incoming RPC. Pass the dispatch callback at construction:

```ts
const tables = attachTables(ydoc, fujiTables);
const actions = createFujiActions(tables);

const sync = attachSync(ydoc, {
  url: '...',
  waitFor: persistence.whenLoaded,
  dispatch: (method, input) => dispatchAction(actions, method, input),
});
```

The `dispatch:` callback (not `serve: Actions` data form) keeps sync ignorant of action shapes. Sync calls a function on each incoming RPC; the function happens to be `dispatchAction(actions, ...)`. Custom dispatch (auth gates, audit logs, rate limits) wraps the line cleanly.

Order reads naturally: ydoc → persistence → domain (tables/kv) → actions (close over domain) → sync (closure references actions for dispatch). No mutation later.

**Token sourcing** follows the same pattern: `getToken: () => Promise<string | null>` callback at construction, replacing the `void (async () => { sync.setToken(...); sync.reconnect(); })()` IIFE pattern (a latent race where sync may attempt connect before the IIFE resolves).

**Edge case**: actions that need to call `sync.rpc()` themselves (delegate to peer) are circular. Rare in practice: the vast majority of actions only touch local state. When it does happen, use a forward `let` reference. Don't optimize the common case for the rare one.

---

## Overview

The current architecture has accreted three intertwined abstractions:

```
DocumentBundle  ─ a structural contract for "what a build closure returns"
DocumentHandle  ─ a refcounted, branded view over a DocumentBundle
DocumentFactory ─ a cache that mints DocumentHandles from a build closure
ActionIndex     ─ a flat map built by walking a DocumentHandle for branded actions
```

Each was added to solve a real problem:

| Abstraction | Solving |
|---|---|
| `DocumentBundle` | "give consumers a typed contract for what `factory.open()` returns" |
| `DocumentHandle` | "share one Y.Doc across multiple opens with refcount + gcTime grace" |
| `DocumentFactory` | "construct lazily, dispose deterministically, cache by id" |
| `ActionIndex` | "let CLI dispatch by string path without addressing framework internals" |

After working through the design with first principles, the conclusion is:

- **`DocumentBundle`** is so structurally loose (`{ ydoc, dispose, [key: string]: unknown }`) that it provides almost no contract. Consumers duck-type `sync`, `awareness`, `whenReady` by name anyway. The contract papers over a missing schema.
- **`DocumentHandle`** is right for one consumer (Svelte component-mount churn against shared docs) and overkill for everyone else (CLI: one process, one open; scripts: one-shot; server: own pooling). Refcounting belongs in a Svelte adapter, not in the universal builder.
- **`DocumentFactory`** is the machinery for `DocumentHandle`'s refcount/gcTime. Falls with `DocumentHandle`.
- **`ActionIndex`** exists because actions can live anywhere on the bundle (no contract field for them). Once actions are *not* part of the bundle (separate registry concern), `ActionIndex` collapses to "a flat string-keyed object."

The new direction:

- Domain packages export the **smallest useful surface**: schema definitions (`fujiTables`, `Entry`, `EntryId`) and an action factory (`createFujiActions(tables)`). An `attach*` helper (e.g., `attachFuji(ydoc)`) is *optional*: only worth shipping when domain composition is non-trivial (multiple attachments wired together in a domain-specific way). For Fuji, no `attachFuji` is needed; composition is one line of `encryption.attachTables(ydoc, fujiTables)`.
- Callers compose **top-level inline at module scope** in `epicenter.config.ts` and in SPA bootstrap modules. **No `openFuji()` wrapper function**: the module IS the workspace; singleton naturally enforced by module loading. They construct the `Y.Doc`, call `attachIndexedDb` or `attachSqlite`, call `attachSync`, call domain-specific helpers (or attach domain primitives directly), and assemble a domain-named export object (`fuji`, `honeycrisp`, etc.).
- **Actions** are a nested-tree registry of typed callables (per Fuji's existing `createFujiActions(tables)` shape), defined inline alongside the bundle assembly. The registry IS the dispatch namespace; no walking, no brand-discovery. Every action returns `Promise<Result<T, E>>` (handlers may return raw values; framework normalizes via `isResult`).
- **Methods vs actions**: default to **methods** for in-process-only operations (UI ephemeral state, view-model helpers). Add **actions** when boundary access is required: CLI dispatch by string, AI tool-bridge introspection, or RPC over sync. For Fuji, every existing operation is CLI-useful, so they all stay actions.
- **`whenReady`** is composed by the caller from the relevant `when*` signals on each attachment. Always defined (`Promise.resolve()` if nothing async).
- **Refcount/gcTime** moves to a Svelte-side wrapper if the SPA needs it. The default model is "module-scope singleton, lives for the app's lifetime." Most SPAs need nothing more.
- **Per-device action discovery** (cross-device side effects, e.g., run Claude Code from mobile on desktop) is specified separately in `20260425T000000-device-actions-via-awareness.md`. It's an additive layer over the post-factory architecture: awareness publishes a serialized action manifest; an `invoke` helper dispatches via `sync.rpc` to a target peer.

---

## Motivation

### What this conversation surfaced

We worked through `entry.handle` in the CLI loader:

```
bundle  = { ydoc, tables, kv, sync, persistence, markdown, whenReady, ..., [Symbol.dispose] }
            ↑ user-owned, typed, full
DocumentHandle = bundle + { dispose, [Symbol.dispose], [DOCUMENT_HANDLE] }
            ↑ refcount + brand
entry          = { name, handle, actions: ActionIndex }
            ↑ loader-derived metadata
```

Three structural problems became visible:

1. **The handle is bundle-shaped.** It exposes 12 properties; the CLI uses 4. The other 8 (`tables`, `kv`, `encryption`, `persistence`, `markdown`, …) the CLI never reads. Those 4: `whenReady`, `sync`, `awareness`, `dispose`: are duck-typed by name with no formal contract. The handle is doing two incompatible jobs: typed access for bundle authors AND opaque-envelope-with-conventions for the CLI.

2. **`ActionIndex` is a workaround for a missing contract.** Actions can live anywhere on the bundle. The CLI walks the entire handle (`ydoc`, `tables`, `kv`, `encryption`, ..) looking for branded callables, then caches the result so it doesn't redo it on every command. This walking + caching only exists because the contract doesn't say where actions go. The action-index docstring admits this: "walking it directly mixes framework internals into the path namespace."

3. **State and behavior cohabitate one property bag.** `ydoc`, `tables`, `sync`, `persistence` (state) live as flat siblings with `posts.create`, `delete`, etc. (behavior). No type-level distinction. `ActionIndex` is the runtime mechanism that recovers the distinction. This is the real category mistake.

### Why the prior fix paths don't go far enough

We considered:

- **Make `actions` a contract field on `Document`**: formalizes the namespace, kills `ActionIndex`. But still keeps `Document`/`DocumentHandle`/`createDocumentFactory`. Doesn't fix the broader category mistake (handle as bundle vs. handle as adapter envelope).
- **Two-tier API (`bootstrapFuji` convenience + primitives)**: Drizzle-style. Felt like extra indirection for what should be a five-line inline composition. Rejected as smelly.
- **Slot-keyed `openFuji({ persistence, sync })`**: clean for the common case but bakes "slots" into Fuji's signature. Adding a sixth attachment changes the function. Slots are an arbitrary ontology.

The further conclusion: **stop trying to provide a one-call builder.** The right primitive is the same one the framework already has: `attach*`. Domain bundles are themselves `attach*` functions. The framework is just composition primitives.

---

## Research findings

### What every attach already does

From the prior spec's audit, every attach function in the codebase already constructs synchronously and exposes its own descriptive `when*` field:

| Attach | Construction | Async signal |
|---|---|---|
| `attachTable` / `attachKv` | sync | none (pure typed view) |
| `attachAwareness` | sync | none |
| `attachIndexedDb` / `attachSqlite` | sync | `whenLoaded` |
| `attachSync` | sync | `whenConnected` |
| `attachSessionUnlock` | sync | `whenChecked` |
| `attachEncryption` | sync | (none, `applyKeys()` is sync) |
| `attachMarkdownMaterializer` / `attachSqliteMaterializer` | sync | `whenFlushed` |
| `attachRichText` / `attachPlainText` / `attachTimeline` | sync | none |

**Implication**: composition is already structural. Each attach takes a ydoc (and options), returns enrichments. The author chains them by passing `waitFor: previous.whenLoaded` where ordering matters. No factory. No coordinator. No special framework.

### Two distinct categories of attach

Not all attaches have the same shape. Be honest:

- **Pure derivations**: `(ydoc) => T`. No async, no cleanup. Tables, kv, awareness selectors, plain text. These are typed views over ydoc state.
- **Resource attachments**: `(ydoc, opts) => T & { whenSomething: Promise; [Symbol.dispose]?(): void }`. They own external resources (db connection, websocket, worker). Their `when*` field is named for what *they* do, not a generic `whenReady`.

The framework should not flatten these into a single optional-everything contract. It should ratify the *style*: descriptive `when*` names, `[Symbol.dispose]` only where the attach owns a resource. Each attach declares its own shape.

### Methods vs. actions: when each is appropriate

Default to **methods** (plain typed functions on the bundle) for in-process-only operations. Use **actions** when boundary access is required.

```
WRITE A METHOD when…                       WRITE AN ACTION when…
──────────────────────                     ─────────────────────
- only the SPA / scripts call it           - CLI scripting wants to dispatch by string
- it manipulates UI / view state           - AI tool-bridge introspects it
- input is already TypeScript-typed        - RPC peers may invoke it
- you'd never expose it over the wire      - it benefits from explicit error typing
```

**Decision rule**: if you can name a boundary that calls it (`epicenter run X`, AI tool call, peer RPC), make it an action. Otherwise, make it a method.

For Fuji specifically: all five existing operations (`entries.create`, `update`, `delete`, `restore`, `bulkCreate`) are CLI-useful and AI-useful. They stay actions. Future operations that are pure UI state (`setSelectedEntry`, `togglePinnedView`, etc.) should be plain methods on the bundle (or live in Svelte stores, not the workspace at all).

This rule replaces the earlier framing that "actions are *the* unified surface for everything." Most workspaces have a small set of boundary-callable operations; the rest is local code. Don't reflexively make everything an action.

### Actions: one unified surface, brand-free, always async + always Result

There are two callers of "actions":

- **In-process callers** (Svelte components, scripts that import the bundle directly): TypeScript-checked.
- **Boundary callers** (CLI args parsed from strings, RPC payloads deserialized from bytes): input is `unknown`. Schema validation is mandatory. Lookup is by string path.

These share **one surface**, not two. An action is a typed callable that returns `Promise<Result<T, E>>`, with attached metadata:

```ts
type Mutation<I, T, E> = ((input: I) => Promise<Result<T, E>>) & {
  type: 'mutation';
  input?: TSchema;
  title?: string;
  description?: string;
};
```

The handler can return raw values *or* `Result`s. The framework normalizes:

```ts
defineMutation({
  input: Type.Object({ title: Type.String() }),
  handler: ({ title }) => {
    const id = generateId<EntryId>();
    tables.entries.set({ id, title, ... });
    return { id };           // ← raw return; framework wraps in Ok
  },
}),

defineQuery({
  input: Type.Object({ id: Type.String() }),
  handler: ({ id }) => {
    const entry = tables.entries.get(id);
    if (!entry) return Err(EntryErrors.NotFound({ id }));   // ← explicit Err
    return entry;            // ← raw; framework wraps in Ok
  },
}),
```

`defineMutation` / `defineQuery` internally:

```ts
function defineMutation({ handler, ...rest }) {
  return Object.assign(
    async (input) => {
      const result = await handler(input);
      return isResult(result) ? result : Ok(result);
    },
    { type: 'mutation', ...rest },
  );
}
```

`isResult(value)` (from wellcrafted) checks the brand: accidental Result-shaped data isn't misdetected.

**Why always async + always Result**:

- One mental model. Local and remote callers see the same shape: `Promise<Result<T, E>>`. Refactoring an action between local-only and RPC-exposed doesn't change the call site.
- Eliminates the `RemoteReturn` conditional type machinery (currently in `packages/workspace/src/shared/actions.ts:515-528`). Remote callers' error union widens by `RpcError | InvokeError`; the data type is unchanged. No more "transport widens errors" magic.
- Errors are first-class and typed. Callers pattern-match on `result.error`'s `name` discriminator (wellcrafted `defineErrors` pattern).
- Aligns with the codebase's existing wellcrafted conventions (per AGENTS.md error-handling skill).

**Cost**: pure-read actions become async (`await` ceremony, microtask queue tax). Trivial actions still don't need explicit `Ok(...)` because the framework wraps. Net ergonomics is comparable.

**The brand symbol is dropped.** `ACTION_BRAND` existed to detect actions when walking arbitrary mixed bundles (`iterateActions(handle)`). The new model has actions in their own dedicated registry: everything in the registry is an action by construction. `isAction(v)` becomes a structural check (`typeof v === 'function' && 'type' in v && (v.type === 'query' || v.type === 'mutation')`).

`defineQuery` / `defineMutation` are kept as ergonomic factories; the underlying type is one tagged sum, not two distinct things.

> **Known philosophical conflation**: an action today is doing two related but separable jobs: (A) "discoverable unit of business logic" (for `epicenter list`, AI tool-bridge, docs) and (B) "wire-callable endpoint with a schema" (CLI dispatch, RPC). For Fuji and the current rewrite these always coincide, so one surface works. If a future case wants "internal command, not exposed over RPC" or "RPC handler not appearing in `epicenter list`," the surfaces split. Don't pre-build for that; revisit if it bites.

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Domain package surface | Schemas + action factory; `attachX` helper is **optional** | Most domains only need `fujiTables` + `createFujiActions(tables)`. An `attachX(ydoc)` helper is worth shipping only when domain composition is non-trivial (multiple attachments wired together). Fuji needs none; honeycrisp/per-row-doc cases might. |
| Composition style | **Top-level inline** at module scope: no `openFuji()`/`openConfig()` wrapper function | The module IS the workspace. Singleton naturally enforced by module loading. Test instantiation isn't needed for SPA singletons or one-shot CLI configs. Saves an indirection layer; reads as one continuous narrative. |
| Bundle methods (`fuji.createPost`) | **Removed**: actions are the unified surface | The earlier draft had separate "plain methods on bundle" and "registry of actions." Reading Fuji's existing code, there are no plain methods: the action callables ARE the implementation, used directly by Svelte and dispatched to by CLI. One surface. |
| `ACTION_BRAND` symbol | **Dropped** | Existed to detect actions in arbitrary mixed bundles. With dedicated action registries, the registry's existence implies the contents. `isAction(v)` becomes a structural check. |
| `attachSync` action wiring | `dispatch: (method, input) => Promise<unknown>` (callback) | More decoupled than `serve: Actions`: sync calls a function, doesn't know action shapes. The `(m, i) => dispatchAction(actions, m, i)` boilerplate is one line and reads as documentation. Custom dispatch (auth gate, audit log, rate limit) wraps the line. |
| Sync token sourcing | `getToken: () => Promise<string \| null>` callback at construction | Replaces the `void (async () => { ... sync.setToken(...); sync.reconnect(); })()` IIFE pattern in playground configs, which is a latent race condition (sync may attempt connect before the IIFE resolves). Sync calls `getToken` when it needs a token. |
| `encryption.attachTables(ydoc, ...)` namespace form | **Kept** (vs. `attachTables(ydoc, ..., { encryption })`) | Both work. Encryption is conceptually attached *first* as a stateful container; the namespace form makes that ordering visible. Don't re-litigate. |
| Auth `onSessionChange` block organization | **Kept inline**: single block per workspace | A small state machine reads better as one block than scattered subscriptions per concern. The `getToken` move from above implicitly drops two `setToken` lines from this block. |
| `Document` contract | Removed | Loose contract papered over duck-typing. Consumers always knew their consumer-specific shape; encode that at the consumer boundary instead. |
| `DocumentHandle` brand | Removed | The brand existed to gate a refcount-aware loader. With refcount removed, there's nothing to brand. CLI loader looks for the export shape it needs (a `workspace` object), not a runtime mark. |
| `createDocumentFactory` / `defineDocument` | Removed | The cache + refcount + gcTime exists for a Svelte-component-churn problem. Move it to a Svelte adapter (`createReactiveDocCache(builder)` or similar). Most callers don't need it. |
| `ActionIndex` | Removed | A flat string-keyed registry IS the index. No walking, no caching, no brand-discovery. |
| `iterateActions` | Removed (or relegated to dev tooling) | The registry is already flat. Iteration is `Object.entries(actions)`. |
| `defineQuery` / `defineMutation` | Kept | Route-style markers for boundary callers. Stay narrow: schema + handler + metadata. Used in registries, not on the bundle. |
| Bundle methods (`fuji.createPost`) | Plain typed functions, no brand | TS already proves the shape at in-process call sites. No schema overhead. |
| `whenReady` on the bundle | Always defined; `Promise.resolve()` if nothing async | Removes `if (whenReady) await whenReady` ceremony. One mental model. |
| `[Symbol.dispose]` on the bundle | Always defined; typically `ydoc.destroy()` | Y.Doc's destroy cascades to attachments via `ydoc.on('destroy')`. The bundle author writes one line. |
| Sync construction | Yes: sync construction with async `whenReady` | Works at module scope (SPAs), works for scripts (await `whenReady` after construct). One model. |
| Refcount / gcTime | Outside the framework | Svelte adapter wraps a builder if the SPA actually needs it. Default = module-scope singleton. |
| Action shape on the wire | Flat string-keyed `Record<string, Action>` | Dispatch is `actions[path](input)`. Iteration is `Object.entries`. RPC manifest is the same object. |
| Where actions are defined | Inline in `epicenter.config.ts` per deployment | Each deployment chooses what it exposes. Default registry can be extracted later if duplication proves it warranted. |
| Two-tier convenience (`bootstrapFuji` + primitives) | **Rejected** | Indirection for a five-line inline composition. The convenience function would itself become a guess about what consumers want. Not worth the abstraction tax. |
| Slot-keyed builder (`openFuji({ persistence, sync })`) | **Rejected** | Bakes "slots" into the package signature; adding new attachments changes the function. Slots are an arbitrary ontology. |
| Sync ordering: `attachSync` then `sync.serveRpc(actions)` | **Rejected** | Two-step initialization is a smell: sync is half-configured between calls; forgetting the second silently breaks RPC. Pass dispatch callback at construction via `dispatch:` option. |
| `serve: Actions` (data form) on `attachSync` | **Rejected** in favor of `dispatch:` callback | `serve: Actions` couples sync to action shapes; `dispatch: (m,i) => Promise<unknown>` is a transport-only concern. Custom dispatch logic (auth, logging, rate limit) wraps the callback line cleanly. |
| Workspace export name | Domain noun (`fuji`, `honeycrisp`, `tabManager`) | Becomes the dot-path root in CLI invocations; reads naturally. `workspace` as a name is generic and clutters every `epicenter run` invocation. |
| Action registry key prefixing | Relative (`'entries.create'`) | The CLI composes `${exportName}.${actionPath}`. Including the prefix in registry keys would duplicate the export name. |
| Domain-package `attachX` helper | Optional, not required | Most domains only need to export schemas + an action factory. An `attachX(ydoc)` helper is worth shipping only when domain composition is non-trivial (multiple attachments wired together in a domain-specific way). |

---

## The new model

### Layer 1: `attach*` is the only primitive

Every reusable piece is an attach function. Same shape:

```ts
// (ydoc, opts) → enrichments + (optional) lifecycle
type ResourceAttach<T, Opts> =
  (ydoc: Y.Doc, opts: Opts) => T & {
    [`when${string}`]: Promise<unknown>;   // descriptive name, e.g. whenLoaded
    [Symbol.dispose]?: () => void;
  };

type PureAttach<T> = (ydoc: Y.Doc) => T;
```

The framework defines no universal `Attach` interface. It defines a *style*: descriptive `when*` for async signals, `[Symbol.dispose]` for resource-owning attaches. Pure attaches return whatever shape they need.

### Layer 2: Domain packages export the smallest useful surface

Most domains only need to export **schemas and an action factory**. No `attachX(ydoc)` helper is required when the composition is one line of `attachTables(ydoc, schemas)`.

```ts
// @epicenter/fuji: minimal package exports
export { fujiTables } from './schemas';
export { createFujiActions } from './actions';   // (tables) → action tree
export type { Entry, EntryId } from './types';
```

Caller composition is direct:

```ts
const tables = attachTables(ydoc, fujiTables);
const actions = createFujiActions(tables);
```

**An `attachX(ydoc)` helper is only worth shipping when the domain has a non-trivial composition**: e.g., it wires multiple attachments together in a domain-specific way (tables + kv + per-row sub-doc factories + materializers). If the domain is just tables, an attach wrapper adds indirection without value.

Examples of when to ship an `attachX`:

- Fuji-with-content-docs: tables + a per-entry content-doc factory + a per-row update hook to bump `updatedAt`. Worth wrapping into a single `attachFujiCore(ydoc, deps)` to keep the wiring co-located.
- Honeycrisp / tab-manager: same pattern as Fuji unless they grow non-trivial composition.

When in doubt, **don't ship the wrapper.** Inline composition is the floor; helpers extract upward only when duplication proves they earn the indirection.

### Layer 3: `epicenter.config.ts` (CLI / RPC surface)

Top-level inline composition at module scope. **No `openConfig()` wrapper.** The module IS the workspace.

```ts
// epicenter.config.ts
import {
  attachAwareness, attachEncryption, attachSync, dispatchAction,
} from '@epicenter/workspace';
import { attachSessionUnlock, createSessionStore, epicenterPaths } from '@epicenter/cli';
import { attachSqlite } from '@epicenter/persistence-sqlite';
import { createFujiActions, fujiTables } from '@epicenter/fuji';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const sessions = createSessionStore();

const ydoc = new Y.Doc({ guid: 'epicenter.fuji' });

const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, fujiTables);
const kv = encryption.attachKv(ydoc, {});
const awareness = attachAwareness(ydoc, {});

const persistence = attachSqlite(ydoc, {
  filePath: epicenterPaths.persistence(ydoc.guid),
});

const unlock = attachSessionUnlock(encryption, {
  sessions,
  serverUrl: SERVER_URL,
  waitFor: persistence.whenLoaded,
});

const actions = createFujiActions(tables);

const sync = attachSync(ydoc, {
  url: (id) => `${SERVER_URL}/workspaces/${id}`,
  waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
  awareness: awareness.raw,
  getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
  dispatch: (method, input) => dispatchAction(actions, method, input),
});

export const fuji = {                  // ← domain-named export
  ydoc, tables, kv, awareness, encryption, persistence, unlock, sync, actions,
  whenReady: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
  [Symbol.dispose]() { ydoc.destroy(); },
};
```

Each line does one thing. Maximum honesty. The reader learns how the framework composes by reading the file. **No async IIFE for token bootstrap**: `getToken` is called by sync when it needs a token (initial connect, reconnect, refresh). No race condition.

### Layer 4: SPA bootstrap (v5 amendment)

> **Amendment (2026-04-25):** the original draft of this section showed a single `client.svelte.ts` file with everything at module scope, no `openFuji()` wrapper, the module IS the workspace. That shape executed first then got reversed within hours when a Node consumer needed to construct the workspace's Y.Doc without dragging in `y-indexeddb` / `BroadcastChannel`. The terminal shape splits the SPA into **three files** per the iso/env/client convention specced at `specs/20260425T225350-app-workspace-folder-env-split.md` and codified at `.claude/skills/workspace-app-layout/SKILL.md`. The example below shows the terminal shape; the original module-scope draft is preserved at the bottom of this section as historical context.

The SPA splits its workspace into three files: an isomorphic doc factory, a pure environment factory, and a running client that wires auth + the singleton + lifecycle. Each layer composes around the one below it; siblings never import each other; the import path tells you what bindings you've crossed.

```ts
// apps/fuji/src/lib/fuji/index.ts: iso doc factory
import { attachAwareness, attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from '$lib/workspace';

export function openFuji() {
  const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, fujiTables);
  const kv = encryption.attachKv(ydoc, {});
  const awareness = attachAwareness(ydoc, {});
  const actions = createFujiActions(tables);
  return {
    ydoc, tables, kv, encryption, awareness, actions,
    batch: (fn: () => void) => ydoc.transact(fn),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

```ts
// apps/fuji/src/lib/fuji/browser.ts: env factory (browser bindings + per-row cache)
import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
  attachBroadcastChannel, attachIndexedDb, attachSync,
  createDisposableCache, dispatchAction, websocketUrl,
} from '@epicenter/workspace';
import { createEntryContentDoc } from '$lib/entry-content-docs';
import type { EntryId } from '$lib/workspace';
import { openFuji as openFujiDoc } from './index';

export function openFuji({ auth }: { auth: AuthClient }) {
  const doc = openFujiDoc();
  const idb = attachIndexedDb(doc.ydoc);
  attachBroadcastChannel(doc.ydoc);
  const entryContentDocs = createDisposableCache(
    (entryId: EntryId) => createEntryContentDoc({
      entryId, workspaceId: doc.ydoc.guid,
      entriesTable: doc.tables.entries, auth, apiUrl: APP_URLS.API,
    }),
    { gcTime: 5_000 },
  );
  const sync = attachSync(doc.ydoc, {
    url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
    waitFor: idb.whenLoaded,
    awareness: doc.awareness.raw,
    getToken: () => auth.getToken(),
    dispatch: (action, input) => dispatchAction(doc.actions, action, input),
  });
  return { ...doc, idb, entryContentDocs, sync, whenReady: idb.whenLoaded };
}
```

```ts
// apps/fuji/src/lib/fuji/client.ts: running singleton + auth + lifecycle
import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { openFuji } from './browser';

const session = createPersistedState({
  key: 'fuji.auth.session',
  schema: AuthSession.or('null'),
  defaultValue: null,
});

export const auth = createAuth({ baseURL: APP_URLS.API, session });
export const fuji = openFuji({ auth });

auth.onSessionChange((next, previous) => {
  if (next === null) {
    fuji.sync.goOffline();
    if (previous !== null) void fuji.idb.clearLocal();
    return;
  }
  fuji.encryption.applyKeys(next.encryptionKeys);
  if (previous?.token !== next.token) fuji.sync.reconnect();
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => { auth[Symbol.dispose](); });
}
```

SPA components import the singleton from `$lib/fuji/client` and consume `fuji.tables.entries.observe(...)`, `fuji.actions.entries.create({...})` for local calls. Build configs and Node tooling import `openFuji` from `$lib/fuji` directly. They get the iso doc without dragging in the browser bindings.

Cross-device invocation (per the awareness publishing layer in `specs/20260425T000000-device-actions-via-awareness.md`) lives in `client.ts` alongside auth + singleton, that's the file that sees the wired `sync` and `awareness`, so it's the natural place to wire `invoke` if/when it ships.

> **Why three files won.** The original draft argued that `openFuji()` was unused encapsulation when called once. That was true at v3: every consumer was the same module. It stopped being true the moment a second consumer appeared (Node config, codegen, test fixture) that couldn't tolerate the browser bindings. The wrapper isn't encapsulation; it's a *seam* between iso construction and env binding. The honest test isn't "is this called more than once?": it's "would removing this make a forbidden import possible?" The article `docs/articles/workspaces-were-documents-all-along.md` v5 walks through the reversal in narrative form.

<details>
<summary><b>Original v3-era draft (preserved as historical context)</b></summary>

The draft from before the v5 amendment showed a single-file module-scope composition with no `open<App>()` wrapper:

```ts
// apps/fuji/src/lib/client.svelte.ts (post-refactor: v3-era, NOT terminal shape)
import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
  attachAwareness, attachBroadcastChannel, attachEncryption,
  attachIndexedDb, attachSync, dispatchAction,
  serializeActionManifest, invoke, websocketUrl,
} from '@epicenter/workspace';
import { createFujiActions, fujiTables } from '$lib/workspace';
import { createEntryContentDocs } from '$lib/entry-content-docs';
import * as Y from 'yjs';

const session = createPersistedState({ key: 'fuji.auth.session', schema: AuthSession.or('null'), defaultValue: null });
export const auth = createAuth({ baseURL: APP_URLS.API, session });

// ── Identity (persisted locally) ───────────────────────────────────
const deviceId = localStorage.getItem('device-id') ?? crypto.randomUUID();
localStorage.setItem('device-id', deviceId);

// ── Pure structural attaches (sync construction, no async) ─────────
const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, fujiTables);
const kv = encryption.attachKv(ydoc, {});
const awareness = attachAwareness(ydoc, {});

// ── Storage (async: kicks off background load) ────────────────────
const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ── Behavior (closes over typed state) ─────────────────────────────
const actions = createFujiActions(tables);

// ── Network ────────────────────────────────────────────────────────
const sync = attachSync(ydoc, {
  url: websocketUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
  waitFor: idb.whenLoaded,
  awareness: awareness.raw,
  getToken: () => auth.getToken(),
  dispatch: (method, input) => dispatchAction(actions, method, input),
});

// ── Auth → workspace transitions ───────────────────────────────────
auth.onSessionChange((next, previous) => {
  if (next === null) {
    sync.goOffline();
    if (previous !== null) void idb.clearLocal();
    return;
  }
  encryption.applyKeys(next.encryptionKeys);
  if (previous?.token !== next.token) sync.reconnect();
});

// ── Export ─────────────────────────────────────────────────────────
export const fuji = {
  ydoc, tables, kv, awareness, encryption, idb, sync, actions,
  whenReady: idb.whenLoaded,
  [Symbol.dispose]() { ydoc.destroy(); },
};
```

This shape is what got reversed. It's preserved here because the rest of this spec was written under its axioms; readers tracking the reasoning chain need the artifact. **Do not use it as a template.**

</details>

> **Note**: `serializeActionManifest`, `invoke`, and the awareness state convention are specified in `specs/20260425T000000-device-actions-via-awareness.md`. The teardown described here doesn't *require* them, but the SPA bootstrap example above shows the integrated form because it's the target shape.

### Layer 5: Scripts

```ts
// scripts/export-entries.ts
import { fuji } from '../epicenter.config';
import { writeFile } from 'node:fs/promises';

await fuji.whenReady;
const entries = fuji.tables.entries.getAllValid();
await writeFile('./entries.json', JSON.stringify(entries, null, 2));
fuji[Symbol.dispose]();
```

`bun run scripts/export-entries.ts` is the runtime. No CLI involved.

---

## Architecture

### What flows through the call graph

```
┌──────────────────────────────────────────────────────────────────┐
│  Y.Doc                                                           │
│   ├── attachIndexedDb (or attachSqlite, ...)  ← persistence     │
│   ├── attachSync                              ← network         │
│   ├── attachAwareness                         ← presence        │
│   ├── attachFuji                              ← domain          │
│   │    ├── attachTable(ydoc, fujiTables)                        │
│   │    ├── attachKv(ydoc, fujiKv)                               │
│   │    └── plain typed methods                                  │
│   └── attachX...                              ← any extension   │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                      caller assembles { ydoc, ...attachments, actions?, whenReady, [Symbol.dispose] }
                                │
                ┌───────────────┼────────────────┐
                ▼               ▼                ▼
        ┌──────────────┐ ┌────────────┐  ┌────────────────────┐
        │ SPA          │ │ Scripts    │  │ epicenter.config.ts│
        │ subscribe to │ │ await      │  │ + actions registry │
        │ tables/kv    │ │ whenReady, │  │ + sync.serveRpc    │
        │ call methods │ │ call       │  │ → CLI dispatches   │
        │ directly     │ │ methods    │  │   actions[path]    │
        └──────────────┘ └────────────┘  └────────────────────┘
```

### What the CLI loader does

It looks for an exported `workspace` object (or whatever convention is chosen: see Open Questions) with at least:

```ts
type LoadedWorkspace = {
  whenReady: Promise<unknown>;
  actions?: Record<string, Action>;
  sync?: { serveRpc, rpc };          // only if --peer dispatch is supported
  awareness?: AwarenessLike;          // only if `epicenter peers` is supported
  [Symbol.dispose](): void;
};
```

No brand check. No walking. No `ActionIndex`. No `entry.handle.X` indirection. The export is the manifest; the loader reads what it needs and dispatches.

### What disappears

| Today | After |
|---|---|
| `createDocumentFactory` / `defineDocument` | Removed |
| `Document` / `DocumentBundle` type | Removed |
| `DocumentHandle<T>` type and `DOCUMENT_HANDLE` brand | Removed |
| `isDocumentHandle` runtime check | Removed (CLI loader checks export shape, not brand) |
| `iterateActions` | Removed (or moved to dev tooling) |
| `ActionIndex` and `buildActionIndex` | Removed |
| `ACTION_BRAND` symbol | Removed; `isAction` becomes a structural check |
| `openFuji()` / `openConfig()` wrapper functions | Removed; module-level inline composition |
| `void (async () => { sync.setToken(...); sync.reconnect(); })()` IIFE | Removed; `getToken` callback at construction |
| `serve: Actions` on `attachSync` (data form) | Replaced by `dispatch: (m, i) => Promise<unknown>` callback |
| `sync.serveRpc(actions)` post-construct | Removed; wired at construction via `dispatch` |
| `entry.handle` envelope in CLI loader | Removed; loader returns the workspace export directly |
| `getSync` / `extractAwareness` duck-type helpers | Inlined; the workspace export provides typed `sync` / `awareness` directly |
| `gcTime` and refcount machinery | Out of the framework; Svelte adapter if needed |
| `if (whenReady) await whenReady` ceremony | Always-defined `whenReady`; just `await workspace.whenReady` |

---

## Migration plan

This is a clean break. All consumers (`apps/whispering`, vault, tab-manager, playgrounds, fuji-spa) are in this repo or on the same migration cadence.

### Phase 1: Surgical changes to `apps/fuji` (smaller than expected)

`apps/fuji/src/lib/client.svelte.ts` already does inline composition inside `openFuji()`. The remaining changes are surgical.

- [ ] **1.1** Revise `attachSync` API in one PR:
   - Add `dispatch?: (method: string, input: unknown) => Promise<unknown>` option for incoming RPC. Internally, sync calls this on each incoming RPC; result becomes the response. Replaces any `sync.serveRpc(actions)` post-construct path.
   - Add `getToken?: () => Promise<string | null>` option for token sourcing. Sync calls this when it needs a token (initial connect, reconnect, refresh). Replaces the `void (async () => { sync.setToken(...); sync.reconnect(); })()` IIFE pattern.
   - Migrate playground configs (`playground/tab-manager-e2e/epicenter.config.ts`, `playground/opensidian-e2e/epicenter.config.ts`) in the same PR.
- [ ] **1.2** Drop `ACTION_BRAND`. Update `isAction(v)` / `isQuery(v)` / `isMutation(v)` to structural checks (`typeof v === 'function' && 'type' in v && (v.type === 'query' || v.type === 'mutation')`). Verify no other consumers depend on the brand symbol; if any cross-package detection turns out to be load-bearing, keep the brand and revisit.
- [ ] **1.3** Update `apps/fuji/src/lib/client.svelte.ts`:
   - Drop the `openFuji()` wrapper function: promote its body to top-level statements at module scope.
   - Drop `import { ..., type Document }` and the `satisfies Document` assertion.
   - Lift `const actions = createFujiActions(tables)` *before* the `attachSync` call.
   - Pass `dispatch: (m, i) => dispatchAction(actions, m, i)` and `getToken: () => auth.getToken()` in `attachSync` options.
   - Rename the export `workspace` → `fuji` (and update consumers in `apps/fuji/src/`).
   - Trim the `auth.onSessionChange` block: `setToken` calls disappear because sync sources the token via `getToken`.
- [ ] **1.4** Verify the SPA boots, hydrates, and writes work end-to-end. The HMR dispose path is unchanged.

**Note on Fuji's package shape**: `apps/fuji/src/lib/workspace.ts` already exports `fujiTables`, `createFujiActions`, `Entry`, `EntryId`. That's the domain package surface. **No `attachFuji(ydoc)` helper is needed for Fuji**: the composition is one line of `attachTables(ydoc, fujiTables)` (or `encryption.attachTables(ydoc, fujiTables)` for encrypted). Don't ship indirection that doesn't earn its keep.

### Phase 2: Same treatment for the other domain bundles

- [ ] **2.1** `apps/honeycrisp/src/lib/note-body-docs.ts` and `apps/fuji/src/lib/entry-content-docs.ts` use `createDocumentFactory` for **per-row Y.Docs** (each entry/note has its own content document). This is a real refcount-cache use case (Svelte components opening the same entry mount/unmount). Decide per-app: (a) keep an app-local cache helper, (b) ship a Svelte adapter `createReactiveDocCache(builder)`, or (c) just inline disposal in `$effect`. **Don't** fold per-row docs into the workspace export: they're factory-shaped for a reason.
- [ ] **2.2** Tab-manager's `apps/tab-manager/src/lib/workspace/definition.ts` and zhongwen: apply the inline-composition pattern. If a domain has non-trivial composition (multi-table + kv + materializer + per-row docs), ship an `attachX(ydoc, deps)` helper to keep the wiring co-located. Otherwise inline.
- [ ] **2.3** Playground configs (`playground/tab-manager-e2e/epicenter.config.ts`, `playground/opensidian-e2e/epicenter.config.ts`) move to inline composition. Use as smoke tests.

### Phase 3: Strip the workspace package

- [ ] **3.1** Delete `packages/workspace/src/document/document.ts` (the factory + handle + brand machinery). Move whatever helpers survive to a more honest home.
- [ ] **3.2** Delete `iterateActions`, `ActionIndex`, `buildActionIndex` from their current locations. Keep `defineQuery` / `defineMutation` / `dispatchAction`: they survive, scoped to boundary callers.
- [ ] **3.3** Update `packages/workspace/src/index.ts` exports. The package's public API shrinks dramatically; expect this to be the most visible diff.

### Phase 4: Rewrite the CLI loader

- [ ] **4.1** `packages/cli/src/load-config.ts`: remove `isDocumentHandle` / handle-based duck-typing. The loader now expects an exported `workspace` (or named convention TBD: see Open Questions) with `{ whenReady, actions?, sync?, awareness?, [Symbol.dispose] }`.
- [ ] **4.2** `LoadConfigResult` becomes `{ entries: { name: string; workspace: LoadedWorkspace }[]; dispose() }`. No more `entry.handle.X`; CLI commands read first-class fields off `entry.workspace`.
- [ ] **4.3** `packages/cli/src/util/handle-attachments.ts`: delete. `getSync` / `extractAwareness` are no longer needed; the workspace export provides typed `sync` / `awareness` directly.
- [ ] **4.4** `packages/cli/src/util/action-index.ts`: delete. `epicenter run` resolves `actions[path]` directly; `epicenter list` does `Object.entries(actions)`.
- [ ] **4.5** `packages/cli/src/commands/run.ts`, `peers.ts`, `list.ts`: rewrite against the new `LoadedWorkspace` shape.

### Phase 5: Refactor / delete docs

- [ ] **5.1** `packages/workspace/README.md`: lead with "everything is an attach." Show the inline composition pattern first. Document `attach*` as the canonical primitive. Document `defineQuery` / `defineMutation` as boundary primitives, not bundle primitives.
- [ ] **5.2** `.claude/skills/workspace-api/SKILL.md`: agent-facing version of the same. Drop references to `createDocumentFactory`, `defineDocument`, `Document`, `DocumentHandle`.
- [ ] **5.3** `docs/articles/workspaces-were-documents-all-along.md` (currently unstaged): rewrite to reflect this direction, or retire and replace with a new article on the attach-everything model.
- [ ] **5.4** Update any other docs that describe the now-removed factory / handle machinery.

### Phase 6: Optional Svelte refcount adapter

- [ ] **6.1** *Only if the SPA actually needs it.* Build `createReactiveDocCache(builder)` in a Svelte adapter package. It wraps a sync-construction builder with refcount + gcTime, mints scope-bound handles, and disposes when refcount → 0. Default for SPAs is module-scope singleton; reach for the cache only when component churn proves it necessary.

### Phase 7: Supersede prior specs

- [ ] **7.1** `specs/20260424T000000-self-gating-attachments.md`: mark Superseded. The one-line `whenReady?` change becomes "always-defined `whenReady` on the workspace export, composed inline by the caller."
- [ ] **7.2** `specs/20260421T155436-cli-scripting-first-redesign.md`: still valid in spirit (3-command CLI, scripting-first). Update the load-config and dispatch sections to match the new shape; the rest stands.

---

## Open questions

1. **Naming for the export from `epicenter.config.ts`.** **Resolved**: domain noun (`fuji`, `honeycrisp`). See the "Naming convention" section near the top of this spec for the rationale and the call-site comparison.

2. **Should `actions` be required or optional on the workspace export?**
   - SPA-only configs don't need them.
   - CLI configs do.
   - **Recommendation**: optional. If `actions` is undefined, `epicenter run` errors with a useful message; `epicenter list` shows an empty tree.

3. **Where do CRDTs that aren't tables/kv go?**
   - `attachRichText`, `attachPlainText`, `attachTimeline` are pure attaches today. They stay pure attaches. Domain bundles that use them call them inside their own `attach*` (e.g., `attachFujiEntry` calls `attachRichText` for the body field).
   - **No change needed.**

4. **Does this break TanStack Query / `createQuery` / `createMutation`?**
   - The query layer consumes services. With actions as flat registries, `createQuery` / `createMutation` adapt one entry from the registry into TanStack-shaped reactive state. Should be straightforward.
   - **Action**: re-verify against `packages/query/` (or wherever the query layer lives) during Phase 4.

5. **Refcount cache: keep as a Svelte adapter, or skip entirely?**
   - The case for refcount: same Y.Doc shared across many components, mount/unmount churn re-opens the same id repeatedly, want gcTime to coalesce.
   - The case against: SPAs typically have one Y.Doc per workspace, lived for the app's lifetime, opened once at module scope. Refcount is solving a problem they don't have.
   - **Recommendation**: don't build the adapter until a real SPA proves it needs one. Default singleton-at-module-scope first.

6. **What happens to the `whenDisposed` async barrier?**
   - The previous spec considered `whenDisposed` as part of the contract. With `[Symbol.dispose]` synchronous and attachment cleanup running via `ydoc.on('destroy')`, callers that need a teardown gate await a specific attachment's `whenDisposed` (e.g. `await persistence.whenDisposed`).
   - **Recommendation**: don't add `whenDisposed` to the workspace export. Callers who need a teardown barrier reach into the specific attachment that owns the resource. Rare in production, occasional in tests.

7. **Action schemas: TypeBox vs. arktype consistency.**
   - Existing actions use TypeBox via `defineQuery({ input: Type.Object({...}) })`.
   - Newer code uses arktype's `type({...})`.
   - **Recommendation**: pick one for boundary-action schemas and stick with it. Arktype reads better; TypeBox is what `defineMutation`'s current generic accepts. Coordinate during Phase 4.

8. **Default action registries shipped from domain packages.**
   - Should `@epicenter/fuji` ship `defineFujiActions(fuji)` as a default registry?
   - Or should every deployment write its own?
   - **Recommendation**: ship a default. Deployments that want to extend or restrict spread it: `{ ...defineFujiActions(fuji), 'admin.ban': defineMutation(...) }`. Cheap convenience without the structural cost of "actions are part of the bundle."

---

## Rejected alternative: typed `whenReady` on `DocumentBundle` (collapsed in from `self-gating-attachments.md`)

A predecessor spec (`20260424T000000-self-gating-attachments.md`, now deleted) proposed the **minimal** change: add one optional field, `readonly whenReady?: Promise<unknown>`, to the `DocumentBundle` contract. Nothing else. Bundle authors would compose `Promise.all([persistence.whenLoaded, unlock.whenChecked, sync.whenConnected])` in their factory closure; the CLI would `await handle.whenReady` without a TypeScript diagnostic. The thesis was that **the framework already had everything it needed for readiness composition**: every `attach*` already constructs synchronously and exposes its own `when<X>` promise; the only missing piece was a typed extension point on the bundle contract.

That spec also catalogued findings that remain useful even though the surface it modified is gone:

- **Pre-hydration writes are safe**: `Y.applyUpdate()` merges with in-memory state via integration into the CRDT's `StructStore`; it does not replace or overwrite. A write made before `persistence.whenLoaded` resolves enters Y.Doc's update log and merges with the saved blob when persistence applies it.
- **Pre-unlock encrypted writes are safe**: `y-keyvalue-lww-encrypted.ts` stores plaintext when no keys are present; `activateEncryption()` re-encrypts every entry when keys arrive (test at `y-keyvalue-lww-encrypted.test.ts:376-398`, "passthrough then encrypted").
- **Conclusion**: no method-wrapping is warranted. Reads/writes do not need to become async to enforce readiness; the framework only needed to give authors a typed place to expose readiness for callers that care (notably the CLI).

**Why this drop-everything spec subsumed it.** A typed-field-on-`DocumentBundle` answer requires `DocumentBundle` to keep existing. The teardown in this spec deletes `DocumentBundle`, `DocumentHandle`, the factory, and the brand outright: domain bundles are now plain objects returned from inline composition at module scope, and "readiness" is whatever shape the author chose to expose on that object. There is no central contract to extend. Apps that need a CLI-readable readiness barrier expose `whenReady` on their workspace export by convention; the CLI reads it duck-typed (`if (workspace.whenReady) await workspace.whenReady`). The minimal-extension answer was correct under the old contract; deleting the contract made it moot.

The Yjs/encryption pre-ready-write findings still hold and inform the new design: nothing in this spec re-introduces method-wrapping for readiness, because the underlying CRDT and encryption layers already handle the unsafe-looking cases correctly.

---

## Edge cases

### Bundle author forgets to compose `whenReady` correctly

The framework can't catch this. If an author writes `whenReady: persistence.whenLoaded` but the bundle also depends on `unlock.whenChecked`, callers may invoke actions against unready encrypted state. **Documentation is the only defense.** README shows the canonical `Promise.all([...])` composition with annotations explaining why each piece is included.

### Caller forgets `[Symbol.dispose]`

`ydoc.destroy()` cascades to attachments via `ydoc.on('destroy')`: they self-clean. So as long as the workspace export's dispose calls `ydoc.destroy()`, all attachments tear down. This is one line and easy to write; documentation should make it the canonical pattern.

### Caller writes their own composition instead of using the package's helper

Allowed. The composition is just function calls. A deployment that wants different tables, custom encryption, or extra attachments writes its own bootstrap module. The package contributes schemas + action factories; the deployment chooses how to compose them. There's no contract being violated.

### Two domain bundles share a Y.Doc

Allowed. `attachTables(ydoc, fujiTables)` and `attachTables(ydoc, journalTables)` can both run against the same ydoc as long as their table keys don't collide. This is one of the *good* properties of the attach-everything model: composition is the framework.

### CLI tries to dispatch an action that doesn't exist

`actions[unknownPath]` is `undefined`. `epicenter run` checks and emits a "not defined" error with sibling suggestions (current behavior, just sourced from `Object.keys(actions)` instead of `ActionIndex.under(prefix)`).

### Workspace export shape doesn't match what the loader expects

Loader emits a clear error: "Expected an exported object with `{ whenReady, [Symbol.dispose] }`. Got `{...}`. See <link to docs>."

---

## Success criteria

- [ ] `packages/workspace/src/document/document.ts` deleted (or reduced to vestigial helpers if anything survives).
- [ ] No `Document`, `DocumentBundle`, `DocumentHandle`, or `DOCUMENT_HANDLE` references in `packages/`.
- [ ] No `iterateActions`, `ActionIndex`, or `buildActionIndex` in `packages/cli/`.
- [ ] At least one app (`apps/fuji` recommended) ships with top-level inline composition (no `openFuji()` wrapper, domain-named export, `dispatch`/`getToken` callbacks).
- [ ] `epicenter.config.ts` files in `playground/*` use inline composition; no factories.
- [ ] CLI loader returns `{ name, workspace }` entries; commands read first-class fields off `entry.workspace`.
- [ ] `epicenter run posts.create '{...}'` works against the new shape.
- [ ] `epicenter peers` works against `entry.workspace.awareness` directly.
- [ ] `packages/workspace/README.md` leads with the attach-everything philosophy.
- [ ] `bun test` passes.
- [ ] `bun run build` passes.

---

## What survives, what dies: quick reference

```
SURVIVES                           DIES
─────────────────────              ─────────────────────────────────
attachTable                        createDocumentFactory
attachKv                           defineDocument
attachAwareness                    Document
attachIndexedDb                    DocumentBundle
attachSqlite                       DocumentHandle
attachSync                         DOCUMENT_HANDLE brand
attachSessionUnlock                isDocumentHandle
attachEncryption                   iterateActions
attachRichText                     ActionIndex
attachPlainText                    buildActionIndex
attachTimeline                     ACTION_BRAND
attachMarkdownMaterializer         entry.handle envelope
attachSqliteMaterializer           getSync / extractAwareness
defineQuery                        gcTime / refcount machinery
defineMutation                     handle.dispose() refcount semantics
dispatchAction                     `if (whenReady) await whenReady`
defineTable                        2-tier convenience APIs (bootstrapFuji)
defineKv                           slot-keyed builders (openFuji({ persistence, sync }))
EPICENTER_PATHS, sessions, etc.    `Document.actions?` contract field (never added)
                                   openFuji() / openConfig() wrapper functions
                                   `serve: Actions` on attachSync
                                   sync.serveRpc(actions) post-construct
                                   void async-IIFE token bootstrap
```

---

## References

### Files most affected

- `packages/workspace/src/document/document.ts`: to be deleted
- `packages/workspace/src/shared/actions.ts`: keep `defineQuery` / `defineMutation` / `dispatchAction`, drop `iterateActions` and `ACTION_BRAND` if possible
- `packages/cli/src/load-config.ts`: rewritten loader
- `packages/cli/src/util/handle-attachments.ts`: deleted
- `packages/cli/src/util/action-index.ts`: deleted
- `packages/cli/src/commands/{run,list,peers}.ts`: rewritten
- `packages/workspace/README.md`: rewritten
- `.claude/skills/workspace-api/SKILL.md`: rewritten
- `docs/articles/workspaces-were-documents-all-along.md`: rewritten or retired

### Consumers to migrate

- `apps/fuji/src/lib/workspace.ts` and any factory usage in `apps/fuji/src/lib/entry-content-docs.ts`
- `apps/honeycrisp/src/lib/workspace.ts` and `note-body-docs.ts`
- `apps/zhongwen/src/lib/workspace/definition.ts`
- `apps/tab-manager/src/lib/workspace/definition.ts`
- `playground/tab-manager-e2e/epicenter.config.ts`
- `playground/opensidian-e2e/epicenter.config.ts`
- `~/Code/vault/epicenter.config.ts` (out of repo, not gating)

### Superseded / coordinated specs

- `specs/20260424T000000-self-gating-attachments.md`: superseded; the one-line `whenReady?` direction is replaced by always-defined `whenReady` composed inline by the caller.
- `specs/20260421T155436-cli-scripting-first-redesign.md`: coordinate; the 3-command CLI surface stays, but the load-config and dispatch sections need updates to match the new shape.
- `specs/20260422T000100-rename-define-document.md`: moot; `defineDocument` / `createDocumentFactory` are both removed.
- `specs/20260425T000000-device-actions-via-awareness.md`: additive follow-up; defines the awareness state convention (`device`, `offers`), the `serializeActionManifest` and `invoke` helpers, and the per-device action discovery / invocation pattern. Builds on the post-factory architecture defined here. The SPA bootstrap example in this spec uses those helpers to show the integrated form.

### Conversation that produced this spec

The reasoning that led here:

1. Started from "why does CLI's `entry.handle.X` feel like a smell?"
2. Identified the loader-envelope vs. typed-handle conflict.
3. Identified `ActionIndex` as a workaround for actions-anywhere-on-bundle.
4. Identified the state-vs-behavior category mistake on the bundle.
5. Worked through reframings: contract field, derived view, sibling compartments.
6. Stepped back from `createDocumentFactory` entirely.
7. Considered `openFuji` as a builder, then as a slot-keyed builder, then as a two-tier API.
8. Rejected all of them as either too opinionated, too indirect, or guesses-at-abstraction.
9. Landed on inline composition + separate action registries; `attachX` helpers ship per-domain only when non-trivial composition warrants them.
10. Recognized this as the "everything is an attach" philosophy taken to its conclusion.

### Surprise discovery: Fuji is mostly already there

After grounding the spec, reading `apps/fuji/src/lib/client.svelte.ts` revealed the function is already named `openFuji()` and already does inline composition with all the right pieces (`encryption`, `tables`, `kv`, `awareness`, `idb`, `attachBroadcastChannel`, `attachSync`, `createFujiActions(tables)`, per-entry content-doc factory, `[Symbol.dispose]`). The only gaps from the new model are:

1. `satisfies Document` at the return: drop it; the contract goes away.
2. `actions: createFujiActions(tables)` declared inline at return: lift to a `const actions` before `attachSync` so it can be passed as `serve`.
3. `attachSync` takes no `serve` parameter today: add it; route incoming RPC through the registry at construct time.
4. Export named `workspace`: rename to `fuji` so CLI invocations read `fuji.entries.create` instead of `workspace.entries.create`.

The package side (`apps/fuji/src/lib/workspace.ts`) already exports the right minimal surface: `fujiTables`, `createFujiActions`, `Entry`, `EntryId`. **No `attachFuji` helper needed**: the composition is one `attachTables` call. This was a useful early signal that the spec's earlier "domain packages export `attachX`" framing was over-specified; many domains only need schemas + action factory.
