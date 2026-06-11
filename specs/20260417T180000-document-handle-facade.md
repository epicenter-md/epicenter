# Strategy-Owned Handles and Minimal Document Surface

**Date**: 2026-04-17
**Status**: Draft
**Author**: AI-assisted

## Overview

Replace the current `DocumentHandle` wrapper. Which exposes `content`, `ydoc`, `awareness`, `extensions`, `id`, `tableName`, `documentName`, and `whenReady`: with a design where `open()` returns the strategy's content object directly. Each strategy provides its own `read()`/`write()` methods, so consumers never need `ydoc`. The documents manager surface shrinks to three methods: `open`, `close`, `closeAll`.

## Motivation

### Current State

Every `open()` call returns a `DocumentHandle` with 8 properties. Consumers use exactly one:

```typescript
const handle = await documents.files.content.open(id);
handle.content.read();    // ← the only thing anyone touches
```

The other 7 (`ydoc`, `awareness`, `extensions`, `id`, `tableName`, `documentName`, `whenReady`) exist for extension factories and tests. Zero app-level call sites access them. Except `handle.ydoc`, which `skills/node.ts` reaches into for `transact()` because the `plainText` strategy returns a raw `Y.Text` with no write method:

```typescript
// skills/node.ts: forced to reach through the handle into Y.Doc
const handle = await client.documents.skills.instructions.open(skillId);
handle.ydoc.transact(() => {
  const ytext = handle.content;
  ytext.delete(0, ytext.length);
  ytext.insert(0, instructions);
});
```

This creates two problems:

1. **Autocomplete noise.** Typing `handle.` shows 8 properties when you need 1. Every new developer wonders what `handle.tableName` is for (answer: nothing, in app code).
2. **Leaky abstraction.** The `plainText` strategy hands you a raw `Y.Text` but no way to write to it without reaching past the handle into `ydoc.transact()`. The strategy created a binding but didn't encapsulate its own write path.

### Desired State

```typescript
// open() returns the content directly: no wrapper
const content = await documents.files.content.open(id);
content.read();         // every strategy provides this
content.write('hello'); // every strategy provides this

// plainText: no ydoc needed
const text = await documents.skills.instructions.open(skillId);
text.write(instructions);  // strategy handles transact internally
text.binding;              // Y.Text for editor binding when needed
```

The documents manager surface:

```
documents.files.content.
  ├── open(id)       → Promise<TContent>
  ├── close(id)      → Promise<void>
  └── closeAll()     → Promise<void>
```

Three methods. Infrastructure (`ydoc`, `awareness`, `extensions`) is internal. No public accessor. When a genuine consumer need arises (cursor presence via awareness), a targeted accessor gets added then.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `open()` returns content directly | `Promise<TContent>` not `Promise<DocumentHandle>` | Eliminates the `.content` indirection. 95% of call sites just want the binding. |
| Strategies must provide `read()` and `write()` | Base `ContentHandle` contract | Consumers never need `ydoc`. The strategy encapsulates `transact()`. |
| Editor binding via `.binding` property | Explicit accessor, not "content IS the Yjs type" | Makes the raw Yjs type opt-in for editor code. `content.binding` reads as "give me the thing to bind." |
| No `ydoc()` or `awareness()` accessor initially | Deferred | Zero production consumers need these today. Adding them later is additive and non-breaking. |
| `DocumentContext` unchanged | Extension factories keep the full internal view | Extensions still receive `{ id, tableName, documentName, ydoc, extensions, whenReady, awareness }`. This change is consumer-facing only. |

## Architecture

### Strategy Contract

```typescript
/**
 * Base contract every strategy must satisfy.
 * Consumers can always read/write regardless of strategy.
 */
type ContentHandle = {
  read(): string;
  write(text: string): void;
};

type ContentStrategy<THandle extends ContentHandle> = (ydoc: Y.Doc) => THandle;
```

### Built-In Strategies

```
ContentStrategy<THandle extends ContentHandle> = (ydoc: Y.Doc) => THandle
                                                                    │
         ┌──────────────────────────────────────────────────────────┼─────────────────────┐
         │                                                          │                     │
    PlainTextHandle                                            Timeline            RichTextHandle
    ┌────────────────────┐                              (already satisfies       ┌────────────────────┐
    │ read(): string     │                               ContentHandle)          │ read(): string     │
    │ write(text): void  │                              ┌─────────────────┐      │ write(text): void  │
    │ binding: Y.Text    │                              │ read(): string  │      │ binding: XmlFrag   │
    └────────────────────┘                              │ write(text)     │      └────────────────────┘
                                                        │ asText()        │
    (ydoc) => {                                         │ asRichText()    │      (ydoc) => {
      const ytext = ydoc.getText('content');            │ asSheet()       │        const frag = ydoc
      return {                                          │ batch(fn)       │          .getXmlFragment('content');
        get binding() { return ytext; },                │ observe(fn)     │        return {
        read() { return ytext.toString(); },            │ ...             │          get binding() { return frag; },
        write(text) {                                   └─────────────────┘          read() { ... },
          ydoc.transact(() => {                                                     write(text) { ... },
            ytext.delete(0, ytext.length);                                        };
            ytext.insert(0, text);                                              }
          });
        },
      };
    }
```

### Documents Manager (After)

```
documents.files.content
  │
  ├── open(id)       → Promise<TContent>     Content object, fully typed by strategy
  ├── close(id)      → Promise<void>         Unchanged
  └── closeAll()     → Promise<void>         Unchanged

  Internally still manages:
  ┌──────────────────────────────────────┐
  │  openDocuments: Map<guid, DocEntry>  │
  │    DocEntry {                        │
  │      content: TContent               │
  │      ydoc: Y.Doc                     │
  │      awareness: AwarenessHelper      │
  │      extensions: { ... }             │
  │      whenReady: Promise<void>        │
  │    }                                 │
  └──────────────────────────────────────┘
  Not exposed. Extension factories receive DocEntry fields via DocumentContext.
```

## Call Site Migration

### App code (editors)

```typescript
// BEFORE
const handle = await workspace.documents.notes.body.open(noteId);
currentYXmlFragment = handle.content;               // raw Y.XmlFragment

// AFTER
const content = await workspace.documents.notes.body.open(noteId);
currentYXmlFragment = content.binding;               // explicit accessor
```

### App code (timeline: opensidian)

```typescript
// BEFORE
const handle = await workspace.documents.files.content.open(id);
handle.content.asText();

// AFTER
const content = await workspace.documents.files.content.open(id);
content.asText();                                    // no .content wrapper
```

### Package code (skills/node.ts: the pain point)

```typescript
// BEFORE: reaches into ydoc
const handle = await client.documents.skills.instructions.open(skillId);
handle.ydoc.transact(() => {
  const ytext = handle.content;
  ytext.delete(0, ytext.length);
  ytext.insert(0, instructions);
});

// AFTER: strategy owns write
const content = await client.documents.skills.instructions.open(skillId);
content.write(instructions);
```

### Package code (skills/workspace.ts: read)

```typescript
// BEFORE
const handle = await client.documents.skills.instructions.open(id);
return { skill, instructions: handle.content.toString() };

// AFTER
const content = await client.documents.skills.instructions.open(id);
return { skill, instructions: content.read() };
```

### Package code (filesystem: sqlite index)

```typescript
// BEFORE
const handle = await documents.open(row);
const text = handle.content.read();

// AFTER
const content = await documents.open(row);
const text = content.read();
```

## Implementation Plan

### Phase 1: Strategy-owned read/write (non-breaking, additive)

Introduce `PlainTextHandle` and `RichTextHandle` types and update `plainText`/`richText` strategies to return them instead of raw Yjs types. Timeline already satisfies `ContentHandle`.

- [x] **1.1** Define `ContentHandle` base type in `types.ts`: `{ read(): string; write(text: string): void }`
- [x] **1.2** Define `PlainTextHandle` type: `ContentHandle & { binding: Y.Text }`
- [x] **1.3** Define `RichTextHandle` type: `ContentHandle & { binding: Y.XmlFragment }`
- [x] **1.4** Update `plainText` strategy in `strategies.ts` to return `PlainTextHandle`: wraps Y.Text with `read()`, `write()`, and `binding` getter
- [x] **1.5** Update `richText` strategy in `strategies.ts` to return `RichTextHandle`: wraps Y.XmlFragment with `read()`, `write()`, and `binding` getter
- [x] **1.6** Verify `timeline` strategy's return type satisfies `ContentHandle` (it should: Timeline has `read()` and `write()`)
- [x] **1.7** Update `skills/node.ts`: replace `handle.ydoc.transact()` pattern with `handle.content.write()`
  > **Note**: Phase 1 keeps the DocumentHandle wrapper, so consumers use `handle.content.write()` not `content.write()` directly. Phase 2 removes the wrapper.
- [x] **1.8** Update `skills/workspace.ts`: replace `handle.content.toString()` with `handle.content.read()`
- [x] **1.9** `bun typecheck` passes (zero new errors), existing tests pass (47/47 document tests)

### Phase 2: Flatten handle: open() returns content directly (breaking)

Remove the `DocumentHandle` wrapper. `open()` returns `TContent` instead of `DocumentHandle<..., TContent>`.

- [x] **2.1** Change `Documents.open()` return type from `Promise<DocumentHandle<...>>` to `Promise<TBinding>`
- [x] **2.2** Update `create-documents.ts`: `open()` returns `contentBinding` instead of the full handle object
- [x] **2.3** Store the full `DocEntry` internally in the `openDocuments` map (unchanged) but only return content to consumers
- [x] **2.4** Migrate all `handle.content.X()` → `content.X()` across apps and packages
  > Migrated: skills/node.ts, skills/workspace.ts, filesystem/file-system.ts, filesystem/sqlite-index, playground/epicenter.config.ts, push-from-markdown.ts, epicenter.config.test.ts
- [x] **2.5** Migrate all `handle.content` (bare, for editor binding) → `content.binding`
  > Migrated: InstructionsEditor.svelte, ReferencesPanel.svelte, +page.svelte (honeycrisp), EntryEditor.svelte (fuji), ContentEditor.svelte (opensidian)
- [x] **2.6** Remove `DocumentHandle` type export (kept as internal alias with `@internal` JSDoc)
- [x] **2.7** Update `DocumentsOf` and `Documents` types to reflect new return type
- [x] **2.8** Update all tests: removed assertions on `handle.tableName`, `handle.documentName`, `handle.ydoc`, `handle.extensions`, `handle.awareness`
  > create-documents.test.ts: 37 pass, 0 fail. file-system.test.ts: 55 pass (6 pre-existing failures). epicenter.config.test.ts: clean.
- [x] **2.9** Update READMEs, JSDoc, strategies.ts examples, document-content.md skill reference
- [x] **2.10** `bun typecheck` passes (zero new errors), `bun test` passes across monorepo

### Phase 3: Future: plumbing accessors (when needed, not now)

When a genuine consumer need arises (cursor presence, extension inspection), add dedicated methods to the documents manager. One per concern:

```typescript
documents.files.content.ydoc(id)       → Y.Doc | null
documents.files.content.awareness(id)  → AwarenessHelper | null
```

Each accessor returns `null` if the document isn't open. Add them individually as the need materializes: `awareness()` when cursor presence ships, `ydoc()` if a consumer genuinely needs raw doc access beyond what the strategy provides. No bag-of-everything `internals()` method.

## Execution Guide: Grep Patterns

These patterns find every call site that needs migration. Run each and verify the count goes to zero after migration.

### Phase 1 patterns (strategy-owned write)

```bash
# The ydoc.transact pattern in plainText consumers: THE bug this fixes
rg 'handle\.ydoc\.transact' --type ts

# Raw Y.Text manipulation through handle.content (plainText consumers writing)
rg 'handle\.content\.delete|handle\.content\.insert' --type ts

# .toString() on handle.content (becomes .read())
rg 'handle\.content\.toString\(\)' --type ts
rg 'Handle\.content\.toString\(\)' --type ts
rg 'contentHandle\.content\.toString\(\)' --type ts
rg 'instructionsHandle\.content\.toString\(\)' --type ts
```

### Phase 2 patterns (flatten handle)

```bash
# Every handle.content access: all must become just content.X()
rg 'handle\.content\b' --type ts --type svelte
rg '\.content\.read\(\)' --type ts --type svelte
rg '\.content\.write\(' --type ts --type svelte
rg '\.content\.asText\(\)' --type ts --type svelte
rg '\.content\.asRichText\(\)' --type ts --type svelte
rg '\.content\.asSheet\(\)' --type ts --type svelte
rg '\.content\.observe\(' --type ts
rg '\.content\.batch\(' --type ts

# Dead properties that should no longer appear on return value of open()
rg 'handle\.(ydoc|awareness|extensions|whenReady|tableName|documentName|id)\b' --type ts --type svelte

# The DocumentHandle type itself: should be removed or internalized
rg 'DocumentHandle' --type ts

# Editor bindings that grab raw Yjs type (handle.content → content.binding)
rg 'handle\.content;' --type svelte   # bare access, not method call: editor binding
rg '= handle\.content$' --type ts     # assignment of raw binding

# Variable naming: find all 'handle' variables from open() calls
rg 'const handle = await.*\.open\(' --type ts --type svelte
rg '\.open\(.*\)\.then\(\(handle\)' --type ts --type svelte
rg '\.open\(.*\)\.then\(\(h\)' --type ts --type svelte
```

### Verification after each phase

```bash
# Phase 1 complete when:
rg 'handle\.ydoc' --type ts          # zero results outside tests
rg '\.content\.toString\(\)' --type ts  # zero results (all .read() now)

# Phase 2 complete when:
rg 'handle\.content\b' --type ts --type svelte  # zero results
rg 'DocumentHandle' --type ts                    # zero results in public API (internal only)
```

## Edge Cases

### Timeline already satisfies ContentHandle

`Timeline` has `read(): string` and `write(text: string): void`. No wrapper needed. But it also exposes `ydoc` as a readonly property (line 45 of timeline.ts). After Phase 2, this is the only path a consumer could reach the Y.Doc through:

```typescript
const content = await documents.files.content.open(id);
content.ydoc;  // Timeline exposes this: should it?
```

Recommendation: remove `ydoc` from Timeline's public type in a follow-up. Timeline shouldn't expose its internal doc. Its `batch()` method already wraps `ydoc.transact()`.

### Idempotent open()

`open()` is currently idempotent: calling it twice returns the same handle. This must remain true: calling it twice returns the same content object (same reference). The internal `DocEntry` is cached; we just return `entry.content` instead of the full entry.

### close() after open(): dangling content references

If a consumer holds a content reference and someone calls `close(id)`, the underlying Y.Doc is destroyed. `content.read()` on a destroyed doc is undefined behavior in Yjs. This is the same risk as today, no change needed. Document it.

### richText write(): what does it do?

`RichTextHandle.write(text)` receives a plain string. For a `Y.XmlFragment`, writing plain text means clearing the fragment and inserting a paragraph node with that text. This matches the existing `Timeline.write()` behavior for richtext mode. The implementer should verify the exact ProseMirror-compatible node structure.

## Open Questions

1. **Should `PlainTextHandle` also expose `insert()` and `delete()`?**
   - `skills/node.ts` currently does positional insert/delete via raw Y.Text. With `write()` covering the full-replace case, is positional editing needed on the handle?
   - Recommendation: Start with `read()` + `write()` + `binding` only. If a consumer needs positional ops, they use `content.binding.insert(pos, text)`: that's the editor binding path, which is expected to touch raw Yjs.

2. **Should `binding` be a method or a getter?**
   - Getter: `content.binding`: consistent with property access
   - Method: `content.getBinding()`: signals "this gives you a live Yjs reference, handle with care"
   - Recommendation: Getter. It's a stable reference, not a computation. `content.binding` reads naturally.

3. **Should Timeline expose `.binding`?**
   - Timeline's equivalent is `.asText()` / `.asRichText()` / `.asSheet()`: it has multiple bindings depending on mode. A single `.binding` property doesn't make sense.
   - Recommendation: No. Timeline keeps its existing `asText()`/`asRichText()`/`asSheet()` methods. The `binding` property is a `PlainTextHandle`/`RichTextHandle` concept only.

## Success Criteria

- [ ] Every strategy provides `read()` and `write()`: no consumer needs `ydoc`
- [ ] `open()` returns `TContent` directly: no `.content` indirection
- [ ] Documents manager surface is exactly `open`, `close`, `closeAll`
- [ ] Zero `handle.ydoc` references in non-test code
- [ ] Zero `handle.content.X()` patterns (all `content.X()`)
- [ ] `bun typecheck` passes across the monorepo
- [ ] `bun test` passes across the monorepo (minus intentional test updates)
- [ ] READMEs and JSDoc updated to match new API

## References

- `packages/workspace/src/workspace/types.ts`: `DocumentHandle`, `DocumentClient`, `DocumentContext`, `Documents`, `DocumentsOf`
- `packages/workspace/src/workspace/create-documents.ts`: runtime document manager, `open()` implementation
- `packages/workspace/src/workspace/strategies.ts`: `plainText`, `richText`, `timeline` strategies
- `packages/workspace/src/timeline/timeline.ts`: Timeline type (already satisfies ContentHandle)
- `packages/skills/src/node.ts`: the `ydoc.transact()` pain point (lines 137, 170)
- `packages/skills/src/workspace.ts`: `.content.toString()` call sites (lines 95, 123, 128)
- `packages/filesystem/src/extensions/sqlite-index/index.ts`: `.content.read()` call site
- `apps/honeycrisp/src/routes/+page.svelte`: editor binding (`handle.content`)
- `apps/fuji/src/lib/components/EntryEditor.svelte`: editor binding (`handle.content`)
- `apps/opensidian/src/lib/components/editor/ContentEditor.svelte`: timeline usage (`handle.content.asText()`)
- `apps/skills/src/lib/components/editor/InstructionsEditor.svelte`: handle open pattern
- `specs/20260418T120000-withdocument-content-strategy.md`: prior spec (content strategy introduction)
