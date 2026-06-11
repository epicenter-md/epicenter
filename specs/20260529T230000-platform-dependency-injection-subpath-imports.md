# Platform DI: Scoped `#platform/*` Subpath Imports Over Global Resolution

**Date**: 2026-05-29
**Status**: Implemented (commits `96c5a55c7` fuji, `3d08cf961` fuji rename, `7d7d1e5d2` whispering; docs reconciled, `workspace-app-layout` skill renamed to `workspace-app-composition`)
**Owner**: Braden
**Scope**: `apps/fuji`, `apps/whispering` (the only two platform-DI apps)

> **Landed note.** Both apps were migrated and verified (typecheck 0 errors; web build excludes `@tauri-apps`; the Tauri condition resolves the tauri variants). A parallel env-split refactor later moved fuji's schema file from the flat `fuji.ts` to `src/lib/workspace/index.ts`; the `#platform/*` DI (in `src/lib/platform/`) is unaffected by that move.

## One Sentence

Replace the global `resolve.extensions` + `moduleSuffixes` "magic suffix" platform
selection with an explicit, scoped `#platform/*` package.json `imports` map keyed on a
`tauri` condition, so the wrong-platform file is never resolved, the global module
namespace stops being magic, and normal files (like the workspace schema) can be named
naturally again.

## Start Here

```txt
WHY THIS EXISTS
  A "cohesion" rename of apps/fuji/fuji.workspace.ts -> fuji.ts broke the fuji build:
  0 errors -> 43 errors ("Circular definition of import alias 'createFuji'"). Root cause:
  fuji's vite.config resolves `.browser.ts` BEFORE `.ts`, so the bare import `./fuji`
  resolved to fuji.browser.ts instead of the schema. The `.workspace` infix was a
  load-bearing workaround for a GLOBAL resolver footgun. This spec removes the footgun.

THE REFRAME (important)
  The goal "don't ship @tauri-apps code to the web bundle" is ALREADY met today: the web
  build's extension list omits `.tauri.ts`, so a `.tauri.ts` file is unresolvable on web
  and a stray import fails at build time. We are NOT fixing bundling. We are fixing the
  MECHANISM: a global switch that makes every bare import magic, to serve ~2 (fuji) /
  ~13 (whispering) real seams.
```

## Decision Ledger

```txt
decision                                   answer                                          status
mechanism                                  package.json "imports" #platform/* + conditions  SETTLED
  (vs resolve.alias, vs status quo)        single source of truth read by BOTH Vite + tsc
tree-shaking of tauri code                 already solved by build-time unresolvability;    SETTLED
                                           NOT relying on Rollup DCE (unreliable, see below)
per-target tsconfig / customConditions     NOT needed; default condition -> browser file;   SETTLED (grounded)
                                           both impls type-checked standalone
impl typing                                explicit annotation `: PlatformAuth`,            SETTLED (grounded)
                                           NOT `satisfies` (satisfies leaks concrete type)
runtime DI / Effect-style Layers           REFUSED; platform is a build-time-static fact    SETTLED
fuji.workspace.ts -> fuji.ts rename        UNBLOCKED once the global resolver is gone;       PLANNED (commit 2)
                                           lands as the visible payoff
whispering migration                       same seam, mechanical; after fuji proves it       PLANNED (commit 3)
subpath naming (#platform/tauri vs native) keep `tauri` to match Tauri vocabulary;           OPEN (minor)
                                           `#platform/native` is an optional clarity rename
```

## First Principles: What We Are Actually Doing

```txt
Goal A (hard)  @tauri-apps/* code must be PHYSICALLY ABSENT from the web bundle.
Goal B (soft)  the right impl is selected per build, low call-site boilerplate.
Non-goal       runtime platform detection. Platform is known at BUILD time and never
               changes at runtime; paying runtime DI to express it is the wrong tool.
```

Why not the alternatives (grounded in research, see Grounding section):

```txt
define + tree-shaking            REJECTED as the firewall. Rollup keeps imported modules
                                 even when exports go unused (moduleSideEffects: true by
                                 default); @tauri-apps/* is not marked sideEffects:false,
                                 so native code can survive a dead branch. Never rely on it.
global resolve.extensions        REJECTED. Works, but it is a whole-namespace tax: every
  (status quo)                   bare import is magic. It caused the ./fuji collision and
                                 forces the fuji.workspace.ts wart. RN/Metro-era idiom,
                                 treated as a smell anywhere a standard bundler is in play.
runtime guards (isTauri())       REJECTED for Goal A; both branches ship. Fine only for
                                 tiny localized feature checks, not for excluding native code.
resolve.alias per seam           VIABLE but inferior: the map lives in TWO places (vite +
                                 tsconfig paths), and per-build alias targets push you into
                                 the per-target tsconfig we are trying to delete.
```

The winner is the Node-standard `imports` field: one map, in the app's own
`package.json`, read natively by both Vite and `tsc`. The best multi-platform libraries
(automerge, rxdb, tldraw, electric, better-auth) all converge on explicit, condition-based
selection where the wrong file is never resolved. This is that, scoped to an app.

## The Mechanism (grounded, minimal)

```jsonc
// apps/fuji/package.json : the ONE source of truth
"imports": {
  "#platform/auth":  { "tauri": "./src/lib/platform/auth.tauri.ts",  "default": "./src/lib/platform/auth.browser.ts" },
  "#platform/tauri": { "tauri": "./src/lib/platform/tauri.tauri.ts", "default": "./src/lib/platform/tauri.browser.ts" }
}
```

```ts
// apps/fuji/vite.config.ts
import { defaultClientConditions } from 'vite';
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
  // ...
  resolve: {
    dedupe: ['yjs'],
    // DELETED: extensions: isTauri ? [...] : [...]
    conditions: isTauri ? ['tauri', ...defaultClientConditions] : undefined,
    //                    ^^^^^^^^ the spread is LOAD-BEARING: a custom condition
    //                    REPLACES the defaults in Vite 6+, so module/browser/dev|prod
    //                    must be re-included or all dep resolution silently breaks.
  },
});
```

```jsonc
// apps/fuji/tsconfig.json
{
  "extends": ["../../tsconfig.base.json", "./.svelte-kit/tsconfig.json"],
  "compilerOptions": {
    "checkJs": true,
    "types": ["bun"]
    // DELETED: "moduleSuffixes": [".tauri", ".browser", ""]
    //   bundler moduleResolution resolves #imports natively; with no customConditions
    //   it lands on `default` = the browser file. No per-target tsconfig needed.
  }
}
```

```ts
// every consumer, web and desktop, identical and greppable:
import { auth } from '#platform/auth';
import { tauri } from '#platform/tauri';
```

### The interface-annotation rule (the inverted convention)

Each impl must carry an EXPLICIT interface annotation so consumers are bound to the
contract regardless of which file resolves:

```ts
// auth.browser.ts AND auth.tauri.ts
export const auth: PlatformAuth = createOAuthAppAuth({ /* ... */ });
//                ^^^^^^^^^^^^^ widens both exports to the identical type.

// DO NOT use `satisfies PlatformAuth` here. satisfies preserves the concrete inferred
// type, so the browser and tauri exports would have DIFFERENT types and a consumer's
// view would depend on which file resolved -> exactly the drift we are killing.
```

This is the one place to invert the repo's usual "prefer `satisfies`" convention.
For `auth`, `PlatformAuth = ReturnType<typeof createOAuthAppAuth>` (the factory return is
the interface; no new type needed). For the `tauri` marker, the shared `type Tauri` moves
to a contract file both impls import:

```txt
src/lib/platform/
  tauri.types.ts     export type Tauri = { markdown: { ... } }   <- the contract
  tauri.browser.ts   export const tauri: Tauri | null = null
  tauri.tauri.ts     export const tauri: Tauri | null = tauriOnly  (imports @tauri-apps/*)
  auth.browser.ts    export const auth: PlatformAuth = ...
  auth.tauri.ts      export const auth: PlatformAuth = ...         (imports @tauri-apps/*)
```

## Before / After (fuji, concrete)

```txt
BEFORE                                          AFTER
resolve.extensions ['.browser.ts','.ts',...] -> resolve.conditions ['tauri', ...defaults]
moduleSuffixes ['.tauri','.browser','']      -> (deleted; bundler resolves #imports)
import { auth } from './auth'  (magic)       -> import { auth } from '#platform/auth' (explicit)
import { tauri } from './tauri' (magic)      -> import { tauri } from '#platform/tauri'
./fuji -> fuji.browser.ts  (collision)       -> ./fuji is a normal import again
fuji.workspace.ts  (forced name)             -> fuji.ts  (commit 2, the payoff)
```

Seam inventory (verified): **fuji = 2 seams** (`auth` x10 importers, `tauri` x1).
**whispering = ~13 seams** across `src/lib/services/{recorder,http,os,sound,download,
blob-store,analytics,text}`, `report/os-notify`, `state/manual-recorder-config`, plus the
`tauri` marker (x35 importers). whispering's folder-`index.{platform}.ts` layout already
contains the footgun better than fuji's root-level files did, so it migrates second.

## Grounding (what was verified, and how)

```txt
Vite 7.3.1, TS 5.9.3, SvelteKit adapter-static (SPA, no SSR -> no client/server
condition split). In-repo precedent: packages/constants already ships a package.json
`imports` field (#*), proving the toolchain resolves # subpaths today.

CONFIRMED against current docs:
  - TS bundler mode resolves #platform/auth via the imports field; with no customConditions
    it applies ["types","import","default"] and lands on `default` = browser file.
  - A per-target tsconfig/customConditions is NOT needed for correctness: both impls are in
    `include` and type-checked standalone against the annotated interface. It would only
    change Go-to-Definition target.
  - `satisfies` leaks the concrete type; explicit `: PlatformAuth` annotation binds consumers
    to the interface resolution-independently.
  - Vite 7: `resolve.conditions` activates `tauri`; custom conditions REPLACE defaults, so
    `[...,'...defaultClientConditions]` re-spread is mandatory; web build sets nothing and
    falls through to `default`.
  - Vite/Rollup resolve `#` against the importing file's nearest package.json (the app's own),
    even for a non-published app. Works identically in dev and build; src files are not
    optimizeDeps-prebundled, so no extra config.

ONE honest gap of single-tsconfig: if a `.tauri.ts` file imported something that ITSELF
resolved differently per condition, single-tsconfig would check it under `default`. Does not
arise here: the tauri impls import concrete `@tauri-apps/*` packages, which type-check under
any condition.
```

## Migration Plan (3-4 commits, sequenced)

```txt
COMMIT 1  feat(fuji): scope platform selection to #platform/* subpath imports
  - create src/lib/platform/{auth,tauri}.{browser,tauri}.ts (move existing files in)
  - add tauri.types.ts contract; annotate both impls with the interface (no satisfies)
  - add package.json "imports" map
  - vite: delete resolve.extensions branch, add resolve.conditions (tauri build only)
  - tsconfig: delete moduleSuffixes
  - rewrite ~11 consumers from './auth'/'./tauri' to '#platform/auth'/'#platform/tauri'
  GATE: `bun run typecheck` (web resolution) = 0 errors; both `vite build` and the Tauri
        build resolve correctly; grep shows no bare './auth' / './tauri' platform imports left.

COMMIT 2  refactor(fuji): rename fuji.workspace.ts -> fuji.ts  (the payoff, now unblocked)
  - git mv + update the ~14 references + package.json "." export
  GATE: typecheck 0 errors; `./fuji` resolves to fuji.ts (no fuji.browser.ts collision).

COMMIT 3  feat(whispering): scope platform selection to #platform/* subpath imports
  - same transformation across the ~13 service seams + tauri marker
  - one "imports" entry per seam; delete resolve.extensions + moduleSuffixes
  GATE: typecheck 0 errors; both builds resolve; native code absent from web build.

COMMIT 4 (optional)  docs: reconcile workspace-app-layout skill + delete stale invariant
  - document the #platform/* seam as the canonical platform-DI mechanism
  - the "fuji.workspace.ts must not be renamed" memory/skill note becomes obsolete -> remove
```

Each commit is independently revertible and leaves the build green. Commit 2 depends on
Commit 1 (resolver must be gone first). Commit 3 is independent of 1/2.

## What This Refuses (the asymmetric win)

```txt
REFUSE (~the 10%)                            GAIN (~the 90%)
implicit "any bare import auto-resolves      no global namespace magic; every non-seam file
  to a platform variant"                       (schema, singletons, components) is boring
                                               and collision-proof
a couple of magic-suffix lines               an explicit, greppable, Node-standard map; tsc
                                               and Vite agree from one source of truth
                                             fuji.workspace.ts -> fuji.ts (cohesion restored)
                                             deletes moduleSuffixes hack + per-target tsconfig
                                               temptation + the "is this file a landmine?" tax
```

Honest cost: you maintain a small `imports` map per app (2 entries fuji, ~13 whispering).
That is the trade: a little explicit config in exchange for deleting an implicit global
footgun. It is not fewer lines; it is fewer surprises.

## Open Questions To Ratify Before Coding

```txt
Q1  Subpath naming: `#platform/tauri` (matches existing export + Tauri's isTauri vocabulary)
    vs `#platform/native` (clearer that it is null on web). Lean: keep `tauri`, defer rename.
Q2  Directory: consolidate platform files into src/lib/platform/ (proposed) vs leave them
    in place and only point the imports map at current paths (less churn). Lean: consolidate;
    it makes the seam set greppable in one folder.
Q3  Should fuji.browser.ts (the root env-composition factory, imported explicitly by
    session.ts, NOT a platform seam) be renamed for clarity in commit 2's vicinity, or left
    alone? Lean: leave alone this pass; it is a separate concern.
```

## Verification Checklist (per app)

```txt
[ ] bun run typecheck = 0 errors (web/default resolution)
[ ] vite build (web) succeeds; a deliberate import of a *.tauri.ts from shared code FAILS
    the build (proves native code is excluded, not runtime-guarded)
[ ] Tauri build resolves the tauri variants (resolve.conditions active)
[ ] rg "from './auth'|from './tauri'|\.browser'|\.tauri'" shows no remaining bare platform
    imports in consumer code (only the imports map references the files by path)
[ ] no moduleSuffixes, no resolve.extensions platform branch remain
[ ] Go-to-Definition on #platform/auth lands on the browser impl (expected; documented)
```
