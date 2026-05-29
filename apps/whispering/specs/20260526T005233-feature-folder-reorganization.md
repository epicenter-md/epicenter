# Feature-Folder Reorganization

**Status**: Proposed
**Type**: Architectural restructure (zero behavior change)
**Scope**: `apps/whispering/src/lib/`

**Supersession note (2026-05-29)**: The recording service sketch below predates
the manual recording clean break. The old shared start params type no longer
exists; manual recorder params are platform-specific and built by
`manual-recorder-params.*.ts`.

## Problem

The current `$lib/` structure organizes by mechanism, not by feature:

```
$lib/
  services/   : pure IO        ┐
  state/      : reactive       │ five mechanism-based layers,
  operations/ : orchestrations │ every feature spread across all of them
  rpc/        : TanStack       │
  constants/  : shared types   ┘
```

A single domain like "recording" lives in:

- `services/recorder/{types,navigator,index}.ts`
- `services/desktop/recorder/cpal.ts`
- `state/{manual-recorder,vad-recorder,device-config}.svelte.ts`
- `operations/recording.ts`
- `operations/pipeline.ts` (cross-feature)
- `operations/shortcuts.ts` (cross-feature)
- `constants/audio/recording-states.ts`
- `routes/(app)/_components/ManualRecordingButton.svelte`

To understand one feature, you read fragments in eight folders. To add a new feature, you touch five top-level folders and inherit their cross-folder dependency rules.

The mechanism-based split also forces artificial rules. The recent `rpc/` rename + rule rewrite removed the worst offender ("which folder gets a defineMutation that needs side effects"), but the underlying smell remains: cross-folder rules exist because the folders weren't drawn around the things that actually depend on each other. Locality is the cure; this spec lays out a path to it.

## Principle

**Folders answer "what does this code do," not "what library did we use."** A feature is the unit of comprehension and the unit of change. Internal layering (service → state → use-cases) stays inside the feature folder where it can be enforced by file proximity, not by a global ruleset.

## Target shape (one feature)

```
$lib/recording/
  service/
    types.ts         : DeviceIdentifier, RecorderError, platform params
    navigator.ts     : Web MediaRecorder impl
    cpal.ts          : Tauri/Rust impl
    index.ts         : platform selector (Tauri vs web)
  state.svelte.ts    : manualRecorder + vadRecorder singletons
  use-cases.ts       : startManualRecording, stopManualRecording, cancel,
                        startVadRecording, stopVadRecording
  devices.ts         : defineQuery for enumerateDevices (TanStack adapter)
  constants.ts       : WhisperingRecordingState, VadState, MIME types
  README.md
```

Imports inside the folder are short (`./service`, `./state.svelte`). Imports from outside the folder enter through a small set of named exports. Cross-feature dependencies become visible because they cross folder boundaries.

## Top-level shape (after migration)

```
$lib/
  recording/         : domain feature
  transcription/     : domain feature
  transformation/    : domain feature
  clipboard/         : domain feature
  audio-blob/        : domain feature (recording storage + playback)
  shortcuts/         : domain feature
  upload/            : domain feature

  pipeline.ts        : cross-feature orchestration (record → transcribe → transform)
                        OR: $lib/pipeline/ if it grows

  shared/            : primitives nothing owns
    result.ts        : WhisperingErr, error types
    paths.ts         : PATHS
    notify.ts        : toast facade
    sound.ts         : sound facade
    analytics.ts     : analytics facade

  ui/                : components not bound to one feature
    settings/        : cross-feature settings panels

  workspace/         : Yjs/CRDT integration (currently shared infra)
  migration/         : already feature-organized
```

`services/`, `state/`, `operations/`, `rpc/` disappear as top-level concepts. Their files live inside the feature that owns them.

## Why this is worth doing

1. **Grep cohesion.** Searching for "recording" returns one folder, not eight.
2. **No cross-folder rules.** The `operations/ → rpc/ → services/` direction rule exists because the layers are global. Inside `recording/`, the same direction is enforced by file naming and proximity; no README needed.
3. **Cross-feature orchestrations become visible.** Today, `operations/pipeline.ts` quietly spans recording + transcription + transformation. In the new shape it has to live somewhere, and its location names what it is.
4. **Onboarding cost drops.** "Where does X live?" answers itself.
5. **The mechanism-based split was never load-bearing.** The recent rename of `query/ → rpc/` already disposed of one global rule. Feature folders dispose of the rest.

## Why this might not be worth doing

1. **Migration cost is real.** ~80 files to move, every import to update. Three commits to land cleanly; one big-bang risks merge conflicts with concurrent work.
2. **Half-migrated is worse than either pure state.** If we stop at three features migrated and three not, the codebase has two conventions side by side until cleanup. Need commitment to finish.
3. **"What's one feature" is fuzzy.** Is `audio-blob/` a feature or part of `recording/`? Is `shortcuts/` a feature or infra? Need to make these calls and accept some will look wrong in hindsight.
4. **Some primitives genuinely don't belong to a feature.** `notify`, `sound`, `analytics`, `result types`. They live in `shared/`, which can become a junk drawer if undisciplined.
5. **The acute pain motivating this is mild.** The README smell is largely gone after the `rpc/` rename. Doing the reorg is paying maintenance cost for future clarity, not fixing a current bug.

## Strategy: incremental, starter-first

Do **not** attempt a single PR rewriting the whole `$lib/`. Migrate one feature at a time, smallest first, learn from each.

### Starter: `clipboard`

Smallest possible migration. Current footprint:

- `services/clipboard/index.ts` + platform impls
- `rpc/text.ts` (defineQuery for `readFromClipboard`)
- `routes/transform-clipboard/+page.svelte` (consumer)

Becomes:

```
$lib/clipboard/
  service/
    types.ts
    web.ts
    tauri.ts
    index.ts
  rpc.ts             : defineQuery readFromClipboard (renamed from rpc/text.ts)
  README.md
```

Three files moved, one renamed, two consumers (`transform-clipboard/+page.svelte`, anywhere else `rpc.text` is used) updated. Single commit, hours not days. If something feels off after living with it for a week, we revert and reconsider before touching anything bigger.

### After clipboard works

Next migrations, in order of complexity:

1. **`transcription/`**: service + rpc adapter + error transformers + orchestration. Self-contained. Big payoff: `transcription-errors/` finally lives next to the service whose errors it transforms.
2. **`transformation/`**: similar shape, plus the runs UI.
3. **`recording/`**: largest, most cross-cutting. Tackle last when conventions are settled.
4. **`pipeline/`**: last move; by this point we know whether it's its own folder or inlines into `recording/use-cases.ts`.

Each migration is its own PR. After all four, `services/`, `state/`, `operations/`, `rpc/` are gone; `constants/` is reduced to truly shared values.

## Open decisions to resolve before starting

These are the calls that need to be made up-front so we don't relitigate per feature:

1. **Cross-feature orchestration home.** Options:
   - (a) `$lib/pipeline/` as its own folder.
   - (b) `$lib/use-cases/` for any cross-feature orchestration (pipeline lives there).
   - (c) Owned by the entry-point feature (pipeline lives in `recording/` since recording kicks it off).

   **Lean: (a).** Pipeline is its own thing with its own lifecycle. Inlining into recording hides it.

2. **Platform-selection pattern.** Currently `services/index.ts` exports `services` which uses `window.__TAURI_INTERNALS__` to pick implementations. After migration, each feature folder's `service/index.ts` does its own selection. **No global `services` barrel.** Direct imports from feature folders.

3. **Barrel for IntelliSense.** The `rpc` barrel currently aggregates all defineQuery/defineMutation for autocomplete. Options:
   - Keep a thin `$lib/rpc.ts` (no folder) that re-exports from feature folders.
   - Drop the barrel; use direct imports.

   **Lean: drop the barrel.** Direct imports are clearer and Vite handles them fine. The barrel was a holdover from the mechanism-organized world where everything reactive lived in one place.

4. **`shared/` discipline.** What earns a place in `shared/`?
   - `result.ts` (WhisperingError): yes, used everywhere.
   - `paths.ts`: yes, OS-aware paths.
   - `notify`, `sound`, `analytics`: these are facades over services. They could live in `shared/` or as their own feature folders. **Lean: feature folders** (`$lib/notify/`, etc.) because each has its own service + state. `shared/` should only contain unstyled primitives.

5. **`constants/` fate.** Most current `constants/` files are feature-specific (`audio/`, `keyboard/`, `sounds/`). These move to their owning feature. Truly cross-feature constants (`platform/`, `app/`) move to `shared/`.

## Migration template (one feature)

Repeated for each feature.

### Wave 1: Create folder + move pure files

- [ ] `mkdir $lib/<feature>/`
- [ ] `git mv` service files into `<feature>/service/`
- [ ] `git mv` state files into `<feature>/state.svelte.ts`
- [ ] `git mv` operations into `<feature>/use-cases.ts`
- [ ] `git mv` rpc adapter into `<feature>/rpc.ts` (or `devices.ts`, etc.)
- [ ] `git mv` feature-specific constants into `<feature>/constants.ts`

### Wave 2: Update internal imports

- [ ] Inside `<feature>/`, rewrite imports to relative paths (`./service`, `./state.svelte`)
- [ ] Verify no `$lib/services/<feature>` or `$lib/state/<feature>` remain inside the folder

### Wave 3: Update external imports

- [ ] Grep callers; rewrite `$lib/services/<x>`, `$lib/state/<x>`, `$lib/operations/<x>`, `$lib/rpc/<x>` to `$lib/<feature>/...`
- [ ] Update `rpc` barrel (until barrel is dropped)

### Wave 4: Write the feature README

- [ ] One-paragraph "what this folder does"
- [ ] File index with shape of each export
- [ ] Note any cross-feature dependencies (and why they're acceptable)

### Wave 5: Verify

- [ ] `bun run typecheck`: zero errors
- [ ] Manual smoke test of the feature's UI surface
- [ ] Single commit per feature

## First concrete move

Wave the clipboard migration as a standalone PR. After it's merged and lived for a week, decide whether to continue.

If the clipboard migration reveals the convention doesn't work (e.g., barrel turns out to be load-bearing, or `shared/` discipline breaks down), we stop and either revert or adjust the convention before touching anything else.

## What does NOT change

- Service implementations stay byte-identical.
- State runes stay byte-identical.
- Public component contracts stay byte-identical.
- TanStack Query options shape stays byte-identical.
- All behavior is preserved. This is pure restructure.
