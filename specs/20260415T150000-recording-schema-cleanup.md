# Recording Schema Cleanup

Rename columns, drop redundant fields, add `duration`.

## Current → Target Schema

```
V1 (current)                →  V2 (target)
──────────────────────────────────────────────────
id: string                  →  id: string
title: string               →  title: string            (auto-generated from transcript)
subtitle: string            →  (dropped)
timestamp: string           →  recordedAt: string       (renamed)
createdAt: string           →  (dropped: redundant with recordedAt)
updatedAt: string           →  updatedAt: string
transcribedText: string     →  transcript: string       (renamed)
transcriptionStatus: enum   →  transcriptionStatus: enum
                            →  duration: number | null  (new: seconds, null for legacy)
_v: 1                       →  _v: 2
```

## Workspace Migration (definition.ts)

```typescript
const recordings = defineTable()
  .version(type({
    id: 'string',
    title: 'string',
    subtitle: 'string',
    timestamp: 'string',
    createdAt: 'string',
    updatedAt: 'string',
    transcribedText: 'string',
    transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
    _v: '1',
  }))
  .version(type({
    id: 'string',
    title: 'string',
    recordedAt: 'string',
    updatedAt: 'string',
    transcript: 'string',
    transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
    'duration?': 'number | undefined',
    _v: '2',
  }))
  .migrate((row) => {
    switch (row._v) {
      case 1: {
        const title = row.transcribedText.slice(0, 60).trim() || row.title || 'Untitled Recording';
        return {
          id: row.id,
          title,
          recordedAt: row.timestamp,
          updatedAt: row.updatedAt,
          transcript: row.transcribedText,
          transcriptionStatus: row.transcriptionStatus,
          duration: undefined,
          _v: 2,
        };
      }
      case 2:
        return row;
    }
  });
```

Migrates on read. Existing V1 rows in Yjs stay untouched until accessed, then silently upgraded to V2.

## Files to Change

### Layer 1: Schema + Type (must go first)

- [ ] `src/lib/workspace/definition.ts`: Add V2 schema with builder pattern + `.migrate()`
- [ ] `src/lib/state/recordings.svelte.ts`: Update sort key `timestamp` → `recordedAt`, JSDoc references

### Layer 2: Recording Creation

- [ ] `src/lib/query/actions.ts`: Update the recording object literal (lines 612-621): new field names, auto-generate title from transcript, drop `subtitle`/`createdAt`
- [ ] `src/lib/state/transformations.svelte.ts`: Comment referencing "timestamps" (cosmetic)

### Layer 3: UI Consumers

- [ ] `src/routes/(app)/(config)/recordings/+page.svelte`: Update column `accessorKey`s, column visibility defaults, search filter
- [ ] `src/routes/(app)/(config)/recordings/row-actions/EditRecordingModal.svelte`: Update field bindings: drop subtitle, rename timestamp → recordedAt, transcribedText → transcript
- [ ] `src/routes/(app)/(config)/debug/+page.svelte`: Update test recording creation

### Layer 4: DB Service (audio blob storage)

- [ ] `src/lib/services/db/models/recordings.ts`: Update `Recording` intermediate type to match V2 fields
- [ ] `src/lib/services/db/file-system.ts`: Update `RecordingFrontMatter` schema, `recordingToMarkdown`, and parsing. Handle backward compat for existing .md files with old field names
- [ ] `src/lib/services/db/web/dexie-schemas.ts`: Update `RecordingStoredInIndexedDB` type (V5 Dexie schema stays for read compat, types updated)
- [ ] `src/lib/services/db/web/index.ts`: Update any field references in create/update
- [ ] `src/lib/migration/migrate-database.ts`: Update the Dexie→workspace migration to write V2 fields

### Layer 5: Query layer references

- [ ] `src/lib/query/transcription.ts`: `transcribedText` → `transcript`, `transcriptionStatus` refs
- [ ] `src/lib/query/actions.ts`: Also handles title auto-generation after transcription completes (set title from first 60 chars of transcript)
- [ ] `src/lib/query/transformer.ts`: Any `transcribedText` references
- [ ] `src/lib/migration/migration-test-data.ts`: Update mock data

### Layer 6: Duration tracking (new)

- [ ] `src/lib/query/actions.ts`: Extract duration from audio blob during recording creation
- [ ] Recording creation sites need to compute duration from the Blob (or set null if unavailable)

## Duration: How to Get It

Audio duration can be extracted from the Blob before saving:

```typescript
function getAudioDuration(blob: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.addEventListener('loadedmetadata', () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : undefined);
    });
    audio.addEventListener('error', () => resolve(undefined));
    audio.src = URL.createObjectURL(blob);
  });
}
```

This runs in the browser, works with WebM and MP3, and gracefully falls back to `undefined`.

## File-System Backward Compat

Existing `.md` files on desktop have old frontmatter keys (`timestamp`, `transcribedText`, `subtitle`, `createdAt`). Two options:

**Option A: Migrate on read**: When parsing a .md file, check for old field names and remap. Simple but keeps stale files on disk.

**Option B: Migrate on write**: Read old format, write back with new field names on first access. Cleans up files but adds write operations.

**Recommendation**: Option A (migrate on read). The file-system layer is secondary storage for audio. The workspace is the source of truth for metadata. No need to rewrite files.

## Not Changing

- Dexie V1-V5 upgrade schemas (`dexie-database.ts`): Historical migration code, must preserve old field names to read legacy data
- Any existing Dexie→workspace migration code that reads old field names: It reads V1 format and the workspace migration handles the rest

## Review

_To be filled after implementation._
