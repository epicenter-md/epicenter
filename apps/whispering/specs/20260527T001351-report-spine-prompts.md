# Report Spine: Agent Execution Prompts

Companion to `20260527T001351-report-spine.md`. Each prompt is self-contained: an agent can read the spec and execute without back-and-forth.

Execution note: completed on 2026-05-27 on branch
`codex/whispering-recorder-refactor`. Stage 2 expanded beyond the prompt list
to migrate every executable `notify.*` call site before Stage 3 demolition.

Dispatch order:
1. **Stage 1**: single agent, blocks all others.
2. **Stage 2**: multiple agents in parallel after Stage 1 lands.
3. **Stage 3**: single agent after Stage 2 lands.

---

## Stage 1 prompt: Foundation

```
Build the foundation for the report spine described in
`apps/whispering/specs/20260527T001351-report-spine.md`. Read that spec fully
before starting.

This stage is additive: no existing code is modified. After you finish, both
the old `notify.*` and the new `report.*` paths must coexist and typecheck.

Create these files under `apps/whispering/src/lib/report/`:

1. `humanize.ts`
   - Export `humanize(variantName: string): string` that converts PascalCase
     tagged-error variant names into a human title. Examples:
       "PayloadTooLarge"  -> "Payload too large"
       "Unauthorized"     -> "Unauthorized"
       "MissingApiKey"    -> "Missing API key"
       "OAuthFlowFailed"  -> "OAuth flow failed"
       "HTTP500"          -> "HTTP 500"
   - Algorithm: split on uppercase boundaries; lowercase all non-first words
     EXCEPT preserve known acronyms (API, HTTP, URL, OAuth, OS, JSON, IP, DNS).
     Numbers stay attached to the preceding word.
   - Single function, no dependencies, fully covered by inline test cases at
     the bottom of the file using bun:test.

2. `types.ts`
   - Export:
       type NoticeAction = { label: string; onClick: () => void | Promise<void> };
       type Notice  = { title?: string; description?: string;
                        action?: NoticeAction; cause?: AnyTaggedError };
       type Problem = Notice & { cause: AnyTaggedError };
       type LoadingHandle = {
         resolve: (r: Notice)  => void;
         reject:  (r: Problem) => void;
         update:  (r: Notice)  => void;
         dismiss: () => void;
       };
       type Level = 'error' | 'success' | 'info' | 'loading';
   - Import AnyTaggedError from 'wellcrafted/error'.

3. `sinks/console.ts`
   - Re-export `consoleSink` from `wellcrafted/logger`. (Single-line file:
     this just centralises the import surface for future swaps.)

4. `sinks/memory.ts`
   - Wrap `memorySink({ capacity: 100 })` from `wellcrafted/logger`. Export
     the bound sink plus a `getRecent()` accessor so dev tools / support can
     dump it. NOT a UI surface.

5. `sinks/toast.ts`
   - Export `toastSink: LogSink` using `@epicenter/ui/sonner`.
   - Reads `event.level` to pick the Sonner method (error/success/info/loading).
   - Reads `event.data` as `Notice | Problem`.
   - Title default: `event.data.title ?? humanize(event.data.cause?.name ?? '') || 'Notice'`.
   - Description default: `event.data.description ?? event.data.cause?.message`.
   - Action: `event.data.action` wins; else for `Problem` without explicit action,
     render a "More details" button that opens `moreDetailsDialog` with the cause.
   - Duration: error -> Infinity (persist); success -> 3000; info -> 4000;
     loading -> Infinity (until handle resolves).

6. `sinks/os-notify.tauri.ts` and `sinks/os-notify.browser.ts`
   - Export `osNotifySink: LogSink`.
   - Gate: emit only when `event.level === 'error' && !document.hasFocus()`.
   - Tauri: dispatch via `@tauri-apps/plugin-notification` sendNotification
     with `{ title, body }` only. No id, no icon, no silent, no autoCancel
     overrides. No removal of prior notifs.
   - Browser: native `new Notification(title, { body })` after permission
     check. No tag, no requireInteraction, no silent.
   - Both: fire-and-forget; if delivery throws, swallow (log via console.error
     once at construction-time if permissions are blocked).

7. `sinks/index.ts`
   - Export `reportSink = composeSinks(consoleSink, memorySinkBound, toastSink, osNotifySink)`.
   - Export `log = createLogger('whispering/report', reportSink)`.

8. `index.ts`
   - Export the public `report` object:
       report.error(p: Problem)          -> emits 'error' via log+sink
       report.success(n: Notice)         -> emits 'success'
       report.info(n: Notice)            -> emits 'info'
       report.loading(n: Notice)         -> returns LoadingHandle
   - Loading handle internals: track a nanoid as toast id; resolve/reject/update
     reuse the id; sonner.dismiss(id) on dismiss. resolve emits at level
     'success', reject at level 'error', update emits at level 'loading'.
   - Internal `emit(level, data)`:
       sink({ ts: Date.now(), level, source: 'whispering/report',
              message: data.title ?? data.cause?.message ?? '', data });
       if (level === 'error' && data.cause) log.error(data.cause);
       else if (data.cause)                 log.info(data.title ?? '', data);
       (i.e., explicit log only for level === 'error'; other levels are
        covered by the sink's own consoleSink fan-out.)

Constraints:
- Use the build-time DI suffix convention (`.tauri.ts`/`.browser.ts`) per
  `apps/whispering/AGENTS.md`. Browser fallback for OS notify is required.
- No console.* directly in library code; use wellcrafted/logger.
- No `try/catch`; use wellcrafted Result types for anything that can fail.
- Do NOT modify `apps/whispering/src/lib/result.ts`, `notify.ts`,
  `services/toast.ts`, or any caller. This stage is purely additive.

When done:
- `bun run typecheck` from repo root must pass.
- Write a brief PR-style report: files created, lines added, anything that
  surprised you.
```

---

## Stage 2 prompts: Migrate call sites (run in parallel)

Each prompt below is independent. Dispatch them only after Stage 1 lands.

### 2A: `pipeline.ts` and `delivery.ts`

```
Migrate two files to use the new report spine (built in Stage 1, see
`apps/whispering/specs/20260527T001351-report-spine.md`):
  - apps/whispering/src/lib/operations/pipeline.ts
  - apps/whispering/src/lib/operations/delivery.ts

Replace every `notify.*` call with the appropriate `report.*` call. Routing
guide:
  - notify.error   -> report.error    (still requires `cause` if there is one)
  - notify.success -> report.success
  - notify.loading -> report.loading (returns LoadingHandle, no string id)
  - notify.warning -> EITHER report.error (if the user should know / might
                      act on it) OR report.info (if we recovered). Decide
                      per call site: see the spec's call site examples.
  - notify.info    -> report.info
  - notify.dismiss(id) -> handle.dismiss()

Specifics:
- Stop threading `toastId: string` parameters across function boundaries.
  Use `LoadingHandle` (returned by `report.loading`) and pass IT through
  if a downstream needs to update the same toast. Change function signatures
  as needed.
- Where the current code reads `error.name === 'WhisperingError'` and does
  notify[error.severity](error), replace with a plain `report.error/info`
  call. The error is now always a tagged error; pass it as `cause`.
- For auto-derived title/description, just pass `{ cause: err }`; trust the
  defaults.
- For the "no transformation selected" case at pipeline.ts:118-129: use
  report.info with the existing link action shape. No cause to attach.
- For the "Audio not saved" case at pipeline.ts:94-100: report.error
  with cause (data-loss-adjacent: user should know).
- For the "Couldn't write to cursor, here's a copy button" case in delivery.ts:
  this is recovered, becomes report.info with the existing copy action and
  the cause attached for logging.
- For the "Couldn't copy to clipboard" case in delivery.ts:54-60: this is
  not recovered (no fallback action). Becomes report.error.

Do not touch the transcription services (cloud/local/self-hosted) in this
agent. Those are a separate stage.

Constraints:
- AGENTS.md hygiene (no em/en dashes, no console.*, no try/catch).
- After your edits, `bun run typecheck` from repo root must pass. The
  old `notify.*` and `WhisperingErr` symbols still exist (other call sites
  still use them): don't break them.
- Stage your changes with `git add <file>` (no `git add -A`). Do not commit;
  the user will review.

Report: list of every `notify.X` -> `report.Y` mapping you made, with a one-
line rationale for any `warning -> error` vs `warning -> info` decision.
```

### 2B: Cloud transcription services

```
Delete the `toWhisperingErr` sidecar from every cloud transcription service
under `apps/whispering/src/lib/services/transcription/cloud/`. The new
design (see `apps/whispering/specs/20260527T001351-report-spine.md`) does
translation at the call site, not in the service.

Files:
  - openai.ts
  - groq.ts
  - mistral.ts
  - elevenlabs.ts
  - deepgram.ts

For each file:
  1. Remove the `toWhisperingErr` method from the *Live object.
  2. Remove the imports of `WhisperingErr`, `* as toasts`, and any
     `transcription-errors/shared` import.
  3. Keep `transcribe` returning `Result<string, <ProviderError>>` (the
     tagged error). No changes to the defineErrors block itself unless you
     find variant names that won't humanize well (use the humanize rules in
     `apps/whispering/src/lib/report/humanize.ts` as a sanity check:
     rename obviously bad variants while you're here).

Then update `apps/whispering/src/lib/operations/transcribe.ts`:
  - `dispatchTranscription` currently returns
    `Promise<Result<string, WhisperingError>>`. Change to
    `Promise<Result<string, TranscriptionError>>` where TranscriptionError
    is a union of every provider's error type (or simpler: AnyTaggedError
    if the caller doesn't need to narrow).
  - Remove every `services.transcriptions.X.toWhisperingErr(error)` call;
    return the tagged error directly: `if (error) return Err(error);`.
  - Update the analytics call (`analytics.logEvent({ type:
    'transcription_failed', ... })`) to read `error.name` and `error.message`
    directly from the tagged error instead of `error.title` / `error.description`.

For the speaches self-hosted service and the local services (whispercpp,
parakeet, moonshine), see the separate prompts (2C, 2D): do NOT modify
them here.

Constraints:
- AGENTS.md hygiene.
- `bun run typecheck` must pass. The call sites in `pipeline.ts` might still
  use `WhisperingError` shape from `transcribeArtifact`'s return; that's
  fine if Stage 2A hasn't landed yet. But coordinate the merge order.
  Easiest: land 2B BEFORE 2A so transcribe's return is already a tagged
  error when pipeline.ts gets rewritten.

Report: per-service, the count of lines removed and the resulting return
type of `transcribe`.
```

### 2C: Self-hosted and local transcription services

```
Convert these services from returning prebaked `WhisperingError` shapes to
returning tagged errors via defineErrors:

  - apps/whispering/src/lib/services/transcription/self-hosted/speaches.ts
  - apps/whispering/src/lib/services/transcription/local/whispercpp.ts
  - apps/whispering/src/lib/services/transcription/local/parakeet.ts
  - apps/whispering/src/lib/services/transcription/local/moonshine.ts
  - apps/whispering/src/lib/services/transcription/local/local-transcription.ts

See the new design in
`apps/whispering/specs/20260527T001351-report-spine.md`.

For each file:
  1. Define (or extend) a tagged error using `defineErrors` from
     'wellcrafted/error'. One error type per service, e.g.
     `SpeachesError`, `WhisperCppError`, etc. Variant names must humanize
     cleanly per the rules in `apps/whispering/src/lib/report/humanize.ts`.
  2. Convert every `WhisperingErr({ title, description, action })` call
     into a tagged-error variant constructor. Drop the title/description
     strings. The message field of defineErrors carries the human text;
     auto-derive will fill the UI. Keep the message string the same as the
     description used to be.
  3. Update the function signature from `Promise<WhisperingResult<string>>`
     to `Promise<Result<string, <ServiceError>>>`.

Then update `dispatchTranscription` in
`apps/whispering/src/lib/operations/transcribe.ts` to reflect the new return
types. These services previously already returned `WhisperingResult` so
no `toWhisperingErr` adapter is involved, just the return type.

Constraints:
- AGENTS.md hygiene.
- `bun run typecheck` must pass.
- Don't migrate any cloud service (see 2B).
- Don't touch pipeline.ts / delivery.ts (see 2A).

Report: per-service, the new tagged-error variants and the call sites
upstream that need a follow-up because their types changed.
```

### 2D: Other `WhisperingErr` consumers

```
Find every remaining consumer of `WhisperingErr` / `WhisperingError` /
`WhisperingResult` in `apps/whispering/src` (excluding the files explicitly
covered by other Stage 2 agents: pipeline.ts, delivery.ts,
transcribe.ts, transcription/cloud/*, transcription/self-hosted/*,
transcription/local/*).

Likely files based on a quick grep:
  - apps/whispering/src/lib/tauri.tauri.ts
  - apps/whispering/src/lib/state/manual-recorder.svelte.ts
  - apps/whispering/src/lib/state/vad-recorder.svelte.ts
  - apps/whispering/src/lib/rpc/download.ts
  - apps/whispering/src/lib/rpc/transformer.ts
  - apps/whispering/src/lib/rpc/transcription.ts
  - apps/whispering/src/lib/services/text/types.ts (writeToCursor signature)
  - apps/whispering/src/routes/(app)/+page.svelte
  - apps/whispering/src/routes/(app)/(config)/recordings/row-actions/RecordingRowActions.svelte
  - apps/whispering/src/routes/(app)/_layout-utils/check-for-updates.ts

For each:
  - If it produces a `WhisperingErr(...)`: convert to a domain tagged error
    via defineErrors. Where the call site is in `state/*` or `routes/*`
    (i.e. UI / Svelte), it may be appropriate to just inline `report.error`
    instead of returning a Result at all.
  - If it consumes a `WhisperingError`: switch to `report.error({ cause: err })`
    or `report.info({ cause: err, ... })` per the routing rules in the spec.
  - For `writeToCursor`'s return type `Result<void, TextError | WhisperingError>`:
    narrow to `Result<void, TextError>`. Add a new `TextError` variant if
    the macOS-permission case had richer copy attached. The caller can
    inline-override at call site if it wants a settings CTA.

Constraints:
- AGENTS.md hygiene.
- `bun run typecheck` must pass.
- Don't touch the files explicitly assigned to other Stage 2 agents.

Report: per file, the changes made and any cases you weren't sure about.
```

---

## Stage 3 prompt: Demolition

```
All call sites have been migrated to the report spine described in
`apps/whispering/specs/20260527T001351-report-spine.md`. This stage deletes
the old machinery.

Pre-flight (must be true before you start):
  bun x rg "WhisperingErr|WhisperingError|WhisperingResult" apps/whispering/src
should return zero matches. If it doesn't, stop and report which file still
references those symbols, that's a Stage 2 miss.

Delete these files:
  - apps/whispering/src/lib/result.ts
  - apps/whispering/src/lib/operations/notify.ts
  - apps/whispering/src/lib/services/toast.ts
  - apps/whispering/src/lib/rpc/transcription-errors/shared.ts
  - apps/whispering/src/lib/components/NotificationLog.svelte (if it exists)

Simplify these files:
  - apps/whispering/src/lib/services/notifications/types.ts
    * Delete the `UnifiedNotificationOptions` type or shrink it to
      `{ id?: string; title: string; description: string }`. (Only used by
      the new os-notify sink internally; if the sink doesn't import it,
      delete the type.)
    * Delete `LinkAction`, `ButtonAction`, `MoreDetailsAction`,
      `NotificationAction` types.
    * Delete `toTauriNotification`, `toBrowserNotification`,
      `hashNanoidToNumber`.
    * Keep `NotificationError` only if any remaining code uses it.
  - apps/whispering/src/lib/services/notifications/index.tauri.ts
    * Delete `removeNotificationById` and the active-listing /
      `removeActive` logic.
    * The file may become so thin that you should delete it and inline
      whatever the os-notify sink needs.
  - apps/whispering/src/lib/services/notifications/index.browser.ts
    * Same treatment.
  - apps/whispering/src/lib/services/index.ts
    * Drop the `toast` and `notification` service exports if no consumer
      remains.

Then:
  - Run `bun run typecheck` from repo root. Fix any stragglers.
  - Run `bun x rg "notify\.(error|warning|warn|success|info|loading|dismiss)" apps/whispering/src`
    to confirm no residual `notify.*` calls. Should be zero.
  - Run `bun x rg "notificationLog" apps/whispering/src`. Should be zero.
  - Skim the diff for dead imports.

Constraints:
- AGENTS.md hygiene.
- If you find a Stage 2 miss, stop immediately and report: do not patch it
  in this stage.
- Do not edit the report spine or the sinks built in Stage 1.

Report: files deleted (with LOC count), files simplified (with LOC delta),
total LOC removed in this stage.
```

---

## Notes for the dispatcher

- Stage 1 must merge before any Stage 2.
- Stage 2B (cloud services) should land before 2A (pipeline.ts) so
  `transcribe.ts`'s return type is already a tagged error when 2A rewrites
  pipeline.ts. If you want strict parallelism, 2A can read the spec's API
  sketch and write against the *new* return type, leaving the type
  mismatch as a typecheck failure that disappears when 2B lands.
- 2C and 2D can run anytime after Stage 1.
- Stage 3 only after all Stage 2 PRs are merged.
