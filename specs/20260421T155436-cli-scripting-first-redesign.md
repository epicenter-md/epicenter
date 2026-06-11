# CLI Scripting-First Redesign

**Date**: 2026-04-21
**Status**: Draft (v2: grounded against current `packages/workspace/src/document/define-document.ts` and `packages/cli/src/*`)
**Author**: AI-assisted (pairing with Braden)
**Branch**: `braden-w/document-primitive`

---

## Overview

Collapse the Epicenter CLI from a framework-shaped command registry (11 commands) to a scripting-first binary with three responsibilities: manage auth sessions, invoke `defineQuery`/`defineMutation` nodes by dot-path, and render a tree view of everything runnable. Everything else: bulk ops, exports, ad-hoc data munging: moves to user-authored `.ts` scripts that import `epicenter.config.ts` and run via `bun run`.

This is a **clean break**. No compat shims, no deprecation warnings. The consumers: `apps/whispering`, vault, tab-manager, playgrounds: all live in this repo or on the same cadence.

---

## Orientation: read this first if you're new

This spec lives at the intersection of several active migrations. Before touching code, understand the sequence:

1. **`defineDocument` is live**, not hypothetical. It's a cached, ref-counted **factory**: not a bundle builder. See `packages/workspace/src/document/define-document.ts:293-423`. The shape that matters:

   ```ts
   // packages/workspace/src/document/define-document.ts:293
   defineDocument<Id, T>(build: (id: Id) => T, opts?: { gcTime?: number })
     : DocumentFactory<Id, T>

   // The factory: NOT the bundle.
   type DocumentFactory<Id, T> = {
     open(id: Id): DocumentHandle<T>;     // refcount++, returns disposable handle
     close(id: Id): Promise<void>;         // force-close regardless of handles
     closeAll(): Promise<void>;
   };

   // The bundle (what your build closure returns):
   type DocumentBundle = {
     ydoc: Y.Doc;
     [Symbol.dispose](): void;
     whenReady?: Promise<void>;            // user convention
     whenDisposed?: Promise<void>;         // async teardown barrier
   };

   // The handle (prototype-chained to the bundle, with refcount accounting):
   type DocumentHandle<T> = T & {
     dispose(): void;                      // per-handle idempotent
     [Symbol.dispose](): void;
   };
   ```

2. **Critical shape discovery: the `id` is NOT on the bundle.** It's the cache key inside the factory. So a user's exported handle has `.ydoc` (via prototype), `.dispose()`, `[Symbol.dispose]`, plus whatever they attached (`tables`, `kv`, `sync`, ...): but no top-level `id` property. Any duck-type that checks `'id' in record` is wrong against the current primitive.

3. **What users should export from `epicenter.config.ts`**: **opened handles**, not factories. A factory doesn't know what id to open without a call; a handle is already connected, refcounted, and walkable.

   ```ts
   // THIS (export an opened handle)
   const tabManagerFactory = defineDocument((id) => ({ ydoc, tables, /* ... */ }));
   export const tabManager = tabManagerFactory.open('epicenter.tab-manager');

   // NOT this (exporting the factory leaves id ambiguous at the CLI boundary)
   export const tabManager = defineDocument(...);
   ```

   The exported `tabManager` reads `tabManager.ydoc`, `tabManager.tables.savedTabs.list(...)` etc. via prototype chain; `.dispose()` releases the refcount.

4. **The lie in the current CLI**: `packages/cli/src/load-config.ts:78-86` requires `'id' in record` AND `'tables' in record`. Neither is guaranteed by `DocumentBundle`. `run.ts:54-66` falls back to `client.extensions.*`: a namespace that no longer exists in the new primitive. `commands/describe.ts` is already deleted with no replacement. The whole CLI surface was written against `createWorkspace()`, which the primitive migration is removing.

5. **`createCliUnlock` does not exist in the codebase.** Grep confirms: only referenced in stale specs, `playground/*/epicenter.config.ts`, and the vault config at `~/Code/vault/epicenter.config.ts`. Those consumers are broken. Any `attachCliUnlock` is **genuinely new code**, not a rename, and its shape depends on the parallel encryption-primitive-refactor spec (`20260421T140000-encryption-primitive-refactor.md`).

6. **Why scripting-first**: If `DocumentBundle` guarantees only `{ ydoc, [Symbol.dispose] }`, any CLI command assuming more (tables, kv, size, rpc) is speculating beyond the contract. Users who want those should write `.ts` scripts. The config is already self-loading: importing `epicenter.config.ts` in any script gives you a live workspace. `bun run script.ts` is the whole runtime.

---

## Motivation

### Current State

**11 top-level commands**, most assuming a workspace shape the new primitive doesn't produce:

```
epicenter
├── auth         (login/logout/status)   ← keep
├── start                                  ← assumes old extension shape
├── get <table> <id>                       ← assumes .tables
├── list <table>                           ← assumes .tables
├── count <table>                          ← assumes .tables
├── delete <table> <id>                    ← assumes .tables
├── tables                                 ← assumes .tables
├── kv <get|set|delete>                    ← assumes .kv
├── export                                 ← assumes .tables
├── init                                   ← scaffolding
├── run <action>                           ← assumes .actions + .extensions
├── size                                   ← assumes .tables
└── rpc                                    ← assumes .rpc surface
```

**The duck-type assertion** at `packages/cli/src/load-config.ts:78-86`:

```ts
function isWorkspaceClient(value: unknown): value is DocumentClient {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&     // ← not guaranteed (bundle has no id)
    'ydoc' in record &&
    'tables' in record                    // ← not guaranteed (tables are optional)
  );
}
```

**The dead `.extensions` fallback** at `packages/cli/src/commands/run.ts:53-66`:

```ts
if (!found) {
  for (const [extKey, extValue] of Object.entries(
    (client as any).extensions ?? {},     // ← namespace deleted in new primitive
  )) { /* unreachable */ }
}
```

**The stale error hint** at `packages/cli/src/load-config.ts:67-68` pointing users at `createWorkspace()`: an API being removed.

### Problems

1. **Duck-type rejects valid bundles.** `DocumentBundle` doesn't require `id` or `tables`.
2. **Dead code paths.** `.extensions` fallback can never match post-migration.
3. **Speculation beyond contract.** `data`/`kv`/`size`/`rpc` assume structure only some bundles have.
4. **No uniform action surface.** App authors write `defineQuery`/`defineMutation` for UI/AI consumers but the CLI uses its own conventions.
5. **No scripting story.** Complex ops ("export recordings to markdown") should be scripts, but there's no first-class escape hatch.

### Desired State

```bash
$ epicenter auth login --server https://api.epicenter.so
$ epicenter list                                      # tree of runnable actions
$ epicenter run tabManager.savedTabs.list
$ epicenter run tabManager.savedTabs.create --title "Hi" --url "..."

$ bun run scripts/export-recordings.ts                # anything non-trivial
```

The config self-loads at import time. The CLI is a thin shell. The real product is the primitives package users import.

---

## Research Findings

### `DocumentBundle` and `DocumentHandle`: the actual contract

Verified by reading `packages/workspace/src/document/define-document.ts`:

```
┌──────────────────────────────────────────────────────────────┐
│  DocumentBundle (what your build() returns)                   │
│    ydoc: Y.Doc                            : required        │
│    [Symbol.dispose](): void               : required        │
│    whenReady?: Promise<void>              : user convention │
│    whenDisposed?: Promise<void>           : async barrier   │
│    + anything else you attach             : tables, kv, ... │
└──────────────────────────────────────────────────────────────┘
                           │
                           │  Object.create(bundle) + inject .dispose
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  DocumentHandle<T> (what factory.open(id) returns)            │
│   : All bundle props via prototype chain                    │
│   : PLUS: dispose(): void                  (own property)   │
│   : PLUS: [Symbol.dispose](): void         (own property)   │
└──────────────────────────────────────────────────────────────┘
```

**Key invariant**: the handle shares every bundle prop via `Object.create`, so `handle.ydoc === bundle.ydoc`, `handle.tables === bundle.tables`, etc. `for...in` does NOT enumerate prototype properties by default, but property access via `.` or `[]` works. This matters for `iterateActions`: which uses `Object.entries(value)` and so would miss prototype-chained properties.

**Implication**: when walking a handle for actions, we must iterate OWN properties of the handle AND of its prototype (the bundle). The cache only injects `dispose` and `[Symbol.dispose]` as own props; everything else is on the bundle prototype. Our `discoverActions` helper must descend one step into the prototype if the top-level `Object.entries` yields only disposers.

Actually simpler: pass `Object.getPrototypeOf(handle)` (the bundle) to `iterateActions`, not the handle itself. The handle's own keys are just `dispose`/`[Symbol.dispose]`.

### `defineQuery` / `defineMutation`: confirmed primitives

Location: `packages/workspace/src/shared/actions.ts`

| Primitive        | Line  | Shape                                                      |
| ---------------- | ----- | ---------------------------------------------------------- |
| `defineQuery`    | 288   | Callable + `{ [ACTION_BRAND]: true, type: 'query', input?, description?, title? }` |
| `defineMutation` | 335   | Callable + `{ [ACTION_BRAND]: true, type: 'mutation', input?, description?, title? }` |
| `isAction`       | 367   | Type guard via `ACTION_BRAND` presence                     |
| `isQuery`        | 377   | `isAction(v) && v.type === 'query'`                        |
| `isMutation`     | 387   | `isAction(v) && v.type === 'mutation'`                     |
| `iterateActions` | 416   | Generator yielding `[Action, string[]]` tuples             |

All exported from `packages/workspace/src/index.ts:29-38`.

`iterateActions` uses `Object.entries(actions)` and recurses only into `object && !Array && !Promise`. It does NOT traverse prototype chains. So we hand it the bundle (handle's prototype), not the handle.

### What the current CLI already gets right (and we should preserve)

Audit of `packages/cli/src/**/*`:

| File                          | Status                                           |
| ----------------------------- | ------------------------------------------------ |
| `auth/store.ts`               | Session store with normalization, `load`, `loadDefault`, `save`, `clear`. Already the primitive. Keep. |
| `auth/api.ts`                 | Typed Better Auth client with device-code flow. Keep. |
| `paths.ts`                    | `EPICENTER_PATHS.home()/authSessions()/persistence(id)`. Keep. Note: the auth path method is `authSessions()`, not `sessions()`. |
| `util/parse-input.ts`         | `parseJsonInput()` handles `@file.json` + stdin + inline. **This is the escape hatch I originally proposed as `--input-json`. Reuse, don't reinvent.** |
| `util/format-output.ts`       | `formatYargsOptions()`, `output()`, `outputError()` with json/jsonl. Keep. |
| `util/typebox-to-yargs.ts`    | `typeboxToYargsOptions()` already handles primitives, unions, enums, literals. Keep. |
| `commands/auth.ts`            | Device-code login, logout, status. Keep. |
| `bin.ts`                      | 20-line entry point. Keep. |
| `index.ts`                    | Already exports `createSessionStore`, `createAuthApi`, `EPICENTER_PATHS`, `loadConfig`, `createCLI`. Adjust to add `attachCliUnlock` when it lands. |

### What's broken or dying

| File / symbol                  | Problem                                                  | Fate       |
| ------------------------------ | -------------------------------------------------------- | ---------- |
| `load-config.ts` `isWorkspaceClient` | Requires `id` + `tables`, neither guaranteed.       | Rewrite    |
| `load-config.ts` `LoadConfigResult.clients` | Loses export name; name is needed for dot-path. | Rewrite (`entries: { name, handle }[]`) |
| `load-config.ts` error hints   | Reference `createWorkspace()`.                           | Rewrite    |
| `util/command.ts` `DocumentClient` | Duplicates canonical `DocumentBundle` with over-specific fields (`tables`, `kv`, `actions`). | Delete; import `DocumentBundle` + `DocumentHandle` from `@epicenter/workspace`. |
| `util/command.ts` `withWorkspaceOptions` | `--workspace` obsolete post-redesign; `--format` only needed by `run`. | Delete; per-command opts. |
| `util/command.ts` `runCommand` | Coupled lifecycle doesn't fit either new command. | Delete; inline lifecycle. |
| `util/command.ts` `resolveTable`, `resolveWorkspace` | Consumers deleted.                     | Delete. |
| `util/command.ts` `defineCommand` | Identity type-narrower. 3 remaining commands; trivial savings. | Delete. Inline `CommandModule` typing. |
| `commands/run.ts` `.extensions` fallback | Namespace deleted.                                  | Rewrite without fallback. |
| `commands/data.ts`             | All 6 table commands depend on `.tables` presence.       | Delete file. |
| `commands/kv.ts`                | Depends on `.kv` presence.                              | Delete. |
| `commands/project.ts`          | Scaffolding init.                                        | Delete (defer to `bun create`). |
| `commands/rpc.ts`              | RPC surface assumption.                                  | Delete. |
| `commands/size.ts`             | `.tables` dependency.                                    | Delete. |
| `commands/start.ts`            | Old extension-style daemon.                              | Delete (see Open Q). |
| `README.md`                    | Describes pre-migration surface.                          | Rewrite.   |
| `cli.test.ts`                  | Docstring lists deleted commands.                        | Rewrite for 3-command surface. |

### The vault config demonstrates the target pattern

`~/Code/vault/epicenter.config.ts` already self-loads: imports `createSessionStore`, composes sync with the stored token, attaches `createCliUnlock` (which doesn't exist yet: vault is broken until the refactor lands), writes persistence to `EPICENTER_PATHS.persistence(...)`. The config IS the workspace. Running `bun run anything.ts` that imports the config boots the full workspace. **We are formalizing this existing pattern, not inventing it.**

### Missing primitive: `attachCliUnlock`

Grep confirms no source for `createCliUnlock` or `attachCliUnlock` anywhere in `packages/`. Only references:

- `specs/20260421T155436-cli-scripting-first-redesign.md` (this file)
- `specs/20260414T023253-connect-workspace.md` (old spec)
- `playground/tab-manager-e2e/epicenter.config.ts`, `playground/opensidian-e2e/epicenter.config.ts`
- `~/Code/vault/epicenter.config.ts`
- `packages/cli/README.md` (stale docs)

All consumers above are broken. The primitive needs to ship as part of this refactor.

**Shape (sketch, pending encryption-refactor coordination):**

```ts
// packages/cli/src/attach-cli-unlock.ts (NEW)
import { attachEncryption } from '@epicenter/workspace';
import type * as Y from 'yjs';
import type { createSessionStore } from './auth/store';

export function attachCliUnlock(
  ydoc: Y.Doc,
  opts: { sessions: ReturnType<typeof createSessionStore>; serverUrl: string },
) {
  // Load session synchronously at construction time: if no session, throw.
  // (Not async because bundle build() is synchronous.)
  // The session provides encryptionKeys used by attachEncryption.
  // Implementation depends on encryption-primitive-refactor.
}
```

This is a **thin wrapper over `attachEncryption`** that sources keys from the session store. Coordinate shape with `specs/20260421T140000-encryption-primitive-refactor.md` before finalizing.

---

## Design Decisions

| Decision                                    | Choice                                                | Rationale                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invocation verb                             | `run`                                                 | Matches current command; `invoke` longer; `list` is the introspection verb.                                                                         |
| Introspection verb                          | `list`                                                | Tree view of runnable nodes. Collides with old `list <table>` which is being deleted.                                                               |
| Scripting command                           | None: use `bun run` directly                         | Config self-loads; `epicenter run file.ts` would reinvent `bun`.                                                                                    |
| Commands to delete                          | `data`/`get`/`count`/`delete`/`tables`/`kv`/`size`/`rpc`/`start`/`init`/`describe` | All speculate on structure `defineDocument` doesn't guarantee.                                                                                      |
| Keep `auth`                                 | Yes                                                   | Interactive browser flows can't be self-serviced in a `.ts` import.                                                                                 |
| Export convention                           | Users export **opened handles**, not factories        | Factory needs an id to open; handle has `.ydoc` walkable via prototype, refcount already incremented, sync already connected.                        |
| `loadConfig` return shape                   | `{ configDir, entries: [{ name, handle }], dispose() }` | Export name is the dot-path root; `dispose()` rolls up per-handle teardown for clean CLI exit.                                                      |
| Duck-type shape                             | `'ydoc' in handle && Symbol.dispose in handle && typeof handle.dispose === 'function'` | Matches `DocumentHandle` contract. No `id` check (bundles don't have one); no `tables` check.                                                       |
| Walking a handle for actions                | `iterateActions(Object.getPrototypeOf(handle))`       | The bundle is the prototype; the handle's own keys are just `dispose`/`[Symbol.dispose]`. `iterateActions` uses `Object.entries`, won't see proto.  |
| Args parsing                                | `typeboxToYargsOptions` for flat schemas              | Already exists and used by current `run.ts`.                                                                                                        |
| Complex input escape hatch                  | Reuse `parseJsonInput`: positional / `--file` / stdin | Already implemented in `util/parse-input.ts`.                                                                                                       |
| Output format                               | Default JSON; `--format jsonl` for arrays              | Already built in `format-output.ts`.                                                                                                                |
| `util/command.ts` fate                      | Delete entirely                                        | Every helper in it dies or doesn't fit the new commands. Inline whatever each surviving command needs.                                              |
| Lifecycle pattern per command               | Each command inlines `loadConfig()` + try/finally + `result.dispose()` | Only 3 commands; centralized helper (`runCommand`) obscures control flow.                                                                           |
| Primitive reorganization                    | None                                                  | `createSessionStore`, `createAuthApi`, `EPICENTER_PATHS`, `loadConfig` already at package root. No `primitives/` directory. |
| `attachCliUnlock` location                  | `packages/cli/src/attach-cli-unlock.ts` (root)         | Small, visible, exported from `index.ts`. Under 5 primitives total: no subdirectory needed.                                                        |
| Backwards compat                            | None                                                  | All consumers in-repo or on the same migration cadence. Dual-shape CLI is worse than brief breakage.                                                |
| Attach primitives' CLI exposure             | Wrap public methods in `defineQuery`/`defineMutation` | Separate workstream (Phase 5); coordinate with attach primitive owners.                                                                             |

---

## Architecture

### Before → After (binary surface)

```
BEFORE (11 commands, most broken post-migration)
═══════════════════════════════════════════════════════════════

epicenter
├── auth { login, logout, status }   ← keep
├── start                              ← delete
├── get <table> <id>                   ← delete
├── list <table>                       ← delete
├── count <table>                      ← delete
├── delete <table> <id>                ← delete
├── tables                             ← delete
├── kv { get, set, delete }            ← delete
├── export                             ← delete
├── init                               ← delete
├── run <action>                       ← rewrite
├── size                               ← delete
└── rpc                                ← delete


AFTER (3 commands + auth group)
═══════════════════════════════════════════════════════════════

epicenter
├── auth
│   ├── login --server <url>
│   ├── logout [--server <url>]
│   └── status [--server <url>]
├── list [dot.path]                    ← NEW: tree of exposed actions
└── run <dot.path> [args...]           ← rewrite: invoke action node
```

### Before → After (source tree)

```
BEFORE                               AFTER (clean break)
══════════════════════════           ══════════════════════════
packages/cli/src/                    packages/cli/src/
├── bin.ts                           ├── bin.ts                  (unchanged)
├── cli.ts                           ├── cli.ts                  (3 commands only)
├── cli.test.ts                      ├── cli.test.ts             (rewritten)
├── index.ts                         ├── index.ts                (+ attachCliUnlock)
├── load-config.ts                   ├── load-config.ts          (handle duck-type, dispose())
├── paths.ts                         ├── paths.ts                (unchanged)
├── README.md                        ├── README.md               (rewritten)
├── attach-cli-unlock.ts  ← NEW      ├── attach-cli-unlock.ts    ← NEW primitive
├── auth/                            ├── auth/
│   ├── api.ts                       │   ├── api.ts              (unchanged)
│   └── store.ts                     │   └── store.ts            (unchanged)
├── commands/                        ├── commands/
│   ├── auth.ts                      │   ├── auth.ts             (unchanged)
│   ├── data.ts       ← DELETE       │   ├── list.ts             ← NEW
│   ├── kv.ts         ← DELETE       │   └── run.ts              (rewritten)
│   ├── project.ts    ← DELETE       ├── util/
│   ├── rpc.ts        ← DELETE       │   ├── discover-actions.ts ← NEW
│   ├── run.ts        (rewrite)      │   ├── format-output.ts    (unchanged)
│   ├── size.ts       ← DELETE       │   ├── parse-input.ts      (unchanged; used by run)
│   └── start.ts      ← DELETE       │   └── typebox-to-yargs.ts (unchanged)
└── util/
    ├── command.ts    ← DELETE       DELETE ENTIRELY:
    ├── format-output.ts             ├── commands/data.ts
    ├── parse-input.ts               ├── commands/kv.ts
    └── typebox-to-yargs.ts          ├── commands/project.ts
                                     ├── commands/rpc.ts
                                     ├── commands/size.ts
                                     ├── commands/start.ts
                                     └── util/command.ts
```

### Data flow: `epicenter run tabManager.savedTabs.create --title "Hi" --url "..."`

```
STEP 1: Parse argv (permissive)
───────────────────────────────
  Yargs with .strict(false): schema unknown until path resolves.
  → { _: ['run', 'tabManager.savedTabs.create'], title: 'Hi', url: '...' }


STEP 2: Load config
───────────────────
  const { entries, dispose } = await loadConfig(cwd);
  //   entries: [{ name: 'tabManager', handle: DocumentHandle }, ...]
  //   dispose: async () => { for each handle: handle.dispose() + await whenDisposed }
  //
  // Side effect: importing epicenter.config.ts executes every .open(id),
  // which boots sync, persistence, etc. This is ACCEPTED COST.


STEP 3: Resolve export name
───────────────────────────
  const [exportName, ...rest] = 'tabManager.savedTabs.create'.split('.');
  const entry = entries.find(e => e.name === exportName);
  if (!entry) throw `No export named "${exportName}" in epicenter.config.ts`;


STEP 4: Walk the bundle (via prototype)
───────────────────────────────────────
  const bundle = Object.getPrototypeOf(entry.handle);  // skip own dispose/[Symbol.dispose]
  let node: unknown = bundle;
  for (const seg of rest) node = (node as any)?.[seg];


STEP 5: Assert action node
──────────────────────────
  if (!isAction(node)) {
    // Helpful error: enumerate sibling actions at the parent path.
    throw new Error(`"${path}" is not a runnable action. Did you mean: ...`);
  }


STEP 6: Parse input from schema
───────────────────────────────
  let input: unknown;
  if (argv.input || argv.file || !process.stdin.isTTY) {
    // Use parseJsonInput for complex shapes (file/stdin/positional @file).
    input = parseJsonInput({...});
  } else if (node.input) {
    // Use typeboxToYargsOptions + argv for flat schemas.
    input = extractFromArgv(argv, typeboxToYargsOptions(node.input));
  }


STEP 7: Invoke
──────────────
  try {
    const result = node.input ? await node(input) : await node();
    output(result, { format: argv.format });
  } finally {
    await dispose();
  }
```

### Data flow: `epicenter list tabManager.savedTabs`

```
STEP 1: Parse argv → path parts
STEP 2: loadConfig → { entries, dispose }
STEP 3: Resolve path:
  - path.length === 0 → walk all entries
  - path[0] → find entry by export name; walk subtree from that point
  - path lands on an action → render action detail (help-style)
  - path lands on an object with actions beneath → render subtree
  - path lands on a non-action, non-object → error
STEP 4: Call discoverActions(bundle, subpath) → list of { path[], action }
STEP 5: Render tree (ASCII with ├── and └──, grouped by export name)
STEP 6: await dispose()
```

### The three worlds share one primitive

```
                    ┌──────────────────────────┐
                    │  defineQuery/Mutation    │
                    │  @epicenter/workspace    │
                    └────────────┬─────────────┘
                                 │ same branded nodes
                   ┌─────────────┼─────────────┐
                   ▼             ▼             ▼
           ┌──────────┐   ┌────────────┐  ┌──────────┐
           │   UI     │   │  AI Tools  │  │   CLI    │
           │ TanStack │   │ tool-      │  │ run/list │
           │ Query    │   │ bridge.ts  │  │          │
           └──────────┘   └────────────┘  └──────────┘
```

Author once, three surfaces pick it up. This spec completes the CLI side.

---

## The new CLI commands in detail

### `epicenter list [dot.path]`

**No argument**: enumerate all exports, render full trees:

```
$ epicenter list

tabManager
├── savedTabs
│   ├── list     (query)     List all saved tabs
│   ├── get      (query)     Get a saved tab by id
│   ├── create   (mutation)  Save a new tab
│   └── delete   (mutation)  Delete a saved tab
├── bookmarks
│   ├── list     (query)
│   └── create   (mutation)
└── devices
    └── list     (query)

fuji
└── entries
    ├── list     (query)     List all journal entries
    ├── create   (mutation)  Create a new entry
    └── search   (query)     FTS5 full-text search
```

**Partial path**: subtree:

```
$ epicenter list tabManager.savedTabs

tabManager.savedTabs
├── list     (query)     List all saved tabs
├── get      (query)     Get a saved tab by id
├── create   (mutation)  Save a new tab
└── delete   (mutation)  Delete a saved tab
```

**Leaf path**: action detail (inline `--help`):

```
$ epicenter list tabManager.savedTabs.create

tabManager.savedTabs.create  (mutation)

  Save a new tab

  Arguments:
    --title <string>         required
    --url <string>           required
    --tags <string...>       optional   repeatable
    --note <string>          optional
```

### `epicenter run <dot.path> [args...]`

```
$ epicenter run tabManager.savedTabs.list
[
  { "id": "abc", "title": "Hacker News", "url": "https://news.ycombinator.com" },
  ...
]

$ epicenter run tabManager.savedTabs.create --title "Hi" --url "https://..."
{ "id": "xyz789" }

$ epicenter run tabManager.savedTabs.create @payload.json
{ "id": "xyz789" }

$ cat payload.json | epicenter run tabManager.savedTabs.create
{ "id": "xyz789" }

$ epicenter run tabManager.savedTabs
Error: "tabManager.savedTabs" is not a runnable action.

Exposed actions at this path:
  tabManager.savedTabs.list     (query)
  tabManager.savedTabs.get      (query)
  tabManager.savedTabs.create   (mutation)
  tabManager.savedTabs.delete   (mutation)
```

### `epicenter auth *` (unchanged)

Already works. No code changes.

---

## Clean-break `epicenter.config.ts` target shape

This is what users write. Reference for anyone migrating an existing config.

```ts
// epicenter.config.ts
import * as Y from 'yjs';
import {
  defineDocument,
  attachTables,
  attachKv,
  attachEncryption,
  defineTable,
  defineKv,
} from '@epicenter/workspace';
import {
  attachCliUnlock,
  createSessionStore,
  EPICENTER_PATHS,
} from '@epicenter/cli';
import { attachWebsocketSync } from '@epicenter/workspace/extensions/sync/websocket';
import { attachSqlitePersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { type } from 'arktype';

const SERVER_URL = 'https://api.epicenter.so';
const sessions = createSessionStore();

const SavedTab = defineTable(type({ id: 'string', title: 'string', url: 'string', _v: '1' }));
const Bookmark = defineTable(type({ id: 'string', title: 'string', url: 'string', _v: '1' }));

const tabManagerFactory = defineDocument(
  (id) => {
    const ydoc = new Y.Doc({ guid: id });

    const persistence = attachSqlitePersistence(ydoc, {
      filePath: EPICENTER_PATHS.persistence(id),
    });
    const unlock = attachCliUnlock(ydoc, { sessions, serverUrl: SERVER_URL });
    const sync = attachWebsocketSync(ydoc, {
      url: `${SERVER_URL}/workspaces/${id}`,
      getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
    });

    const tables = attachTables(ydoc, { savedTabs: SavedTab, bookmarks: Bookmark });

    return {
      ydoc,
      tables,
      // optionally attach kv, awareness, etc.
      whenReady: Promise.all([persistence.whenLoaded, sync.whenConnected]).then(() => {}),
      whenDisposed: Promise.all([
        persistence.whenDisposed,
        sync.whenDisposed,
        unlock.whenDisposed,
      ]).then(() => {}),
      [Symbol.dispose]() { ydoc.destroy(); },
    };
  },
);

// Export the OPENED HANDLE. This is what scripts and the CLI consume.
export const tabManager = tabManagerFactory.open('epicenter.tab-manager');
```

And a user script:

```ts
// scripts/export-tabs.ts
import { tabManager } from '../epicenter.config';
import { writeFile } from 'node:fs/promises';

try {
  await tabManager.whenReady;
  const tabs = await tabManager.tables.savedTabs.list();
  await writeFile('./tabs.json', JSON.stringify(tabs, null, 2));
  console.log(`Exported ${tabs.length} tabs.`);
} finally {
  tabManager.dispose();
}
```

Run: `bun run scripts/export-tabs.ts`. No CLI involved.

---

## Implementation Plan

### Phase 0: Verify shapes and coordinate

- [ ] **0.1** Grep `packages/workspace/src/` and confirm `DocumentBundle` contract matches what this spec asserts (ydoc, `[Symbol.dispose]`, optional `whenReady`/`whenDisposed`). **Done in spec research. Re-verify before code.**
- [ ] **0.2** Coordinate with `specs/20260421T140000-encryption-primitive-refactor.md` owner on `attachEncryption` signature. `attachCliUnlock` is a thin wrapper: it must match.
- [ ] **0.3** Decide `attachTable`/`attachKv` exposure convention (see Phase 5). If defer, document `list` will render empty trees until wrappers land.

### Phase 1: Gut the dead surface

- [ ] **1.1** Delete `commands/data.ts`, `commands/kv.ts`, `commands/project.ts`, `commands/rpc.ts`, `commands/size.ts`, `commands/start.ts`.
- [ ] **1.2** Delete `util/command.ts` entirely. Its consumers are the commands we just deleted.
- [ ] **1.3** Remove deleted command registrations from `cli.ts`. Only `auth` remains pre-rewrite.
- [ ] **1.4** Rewrite `cli.test.ts`: delete stale docstring; test the 3 surviving commands.
- [ ] **1.5** `bun test packages/cli`: expect some tests deleted, remaining tests pass. Fix only the tests that test surviving behavior; delete the rest.

### Phase 2: Rewrite `load-config.ts`

- [ ] **2.1** Change the duck-type to `isDocumentHandle(value)`:
  ```ts
  function isDocumentHandle(v: unknown): v is DocumentHandle<DocumentBundle> {
    if (v == null || typeof v !== 'object') return false;
    const r = v as Record<string | symbol, unknown>;
    return (
      'ydoc' in r &&
      typeof r.dispose === 'function' &&
      Symbol.dispose in r
    );
  }
  ```
- [ ] **2.2** Change `LoadConfigResult`:
  ```ts
  type LoadConfigResult = {
    configDir: string;
    entries: { name: string; handle: DocumentHandle<DocumentBundle> }[];
    dispose(): Promise<void>;
  };
  ```
  `dispose()` iterates entries, calls `.dispose()` on each, awaits `whenDisposed` if present.
- [ ] **2.3** Update error hints to reference `defineDocument` + `.open(id)`, not `createWorkspace`.
- [ ] **2.4** Import `DocumentBundle`, `DocumentHandle` types from `@epicenter/workspace`.

### Phase 3: Rewrite `commands/run.ts`

- [ ] **3.1** Load config; try/finally around `dispose()`.
- [ ] **3.2** Split dot-path: `path[0]` = export name → find entry; rest = walk into bundle.
- [ ] **3.3** `const bundle = Object.getPrototypeOf(entry.handle)` then walk properties by path.
- [ ] **3.4** Assert `isAction(node)`. On failure, use `discoverActions` to suggest siblings.
- [ ] **3.5** If `node.input` exists, parse flags via `typeboxToYargsOptions`. Add escape hatch: positional `@file.json` or stdin handled by `parseJsonInput`.
- [ ] **3.6** Invoke, output, dispose.
- [ ] **3.7** E2E test against a fixture config that exports a handle.

### Phase 4: New `commands/list.ts`

- [ ] **4.1** Create `util/discover-actions.ts`:
  ```ts
  export function discoverActions(
    root: unknown,
  ): Array<{ path: string[]; action: Action }> {
    if (root == null || typeof root !== 'object') return [];
    return [...iterateActions(root as Record<string, unknown>)].map(
      ([action, path]) => ({ action, path }),
    );
  }
  ```
- [ ] **4.2** Create `commands/list.ts`. Three render modes:
  - No subpath → group by entry name, render each entry's full tree.
  - Partial path → resolve to subtree, render.
  - Leaf (action) → render action detail with TypeBox-derived flag help.
- [ ] **4.3** ASCII renderer: prefix-based tree (`├──`/`└──`/`│   `).
- [ ] **4.4** Register in `cli.ts`.
- [ ] **4.5** Snapshot-test output against fixture config.

### Phase 5: `attachCliUnlock` + attach-primitive exposure

**Update (2026-04-22):** Shipped as `attachSessionUnlock` in `packages/cli/src/primitives/attach-session-unlock.ts`. The encryption refactor (`20260421T140000`) completed first; this primitive is a thin consumer of `attachEncryption` + the session store.

- [x] **5.1** Create `attachSessionUnlock`: shipped.
- [x] **5.2** Export from `packages/cli/src/index.ts` via `src/primitives/index.ts`: shipped.
- [x] **5.3** ~~Audit `attachTable` and wrap public methods in `defineQuery`/`defineMutation`.~~ **Designed out (2026-04-22).** See "Why no auto-expose" below.
- [x] **5.4** ~~Document that attach primitives MUST wrap CLI-exposable methods.~~ Superseded: users wrap their own. See CLI README "Exposing operations via CLI."

#### Why no auto-expose of `attachTable` / `attachKv` methods

After working through the design, the auto-expose direction loses to hand-rolled wraps. The reasoning:

1. **Positional vs. single-object input mismatch.** `table.get(id: string)` takes a positional string; `defineQuery`'s action contract is `(input: Static<TSchema>) => TOutput`: a single input object. Branding the existing Table methods in place would break every existing in-process caller that does `table.get(id)`. Changing the Table API to action-shaped (`table.get({id})`) is a 7-app breaking change. Ruled out.

2. **Wrapping layer vs. brand-at-source.** The alternative: a `tableActions(table)` helper that returns action-shaped wrappers around Table methods: is a wrap layer. It adds a second API surface (`tables.savedTabs.get(id)` for in-process, `actions.savedTabs.get({id})` for CLI) that can drift. One helper for every app when most CLI usage is debug/inspection operations that users want to hand-pick anyway.

3. **Curated exposure beats default exposure.** `epicenter run` is most valuable for purpose-built debug/inspection/admin actions (e.g., `tabManager.importBackup`, `tabManager.savedTabs.clearOrphans`). Users write those as `defineQuery`/`defineMutation` blocks deliberately. Auto-exposing all of CRUD (`list`, `get`, `count`, `has`, `upsert`, `update`, `delete`, `clear`) puts methods in the CLI tree that nobody asked for. The curated-by-default alternative (expose only some methods) is a design decision the framework can't make well: "which methods get the CLI treatment" is app-specific.

4. **Scripts cover the power-user case.** Anyone who wants bulk CRUD or arbitrary logic writes a `scripts/*.ts` file that imports the config and uses the full Table API directly. No CLI needed. Auto-exposing CRUD via CLI duplicates capability that scripts already provide better.

The honest conclusion: **the CLI runs user-authored branded actions; it does not generate them.** Users who want CLI access to an operation wrap it themselves. This keeps the framework minimal, the CLI surface intentional, and the Table API unchanged.

Documentation for this lives in `packages/cli/README.md` under "Exposing operations via CLI."

#### Design decision: always-prefix, no default-export shorthand

`epicenter run` paths always start with a named export from `epicenter.config.ts`. There is no default-export shorthand that would let a single-workspace config omit the prefix.

Considered and rejected: allowing `export default handle` to make CLI paths address its contents directly (e.g., `epicenter run savedTabs.list` instead of `epicenter run tabManager.savedTabs.list`). The reasons:

1. **Upgrade-path fragility.** A single-workspace config that uses `export default` works fine until the user adds a second workspace. Then either (a) they keep default + add named exports → two addressing conventions in the same config, or (b) they convert default to named → every existing CLI path, script, doc, and CI job silently invalidated with no deprecation. Named-exports-only means day-1 path is identical to day-180 path.

2. **Framework-config precedent doesn't apply.** Vite, Astro, Next, and Svelte use default-export because their config objects are single-instance by design. An Epicenter config is a manifest of workspaces: plural is first-class. The closer precedents are Drizzle schemas and tRPC routers, both of which use named exports exclusively.

3. **The "prefix is ceremony" complaint resolves to naming choice.** Users who want short paths can pick short export names (`tm`, `w`). The framework isn't forcing verbosity; it's making the addressing rule uniform.

This is additive-compatible: if real demand shows up later, default-export shorthand can be introduced as an opt-in without breaking existing configs. Defaulting to the conservative, uniform rule now.

### Phase 6: Consumer migration

- [ ] **6.1** Rewrite `~/Code/vault/epicenter.config.ts` to the new shape. Use as smoke test.
  - *Status:* Outside this workspace. Track in the vault repo; not gating this spec.
- [x] **6.2** ~~Delete or rewrite `playground/*/epicenter.config.ts` files: they reference `createCliUnlock` and the old builder API.~~
  - *Shipped:* Both `playground/tab-manager-e2e/epicenter.config.ts` and `playground/opensidian-e2e/epicenter.config.ts` already migrated to `defineDocument` + `attachSessionUnlock` + encrypted-attach primitives. Stale `epicenter start` / `epicenter get files` / `epicenter describe` command references in docstrings + `playground/opensidian-e2e/README.md` cleaned up separately.
- [x] **6.3** ~~Update `apps/whispering` if it consumes `@epicenter/cli` primitives.~~
  - *Non-task:* grep confirms `apps/whispering` does not import from `@epicenter/cli`. Nothing to migrate.
- [x] **6.4** ~~Rewrite `packages/cli/README.md` for the three-command + scripting model.~~
  - *Shipped:* `eaff7ed5 docs(cli,skills): close auto-expose + always-prefix design decisions`. README now documents the three-command surface, the "expose operations via CLI" manual pattern, and the naming conventions.

#### Known stragglers outside Phase 6 scope

Grep turned up widespread `defineWorkspace` / `createWorkspace` references in historical articles:

- `packages/workspace/docs/articles/*` (3 files)
- `packages/workspace/docs/architecture/action-dispatch.md`
- `apps/landing/src/content/blog/second-brain-infrastructure.md` (published marketing content)
- `docs/articles/*`: several including `20251001T180000-plugins-to-workspaces.md` (ironically about the `definePlugin` → `defineWorkspace` rename, now both dead) and `20260127T120000-static-workspace-api-guide.md` (full guide to removed APIs)

These are point-in-time narrative: dated filenames, historical record of design decisions. Rewriting erases context; deleting erases history. Left as a separate batch decision: keep as-is (dates in filenames let readers infer period), add banners, archive to `docs/articles/archived/`, or delete case-by-case.

---

## Edge Cases

### Config exports a factory instead of an opened handle

1. `loadConfig`'s duck-type rejects factories (no `.ydoc`, no `[Symbol.dispose]` at top level).
2. `epicenter list` / `run` error: "`<name>` looks like a `defineDocument` factory, not an opened handle. Export `<name>Factory.open('your-id')` instead."
3. Helpful but explicit: consumers see exactly what to change.

### Config exports zero handles

1. `loadConfig` throws "No workspace handles found in epicenter.config.ts" with a template snippet.

### Config has multiple handles with the same export name

1. `export const tabManager = ...; export { tabManager };`: JS collapses to one. Not a real case.
2. If re-exports do somehow produce duplicates, first-wins. Document.

### Action thrown during invocation

1. Error bubbles out of `run`'s handler. CLI catches, prints message, exits with code 1.
2. `finally` block still calls `dispose()` to release the handle cleanly.
3. Stack traces only shown with `--verbose` (stretch goal).

### `iterateActions` doesn't see prototype-chained properties

1. Handle keys are `dispose`, `[Symbol.dispose]` only (own props); everything else is on the bundle (prototype).
2. `discoverActions(handle)` would return `[]`.
3. **Fix**: `discoverActions(Object.getPrototypeOf(handle))`: pass the bundle, not the handle.
4. This is a critical implementation detail; test for it explicitly.

### Action node happens to be a plain object with more actions underneath

1. `iterateActions` yields the outer action and does NOT descend into it (because it's callable; `isAction(value)` returns true at the first branded node).
2. Inner actions would be hidden. Design convention: keep nested exposable groups as siblings, not children of actions. Document.

### User script doesn't call `handle.dispose()`

1. Handle's refcount stays at 1 until process exit.
2. On exit, OS reaps the process; sync websockets close, persistence flushes via `ydoc.destroy()` on its teardown hooks.
3. Acceptable for scripts. Long-running services should use `using` or explicit dispose.

### Flag name collides with yargs built-ins (`--help`, `--version`)

1. TypeBox schema has `{ help: string }`. Yargs intercepts `--help`.
2. **Workaround**: use `--file` / stdin / positional `@file.json` via `parseJsonInput`.
3. Document this limitation.

### `list` output piped to non-TTY

1. `format-output.ts` already toggles pretty/compact based on `process.stdout.isTTY`.
2. For `list`, we always render ASCII trees regardless of TTY: it's human output, not data. Use `--format json` explicitly if machine consumption is needed.

---

## Open Questions

1. **`whenReady` awaiting in `list` vs `run`.**
   - `run` obviously needs `await handle.whenReady` before invoking actions against possibly-unready data.
   - `list` only inspects shape: does it need `whenReady`? No, probably. But importing the config triggers `.open()` which starts sync; we can't avoid the network either way.
   - **Recommendation**: `run` awaits, `list` doesn't. Document both.

2. **Output format defaults.**
   - `run` returning an array → JSON array vs JSONL?
   - `list` → always ASCII tree (not JSON)?
   - **Recommendation**: `run` defaults to JSON (pretty on TTY, compact on pipe), `--format jsonl` to opt in. `list` always prints ASCII; `--format json` opts in to a JSON dump of `{ path, type, input, description }[]`.

3. **Does `dev`/`start` survive in any form?**
   - Config already self-loads; scripts already long-run. Is there a category of use that neither covers?
   - **Recommendation**: delete for now. If users report needing "keep my workspace open for N hours to sync," re-add as `epicenter watch` taking a path argument that resolves to an opened handle.

4. **Does `init` survive?**
   - A template copier is genuinely useful for onboarding.
   - **Recommendation**: defer. `bun create epicenter-app` is the right idiom later. Delete `commands/project.ts` now.

5. **What happens to `describeWorkspace()` in `packages/workspace`?**
   - It's exported (per earlier research). With `commands/describe.ts` already deleted, does anything still consume it? Check AI bridge, server adapter.
   - **Recommendation**: if nothing consumes it, deprecate in a follow-up. `epicenter list` is the CLI-shaped replacement but not a full substitute (it renders human-friendly; `describeWorkspace` returns a data structure).

6. **Should `run` accept flags BEFORE path (`epicenter run --format json foo.bar`) or AFTER (`epicenter run foo.bar --format json`)?**
   - Yargs accepts both by default. Keep both; document the canonical (after) in help.

7. **The "config boots the world on import" side effect.**
   - Every `epicenter list` invocation does a full sync connect + persistence open + key unlock. Slow for large docs.
   - Options: (a) accept (simplest), (b) add an `--offline` flag that... does what? `.open()` is already synchronous construction; sync is async but doesn't block list.
   - **Recommendation**: accept. If slowness becomes a real problem, add an env var `EPICENTER_OFFLINE=1` that attach primitives honor by skipping network.

8. **Error handling idiom: wellcrafted Result or throw?**
   - `packages/cli` already uses `trySync`/`tryAsync` from wellcrafted in places (`bin.ts:8`, `util/parse-input.ts`).
   - **Recommendation**: use `Result` internally where it clarifies control flow (e.g., `parseJsonInput`); throw at command boundaries where yargs' error handling catches. Match existing patterns per file.

---

## Success Criteria

- [ ] `bun test packages/cli` passes.
- [ ] `epicenter list` against a vault-style config shows every `defineQuery`/`defineMutation` node grouped by export.
- [ ] `epicenter run tabManager.savedTabs.list` returns real data and exits 0.
- [ ] `epicenter run tabManager.savedTabs.create --title X --url Y` succeeds, and the new row is visible in a subsequent `list`-based query.
- [ ] A hand-written `.ts` script that imports `epicenter.config.ts` and calls actions via the handle works under `bun run`.
- [ ] `packages/cli/src/util/command.ts` no longer exists.
- [ ] `packages/cli/src/commands/` contains exactly three files: `auth.ts`, `list.ts`, `run.ts`.
- [ ] `isDocumentHandle` accepts a handle from `factory.open(id)` and rejects a bare factory.
- [ ] `packages/cli/README.md` documents the three-command + scripting model.

---

## Clean-break API: if I designed it from scratch

With what I now know from grounding against the repo:

```ts
// @epicenter/cli public API

// Session primitive: keep
export { createSessionStore, type AuthSession } from './auth/store';

// Auth API: keep
export { createAuthApi, type AuthApi } from './auth/api';

// Paths: keep
export { EPICENTER_PATHS } from './paths';

// Config loader: new shape
export { loadConfig, type LoadConfigResult } from './load-config';
// LoadConfigResult = { configDir, entries: { name, handle }[], dispose(): Promise<void> }

// The one genuinely new primitive
export { attachCliUnlock } from './attach-cli-unlock';

// Binary entry
export { createCLI } from './cli';
```

```ts
// epicenter.config.ts (user code)

const factory = defineDocument((id) => ({
  ydoc: new Y.Doc({ guid: id }),
  tables: attachTables(ydoc, { ... }),
  whenReady: Promise.all([...]),
  whenDisposed: Promise.all([...]),
  [Symbol.dispose]() { ydoc.destroy(); },
}));

// Export the opened handle: this is what every consumer reads.
export const notes = factory.open('notes');
```

```ts
// scripts/anything.ts (user code)

import { notes } from '../epicenter.config';
try {
  await notes.whenReady;
  // ... do anything, use notes.tables / notes.kv / notes.ydoc ...
} finally {
  notes.dispose();
}
```

```
# binary surface
$ epicenter auth login --server <url>
$ epicenter auth logout
$ epicenter auth status
$ epicenter list [dot.path]
$ epicenter run <dot.path> [--flags | @file.json | stdin]
```

Four primitives shipped from `@epicenter/cli` (session store, auth API, paths, CLI unlock). One factory. One loader. Three commands. That's the whole thing.

---

## References

### Read to understand the primitive

- `packages/workspace/src/document/define-document.ts:1-424`: the whole factory-cache design, `DocumentBundle` contract, `DocumentHandle` semantics
- `packages/workspace/src/shared/actions.ts:270-428`: `defineQuery`/`defineMutation`/`isAction`/`iterateActions`
- `packages/workspace/src/index.ts`: public surface; grep this to see what's actually exported

### Files to rewrite

- `packages/cli/src/load-config.ts`: duck-type + result shape
- `packages/cli/src/commands/run.ts`: handle-aware dispatch, reuse `parseJsonInput`
- `packages/cli/src/cli.ts`: shrink command registry
- `packages/cli/src/cli.test.ts`: new surface
- `packages/cli/README.md`: rewrite for 3-command + scripting model

### Files to create

- `packages/cli/src/commands/list.ts`: new command
- `packages/cli/src/util/discover-actions.ts`: thin wrapper over `iterateActions`
- `packages/cli/src/attach-cli-unlock.ts`: new primitive (coordinate with encryption refactor)

### Files to delete

- `packages/cli/src/commands/data.ts`
- `packages/cli/src/commands/kv.ts`
- `packages/cli/src/commands/project.ts`
- `packages/cli/src/commands/rpc.ts`
- `packages/cli/src/commands/size.ts`
- `packages/cli/src/commands/start.ts`
- `packages/cli/src/util/command.ts`

### Files to keep unchanged

- `packages/cli/src/bin.ts`
- `packages/cli/src/paths.ts`
- `packages/cli/src/index.ts` (add one export for `attachCliUnlock`)
- `packages/cli/src/auth/api.ts`
- `packages/cli/src/auth/store.ts`
- `packages/cli/src/commands/auth.ts`
- `packages/cli/src/util/format-output.ts`
- `packages/cli/src/util/parse-input.ts`
- `packages/cli/src/util/typebox-to-yargs.ts`

### Related specs

- `specs/20260420T152026-definedocument-primitive.md`
- `specs/20260421T000000-inline-content-doc-factories.md`
- `specs/20260421T170000-collapse-document-and-workspace-primitives.md`
- `specs/20260421T170000-merge-document-into-workspace.md`
- `specs/20260421T140000-encryption-primitive-refactor.md` ← coordination point for `attachCliUnlock`

### Consumers to migrate

- `~/Code/vault/epicenter.config.ts`
- `playground/tab-manager-e2e/epicenter.config.ts`
- `playground/opensidian-e2e/epicenter.config.ts`
