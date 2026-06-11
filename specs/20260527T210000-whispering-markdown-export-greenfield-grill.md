# Whispering Recording Markdown Export: Greenfield Grill

**Date**: 2026-05-27
**Status**: Proposal
**Owner**: Whispering
**Grills**: `specs/20260527T180000-whispering-markdown-materializer-greenfield.md` (Implemented)

## Why this exists

The previous spec just shipped (commits `0c03e5c..9e8a1d7`). v7.11.1 is on a working branch with no released users yet. Compatibility pressure is zero. This grill asks: if we were designing today, would we ship this shape? Or did we polish the wrong sentence?

## Three product sentences on trial

```txt
Sentence C (current):
  Recording rows own transcript state; when a Tauri user chooses an export folder,
  Whispering writes read-only Markdown copies there; rebuild deletes `.md` files
  in that folder and writes current rows.

Sentence A (fixed appdata):
  Recording rows own transcript state; the Tauri app owns one fixed appdata
  Markdown projection folder; Markdown files are deterministic derived output,
  not a user-selected live sync location.

Sentence B (one-shot only):
  Recording rows own transcript state; Markdown export is an explicit one-shot
  action only; there is no live projection, no folder setting, no observer,
  and no rebuild lifecycle.
```

## Bluntly: Sentence A is dead

Sentence A is exactly what v7.11.1 just refused. The previous spec walked through it and listed the user loss: hidden files, no Finder-discoverability, can't pipe into Obsidian or a Dropbox folder. Going back to appdata is a regression, not a clean break. **Refused.**

The real fight is Sentence B vs. Sentence C.

## ASCII model of the current shape

```txt
openWhispering()                              <-- public Whispering client
  ├── workspace = createWhisperingWorkspace()
  ├── idb = attachIndexedDb(ydoc)              <-- whispering.idb (exported, unused)
  ├── attachBroadcastChannel(ydoc)
  ├── let recordingsExport                     <-- mutable handle (only the folder
  │   ├── attach on init                           setting needs a mutable handle)
  │   ├── attach/dispose on deviceConfig.observe
  │   └── dispose on ydoc.destroy
  ├── rebuildRecordingMarkdownExport()         <-- leaks exporter action into the
  │                                                public client just so a settings
  │                                                Svelte component can call it
  └── whenReady = idb.whenLoaded

attachRecordingMarkdownExport(ydoc, recordings, { dir, waitFor })
  ├── pendingIds: Set
  ├── syncQueue: Promise chain
  ├── recordings.observe -> schedule(ids)
  ├── microtask -> flushIds(ids) -> chunked IPC
  ├── whenExported: Promise<void>              <-- defined, exported, **no caller**
  ├── rebuild(): { deleted, written }          <-- called once from a settings button
  ├── [Symbol.dispose]                         <-- only fires on folder change
  └── ydoc.once('destroy', dispose)

settings/recording/RecordingMarkdownExportFolder.svelte
  ├── chooseExportFolder() -> deviceConfig.set
  ├── rebuildExport() -> whispering.rebuildRecordingMarkdownExport()
  └── clear button -> deviceConfig.set(null)

DeleteFilesSelection (Rust)
  ├── Filenames { filenames }                   <-- used by audio blob delete + realtime markdown delete
  └── Extension { extension }                    <-- used by rebuild only
```

## Drift: things that already smell

Independent of which sentence wins, these are dead or near-dead:

```txt
1. `whenExported` is exported and unused.
   `rg whenExported apps/whispering` returns only the definition line.
   Pure readiness leakage. Delete.

2. `whispering.idb` is exported by openWhispering and has zero external readers.
   `rg "whispering\.idb"` returns nothing outside the producer.
   Delete from the returned object.

3. `whispering.rebuildRecordingMarkdownExport` exists on the public Whispering
   client purely so one Svelte file can call it. The Whispering client doesn't
   own the exporter as a concept. The exporter is its own module. The
   settings panel should reach the exporter directly, not via the workspace
   client. Refusing this leak unbinds `openWhispering` from the markdown export
   action surface.

4. `PATHS.DB.TRANSFORMATIONS`, `TRANSFORMATION_MD`, `TRANSFORMATION_RUNS`,
   `TRANSFORMATION_RUN_MD` and their docstrings (130 lines) are stranded.
   No active caller. Out of scope for this grill but flagged for a separate
   straggler sweep.
```

## Value owners under each sentence

```txt
                          | Sentence C (live)              | Sentence B (one-shot)
recording row state       | workspace table                 | workspace table
audio bytes               | filesystem blob store           | filesystem blob store
markdown content          | exporter (derived)              | one-shot writer (derived)
filesystem IO trust       | Tauri write_markdown_files      | Tauri write_markdown_files
filesystem deletes        | Tauri delete_files_in_directory | Tauri delete_files_in_directory
export folder choice      | deviceConfig (durable)          | settings UI (per-export prompt)
exporter lifecycle        | openWhispering owns mutable     | n/a, no lifecycle
                            handle + observe/dispose
"is file current" promise | implicit, eventually consistent | snapshot-at-export, honest
```

The asymmetry: Sentence B has no exporter-as-living-thing. There is no "is this live", no "did the observer batch settle", no "did we miss a write while disposed". A click does the whole job, in one IPC, and the file is exactly the state at the moment of the click.

## Candidate refusals (refusal-shaped, in priority order)

### Refusal 1: Refuse `whenExported`. (wins regardless)

```txt
Code family it deletes:
  exporter `whenExported` IIFE + early `await config.waitFor`
  the initial-export branch of the queue
  the "initial export must run before settings UI is meaningful" mental model

User loss:
  None. No caller. The mental model the field implied was wrong anyway
  (first render does not read markdown).

Decision:
  Refuse.
```

### Refusal 2: Refuse `whispering.idb` on the public client. (wins regardless)

```txt
Code family it deletes:
  `idb` field on openWhispering's return object
  the implication that consumers can reach into IndexedDB persistence

User loss:
  None. No external readers.

Decision:
  Refuse. `whenReady = idb.whenLoaded` survives; the `idb` handle stays
  private to openWhispering.
```

### Refusal 3: Refuse `whispering.rebuildRecordingMarkdownExport`. (wins regardless)

```txt
Code family it deletes:
  the rebuild trampoline in openWhispering (`async function rebuildRecordingMarkdownExport`)
  the mutable handle's role as "rebuild source" for the settings UI
  exporter-shape leakage onto the public Whispering client

User loss:
  None. The settings panel reaches the exporter through its own module
  instead of through the workspace client.

Replacement (under Sentence C only):
  Settings file imports a singleton `recordingMarkdownExport` from
  `$lib/recording-markdown-export.client.ts` (or equivalent) and calls
  `.rebuild()` directly. Lifecycle stays in one place.

Decision:
  Refuse.
```

### Refusal 4: Refuse the user-selected live export folder. (Sentence B win)

```txt
Code family it deletes:
  `recording.markdownExportDir` device-config key
  `RecordingMarkdownExportFolder.svelte` becomes a single "Export…" button
  `deviceConfig.observe('recording.markdownExportDir', ...)` plumbing
  mutable `recordingsExport` in openWhispering
  `attachRecordingMarkdownExport` factory + microtask coalescing queue
  `recordings.observe` subscription + `pendingIds` + `syncQueue`
  `[Symbol.dispose]` + `isDisposed` + ydoc.once('destroy', dispose)
  `whenExported` (already gone under Refusal 1)
  `rebuild()` action (one-shot IS rebuild every time)
  `DeleteFilesSelection::Extension { extension }` Rust variant
  the once-per-session failure toast state (`hasShownFailureToast`)
  the dispose/re-attach loop on folder change

  ~140 lines of TS deleted. ~25 lines of Rust deleted.

User loss:
  No background updates. If a user wants their Obsidian vault current,
  they re-export. The file is a snapshot, not a mirror.

Replacement:
  function exportRecordingsMarkdown() {
    const dir = await chooseFolder();
    if (!dir) return;
    const files = whispering.tables.recordings.getAllValid().map(toMd);
    const { error } = await commands.writeMarkdownFiles(dir, files);
    if (error) toastError(...);
    else toastSuccess(`Wrote ${files.length} files to ${dir}`);
  }

  Folder choice is not persisted; the dialog re-asks each time, or it is
  remembered in deviceConfig as a UX nicety (`recording.lastExportDir`)
  with no behavioral coupling.

Decision:
  **Recommend refuse.** See "Asymmetric win" below.
```

### Refusal 5: Refuse rebuild-as-repair under Sentence C. (Sentence C cleanup only)

If Sentence C survives, the rebuild button still smells. Rebuild only exists because live projection is implicit and can drift. That is a symptom of live projection, not an independent product feature. Either:

```txt
Option C1: Keep rebuild as an explicit user repair (current shape).
Option C2: Refuse rebuild. If projection drifts, the user toggles the folder
           setting off and back on (which re-attaches and re-fires
           writeAllRecordings as the initial pass. Once whenExported is
           reintroduced for that purpose only, see contradiction with R1).
```

The contradiction matters: **`whenExported` is the right primitive for "do the initial export" but the wrong primitive to expose as a returned member.** Internally, the live exporter still needs an initial write to backfill. Just don't return it.

### Refusal 6: Refuse the `client.browser.ts` / `client.tauri.ts` split (regardless).

The task suggested investigating an env split. Don't do it. Today `whispering/client.ts` directly imports `./tauri`. There is no browser variant. Adding a `.browser.ts` shim would be a no-op export that exists only to look symmetric. The honest shape is: Whispering's runtime client is Tauri-only at this layer. The browser app (if it ever exists) builds a different client file. Don't add an env-split until a real browser path exists.

## Asymmetric win

```txt
Sentence B (one-shot) deletes ~165 lines, an entire lifecycle, a public
client method, a settings UI subcomponent, a Rust enum variant, a
coalescing queue, an observer subscription, a Symbol.dispose contract,
a device-config key, and a "is the file live" mental model.

It costs: a single product promise. "Your folder stays current without
you clicking anything."

That promise has zero released users. It is plausible-but-unvalidated.
The reverse migration (B → C) is doable later if usage demands it.
The forward migration (C → B) is harder once people build muscle
memory around "Whispering keeps my Obsidian folder updated."

This is the textbook moment to take the asymmetric deletion.
```

## What survives if Sentence C wins anyway

If the user explicitly says "live folder is the product promise, keep it", these refusals still land:

```txt
1. Delete `whenExported` from the returned object (keep internal initial-flush).
2. Delete `whispering.idb` from openWhispering's return.
3. Delete `whispering.rebuildRecordingMarkdownExport`; have the settings UI
   reach a singleton exporter module.
4. Move the device-config observe + dispose/re-attach loop out of
   openWhispering into the exporter module. openWhispering should not own
   a mutable handle.
5. Consider whether rebuild is product or symptom (Refusal 5).
```

After those, openWhispering shrinks to:

```ts
export function openWhispering() {
  const workspace = createWhisperingWorkspace();
  const idb = attachIndexedDb(workspace.ydoc);
  attachBroadcastChannel(workspace.ydoc);
  return {
    ...workspace,
    whenReady: idb.whenLoaded,
  };
}
```

Markdown export becomes its own module that imports `whispering` and `deviceConfig` itself. The Whispering client stops being the registry for every Tauri attachment.

## Final recommendation

```txt
Recommendation:
  Refuse the user-selected live export folder. Ship Sentence B.

Implementation:
  Replace attachRecordingMarkdownExport with a single explicit
  exportRecordings(dir) function. Replace the settings panel with a
  single "Export Markdown…" button. Delete the device-config key.
  Delete the Extension variant in DeleteFilesSelection.

If the user pushes back and keeps Sentence C:
  Land Refusals 1, 2, 3, and 6 unconditionally.
  Move device-config observe + dispose loop out of openWhispering
  (Refusal 4-lite without deleting the feature).
  Decide Refusal 5 explicitly.
```

## Open risks

```txt
1. The user may have a real product reason for live export I don't know
   about. Obsidian-sync demand could be the actual point of v7.11.1.
   This is a judgment call I am willing to be wrong about.

2. Sentence B loses the "Whispering writes alongside my work" feel. Users
   who think of recordings as flowing files may be surprised when the
   folder is a stale snapshot. One-shot exports must be obvious about
   "this is a snapshot at <timestamp>".

3. If we keep Sentence C and accept the smaller refusals, the dispose/
   re-attach pattern still exists, just moved. Make sure the new home
   doesn't import `openWhispering` and create a circular dependency.

4. `DeleteFilesSelection::Filenames` is earned (audio blob store uses it).
   `Extension` is only earned under Sentence C. If we refuse Sentence C
   AND keep some other markdown shape later, do not preemptively keep
   `Extension`. Reintroduce it when a real caller exists.
```

## Files this would change under Sentence B

```txt
Delete or shrink:
  apps/whispering/src/lib/recording-markdown-export.ts             (factory → one function)
  apps/whispering/src/routes/(app)/(config)/settings/recording/RecordingMarkdownExportFolder.svelte
                                                                    (folder picker + buttons → one button)
  apps/whispering/src/lib/whispering/tauri.ts                       (drop exporter wiring + idb export)
  apps/whispering/src/lib/state/device-config.svelte.ts             (drop markdownExportDir key)
  apps/whispering/src-tauri/src/markdown.rs                         (drop Extension variant)
  apps/whispering/src/lib/tauri/bindings.gen.ts                     (regenerate)
  docs/release-notes/v7.11.1.md                                     (rewrite for one-shot)
  specs/20260527T180000-whispering-markdown-materializer-greenfield.md
                                                                    (add a "Superseded by 20260527T210000" header)
```

## Files this would change under Sentence C cleanup

```txt
Modify:
  apps/whispering/src/lib/whispering/tauri.ts                       (drop idb, drop rebuild method, drop observe)
  apps/whispering/src/lib/recording-markdown-export.ts              (drop whenExported from return, own deviceConfig wiring)
  apps/whispering/src/routes/(app)/(config)/settings/recording/RecordingMarkdownExportFolder.svelte
                                                                    (call exporter module directly)
```

## Commit strategy (Sentence B)

```txt
1. docs(whispering): refuse live markdown projection
   - design note as this file
   - mark prior spec superseded

2. refactor(whispering): drop unused markdown export client surface
   - remove whenExported from exporter return
   - remove idb from openWhispering return
   - remove rebuildRecordingMarkdownExport from openWhispering

3. refactor(whispering): delete live markdown export attachment
   - delete attachRecordingMarkdownExport
   - delete deviceConfig observe wiring in openWhispering
   - delete markdownExportDir device-config key

4. feat(whispering): explicit recording markdown export action
   - one-shot exportRecordings() in a new module
   - settings panel becomes a single button + last-used-folder memory
   - regenerate bindings (no command surface change)

5. refactor(whispering): drop Extension selector from delete_files_in_directory
   - delete enum variant + tests
   - regenerate bindings

6. docs(whispering): rewrite v7.11.1 release note for one-shot export
```

## Commit strategy (Sentence C cleanup)

```txt
1. docs(whispering): record live export ownership decision
2. refactor(whispering): drop unused markdown export client surface (Refusals 1, 2, 3)
3. refactor(whispering): move markdown exporter lifecycle out of openWhispering
4. (optional) refactor(whispering): refuse rebuild as repair action
```

## Verification (either path)

```txt
bun --filter @epicenter/whispering typecheck
bun test apps/whispering
cargo test --manifest-path apps/whispering/src-tauri/Cargo.toml export_types
```

## Trigger to revisit

```txt
Sentence B revisit:
  If at least one real user reports that they want their export folder
  current without clicking, reintroduce live export. The mechanics survived
  in git history; the spec lives at 20260527T180000.

Sentence C survives:
  If users actively configure markdownExportDir on first run and edit
  recordings frequently enough that a live mirror is materially better
  than a one-click snapshot, the live machinery is earned.
```
