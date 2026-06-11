# Modernize Every tsconfig in the Monorepo

**Date**: 2026-05-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: spec only; implementation branch TBD (off `main`, not the current revert branch)

## Overview

Collapse the monorepo's three root TypeScript base configs into two, delete the
dead `tsconfig.base.lib.json`, and rewrite all 25 leaf configs so each one is
minimal: it may set `types`, library-only strictness, and genuinely
package-specific options, and nothing that merely repeats a base. One module
strategy (`module: preserve` + `moduleResolution: bundler`) applies everywhere;
the `constants` package's `NodeNext` override is removed as drift.

**One sentence**: every package in this repo is source-only `.ts` consumed by a
bundler or by Bun, so there is exactly one correct module strategy, one base, one
DOM variant, and every leaf config should be three lines or fewer of real choices.

## Motivation

### Current State

Three root base files, with no single consumer of the third:

```
tsconfig.base.json        preserve + bundler, strict, noEmit, types []   (universal)
tsconfig.base.dom.json    extends base, adds DOM lib                     (7 consumers)
tsconfig.base.lib.json    extends base, noEmit:false + composite + emit  (1 consumer: ui)
```

Leaf configs drifted into several near-identical-but-not shapes. Representative
samples:

```jsonc
// packages/workspace, filesystem, skills, cli, util, sync : "bun library"
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"types": ["bun"],
		"noUnusedLocals": true,
		"noUnusedParameters": true,
		"noPropertyAccessFromIndexSignature": false  // <-- sets the flag to its OWN default
	}
}

// packages/encryption: same, plus a redundant re-declaration
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"module": "preserve",        // <-- already in the base
		"noPropertyAccessFromIndexSignature": false,
		/* ...types, noUnused... */
	}
}

// packages/constants: the outlier: a SECOND module strategy
{
	"extends": ["../../tsconfig.base.json"],
	"compilerOptions": {
		"module": "NodeNext",            // <-- conflicts with base's preserve
		"moduleResolution": "NodeNext",  // <-- conflicts with base's bundler
		"types": ["node"]
	},
	"include": ["src/**/*"],
	"exclude": ["node_modules", "dist"]  // <-- node_modules is default; dist does not exist
}

// apps/tab-manager: orphaned: extends ONLY its generated wxt config,
// re-declares 9 options by hand, and is missing the repo's extra strict flags
{
	"extends": "./.wxt/tsconfig.json",
	"compilerOptions": {
		"allowImportingTsExtensions": true, "verbatimModuleSyntax": true,
		"noEmit": true, "strict": true, "skipLibCheck": true,
		"moduleResolution": "bundler", "module": "ESNext", "target": "ESNext",
		"lib": ["ESNext", "DOM", "DOM.Iterable"],
		"customConditions": ["browser"], "paths": { "$lib/*": ["./src/lib/*"] }
	}
}
```

This creates problems:

1. **A dead base file**: `tsconfig.base.lib.json` turns on `noEmit:false`,
   `outDir`, `declaration`, `declarationMap`, `composite`, and `inlineSources`.
   Its only consumer is `packages/ui`, which has **no `build` script**,
   typechecks via `svelte-check`, and is referenced by **zero** project
   `references` anywhere in the repo. None of the emit settings ever take
   effect. Worse, `composite` forces `declaration: true`, which makes `tsc`
   demand portable type names; that produces *"inferred type ... cannot be
   named ... not portable"* errors in `ui` that have nothing to do with `ui`'s
   actual code.
2. **Two module strategies**: the base says `preserve` + `bundler`; `constants`
   says `NodeNext`. Nothing in the repo is published as emitted Node ESM, so the
   second strategy is accidental drift, not a deliberate split.
3. **Cargo-culted redundancy**: `noPropertyAccessFromIndexSignature: false`
   appears in 7 leaf configs and sets the flag to its own default value.
   `encryption` re-declares `module: preserve`. `api` re-declares `noEmit: true`.
   `test-utils` re-declares `lib: ["ESNext"]`. `yjs-size-benchmark` sets
   `useDefineForClassFields: true`, which is already the default at
   `target: ESNext`. The base itself carries `sourceMap` (dead under `noEmit`),
   `resolvePackageJsonExports` (default under `bundler`), and
   `forceConsistentCasingInFileNames` (default since TS 5.0).
4. **Inconsistent layering for identical runtimes**: 4 SvelteKit apps extend
   `tsconfig.base.json`, 3 extend `tsconfig.base.dom.json`. The choice is inert:
   each SvelteKit app also extends its generated `./.svelte-kit/tsconfig.json`,
   which is listed *last* and sets `lib: [esnext, DOM, DOM.Iterable]`, so the DOM
   lib always comes from the generated config regardless of which base is named.
5. **`extends` shape drift**: some leaves use a single-element array
   (`["../../tsconfig.base.dom.json"]`), some a string.
6. **A latent include bug**: `apps/dashboard` declares its own
   `include: ["src/**/*.ts", "src/**/*.svelte"]`. TypeScript does not merge
   `include` across `extends`; the leaf's array fully *replaces* the generated
   SvelteKit `include`, silently dropping `ambient.d.ts`, `$types`, and
   `vite.config`. The other 6 SvelteKit apps correctly inherit it.
7. **The boilerplate source**: `.agents/skills/monorepo/SKILL.md` prescribes the
   old shape (`module: preserve` + `noPropertyAccessFromIndexSignature: false` +
   `main`/`types`). Every new package inherits the drift. The skill is the root
   cause and must be fixed, or the cleanup regrows.

### Desired State

Two root base files. Every leaf config one of eight known shapes, each minimal.

```
tsconfig.base.json    universal: preserve+bundler, strict, noEmit, types []
tsconfig.dom.json     extends base, adds DOM lib                  (renamed from base.dom)
                      tsconfig.base.lib.json deleted
```

```jsonc
// every bun library
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["bun"], "noUnusedLocals": true, "noUnusedParameters": true } }

// every svelte library
{ "extends": "../../tsconfig.dom.json", "compilerOptions": { "types": ["bun"] } }
```

## Research Findings

### Current TypeScript guidance (verified against typescriptlang.org, TS 5.9)

| Option | Current docs say | Implication here |
| --- | --- | --- |
| `module: "preserve"` | "the best choice whenever a runtime or bundler is operating on raw `.ts` files, since it implies no transformation"; "best reflects ... most modern bundlers, as well as the Bun runtime" | Correct for this repo. Keep. |
| `module: preserve` → resolution | "`--module preserve` implies `--moduleResolution bundler`" (default table: "`Bundler` if `module` is `Preserve`") | `moduleResolution: bundler` is strictly implied. |
| `moduleResolution: "bundler"` | "supports package.json `imports` and `exports`"; "never requires file extensions on relative paths" | Resolves `constants`' `imports`/`exports` maps without `NodeNext`. |
| `module: "nodenext"` | "implies and enforces `--moduleResolution nodenext`"; for "code compiled and run in Node.js" | Only correct for emitted/published Node ESM. Nothing here qualifies. |
| `forceConsistentCasingInFileNames` | default `true` since TS 5.0 | Redundant in the base. Drop. |
| `useDefineForClassFields` | default `true` when `target` >= ES2022 | Redundant at `target: ESNext`. Drop from `yjs-size-benchmark`. |
| `resolvePackageJsonExports` | default `true` under `moduleResolution: bundler` | Redundant in the base. Drop. |
| `sourceMap` | emits `.map` files | No-op under `noEmit`. Drop from the base. |
| `noPropertyAccessFromIndexSignature` | default `false`; NOT part of `strict` | `: false` in 7 leaves is a no-op. Drop everywhere. |

**Key finding**: the base's `preserve` + `bundler` pairing is already the
modern, correct choice. The work is not a strategy change; it is removing a
second strategy (`constants`), removing settings that repeat a default, and
collapsing one dead base file.

**Implication**: this is a clean break with no resolution-behavior change for
any conforming consumer. `bundler` resolution reads `exports`/`imports` exactly
as `NodeNext` did for `constants`.

### Baseline typecheck state (before any change)

`turbo run typecheck --continue` on a clean tree:

| Package | Errors | Cause | tsconfig-related? |
| --- | --- | --- | --- |
| `@epicenter/dashboard` | 2 | imports `@epicenter/auth` + `/oauth-launchers`; only `@epicenter/auth-svelte` is in its deps | No (missing dependency) |
| `@epicenter/whispering` | 21 | app-logic type errors (`stepRuns`, `.value` on disposable, etc.) | No |
| `@epicenter/ui` | 71 | `noUncheckedIndexedAccess` violations + `declaration`-portability errors | Partly |

**Key finding**: the workspace typecheck is already red, for reasons unrelated
to config layout. The sweep cannot make it green on its own.

**Implication**: success is defined as *no package gains errors*, not *all
green*. Two extra outcomes are expected and good: `dashboard` goes to 0 once its
missing dependency is added (Phase 4), and `ui`'s count *drops* once
`base.lib.json` is deleted, because the `declaration`-portability errors stop
firing when `composite`/`declaration` are gone. `whispering`'s 21 are
out of scope and stay.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Module strategy | 1 evidence | `module: preserve` + `moduleResolution: bundler`, repo-wide | Docs verified; every consumer is a bundler or Bun on raw `.ts`. |
| `constants` `NodeNext` | 1 evidence | Remove; join the single strategy | `bundler` resolution reads its `imports`/`exports`; `constants` is `private`, never published as Node ESM. |
| Delete `tsconfig.base.lib.json` | 1 evidence | Delete; `ui` extends `tsconfig.dom.json` | Verified: no `references` exist anywhere; `ui` has no `build` script; emit settings are inert and `composite` actively produces spurious errors. |
| Number of base files | 3 taste | Two (`base`, `dom`), flat leaves | A `tsconfig.lib.json` layer for the two `noUnused*` flags does not compose with the DOM split under TS's single-string `extends`; two base files plus 3-line leaves is less cognitive load than four base files. |
| Keep `moduleResolution: bundler` explicit | 3 taste | Keep in the base, with a comment | Strictly implied by `preserve`, but the explicit `module`/`moduleResolution` pair reads as complete to anyone who does not know the TS 5.4 implication rule. |
| Rename `base.dom` -> `dom` | 3 taste | Rename | With `base.lib` gone the clean story is two tiers: `base`, and `base` + DOM. `tsconfig.dom.json` names that directly. |
| `types` stays per-leaf | 2 coherence | Do not hoist `types: ["bun"]` to the base | The base deliberately sets `types: []` so each package opts in; hoisting risks `Cannot find type definition` where `@types/bun` is absent (e.g. `landing`). The base comment already documents this intent. |
| `noUnused*` stays per-leaf | 2 coherence | Library leaves set them; apps do not | Libraries enforce; apps stay lax mid-development. Hoisting to the base would force 9 apps to opt out, which is more lines, not fewer. |
| Add `noUnused*` to `constants` | 2 coherence | Add | `constants` is a library; the standard bun-library shape includes them. May surface unused-symbol errors in a tiny package; fix in place if so. |
| Svelte libraries omit `noUnused*` | 3 keep | Keep `auth-svelte`, `svelte-utils`, `ui` without them | Matches current behavior; adding them risks new errors on the already-red `ui`. See Decisions Log. |
| `tab-manager` joins the repo base | 2 coherence | `extends: ["../../tsconfig.dom.json", "./.wxt/tsconfig.json"]` | Stops the orphan; the SvelteKit apps already run the repo's full strict set, so `tab-manager` should too. Risk in Edge Cases. |
| `package.json` `main`/`types` cleanup | 2 coherence | Drop redundant `main`/`types` from the 9 packages that also have `exports` | Modern resolvers (`bundler`/`node16`+) ignore `main`/`types` when `exports` exists; deleting them is a no-op for every consumer. |
| Fix `dashboard`'s missing dep | 1 evidence | Add `@epicenter/auth` to `dashboard` deps | `dashboard/src/lib/platform/auth/auth.ts` imports it directly; the import is real, the dependency declaration is missing. |
| `whispering` / `ui` app-logic errors | Deferred | Deferred | Pre-existing, unrelated to config. Out of scope. |

## Architecture

### Base layering

```
                  tsconfig.base.json
                  ├── target / lib [ESNext] / moduleDetection force / types []
                  ├── module preserve  (implies moduleResolution bundler)
                  ├── noEmit / isolatedModules / verbatimModuleSyntax / esModuleInterop
                  └── strict / noUncheckedIndexedAccess / noImplicitOverride / skipLibCheck
                          │
                          │ extends
                          ▼
                  tsconfig.dom.json
                  └── lib [ESNext, DOM, DOM.Iterable]      (the ONLY override)
```

### Leaf tiers (8 shapes)

```
TIER                    extends                                              leaf may add
──────────────────────────────────────────────────────────────────────────────────────────
bun library             ../../tsconfig.base.json                             types[bun], noUnused*
node library (constants)../../tsconfig.base.json                             types[node], noUnused*
svelte library          ../../tsconfig.dom.json                              types[bun]
SvelteKit app           [../../tsconfig.base.json, ./.svelte-kit/tsconfig]    checkJs, types[bun]
Cloudflare Worker (api) ../../tsconfig.base.json                             jsx*, types, include
bun app (breddit)       ../../tsconfig.base.json                             types[bun], include
Astro app (landing)     [../../tsconfig.base.json, astro/tsconfigs/strict]   astro include/exclude
WXT extension (tab-mgr) [../../tsconfig.dom.json, ./.wxt/tsconfig.json]       customConditions, paths, include
──────────────────────────────────────────────────────────────────────────────────────────
Generated configs (./.svelte-kit/tsconfig.json, ./.wxt/tsconfig.json) are listed
LAST so their lib/module win where they must. They are never hand-edited.
```

### Per-file change map

```
ROOT
  tsconfig.base.json      EDIT   drop sourceMap, resolvePackageJsonExports,
                                 forceConsistentCasingInFileNames; add preserve->bundler comment
  tsconfig.base.dom.json  RENAME -> tsconfig.dom.json  (inner `extends` unchanged)
  tsconfig.base.lib.json  DELETE

packages/  (13)
  workspace, filesystem, skills, cli, util, sync   EDIT  drop noPropertyAccessFromIndexSignature
  encryption                                       EDIT  drop module:preserve + noPropertyAccess...
  test-utils                                        EDIT  drop redundant lib:["ESNext"] and include*
  constants                                         EDIT  drop NodeNext x2 + include/exclude; add noUnused*
  auth                                              EDIT  extends dom.json; drop inline lib
  auth-svelte, svelte-utils                          EDIT  extends dom.json (string form)
  ui                                                 EDIT  extends dom.json; drop rootDir/lib/include/exclude

apps/  (11)
  api               EDIT  drop redundant noEmit:true
  breddit           NONE  already minimal
  dashboard         EDIT  extends base+svelte-kit; drop the explicit `include`
  fuji, honeycrisp, whispering   NONE  already the target shape
  opensidian, skills, zhongwen   EDIT  base.dom -> base
  landing           NONE  astro app, already correct
  tab-manager       EDIT  extends [dom.json, ./.wxt/tsconfig.json]; drop 9 hand-redeclared options

examples/  (1)
  yjs-size-benchmark  EDIT  base.dom -> dom; drop redundant useDefineForClassFields
                            (not in the turbo typecheck graph; cosmetic)
```

\* `test-utils`' `include: ["src/**/*.ts"]`: drop only if `test-utils` has no
`.ts` files outside `src/`. Verify during execution.

## Implementation Plan

Ordered Build, Prove, Remove: the base files and leaves change together (a
config rewrite has no "old path running in parallel"), but `base.lib.json` is
deleted only after `ui` has been repointed and the workspace verified.

### Phase 1: Base files

- [ ] **1.1** Edit `tsconfig.base.json`: remove `sourceMap`,
      `resolvePackageJsonExports`, `forceConsistentCasingInFileNames`. Add a
      one-line comment that `module: preserve` implies `moduleResolution: bundler`.
- [ ] **1.2** `git mv tsconfig.base.dom.json tsconfig.dom.json`. Its inner
      `extends: "./tsconfig.base.json"` needs no change.
- [ ] **1.3** Leave `tsconfig.base.lib.json` on disk for now (deleted in Phase 5).

### Phase 2: Library leaf configs

- [ ] **2.1** Bun libraries (`workspace`, `filesystem`, `skills`, `cli`, `util`,
      `sync`): reduce to `{ extends base, types:[bun], noUnusedLocals,
      noUnusedParameters }`. For `encryption` also drop `module: preserve`.
- [ ] **2.2** `test-utils`: drop redundant `lib: ["ESNext"]`; drop `include`
      unless non-`src` `.ts` files exist.
- [ ] **2.3** `constants`: drop the `NodeNext` pair and `include`/`exclude`;
      `extends` as a string; `types: ["node"]`; add `noUnusedLocals`/`noUnusedParameters`.
- [ ] **2.4** `auth`: `extends: "../../tsconfig.dom.json"`, drop inline `lib`.
- [ ] **2.5** Svelte libraries (`auth-svelte`, `svelte-utils`, `ui`): reduce to
      `{ extends "../../tsconfig.dom.json", compilerOptions: { types: ["bun"] } }`.
      For `ui` this also drops `rootDir`, `lib`, `include`, `exclude`.

### Phase 3: App and example leaf configs

- [ ] **3.1** `api`: drop redundant `noEmit: true`.
- [ ] **3.2** SvelteKit apps `opensidian`, `skills`, `zhongwen`: change
      `tsconfig.base.dom.json` -> `tsconfig.base.json` in the `extends` array.
- [ ] **3.3** `dashboard`: remove the explicit `include` so it inherits the
      generated SvelteKit `include`.
- [ ] **3.4** `tab-manager`: `extends: ["../../tsconfig.dom.json",
      "./.wxt/tsconfig.json"]`; keep only `customConditions`, `paths`, `include`.
- [ ] **3.5** `yjs-size-benchmark`: `tsconfig.base.dom.json` -> `tsconfig.dom.json`;
      drop `useDefineForClassFields`.
- [ ] **3.6** Confirm `breddit`, `fuji`, `honeycrisp`, `whispering`, `landing`
      need no change.

### Phase 4: package.json cleanup and the dashboard fix

- [ ] **4.1** Drop redundant `main` and `types` from `auth`, `auth-svelte`,
      `encryption`, `filesystem`, `sync`, `util`, `workspace`, `skills`, `api`
      (all 9 have an `exports` map).
- [ ] **4.2** `cli`: give it `exports: { ".": "./src/index.ts" }` and drop
      `main`/`types`. (`cli` has a `bin`; this just modernizes its package entry.)
- [ ] **4.3** Add `"@epicenter/auth": "workspace:*"` to `apps/dashboard`
      `dependencies`. Run `bun install` from the repo root.

### Phase 5: Prove, then Remove

- [ ] **5.1** Run `bun typecheck` (`turbo run typecheck --continue`). Compare
      against the baseline in Research Findings. Required: no package gains
      errors; `dashboard` reaches 0; `ui`'s count is <= 71.
- [ ] **5.2** If `tab-manager` gains `noUncheckedIndexedAccess` errors, decide
      per Edge Cases (fix in place, or explicit opt-out).
- [ ] **5.3** Once 5.1 is green-relative-to-baseline, `git rm tsconfig.base.lib.json`.
- [ ] **5.4** Re-run `bun typecheck` to confirm the deletion changed nothing.

### Phase 6: Externalize so the drift cannot regrow

- [ ] **6.1** Keep `.agents/skills/tsconfig/SKILL.md` (created alongside this
      spec) in sync with the final shapes.
- [ ] **6.2** Update `.agents/skills/monorepo/SKILL.md`: replace the "New Package
      Boilerplate" `tsconfig.json` snippet with the minimal bun-library shape and
      point at the `tsconfig` skill; drop `main`/`types` from its `package.json`
      snippet.
- [ ] **6.3** Optional: add a one-line pointer to the `tsconfig` skill in the
      root `AGENTS.md`.

## Edge Cases

### `tab-manager` gains strict-flag errors

1. `tab-manager` currently extends only its generated WXT config and lacks
   `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
2. Extending `tsconfig.dom.json` adds all of them.
3. Expected: likely a small number of `noUncheckedIndexedAccess` findings.
   Resolution: if few, fix them in place (real strictness debt the SvelteKit
   apps already pay); if many or risky, add an explicit, commented
   `"noUncheckedIndexedAccess": false` to the `tab-manager` leaf and file a
   follow-up. Do not silently weaken the base.

### `dashboard` gains errors after dropping its `include`

1. Removing `dashboard`'s explicit `include` makes it inherit the generated
   SvelteKit `include`, which checks `ambient.d.ts`, `$types`, `vite.config`,
   and test directories that were previously unchecked.
2. Newly checked files could surface pre-existing errors.
3. Expected outcome: those errors were always real; report them. If they are
   genuinely out of scope, restore a minimal `include` with a comment naming
   what it deliberately narrows and why. Prefer the inherited include.

### `ui` without `include`/`exclude`

1. `ui` currently scopes `svelte-check` with `include: ["src/**/*"]` /
   `exclude: ["dist", "node_modules"]`.
2. After the rewrite it relies on the default project scope.
3. Expected outcome: `ui` has no `dist/`, and `node_modules` is excluded by
   default, so the default scope should match. If `svelte-check` starts
   checking unintended files, restore a minimal `include`.

## Open Questions

1. **Keep `moduleResolution: bundler` explicit in the base, or drop it as
   strictly implied by `module: preserve`?**
   - Options: (a) keep with a comment, (b) drop.
   - **Recommendation**: keep (a). The explicit pair is more legible than
     relying on a reader knowing the TS 5.4 implication. Left open: a stricter
     reading of "no redundant settings" would drop it.

2. **Should the three Svelte libraries (`auth-svelte`, `svelte-utils`, `ui`)
   also get `noUnusedLocals`/`noUnusedParameters` for full library consistency?**
   - `svelte-check` honors them correctly for `.svelte` files (template usage
     counts), so it is technically safe. The risk is surfacing new errors on the
     already-red `ui`.
   - **Recommendation**: defer. Land the layout sweep first; add `noUnused*` to
     the Svelte libraries as a separate, small follow-up once `ui` is green.

3. **`cli`: add an `exports` map (Phase 4.2) or leave `main`/`types`?**
   - `cli` is consumed as a `bin`, not imported as a library.
   - **Recommendation**: add `exports` for consistency with every other package;
     it is harmless. Skip only if a consumer is found to import `@epicenter/cli`
     in a way that depends on `main`.

## Decisions Log

- Keep the three Svelte libraries without `noUnusedLocals`/`noUnusedParameters`:
  matches current behavior, avoids adding errors to the already-red `ui` during
  a layout-only sweep.
  Revisit when: `ui` typechecks clean, at which point Open Question 2 becomes a
  cheap, safe follow-up.
- Keep `moduleResolution: bundler` explicit in `tsconfig.base.json`: legibility
  over strict non-redundancy; it is implied by `module: preserve`.
  Revisit when: the team standardizes on trusting TS implication rules and wants
  the base trimmed to only non-implied options.

## Success Criteria

- [ ] Two root base files: `tsconfig.base.json`, `tsconfig.dom.json`.
      `tsconfig.base.lib.json` deleted.
- [ ] Every leaf `extends` is a string, except the deliberate two-element arrays
      for SvelteKit, Astro, and WXT apps.
- [ ] No leaf config sets an option that merely repeats a base or a TS default.
- [ ] Exactly one module strategy in the repo (`preserve` + `bundler`); no
      `NodeNext` anywhere.
- [ ] `bun typecheck`: no package has more errors than the baseline;
      `@epicenter/dashboard` is at 0; `@epicenter/ui` is at <= 71.
- [ ] `.agents/skills/monorepo/SKILL.md` boilerplate produces the new minimal
      shape; `.agents/skills/tsconfig/SKILL.md` documents all eight tiers.
- [ ] No AI attribution in commits; files staged individually.

## References

- `tsconfig.base.json`, `tsconfig.base.dom.json`, `tsconfig.base.lib.json` - the
  three roots; the spec consolidates them to two.
- `packages/*/tsconfig.json`, `apps/*/tsconfig.json`,
  `examples/yjs-size-benchmark/tsconfig.json` - the 25 leaf configs.
- `apps/*/.svelte-kit/tsconfig.json`, `apps/tab-manager/.wxt/tsconfig.json` -
  generated configs; read to confirm what they set, never edited.
- `apps/dashboard/src/lib/platform/auth/auth.ts` - the import that needs the
  `@epicenter/auth` dependency.
- `.agents/skills/monorepo/SKILL.md` - the boilerplate source to fix in Phase 6.
- `.agents/skills/tsconfig/SKILL.md` - the new skill; the durable form of this spec.
