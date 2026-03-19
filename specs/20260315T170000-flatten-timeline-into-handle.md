# Flatten Timeline Into DocumentHandle

**Date**: 2026-03-15
**Status**: Draft
**Author**: AI-assisted

## Overview

Merge the `Timeline` abstraction into `DocumentHandle` so that the handle IS the timeline—one object instead of two layers of delegation. `DocumentHandle` becomes `Timeline & { exports }`.

## Motivation

### Current State

Three layers sit between a consumer and the content CRDT:

```
Consumer  →  DocumentHandle  →  Timeline  →  Y.Doc.getArray('timeline')
```

`makeHandle()` in `create-document.ts` creates a Timeline, then wraps every method with thin delegation:

```typescript
function makeHandle(ydoc, extensions): DocumentHandle {
    const tl = createTimeline(ydoc);
    return {
        ydoc,                                                // pass-through
        get mode() { return tl.currentType; },               // rename
        read() { return tl.readAsString(); },                // rename
        write(text) { ydoc.transact(() => tl.replaceCurrentText(text)); },  // transact wrapper
        asText()  { /* switch + tl.pushText in transact */ },               // mode conversion
        asRichText() { /* switch + tl.pushRichtext in transact */ },        // mode conversion
        asSheet() { /* switch + tl.pushSheetFromCsv in transact */ },       // mode conversion
        timeline: tl,                                        // escape hatch to... itself
        batch(fn) { ydoc.transact(fn); },                    // alias
        exports: extensions,                                 // lifecycle concern
    };
}
```

Every handle method falls into one of four categories:

| Category | Methods | What it actually does |
|---|---|---|
| Rename | `mode`, `read` | Delegates to Timeline with a different name |
| Transact wrapper | `write`, `batch` | Calls Timeline method inside `ydoc.transact()` |
| Mode conversion | `asText`, `asRichText`, `asSheet` | `readEntry()` + conditional push in transact |
| Pass-through | `ydoc`, `timeline`, `exports` | Returns something Timeline already has or doesn't need |

This creates problems:

1. **The escape hatch is the loudest signal.** Consumers write `handle.timeline.pushRichtext()` and `handle.timeline.currentEntry` constantly. The filesystem package accesses `handle.timeline` in 6 of its 8 handle call sites. When the escape hatch is used more than the abstraction, the abstraction is wrong.

2. **Two names for one thing.** `handle.mode` vs `tl.currentType`. `handle.read()` vs `tl.readAsString()`. Consumers learn two APIs for the same data. New developers have to decide which to use.

3. **Mode conversion is just timeline logic.** The `asText`/`asRichText`/`asSheet` methods read the current entry via `readEntry()` (already a timeline function), then push a new entry via timeline push methods, wrapped in `ydoc.transact()`. This is timeline behavior; it ended up on the handle by historical accident.

### Desired State

```
Consumer  →  Timeline  →  Y.Doc.getArray('timeline')
```

One object. The handle IS the timeline. The only addition for content documents is `exports` (per-doc extension lifecycle).

## Research Findings

### Consumer Usage Audit

Grepped all `handle.*` access across the monorepo (114 occurrences, 8 files):

| Pattern | Occurrences | Files | Observation |
|---|---|---|---|
| `handle.timeline.*` | 18 | 3 files | Escape hatch used heavily—length, currentEntry, push methods |
| `handle.read()` | 7 | 4 files | Core consumer API |
| `handle.write()` | 14 | 3 files | Core consumer API |
| `handle.ydoc` | 8 | 2 files | Needed for sync, testing, `restoreFromSnapshot` |
| `handle.batch()` | 5 | 2 files | Wraps `ydoc.transact()` |
| `handle.mode` | 12 | 1 file | Tests only |
| `handle.asText/asRichText/asSheet` | 22 | 1 file | Tests + editor binding |
| `handle.exports` | 12 | 1 file | Extension system |

**Key finding:** `handle.timeline.*` accounts for 16% of all handle access. Every one of those would become a direct property access if the layers were flat. The filesystem package—the most sophisticated consumer—uses `readEntry(handle.timeline.currentEntry)` to do work the handle should be doing natively.

### `restoreFromSnapshot` Usage

`restoreFromSnapshot(ydoc, binary)` calls `createTimeline(ydoc)` on both the temp doc and the live doc. It uses only low-level push methods (`replaceCurrentText`, `pushSheetFromCsv`, `pushRichtextFromFragment`). It does NOT need mode conversion or `exports`.

This is fine—`createTimeline` still works standalone. The flattening adds methods to Timeline; it doesn't remove any. `restoreFromSnapshot` keeps calling the same methods it already calls.

### Getter Spreading Limitation

Timeline's returned object uses `get length()`, `get currentEntry()`, `get currentType()`. JavaScript's `{ ...obj }` evaluates getters (captures values) rather than copying the descriptors. So `{ ...timeline, exports }` would freeze the getter values.

Two approaches:
- `Object.assign(timeline, { exports })` — adds `exports` to the existing object, preserving getters on the target. Works because Timeline returns a fresh object per call.
- `Object.defineProperties(...)` — more explicit but verbose.

`Object.assign` is the simple path.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where mode conversion lives | On Timeline directly | It's just `readEntry()` + conditional push—all timeline primitives. No external dependencies beyond what Timeline already imports. |
| Whether Timeline exposes `ydoc` | Yes, as `readonly ydoc` | Consumers need it for sync providers, testing, and `restoreFromSnapshot`. Timeline already has it via closure; exposing it is zero-cost. |
| How `DocumentHandle` relates to `Timeline` | `Timeline & { exports }` | `exports` is the only lifecycle concern that can't live on Timeline. Everything else is timeline behavior. |
| What happens to `handle.timeline` | Remove | The handle IS the timeline. An escape hatch to yourself is `this`. Removing it simplifies the type and avoids confusion. |
| Whether `read`/`readAsString` coexist | Keep both | `read()` is the consumer name. `readAsString()` is the explicit name used by `restoreFromSnapshot` internals. Aliasing is fine. |
| Whether push methods auto-transact | No | Keep push methods non-transacting for batching flexibility. Higher-level methods (`write`, `asText`, etc.) transact. This preserves the ability to batch multiple push operations in `handle.batch()`. |

## Architecture

### Before (two objects, delegation)

```
┌──────────────────────────────────────────────┐
│  DocumentHandle                               │
│  ├── ydoc: Y.Doc                              │
│  ├── mode → tl.currentType                    │  rename
│  ├── read() → tl.readAsString()               │  rename
│  ├── write() → transact(tl.replaceCurrentText)│  transact wrap
│  ├── asText() → readEntry + tl.pushText       │  mode conversion
│  ├── asRichText() → readEntry + tl.pushRT     │  mode conversion
│  ├── asSheet() → readEntry + tl.pushSheet     │  mode conversion
│  ├── timeline: tl  ←── escape hatch           │  pass-through
│  ├── batch() → ydoc.transact()                │  alias
│  └── exports: Record<...>                     │  lifecycle
│         │                                     │
│         ▼                                     │
│  ┌──────────────────────────────────┐         │
│  │  Timeline (tl)                    │         │
│  │  ├── length, currentEntry, mode   │         │
│  │  ├── pushText, pushSheet, ...     │         │
│  │  ├── replaceCurrentText           │         │
│  │  ├── pushRichtextFromFragment     │         │
│  │  └── readAsString                 │         │
│  └──────────────────────────────────┘         │
└──────────────────────────────────────────────┘
```

### After (one object)

```
┌──────────────────────────────────────────────┐
│  Timeline (= DocumentHandle sans exports)     │
│                                               │
│  Identity                                     │
│  ├── ydoc: Y.Doc                              │
│                                               │
│  State (getters)                              │
│  ├── length, currentEntry, currentType        │
│                                               │
│  Low-level push (no transact, for batching)   │
│  ├── pushText, pushSheet, pushRichtext        │
│  ├── pushSheetFromCsv, pushRichtextFromFrag.  │
│  ├── replaceCurrentText                       │
│                                               │
│  Content access (mode-aware, transact-wrapped) │
│  ├── read(): string                           │
│  ├── write(text): void                        │
│  ├── asText(): Y.Text                         │
│  ├── asRichText(): Y.XmlFragment              │
│  ├── asSheet(): SheetBinding                  │
│                                               │
│  Utilities                                    │
│  ├── readAsString(): string                   │
│  └── batch(fn): void                          │
└──────────────────────────────────────────────┘

DocumentHandle = Timeline & { exports: Record<string, Record<string, unknown>> }
```

### `makeHandle` after flattening

```typescript
function makeHandle(ydoc: Y.Doc, extensions: Record<string, Extension<any>>): DocumentHandle {
    return Object.assign(createTimeline(ydoc), { exports: extensions });
}
```

One line. Down from 80.

## Implementation Plan

### Phase 1: Expand Timeline

- [ ] **1.1** Add `ydoc: Y.Doc` to `Timeline` type and `createTimeline` return
- [ ] **1.2** Add `read()`, `write(text)`, `batch(fn)` to Timeline (transact-wrapped)
- [ ] **1.3** Add `asText()`, `asRichText()`, `asSheet()` to Timeline (move mode conversion logic from `makeHandle`)
- [ ] **1.4** Add `mode` getter (alias for `currentType`—decide in Open Questions whether to keep both or pick one name)
- [ ] **1.5** Update `Timeline` type definition with all new methods + JSDoc
- [ ] **1.6** Update timeline barrel exports (`index.ts`) if needed

### Phase 2: Flatten DocumentHandle

- [ ] **2.1** Update `DocumentHandle` type in `types.ts` to extend `Timeline` with just `{ exports }`
- [ ] **2.2** Replace `makeHandle` body with `Object.assign(createTimeline(ydoc), { exports })`
- [ ] **2.3** Remove `timeline` property from `DocumentHandle` type (the handle IS the timeline)
- [ ] **2.4** Remove now-unused imports in `create-document.ts` (`readEntry`, `xmlFragmentToPlaintext`, `populateFragmentFromText`, `serializeSheetToCsv`)

### Phase 3: Migrate consumers

- [ ] **3.1** Replace `handle.timeline.X` → `handle.X` across filesystem package and tests
- [ ] **3.2** Replace `readEntry(handle.timeline.currentEntry)` → `readEntry(handle.currentEntry)` in filesystem
- [ ] **3.3** Update all test files that use `handle.timeline.*`
- [ ] **3.4** Update JSDoc examples referencing `handle.timeline`
- [ ] **3.5** Grep for any remaining `\.timeline` access and fix

### Phase 4: Verify

- [ ] **4.1** `bun typecheck` passes
- [ ] **4.2** `bun test packages/workspace/` passes (394 tests)
- [ ] **4.3** `bun test packages/filesystem/` passes
- [ ] **4.4** LSP diagnostics clean on all changed files

## Edge Cases

### `restoreFromSnapshot` uses `createTimeline` on temp docs

The temp doc gets a full Timeline object including the new mode conversion methods. These are unused—zero cost. `restoreFromSnapshot` keeps calling `replaceCurrentText`, `pushSheetFromCsv`, `pushRichtextFromFragment` directly. No change needed.

### Consumer destructures handle

If someone writes `const { read, write } = handle`, method shorthands using `this` (inside Timeline) would break. Current codebase never destructures handles—all access is `handle.method()`. Timeline methods that call `this.pushText()` (e.g., `replaceCurrentText`, `pushRichtextFromFragment`) require method-call `this` binding.

### `createTimeline` import surface grows

Timeline currently imports `xmlFragmentToPlaintext`, `serializeSheetToCsv` from sibling modules. Adding `asText`/`asRichText`/`asSheet` requires adding `populateFragmentFromText` and `readEntry` (already in same file). The dependency surface grows by one import. This is acceptable—these are all timeline-adjacent concerns in the same package.

### Package exports change

`@epicenter/workspace` exports `Timeline` type and `createTimeline`. If `Timeline` type expands, downstream consumers get more methods for free. No breaking change.

`DocumentHandle` type changes from a standalone type to `Timeline & { exports }`. Consumers that import `DocumentHandle` type get the expanded API. The removed `timeline` property is a breaking change for any code that accesses it.

## Open Questions

1. **Should `mode` and `currentType` coexist?**
   - `currentType` is the Timeline name (explicit). `mode` is the handle name (concise).
   - Options: (a) keep both as aliases, (b) rename to just `mode` everywhere, (c) keep `currentType` and drop `mode`
   - **Recommendation**: Keep `currentType` as the canonical name. It's more explicit and already used by `restoreFromSnapshot` and all timeline tests. Drop the `mode` alias—one name is better than two.

2. **Should `read()` and `readAsString()` coexist?**
   - Same function, two names. `read()` is concise for consumers. `readAsString()` is explicit about what it does.
   - Options: (a) keep both, (b) rename to just `read()`, (c) keep just `readAsString()`
   - **Recommendation**: Keep both. `readAsString()` is the descriptive name that reads well in internal code. `read()` is the consumer-facing alias that reads well in app code. The cost of an alias is near zero.

3. **Should `write()` stay as a separate method or be renamed to `replaceCurrentText`?**
   - `write()` is handle's name. `replaceCurrentText()` is Timeline's name. They do the same thing, except `write()` wraps in transact.
   - Options: (a) keep `write()` as transact-wrapped alias, (b) make `replaceCurrentText` auto-transact and drop `write`, (c) keep both
   - **Recommendation**: Keep `write()` as the consumer-facing transact-wrapped method. `replaceCurrentText()` stays non-transacting for use inside `batch()` calls and `restoreFromSnapshot`. Different transaction semantics justify different names.

4. **Should `DocumentHandle` be a type alias or an intersection?**
   - `type DocumentHandle = Timeline & { exports: ... }` (intersection)
   - `type DocumentHandle = Omit<Timeline, never> & { exports: ... }` (explicit)
   - Or keep it as a standalone type that mirrors Timeline's shape
   - **Recommendation**: Intersection `Timeline & { exports }`. Simplest, and TypeScript handles it well.

5. **Is `handle.timeline` removal actually breaking?**
   - 18 occurrences in 3 files, all internal to the monorepo. No external consumers.
   - Could add a deprecated getter `get timeline() { return this; }` for migration period.
   - **Recommendation**: Remove outright. All consumers are in-monorepo and can be migrated in the same PR.

## Success Criteria

- [ ] `DocumentHandle` type is `Timeline & { exports }`
- [ ] `makeHandle` is ≤5 lines
- [ ] Zero `handle.timeline` access in the codebase
- [ ] All push/read/write/mode/batch methods available directly on handle
- [ ] `restoreFromSnapshot` unchanged (still uses `createTimeline` directly)
- [ ] 394+ workspace tests pass
- [ ] Filesystem tests pass
- [ ] Typecheck passes

## References

- `packages/workspace/src/timeline/timeline.ts`—`createTimeline`, `readEntry`, `restoreFromSnapshot`. This file absorbs the mode conversion logic from `makeHandle`.
- `packages/workspace/src/timeline/entries.ts`—`TextEntry`, `RichTextEntry`, `SheetEntry`, `ContentType`. Return types for push methods.
- `packages/workspace/src/workspace/create-document.ts`—`makeHandle` factory. Becomes a one-liner.
- `packages/workspace/src/workspace/types.ts`—`DocumentHandle` type definition. Becomes `Timeline & { exports }`.
- `packages/filesystem/src/file-system.ts`—Heaviest consumer of `handle.timeline` escape hatch. All 6 occurrences become direct access.
- `packages/workspace/src/workspace/create-document.test.ts`—22 occurrences of `handle.timeline.*` to migrate.
