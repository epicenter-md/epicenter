# Absorb timeline-helpers into a createTimeline wrapper

**Date**: 2026-02-11
**Status**: Done
**Parent**: `specs/20260212T120000-yjs-filesystem-decomposition.md`

## Problem

`ContentOps` imports 7 free functions from `timeline-helpers.ts` and manually threads Yjs primitives through them on every call:

```typescript
const ydoc = await this.store.ensure(fileId);
const timeline = getTimeline(ydoc);           // ydoc.getArray('timeline')
const current = getCurrentEntry(timeline);     // timeline.get(timeline.length - 1)
const mode = getEntryType(current);            // current.get('type')
```

Tests are worse — they reach through `(content as any).store.ensure(id)` then call `getTimeline(ydoc).length` just to assert timeline didn't grow.

The raw Yjs calls (`ydoc.getArray`, `Y.Map.get('type')`, `Y.Map.get('content')`) leak through every consumer. Nobody should need to know the timeline lives at `ydoc.getArray('timeline')` or that entries are `Y.Map` instances with a `'type'` key.

## Design

Replace the 7 free functions with a single `createTimeline(ydoc)` factory that returns a pre-bound object. All Yjs internals are hidden behind the wrapper.

### createTimeline API

```typescript
// timeline-helpers.ts

export type Timeline = {
  /** Number of entries in the timeline. */
  readonly length: number;
  /** The most recent entry, or undefined if empty. O(1). */
  readonly currentEntry: Y.Map<any> | undefined;
  /** Content mode of the current entry, or undefined if empty. */
  readonly currentType: ContentType | undefined;
  /** Append a new text entry. Returns the Y.Map. */
  pushText(content: string): Y.Map<any>;
  /** Append a new binary entry. Returns the Y.Map. */
  pushBinary(data: Uint8Array): Y.Map<any>;
  /** Read the current entry as a string. Returns '' if empty. */
  readAsString(): string;
  /** Read the current entry as Uint8Array. Returns empty array if empty. */
  readAsBuffer(): Uint8Array;
};

export function createTimeline(ydoc: Y.Doc): Timeline {
  const timeline = ydoc.getArray<Y.Map<any>>('timeline');

  function currentEntry(): Y.Map<any> | undefined {
    if (timeline.length === 0) return undefined;
    return timeline.get(timeline.length - 1);
  }

  function currentType(): ContentType | undefined {
    const entry = currentEntry();
    return entry ? (entry.get('type') as ContentType) : undefined;
  }

  return {
    get length() { return timeline.length; },
    get currentEntry() { return currentEntry(); },
    get currentType() { return currentType(); },

    pushText(content: string): Y.Map<any> {
      const entry = new Y.Map();
      entry.set('type', 'text');
      const ytext = new Y.Text();
      ytext.insert(0, content);
      entry.set('content', ytext);
      timeline.push([entry]);
      return entry;
    },

    pushBinary(data: Uint8Array): Y.Map<any> {
      const entry = new Y.Map();
      entry.set('type', 'binary');
      entry.set('content', data);
      timeline.push([entry]);
      return entry;
    },

    readAsString(): string {
      const entry = currentEntry();
      if (!entry) return '';
      switch (entry.get('type') as ContentType) {
        case 'text':
          return (entry.get('content') as Y.Text).toString();
        case 'richtext':
          return '';
        case 'binary':
          return new TextDecoder().decode(entry.get('content') as Uint8Array);
      }
    },

    readAsBuffer(): Uint8Array {
      const entry = currentEntry();
      if (!entry) return new Uint8Array();
      switch (entry.get('type') as ContentType) {
        case 'text':
          return new TextEncoder().encode((entry.get('content') as Y.Text).toString());
        case 'richtext':
          return new Uint8Array();
        case 'binary':
          return entry.get('content') as Uint8Array;
      }
    },
  };
}
```

The old free functions (`getTimeline`, `getCurrentEntry`, `getEntryType`, `pushTextEntry`, `pushBinaryEntry`, `readEntryAsString`, `readEntryAsBuffer`) are deleted entirely. `createTimeline` is the only export.

### ContentOps refactored

Every method simplifies from multi-step Yjs threading to one-liner delegation:

```typescript
// content-ops.ts

export class ContentOps {
  private store: ContentDocStore;

  constructor(providers?: ProviderFactory[]) {
    this.store = createContentDocStore(providers);
  }

  async read(fileId: FileId): Promise<string> {
    const ydoc = await this.store.ensure(fileId);
    return createTimeline(ydoc).readAsString();
  }

  async readBuffer(fileId: FileId): Promise<Uint8Array> {
    const ydoc = await this.store.ensure(fileId);
    return createTimeline(ydoc).readAsBuffer();
  }

  async write(fileId: FileId, data: string | Uint8Array): Promise<number> {
    const ydoc = await this.store.ensure(fileId);
    const tl = createTimeline(ydoc);

    if (typeof data === 'string') {
      if (tl.currentType === 'text') {
        const ytext = tl.currentEntry!.get('content') as Y.Text;
        ydoc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, data);
        });
      } else {
        ydoc.transact(() => tl.pushText(data));
      }
      return new TextEncoder().encode(data).byteLength;
    } else {
      ydoc.transact(() => tl.pushBinary(data));
      return data.byteLength;
    }
  }

  async append(fileId: FileId, data: string): Promise<number | null> {
    const ydoc = await this.store.ensure(fileId);
    const tl = createTimeline(ydoc);

    if (tl.currentType === 'text') {
      const ytext = tl.currentEntry!.get('content') as Y.Text;
      ydoc.transact(() => ytext.insert(ytext.length, data));
    } else if (tl.currentType === 'binary') {
      const existing = new TextDecoder().decode(tl.currentEntry!.get('content') as Uint8Array);
      ydoc.transact(() => tl.pushText(existing + data));
    } else {
      return null;
    }

    // Re-read after mutation
    const updated = createTimeline(ydoc);
    if (updated.currentType === 'text') {
      return new TextEncoder().encode(
        (updated.currentEntry!.get('content') as Y.Text).toString(),
      ).byteLength;
    }
    return (updated.currentEntry!.get('content') as Uint8Array).byteLength;
  }

  async destroy(fileId: FileId): Promise<void> {
    return this.store.destroy(fileId);
  }

  async destroyAll(): Promise<void> {
    return this.store.destroyAll();
  }
}
```

**Key change**: `ContentOps` no longer imports 7 separate functions. It imports `createTimeline` and calls methods on the returned object.

### Test improvements

**content-ops.test.ts** — Tests that currently do:

```typescript
const ydoc = await (content as any).store.ensure(id);
expect(getTimeline(ydoc).length).toBe(1);
```

Become:

```typescript
const ydoc = await (content as any).store.ensure(id);
expect(createTimeline(ydoc).length).toBe(1);
```

This removes the `getTimeline` import from tests entirely. The test still reaches into `.store` internals (unavoidable for timeline-length assertions), but no longer needs to know the array key name.

**yjs-file-system.test.ts** — The `getTimelineLength` helper:

```typescript
// Before
import { getTimeline } from './timeline-helpers.js';
async function getTimelineLength(fs: YjsFileSystem, path: string): Promise<number> {
  const tree = (fs as any).tree;
  const content = (fs as any).content;
  const id = tree.lookupId(path);
  const ydoc = await content.store.ensure(id);
  return getTimeline(ydoc).length;
}

// After
import { createTimeline } from './timeline-helpers.js';
async function getTimelineLength(fs: YjsFileSystem, path: string): Promise<number> {
  const tree = (fs as any).tree;
  const content = (fs as any).content;
  const id = tree.lookupId(path);
  const ydoc = await content.store.ensure(id);
  return createTimeline(ydoc).length;
}
```

### What does NOT change

- `content-doc-store.ts` — doesn't use timeline helpers at all
- `file-tree.ts` — metadata only, no content awareness
- `yjs-file-system.ts` — delegates to `ContentOps`, doesn't touch timeline helpers
- `types.ts` — `ContentType`, `TimelineEntry` types stay as-is
- `index.ts` — no timeline-helpers re-exports exist today

---

## Implementation Plan

### Step 1: Replace free functions with createTimeline factory

- **File**: `timeline-helpers.ts`
- Delete all 7 free functions
- Add `Timeline` type and `createTimeline` factory function (as shown above)
- Keep all existing Yjs logic, just co-locate it inside the returned object

### Step 2: Update ContentOps to use createTimeline

- **File**: `content-ops.ts`
- Replace 7-function import with single `createTimeline` import
- Rewrite `read`, `readBuffer`, `write`, `append` to use `createTimeline(ydoc)` wrapper
- No behavior changes — same mode-switching logic, same transact boundaries

### Step 3: Update tests

- **File**: `content-ops.test.ts`
  - Replace `import { getTimeline }` with `import { createTimeline }`
  - Change `getTimeline(ydoc).length` → `createTimeline(ydoc).length`
- **File**: `yjs-file-system.test.ts`
  - Same import swap
  - `getTimelineLength` helper uses `createTimeline(ydoc).length`

### Step 4: Verify

- Run `bun test packages/epicenter/src/filesystem/` — all existing tests pass unchanged
- Run `bun run typecheck` — no type errors

---

## Success Criteria

- [ ] `timeline-helpers.ts` exports only `createTimeline` and the `Timeline` type
- [ ] `ContentOps` imports nothing from timeline-helpers except `createTimeline`
- [ ] No file in the codebase calls `ydoc.getArray('timeline')` directly
- [ ] No file imports `getTimeline`, `getCurrentEntry`, `getEntryType`, `pushTextEntry`, `pushBinaryEntry`, `readEntryAsString`, or `readEntryAsBuffer`
- [ ] All existing tests pass with no behavior changes
- [ ] `bun run typecheck` passes

## References

- `packages/epicenter/src/filesystem/timeline-helpers.ts` — file being refactored
- `packages/epicenter/src/filesystem/content-ops.ts` — primary consumer
- `packages/epicenter/src/filesystem/content-ops.test.ts` — test consumer
- `packages/epicenter/src/filesystem/yjs-file-system.test.ts` — test consumer
- `specs/20260212T120000-yjs-filesystem-decomposition.md` — parent decomposition spec
