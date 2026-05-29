# Build-Time Platform DI via Filename Suffixes

**Status**: Approved for execution. Clean break: no backward-compatibility layer, no deprecation period.
**Type**: Build/architecture change (zero behavior change at runtime)
**Scope**: `apps/whispering/src/lib/services/*`, `apps/whispering/vite.config.ts`, `apps/whispering/tsconfig.json`

**Supersession note (2026-05-29)**: The recorder is no longer the "one tricky
case" described below. Manual recording is build-time platform-owned:
`services/recorder/index.tauri.ts` uses CPAL, and
`services/recorder/index.browser.ts` uses Navigator. There is no
`recording.method`, nullable `cpalRecorder`, `RecorderModule`, or
`navigatorRecorder` manual path in live code. The recorder row under runtime
DI, the "Recorder: the one tricky case" section, Risk 5, and Wave 5 are
historical. See `20260529T000000-recording-input-paths-clean-break.md`.

## Problem

Today, every cross-platform service uses runtime DI:

```ts
// services/clipboard/index.ts
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
  ? createClipboardServiceDesktop()
  : createClipboardServiceWeb();
```

Both implementations are imported. The wrong one is bundled as dead code. The decision is evaluated at module load.

This conflates two unlike decisions:

1. **"What platform am I on?"**: a build-time fact. We know at `vite build` whether we're producing the Tauri bundle or the web bundle. There is no scenario where a single Tauri bundle would need to fall back to the web clipboard.
2. **"What user preference did the user pick?"**: a runtime fact. The transcription provider is OpenAI today, Groq tomorrow, with the same bundle.

Mixing them under one mechanism (the `__TAURI_INTERNALS__` ternary) has concrete costs:

- **Bundle bloat.** Web bundle ships Tauri code; Tauri bundle ships web fallbacks. Small per service; aggregate isn't free.
- **Weaker type safety.** Nothing prevents `web` impl from importing `@tauri-apps/api/*`. The bundler accepts it; we find out at runtime, or via a lint rule, or never.
- **Cognitive overhead.** Every reader meets the same ternary pattern and re-derives why.
- **No build-time enforcement.** A Tauri-only module (`tray`, `fs`, `globalShortcutManager`) accidentally imported from a web-facing path produces a runtime null reference, not a build error.

The fix is to separate the two decisions and give each the mechanism it deserves.

## Principle

- **Build-time facts** (the platform target) belong in build config. The bundler resolves them; the wrong impl never enters the bundle.
- **Runtime facts** (user preferences) belong in code. A switch statement reads settings.

The mechanism we recommend matches what VS Code, React Native, Metro, and similar large cross-platform codebases all use: **filename suffixes resolved by the bundler.**

## Mechanism: Vite `resolve.extensions` with `.tauri.ts` / `.web.ts`

Vite resolves bare module specifiers by trying file extensions in `resolve.extensions` order. By overriding that array per build target, the same import resolves to different files in each build.

### Convention

A module that needs platform variants has:

- `foo.ts`: default/web implementation (lives at the natural feature location)
- `foo.tauri.ts`: Tauri-specific override (sibling, same exports)

```
$lib/clipboard/
  service.ts         ← web impl + the shared interface (re-exported types)
  service.tauri.ts   ← Tauri impl, same exports
  rpc.ts             ← TanStack adapters, platform-agnostic
```

Consumers always write `import { ClipboardService } from '$lib/clipboard/service'`. They never name the platform.

### Vite config

```ts
// vite.config.ts
import { defineConfig } from 'vite';

const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.ts', '.tauri.js', '.js', '.json']
      : ['.web.ts', '.ts', '.web.js', '.js', '.json'],
  },
});
```

Build behavior:

- **Tauri build** sees `service.ts` AND `service.tauri.ts`. Vite tries `.tauri.ts` first, finds it, uses it. `service.ts` is never parsed.
- **Web build** sees the same files. Vite tries `.web.ts` first, doesn't find it, falls through to `.ts`. `service.tauri.ts` is never parsed.

### Tauri-only modules (no web fallback)

For services that don't exist on web (`tray`, `fs`, `cpal`, `autostart`, `globalShortcutManager`):

- `foo.tauri.ts` exists, `foo.ts` does **not** exist.
- Tauri build: resolves to `.tauri.ts`. Works.
- Web build: tries `.web.ts`, then `.ts`, neither exist. **Build error.**

This is the desired behavior. A web-bundled module accidentally importing a Tauri-only file fails at `vite build`, not at user runtime.

### Optional `.web.ts` explicit suffix

For services where the web impl is non-trivial and we want both files to make their target explicit:

- `foo.tauri.ts` + `foo.web.ts` (no `foo.ts`).
- Each build resolves to its target. Web build error if `.web.ts` missing; Tauri build error if `.tauri.ts` missing.

This is more explicit but requires both files. The recommendation: use plain `foo.ts` as the web default unless there's a reason to make the web target explicit.

### TypeScript handling

TypeScript needs to know which file to type-check against. Two patterns:

1. **Single tsconfig, both files present.** TypeScript sees both `service.ts` and `service.tauri.ts` and type-checks both. Each must satisfy the same export shape (enforced by a shared `types.ts` interface). Pro: simple. Con: TS may flag unused imports in `.tauri.ts` that look unused on the web build.

2. **Per-target tsconfigs with `moduleSuffixes`.** TypeScript 4.7+ supports `moduleSuffixes: ['.tauri', '']` to mirror the Vite resolution. Two `tsconfig.json` files extending a base. Pro: TS matches the actual build. Con: more config; needs CI to run both typechecks.

**Lean: pattern 1.** Both files visible to TS, both type-checked, shared interface in `types.ts`. The "unused import" noise is rare and easily ignored.

## Build-time DI vs runtime DI

A working rule. Apply the test to each existing branch and migrate accordingly.

### When build-time DI is right

The condition is decided when the bundle is produced. It cannot change for the lifetime of the bundle without a rebuild.

Examples in this codebase:

- **Clipboard**: Tauri uses native clipboard, web uses navigator clipboard. A Tauri build will never need the web impl.
- **Notifications**: Tauri uses native OS notifications, web uses browser notifications.
- **Recorder**: Tauri can use CPAL or navigator (currently a user setting, but the CPAL path itself only exists in Tauri).
- **Filesystem, tray, autostart, global shortcuts, command service**: Tauri-only.

**Pros of build-time DI:**

- **Smaller bundles.** Dead code never enters the artifact.
- **Stronger type safety.** Web bundle cannot accidentally import Tauri APIs (the file containing the import isn't in scope).
- **Build-time failure for misuse.** Importing a Tauri-only module from a web entry point fails `vite build`, not user runtime.
- **No `__TAURI_INTERNALS__` ternaries scattered through code.** Consumers are platform-blind.
- **Composable with feature folders.** The platform variant is local to the feature, not yanked into a separate folder.

**Cons of build-time DI:**

- **More files.** Two implementations per platform-bound service instead of one with branches.
- **Setup cost.** Vite config + (optional) tsconfig variants. One-time.
- **Less obvious from a file listing.** Reading `service.ts` alone doesn't tell you a `.tauri.ts` exists. Convention + grep mitigate this.
- **The "shared interface" discipline must hold.** Both files must export the same symbols with compatible types. A `types.ts` companion is the enforcement mechanism.

### When runtime DI is right

The condition is decided by the user or system at runtime and can change without rebuilding.

Examples in this codebase:

- **Transcription provider**: user picks OpenAI / Groq / Deepgram / Elevenlabs / Mistral / local in settings. Same bundle serves all choices.
- **Transformation provider**: similar.
- **Recording method** (CPAL vs navigator on Tauri): user setting `recording.method` decides which to use at start time. Only meaningful on the Tauri bundle, but still a runtime decision within that bundle.

**Pros of runtime DI:**

- **One bundle serves many configurations.** No multi-target build.
- **User changes don't require a reinstall.**
- **Branch lives in code that's read alongside its logic**: natural location.

**Cons of runtime DI:**

- **All implementations are bundled.** A web build with five transcription providers ships all five.
- **No build-time misuse check.** A bug that calls the wrong provider passes typecheck and ships.
- **A runtime branch every call.** Negligible perf cost; non-negligible noise in the code if pervasive.

### The cleanest split

Apply both. Each call site uses the mechanism that matches the decision's nature:

```ts
// Build-time: Vite picks the right clipboard at bundle time
import { writeText } from '$lib/clipboard/service';

// Runtime: user setting picks the transcription provider at call time
const provider = settings.get('transcription.selectedTranscriptionService');
switch (provider) {
  case 'OpenAI':   return services.openai.transcribe(blob);
  case 'Groq':     return services.groq.transcribe(blob);
  case 'Deepgram': return services.deepgram.transcribe(blob);
  // ...
}
```

The platform check is invisible to the call site. The provider switch is visible because the choice is genuinely a runtime fact the reader should know about.

## What does NOT need to move

- **The transcription provider switch.** Stays runtime DI. Each provider has one impl that works on both platforms (HTTP).
- **Runtime feature flags.** Stays runtime DI.
- **Settings-driven behavior in general.** Stays runtime DI.
- **Services with only one impl across all platforms.** Don't need a `.tauri.ts` variant; they're just `.ts`.

## File inventory

These are every platform-bound file in the codebase today. The migration touches exactly these; nothing else.

### Services with both web and Tauri impls (8)

Currently the `index.ts` + `web.ts` + `desktop.ts` + `types.ts` ternary pattern. All migrate to `index.ts` + `index.tauri.ts` + `types.ts`.

| Folder                    | Today                                | After                                |
| ------------------------- | ------------------------------------ | ------------------------------------ |
| `services/analytics/`     | `index.ts` + `web.ts` + `desktop.ts` | `index.ts` + `index.tauri.ts`        |
| `services/blob-store/`    | `index.ts` + `web/` + `desktop.ts`   | `index.ts` + `index.tauri.ts` (note: `web/` subfolder content folds into `index.ts` or stays as supporting files) |
| `services/download/`      | `index.ts` + `web.ts` + `desktop.ts` | `index.ts` + `index.tauri.ts`        |
| `services/http/`          | `index.ts` + `web.ts` + `desktop.ts` + `tauri-fetch.ts` | `index.ts` + `index.tauri.ts` (tauri-fetch becomes supporting file used only by tauri impl) |
| `services/notifications/` | `index.ts` + `web.ts` + `desktop.ts` | `index.ts` + `index.tauri.ts`        |
| `services/os/`            | `index.ts` + `web.ts` + `desktop.ts` | `index.ts` + `index.tauri.ts`        |
| `services/sound/`         | `index.ts` + `web.ts` + `desktop.ts` | `index.ts` + `index.tauri.ts`        |
| `services/text/`          | `index.ts` + `web.ts` + `desktop.ts` | `index.ts` + `index.tauri.ts`        |

### Tauri-only services (8): `services/desktop/` dissolves

Currently nested under `services/desktop/`. Each moves up one level and becomes a folder with only `index.tauri.ts`.

| Today                                             | After                                   |
| ------------------------------------------------- | --------------------------------------- |
| `services/desktop/autostart.ts`                   | `services/autostart/index.tauri.ts`     |
| `services/desktop/command.ts`                     | `services/command/index.tauri.ts`       |
| `services/desktop/ffmpeg.ts`                      | `services/ffmpeg/index.tauri.ts`        |
| `services/desktop/fs.ts`                          | `services/fs/index.tauri.ts`            |
| `services/desktop/global-shortcut-manager.ts`     | `services/global-shortcut-manager/index.tauri.ts` |
| `services/desktop/permissions.ts`                 | `services/permissions/index.tauri.ts`   |
| `services/desktop/tray.ts`                        | `services/tray/index.tauri.ts`          |
| `services/desktop/recorder/cpal.ts`               | `services/recorder/cpal.tauri.ts` (sibling of `navigator.ts`) |
| `services/desktop/index.ts` (barrel)              | **deleted**                              |

The `services/desktop/` folder ceases to exist after this migration.

### Recorder: the one tricky case

The recorder is a hybrid:

- `services/recorder/navigator.ts`: works on both platforms, unchanged.
- `services/desktop/recorder/cpal.ts`: Tauri-only, moves to `services/recorder/cpal.tauri.ts`.
- `state/manual-recorder.svelte.ts`: currently does `deviceConfig.get('recording.method') === 'cpal' ? cpalRecorder : navigatorRecorder` (a *runtime* decision inside the Tauri build, because the user picks the method in settings).

After the migration, the state file must compile on web (where `cpal.tauri.ts` does not resolve) AND on Tauri. The solution:

`services/recorder/index.ts` (web) exports `cpalRecorder` as `null`:
```ts
export { NavigatorRecorderServiceLive as navigatorRecorder } from './navigator';
export const cpalRecorder: RecorderService | null = null;
```

`services/recorder/index.tauri.ts` exports the real CPAL service:
```ts
export { NavigatorRecorderServiceLive as navigatorRecorder } from './navigator';
export { CpalRecorderServiceLive as cpalRecorder } from './cpal.tauri';
```

Both files satisfy a shared type defined in `services/recorder/types.ts`:
```ts
export type RecorderModule = {
  navigatorRecorder: RecorderService;
  cpalRecorder: RecorderService | null;
};
```

The state file becomes:
```ts
function recorderService() {
  if (cpalRecorder && deviceConfig.get('recording.method') === 'cpal') {
    return cpalRecorder;
  }
  return navigatorRecorder;
}
```

The `cpalRecorder &&` runtime null-check is the seam between build-time platform DI and the runtime user setting. It's correct on both platforms: on web, `cpalRecorder` is `null`, so the check short-circuits. On Tauri, the user setting controls the choice.

### Consumer call sites with `isTauri()` / `__TAURI_INTERNALS__`

Most consumer-side platform checks are about feature gating in the UI, not service selection. These do **not** migrate to the suffix convention: they're runtime UI decisions:

- `routes/(app)/(config)/settings/+page.svelte`: shows Tauri-only sections
- `routes/(app)/_components/AppLayout.svelte`, `VerticalNav.svelte`: Tauri-only menu items
- `routes/(app)/(config)/recordings/+page.svelte`: "file system" vs "IndexedDB" label
- ~15 other UI files

These stay as `{#if window.__TAURI_INTERNALS__}` because they're rendering decisions inside a single component, not service-impl selection. The `$lib/services/*` migration does not touch them.

## Vite config (exact)

`apps/whispering/vite.config.ts`:

```ts
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.tauri.js', '.ts', '.js', '.json', '.svelte']
      : ['.ts', '.js', '.json', '.svelte'],
  },
  // ... existing config
});
```

Notes:
- On Tauri builds, `.tauri.ts` is tried first; missing → falls through to `.ts`.
- On web builds, `.tauri.ts` is NOT in the extensions list, so a web bundle that imports a Tauri-only path fails at build time. This is the desired safety: web cannot accidentally bundle Tauri code.
- `TAURI_ENV_PLATFORM` is set by Tauri's CLI automatically during `tauri dev` and `tauri build`. No manual env var management.

## tsconfig (exact)

Single `tsconfig.json`. Both `.ts` and `.tauri.ts` files are visible to TypeScript and must satisfy `types.ts`. No `moduleSuffixes`. Reasoning:

- TS type-checks the whole tree once.
- Both impls must compile against the same `types.ts` interface, so divergence is caught.
- The minor "unused import" noise on the web build for Tauri-only API imports inside `.tauri.ts` files is acceptable (those files are valid TS; TS doesn't know they're not bundled on web).

If `moduleSuffixes` is wanted later for per-target type-checking, that's a separate change. Not in this spec.

## README discipline (required, not optional)

Each service folder MUST have a `README.md` after migration. Minimum content:

```md
# <Service Name>

**Platform-bound**: web (`index.ts`), Tauri (`index.tauri.ts`).
Interface: `types.ts`.

<one paragraph on what this service does>

## Implementations

- `index.ts`: Web impl using <browser API>.
- `index.tauri.ts`: Tauri impl using <Tauri API or Rust command>.

Both files MUST satisfy the type exported from `types.ts`.
```

For Tauri-only services:

```md
# <Service Name>

**Tauri-only**: `index.tauri.ts`. No web fallback.
Interface: `types.ts`.

Importing this service from a web-bundled module is a build error by design.
```

Top-level `services/README.md` is rewritten in Wave 5 to describe the suffix convention as the project convention.

## Migration plan

### Wave 1: Wire up Vite (one PR, no service touched)

- [ ] Edit `apps/whispering/vite.config.ts` to set `resolve.extensions` based on `process.env.TAURI_ENV_PLATFORM`.
- [ ] Create `apps/whispering/src/lib/.platform-probe.ts` (web stub: `export const target = 'web';`) and `apps/whispering/src/lib/.platform-probe.tauri.ts` (`export const target = 'tauri';`).
- [ ] In `routes/(app)/+layout.svelte` (or any entry), add a dev-only `console.log` importing the probe.
- [ ] `bun run dev` on web: log says `web`. `bun run dev:local` (Tauri): log says `tauri`.
- [ ] Delete the probe files and the console.log.
- [ ] Commit.

### Wave 2: Single-service smoke test: pick `text` (smallest, no recorder complexity)

- [ ] Move `services/text/web.ts` content into a new `services/text/index.ts` (delete the old `index.ts` ternary).
- [ ] Move `services/text/desktop.ts` content into `services/text/index.tauri.ts`.
- [ ] Delete `services/text/web.ts` and `services/text/desktop.ts`.
- [ ] Verify `services/text/types.ts` is the shared interface; both new files satisfy it.
- [ ] Run `bun run typecheck`: zero errors expected.
- [ ] Run `bun run dev` (web) and `bun run dev:local` (Tauri); manually exercise a text/clipboard read in each. Smoke test passes.
- [ ] Add `services/text/README.md` per the discipline above.
- [ ] Commit.

If wave 2 fails (Vite resolution gotcha, TS type mismatch), stop and fix the convention before doing any more.

### Wave 3: Bulk-migrate the remaining seven dual-impl services

One commit per service. Same shape as wave 2. Order:

- [ ] `services/sound/`: small, no external deps
- [ ] `services/notifications/`: small
- [ ] `services/os/`: small
- [ ] `services/download/`: small
- [ ] `services/analytics/`: small
- [ ] `services/http/`: medium, also fold `tauri-fetch.ts` into the Tauri impl
- [ ] `services/blob-store/`: medium, has a `web/` subfolder that may stay as supporting files

Each commit:
- Rename files.
- Delete old `index.ts` ternary.
- Update any imports that referenced `desktop.ts` or `web.ts` directly (rare; the ternary `index.ts` is usually the only import path).
- Add the service README.
- `bun run typecheck` clean.

### Wave 4: Dissolve `services/desktop/`

One commit per Tauri-only service. Each moves out of `desktop/` and becomes its own service folder with only `index.tauri.ts`.

- [ ] `services/desktop/autostart.ts` → `services/autostart/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/command.ts` → `services/command/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/ffmpeg.ts` → `services/ffmpeg/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/fs.ts` → `services/fs/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/global-shortcut-manager.ts` → `services/global-shortcut-manager/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/permissions.ts` → `services/permissions/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/tray.ts` → `services/tray/index.tauri.ts` + `types.ts`
- [ ] `services/desktop/recorder/cpal.ts` → `services/recorder/cpal.tauri.ts` (this one is a sibling of `navigator.ts`, not a separate service folder)

Update every consumer that imported `from '$lib/services/desktop'` or `from '$lib/services/desktop/<x>'` to import from the new location.

Delete `services/desktop/index.ts` and the empty `services/desktop/` folder.

### Wave 5: Recorder special-case wiring

- [ ] Create `services/recorder/types.ts` `RecorderModule` type (defined above).
- [ ] Create `services/recorder/index.ts` (web): exports `navigatorRecorder`, `cpalRecorder: null`.
- [ ] Create `services/recorder/index.tauri.ts`: exports `navigatorRecorder`, `cpalRecorder`.
- [ ] Update `state/manual-recorder.svelte.ts` `recorderService()` to use the null-check pattern documented above.
- [ ] Verify web typecheck and runtime: clicking "record" on web works (uses navigator).
- [ ] Verify Tauri typecheck and runtime: clicking "record" on Tauri uses navigator OR CPAL based on settings.

### Wave 6: Cleanup + docs

- [ ] Top-level `services/README.md` rewritten to describe the suffix convention.
- [ ] `ARCHITECTURE.md` updated: replace the runtime-DI examples with build-time-DI examples.
- [ ] Grep `apps/whispering/src/lib` for `isTauri()` and `__TAURI_INTERNALS__`. Each remaining hit is either:
  - A UI feature gate (acceptable, leave it).
  - A leftover from a previous migration step (delete it).
- [ ] Verify each remaining hit is intentional.

### Wave 7: Bundle audit (verification, not a code change)

- [ ] `bun run build` (web build).
- [ ] Inspect the build output for any `@tauri-apps/*` imports. There should be **zero**.
  - Method: `bun run build && grep -r "@tauri-apps" build/`: should return nothing.
- [ ] Note web bundle size before and after. The reduction is the visible win.
- [ ] `bun tauri build` succeeds.

## Locked decisions

1. **Default = web. Override = `.tauri.ts`.** Web is the unsuffixed file (`.ts`). Tauri-specific impl is `<name>.tauri.ts`. We do not use `.web.ts`; the absence of a suffix means web. This matches React Native's pattern, minimizes file count, and biases toward the broader audience as the default.

2. **Suffix name: `.tauri.ts`** (not `.desktop.ts`). The file uses Tauri APIs; "tauri" is what's actually true. A future iOS/Android Tauri build is still "tauri."

3. **Single tsconfig.** Both `index.ts` and `index.tauri.ts` are visible to TypeScript and must satisfy a shared interface in `types.ts`. No `moduleSuffixes`. The shared interface is the contract; type-checking both files prevents drift.

4. **`services/desktop/` dissolves.** Each currently-desktop-only service moves into its own top-level service folder under `services/<name>/` and exposes only an `index.tauri.ts`. The web build will produce a build-time error if any web-bundled module imports such a service: that error is the whole point.

5. **Composability with feature folders.** Orthogonal. The feature-folder spec inherits the `.tauri.ts` suffix convention unchanged when service code moves into feature folders.

6. **No backward compatibility.** Old `desktop.ts`, `web.ts`, and `index.ts` ternary files are deleted, not deprecated. Single PR per service. Type errors during migration are expected and resolved within the same PR.

## Risks

1. **Vite `resolve.extensions` and `node_modules`.** `resolve.extensions` is global: it applies to imports inside `node_modules` too. If a library happens to import `./foo` and a `foo.tauri.ts` exists in its dist tree (vanishingly unlikely), it would be picked up. Confirmed during wave 1 by inspecting `node_modules` for any `.tauri.ts` files (`find node_modules -name '*.tauri.ts'` should return nothing). Not a real risk for this codebase, but document the check.

2. **Hot reload.** Vite dev mode HMR should pick up a new `.tauri.ts` file. Verified in wave 1.

3. **Two implementations drift.** `index.ts` and `index.tauri.ts` could diverge silently. Mitigation: the shared `types.ts` interface is the enforcement; TS type-checks both files against it.

4. **Bundle audit is the final word.** Tree-shaking and dead-code elimination are good but bundle inspection (wave 7) is non-optional. Without it we don't know we won.

5. **Recorder hybrid case.** Build-time platform DI for CPAL availability, runtime user-setting DI for CPAL vs navigator choice within the Tauri build. The null-check pattern documented in the recorder section is the seam between the two mechanisms.

6. **Existing UI `__TAURI_INTERNALS__` checks remain.** These are runtime UI feature gates, not service-impl selection. They are out of scope for this migration. Wave 6 verifies each remaining hit is intentional.

## Why this is a bigger unblock than feature folders

The feature-folder spec is about code locality. The platform-DI spec is about correctness, bundle size, and type safety. The platform-DI change has measurable benefits (smaller web bundle, build-time enforcement of platform boundaries) that the feature-folder change doesn't. Doing platform-DI first also means feature folders inherit a cleaner story for where platform-specific code lives (right next to the feature, with a `.tauri.ts` suffix).

**Recommended sequence:**

1. Platform-DI spec (this one): gives every feature a clean platform-variant pattern.
2. Feature-folder spec: moves things around with the platform pattern already settled.

Doing them in this order means feature folders don't have to invent a platform story; they inherit one.

## First concrete move

**Wave 1 is the next commit.** Vite config change + ephemeral probe pair + smoke verification. If it works, wave 2 (the `text` service smoke test) follows in the same session. The dual-impl service migrations (wave 3) are then mechanical and can be done in a single sitting.

Estimated waves 1+2 together: ~30 minutes. Waves 3+4: ~1-2 hours. Waves 5+6+7: ~1 hour.

Total estimate: half a working day for the full clean break, with each wave individually revertable.
