# Remove `fs.content` Namespace

**Date:** 2026-03-14
**Status:** Planned
**Scope:** `packages/filesystem/src/file-system.ts`, `apps/opensidian/`

## Problem

`fs.content` is an inline object on the filesystem with 4 methods:

- `open(id)` — pure passthrough to `contentDocuments.open()`
- `read(id)` — two-liner: open + `handle.read()`
- `write(id, data)` — has real sheet-mode CSV reparsing logic
- `append(id, data)` — has real text-mode Y.Text.insert logic

2 of 4 methods are pure passthrough. The namespace isn't required by `IFileSystem` (just-bash). Consumers already have access to `Documents<FileRow>` through the workspace client (`ws.documents.files.content`). The filesystem shouldn't own a partial proxy of the documents API.

## Solution

Remove `fs.content`. Inline its non-trivial logic into the filesystem's own methods. Consumers access documents directly from the workspace.

## Waves

### Wave 1: Filesystem — inline content helpers, remove namespace

**Files:** `packages/filesystem/src/file-system.ts`

- [ ] **1.1** Inline `content.write` sheet-mode CSV logic directly into `writeFile`
  - Currently `writeFile` calls `this.content.write(id, textData)` on line 288
  - Move the sheet-mode check + CSV reparse + `handle.write()` logic inline
  - Return byte size from the inlined logic (same as `content.write` did)
- [ ] **1.2** Inline `content.append` text-mode logic directly into `appendFile`
  - Currently `appendFile` calls `this.content.append(id, text)` on line 302
  - Move the text-mode check + Y.Text.insert logic inline
  - Return byte size or null (same as `content.append` did)
- [ ] **1.3** Remove the `content` inline object (lines 71–145)
- [ ] **1.4** Update JSDoc on `createYjsFileSystem` — remove mention of `content` from extra members list (line 30)
- [ ] **1.5** Verify: `bun test` in `packages/filesystem` passes (tests don't use `fs.content.*`)

### Wave 2: Consumers — switch to workspace documents

**Files:** `apps/opensidian/src/lib/fs/fs-state.svelte.ts`, `apps/opensidian/src/lib/components/ContentEditor.svelte`

- [ ] **2.1** In `fs-state.svelte.ts`: store `ws.documents.files.content` as a `documents` const alongside `fs`
- [ ] **2.2** Expose `documents` on the state object (so components can access it)
- [ ] **2.3** Update `readContent`: `fs.content.read(id)` → `documents.open(id).then(h => h.read())`
  - Or: `const handle = await documents.open(id); return handle.read();`
- [ ] **2.4** Update `writeContent`: `fs.content.write(id, data)` → `const handle = await documents.open(id); handle.write(data);`
  - Note: this loses the sheet-mode CSV reparsing that `fs.content.write` did. But `writeContent` is only used by the textarea editor which is always text mode. The sheet path was dead code for this call site.
- [ ] **2.5** Update `ContentEditor.svelte`: `fsState.fs.content.open(id)` → `fsState.documents.open(id)`
- [ ] **2.6** Verify: opensidian builds cleanly (`bun run --filter opensidian build` or typecheck)

## Risk Assessment

- **Tests:** filesystem tests don't use `fs.content.*` — they go through `fs.readFile`/`fs.writeFile` or `ws.documents.files.content` directly. No test changes needed.
- **Sheet-mode write in consumers:** `writeContent` in fs-state.svelte.ts loses the CSV reparsing path, but that path was unreachable — the textarea editor only writes text-mode content. Sheet writes go through `fs.writeFile` which will have the logic inlined.
- **Type export:** `YjsFileSystem` is `ReturnType<typeof createYjsFileSystem>` — removing `content` narrows this type automatically. Any external consumers referencing `fs.content` would get a compile error, which is the desired behavior.
