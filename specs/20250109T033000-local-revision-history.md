# Local Revision History Capability

**Status**: In Progress
**Created**: 2025-01-09

## Overview

A capability that stores Y.Snapshots locally for time-travel and revision history. Debounces saves on every Y.Doc change.

## Storage Structure

```
{directory}/
  └── snapshots/
      └── {workspaceId}/
          ├── 1704067200000.ysnap
          ├── 1704067500000.ysnap
          └── 1704067800000.ysnap
```

**Key points**:

- `directory` is **required** (no default)
- Scoped by workspace `id` from context
- Timestamp-based naming for automatic sorting

## Critical Requirement: GC Must Be Disabled

Y.Snapshots require `gc: false` on the Y.Doc. Without this, deleted items are garbage collected and snapshots cannot reconstruct historical states.

**Decision**: Throw an error if `gc: true`. Don't auto-set it—that's overreaching and could mask issues elsewhere.

```typescript
if (ydoc.gc) {
	throw new Error(
		`[RevisionHistory] gc must be disabled. Set { gc: false } on Y.Doc.`,
	);
}
```

## Debounced Saves

Every Y.Doc change triggers a debounced save:

```typescript
ydoc.on('update', () => {
	debouncedSave();
});
```

**Debounce behavior**:

- Default: 1000ms (configurable)
- Only saves if document actually changed (use `Y.equalSnapshots`)
- Saves are synchronous (writeFileSync) to ensure data persists before process exits

## Simplified API

### Config

```typescript
type LocalRevisionHistoryConfig = {
	/** Required: Base directory for storage */
	directory: string;

	/** Debounce interval in ms. Default: 1000 */
	debounceMs?: number;

	/** Max versions to keep. Default: undefined (no limit) */
	maxVersions?: number;
};
```

### Exports

```typescript
{
  /** Manually save a snapshot (bypasses debounce) */
  save(description?: string): VersionEntry | null;

  /** List all snapshots, sorted oldest-first */
  list(): Promise<VersionEntry[]>;

  /** Get read-only Y.Doc at a version index */
  view(index: number): Promise<Y.Doc>;

  /** Restore document to a version (applies update to current doc) */
  restore(index: number): Promise<void>;

  /** Number of saved snapshots */
  count(): Promise<number>;

  /** Stop watching and clean up */
  destroy(): void;
}
```

**Renamed for clarity**:

- `saveVersion` → `save`
- `getVersions` → `list`
- `viewVersion` → `view`
- `restoreVersion` → `restore`

### VersionEntry

```typescript
type VersionEntry = {
	timestamp: number; // Unix ms
	date: string; // ISO string for display
	description?: string; // Optional label
	size: number; // Bytes
	filename: string; // e.g., "1704067200000.ysnap"
};
```

## On maxVersions

**My recommendation**: Keep it optional with no default limit.

**Reasoning**:

- Snapshots are small (~1-10KB each)
- 1000 snapshots = ~10MB, not a concern
- Manual cleanup is fine for now
- Automatic pruning adds complexity (which ones to delete? what if user wants that old one?)
- Can add later if storage becomes an issue

If you do want pruning, the logic is simple:

```typescript
if (maxVersions && versions.length > maxVersions) {
	const toDelete = versions.slice(0, versions.length - maxVersions);
	// Delete oldest files
}
```

## Implementation Notes

### 1. Directory is required

```typescript
export const localRevisionHistory = async (
	ctx: CapabilityContext,
	config: LocalRevisionHistoryConfig, // No defaults for directory
) => {
	const { directory } = config;
	const snapshotDir = path.join(directory, 'snapshots', ctx.id);
	await mkdir(snapshotDir, { recursive: true });
	// ...
};
```

### 2. Debounced save on update

```typescript
import { debounce } from 'some-debounce-lib'; // or implement inline

let lastSnapshot: Y.Snapshot | null = null;

const saveSnapshot = () => {
  const snapshot = Y.snapshot(ydoc);
  if (lastSnapshot && Y.equalSnapshots(lastSnapshot, snapshot)) {
    return null; // No changes
  }

  const timestamp = Date.now();
  const filePath = path.join(snapshotDir, `${timestamp}.snap`);
  const encoded = Y.encodeSnapshot(snapshot);
  writeFileSync(filePath, encoded);

  lastSnapshot = snapshot;
  return { timestamp, ... };
};

const debouncedSave = debounce(saveSnapshot, config.debounceMs ?? 1000);

ydoc.on('update', () => {
  debouncedSave();
});
```

### 3. Cleanup on destroy

```typescript
destroy() {
  debouncedSave.cancel?.(); // Cancel pending debounce
  // Remove ydoc listener if we stored a reference
}
```

## Questions to Resolve

1. **Should we save an initial snapshot on init?** (I say yes—capture state before any edits)

2. **What happens on restore?** Options:
   - A: Apply snapshot as update (additive, merges with current)
   - B: Clear doc and apply snapshot (destructive, replaces current)

   I lean toward B for true "restore" semantics, but it's more complex.

3. **Should `save()` also save to the debounce tracker?** (Yes, to avoid double-saves)

## Files

- `packages/epicenter/src/capabilities/revision-history/index.ts` - Exports
- `packages/epicenter/src/capabilities/revision-history/local.ts` - Implementation

## TODO

- [x] Make `directory` required in config type
- [x] Simplify function names (save, list, view, restore)
- [x] Add debounced save on Y.Doc update
- [x] Remove autoSaveInterval (replaced by debounce)
- [x] Keep maxVersions optional (no default limit)
- [x] Consider initial snapshot on init
- [x] Add destroy cleanup for debounce cancellation
