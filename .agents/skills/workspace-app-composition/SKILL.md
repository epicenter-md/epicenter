---
name: workspace-app-composition
description: 'How a workspace-backed app under `apps/*` is composed: the isomorphic doc factory (`create<App>`), the environment factories (`open<App>Browser` / `open<App>Extension` / tauri) with the one boot call (`connect(toConnection(auth, nodeId))`, ADR-0088/ADR-0094), the `#platform/*` build-time platform DI for multi-platform (Tauri) apps, the workspace singleton, the sign-in migration wiring, daemon/script placement under per-project `workspaces/<app>/`, and the file layout itself. Use when creating a new app, naming or placing the iso/browser/extension factory, wiring `#platform/*` subpath imports for a Tauri seam, placing the workspace singleton, wiring the first-sign-in migration, registering daemon/script bindings, or gating first paint on local storage hydration (load gate vs WorkspaceGate).'
metadata:
  author: epicenter
  version: '6.0'
---

# Workspace App Layout

A workspace app is composed in layers: a pure isomorphic doc factory, one or
more environment factories that bind it to a runtime (browser, Chrome
extension, Tauri), a single side-effectful workspace singleton, and (for
multi-platform apps) a build-time platform DI seam. Daemon and script bindings
do not live in the app package at all; they live per-project under
`workspaces/<app>/` and are registered through `epicenter.config.ts`.

There is ONE composition shape (ADR-0088: sign-in is an enhancement, never a
door). Every app boots into a working local workspace with one call;
`toConnection` reads the persisted `auth.state` once and projects it to the
connection (signed in) or `null` (signed out, bare local wiring, ADR-0094).
Storage is an environment concern: browser apps use the default IndexedDB
local persistence, while Bun hosts inject `bunLocalPersistence({ dir, nodeId })`
through `connect(null, { persistence })` (ADR-0095).

```ts
model.connect(toConnection(auth, nodeId), compose);
```

The workspace is never `null`, no route gates on identity, and an owner change
reloads the page (`reloadOnOwnerChange`) so the next boot re-projects.
When a schema needs a per-platform argument, the model is a factory
`define<App>(args)`: the id and tables stay fixed, and only defaults or other
read-side schema inputs vary.

## File Layout

Two layouts ship today. Older single-platform apps keep the composition files
flat at the package root; apps preparing for multi-platform builds nest the
same files under `src/lib/workspace/` and add a `src/lib/platform/` seam.

**Flat root** (opensidian, vocab):

```txt
apps/<app>/
|- <app>.ts                  iso schema + workspace model            (package "." export)
|- <app>.browser.ts          browser env factory open<App>Browser()  (the preset branch)
|- <app>.test.ts             tests
|- mount.ts                  optional mount factory <app>()          (package "./mount" export)
`- src/lib/
   |- <app>.ts               the workspace singleton
   |- migration/sign-in-migration.ts   first-sign-in migration wiring
   `- platform/auth/         auth client construction
```

**Nested under `src/lib/workspace/`** (honeycrisp, whispering):

```txt
apps/<app>/
|- package.json              "imports" map declares the #platform/* seams
`- src/lib/
   |- workspace/
   |  |- index.ts            iso schema + workspace model            (package "." export)
   |  |- browser.ts          browser env factory open<App>Browser()  (the preset branch)
   |  |- index.test.ts       tests
   |  `- mount.ts            optional mount factory <app>()          (package "./mount" export)
   |- <app>.ts               the workspace singleton
   |- migration/sign-in-migration.ts   first-sign-in migration wiring
   `- platform/              #platform/* impls (X.browser.ts / X.tauri.ts) + types.ts contract
```

The extension app (tab-manager) keeps its deferred boot module at
`src/lib/session.svelte.ts`: `chrome.storage` is async, so the auth client and
workspace bundle are built after a readiness promise resolves, and the module
exports a `tabManagerBoot` handle whose getters throw only before storage
readiness (never a signed-out branch).

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

| Layer | File | Job | Returns |
| --- | --- | --- | --- |
| Iso factory | `<app>.ts` / `workspace/index.ts` | `defineWorkspace({...})`: pure doc model | workspace model (`create`, `connect`, `mount`) |
| Browser factory | `<app>.browser.ts` / `workspace/browser.ts` | `open<App>Browser({ auth, nodeId })`: the one boot call | `LocalWorkspace \| ConnectedWorkspace` bundle (storage, collaboration, wipe, child-doc openers) |
| Extension / tauri factory | `<app>.extension.ts` etc. | same branch after async storage resolves | iso bundle plus runtime resources |
| Mount factory | `mount.ts` / `workspace/mount.ts` | Optional. `<app>(opts?)` calls `<app>Workspace.mount({ runtime: nodeMountRuntime(), ... })` and returns the `Mount` a project's `epicenter.config.ts` default-exports | `Mount` (node persistence, materializers) |
| Workspace singleton | `src/lib/<app>.ts` | compose the bundle with app state, alias `whenReady` | `<app>` handle, never `null` |
| Migration | `src/lib/migration/sign-in-migration.ts` | wire `createSignInMigration` (local source + words) | `signInMigration` state for the shared dialog |
| Auth | `src/lib/platform/auth/` (or `#platform/auth`) | auth client construction | `auth` |

The iso factory and browser/extension factory are pure construction surfaces.
Side effects (HMR disposal, persisted state, network) live only in the
workspace singleton module.

## Iso Factory

The iso model builds the document schema and returns the workspace model. It is
the package `.` export and the wire contract for sync: browser, daemon,
local-host, and test consumers import it when they need the shared schema.
Forking a table column shape breaks sync compatibility with peers running the
canonical schema.

Rules:

- Keep the iso factory free of `node:*`, `bun:*`, `chrome.*`, Tauri APIs,
  `y-indexeddb`, `BroadcastChannel`, and runtime singletons. It must type-check
  and run isomorphically.
- Put pure actions inline as `actions: defineActions({ ... })` in the model
  when they depend only on tables.
- Keep env-bound actions in the env factory when they need filesystem, SQLite,
  shell, or browser persistence. Extract only when the runtime action set is
  shared or owns a boundary that would be harder to read inline.

## Browser Factory

`open<App>Browser({ auth, nodeId })` is the one boot call. Both connection
arms return the same bundle shape (per-row child-doc openers and `wipe()`
included), so nothing downstream branches on auth again:

```ts
import { toConnection } from '@epicenter/svelte/auth';

export function openHoneycrispBrowser({
	auth,
	nodeId,
}: {
	auth: SyncAuthClient;
	nodeId: NodeId;
}) {
	return honeycrispWorkspace.connect(toConnection(auth, nodeId));
}
```

When the app layers a runtime composition, pass `compose` as the second
argument. An inline arrow infers its parameter; a named `compose` function
annotates it with `ComposeContext<typeof myAppWorkspace>` from
`@epicenter/workspace`, never a hand-written `Pick` or `Parameters<...>`
extraction.

## Workspace Singleton

The singleton lives in `src/lib/<app>.ts` (a plain `.ts` module). It builds
the bundle once at module load and composes app state on top; it is never
`null` and has no `require*()` accessor:

```ts
import { createNodeId } from '@epicenter/workspace';
import { auth } from '#platform/auth'; // nested apps; flat-root apps import from $lib/platform/auth
import { openHoneycrispBrowser } from './workspace/browser';

const browser = openHoneycrispBrowser({
	auth,
	nodeId: createNodeId({ storage: localStorage }),
});

export const honeycrisp = {
	...browser,
	state: createHoneycrispState(browser),
	/** Resolves when local persistence has hydrated the root doc. */
	whenReady: browser.storage.whenLoaded,
};
```

The root layout mounts `reloadOnOwnerChange(auth)` once (`onMount`), the
`WorkspaceGate`, the migration `check()`, and the shared dialogs. `AccountPopover`
is the only auth surface; there is no signed-out screen and no `(signed-in)`
route group.

`createSession` (`@epicenter/svelte/auth`) never owns a workspace lifecycle
(ADR-0088). It survives only for auxiliary signed-in-only resources whose whole
existence is tied to an identity (e.g. the vault keyring session).

## Sign-In Migration

The first signed-in boot that finds bare local rows offers the flag-free
Add / Delete / Keep dialog. The mechanics (probe, crash-safe child-doc phases,
copy-then-clear) live in `@epicenter/app-shell/sign-in-migration`; the app
supplies only `openLocalSource` (the iso model's `.create()` plus a bare
`attachIndexedDb`) and the words (`describe`, `note`, `errorNoun`):

```ts
export const signInMigration = createSignInMigration({
	auth,
	openLocalSource,
	target: honeycrisp,
	describe: describeLocalContents,
	errorNoun: 'notes',
});
```

Child-doc guids are derived from the tables returned by `openLocalSource`
(ADR-0092). Deliberately excluding a table from `openLocalSource` (e.g.
tab-manager's always-populated `devices`) excludes it from the probe, row copy,
and child-doc migration together.

## Gating Readiness on Hydration

A workspace-backed route reads empty tables until the workspace's readiness
promise resolves (`storage.whenLoaded`, aliased as `whenReady`; matter's is the
`once()`-memoized store read `ensureHydrated()`), so it flashes an empty state
("No recordings yet", "All clear"). No useful partial UI exists here, so gate
the first paint rather than skeleton it.

One rule: **gate where the readiness promise is first reachable**, decided by
where the workspace is built.

| Workspace built | Reachable in | Gate |
| --- | --- | --- |
| Eager module singleton with route loads: todos, whispering, skills, matter | a route `load` | `load`: `await x.whenReady` (matter: `ensureHydrated()`) |
| Eager module singleton, gate in the root layout: honeycrisp, vocab, opensidian | the root layout | `<WorkspaceGate pending={<app>.whenReady} onForgetDevice onSignOut>` |
| Extension entrypoint behind async storage: tab-manager | the component | outer `{#await boot.whenReady}`, then `WorkspaceGate` |

- Correctness gates (404 / redirect / param) always go in `load`; only `load`
  can `error()` / `redirect()` (matter `vault/[id]`).
- The promise must be resolve-only or the gate blocks paint forever
  (`storage.whenLoaded` is kept resolve-only by the y-indexeddb corrupt-load
  patch). Fix the promise, never add a timeout.

The blank-shell (load) vs `<Loading>` (`WorkspaceGate`) difference follows from
the boundary, not a separate choice. For the `load`-blocks-render rule ground
against `sveltejs/kit`; for the `{#await}` form see the `svelte` skill.

## Platform DI: the `#platform/*` seam

Multi-host SPAs such as Whispering select browser-vs-Epicenter implementations
at BUILD time via Node-standard `#platform/*` subpath imports. Epicenter owns
the Tauri runtime; the SPA owns both implementation leaves. This is the
canonical mechanism. It replaced the old
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
const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';
// ...
resolve: {
	// Custom conditions REPLACE Vite's defaults, so the
	// ...defaultClientConditions spread is LOAD-BEARING (drop it and all
	// dependency resolution breaks).
	...(isEpicenterSurface && {
		conditions: ['tauri', ...defaultClientConditions],
	}),
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

- Gating any route or the app shell on identity: no `(signed-in)` route
  groups, no signed-out screen, no redirect-to-sign-in. Sign-in is an
  enhancement (ADR-0088); signed-in-only features get small inline
  affordances.
- Owning a workspace lifecycle with `createSession`, or adding a `require*()`
  accessor / nullable workspace handle. The singleton is never `null`.
- Hand-rolling child-doc wiring, wipe, or migration phases in an app. The
  presets and the sign-in migration kit own them; the app supplies words and
  guid readers.
- Branching on `auth.state` anywhere except the one preset branch in the
  environment factory (and small inline feature affordances).
- Putting auth, `createPersistedState`, `auth.onStateChange`, or HMR disposal in
  the browser/extension/tauri factory. Those belong in the singleton module.
- Adding a second singleton home (`client.ts`). The singleton already lives in
  `src/lib/<app>.ts`.
- Putting auth subscriptions or workspace construction in a Svelte component.
  They belong in the singleton module.
- Forgetting `disabledReason` on `AccountPopover` when the app has an
  unsafe-to-interrupt moment (an in-flight `MediaRecorder` cannot survive the
  owner-change reload).
- Branching on platform at a `#platform/*` call site. Import the bare specifier
  and let the build select the impl.
- Using `satisfies` on a `#platform/*` impl instead of a `: Contract` annotation.
- Importing a `.tauri.ts`-only symbol through `#platform/*` (it is `null` on web);
  import it directly from the `.tauri` module inside another `.tauri.ts` file.
- Reintroducing `resolve.extensions` suffixes or tsconfig `moduleSuffixes` for
  platform selection.
- Dropping `...defaultClientConditions` from the Tauri `conditions` array.
- Adding a `./browser` package export to honeycrisp/vocab for symmetry
  with opensidian. Keep the asymmetry; only opensidian has a consumer for it.
- Adding `./mount` back to honeycrisp. Honeycrisp's integration contract is the
  package `.` isomorphic workspace export.
- Placing `daemon.ts` or `script.ts` inside the app package. They live under a
  project's `workspaces/<app>/` and are registered via `epicenter.config.ts`.
- Restoring `serve` as the public lifecycle command (it is `epicenter daemon up`).
- Load-gating where the readiness promise is not reachable, or showing a
  `<Loading>` skeleton for a fast eager-workspace gate (the spinner just
  flashes). Gate where the readiness promise is first reachable; see Gating
  Readiness on Hydration.
