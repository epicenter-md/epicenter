# Data Layer Refactor: `transcribedText` to `transcript`

## Overview

This spec documents the remaining work to rename the `transcribedText` field to `transcript` throughout the data layer. The UI layer has already been updated to display "Transcript" instead of "Transcribed Text".

## Completed Work (UI Layer)

The following UI-only changes have been completed:

- [x] Renamed `TranscribedTextDialog.svelte` to `TranscriptDialog.svelte`
- [x] Updated all component imports
- [x] Updated all UI labels from "Transcribed Text" to "Transcript"
- [x] Updated tooltips, descriptions, and toast messages
- [x] Updated JSDoc comments with user-facing text

## Remaining Work (Data Layer)

### 1. Recording Model Type Definition

**File**: `apps/whispering/src/lib/services/db/models/recordings.ts`

Change the `transcribedText` field to `transcript`:

```typescript
// Before
export type Recording = {
  // ...
  transcribedText: string;
  // ...
};

// After
export type Recording = {
  // ...
  transcript: string;
  // ...
};
```

### 2. File System Serialization

**File**: `apps/whispering/src/lib/services/db/file-system.ts`

Update the serialization/deserialization logic:

```typescript
// Line ~41: Update destructuring
const { transcript, ...frontMatter } = recording;
return matter.stringify(transcript ?? '', frontMatter);

// Line ~57: Update the parsed result
transcript: body,
```

### 3. Query Layer References

Update all references in the query layer:

**Files to update**:
- `apps/whispering/src/lib/query/transcription.ts` - Lines 55, 77, 80, 83, 87, 90, 94
- `apps/whispering/src/lib/query/actions.ts` - Lines 631, 664, 684, 729
- `apps/whispering/src/lib/query/transformer.ts` - Line 115

### 4. Component Property Access

Update all components accessing `recording.transcribedText`:

**Files to update**:
- `apps/whispering/src/routes/(app)/+page.svelte` - Lines 54, 67, 320, 323, 331
- `apps/whispering/src/routes/(app)/(config)/recordings/+page.svelte` - Lines 98, 102, 171, 178, 182, 334, 342
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/EditRecordingModal.svelte` - Lines 177, 181
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/RecordingRowActions.svelte` - Lines 82, 86, 112

### 5. Table Column Configuration

**File**: `apps/whispering/src/routes/(app)/(config)/recordings/+page.svelte`

```typescript
// Line 171
accessorKey: 'transcript', // was 'transcribedText'
```

### 6. View Transition IDs

Update `propertyName` references used for view transitions:

**Files to update**:
- `apps/whispering/src/routes/(app)/+page.svelte` - Line 334
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/RecordingRowActions.svelte` - Line 115
- `apps/whispering/src/lib/components/copyable/TranscriptDialog.svelte` - Line 38

### 7. Transformation Runs Model

**File**: `apps/whispering/src/lib/services/db/models/transformation-runs.ts`

Update JSDoc comments referencing "transcribedText":
- Lines 65-66: Update comment about storing snapshot of transcribedText
- Line 98: Update comment about recording's transcribed text

### 8. Migration Dialog (Test Data)

**File**: `apps/whispering/src/lib/components/MigrationDialog.svelte`

```typescript
// Lines 82, 94
transcript: textLengths[index % textLengths.length], // was transcribedText
```

## Data Migration Strategy

Since recordings are stored as markdown files with YAML frontmatter, existing data will need migration:

1. The `transcript` content is stored as the markdown body (not in frontmatter)
2. No frontmatter changes needed for the content itself
3. Code changes will handle reading/writing the body as `transcript` instead of `transcribedText`

**Important**: This is a breaking change for any code that accesses `recording.transcribedText`. All references must be updated simultaneously.

## Testing Checklist

- [ ] Create new recording and verify transcript is saved correctly
- [ ] Edit existing recording's transcript and verify it persists
- [ ] Verify transcription flow updates transcript field
- [ ] Verify transformation runs can access transcript
- [ ] Verify copy to clipboard works with transcript
- [ ] Verify recordings table displays transcript column correctly
- [ ] Verify existing recordings still load correctly after code changes

## Files Summary

### Must Update (Breaking Changes)
1. `apps/whispering/src/lib/services/db/models/recordings.ts`
2. `apps/whispering/src/lib/services/db/file-system.ts`
3. `apps/whispering/src/lib/query/transcription.ts`
4. `apps/whispering/src/lib/query/actions.ts`
5. `apps/whispering/src/lib/query/transformer.ts`
6. `apps/whispering/src/routes/(app)/+page.svelte`
7. `apps/whispering/src/routes/(app)/(config)/recordings/+page.svelte`
8. `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/EditRecordingModal.svelte`
9. `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/RecordingRowActions.svelte`
10. `apps/whispering/src/lib/components/copyable/TranscriptDialog.svelte`
11. `apps/whispering/src/lib/components/MigrationDialog.svelte`

### Optional (JSDoc/Comments Only)
1. `apps/whispering/src/lib/services/db/models/transformation-runs.ts`

### Documentation to Update
1. `apps/whispering/src/lib/services/db/README.md`
2. `apps/whispering/README.md`
3. Various spec files in `specs/` directory
