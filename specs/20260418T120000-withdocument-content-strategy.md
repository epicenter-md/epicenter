# withDocument Content Strategy (IoC)

**Date**: 2026-04-18
**Status**: In Progress
**Author**: AI-assisted

## Overview

Replace the implicit "every document is text/richtext/sheet via Timeline" model with an explicit content strategy injected via `.withDocument()`. The user passes a `content` factory that receives a Y.Doc and returns a typed binding. The handle exposes `handle.content` as whatever that factory returned.

## Motivation

### Current State

Every `.withDocument()` call produces a handle with the same generic surface: `read()`, `write()`, `asText()`, `asRichText()`, `asSheet()`, `batch()`, `restoreFromSnapshot()`: regardless of what content type the document actually is:

```ts
// Definition: no content type specified
).withDocument('content', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: Date.now() }),
});

// Consumption: generic handle, all methods available
const handle = await documents.content.open(row);
handle.asText();       // always available
handle.asRichText();   // always available
handle.asSheet();      // always available: even on a chat document?
```

This creates problems:

1. **No type safety at the handle level.** A honeycrisp note handle has `.asSheet()` on it. A filesystem file has `.asRichText()`. These methods exist but are nonsensical for those use cases.
2. **Can't add new content types.** chatTree, canvas, or any custom content type would require modifying the framework's Timeline internals. Adding new entry types, conversion paths, and handle methods.
3. **The Timeline manages format switching for documents that never switch.** 100% of current call sites use a single content type. The Timeline's format conversion machinery is unused overhead.

### Desired State

```ts
// Definition: content type is explicit
).withDocument('content', {
  content: plainText(),
  guid: 'id',
  onUpdate: () => ({ updatedAt: Date.now() }),
});

// Consumption: handle.content IS the binding, fully typed
const handle = await documents.content.open(row);
handle.content            // Y.Text (for plainText strategy)
handle.content.toString() // read
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Content strategy receives Y.Doc | `(ydoc: Y.Doc) => TBinding` | Natural Yjs API, no artificial nesting. Each document IS its own Y.Doc. |
| `content` is a required field | Required | Forces explicit content type. No magic "every doc is everything." |
| `guid` stays explicit | Required field | All current sites use `'id'` but the indirection is proven and cheap. |
| `onUpdate` stays explicit | Required field | Bridge between Y.Doc changes and table row observation. Can't be defaulted safely. |
| ~~Keep backward compat in Phase 1~~ | Old handle methods removed (Phase 2 done) | Phase 2 completed in the same PR. `handle.content` is now the only content access path. |
| Built-in strategies as values | `plainText`, `richText`, `timeline` | Ship common cases. `timeline` wraps the existing Timeline for multi-mode docs. Users can write custom strategies for chatTree etc. |

## Architecture

```
ContentStrategy<TBinding> = (ydoc: Y.Doc) => TBinding

.withDocument('name', {                     DocumentHandle<TBinding>
  content: strategy ──────────────────────▶ { content: TBinding,
  guid: 'id',                                 id, tableName, documentName,
  onUpdate: () => ({...}),                    ydoc, extensions, whenReady }
})
                                            ▲
At open time:                               │
1. Create Y.Doc (guid from row)             │
2. Run extensions (persistence, sync)       │
3. await whenReady                          │
4. binding = strategy(ydoc)  ───────────────┘
5. Attach onUpdate observer
6. Return handle
```

## Implementation Plan

### ~~Phase 1: Add content strategy (additive, no breaking changes)~~

- [x] **1.1** Define `ContentStrategy<TBinding>` type in `types.ts`
- [x] **1.2** Add `content` field to `DocumentConfig` type
- [x] **1.3** Update `withDocument()` in `define-table.ts` to accept and store `content`
- [x] **1.4** Ship `plainText`, `richText`, and `timeline` strategy values in a new `strategies.ts`
- [x] **1.5** Update `create-documents.ts` to call the content strategy at open time and attach to handle
- [x] **1.6** Add `content: TBinding` to `DocumentHandle` type
- [x] **1.7** Update all 5 production `.withDocument()` call sites to add `content` field
- [x] **1.8** Update all handle consumers to use `handle.content`
- [x] **1.9** Verify: `bun typecheck` passes, existing tests pass

### ~~Phase 2: Remove Timeline from handle (completed in same PR)~~

- [x] **2.1** Remove `asText()`, `asRichText()`, `asSheet()`, `read()`, `write()` from handle
- [x] **2.2** Migrate all remaining consumers to `handle.content`
- [x] **2.3** Timeline kept as library: `timeline` strategy returns it
- [x] **2.4** Remove `timeline` from `DocumentContext`

## Call site changes

### Definition sites (+1 line each)

| File | Before | After |
|---|---|---|
| `packages/filesystem/src/table.ts` | `{ guid, onUpdate }` | `{ content: timeline, guid, onUpdate }` |
| `packages/skills/src/tables.ts` (instructions) | `{ guid, onUpdate }` | `{ content: plainText, guid, onUpdate }` |
| `packages/skills/src/tables.ts` (content) | `{ guid, onUpdate }` | `{ content: plainText, guid, onUpdate }` |
| `apps/fuji/src/lib/workspace.ts` | `{ guid, onUpdate }` | `{ content: richText, guid, onUpdate }` |
| `apps/honeycrisp/.../definition.ts` | `{ guid, onUpdate }` | `{ content: richText, guid, onUpdate }` |

### Handle consumption sites (completed)

| Pattern | Before | After (via `handle.content`) |
|---|---|---|
| Read text (timeline) | `handle.read()` | `handle.content.read()` |
| Read text (plainText) | `handle.read()` | `handle.content.toString()` |
| Get Y.Text | `handle.asText()` | `handle.content` (plainText) or `handle.content.asText()` (timeline) |
| Get Y.XmlFragment | `handle.asRichText()` | `handle.content` (richText) or `handle.content.asRichText()` (timeline) |
| Write text (timeline) | `handle.write('x')` | `handle.content.write('x')` |
| Write text (plainText) | `handle.write('x')` | Y.Text: `ydoc.transact(() => { ytext.delete(0, len); ytext.insert(0, 'x') })` |

## Success Criteria

- [ ] `content` field accepted by `.withDocument()` and stored on the definition
- [ ] `plainText()`, `richText()`, and `timeline()` strategies exported from workspace package
- [ ] `handle.content` returns the typed binding at runtime
- [ ] All 5 production call sites updated with `content` field
- [ ] `bun typecheck` passes across the monorepo
- [ ] Existing tests continue to pass (backward compat preserved)

## References

- `packages/workspace/src/workspace/types.ts`: DocumentConfig, DocumentHandle, DocumentContext
- `packages/workspace/src/workspace/define-table.ts`: withDocument() chain
- `packages/workspace/src/workspace/create-documents.ts`: runtime document manager
- `packages/workspace/src/timeline/timeline.ts`: Timeline (to be replaced in Phase 2)
- `packages/filesystem/src/table.ts`: filesystem call site
- `packages/skills/src/tables.ts`: skills call sites
- `apps/fuji/src/lib/workspace.ts`: fuji call site
- `apps/honeycrisp/src/lib/workspace/definition.ts`: honeycrisp call site
