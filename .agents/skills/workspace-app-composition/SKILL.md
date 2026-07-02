---
name: workspace-app-composition
description: 'How a workspace-backed app under `apps/*` is composed: the isomorphic doc factory (`create<App>`), the environment factories (`open<App>Browser` / `open<App>Extension` / tauri), the `#platform/*` build-time platform DI for multi-platform (Tauri) apps, the `session` singleton, daemon/script placement under per-project `workspaces/<app>/`, and the file layout itself. Use when creating a new app, naming or placing the iso/browser/extension factory, wiring `#platform/*` subpath imports for a Tauri seam, choosing between auth-gated (Shape A) vs module-singleton (Shape B), placing the session singleton, registering daemon/script bindings, or gating first paint on IndexedDB hydration (load gate vs WorkspaceGate).'
metadata:
  author: epicenter
  version: '5.0'
---

# Workspace App Layout

A workspace app is composed in layers: a pure isomorphic doc factory, one or
more environment factories that bind it to a runtime (browser, Chrome
extension, Tauri), a single side-effectful session singleton, and (for
multi-platform apps) a build-time platform DI seam. Daemon and script bindings
do not live in the app package at all; they live per-project under
`workspaces/<app>/` and are registered through `epicenter.config.ts`.

Two shipped shapes; pick by whether the app gates UI on signed-in identity.

**Shape A**: auth-gated SvelteKit web apps (honeycrisp, vocab). The app
is not a running thing until identity exists, so a `session` singleton owns the
workspace lifecycle and UI lives under `(signed-in)` routes.

**Shape B**: module-level singleton apps (opensidian, tab-manager, whispering).
A module singleton blocks on auth/session readiness and exports a constructed
handle.

## File Layout

Two layouts ship today. Older single-platform apps keep the composition files
flat at the package root; apps preparing for multi-platform builds nest the same
files under `src/lib/workspace/` and add a `src/lib/platform/` seam.

**Flat root** (opensidian, vocab):

```txt
apps/<app>/
|- <app>.ts                  iso schema + create<App>() factory   (package "." export)
|- <app>.browser.ts          browser env factory open<App>Browser()
|- <app>.test.ts             tests
|- mount.ts                  optional mount factory <app>()       (package "./mount" export)
`- src/lib/
   |- session.ts             the session singleton (NOT session.svelte.ts)
   `- platform/auth/         auth client construction
```

**Nested under `src/lib/workspace/`** (honeycrisp, whispering):

```txt
apps/<app>/
|- package.json              "imports" map declares the #platform/* seams
`- src/lib/
   |- workspace/
   |  |- index.ts            iso schema + create<App>() factory   (package "." export)
   |  |- browser.ts          browser env factory open<App>Browser()
   |  |- index.test.ts       tests
   |  `- mount.ts            optional mount factory <app>()       (package "./mount" export)
   |- session.ts             the session singleton
   `- platform/              #platform/* impls (X.browser.ts / X.tauri.ts) + types.ts contract
```

Honeycrisp is the Shape A nested app: it has `src/lib/session.ts`, a package
`.` export to `src/lib/workspace/index.ts`, and currently only a default
browser `#platform/auth` implementation. It has no `mount.ts` and no `./mount`
export. Whispering is Shape B: it has no `session.ts`, no `mount.ts`, no `.`
export, and many more `#platform/*` seams because audio and desktop services
earn them.

Package exports follow the file's actual owner. Flat-root apps export the iso
factory as `.`; only apps with a live daemon consumer export a mount factory as
`./mount`. Apps without a daemon mount export narrower surfaces instead:

```jsonc
// honeycrisp (nested, no mount)
"exports": {
  ".": "./src/lib/workspace/index.ts"
}

// whispering (nested, no mount): no `.` or `./mount`, since whispering isn't
// daemon-mounted.
"exports": {
  "./commands": "./src/lib/commands.ts",
  "./workspace": "./src/lib/workspace/index.ts"
}
```

Opensidian additionally exports `"./browser": "./opensidian.browser.ts"`; the
others do not export their browser factory. That asymmetry is honest, opensidian
has a consumer that needs the bare browser factory and the others do not. Do not
add a `./browser` export to the rest for symmetry's sake.

## Layers

| Layer | File | Shape | Job | Returns |
| --- | --- | --- | --- | --- |
| Iso factory | `<app>.ts` / `workspace/index.ts` | A + B | `create<App>()`: pure doc construction | workspace (`ydoc`, tables, kv, actions) |
| Browser factory | `<app>.browser.ts` / `workspace/browser.ts` | A + B | `open<App>Browser({ signedIn, nodeId })`: bind to browser persistence + sync | iso bundle plus IndexedDB/local storage, collaboration |
| Extension / tauri factory | `<app>.extension.ts` etc. | B | bind to chrome.storage / Tauri APIs | iso bundle plus runtime resources |
| Mount factory | `mount.ts` / `workspace/mount.ts` | A + B | Optional. `<app>(opts?)` calls `<app>Workspace.mount({ runtime: nodeMountRuntime(), ... })` and returns the `Mount` a project's `epicenter.config.ts` default-exports | `Mount` (node persistence, materializers) |
| Session singleton | `src/lib/session.ts` | A | `createSession({ ... })`: owns workspace lifecycle, side effects | `session`, `session.require` |
| Auth | `src/lib/platform/auth/` (or `#platform/auth`) | A | auth client construction | `auth` |

The iso factory, browser/extension factory, and mount factory are pure
construction surfaces. Side effects (auth subscriptions, HMR disposal,
persisted state, network) live only in the session singleton (`src/lib/session.ts`).

## Iso Factory

`create<App>()` builds the document and returns the workspace. It is the package
`.` export and the wire contract for sync: browser, daemon, local-host, and test
consumers import it when they need the shared schema. Forking a table column
shape breaks sync compatibility with peers running the canonical schema.

```ts
export function createHoneycrisp() {
	const workspace = createWorkspace({
		id: HONEYCRISP_ID,
		tables: { /* ... */ },
		kv: {},
	});
	return defineWorkspace({
		...workspace,
		actions: defineActions({
			// Pure workspace actions that depend only on tables.
		}),
	});
}
```

Rules:

- Keep the iso factory free of `node:*`, `bun:*`, `chrome.*`, Tauri APIs,
  `y-indexeddb`, `BroadcastChannel`, and runtime singletons. It must type-check
  and run isomorphically.
- Put pure actions inline as `actions: defineActions({ ... })` in the returned
  workspace when they depend only on tables.
- Keep env-bound actions in the env factory when they need filesystem, SQLite,
  shell, or browser persistence. Extract only when the runtime action set is
  shared or owns a boundary that would be harder to read inline.

## Browser Factory

`open<App>Browser({ signedIn, nodeId })` calls the iso factory, then attaches
local persistence and collaboration.

```ts
export function openHoneycrispBrowser({
	signedIn,
	nodeId,
}: {
	signedIn: SignedIn;
	nodeId: NodeId;
}) {
	return honeycrispWorkspace.connect({ ...signedIn, nodeId });
}
```

## Session Singleton (Shape A)

The singleton lives in `src/lib/session.ts` (a plain `.ts` module, not
`session.svelte.ts`). `createSession` owns the workspace lifecycle; the app
re-exports `session.require` under an app-specific name.

```ts
import { createSession } from '@epicenter/svelte/auth';
import { auth } from '#platform/auth'; // nested apps; flat-root apps import from $lib/platform/auth

export const session = createSession({ /* auth + build */ });
export const requireHoneycrisp = session.require;
```

This is the only home for the singleton. Do not add a `client.ts` or a second
singleton site.

## Gating Readiness on Hydration

A workspace-backed route reads empty tables until the workspace's readiness
promise resolves (`idb.whenLoaded`, exposed as `whenReady`; matter's is the
`once()`-memoized store read `ensureHydrated()`), so it flashes an empty state
("No recordings yet", "All clear"). No useful partial UI exists here, so gate
the first paint rather than skeleton it.

One rule: **gate where the readiness promise is first reachable**, decided by
where the workspace is built (NOT the Shape A/B handle label).

| Workspace built | Reachable in | Gate |
| --- | --- | --- |
| Eager module singleton, no auth gate: todos, whispering, skills, matter | a route `load` | `load`: `await x.whenReady` (matter: `ensureHydrated()`) |
| Post-auth inside a `session` (only `session.current`): honeycrisp, vocab, opensidian | the signed-in component | `<WorkspaceGate pending={session.current.idb.whenLoaded}>` |
| Extension entrypoint, no `load`: tab-manager | the component | `{#await idb.whenLoaded}` |

- Correctness gates (404 / redirect / param) always go in `load`; only `load`
  can `error()` / `redirect()` (matter `vault/[id]`).
- The promise must be resolve-only or the gate blocks paint forever
  (`whenLoaded = idb.whenSynced`, kept resolve-only by the y-indexeddb
  corrupt-load patch). Fix the promise, never add a timeout.

The blank-shell (load) vs `<Loading>` (`WorkspaceGate`) difference follows from
the boundary, not a separate choice. For the `load`-blocks-render rule ground
against `sveltejs/kit`; for the `{#await}` form see the `svelte` skill.

## Platform DI: the `#platform/*` seam

Multi-platform apps (the app with `src-tauri/`: currently whispering) select
browser-vs-Tauri implementations at BUILD time via Node-standard `#platform/*`
subpath imports. This is the canonical mechanism. It replaced the old
`resolve.extensions` / `moduleSuffixes` suffix trick (see "Why not suffixes"
below).

**1. Declare the seam in `package.json` "imports".** Each seam maps a bare
specifier to a Tauri impl and a default (browser) impl:

```jsonc
"imports": {
  "#platform/tauri": {
    "tauri": "./src/lib/platform/tauri.tauri.ts",
    "default": "./src/lib/platform/tauri.browser.ts"
  }
}
```

**2. Consume the bare specifier, with NO platform branch at the call site:**

```ts
import { tauri } from '#platform/tauri';
```

**3. The build picks the impl by condition.** The web build uses `default`
(browser). The Tauri build activates the `tauri` condition in `vite.config.ts`:

```ts
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;
// ...
resolve: {
	// Custom conditions REPLACE Vite's defaults, so the
	// ...defaultClientConditions spread is LOAD-BEARING (drop it and all
	// dependency resolution breaks).
	...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
},
```

**4. tsconfig needs nothing.** No `moduleSuffixes`, no per-target tsconfig.
Bundler `moduleResolution` reads the `imports` field and lands on `default`
(browser) for the editor and typecheck.

**5. Each seam has a shared contract.** A `types.ts` declares the contract;
both impls annotate against it with a type annotation, not `satisfies`:

```ts
// platform/types.ts
export type Tauri = { /* ... */ };

// platform/tauri.browser.ts
export const tauri: Tauri | null = null; // no native capability on web

// platform/tauri.tauri.ts
export const tauri: Tauri | null = tauriOnly;
```

Use `export const x: Contract = ...`, NOT `satisfies`. `satisfies` would leak the
concrete type and break the lockstep that keeps both variants conforming to the
same shape.

**`.tauri.ts`-only exports bypass the seam.** A symbol that only exists on Tauri
(e.g. whispering's `tauriOnly`) is imported DIRECTLY by `.tauri.ts` files (e.g.
`import { tauriOnly } from '$lib/tauri.tauri'`), not through `#platform/*`
(which resolves to `null` on web).

**The guarantee.** Because the wrong-platform file is never resolved,
`@tauri-apps/*` code is PHYSICALLY ABSENT from the web bundle (a build-time
guarantee, not Rollup tree-shaking). A Tauri-only file imported by shared code
fails the web build instead of shipping a broken runtime.

### Why not suffixes

The old mechanism put `.browser.ts` / `.tauri.ts` ahead of `.ts` in Vite
`resolve.extensions`, mirrored by tsconfig `moduleSuffixes`. That was GLOBAL:
every bare import was magic, which is why a bare `./fuji` once collided with a
`fuji.browser.ts`. The `#platform/*` mechanism is scoped to the `#platform/*`
specifiers only, so the rest of the import graph stays ordinary. Do not
reintroduce `resolve.extensions` suffixes or tsconfig `moduleSuffixes`.

## Daemon and Script Placement

Daemon and script bindings are NOT in the app package. They live per-project
under `workspaces/<app>/` (e.g. `playground/opensidian-e2e/workspaces/opensidian/daemon.ts`)
and are registered through `epicenter.config.ts` at the Epicenter root:

```ts
import { defineConfig } from '@epicenter/workspace';
import opensidian from './workspaces/opensidian/daemon.ts';

export default defineConfig({
	routes: [opensidian],
});
```

The daemon imports the app's mount factory (the `./mount` export) to construct
its `Mount`. `epicenter.config.ts` marks the Epicenter root and is the route
registry; `.epicenter/` is machine state under that root, not a discovery marker. The public
lifecycle command is `epicenter daemon up`, not `epicenter serve`.

## Anti-Patterns

- Load-gating a post-auth workspace (its `idb.whenLoaded` does not exist at
  `load` time), or showing a `<Loading>` skeleton for a fast eager-workspace gate
  (the spinner just flashes). Gate where the readiness promise is first
  reachable; see Gating Readiness on Hydration.
