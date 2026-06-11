# Whispering Recording Markdown Export

**Date**: 2026-05-27
**Status**: Superseded by `specs/20260527T210000-whispering-markdown-export-greenfield-grill.md`
**Owner**: Whispering
**Supersedes**: `specs/20260415T170000-recording-data-architecture.md` for the active markdown decision path
**Superseded by**: `specs/20260527T210000-whispering-markdown-export-greenfield-grill.md`: greenfield grill refused the user-selected live export folder in favor of one-shot export

## One Sentence

Whispering stores recordings in the workspace; when the user chooses a transcript export folder, Whispering writes read-only markdown copies there; Tauri owns validated disk IO.

## How to Read This Spec

Read first:

```txt
One Sentence
Current State
Target Shape
Queue Semantics
Implementation Plan
Verification
Go or No-Go
```

Read if changing architecture:

```txt
Design Decisions
Greenfield Refusals
Grill Pass Result
Open Questions
```

Historical context:

```txt
20260415T160000-recording-materializer.md
20260415T170000-recording-data-architecture.md
20260415T180000-recording-rust-materializer.md
20260415T190000-recording-remaining-phases.md
```

## Overview

Whispering already writes recording markdown sidecars into appdata. That shape is too ambiguous: the workspace owns recording state, but appdata markdown looks like storage. This spec collapses the feature into a narrower product promise.

```txt
Chosen shape:
  user-selected read-only live export

Refused shapes:
  appdata markdown as product storage
  markdown push into workspace from the same export folder
  realtime file watching from markdown into workspace
  transformations, runs, settings, and generic multi-table export in this pass
```

The goal is not "a markdown materializer because the workspace package has one." The goal is readable transcript files in a folder the user chose.

## Current State

Current startup path:

```txt
openWhispering()
  -> createWhisperingWorkspace()
  -> attachIndexedDb(ydoc)
  -> attachBroadcastChannel(ydoc)
  -> attachRecordingMarkdownFiles(ydoc, tables.recordings, ...)
  -> whenReady waits for IndexedDB load and first markdown flush
```

Current realtime path:

```txt
recordings.observe(changedIds)
  -> build toWrite and toDelete arrays
  -> commands.writeMarkdownFiles(dir, toWrite)
  -> commands.deleteFilesInDirectory(dir, toDelete)
```

Current Rust write path:

```txt
write_markdown_files(directory, files)
  -> require absolute directory
  -> validate every filename is one leaf component
  -> reject duplicate filenames
  -> create directory
  -> for each file:
       write temp file
       persist temp file to final filename
```

What this already gets right:

1. One IPC call can carry many file writes.
2. Rust validates filenames at the trust boundary.
3. Rust owns atomic writes.
4. The JS promise chain serializes observer batches so older batches cannot race newer batches.

What is wrong with the current product shape:

1. Markdown is written to appdata, not a user-chosen folder.
2. Startup readiness waits for markdown even though first render does not read markdown.
3. The code and docs still describe a "file-system database" even though the workspace owns recording state.
4. The projection is hidden, so failures are neither clear export failures nor clear data loss failures.
5. Generated files are not read back into the app, so editing them does nothing.

## Target Shape

Greenfield API shape:

```ts
const markdownExport = attachRecordingMarkdownExport({
	table: workspace.tables.recordings,
	dir: settings.get('recording.markdownExportDir'),
	waitFor: idb.whenLoaded,
	commands,
	log,
});

await markdownExport.whenExported;
await markdownExport.rebuild();

// On folder change or app teardown the caller disposes explicitly.
// The workspace ydoc.destroy hook also covers app teardown as a fallback.
markdownExport[Symbol.dispose]();
```

Attachment rule:

```txt
If no export directory is configured:
  do not attach markdown export

If an export directory is configured:
  attach realtime read-only export
  do not block app whenReady on export
```

Target ownership:

```txt
recordings table
  owns durable recording metadata and transcript

audio blob store
  owns audio bytes and playback URLs

recording markdown export
  owns read-only transcript files generated from recording rows

Tauri commands
  own filesystem validation, atomic write, and bulk delete
```

Target file format:

```md
---
id: rec_123
title: Morning Meeting
recordedAt: "2026-05-27T12:00:00.000Z"
updatedAt: "2026-05-27T12:03:00.000Z"
transcriptionStatus: DONE
duration: 180000
---
Transcript text lives here.
```

The `transcript` field is the markdown body. Every other recording field is frontmatter.

## Queue Semantics

The realtime queue should be latest-state coalescing.

```ts
const pendingIds = new Set<string>();
let flushPromise = Promise.resolve();
let scheduled = false;

function schedule(ids: Iterable<string>) {
	for (const id of ids) pendingIds.add(id);
	if (scheduled) return;

	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		const ids = [...pendingIds];
		pendingIds.clear();
		flushPromise = flushPromise.then(() => flushIds(ids)).catch(logFailure);
	});
}
```

`flushIds` reads the table at flush time:

```ts
async function flushIds(ids: string[]) {
	const toWrite = [];
	const toDelete = [];

	for (const id of ids) {
		const { data: row, error } = recordings.get(id);
		if (error) continue;
		if (row === null) toDelete.push(`${id}.md`);
		else toWrite.push(toRecordingMarkdownFile(row));
	}

	await writeFilesInChunks(toWrite);
	await deleteFilesInChunks(toDelete);
}
```

This gives us three properties:

```txt
Correctness:
  Observer batches still run in order.

Coalescing:
  Multiple edits to the same row before the microtask flush become one write.

Freshness:
  The file content is computed from the latest table state, not from a stale row captured when the observer fired.
```

Do not make one IPC call per file. The efficient boundary is one IPC call with many files, chunked when the batch is large.

Suggested defaults:

```txt
Realtime chunk size: 100 files
Rebuild chunk size: 250 files
```

These numbers are tuning defaults, not schema. Measure before treating them as product rules.

## Export Actions

### observe

Realtime projection from table changes to markdown.

```txt
input:
  changed recording ids

behavior:
  coalesce ids
  read latest rows
  write changed rows
  delete markdown files for deleted rows

result:
  background read-only export
```

### rebuild

Repair action from workspace to markdown.

```txt
input:
  all valid recording rows

behavior:
  delete existing .md files in the export directory
  write every valid row

result:
  { deleted, written }
```

Use `rebuild` after filename rules change, after a failed projection leaves stale files, or when users ask for a clean export.

### refused: push

`push` is deliberately not part of this exporter. Importing markdown into the workspace is a different product operation.

If import is needed later, design it as a separate action:

```txt
Import Markdown
  user selects files or a folder
  app previews valid rows and errors
  user confirms import
  workspace bulkSet writes rows
```

Do not run import against the same folder that realtime export owns. A folder should not be both generated output and source of truth.

## Tauri Command Surface

Target command surface:

```rs
write_markdown_files(directory: String, files: Vec<MarkdownFile>) -> Result<(), String>
delete_files_in_directory(directory: String, filenames: Vec<String>) -> Result<u32, String>
```

`MarkdownFile`:

```rs
pub struct MarkdownFile {
    filename: String,
    content: String,
}
```

`write_markdown_files` should stay a Specta-generated command if markdown export stays. The type bridge matters because the caller is TypeScript and the trust boundary is Rust.

`delete_files_in_directory` is not markdown-specific. If markdown export is removed later, this command should stay or move to a generic filesystem command module because audio cleanup uses it.

Do not add `read_markdown_files` for this exporter. Reading markdown is import behavior, and import is out of scope.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Product state owner | 2 coherence | Workspace table | Markdown is read-only export. The app reads and writes recording state through the table. |
| Export location | 2 coherence | User-chosen folder only | Appdata export looks like storage but is not editable source state. |
| Realtime strategy | 2 coherence | Observe changed ids and coalesce before writing | Keeps live export without writing the same row repeatedly during rapid updates. |
| App readiness | 2 coherence | Do not include markdown export in `whenReady` | First render reads workspace state, not generated markdown. |
| IPC shape | 1 evidence | Batch files into one Specta command | Current code already proves the command can carry `files[]`; one IPC call per file would add overhead. |
| Rust write behavior | 2 coherence | Rust owns atomic writes and filename validation | The filesystem is the Tauri boundary. TS types are not a security boundary. |
| Push behavior | 2 coherence | Refuse from export surface | Importing external edits creates a second write path and source ambiguity. |
| Rebuild behavior | 2 coherence | Destructive and explicit | Orphan cleanup deletes user-visible files, so it must be a named repair action. |
| Rebuild chunking | 3 taste | Chunk commands rather than one huge call | Avoids large IPC payloads and gives future progress hooks. Exact chunk size is tuning. |

## Greenfield Refusals

Product sentence:

```txt
Whispering stores recordings in the workspace; when the user chooses a transcript export folder, Whispering writes read-only markdown copies there; Tauri owns validated disk IO.
```

Candidate refusal:

```txt
Appdata markdown as a product feature.
```

Code family it deletes:

```txt
hidden projection lifecycle
confusing file-system database docs
startup readiness coupling
appdata folder product semantics
debug-export ambiguity
```

User loss:

```txt
Users no longer get hidden .md files unless they choose an export folder.
```

Decision:

```txt
Refuse it. Hidden appdata markdown is neither durable storage nor a good ownership story.
```

Candidate refusal:

```txt
Push from the export folder into workspace.
```

Code family it deletes:

```txt
read_markdown_files command
frontmatter parser path
fromMarkdown mapper
schema validation reporting
import events
source-of-truth confusion
generated-output conflict policy
```

User loss:

```txt
Editing {id}.md in an external editor cannot update Whispering recording state.
```

Decision:

```txt
Refuse it. A read-only export folder should not also be an import source.
```

Candidate refusal:

```txt
Realtime file watching from markdown into workspace.
```

Code family it deletes:

```txt
filesystem watcher
loop prevention
external edit debounce
conflict policy
delete semantics for missing files
rename detection
validation recovery UI
background import error state
```

User loss:

```txt
Users must use the app to edit recording state. External markdown edits are not synced.
```

Decision:

```txt
Refuse it. The app UI is the editing interface.
```

Candidate refusal:

```txt
Markdown export for transformations, transformation steps, runs, and settings in this pass.
```

Code family it deletes:

```txt
multi-table serializers
directory routing policy
schema-specific markdown formats
cross-table import ordering
foreign-key repair
partial import rollback
```

User loss:

```txt
Only recordings get markdown export first.
```

Decision:

```txt
Refuse it. Recordings are the only table with an obvious markdown body and a direct user value as transcript files.
```

Candidate refusal:

```txt
Cross-materializer projection-queue extraction in packages/workspace.
```

Code family it would add:

```txt
shared waitFor + observe + coalesce + dispose helper in packages/workspace
abstract perTable callback shape for one-table consumers like Whispering
behavior change for the package markdown materializer (no coalescing today)
indirection across three call sites with three different needs
```

Code family it would delete:

```txt
roughly 10 lines per consumer of repeated waitFor and ydoc.once destroy plumbing
```

User loss:

```txt
None directly. The cost lands on future maintainers: one shared helper that fits three consumers awkwardly is worse than three honest queues that fit their own consumers well.
```

Decision:

```txt
Refuse it. The three queue algorithms differ on the load-bearing axis:
  sqlite materializer:   debounce window + Map<table, Set<id>> + transactions
  package markdown:      no coalescing; per-id sequential awaits + rename tracking
  whispering export:     microtask coalesce + single Set<id> + batched IPC

The shared parts (waitFor, isDisposed, ydoc.once destroy, serialized promise chain) are about ten lines per consumer; the variant parts are three to four times that. Whispering inlines its own coalescing queue. SQLite keeps its own. Package markdown keeps its own. Revisit only when a fourth real projection wants the exact same shape Whispering has, not before.
```

## Implementation Plan

### Wave 1: Stop treating appdata markdown as startup storage

- [x] Remove markdown flushing from `openWhispering().whenReady`.
- [x] Keep the existing materializer code on disk for rollback.
- [x] Verify app startup and recording UI still work.
  > **Verification note**: `bun test apps/whispering` passes. `bun run check` was run and failed on pre-existing repo-wide lint/typecheck diagnostics outside this wave, including `packages/client` typecheck and unrelated lint warnings. The Wave 1 change only removes `recordingsFs.whenFlushed` from `whenReady`, so recording UI and audio playback continue to use the same workspace and blob-store paths.

### Wave 2: Add export directory setting

Setting:

- [x] Add the device-local key `recording.markdownExportDir: string | null`, default `null`. Do not sync to other devices: filesystem paths are device specific.
- [x] Pick the existing Whispering device-local settings module to host the key. Do not introduce a new module.

Folder picker UI:

- [x] Add a settings panel row labelled "Recording markdown export folder."
- [x] "Choose folder" invokes `@tauri-apps/plugin-dialog` `open({ directory: true })` and writes the absolute path into the setting on selection.
- [x] "Clear" sets the value to `null`.
- [x] Show the current absolute path next to the buttons when set.

Reactive wiring:

- [x] In Whispering's Tauri startup, observe the setting and react to transitions:
  - `null` to a path: attach the exporter against the new path; do not await `whenExported` in the critical path.
  - one path to a different path: call `[Symbol.dispose]` on the current exporter, then attach a new one. Existing files at the old path stay on disk.
  - a path to `null`: call `[Symbol.dispose]` on the current exporter. Leave existing files on disk.
- [x] The exporter never reads the setting itself. Reactivity lives in the Tauri startup wiring, not inside the exporter.

Out of scope:

- [x] Do not backfill any files from the old appdata location. Wave 6 owns appdata cleanup.
  > **Verification note**: Added a focused `deviceConfig.observe` API for non-component startup wiring. `bun --filter @epicenter/whispering typecheck` passes. `bun test apps/whispering` passes. `bun run check` was run and still fails on unrelated repo-wide lint/typecheck diagnostics, including existing `@epicenter/client` and `@epicenter/landing` typecheck failures.

### Wave 3: Rename and reshape the exporter

- [x] Rename `recording-materializer.ts` to `recording-markdown-export.ts`.
- [x] Return `{ whenExported, rebuild, [Symbol.dispose] }`. `[Symbol.dispose]` unsubscribes the observer, sets an `isDisposed` flag the queue checks before flushing, and lets any in-flight Rust IPC call settle (do not race-cancel it).
- [x] Remove browser no-op language: this module is imported only from `apps/whispering/src/lib/whispering/tauri.ts`.
- [x] Keep `write_markdown_files` and `delete_files_in_directory` as the only IO surface. Do not call `@tauri-apps/plugin-fs` directly from the exporter.
  > **Verification note**: `bun --filter @epicenter/whispering typecheck` passes. `bun test apps/whispering` passes. `bun run check` was run and still fails on unrelated repo-wide lint/typecheck diagnostics outside Whispering exporter changes.

### Wave 4: Add coalescing queue

- [x] Replace append-only batch queue with latest-state coalescing queue.
- [x] Read table rows at flush time.
- [x] Chunk write and delete calls.
- [x] Surface projection failures with logging and a once-per-session toast. Do not expose the exporter handle as a Svelte store only for the settings row.
  > **Verification note**: The queue now stores changed ids in a `Set`, flushes them in one microtask, reads rows during `flushIds`, and sends chunked bulk IPC calls. `bun run check` and `bun test apps/whispering` pass. A follow-up rollback removed the reactive `lastError` UI bridge because it was not earning the extra public surface.

### Wave 5: Add rebuild repair action

- [x] Implement `rebuild` by deleting existing `.md` files and then writing all valid rows.
- [x] Return `{ deleted, written }`.
- [x] Wire it as a settings repair action if the export folder is configured.
  > **Verification note**: Extended the existing `delete_files_in_directory` Rust command with a tagged selector so rebuild can delete all immediate `.md` files without TypeScript filesystem IO or a second delete command. Regenerated Specta bindings and kept realtime deletes on explicit filenames. `cargo test --manifest-path apps/whispering/src-tauri/Cargo.toml export_types`, `bun run check`, and `bun test apps/whispering` pass.

### Wave 6: Remove old appdata projection

- [x] Stop attaching export against `PATHS.DB.RECORDINGS()`.
- [x] Remove old references to appdata markdown as storage.
- [x] Update `PATHS.DB` docs to describe audio storage only unless a helper is still needed.
- [x] Remove unused `utils/frontmatter.ts` if no caller remains.
- [x] Re-run symbol searches for `recording-materializer`, `writeMarkdownFiles`, `MarkdownFile`, `frontmatter`, and `{id}.md`.
- [x] Stranded appdata `.md` files: leave them in place. Note in the release changelog that users can delete the legacy `recordings/` folder under appdata if they want. Whispering itself does not touch it. Refused: an auto-cleanup pass at startup, which would silently delete user files in a folder Whispering no longer claims.
  > **Verification note**: Removed the appdata export attachment from `openWhispering`, removed the `RECORDING_MD` appdata helper, deleted the unused frontmatter utility, and added `docs/release-notes/v7.11.1.md` with the legacy-file note. Blob cleanup now filters out `.md` files so stranded appdata markdown remains untouched. The symbol search now finds markdown names only in the explicit exporter, Rust markdown command, transformation docs, release note, spec text, and comments that say recording artifact writes do not touch markdown.

## Verification

Commands:

```sh
bun run check
bun test apps/whispering
```

Targeted behavior checks:

```txt
No export directory:
  app starts without writing markdown files
  recordings still render
  audio playback still works

Configure export directory:
  existing recordings write as {id}.md
  new recording writes as {id}.md

Realtime update:
  transcript edit rewrites body

Realtime delete:
  recording delete removes {id}.md from export folder

Coalescing:
  several updates to one id before a flush produce one final file content

Rebuild:
  orphan .md files are deleted, then valid rows are written

Read-only export:
  editing a generated .md file does not change workspace state
```

## Grill Pass Result

The greenfield grill rejected the first draft of this spec. The draft grouped `observe`, `pull`, `push`, and `rebuild` as if they were one coherent materializer surface. They are not.

```txt
observe:
  live export

pull:
  export refresh

push:
  import and second write path

rebuild:
  repair
```

The collapsed target is smaller:

```txt
Keep:
  user-chosen read-only live export
  rebuild as repair
  Specta write command
  generic delete command

Refuse:
  appdata markdown
  push from the export folder
  realtime markdown watcher
  startup readiness coupling
```

Implementation status from the grill:

```txt
No-go:
  generic push/pull/rebuild materializer in appdata

Go:
  user-chosen read-only markdown export
```

## Open Questions

1. Where should the export directory setting live?
   - Recommendation: device-local settings, not synced workspace KV. A filesystem path is device-specific.

2. Should export start immediately after choosing a folder?
   - Recommendation: yes. Choosing a folder is enough intent to backfill current recordings.

3. Should clearing the folder delete exported markdown files?
   - Recommendation: no. Clearing the setting should stop future writes only.

4. Should Rust write files sequentially or in parallel?
   - Recommendation: sequential for realtime chunks. Bounded parallelism can be considered for `rebuild` after measurement.

5. Should import from markdown exist later?
   - Recommendation: only as a separate import flow with preview and confirmation. It should not reuse the live export folder as an implicit source of truth.

## Go or No-Go

Go if the product wants this user-facing behavior:

```txt
The user can choose a folder where Whispering keeps readable transcript markdown files up to date.
```

No-go if the desired behavior is only this:

```txt
Keep writing hidden appdata markdown sidecars because the code already does it.
```

If no user-facing export folder is wanted now, remove the current appdata projection instead of generalizing it.

## Review

**Completed**: 2026-05-27
**Branch**: `codex/fooji-tauri-plan`

### Summary

Whispering now treats recording markdown as an explicit, device-local export folder instead of a hidden appdata projection. The exporter is read-only from workspace to disk, coalesces rapid edits, supports rebuild, and uses only the Specta `write_markdown_files` and `delete_files_in_directory` commands for filesystem IO.

### Files Read

```txt
apps/whispering/
|-- src-tauri/src/markdown.rs
|-- src/lib/
|   |-- constants/paths.ts
|   |-- recording-markdown-export.ts
|   |-- services/blob-store/file-system.tauri.ts
|   |-- state/device-config.svelte.ts
|   |-- tauri/bindings.gen.ts
|   `-- whispering/tauri.ts
|-- src/routes/(app)/(config)/settings/recording/
|   |-- +page.svelte
|   `-- RecordingMarkdownExportFolder.svelte
docs/release-notes/
`-- v7.11.1.md
```

### Deviations from Spec

- The Wave 4 reactive `lastError` settings-panel bridge was removed before final handoff. Logging plus a once-per-session toast keeps failures visible without exposing the exporter handle as public Svelte state only for one settings row.
- `delete_files_in_directory` kept one Rust command but now accepts a tagged selector: explicit filenames for realtime deletes and an extension selector for rebuild. This preserved the single filesystem boundary while avoiding TypeScript-side directory deletion logic.

### Verification

- `bun run check`
- `bun test apps/whispering`
- `cargo test --manifest-path apps/whispering/src-tauri/Cargo.toml export_types`
- Symbol search for `recording-materializer`, `PATHS.DB.RECORDING_MD`, old appdata export attachment, and `utils/frontmatter` found no active code callers.
