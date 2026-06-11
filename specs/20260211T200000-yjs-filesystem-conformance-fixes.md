# YjsFileSystem IFileSystem Conformance Fixes

**Date**: 2026-02-11
**Status**: Implemented
**Related**: `specs/20260208T000000-yjs-filesystem-spec.md`, `specs/20260211T100000-simplified-ytext-content-store.md` (superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`)

---

## Problem

The current `YjsFileSystem` implementation has several behavioral gaps where it diverges from standard POSIX filesystem semantics that just-bash's `InMemoryFs` correctly implements. These gaps would cause failures in conformance testing and could produce surprising behavior during bash agent sessions.

Additionally, the binary file storage strategy (ephemeral `Map<FileId, Uint8Array>`) needs a design decision about whether to persist, sync, or simplify.

---

## Part 1: Behavioral Fixes

### Fix 1: `mkdir` on existing file should throw EEXIST

**Current behavior** (`yjs-file-system.ts:200`):
```typescript
if (await this.exists(resolved)) return; // mkdir on existing dir is a no-op
```

`mkdir('/existing-file')` silently succeeds because `exists()` returns true for both files and directories. The code treats them identically.

**Expected behavior**: `mkdir` on an existing *directory* is a no-op. `mkdir` on an existing *file* throws `EEXIST`.

**Fix**:
```typescript
if (await this.exists(resolved)) {
  const id = this.index.pathToId.get(resolved);
  if (id !== undefined) {
    const row = this.getRow(id, resolved);
    if (row.type === 'file') throw fsError('EEXIST', resolved);
  }
  return; // existing directory, no-op
}
```

The `recursive` path has the same issue. When walking path segments, if an existing segment is a file, it should throw `ENOTDIR` (can't create a directory inside a file):

```typescript
if (options?.recursive) {
  const parts = resolved.split('/').filter(Boolean);
  let currentPath = '';
  for (const part of parts) {
    currentPath += '/' + part;
    if (await this.exists(currentPath)) {
      // Verify existing segment is a directory, not a file
      const existingId = this.index.pathToId.get(currentPath);
      if (existingId) {
        const existingRow = this.getRow(existingId, currentPath);
        if (existingRow.type === 'file') throw fsError('ENOTDIR', currentPath);
      }
      continue;
    }
    // ... create directory
  }
}
```

---

### Fix 2: `writeFile` on existing directory should throw EISDIR

**Current behavior** (`yjs-file-system.ts:147-180`):
```typescript
let id = this.index.pathToId.get(resolved);
if (!id) {
  // ... create new file
}
// proceeds to write content: even if id points to a folder
```

`writeFile('/existing-dir', 'hello')` succeeds, writing a Y.Text content to a metadata row that says `type: 'folder'`. This corrupts the filesystem state.

**Expected behavior**: Throw `EISDIR` when the target path is an existing directory.

**Fix**: After resolving the id for an existing path, check the row type:
```typescript
let id = this.index.pathToId.get(resolved);
if (id) {
  const row = this.getRow(id, resolved);
  if (row.type === 'folder') throw fsError('EISDIR', resolved);
}
```

---

### Fix 3: `appendFile` should use incremental Y.Text insert

**Current behavior** (`yjs-file-system.ts:182-192`):
```typescript
async appendFile(path, data, _options) {
  // ...
  const existing = await this.readFile(resolved);
  const fullText = existing + content;
  await this.writeFile(resolved, fullText);
}
```

This reads the entire file, concatenates, then does a full `delete(0, length) + insert(0, fullText)` via `writeFile`. This is O(n) and generates a massive Yjs operation that tombstones every existing character. Two concurrent appends would conflict badly: each would read the same state, append their content, and do a full rewrite, with one overwriting the other via LWW.

**Expected behavior**: Append to the end of the Y.Text directly, preserving existing CRDT item IDs. Two concurrent appends should both succeed (Yjs handles concurrent inserts at the same position).

**Fix**:
```typescript
async appendFile(path: string, data: FileContent, _options?: { encoding?: string } | string): Promise<void> {
  const resolved = posixResolve(this.cwd, path);
  const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
  const id = this.index.pathToId.get(resolved);

  if (!id) return this.writeFile(resolved, data, _options);

  const row = this.getRow(id, resolved);
  if (row.type === 'folder') throw fsError('EISDIR', resolved);

  // Check binary store: if file has binary data, read-concat-write
  const binary = this.binaryStore.get(id);
  if (binary) {
    const existingText = new TextDecoder().decode(binary);
    await this.writeFile(resolved, existingText + content);
    return;
  }

  // Y.Text path: incremental insert at end
  const ydoc = this.store.ensure(id);
  const ytext = ydoc.getText('content');
  ydoc.transact(() => {
    ytext.insert(ytext.length, content);
  });

  const newSize = new TextEncoder().encode(ytext.toString()).byteLength;
  this.filesTable.update(id, { size: newSize, updatedAt: Date.now() });
}
```

This is O(append length) instead of O(file size), and concurrent appends merge correctly via Yjs.

---

### Fix 4: Remove dead code in `stat`

**Current code** (`yjs-file-system.ts:73-96`):
```typescript
async stat(path: string): Promise<FsStat> {
  const resolved = posixResolve(this.cwd, path);
  if (resolved === '/') {
    return { isFile: false, isDirectory: true, ... };  // line 75-83
  }
  const id = this.resolveId(resolved);       // throws ENOENT if not found
  if (id === null) throw fsError('EISDIR', resolved);  // line 86: UNREACHABLE
  const row = this.getRow(id, resolved);
  // ...
}
```

Line 86 is unreachable. `resolveId` returns `null` only when `path === '/'`, which is already handled on line 75. For any other path, `resolveId` either returns a `FileId` or throws `ENOENT`.

**Fix**: Remove the dead check:
```typescript
async stat(path: string): Promise<FsStat> {
  const resolved = posixResolve(this.cwd, path);
  if (resolved === '/') {
    return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtime: new Date(0), mode: 0o755 };
  }
  const id = this.resolveId(resolved);
  const row = this.getRow(id!, resolved);
  // ...
}
```

Same dead-code pattern also exists in `readFile` (line 115) and `readFileBuffer` (line 130). Apply the same cleanup: after the root check, `resolveId` guarantees a non-null FileId, so the null check is dead code in all three methods.

---

### Fix 5: `appendFile` on directory should throw EISDIR

**Current behavior**: `appendFile('/existing-dir', 'data')` falls through to `readFile(resolved)` which throws EISDIR. This happens to be correct, but only by accident: the error comes from `readFile`, not from `appendFile` itself.

**Fix**: Already addressed in Fix 3: the new `appendFile` checks `row.type === 'folder'` explicitly before attempting any content operations.

---

## Part 2: Binary Storage: Discussion

The current design uses an ephemeral `Map<FileId, Uint8Array>` for binary files. This means binary data is:
- Not synced via Yjs (no collaborative merge)
- Not persisted (lost on reload)
- Not available to other peers

The user's primary question: **Is this the right tradeoff? Should we persist/sync binary data? Or simplify further?**

### Option A: Keep Ephemeral Map (Current)

**How it works**: `writeFile(path, uint8Array)` stores in `Map`. `writeFile(path, string)` stores in Y.Text. Binary and text are mutually exclusive per file.

**Pros**:
- Simplest implementation (already done)
- Zero overhead for the text path (which is 99% of usage)
- Matches InMemoryFs semantics: just-bash's own fs is also ephemeral

**Cons**:
- Binary files vanish on reload
- Binary files don't sync between peers
- Two-track storage adds branching in read/write/rm/cp paths

**Best for**: Current state. Bash agent sessions where binary files are intermediate artifacts (sqlite temp databases, gzip output).

### Option B: Remove Binary Support Entirely

**How it works**: All `writeFile` data gets converted to string. `writeFile(path, uint8Array)` does `new TextDecoder().decode(data)` and stores in Y.Text. No `binaryStore` at all.

```typescript
async writeFile(path: string, data: FileContent): Promise<void> {
  const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
  // ... always Y.Text path
}
```

**Pros**:
- Removes all binary branching from read/write/rm/cp paths
- Every file is Y.Text-backed: consistent, collaborative, persistent
- Simpler mental model: filesystem = text files
- `readFileBuffer` becomes `new TextEncoder().encode(ytext.toString())`: one path

**Cons**:
- Binary data that contains invalid UTF-8 gets replacement characters (U+FFFD) on decode. SQLite databases, images, compressed files become corrupted.
- just-bash's `sqlite3` command would break: it writes Uint8Array and reads it back via `readFileBuffer`, expecting byte-perfect round-trip.

**Best for**: If we decide binary support isn't needed. The bash agent primarily works with text. But `sqlite3` is a significant just-bash feature.

### Option C: Y.Map with Uint8Array Values

**How it works**: Store binary data in a `Y.Map` on the content Y.Doc alongside the Y.Text:

```
Y.Doc (guid = fileId)
├── Y.Text('content')    → text content (collaborative, character-level CRDT)
└── Y.Map('binary')      → { data: Uint8Array }  (LWW at the whole-value level)
```

When `writeFile` receives a Uint8Array, it writes to the Y.Map. When it receives a string, it writes to Y.Text and clears the Y.Map. The `readFile`/`readFileBuffer` checks the Y.Map first.

Yjs `Y.Map` natively supports `Uint8Array` values: `ymap.set('data', uint8Array)` works out of the box. The binary data syncs via Yjs with last-write-wins semantics at the whole-value level (not byte-level CRDT, which would be overkill).

**Pros**:
- Binary data persists and syncs via standard Yjs providers
- LWW is the right merge strategy for binary (you can't meaningfully merge two SQLite databases at the byte level)
- No new infrastructure: uses existing Y.Doc and providers
- Byte-perfect round-trip

**Cons**:
- Large binary files bloat the Y.Doc (a 1MB SQLite database = 1MB in the Y.Doc state)
- Y.Doc `gc: false` means old binary versions accumulate as tombstones
- Every binary write replaces the entire value in Y.Map (no delta, but this is correct for binary)
- Adds a second shared type to the content Y.Doc (complexity)

**Best for**: If binary files need to persist across sessions and sync between peers. Makes sense if `sqlite3` is a core feature of the agent workflow.

### Option D: Separate Blob Store (IndexedDB / External)

**How it works**: Binary data goes to a separate storage system (IndexedDB, S3, local file) keyed by FileId. The Y.Doc only stores text. A `BlobStore` interface abstracts the backend.

**Pros**:
- Keeps Y.Docs lightweight (text only)
- Binary storage can use appropriate backends (IndexedDB for client, S3 for server)
- No Y.Doc bloat from large binaries

**Cons**:
- New infrastructure to build and maintain
- Sync between peers requires a separate channel (not Yjs)
- More complex wiring (BlobStore + ContentDocStore + FileSystemIndex)
- Over-engineered for the current use case

**Best for**: Production systems with significant binary file needs (image editors, PDF storage). Not worth building now.

### Recommendation

**Start with Option A (keep current), revisit if `sqlite3` usage becomes important.**

The bash agent use case is overwhelmingly text: code files, config, markdown, shell scripts. Binary files are session artifacts that don't need to survive reloads. The two-track storage is already implemented and working.

If binary persistence becomes a real requirement (e.g., agent workflows that build and query SQLite databases across sessions), upgrade to Option C (Y.Map with Uint8Array). It's a contained change: add a Y.Map to the content Y.Doc, update read/write/rm paths. No IFileSystem API changes.

Option B (remove binary) is tempting for simplicity but breaks `sqlite3`, which is a significant just-bash selling point.

---

## Implementation

### Files to modify

| File | Changes |
|------|---------|
| `yjs-file-system.ts` | Fix `mkdir` (EEXIST on file), fix `writeFile` (EISDIR on dir), fix `appendFile` (incremental insert), remove dead code in `stat`/`readFile`/`readFileBuffer` |
| `yjs-file-system.test.ts` | Add conformance tests for each fix |

### Test cases to add

```
mkdir:
  - mkdir on existing file → throws EEXIST
  - mkdir on existing directory → no-op (existing behavior, verify)
  - mkdir -p through existing file → throws ENOTDIR
  - mkdir -p through existing directories → no-op for existing, creates missing

writeFile:
  - writeFile on existing directory → throws EISDIR

appendFile:
  - appendFile to existing text file → content appended (not rewritten)
  - appendFile to non-existent file → creates file
  - appendFile to existing directory → throws EISDIR
  - concurrent appendFile calls → both appends present (CRDT merge)

stat:
  - stat on root → returns directory entry (existing, verify)
  - stat on file → returns file entry (existing, verify)
  - stat on non-existent path → throws ENOENT (existing, verify)
```

### Estimated scope

~30 lines changed in `yjs-file-system.ts`, ~50 lines of new tests. No API changes. No new dependencies.

---

## Verification

```bash
bun test packages/epicenter/src/filesystem/
```

All existing tests must continue to pass. New tests validate each fix.
