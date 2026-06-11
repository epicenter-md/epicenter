# Tab Manager Markdown: Replace createExporter with Persistence Extension

## Problem

The tab-manager-markdown app had two separate systems:

1. `createWorkspace(definition).withExtension('sync', ...)`: workspace with sync
2. `createExporter(...)`: a hand-rolled observer that debounces and writes markdown files

The exporter was doing what a persistence extension should do (observe Y.Doc → write to filesystem), but it lived outside the workspace lifecycle. This meant:

- No `whenReady` / `destroy` integration
- Manual observer wiring for each table
- Separate flush/shutdown logic
- Didn't benefit from the extension ordering guarantees (persistence before sync)

## Solution

Replaced `createExporter` with a `createMarkdownPersistenceExtension` that returns an `Extension<{}>`, chained before sync:

```typescript
const client = createWorkspace(definition)
  .withExtension('persistence', createMarkdownPersistenceExtension({
    outputDir: './markdown/devices',
    debounceMs: 1000,
  }))
  .withExtension('sync', createSyncExtension({
    url: 'ws://localhost:3913/workspaces/{id}/sync',
  }));
```

The persistence extension:
- Observes all table changes internally (using `ydoc.on('update', ...)`)
- Debounces writes
- Returns `{ exports: { flush }, whenReady, destroy }` following the `Extension` contract
- Handles cleanup (clear timers, flush pending writes) in `destroy`

The sync extension already awaits `client.whenReady` before connecting, so ordering is automatic.

## Todo

- [x] Create `createMarkdownPersistenceExtension` in `src/markdown-persistence-extension.ts`
  - Takes `{ outputDir, debounceMs }` config
  - Returns `ExtensionFactory` (receives `ExtensionContext`, returns `Extension`)
  - Uses `ydoc.on('update', ...)` to observe all changes (simpler than per-table observers)
  - Debounces writes with the same timer logic from current exporter
  - Exports `{ flush }` so callers can force-write pending changes
  - `destroy` clears timers and flushes pending writes
  - `whenReady` ensures output directory exists
  - Reuses the existing `generateMarkdown` / `generateSummary` functions from `exporter.ts`
- [x] Refactor `src/exporter.ts`: keep only the pure markdown generation functions (`generateMarkdown`, `generateSummary`, types), remove `createExporter`
- [x] Update `src/index.ts` to use the new extension chain, remove manual observer wiring and shutdown logic
- [x] Verify with `bun run typecheck` in the app directory

## Non-goals

- Don't move this extension into `packages/epicenter`: it's app-specific markdown serialization
- Don't change the markdown output format
- Don't change the sync extension config
