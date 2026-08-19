# Deterministic Transformations

**Date**: 2026-08-18
**Status**: In Progress
**Owner**: Adam

## One sentence

Whispering applies every enabled Transformation in a synced, user-defined order to the raw transcript before optional AI Polish, while preserving both the raw ASR output and the final text selected for delivery.

## Overview

Restore Transformations as named groups of deterministic steps. Multiple Transformations may be enabled at once, they run locally in an explicit order, and they do not contain AI prompts, provider configuration, manual actions, or persisted run history.

This restores the useful part of the deleted subsystem without restoring the `transformation.selectedId` bottleneck or overlapping with Polish and Recipes.

## Current state

The automatic text path is:

```txt
transcribe
  -> persist raw text in recordings.transcript
  -> optional AI Polish
  -> persist AI output in recordings.polishedTranscript
  -> deliver once
```

`apps/whispering/src/lib/operations/transcribe.ts` currently contains an uncommitted integration of `normalizeSpokenUrls`. It rewrites provider output before `recordTranscriptionOutcome` persists it, so `recordings.transcript` is no longer the exact ASR output. That is the wrong ownership boundary even though the URL parser itself is useful.

Whispering previously had a Transformation subsystem. Its final data shape was:

```txt
preReplacements[]
  -> optional AI prompt
  -> postReplacements[]
```

A Transformation could contain many ordered replacement rules, but only the row referenced by `transformation.selectedId` ran automatically. Commits `44313b48d0` and `bac7a18fe7` replaced and then deleted the subsystem, including its editor, test pane, run history, picker, executor, and deterministic punctuation support.

[ADR-0099](../docs/adr/0099-replace-transformations-with-a-dictionary-polish-and-a-portable-recipe-library.md) correctly separated always-on correction from on-demand reshaping, but it also explicitly removed find/replace and regex processing. Dictionary, Polish, and Recipes do not replace deterministic local rewriting:

```txt
Dictionary       spelling context supplied to a model
Transformation   deterministic text-to-text steps
Polish           optional meaning-preserving AI cleanup
Recipe           on-demand AI reshape
```

## Target shape

```txt
provider ASR output
  -> persist recordings.transcript unchanged
  -> enabled Transformations, ordered, local, deterministic
  -> optional AI Polish
  -> persist recordings.deliveredTranscript
  -> deliver once
```

A Transformation is:

```txt
Transformation
  name
  description
  enabled
  position
  ordered steps
    find/replace       literal or regular expression
    spoken URLs        built-in deterministic parser
```

A fresh installation has no Transformations and therefore performs no deterministic rewriting. The person must create and enable one. The built-in Spoken URLs parser is available as a step type, not as unconditional behavior or a provisioned default row.

Transformation definitions, enabled state, and order are portable work. They use the same active work document as recordings and recipes: account-backed when signed in, device-backed when signed out.

## Product boundaries

### Transformations own

- Deterministic text rewriting.
- Ordered composition of several simultaneously enabled Transformations.
- Ordered composition of steps within one Transformation.
- Local execution with no network request.
- A configuration and test surface.

### Transformations do not own

- AI prompts, completion providers, or model selection. Polish and Recipes own those.
- A single selected or pinned Transformation.
- Manual transformation pickers or recording row actions. Recipes own on-demand actions.
- Persisted run history. Deterministic test output is sufficient.
- Historical Transformation data recovery. The implementation may reuse code and UI ideas from Git, but the new library starts empty.
- A default Transformation row.

## Data model

The current database declaration cannot represent an array of structured step objects in one field without hiding typed data in an opaque string. Use two portable tables instead.

### `transformations`

```ts
{
  name: string;
  description: string;
  enabled: boolean; // new rows start false
  position: number;
}
```

### `transformationSteps`

```ts
{
  transformationId: string;
  position: number;
  kind: 'find_replace' | 'spoken_urls';
  find: string;      // empty for spoken_urls
  replace: string;   // empty for spoken_urls
  useRegex: boolean; // false for spoken_urls
}
```

The non-applicable fields remain present with inert defaults because the database declaration has no optional fields. The domain validates the invariants for each `kind`:

- `find_replace` requires a non-empty `find` value.
- A regex rule must compile with the global flag before it can be saved or enabled.
- `spoken_urls` ignores `find`, `replace`, and `useRegex`.

Both tables use runtime-minted row IDs. `transformationSteps.transformationId` points to a Transformation row. The Transformations domain owns parent deletion and deletes the parent's steps in the same workflow.

Positions sort ascending with row ID as a deterministic tie-breaker. Creating an item appends it. Reordering writes contiguous positions. Concurrent reorder conflicts may produce equal positions, but every replica still derives the same order from the ID tie-breaker.

## Runtime semantics

### Step execution

`find_replace` preserves the old useful behavior:

- Literal rules use `replaceAll`.
- Regex rules compile with `new RegExp(find, 'g')`.
- Rules run in ascending step order.

`spoken_urls` moves the existing `normalizeSpokenUrls` parser behind a step. Preserve its narrow recognition boundary:

- Require an explicit spoken `http` or `https` scheme.
- Require a dotted domain.
- Support spoken colons, slashes, dots, hyphens, underscores, ports, and paths.
- Lower-case protocol and domain while preserving path casing.
- Do not rewrite ordinary prose containing words such as “dot” or “slash”.

### Transformation composition

Enabled Transformations run in ascending Transformation order. Each receives the previous successful Transformation's output.

A Transformation executes atomically. If one of its steps is invalid at runtime:

1. Discard that Transformation's partial output.
2. Keep the text that entered that Transformation.
3. Report the failing Transformation and step.
4. Continue with later enabled Transformations.

The executor itself returns structured failures and does not display UI or write history. Pipeline and test surfaces decide how to report them.

### Pipeline integration

Deterministic rewriting must happen after raw persistence and before Polish:

```txt
transcribeAndPersist()
  returns raw text and leaves recordings.transcript exact

applyEnabledTransformations(app, rawText)
  returns transformed text plus any per-Transformation failures

runPolish(app, { input: transformedText })
  returns polished text or falls back to transformedText
```

This ordering matters:

- A Transformation failure cannot destroy the raw transcript.
- Polish sees deterministic corrections.
- Cancelling or failing Polish delivers the transformed text, not the unprocessed raw text.
- Speed mode still runs local Transformations and makes no AI call.

Manual single-recording and bulk transcription currently call `transcribeAndPersist` directly. They must call the shared deterministic processing operation after raw persistence so capture, import, retry, and bulk paths do not disagree. This change does not make manual retry run AI Polish; it only makes deterministic Transformations universal.

## Recording history transition

Add:

```ts
deliveredTranscript: 'string|null = null'
```

`recordings.transcript` remains the exact provider output. `recordings.deliveredTranscript` becomes the final text selected for delivery after Transformations and optional Polish.

Keep `polishedTranscript` temporarily as a migration source for existing rows:

```txt
effective delivered text =
  deliveredTranscript
  ?? polishedTranscript
  ?? transcript
```

During app acquisition, perform an idempotent upgrade for the active work document: when `deliveredTranscript` is null and `polishedTranscript` is not null, copy the old value into `deliveredTranscript`. Keep the read fallback because an older replica may sync a row later.

New code never writes a new Polish result to `polishedTranscript`. Re-transcription clears both `deliveredTranscript` and the legacy `polishedTranscript` before processing so stale output cannot reappear through the fallback. Removal of the legacy field is a later data-compatibility decision, not part of this plan.

Update recording history, latest-recording, transcript cells, detail editing, search/sort accessors, and delivery-facing copy to use the effective delivered transcript. UI wording should say “Delivered transcript” and “Original transcript”, not assume the final text came from Polish.

## Application domain

Add a `createWhisperingTransformations` domain over both portable tables and expose it as `app.transformations`.

The domain owns:

- Reactive joined Transformation and step views.
- Ascending order and deterministic tie-breaking.
- Create, edit, enable/disable, reorder, and delete operations.
- Add, edit, reorder, and delete step operations.
- Parent-step cascading deletion.
- Per-kind validation before writes.
- Nonconforming row diagnostics for both tables.

Do not restore the old global state bridges. Follow the current `createWhisperingRecipes` and `createWhisperingRecordings` pattern: the domain reads synchronously from the active document, subscribes to table changes, and is disposed with the app.

## User interface

Restore `Transformations` as a top-level route beside Recordings and Recipes.

The page should make execution state and order visible without a separate selector:

```txt
Transformations

[Create Transformation]

1  [on]  Spoken technical text      [up] [down] [edit] [delete]
2  [off] Meeting cleanup            [up] [down] [edit] [delete]
```

Use explicit up/down controls rather than introducing a drag-and-drop dependency. Disabled Transformations remain in their saved position and are skipped at runtime.

The editor contains:

1. Name and description.
2. Enabled switch.
3. Ordered step list.
4. “Add step” control with `Find and replace` and `Spoken URLs` choices.
5. Per-step up/down, duplicate, and delete actions.
6. For find/replace: find, replacement, and regex switch.
7. Input and output test areas that run the current unsaved draft without persisting a run.
8. Inline validation for blank find values and invalid regular expressions.

Recover product knowledge from the deleted UI, especially:

- `apps/whispering/src/lib/components/transformations-editor/Configuration.svelte`
- `apps/whispering/src/lib/components/transformations-editor/Test.svelte`
- `apps/whispering/src/routes/(app)/(config)/transformations/+page.svelte`

Read them through `git show bac7a18fe7^:<path>`. Do not copy the old files wholesale: their state, workspace, RPC, provider, and component APIs are obsolete.

Do not restore `Runs.svelte`, `TransformationSelector.svelte`, `TransformationPickerBody.svelte`, run-history dialogs, recording actions, AI prompt configuration, or the three-pane layout built around persisted runs.

## ADR amendment

Amend ADR-0099 during implementation. Keep its separation of Dictionary, Polish, and Recipes, but reverse these claims:

- “Delete the Transformation concept.”
- “No find/replace, no regex.”
- “The only thing that auto-runs is guaranteed meaning-preserving” when interpreted as AI Polish being the sole automatic text stage.

The amendment should state:

- Transformations are deterministic and local.
- Several may be enabled and ordered.
- They run before optional Polish.
- They do not contain AI or replace Recipes.
- The old `selectedId` design remains rejected.

Do not create a second architecture story that leaves ADR-0099 apparently authoritative and contradictory.

## Implementation plan

### Phase 1: Record the reopened decision and declare storage

- [x] Amend ADR-0099 with the deterministic Transformation boundary and runtime order.
- [x] Add `transformations` and `transformationSteps` to `apps/whispering/src/lib/workspace/index.ts`.
- [x] Add `deliveredTranscript` while retaining deprecated `polishedTranscript` as a migration source.
- [x] Export the inferred row and ID types needed by the application domain.
- [x] Add declaration and conformance tests for the new tables and recording field.

### Phase 2: Build the Transformations domain

- [ ] Create `apps/whispering/src/lib/whispering/transformations.svelte.ts` over both tables.
- [ ] Implement reactive joined rows, ordering, validation, mutation methods, and cascading deletion.
- [ ] Expose and dispose `app.transformations` from `apps/whispering/src/lib/whispering/app.ts`.
- [ ] Include both tables in signed-in and signed-out app tests, proving they use the active work document and not device settings.
- [ ] Add both tables' nonconforming counts to the debug surface.

### Phase 3: Restore deterministic execution

- [ ] Create a pure Transformation executor and tests in `apps/whispering/src/lib/operations/`.
- [ ] Implement ordered literal and regex replacement steps.
- [ ] Move `normalizeSpokenUrls` behind the `spoken_urls` step and remove its unconditional call from `transcribe.ts`.
- [ ] Implement multi-Transformation composition, disabled-row skipping, deterministic ties, and atomic per-Transformation failure handling.
- [ ] Return structured failures without toasts, history writes, or network access.

### Phase 4: Integrate processing and recording history

- [ ] Add a shared deterministic processing operation used after `transcribeAndPersist` by capture, import, manual retry, and bulk transcription.
- [ ] Feed transformed text into Polish in `pipeline.ts`.
- [ ] Persist the final text in `deliveredTranscript` whether it came from Transformations, Polish, both, or neither.
- [ ] Ensure Polish cancellation/failure falls back to transformed text.
- [ ] Clear stale delivered and legacy polished values when re-transcription starts.
- [ ] Add the idempotent `polishedTranscript` to `deliveredTranscript` upgrade and fallback reads.
- [ ] Update history and latest-recording surfaces to use effective delivered text.
- [ ] Cover speed mode, Polish success, Polish failure, no enabled Transformations, several enabled Transformations, manual retry, and bulk transcription.

### Phase 5: Restore the focused editor

- [ ] Add Transformations to `apps/whispering/src/routes/(app)/_components/nav-items.ts`.
- [ ] Create the `/transformations` route and ordered list controls.
- [ ] Add create, edit, enable/disable, reorder, and delete flows.
- [ ] Add the ordered step editor for find/replace and Spoken URLs.
- [ ] Add an unpersisted input/output test surface and inline validation.
- [ ] Confirm keyboard and screen-reader operation for all reorder and mutation controls.

### Phase 6: Remove temporary and stale paths

- [ ] Delete the unconditional URL-normalizer integration from `transcribe.ts`; keep the parser only behind its step executor.
- [ ] Remove stale Transformation view-transition helpers or comments that refer to the deleted selector/picker unless the new UI uses them honestly.
- [ ] Search for every `polishedTranscript` read and convert it to the migration boundary or effective-delivered helper.
- [ ] Search for obsolete `selectedId`, prompt-phase, run-history, and picker concepts and ensure none were reintroduced.
- [ ] Run focused tests, Whispering typecheck, Biome, the desktop build, and a manual dictation smoke test.

## Test catalog

### Executor

- Literal replacement applies globally and preserves case.
- Regex replacement applies globally and reports an invalid pattern.
- Step order changes output predictably.
- Transformation order changes output predictably.
- Disabled Transformations are skipped.
- Equal positions resolve by row ID.
- A failing Transformation contributes no partial output and later Transformations still run.
- Spoken URLs covers protocol, domain, port, path, following prose, and ordinary “dot”/“slash” prose.

### Domain

- New Transformations start disabled and append to the order.
- New steps append to their parent.
- Reordering writes and reads a stable order.
- Deleting a Transformation deletes its steps.
- Invalid find/replace steps are refused before persistence.
- Table updates from another replica subscription refresh the reactive view.
- Signed-in Transformations use account work; signed-out Transformations use device work.

### Pipeline and history

- Raw ASR output is persisted unchanged.
- No enabled Transformations preserves the raw text.
- Speed mode delivers and stores transformed text without AI.
- Polish receives transformed text.
- Polish success stores its result in `deliveredTranscript`.
- Polish failure or cancellation delivers transformed text.
- Re-transcription clears stale final output.
- Existing `polishedTranscript` rows display and migrate as delivered text.
- Manual retry and bulk transcription apply enabled Transformations.

### UI

- Several Transformations can be enabled simultaneously.
- Up/down controls change execution order.
- Disabled rows retain their position.
- A draft can be tested without saving or creating run history.
- Invalid regex feedback identifies the failing step.
- Spoken URLs can be added and removed like any other step.

## Edge cases

### Empty pipeline

No Transformation rows or no enabled rows is an identity operation. Do not create default rows during boot.

### Empty Transformation

An empty Transformation may be saved as a draft but cannot be enabled. The UI explains that it needs at least one valid step.

### Synced invalid or orphaned data

Schema-nonconforming rows appear in debug diagnostics. A step whose `transformationId` has no parent is ignored by execution and editing surfaces. Do not silently attach it to another Transformation.

### Concurrent reorder

Equal positions are legal intermediate state. Sorting by row ID produces the same execution order on every replica. The next explicit reorder compacts positions.

### Transformation failure

A bad Transformation cannot block transcription, Polish, history, or delivery. Its own changes are discarded, the failure is reported, and later Transformations continue.

### Polish disabled or unavailable

Transformations still run. The transformed text is the delivered text and is persisted in `deliveredTranscript`.

### Existing polished rows

The legacy value remains readable and is copied when the active work document is upgraded. Do not delete `polishedTranscript` in this work.

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Restore the entire old subsystem | Reintroduces AI prompts, providers, run persistence, manual actions, and the single-selection model that caused the original overlap. |
| Rename the concept to Filters | The chosen product language is Transformations; the narrower contract, not a new noun, removes the old ambiguity. |
| One top-level row per replacement rule | Makes related URL or punctuation behavior scatter across many top-level items and loses the useful named grouping from the old UI. |
| Store structured steps as JSON in one row | Hides step validation from the current database declaration and makes concurrent edits replace the whole pipeline. |
| Keep URL normalization in `transcribeAudio` | Mutates the supposed raw transcript and removes user control. |
| Provision Spoken URLs by default | Adds bootstrap and cross-device deduplication complexity and changes transcripts before the person opts in. |
| Reuse `polishedTranscript` for every final result | Leaves a permanent technical lie once deterministic processing can produce the final text without Polish. |
| Recover historical Transformation rows | Old data crossed several deleted schemas and store clean breaks; recovery is a separate importer product with ambiguous AI-bearing rows. |
| Persist Transformation run history | Deterministic execution is immediate and reproducible in the test pane; a run entity adds storage and liveness without a current user need. |

## Success criteria

- [ ] A person can create several Transformations, enable them together, and control their execution order.
- [ ] Each Transformation can contain ordered literal/regex and Spoken URLs steps.
- [ ] The raw provider transcript remains unchanged in `recordings.transcript`.
- [ ] Transformations run locally before optional Polish in capture, import, retry, and bulk paths.
- [ ] Recording history shows the final text through `deliveredTranscript` and preserves the original one click away.
- [ ] Existing `polishedTranscript` values remain visible through the migration boundary.
- [ ] An invalid Transformation cannot prevent later processing or delivery.
- [ ] No AI prompt, provider selector, `selectedId`, picker, or run-history subsystem returns with Transformations.
- [ ] No Transformation is created or enabled by default.
- [ ] Relevant tests, typecheck, lint, desktop build, and manual smoke validation pass.

## References

- `docs/adr/0099-replace-transformations-with-a-dictionary-polish-and-a-portable-recipe-library.md`: accepted decision this work must amend.
- `apps/whispering/src/lib/workspace/index.ts`: current recording, recipe, and settings declarations.
- `apps/whispering/src/lib/whispering/app.ts`: owner of portable work domains.
- `apps/whispering/src/lib/whispering/recipes.svelte.ts`: current reactive portable-table pattern.
- `apps/whispering/src/lib/whispering/recordings.ts`: current multi-resource domain pattern.
- `apps/whispering/src/lib/operations/transcribe.ts`: raw transcription and persistence boundary.
- `apps/whispering/src/lib/operations/pipeline.ts`: Transformation, Polish, history, and delivery ordering owner.
- `apps/whispering/src/lib/operations/transcription-history.ts`: raw and final transcript persistence.
- `apps/whispering/src/lib/queries/transcription.ts`: manual and bulk transcription entry points.
- `apps/whispering/src/lib/operations/normalize-spoken-urls.ts`: tentative parser to move behind the built-in step.
- `apps/whispering/src/routes/(app)/(config)/settings/dictation/+page.svelte`: current Dictionary and Polish boundary.
- `apps/whispering/src/routes/(app)/_components/nav-items.ts`: current top-level navigation.
- Commit `e7726f4980`: final pre/prompt/post Transformation shape before deletion.
- Commit `ce34e8ccef`: original Simple Punctuation step.
- Commit `63b0cde846`: hardened Simple Punctuation matching.
- Commit `44313b48d0`: initial replacement of Transformations with Dictionary, Polish, and Recipes.
- Commit `bac7a18fe7`: final Transformation subsystem deletion.
