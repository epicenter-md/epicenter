# Timeline Content Storage Implementation

**Date**: 2026-02-11
**Status**: Implemented
**Implementation notes**: Phases 1-3 completed. `timeline-helpers.ts` created with `createTimeline()` factory API (slightly different from spec's standalone functions — uses object with methods instead). `binaryStore` removed from YjsFileSystem. Tests exist in `yjs-file-system.test.ts` covering timeline length, mode switching, and binary persistence. Phase 4 (richtext) remains deferred.
**Supersedes**: `specs/20260211T100000-simplified-ytext-content-store.md`
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md` (decision record with full rationale)

---

## 1. Summary

This spec replaces the single `Y.Text('content')` content storage with a `Y.Array('timeline')` per file Y.Doc. Each timeline entry is a `Y.Map` forming a discriminated union on a `type` field, supporting text (`Y.Text`), richtext (`Y.XmlFragment` + `Y.Map` frontmatter), and binary (`Uint8Array`) modes. Same-mode text edits mutate the nested `Y.Text` in place (no new entry); binary writes and mode switches append new entries. The current version is always the last entry: `timeline.get(timeline.length - 1)`.

This eliminates the ephemeral `Map<FileId, Uint8Array>` binary store from `YjsFileSystem`. Binary data now lives inside the Y.Doc timeline, giving it persistence, sync, and revision history for free. The `ContentDocStore` interface is unchanged -- only the internal structure of each Y.Doc changes.

The v13 implementation has a 1:1 structural mapping to Yjs v14's `Y.Type` (see section 11). Migration is confined to `timeline-helpers.ts` -- all consumers are insulated by the helper API.

---

## 2. TypeScript Types

Added to `packages/epicenter/src/filesystem/types.ts`:

```typescript
/** Content modes supported by timeline entries */
export type ContentType = 'text' | 'richtext' | 'binary';

/**
 * Timeline entry shapes -- a discriminated union on 'type'.
 * These describe the SHAPE of what's stored. At runtime, entries are Y.Map
 * instances accessed via .get('type'), .get('content'), etc.
 */
export type TextEntry = { type: 'text'; content: Y.Text };
export type RichTextEntry = {
	type: 'richtext';
	content: Y.XmlFragment;
	frontmatter: Y.Map<unknown>;
};
export type BinaryEntry = { type: 'binary'; content: Uint8Array };
export type TimelineEntry = TextEntry | RichTextEntry | BinaryEntry;
```

These types are for documentation and type-checking only. They are not instantiated directly -- timeline entries are `Y.Map` instances.

---

## 3. Content Doc Helpers

New file: `packages/epicenter/src/filesystem/timeline-helpers.ts`

```typescript
import * as Y from 'yjs';
import type { ContentType } from './types.js';

/** Get the timeline array from a content doc. */
export function getTimeline(ydoc: Y.Doc): Y.Array<Y.Map<any>> {
	return ydoc.getArray('timeline');
}

/** Get the current (last) entry from a timeline. O(1). */
export function getCurrentEntry(
	timeline: Y.Array<Y.Map<any>>,
): Y.Map<any> | undefined {
	if (timeline.length === 0) return undefined;
	return timeline.get(timeline.length - 1);
}

/** Get the content mode of an entry. */
export function getEntryType(entry: Y.Map<any>): ContentType {
	return entry.get('type') as ContentType;
}

/** Create and append a new text entry. Returns the new Y.Map. */
export function pushTextEntry(
	timeline: Y.Array<Y.Map<any>>,
	content: string,
): Y.Map<any> {
	const entry = new Y.Map();
	entry.set('type', 'text');
	const ytext = new Y.Text();
	ytext.insert(0, content);
	entry.set('content', ytext);
	timeline.push([entry]);
	return entry;
}

/** Create and append a new binary entry. Returns the new Y.Map. */
export function pushBinaryEntry(
	timeline: Y.Array<Y.Map<any>>,
	data: Uint8Array,
): Y.Map<any> {
	const entry = new Y.Map();
	entry.set('type', 'binary');
	entry.set('content', data);
	timeline.push([entry]);
	return entry;
}

/** Create and append a new richtext entry from markdown. Returns the new Y.Map. */
export function pushRichTextEntry(
	timeline: Y.Array<Y.Map<any>>,
	markdown: string,
): Y.Map<any> {
	// Uses markdown-helpers.ts for parsing -- wired in Phase 4
	const entry = new Y.Map();
	entry.set('type', 'richtext');
	entry.set('content', new Y.XmlFragment());
	entry.set('frontmatter', new Y.Map());
	timeline.push([entry]);
	// After push, populate the now-integrated shared types:
	// updateYXmlFragmentFromString(entry.get('content'), body);
	// updateYMapFromRecord(entry.get('frontmatter'), frontmatter);
	return entry;
}

/** Read an entry's content as a string (for readFile). */
export function readEntryAsString(entry: Y.Map<any>): string {
	switch (getEntryType(entry)) {
		case 'text':
			return (entry.get('content') as Y.Text).toString();
		case 'richtext':
			// Phase 4: serializeXmlFragmentToMarkdown + serializeMarkdownWithFrontmatter
			return '';
		case 'binary':
			return new TextDecoder().decode(entry.get('content') as Uint8Array);
	}
}

/** Read an entry's content as Uint8Array (for readFileBuffer). */
export function readEntryAsBuffer(entry: Y.Map<any>): Uint8Array {
	switch (getEntryType(entry)) {
		case 'text':
			return new TextEncoder().encode(
				(entry.get('content') as Y.Text).toString(),
			);
		case 'richtext':
			// Phase 4: serialize markdown then encode
			return new Uint8Array();
		case 'binary':
			return entry.get('content') as Uint8Array;
	}
}
```

---

## 4. Content Mode Detection

How `writeFile` determines which mode to use:

- `writeFile(path, Uint8Array)` -- always binary mode
- `writeFile(path, string)` -- always text mode (including `.md` files)

Richtext mode is NOT triggered by `writeFile`. It is triggered by the UI/editor binding to `Y.XmlFragment` directly. The filesystem treats all string writes as plain text. This matches the Obsidian model: markdown is stored as a string, rich rendering is a view concern.

**Why richtext exists if writeFile doesn't use it:** The UI can create richtext entries when a user opens a markdown file in the WYSIWYG editor. `readFile` on a richtext entry serializes the `Y.XmlFragment` back to a markdown string, transparent to consumers. This is a Phase 4 capability.

---

## 5. YjsFileSystem Changes

All changes in `packages/epicenter/src/filesystem/yjs-file-system.ts`.

### readFile(path) -> string

```typescript
const ydoc = this.store.ensure(id);
const timeline = getTimeline(ydoc);
const entry = getCurrentEntry(timeline);
if (!entry) return '';
return readEntryAsString(entry);
```

### readFileBuffer(path) -> Uint8Array

```typescript
const ydoc = this.store.ensure(id);
const entry = getCurrentEntry(getTimeline(ydoc));
if (!entry) return new Uint8Array();
return readEntryAsBuffer(entry);
```

### writeFile(path, data)

```typescript
const ydoc = this.store.ensure(id);
const timeline = getTimeline(ydoc);
const current = getCurrentEntry(timeline);

if (typeof data === 'string') {
	if (current && getEntryType(current) === 'text') {
		// Same-mode text: edit existing Y.Text in place (timeline doesn't grow)
		const ytext = current.get('content') as Y.Text;
		ydoc.transact(() => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, data);
		});
	} else {
		// Mode switch or first write: push new text entry
		ydoc.transact(() => pushTextEntry(timeline, data));
	}
} else {
	// Binary: always push new entry (atomic, no CRDT merge)
	ydoc.transact(() => pushBinaryEntry(timeline, data));
}
```

### appendFile(path, data)

```typescript
const ydoc = this.store.ensure(id);
const timeline = getTimeline(ydoc);
const current = getCurrentEntry(timeline);
const content =
	typeof data === 'string' ? data : new TextDecoder().decode(data);

if (current && getEntryType(current) === 'text') {
	// Incremental append to existing Y.Text
	const ytext = current.get('content') as Y.Text;
	ydoc.transact(() => ytext.insert(ytext.length, content));
} else if (current && getEntryType(current) === 'binary') {
	// Binary entry: decode existing, concat, push new text entry
	const existing = new TextDecoder().decode(
		current.get('content') as Uint8Array,
	);
	ydoc.transact(() => pushTextEntry(timeline, existing + content));
} else {
	// No current entry: same as writeFile
	await this.writeFile(path, data);
}
```

### rm(path)

Same as current implementation but **remove** `this.binaryStore.delete(id)`. Binary data is now in the Y.Doc and cleaned up when `this.store.destroy(id)` is called.

### cp(src, dest)

Read from source entry, write to dest via `writeFile` (which creates the appropriate timeline entry):

```typescript
const srcDoc = this.store.ensure(srcId);
const entry = getCurrentEntry(getTimeline(srcDoc));
if (!entry) {
	await this.writeFile(destPath, '');
} else if (getEntryType(entry) === 'binary') {
	await this.writeFile(destPath, entry.get('content') as Uint8Array);
} else {
	await this.writeFile(destPath, readEntryAsString(entry));
}
```

### mv(src, dest)

**Unchanged.** Pure metadata update. Content doc is untouched.

### Field removal

Remove `private binaryStore = new Map<FileId, Uint8Array>()` from `YjsFileSystem`. All references to `this.binaryStore` are deleted.

---

## 6. Migration from Y.Text('content')

No production data exists to migrate (development only). Migration pattern for reference:

```typescript
function migrateContentDoc(ydoc: Y.Doc): void {
	const oldText = ydoc.getText('content');
	const timeline = ydoc.getArray('timeline');

	if (oldText.length > 0 && timeline.length === 0) {
		ydoc.transact(() => {
			const entry = new Y.Map();
			entry.set('type', 'text');
			const ytext = new Y.Text();
			ytext.insert(0, oldText.toString());
			entry.set('content', ytext);
			timeline.push([entry]);
		});
	}
}
```

---

## 7. What Changes from the Simplified Spec

| Concept            | Simplified Spec                              | This Spec                                      |
| ------------------ | -------------------------------------------- | ---------------------------------------------- |
| Content storage    | `Y.Text('content')` single key               | `Y.Array('timeline')` with nested entries      |
| Binary storage     | Ephemeral `Map<FileId, Uint8Array>`          | Persistent in Y.Doc timeline entries           |
| Content mode       | Implicit (string vs Uint8Array at call site) | Explicit `type` field in timeline entry        |
| Binary persistence | Lost on restart                              | Syncs and persists via Y.Doc                   |
| Mode history       | None                                         | Implicit in timeline (array of entries)        |
| readFile           | `ydoc.getText('content').toString()`         | `readEntryAsString(getCurrentEntry(timeline))` |
| writeFile string   | `ytext.delete + insert`                      | Same-mode: edit Y.Text. Switch: push new entry |
| writeFile binary   | `binaryStore.set(id, data)`                  | `pushBinaryEntry(timeline, data)`              |
| ContentDocStore    | Unchanged                                    | Unchanged (Y.Doc lifecycle is the same)        |
| binaryStore field  | `Map<FileId, Uint8Array>` on YjsFileSystem   | **Removed**                                    |

---

## 8. Implementation Phases

**Phase 1: Types and Helpers** (`types.ts` + `timeline-helpers.ts`)

- Add `ContentType`, `TextEntry`, `RichTextEntry`, `BinaryEntry`, `TimelineEntry` types
- Create `timeline-helpers.ts` with all helper functions
- No behavioral changes yet

**Phase 2: YjsFileSystem Core** (`yjs-file-system.ts`)

- Replace `readFile` to use timeline dispatch
- Replace `writeFile` to use timeline entries
- Replace `readFileBuffer` to use timeline dispatch
- Replace `appendFile` for timeline
- Remove `binaryStore` field entirely
- Update `rm` (remove binaryStore cleanup)
- Update `cp` (read from timeline entry, write via writeFile)
- `mv` unchanged

**Phase 3: Tests** (`yjs-file-system.test.ts`)

- All existing text file tests pass unchanged (behavioral compatibility)
- Add: binary file persistence (write binary, read back)
- Add: mode switching (text -> binary -> text)
- Add: binary-to-text switching
- Add: text append (`appendFile` on text entry)
- Add: binary append (`appendFile` on binary entry becomes text)
- Add: timeline inspection (verify entry count after mode switches)
- Add: same-mode text overwrite doesn't grow timeline
- Add: same-mode binary overwrite DOES grow timeline

**Phase 4: Richtext Support** (deferred)

- Wire `markdown-helpers.ts` into `readEntryAsString`/`pushRichTextEntry`
- Add UI observation pattern for timeline changes
- Not in initial implementation scope

---

## 9. Open Questions

5. **Extension-based vs explicit mode detection** -- For Phases 1-3, `writeFile` uses `string` -> text, `Uint8Array` -> binary. Extension detection is not needed. Richtext mode is UI-initiated only (Phase 4).

6. **readFileBuffer serialization path** -- For text: `TextEncoder.encode(ytext.toString())`. For binary: zero-copy from entry's `content`. For richtext (Phase 4): serialize markdown then encode.

7. **Binary overwrite: new entry** -- Each binary write appends a new entry. This gives explicit version history. The array grows, but so would `Y.Map` tombstones in any alternative.

8. **UI observation for mode changes** -- Deferred to Phase 4. Phases 1-3 are bash-agent focused (no UI binding).

9. **Large binary files** -- No size threshold in Phases 1-3. Acknowledged as a future concern.

---

## 10. Verification

```bash
bun test packages/epicenter/src/filesystem/
```

Checklist:

- [ ] `readFile()` returns correct content for text entries
- [ ] `readFile()` returns decoded content for binary entries
- [ ] `readFileBuffer()` returns `Uint8Array` for all entry types
- [ ] `writeFile(path, string)` creates/edits text entry
- [ ] `writeFile(path, Uint8Array)` creates binary entry
- [ ] Same-mode text write edits `Y.Text` in place (timeline doesn't grow)
- [ ] Same-mode binary write appends new entry (timeline grows)
- [ ] Mode switch appends new entry with fresh shared types
- [ ] `appendFile` does incremental `Y.Text` insert for text entries
- [ ] `rm` destroys content doc (timeline cleaned up via Y.Doc destroy)
- [ ] `cp` copies content correctly regardless of source entry type
- [ ] `mv` is pure metadata (no content doc changes)
- [ ] `binaryStore` field is removed from `YjsFileSystem`
- [ ] Binary data persists in Y.Doc (not ephemeral)
- [ ] just-bash integration tests pass (echo, cat, mkdir, ls, find, grep, rm, mv, cp, wc)
- [ ] Existing text file tests pass without modification

---

## 11. v14 Forward Compatibility

The v13 implementation is designed for a clean v14 migration. The timeline structure is preserved -- only the internal types change. See the [decision record's v14 Migration Path](specs/20260211T220000-yjs-content-doc-multi-mode-research.md#v14-migration-path-ytype-structural-mapping) for full rationale.

### Structural mapping (v13 -> v14)

```
v13 (this spec)                            v14 (future)
──────────────────────────────────         ──────────────────────────────────
Y.Array('timeline')                        Y.Type('timeline')
└── Y.Map entry                            └── Y.Type entry
    ├── .get('type')        → string           ├── .getAttr('type')        → string
    ├── .get('content')     → Y.Text /         ├── .getAttr('content')     → Y.Type /
    │                         Y.XmlFrag /      │                             Uint8Array
    │                         Uint8Array       │
    └── .get('frontmatter') → Y.Map           └── .getAttr('frontmatter') → Y.Type
```

### What changes at migration time

Only `timeline-helpers.ts` changes:

- `new Y.Map()` -> `new Y.Type()`
- `new Y.Text()` -> `new Y.Type()`
- `new Y.XmlFragment()` -> `new Y.Type()`
- `entry.get(key)` -> `entry.getAttr(key)`
- `entry.set(key, value)` -> `entry.setAttr(key, value)`

### What does NOT change

- Timeline structure (array of entries, last index = current)
- Entry schema (discriminated union on `type` field)
- Helper API (`getCurrentEntry`, `readEntryAsString`, `pushTextEntry`, etc.)
- All consumer code (YjsFileSystem, tests)
- Frontmatter as nested type (not flat `fm:` prefixed attrs -- see decision record)
- Content as nested type (not promoted to entry's children -- see decision record)

### v14 bonus: attribution

v14's attribution system tracks who made what changes at the CRDT level. No structural changes needed -- attribution applies to any nested `Y.Type` content in the timeline entries. This enables AI vs human edit tracking, diff-based accept/reject, and contribution heatmaps.

---

## 12. Spec Lineage

| Spec                                                           | Relationship                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `specs/20260211T100000-simplified-ytext-content-store.md`      | **Superseded** by this spec                                                                                             |
| `specs/20260211T220000-yjs-content-doc-multi-mode-research.md` | Decision record with full rationale. This spec implements Option F.                                                     |
| `specs/20260210T220000-v14-content-storage-spec.md`            | **Deferred**. v14 `Y.Type` concepts are forward-compatible with this spec's timeline structure (see v14 section above). |
| `specs/20260208T000000-yjs-filesystem-spec.md`                 | **Still valid** -- two-layer architecture unchanged                                                                     |
| `specs/20260211T200000-yjs-filesystem-conformance-fixes.md`    | **Still valid** -- behavioral fixes orthogonal                                                                          |
| `specs/20260209T000000-simplify-content-doc-lifecycle.md`      | **Still valid** -- ContentDocStore interface unchanged                                                                  |
