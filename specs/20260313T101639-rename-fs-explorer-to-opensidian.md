# Rename fs-explorer to OpenSidian

**Goal**: Rebrand `apps/fs-explorer` (a dev-only filesystem UI) into **OpenSidian**—the starting point for an Obsidian-like note-taking app within the Epicenter monorepo.

**Scope**: Medium rename—directory, configs, branding, README. No feature changes, no new dependencies, no Tauri yet.

## Context

`apps/fs-explorer/` is a SvelteKit web app with 10 components and one state file. It uses `@epicenter/filesystem`, `@epicenter/workspace`, and `@epicenter/ui`. Currently described as a "dev tool"—that changes with this rename.

The app already has the bones of a file manager (tree view, content editor, create/rename/delete) built on Yjs CRDTs. Renaming it to OpenSidian sets the direction for gradual evolution toward an Obsidian clone.

## Decisions

- **Directory**: `apps/opensidian` (no hyphen—it's a proper noun, not two words)
- **Package name**: `"opensidian"`
- **Stays in monorepo**: Shared packages (`@epicenter/filesystem`, `@epicenter/workspace`, `@epicenter/ui`) are too valuable to fork away from right now
- **Historical specs**: Left untouched. They're historical records referencing `fs-explorer` and that's fine.

## Inventory of Changes

### 1. Rename directory

```
apps/fs-explorer/ → apps/opensidian/
```

Git mv to preserve history.

### 2. Update `apps/opensidian/package.json`

```diff
- "name": "fs-explorer",
+ "name": "opensidian",
```

### 3. Update `apps/opensidian/src/lib/fs/fs-state.svelte.ts`

The workspace ID is used as the IndexedDB database name. Changing it means existing local data won't carry over—acceptable since this had no real users.

```diff
- id: 'fs-explorer',
+ id: 'opensidian',
```

### 4. Update `apps/opensidian/src/app.html`

Add a title tag:

```diff
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
+   <title>OpenSidian</title>
    %sveltekit.head%
  </head>
```

### 5. Rewrite `apps/opensidian/README.md`

Replace the dev-tool README with one describing OpenSidian's purpose:

```markdown
# OpenSidian

Open-source, local-first note-taking app inspired by Obsidian. Built with SvelteKit on the Epicenter ecosystem.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.

## Running

```bash
cd apps/opensidian
bun dev
```
```

### 6. Run `bun install`

Regenerates `bun.lock` with the new package name and directory references.

### 7. Verify build

```bash
cd apps/opensidian && bun run build
```

## Out of Scope

- Updating historical spec files that reference `fs-explorer` (they're accurate records of past work)
- Adding Tauri (future work)
- Any feature changes, new components, or UI modifications
- Logo or favicon changes
- Renaming the `EXECUTE_UNIFY_EXTENSION_LIFECYCLE.md` reference (historical)

## Todo

- [x] 1. `git mv apps/fs-explorer apps/opensidian`
- [x] 2. Update `package.json` name to `"opensidian"`
- [x] 3. Update workspace ID in `fs-state.svelte.ts` from `'fs-explorer'` to `'opensidian'`
- [x] 4. Add `<title>OpenSidian</title>` to `app.html`
- [x] 5. Rewrite `README.md` with new identity
- [x] 6. Run `bun install` to regenerate lockfile
- [x] 7. Verify build passes

## Review

**Status**: Implemented

### Summary

Renamed `apps/fs-explorer` to `apps/opensidian` with `git mv` to preserve history. Updated package name, workspace ID (IndexedDB database name), HTML title, and README. Build passes cleanly.

### Deviations from Spec

None. All changes matched the spec exactly.

### Notes

- Pre-existing a11y warnings (`autofocus` in CreateDialog/RenameDialog) and chunk size warning are unrelated to this rename.
- Historical specs referencing `fs-explorer` left untouched per spec.
