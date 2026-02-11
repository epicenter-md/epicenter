# Unified Local Persistence Provider

**Created**: 2026-01-11T12:29:00
**Status**: Research / Design
**Related**: `packages/epicenter/src/capabilities/revision-history/local.ts`

## Problem Statement

Currently, Epicenter has two separate capabilities for local data management:

1. **Persistence Provider** (`setupPersistence`) - Stores full Y.Doc state
2. **Revision History** (`localRevisionHistory`) - Stores snapshots for time-travel

These are conceptually related but implemented separately, leading to:

- Two different storage locations
- Duplicate configuration (both need `gc: false`)
- No coordination between them
- Potential for inconsistent state

## Proposed Solution: Option B - Unified Provider with Sidecar Snapshots

Merge persistence and revision history into a single `localPersistence` provider that handles both document state and snapshots.

### Storage Layout

```
{projectDir}/
└── .epicenter/
    └── providers/
        └── persistence/
            └── {workspaceId}/
                ├── state.yjs                    # Full document state (V2 encoded)
                └── snapshots/
                    ├── 1704067200000.ysnap     # Snapshot (V2 encoded, lightweight)
                    ├── 1704067200000.json      # Snapshot metadata (optional)
                    ├── 1704067300000.ysnap
                    └── ...
```

### File Formats

#### `state.yjs` - Full Document State

- Binary file containing `Y.encodeStateAsUpdateV2(ydoc)`
- Loaded on startup via `Y.applyUpdateV2(ydoc, data)`
- Updated on every Y.Doc change (debounced)
- Uses V2 encoding for 30-50% size reduction

#### `{timestamp}.ysnap` - Snapshot Files

- Binary file containing `Y.encodeSnapshotV2(snapshot)`
- Lightweight: only DeleteSet + StateVector (not full content)
- Named by Unix timestamp in milliseconds
- Used for time-travel and version history

#### `{timestamp}.json` - Snapshot Metadata (Optional)

```json
{
	"description": "Before major refactor",
	"createdAt": "2026-01-11T12:29:00.000Z"
}
```

Alternative: Embed metadata in filename (e.g., `1704067200000_before-refactor.ysnap`)

## Technical Details

### YJS V2 Encoding

**Verified via DeepWiki research** - V2 functions exist and are stable:

```typescript
// State encoding (30-50% smaller than V1)
Y.encodeStateAsUpdateV2(doc);
Y.applyUpdateV2(doc, update);

// Snapshot encoding
Y.encodeSnapshotV2(snapshot);
Y.decodeSnapshotV2(buf);

// Conversion utilities
Y.convertUpdateFormatV1ToV2(update);
Y.convertUpdateFormatV2ToV1(update);
```

**Caveat**: y-websocket sync protocol still uses V1. V2 is for storage only.

### Snapshot vs Update (Important Distinction)

| Concept      | Function                | Contains                     | Size                | Use Case                |
| ------------ | ----------------------- | ---------------------------- | ------------------- | ----------------------- |
| **Update**   | `encodeStateAsUpdate()` | Full document content        | Large               | Persistence, sync       |
| **Snapshot** | `encodeSnapshot()`      | DeleteSet + StateVector only | Tiny (~100B-few KB) | Time-travel, versioning |

Snapshots are **pointers into document history**, not copies. This is why:

1. `gc: false` is required (GC deletes items snapshots point to)
2. Snapshots only work with the original Y.Doc that created them
3. `Y.createDocFromSnapshot(originalDoc, snapshot)` reconstructs state

### Atomic Writes (Crash Safety)

```typescript
// Write to temp file, then atomic rename
const tempPath = `${filePath}.tmp`;
await Bun.write(tempPath, encoded);
await Bun.file(tempPath).rename(filePath);
```

### gc: false Requirement

Both persistence and snapshots require garbage collection disabled:

```typescript
const ydoc = new Y.Doc({ gc: false });
```

The unified provider should:

1. Check `ydoc.gc` on initialization
2. Throw descriptive error if GC is enabled
3. Document this requirement clearly

## API Design

### Configuration

```typescript
type LocalPersistenceConfig = {
	/** Base directory for all persistence data */
	directory: string;

	/** Debounce interval for auto-saving state (default: 1000ms) */
	debounceMs?: number;

	/** Snapshot configuration */
	snapshots?: {
		/** Enable automatic snapshots on changes (default: true) */
		enabled?: boolean;
		/** Debounce interval for auto-snapshots (default: 30000ms) */
		debounceMs?: number;
		/** Maximum snapshots to keep (default: unlimited) */
		maxVersions?: number;
	};

	/** Use V2 encoding for smaller files (default: true) */
	useV2Encoding?: boolean;
};
```

### Exports

```typescript
type LocalPersistenceExports = {
	// State operations
	/** Force save current state (bypasses debounce) */
	saveState(): Promise<void>;

	// Snapshot operations
	/** Create a snapshot with optional description */
	createSnapshot(description?: string): Promise<SnapshotEntry | null>;
	/** List all snapshots (oldest first) */
	listSnapshots(): Promise<SnapshotEntry[]>;
	/** View document at a specific snapshot (read-only) */
	viewSnapshot(index: number): Promise<Y.Doc>;
	/** Restore document to a specific snapshot */
	restoreSnapshot(index: number): Promise<void>;
	/** Get snapshot count */
	snapshotCount(): Promise<number>;

	// Metadata
	/** Directory where data is stored */
	directory: string;

	// Cleanup
	/** Stop watchers and save final state */
	destroy(): Promise<void>;
};

type SnapshotEntry = {
	timestamp: number;
	description?: string;
	size: number;
	filename: string;
};
```

### Usage Example

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { localPersistence } from '@epicenter/hq/providers';

const workspace = defineWorkspace({
  id: 'my-workspace',
  tables: { ... },

  providers: {
    persistence: (ctx) => localPersistence(ctx, {
      directory: './data',
      debounceMs: 1000,
      snapshots: {
        enabled: true,
        debounceMs: 30000,  // Auto-snapshot every 30s of inactivity
        maxVersions: 100,
      },
    }),
  },
});

// Usage
const client = await createClient(workspace);

// Manual snapshot
await client.providers.persistence.createSnapshot('Before migration');

// List versions
const snapshots = await client.providers.persistence.listSnapshots();

// Time-travel
const oldDoc = await client.providers.persistence.viewSnapshot(5);

// Restore
await client.providers.persistence.restoreSnapshot(5);
```

## Research Questions

### 1. V2 Encoding Compatibility

- [ ] Test `encodeStateAsUpdateV2` / `applyUpdateV2` with current YJS version (13.6.x)
- [ ] Verify V2 snapshots work correctly with `createDocFromSnapshot`
- [ ] Check if V2 state can be synced via y-websocket (may need V1 conversion)

### 2. Migration Path

- [ ] How to migrate existing `.yjs` files (V1) to V2?
- [ ] How to migrate existing `snapshots/*.ysnap` files?
- [ ] Should we auto-detect format on load?

### 3. Performance

- [ ] Benchmark V1 vs V2 encoding/decoding speed
- [ ] Measure actual size reduction on real documents
- [ ] Test with large documents (1MB+ state)

### 4. YJS v14 Beta

Current stable: v13.6.29, Beta: v14.0.0-19

v14 adds:

- Attribution support (`DiffAttributionManager`, `SnapshotAttributionManager`)
- `diffDocsToDelta` for comparing documents
- ESM-only bundling

- [ ] Should we wait for v14 stable?
- [ ] Any breaking changes that affect this design?

### 5. Snapshot Storage Alternatives

- [ ] Single log file vs individual files (pros/cons)
- [ ] Embedding metadata in filename vs sidecar JSON
- [ ] Compression (gzip) for snapshots

### 6. Edge Cases

- [ ] What happens if state.yjs is corrupted?
- [ ] What if snapshot references items not in state.yjs?
- [ ] Concurrent access (multiple processes)?

## Implementation Checklist

- [ ] Research questions answered
- [ ] Design reviewed and approved
- [ ] Create `packages/epicenter/src/providers/local-persistence/`
- [ ] Implement state persistence (V2)
- [ ] Implement snapshot management (V2)
- [ ] Add atomic writes
- [ ] Add migration utilities (V1 -> V2)
- [ ] Write tests
- [ ] Update documentation
- [ ] Deprecate old `localRevisionHistory` capability

## References

- [YJS Document Updates API](https://docs.yjs.dev/api/document-updates)
- [YJS Snapshots](https://docs.yjs.dev/api/snapshots) (if exists)
- [DeepWiki: YJS Snapshots](https://deepwiki.com/yjs/yjs#6.3)
- [y-sweet S3 persistence](https://github.com/jamsocket/y-sweet) - Reference implementation
- Current implementation: `packages/epicenter/src/capabilities/revision-history/local.ts`

## File Extension Conventions (From Research)

| Data Type             | Extension  | YJS Function                  |
| --------------------- | ---------- | ----------------------------- |
| Full document state   | `.yjs`     | `Y.encodeStateAsUpdate[V2]()` |
| Snapshot (versioning) | `.ysnap`   | `Y.encodeSnapshot[V2]()`      |
| State vector only     | `.ysv`     | `Y.encodeStateVector()`       |
| Incremental update    | `.yupdate` | from `doc.on('update')`       |

No magic bytes in YJS binary format - extension is purely for human/application identification.
