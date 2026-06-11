# Clean Markdown Export with YAML Frontmatter

## Problem

The current `exporter.ts` generates a hybrid format: Markdown wrapping a JSON code block, plus a redundant human-readable summary. This serves neither programmatic nor human consumers well:

- The JSON blob is noise for human readers (the summary already has everything)
- Programmatic consumers must parse Markdown to extract JSON: strictly worse than a `.json` file
- Git diffs are noisy (JSON mutations inside a Markdown code block)
- The summary duplicates 100% of the JSON content

## Solution

Replace the hybrid format with **clean Markdown + YAML frontmatter**. Device-level metadata goes in frontmatter; the body is pure Markdown with tabs organized by window. No JSON blob. No redundancy.

### Before

```markdown
# Device: Chrome on MacBook Pro

**Device ID:** `xK2mP9qL`
**Browser:** chrome
**Last Seen:** 2026-02-18T17:15:30Z

---

## Data

\`\`\`json
{ ... massive JSON blob ... }
\`\`\`

---

## Summary

### Windows (2)

...

### Tabs (8)

...
```

### After

```markdown
---
id: xK2mP9qL
name: Chrome on MacBook Pro
browser: chrome
lastSeen: '2026-02-18T17:15:30Z'
exported: '2026-02-18T17:22:45Z'
windows: 2
tabs: 8
tabGroups: 1
---

# Chrome on MacBook Pro

## Window 1 (focused)

| #   | Title               | URL                                      | Flags          |
| --- | ------------------- | ---------------------------------------- | -------------- |
| 1   | Epicenter - GitHub  | https://github.com/EpicenterHQ/epicenter | active, pinned |
| 2   | TypeScript Handbook | https://typescriptlang.org/docs/         |                |

## Window 2

| #   | Title             | URL                   | Flags |
| --- | ----------------- | --------------------- | ----- |
| 1   | Yjs Documentation | https://docs.yjs.dev/ |       |

## Tab Groups

**Work** (blue) - 4 tabs
**Research** (green, collapsed) - 2 tabs
```

### Why This Format

- **YAML frontmatter** is the standard for Obsidian, Jekyll, Hugo: tools already parse it
- **Tables** render cleanly in GitHub, Obsidian, and any Markdown viewer
- **Window-scoped tabs**: tabs listed under their window, which is how humans think about them (not a flat list)
- **No redundancy**: metadata in frontmatter, content in body, nothing repeated
- **Clean git diffs**: a tab title change is a single table row diff

## Todo

- [x] Rewrite `generateMarkdown()` in `exporter.ts`: YAML frontmatter + window-scoped tab tables
- [x] Remove `generateSummary()` (absorbed into the new `generateMarkdown`)
- [x] Use `Bun.YAML.stringify()` for frontmatter serialization (no hand-written YAML)
- [x] Replace Node `fs`/`path` with `Bun.write()` (`createPath: true`) in `markdown-persistence-extension.ts`
- [x] Update JSDoc in `exporter.ts` and `markdown-persistence-extension.ts`
- [x] Typecheck with `bun run typecheck` in `apps/tab-manager-markdown`

## Non-Goals

- No new dependencies: used Bun's built-in `YAML.stringify()` and `Bun.write()`
- No changes to `index.ts`
- No changes to the workspace definition or data model
- No bidirectional sync

## Technical Notes

- `Bun.YAML.stringify(obj, null, 2)` produces block-style YAML (multi-line, human-readable)
- `Bun.write(path, data, { createPath: true })` auto-creates parent directories: removed `fs.mkdir`
- Tab titles may contain pipe characters (`|`) which break Markdown tables: escaped with `\|`
- The flat tab list sorted by index is replaced by tabs grouped under their parent window
- Tab groups section stays at the bottom as a summary (groups span windows)

## Review

### Changes Made

**`exporter.ts`**: Full rewrite of `generateMarkdown()`, removed `generateSummary()`:

- YAML frontmatter via `Bun.YAML.stringify()` with device metadata + counts
- Body: tabs grouped by window in Markdown tables (not a flat list)
- Pipe character escaping for table cells
- No JSON code block, no redundant summary section

**`markdown-persistence-extension.ts`**: Swapped Node APIs for Bun:

- Replaced `fs.writeFile()` with `Bun.write()` (`createPath: true`)
- Removed `fs.mkdir()` call (directory creation handled by `Bun.write`)
- Removed `import { promises as fs } from 'node:fs'`
- Updated JSDoc to reflect Bun API usage
