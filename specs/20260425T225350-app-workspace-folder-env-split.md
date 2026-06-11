# App workspace folder + environment split

**Date**: 2026-04-25
**Status**: shipped (manual smoke tests pending)
**Author**: AI-assisted (Braden + Claude)
**Branch**: drop-document-factory

## Overview

Standardize how every app under `apps/*` exposes its workspace. Replace the
current single `client.{svelte.,}ts` file with a per-app folder containing one
isomorphic entry (`index.ts`) plus one or more environment-bound siblings
(`browser.ts`, `tauri.ts`, `extension.ts`). Same canonical function name in
every file; the import path tells you the binding.

## Motivation

### Current State

Each app exposes a single workspace client file at `apps/<app>/src/lib/`:

| App          | File                | Pattern                            |
| ------------ | ------------------- | ---------------------------------- |
| zhongwen     | `client.svelte.ts`  | `openZhongwen()` factory + singleton |
| fuji         | `client.svelte.ts`  | (assumed) flat module-scope        |
| honeycrisp   | `client.svelte.ts`  | (assumed) flat module-scope        |
| opensidian   | `client.svelte.ts`  | (assumed) flat module-scope        |
| tab-manager  | `client.svelte.ts`  | flat module-scope (verified)        |
| whispering   | `client.ts`         | flat module-scope (verified)        |

`client.svelte.ts` (zhongwen): current shape:

```ts
function openZhongwen() {
  const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, zhongwenTables);
  const kv = encryption.attachKv(ydoc, zhongwenKv);
  const idb = attachIndexedDb(ydoc);             // ← browser-only import
  attachBroadcastChannel(ydoc);                  // ← browser-only import
  return { ydoc, tables, kv, encryption, idb,
           batch: fn => ydoc.transact(fn),
           whenReady: idb.whenLoaded,
           [Symbol.dispose]() { ydoc.destroy(); } };
}
export const zhongwen = openZhongwen();
```

This creates problems:

1. **Browser-only deps reachable from Node**: `epicenter.config.ts` and any
   build/CLI tool that imports zhongwen pulls `y-indexeddb` (which references
   `indexedDB` at module scope) and `BroadcastChannel`. Even when not crashing,
   it's an import-graph foothold for browser code into Node bundles.
2. **No headless factory for tests/tooling**: There's no way to construct a
   zhongwen Y.Doc with schemas + encryption attached *without* IndexedDB. Tests
   either mock idb or skip persistence-coupled paths.
3. **Inconsistent shape across apps**: zhongwen is a factory, the rest are flat
   module-scope. New developers can't predict which pattern they'll find.
4. **Single binding per app**: No shape supports adding a Tauri build of a
   browser app, or a Node CLI for an extension app, without rewriting imports.

### Desired State

Each app exposes a folder named after itself, with `index.ts` (isomorphic) and
one or more environment files. Same canonical function name (`open<App>`) in
every file. Imports look like:

```ts
// epicenter.config.ts (Node, build/config)
import { openZhongwen } from './apps/zhongwen/src/lib/zhongwen';

// browser app code
import { zhongwen } from '$lib/zhongwen/browser';

// future desktop entry
import { zhongwen } from '$lib/zhongwen/desktop';
```

## Research Findings

### Pattern in the JS ecosystem

The "core + per-environment" split is a settled pattern across major libraries:

| Library         | Core                | Environment variants                                  |
| --------------- | ------------------- | ----------------------------------------------------- |
| `react`         | `react`             | `react-dom`, `react-dom/server`, `react-native`       |
| `effect`        | `effect`            | `@effect/platform-node`, `@effect/platform-browser`   |
| `yjs`           | `yjs`               | `y-indexeddb`, `y-websocket`, `y-leveldb`             |
| `drizzle`       | `drizzle-orm`       | `drizzle-orm/better-sqlite3`, `/postgres-js`, etc.    |

**Key finding**: Every major library separates the portable layer from the
binding layer via *paths*, not function-name suffixes. `react-dom/server` is
not `serverReactDom()`; it's the same `render` function reached via a
different import path.

**Implication**: The folder-as-namespace + same-name-per-file pattern is the
native idiom. Function-name suffixes (`openZhongwenBrowser`) are a workaround
for environments that don't have paths.

### Conflict with recent codebase direction

Commit `ca3b81a77 refactor(workspaces): drop bundle + open*: fully flat
module-scope exports` (4 commits ago) standardized most apps on **flat
module-scope exports** instead of `open*()` factories. Whispering and
tab-manager were migrated. Zhongwen was not. The reasoning behind that commit
was: "the file IS the workspace recipe, top-down". The file's exports *are*
the workspace; you don't need a constructor.

This is the central tension. The split into iso + env files works under either
pattern, but the choice changes the call sites:

- **Factory pattern**: `import { openZhongwen } from '$lib/zhongwen/browser'`
  followed by `const z = openZhongwen()`. Fresh instance per call.
- **Flat module-scope**: `import { ydoc, tables, kv } from '$lib/zhongwen/browser'`.
  Singleton (the module is the singleton).

### Verified teardown behavior

Both browser-side attachments register `ydoc.once('destroy', ...)` already, so
`ydoc.destroy()` (whether from a `[Symbol.dispose]` or directly) tears down
idb + BroadcastChannel. Verified at:

- `packages/workspace/src/document/attach-indexed-db.ts:29`
- `packages/workspace/src/document/attach-broadcast-channel.ts:64`

Both also expose an awaitable `whenDisposed` promise for tests/CLIs that need
to flush before exit.

### App inventory

```
apps/api/                  ← Cloudflare Workers, no workspace consumer
apps/breddit/              ← workspace/ folder only, no client file. SKIP.
apps/dashboard/            ← no workspace. SKIP.
apps/fuji/                 ← client.svelte.ts (browser)
apps/honeycrisp/           ← client.svelte.ts (browser)
apps/landing/              ← marketing site. SKIP.
apps/opensidian/           ← client.svelte.ts (browser)
apps/posthog-reverse-proxy ← proxy. SKIP.
apps/tab-manager/          ← client.svelte.ts (chrome extension)
apps/whispering/           ← client.ts (Tauri desktop)
apps/zhongwen/             ← client.svelte.ts (browser): pilot
```

Six apps in scope. Five browser/extension/Tauri, plus zhongwen.

## Design Decisions

| Decision                          | Choice                                            | Rationale                                                                                                  |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| File layout                       | Folder per app, `index.ts` + `<binding>.ts`       | Folder is namespace; path is the environment signal. Maps directly to subpath exports if ever packaged.    |
| Folder name                       | The app name (e.g. `zhongwen/`)                   | Self-describing imports: `$lib/zhongwen/browser`. Matches package convention.                              |
| Isomorphic file name              | `index.ts`                                        | Default entry; matches subpath-exports `"."`.                                                              |
| Environment file names            | `browser.ts`, `tauri.ts`, `extension.ts`          | Specific when bound to a platform's APIs (Tauri, Chrome extension). Generic `browser` only when no framework binds the file. |
| Reject `desktop.ts`               | Use `tauri.ts` instead for whispering             | If we ever add Electron, `desktop.ts` would lie. `tauri.ts` is honest about its imports.                   |
| Reject `browser.ts` for tab-manager | Use `extension.ts`                              | Chrome extensions use `chrome.*` APIs not present in regular browser env; `browser.ts` would understate.   |
| Function name                     | `open<App>` in every file (canonical, same name)  | Path disambiguates; function name stays grep-able and consistent across the monorepo.                      |
| Singleton const                   | Lowercase `<app>`, only in env files              | `index.ts` is for tooling/tests that want fresh docs; no implicit singleton there.                         |
| Verb choice                       | `open` over `create`/`make`/`init`                | Signals "resource needing teardown": pairs with `[Symbol.dispose]`.                                       |
| Always have `index.ts`            | Even if app has only one environment              | Build tools, tests, and migrations need a portable factory. Cost is one tiny file per app.                 |
| Convention location               | `.claude/skills/workspace-app-layout/SKILL.md`    | User preference; skills are the durable place for codebase patterns.                                       |
| Singleton vs factory pattern      | **OPEN: see Open Questions #1**                  | Conflict with `ca3b81a77`. Pick before executing.                                                          |

## Architecture

### Per-app folder shape

```
apps/<app>/src/lib/<app>/
├── index.ts          ← isomorphic
│                       imports: @epicenter/workspace (core), schemas
│                       no  `attach*` for persistence/transport
│                       no  node:* / bun:* / chrome.* / @tauri-apps/*
│
├── browser.ts        ← browser-bound (zhongwen, fuji, honeycrisp, opensidian)
│                       imports: ./index + attachIndexedDb + attachBroadcastChannel
│                       (+ attachSync if the app has remote sync)
│
├── tauri.ts          ← tauri-bound (whispering)
│                       imports: ./index + Tauri-specific persistence + materializers
│
└── extension.ts      ← chrome-extension-bound (tab-manager)
                        imports: ./index + idb + bc + sync + chrome.* glue
```

### Bleed-prevention is structural

```
browser.ts ───imports───▶ index.ts ───imports───▶ @epicenter/workspace (core), schemas
                                ▲
                                │
tauri.ts ─────imports───────────┘ (siblings never import each other)
```

`browser.ts` and `tauri.ts` never import each other. The browser bundle entry
walks `browser.ts → index.ts → ...` and stops: `bun:sqlite` cannot reach
the browser bundle even if added carelessly to `tauri.ts`.

### Function shape (factory pattern variant)

```ts
// index.ts
export function open<App>() {
  const ydoc = new Y.Doc(...);
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, <app>Tables);
  const kv = encryption.attachKv(ydoc, <app>Kv);
  return { ydoc, tables, kv, encryption,
           batch: fn => ydoc.transact(fn),
           [Symbol.dispose]() { ydoc.destroy(); } };
}

// browser.ts
import { open<App> as openIsomorphic } from './index';
export function open<App>() {
  const base = openIsomorphic();
  const idb = attachIndexedDb(base.ydoc);
  attachBroadcastChannel(base.ydoc);
  return { ...base, idb, whenReady: idb.whenLoaded };
}
export const <app> = open<App>();
```

### Function shape (flat module-scope variant)

```ts
// index.ts
export const ydoc = new Y.Doc(...);
export const encryption = attachEncryption(ydoc);
export const tables = encryption.attachTables(ydoc, <app>Tables);
export const kv = encryption.attachKv(ydoc, <app>Kv);
export const batch = (fn: () => void) => ydoc.transact(fn);

// browser.ts
export * from './index';
import { ydoc } from './index';
export const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);
export const whenReady = idb.whenLoaded;
```

## Implementation Plan

### Phase 1: Pilot zhongwen ✅

- [x] **1.1** Create `apps/zhongwen/src/lib/zhongwen/index.ts`: isomorphic factory.
- [x] **1.2** Create `apps/zhongwen/src/lib/zhongwen/browser.ts`: browser bindings + singleton.
- [x] **1.3** Update call sites (`+page.svelte`, `chat-state.svelte.ts`) to import
      from `$lib/zhongwen/browser` and access via `zhongwen.kv`, `zhongwen.tables`,
      `zhongwen.batch`, `zhongwen.whenReady`.
- [x] **1.4** Delete old `apps/zhongwen/src/lib/client.svelte.ts`.
- [x] **1.5** Typecheck + build: refactor introduces zero new errors. Pre-existing
      `@tanstack/ai-svelte` missing-dep issue is independent.
- [ ] **1.6** Manual smoke test in browser deferred to user.

### Phase 2: Codify the convention ✅

- [x] **2.1** Create `.claude/skills/workspace-app-layout/SKILL.md` with the
      conventions: folder shape, naming rules, binding vocabulary, function
      shape, two bleed-prevention rules, what-goes-where table, anti-patterns,
      and migration guide.
- [ ] **2.2** Reference from `AGENTS.md` (deferred: skills are auto-discovered
      via their description; explicit reference may be unnecessary).

### Phase 3: Roll out to remaining apps ✅

Then refactored further (per user request) into a three-file layout per app:
- `index.ts`: iso doc factory (`open<App>()`)
- `<binding>.ts`: pure env factory, takes injected deps like `{ auth }`,
  no `createAuth`, no singleton, no `onSessionChange`
- `client.ts`: `createAuth`, singleton, lifecycle subscriptions, HMR dispose

Call sites import from `client.ts` and use direct property access
(`<app>.tables.foo`, `<app>.actions.bar`): no destructuring.

- [x] **3.1** fuji: `lib/fuji/{index,browser,client}.ts`. 7 call sites updated.
- [x] **3.2** honeycrisp: `lib/honeycrisp/{index,browser,client}.ts`. 5 call sites updated.
- [x] **3.3** opensidian: `lib/opensidian/{index,browser,client}.ts`. 12 call sites updated.
      `actions`, `fs`, `bash`, `sqliteIndex`, `fileContentDocs` live in
      `browser.ts` because they depend on `attachIndexedDb`. `workspaceAiTools`
      lives in `client.ts` (uses the singleton).
- [x] **3.4** tab-manager: `lib/tab-manager/{index,extension,client}.ts`. 11 call sites
      updated. `await session.whenReady` (chrome.storage hydration) lives in
      `client.ts` before `createAuth`. `rpc-contract.ts` derives `Actions`
      from `typeof tabManager.actions`.
- [x] **3.5** whispering: `lib/whispering/{index,tauri,client}.ts`. 9 call sites updated.
      `recordingsFs` lives in `tauri.ts`. `client.ts` is minimal (no auth/sync):
      just `export const whispering = openWhispering()`.

### Phase 4: Verify nothing imports old paths ✅

- [x] **4.1** Grep for `$lib/client` and `$lib/client.svelte` across all apps:
      zero hits.
- [x] **4.2** Confirmed no leftover `client.ts` / `client.svelte.ts` files in
      any app's `src/lib/`.
- [ ] **4.3** Full monorepo type-check / test run deferred to user. Per-app
      diagnostics during migration showed only pre-existing errors
      (`@tanstack/ai-svelte` missing dep, `@tanstack/ai-svelte` FetchFn shape
      mismatch, FileId branding): none introduced by the refactor.

## Edge Cases

### Apps with `await` at module top-level

`tab-manager/client.svelte.ts:40` has `await session.whenReady` at module
scope before constructing auth. This works because the file is a module with
top-level await. After the split:

1. `index.ts` should not contain auth/session wiring: that's environment
   concerns. Auth lives in `extension.ts`.
2. `extension.ts` keeps the top-level await pattern.
3. Importing `index.ts` from a Node config does not trigger the await chain.

### Whispering's `recordingsFs` materializer

`whispering/client.ts:30` attaches a Tauri-specific markdown-file materializer
on top of idb's `whenReady`. That belongs in `tauri.ts`, not `index.ts`. The
isomorphic doc has no filesystem.

### Apps where the singleton is consumed directly (`import { ydoc } from ...`)

Flat module-scope apps (whispering, tab-manager) export named primitives like
`ydoc`, `tables`, `kv`. Many call sites import these directly. The migration
must preserve those exports under the new path: `browser.ts` / `tauri.ts` /
`extension.ts` re-exports `index.ts` and adds the env-specific ones. Call
sites change from `$lib/client.svelte` to `$lib/<app>/<binding>` but the
import names stay the same.

### Apps with sync (`attachSync`)

Tab-manager and possibly fuji wire `attachSync` with WebSocket transport.
WebSocket is part of the browser/extension binding (uses `WebSocket` global),
so `attachSync` belongs in the env file, not `index.ts`.

### `auth.onSessionChange` and HMR dispose

Session-change side-effects and HMR teardown are env concerns (HMR only
applies to Vite-driven dev environments). They live in env files.

### `epicenter.config.ts`

Confirm whether this file currently exists, where, and what it imports. If it
imports from `client.svelte.ts` today, it's the canary for the bleed problem.
If it doesn't exist yet, the iso file is built for hypothetical future
consumers (tests, codegen) and the bleed argument is preventive.

### `.svelte.ts` files using runes

If an env file uses Svelte 5 runes (`$state`, `$derived`), it must be named
`browser.svelte.ts` (or `extension.svelte.ts` etc.). The pattern accommodates
this; the folder name is unchanged.

## Open Questions

1. **Factory pattern (`open<App>()`) vs flat module-scope exports**: **RESOLVED: (a) Full factory.**
   - User decision (2026-04-25): full factory pattern in both files. `browser.ts`
     composes around `index.ts`'s factory. Clean break from `ca3b81a77`.
   - Call sites that previously did `import { kv, batch, tables } from '$lib/client.svelte'`
     migrate to `import { zhongwen } from '$lib/zhongwen/browser'` and access
     via `zhongwen.kv`, `zhongwen.tables`, etc.

2. **`zhongwen` naming when used both as folder and as singleton const**
   - The folder is `lib/zhongwen/`. The browser file exports
     `export const zhongwen = openZhongwen()`. Imports become
     `import { zhongwen } from '$lib/zhongwen/browser'`. No actual collision
     (folder vs identifier), but the identifier is rendered in autocomplete
     by tools that may show both.
   - **Recommendation**: Live with it. The path makes it unambiguous to TS.

3. **What does `index.ts` return when the app needs sync attached unconditionally?**
   - Tab-manager's flow assumes `attachSync` runs at startup. If a Node test
     constructs a tab-manager doc, does it want `sync`? Almost never.
   - **Recommendation**: `index.ts` never wires sync. Sync is exclusively in
     env files. Tests that need sync can wire it manually.

4. **Should we expose `index.ts` from a TS-path alias?**
   - Currently `$lib` is the alias. Imports look like `$lib/zhongwen/browser`.
     Could add `$workspace` as a per-app alias if it matters.
   - **Recommendation**: Defer. `$lib/<app>/<binding>` is fine.

5. **Migration sequencing: single PR or per-app commits?**
   - Options: (a) one big PR for all six apps; (b) zhongwen pilot ships first,
     then a second PR sweeps the rest; (c) one PR per app.
   - **Recommendation**: (b). Pilot zhongwen, validate, then sweep. Avoids
     finding a wrinkle in zhongwen and having to retrofit five apps.

## Success Criteria

- [ ] All six apps follow the same folder shape: `lib/<app>/index.ts` plus
      one or more `<binding>.ts` files.
- [ ] No app's `lib/<app>/index.ts` imports from `node:*`, `bun:*`,
      `@tauri-apps/*`, `chrome.*`, `y-indexeddb`, or `BroadcastChannel`.
- [ ] All apps build and pass type-check.
- [ ] Smoke-test of each app's golden path passes (browser apps load and
      persist data; whispering loads in Tauri; tab-manager loads in extension).
- [ ] `.claude/skills/workspace-app-layout/SKILL.md` exists and documents
      the convention with examples.
- [ ] No remaining imports of `$lib/client` or `$lib/client.svelte` paths.

## References

- `apps/zhongwen/src/lib/client.svelte.ts`: current zhongwen client (factory pattern).
- `apps/whispering/src/lib/client.ts`: current whispering client (flat, Tauri).
- `apps/tab-manager/src/lib/client.svelte.ts`: current tab-manager client (flat, extension).
- `packages/workspace/src/document/attach-indexed-db.ts`: verified destroy
  hook + `whenDisposed` promise.
- `packages/workspace/src/document/attach-broadcast-channel.ts`: verified
  destroy hook + `whenDisposed` promise.
- Commit `ca3b81a77 refactor(workspaces): drop bundle + open*: fully flat
  module-scope exports`: the recent direction this spec must reconcile with.
- `.claude/skills/factory-function-composition/SKILL.md`: relevant if
  Open Question #1 lands on factory or hybrid.
- `.claude/skills/workspace-api/SKILL.md`: current workspace API docs.
