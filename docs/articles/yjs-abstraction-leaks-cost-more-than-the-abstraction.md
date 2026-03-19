# Y.js Abstraction Leaks Cost More Than the Abstraction

You build a nice typed API over Y.js. `handle.read()`, `handle.write()`, `tables.posts.set()`. Clean, minimal surface area. Then one consumer needs to append text to a document, the typed API doesn't have `append()`, and they write this:

```typescript
const entry = handle.currentEntry;
if (entry?.type === 'text') {
    handle.batch(() => entry.content.insert(entry.content.length, text));
}
```

Three lines. Works fine. Ships.

Six months later you want to change how the timeline stores text entries. You refactor the internal `Y.Map` structure, update `createTimeline`, update `read()` and `write()`. Tests pass. Then you discover that filesystem's `appendFile` reaches through `currentEntry` to call `Y.Text.insert()` directly, and your refactor broke it in a way the type system couldn't catch.

That's the cost. Not the three lines—the invisible coupling they create.

## What a Y.js Abstraction Leak Looks Like

The pattern has a consistent shape. A consumer can't do something through the typed API, so they reach through it:

```typescript
// Step 1: access internals
const validated = handle.currentEntry;

// Step 2: branch on mode (consumer knows about internal content types)
if (validated?.type !== 'text') {
    await this.writeFile(path, data);
    return;
}

// Step 3: raw CRDT mutation
handle.batch(() => validated.content.insert(validated.content.length, text));
```

Each step is a violation. The consumer inspects `currentEntry` (an internal representation), branches on `type` (a mode the abstraction should own), and calls `Y.Text.insert()` (a raw CRDT operation). The `handle.batch()` wrapper makes it look tidy, but the real work bypasses the Timeline entirely.

Compare to what it should look like:

```typescript
handle.append(text);
```

One line, no Y.js knowledge. The Timeline owns the "am I in text mode?" decision and the "insert at end" operation.

## Five Indicators That Y.js Internals Are Leaking

After auditing a real codebase, these patterns reliably predict abstraction leaks:

**Type assertions to Y.js types.** `as Y.Map`, `as Y.Text`, `as Y.XmlFragment` outside the owning module. The consumer has untyped data and is forcing it into shape—which means the typed API doesn't give them what they need.

**Mode branching in consumer code.** `if (entry.type === 'text') ... else if (entry.type === 'sheet')` outside the module that owns content modes. The consumer is making a decision the abstraction should make.

**Raw mutations inside batch callbacks.** `handle.batch(() => ytext.insert(...))` means the consumer is doing CRDT operations the handle should encapsulate. `batch()` is for grouping *high-level* operations (multiple `table.delete()` calls), not for wrapping raw Y.js mutations.

**Internal helpers on the public API.** Functions like `parseSheetFromCsv(columns: Y.Map<Y.Map<string>>, rows: Y.Map<Y.Map<string>>)` on a package's root export. The parameters are raw Y.js types—you can't call this function without first breaking the abstraction to get those references.

**`ydoc.getArray()`/`ydoc.getMap()` in consumer code.** Direct Y.Doc access outside infrastructure (sync, persistence) bypasses every typed API you built.

## The Boundary Rule

Y.js code naturally settles into three layers, and each has clear rules about what Y.js types it touches:

```
┌──────────────────────────────────────────────────────────┐
│  Consumer Code (apps, features)                          │
│  Uses: handle.read(), handle.write(), tables.*.set()     │
│  MAY bind to Y.Text/Y.XmlFragment returned by as*()     │
│  NEVER constructs, casts, or mutates Y.js types directly │
├──────────────────────────────────────────────────────────┤
│  Format Bridges (markdown ↔ Y.XmlFragment, CSV ↔ Y.Map) │
│  Accepts Y.js types as parameters (that's their job)     │
│  Lives close to the owning module, not on the public API │
├──────────────────────────────────────────────────────────┤
│  Internals (timeline, table-helper, y-keyvalue)          │
│  Constructs and manages all Y.js shared types            │
│  Owns the Y.Doc layout and exposes typed APIs over it    │
└──────────────────────────────────────────────────────────┘
```

The middle layer is the tricky one. Format bridges (converting `Y.XmlFragment` to markdown, serializing `Y.Map<Y.Map<string>>` to CSV) are legitimate—they exist specifically to work with Y.js types. But they should live next to the module that owns those types, not be re-exported across package boundaries where any consumer can call them.

## Real Example: How a Barrel Export Creates Coupling

`parseSheetFromCsv` and `serializeSheetToCsv` are internal helpers that convert between CSV strings and Y.Map-based sheet structures. They lived in `packages/workspace/src/timeline/sheet.ts`—the right place. But then they got re-exported:

```
timeline/sheet.ts (defined)
  → timeline/index.ts (re-export)
    → workspace/src/index.ts (re-export)     ← public API!
      → filesystem/formats/sheet.ts (re-export)
        → filesystem/src/index.ts (re-export) ← public API!
```

Now any consumer of `@epicenter/workspace` or `@epicenter/filesystem` can import these functions. But they're useless without raw `Y.Map<Y.Map<string>>` references—which you can only get by reaching through the Timeline abstraction. The export itself is the invitation to break the boundary.

The fix was simple: remove from all barrel exports. The functions stay in `timeline/sheet.ts` where `timeline.ts` imports them directly. The Timeline's `write()` and `read()` methods encapsulate the CSV conversion. No consumer needs the raw helpers.

## When Raw Y.js Access Is Correct

Not every Y.js import outside the internals is a leak. Three cases are legitimate:

**Editor binding.** `handle.asText()` returns a `Y.Text` specifically so editors can bind to it. The consumer *needs* the live CRDT reference for collaborative editing. Same for `asRichText()` returning `Y.XmlFragment` and `asSheet()` returning column/row `Y.Map`s.

**Sync and persistence infrastructure.** Code that manages Y.Doc replication (`Y.encodeStateVector`, `Y.applyUpdate`, `Y.snapshot`) operates at the document transport level. It has no business using Timeline or Table abstractions.

**Transaction grouping.** `client.batch(() => { ... })` wrapping multiple high-level operations (several `table.delete()` calls in one transaction) is the intended use of batch. The batch callback should only contain typed API calls, not raw Y.js mutations.

## The Review Question

When reviewing code that touches Y.js types, ask one question: "Could this consumer accomplish the same thing using only the typed API?"

If yes, the raw Y.js usage is a leak. If no, either it's a legitimate case (editor binding, sync infrastructure) or the typed API has a gap worth filling. Both answers are useful.
