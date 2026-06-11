# Whispering Workspace: Polish & Migration Completion

**Date**: 2026-03-12
**Status**: In Progress (Waves 1-3 complete, Wave 4 deferred)
**Builds on**: [20260302T140000-whispering-sync-strategy.md](./20260302T140000-whispering-sync-strategy.md)

## Overview

The Whispering workspace definition (`apps/whispering/src/lib/workspace.ts`) is ~80% complete. This spec audits it against the old data model and the sync strategy spec, identifies concrete issues, and plans the remaining work to reach production-grade.

Two goals:
1. **Polish**: fix design issues in the workspace definition
2. **Complete remaining waves**: settings separation, migration, sync wiring

### Architecture: Where Data Lives Today vs After Migration

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TODAY                                                                  │
│                                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │
│  │  localStorage │   │   IndexedDB  │   │  Filesystem  │                │
│  │              │   │   (Dexie)    │   │  (Tauri)     │                │
│  │  ~80 settings│   │  recordings  │   │  recordings  │                │
│  │  (flat keys) │   │  transforms  │   │  transforms  │                │
│  │              │   │  runs        │   │  runs        │                │
│  │  ALL mixed:  │   │  audio blobs │   │  audio files │                │
│  │  • secrets   │   │              │   │              │                │
│  │  • prefs     │   └──────────────┘   └──────────────┘                │
│  │  • hardware  │         Web                Desktop                    │
│  └──────────────┘                                                       │
│       Both                                                              │
└─────────────────────────────────────────────────────────────────────────┘

                              │  Waves 1-4
                              ▼

┌─────────────────────────────────────────────────────────────────────────┐
│  AFTER                                                                  │
│                                                                         │
│  ┌──────────────────────────────────┐   ┌──────────────┐               │
│  │  Workspace (Yjs Y.Doc)           │   │  localStorage │               │
│  │                                  │   │  (local-only) │               │
│  │  Tables:                         │   │               │               │
│  │    recordings                    │   │  • API keys   │               │
│  │    transformations               │   │  • endpoints  │               │
│  │    transformationSteps            │   │  • device IDs │               │
│  │    transformationRuns             │   │  • file paths │               │
│  │    transformationStepRuns         │   │  • global     │               │
│  │                                  │   │    shortcuts  │               │
│  │  KV (synced prefs):              │   │  • recording  │               │
│  │    ~40 entries with per-key LWW  │   │    hardware   │               │
│  │                                  │   └──────────────┘               │
│  │  Persistence: IndexedDB          │                                   │
│  │  Future: ──► server-remote sync  │   ┌──────────────┐               │
│  └──────────────────────────────────┘   │  BlobStore   │               │
│                                         │  (audio)     │               │
│                                         │  Desktop: FS │               │
│                                         │  Web: IDB    │               │
│                                         └──────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Wave Progression

```
Wave 1 ✅  Polish workspace.ts
  │         Schema fixes: flat rows, individual KVs, camelCase tables,
  │         missing entries, type audit, JSDoc
  │
  ▼
Wave 2     Settings separation
  │         Two separate .svelte.ts files instead of merged interface.
  │         workspace-settings.svelte.ts for synced prefs (workspace KV),
  │         device-config.svelte.ts for hardware/platform (localStorage).
  │
  │         ┌─────────────────────────────┐  ┌──────────────────────────┐
  │         │ workspace-settings.svelte.ts │  │ device-config.svelte.ts  │
  │         │ reads workspace KV (synced)  │  │ reads localStorage       │
  │         │ ~42 user preferences        │  │ ~36 device-bound keys    │
  │         └─────────────────────────────┘  └──────────────────────────┘
  │
  │         API keys start in device-config (secrets).
  │         Move to workspace KV once encryption lands.
  │
  ▼
Wave 3     Migration
  │         Dialog-driven, user-initiated. 3-state machine in localStorage.
  │         Old data copied into workspace, never deleted automatically.
  │
  │         localStorage['whispering:migration']:
  │           (absent) ──► probe for old data ──► 'pending' or 'cleaned'
  │           'pending' ──► show dialog ──► user clicks Migrate ──► 'completed'
  │           'completed' ──► old data still on disk, offer cleanup in settings
  │           'cleaned' ──► terminal, skip all probes
  │
  │         ┌─────────────┐     ┌──────────────────┐
  │         │ Old Dexie /  │────►│ workspace tables │
  │         │ Filesystem   │    │ + workspace KV   │
  │         └─────────────┘    └──────────────────┘
  │         ┌─────────────┐     ┌──────────────────┐
  │         │ Old audio    │────►│ BlobStore        │
  │         │ blobs        │    │ (FS or IDB)      │
  │         └─────────────┘    └──────────────────┘
  │
  ▼
Wave 4     Sync wiring (deferred: needs Better Auth + server-remote)
            Add server URL setting ──► createSyncExtension connects.
            Everything above works offline-first; sync is additive.
```

## Audit: Current workspace.ts vs Old Models

### Full Data Model Comparison: Old Storage vs Workspace Client

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║                        CURRENT: apps/whispering (IndexedDB + FS)                        ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                          ║
║  ┌─ IndexedDB ("RecordingDB" via Dexie, V6) ─────────────────────────────────────────┐  ║
║  │                                                                                    │  ║
║  │  recordings  (&id, timestamp, createdAt, updatedAt)                                │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── title: string                                                                 │  ║
║  │  ├── subtitle: string                                                              │  ║
║  │  ├── timestamp: string                                                             │  ║
║  │  ├── createdAt: string                                                             │  ║
║  │  ├── updatedAt: string                                                             │  ║
║  │  ├── transcribedText: string                                                       │  ║
║  │  ├── transcriptionStatus: UNPROCESSED|TRANSCRIBING|DONE|FAILED                     │  ║
║  │  └── serializedAudio: { arrayBuffer, blobType } | undefined                       │  ║
║  │                                                                                    │  ║
║  │  transformations  (&id, createdAt, updatedAt)                                      │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── title: string                                                                 │  ║
║  │  ├── description: string                                                           │  ║
║  │  ├── createdAt: string                                                             │  ║
║  │  ├── updatedAt: string                                                             │  ║
║  │  └── steps: TransformationStepV2[]          ◄── NESTED ARRAY (denormalized)        │  ║
║  │       ├── id, version: 2                                                           │  ║
║  │       ├── type: prompt_transform | find_replace                                    │  ║
║  │       ├── prompt_transform.inference.provider: OpenAI|Groq|Anthropic|...           │  ║
║  │       ├── prompt_transform.inference.provider.OpenAI.model: string                 │  ║
║  │       ├── prompt_transform.inference.provider.Groq.model: string                   │  ║
║  │       ├── prompt_transform.inference.provider.Anthropic.model: string              │  ║
║  │       ├── prompt_transform.inference.provider.Google.model: string                 │  ║
║  │       ├── prompt_transform.inference.provider.OpenRouter.model: string             │  ║
║  │       ├── prompt_transform.inference.provider.Custom.model: string                 │  ║
║  │       ├── prompt_transform.inference.provider.Custom.baseUrl: string               │  ║
║  │       ├── prompt_transform.systemPromptTemplate: string                            │  ║
║  │       ├── prompt_transform.userPromptTemplate: string                              │  ║
║  │       ├── find_replace.findText: string                                            │  ║
║  │       ├── find_replace.replaceText: string                                         │  ║
║  │       └── find_replace.useRegex: boolean                                           │  ║
║  │                                                                                    │  ║
║  │  transformationRuns  (&id, transformationId, recordingId, startedAt)                │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── transformationId: string                                                      │  ║
║  │  ├── recordingId: string | null                                                    │  ║
║  │  ├── status: running | completed | failed                                          │  ║
║  │  ├── input: string                                                                 │  ║
║  │  ├── output: string | null                                                         │  ║
║  │  ├── error: string | null                                                          │  ║
║  │  ├── startedAt: string                                                             │  ║
║  │  ├── completedAt: string | null                                                    │  ║
║  │  └── stepRuns: TransformationStepRun[]      ◄── NESTED ARRAY (denormalized)        │  ║
║  │       ├── id, stepId, input, startedAt, completedAt                                │  ║
║  │       ├── status: running | completed | failed                                     │  ║
║  │       ├── output?: string  (completed)                                             │  ║
║  │       └── error?: string   (failed)                                                │  ║
║  │                                                                                    │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
║  ┌─ File System (Desktop only, ~/.whispering/) ──────────────────────────────────────┐  ║
║  │                                                                                    │  ║
║  │  recordings/{id}.md          YAML frontmatter + transcribed text body              │  ║
║  │  recordings/{id}.webm|.mp3   Audio blob as separate file                          │  ║
║  │  transformations/{id}.json   Transformation with nested steps                     │  ║
║  │  runs/{id}.json              Run with nested stepRuns                              │  ║
║  │                                                                                    │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
║  ┌─ localStorage ────────────────────────────────────────────────────────────────────┐  ║
║  │                                                                                    │  ║
║  │  ALL settings: API keys, transcription service/model selection, recording mode,    │  ║
║  │  sound toggles, output behavior, UI prefs, shortcuts, retention strategy,          │  ║
║  │  device IDs, base URLs, global shortcuts, analytics toggle, ...                    │  ║
║  │  (flat key-value, ~60+ keys, NOT synced across devices)                            │  ║
║  │                                                                                    │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
║  ┌─ Desktop DB Service (desktop.ts) ─────────────────────────────────────────────────┐  ║
║  │  READS:  merge IndexedDB + FS  (FS wins on conflict)                               │  ║
║  │  WRITES: FS only                                                                   │  ║
║  │  Migration: gradual IndexedDB → FS (in progress)                                   │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝


╔══════════════════════════════════════════════════════════════════════════════════════════╗
║               TARGET: workspace.ts (Y.Doc + workspace client)                            ║
║               file: apps/whispering/src/lib/workspace.ts                                 ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                          ║
║  ┌─ Tables (defineTable → Y.Array in Y.Doc) ─────────────────────────────────────────┐  ║
║  │                                                                                    │  ║
║  │  recordings  (_v: 1)                                                               │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── title: string                                                                 │  ║
║  │  ├── subtitle: string                                                              │  ║
║  │  ├── timestamp: string                                                             │  ║
║  │  ├── createdAt: string                                                             │  ║
║  │  ├── updatedAt: string                                                             │  ║
║  │  ├── transcribedText: string                                                       │  ║
║  │  ├── transcriptionStatus: UNPROCESSED|TRANSCRIBING|DONE|FAILED                     │  ║
║  │  ├── transcriptionError: string              ← empty when not FAILED               │  ║
║  │  │    ⚠ NO audio blob: stored out-of-band (blob store / FS)                      │  ║
║  │                                                                                    │  ║
║  │  transformations  (_v: 1)                   ◄── NORMALIZED (no nested steps)        │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── title: string                                                                 │  ║
║  │  ├── description: string                                                           │  ║
║  │  ├── createdAt: string                                                             │  ║
║  │  └── updatedAt: string                                                             │  ║
║  │                                                                                    │  ║
║  │  transformationSteps  (_v: 1)               ◄── NEW: broken out from nested array  │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── transformationId: string               ← FK to transformations.id             │  ║
║  │  ├── order: number                          ← explicit ordering                    │  ║
║  │  ├── type: prompt_transform | find_replace                                         │  ║
║  │  ├── inferenceProvider: OpenAI|Groq|Anthropic|Google|OpenRouter|Custom             │  ║
║  │  ├── openaiModel: string                    ┐                                      │  ║
║  │  ├── groqModel: string                      │                                      │  ║
║  │  ├── anthropicModel: string                 │ camelCase field names                │  ║
║  │  ├── googleModel: string                    │ (no more dot-notation keys)          │  ║
║  │  ├── openrouterModel: string                │                                      │  ║
║  │  ├── customModel: string                    │                                      │  ║
║  │  ├── customBaseUrl: string                  ┘                                      │  ║
║  │  ├── systemPromptTemplate: string                                                  │  ║
║  │  ├── userPromptTemplate: string                                                    │  ║
║  │  ├── findText: string                                                              │  ║
║  │  ├── replaceText: string                                                           │  ║
║  │  └── useRegex: boolean                                                             │  ║
║  │                                                                                    │  ║
║  │  transformationRuns  (_v: 1)                ◄── DISCRIMINATED UNION on status       │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── transformationId: string                                                      │  ║
║  │  ├── recordingId: string | null                                                    │  ║
║  │  ├── input: string                                                                 │  ║
║  │  ├── startedAt: string                                                             │  ║
║  │  ├── completedAt: string | null                                                    │  ║
║  │  ├── status: 'running'                       ─┐                                    │  ║
║  │  ├── status: 'completed', output: string      │ discriminated union                │  ║
║  │  └── status: 'failed',    error: string      ─┘                                    │  ║
║  │                                                                                    │  ║
║  │  transformationStepRuns  (_v: 1)            ◄── DISCRIMINATED UNION on status       │  ║
║  │  ├── id: string                                                                    │  ║
║  │  ├── transformationRunId: string            ← FK to transformationRuns.id          │  ║
║  │  ├── stepId: string                         ← FK to transformationSteps.id         │  ║
║  │  ├── order: number                                                                 │  ║
║  │  ├── input: string                                                                 │  ║
║  │  ├── startedAt: string                                                             │  ║
║  │  ├── completedAt: string | null                                                    │  ║
║  │  ├── status: 'running'                       ─┐                                    │  ║
║  │  ├── status: 'completed', output: string      │ discriminated union                │  ║
║  │  └── status: 'failed',    error: string      ─┘                                    │  ║
║  │                                                                                    │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
║  ┌─ KV Store (defineKv → Y.Array 'kv' in Y.Doc) ────────────────────────────────────┐  ║
║  │                                                                                    │  ║
║  │  sound (8 keys)                              boolean toggles                       │  ║
║  │  ├── sound.manualStart                                                             │  ║
║  │  ├── sound.manualStop                                                              │  ║
║  │  ├── sound.manualCancel                                                            │  ║
║  │  ├── sound.vadStart                                                                │  ║
║  │  ├── sound.vadCapture                                                              │  ║
║  │  ├── sound.vadStop                                                                 │  ║
║  │  ├── sound.transcriptionComplete                                                   │  ║
║  │  └── sound.transformationComplete                                                  │  ║
║  │                                                                                    │  ║
║  │  output (6 keys)                             boolean toggles                       │  ║
║  │  ├── output.transcription.clipboard                                                │  ║
║  │  ├── output.transcription.cursor                                                   │  ║
║  │  ├── output.transcription.enter                                                    │  ║
║  │  ├── output.transformation.clipboard                                               │  ║
║  │  ├── output.transformation.cursor                                                  │  ║
║  │  └── output.transformation.enter                                                   │  ║
║  │                                                                                    │  ║
║  │  ui (2 keys)                                                                       │  ║
║  │  ├── ui.alwaysOnTop: enum                                                          │  ║
║  │  └── ui.layoutMode: enum                                                           │  ║
║  │                                                                                    │  ║
║  │  dataRetention (2 keys)                                                            │  ║
║  │  ├── retention.strategy: keep-forever | limit-count                                │  ║
║  │  └── retention.maxCount: integer >= 1                                              │  ║
║  │                                                                                    │  ║
║  │  recording (1 key)                                                                 │  ║
║  │  └── recording.mode: enum                                                          │  ║
║  │                                                                                    │  ║
║  │  transcription (11 keys)                                                          │  ║
║  │  ├── transcription.service: selected service ID                                    │  ║
║  │  ├── transcription.openai.model: string                                            │  ║
║  │  ├── transcription.groq.model: string                                              │  ║
║  │  ├── transcription.elevenlabs.model: string                                        │  ║
║  │  ├── transcription.deepgram.model: string                                          │  ║
║  │  ├── transcription.mistral.model: string                                           │  ║
║  │  ├── transcription.language: string                                                │  ║
║  │  ├── transcription.prompt: string                                                  │  ║
║  │  ├── transcription.temperature: 0..1                                               │  ║
║  │  ├── transcription.compressionEnabled: boolean                                     │  ║
║  │  └── transcription.compressionOptions: string                                      │  ║
║  │                                                                                    │  ║
║  │  transformation (2 keys)                                                          │  ║
║  │  ├── transformation.selectedId: string | null    ← FK to transformations table       │  ║
║  │  └── transformation.openrouterModel: string      ← merged from completion.*          │  ║
║  │                                                                                    │  ║
║  │  shortcuts (10 keys)                                                               │  ║
║  │  ├── shortcut.toggleManualRecording                                                │  ║
║  │  ├── shortcut.startManualRecording                                                 │  ║
║  │  ├── shortcut.stopManualRecording                                                  │  ║
║  │  ├── shortcut.cancelManualRecording                                                │  ║
║  │  ├── shortcut.toggleVadRecording                                                   │  ║
║  │  ├── shortcut.startVadRecording                                                    │  ║
║  │  ├── shortcut.stopVadRecording                                                     │  ║
║  │  ├── shortcut.pushToTalk                                                           │  ║
║  │  ├── shortcut.openTransformationPicker                                             │  ║
║  │  └── shortcut.runTransformationOnClipboard                                         │  ║
║  │                                                                                    │  ║
║  │  ⚠ NOT in KV (stay in localStorage, device-specific):                              │  ║
║  │    API keys, filesystem paths, hardware device IDs, base URLs, global shortcuts    │  ║
║  │                                                                                    │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
║  ┌─ Persistence ─────────────────────────────────────────────────────────────────────┐  ║
║  │  Web:     indexeddbPersistence (Y.Doc → IndexedDB)                                 │  ║
║  │  Desktop: (future) file system persistence                                         │  ║
║  └────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                          ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

### Key Structural Differences

```
CHANGE                          OLD (Dexie/FS)              NEW (workspace client)
─────────────────────────────── ─────────────────────────── ──────────────────────────────
1. Steps storage                nested array in             separate transformationSteps
                                transformations.steps[]     table with FK + order field

2. Step runs storage            nested array in             separate transformationStepRuns
                                transformationRuns.         table with FK + order field
                                stepRuns[]

3. Step field naming            dot-notation keys           camelCase fields
                                "prompt_transform.          "inferenceProvider",
                                inference.provider"         "openaiModel", etc.

4. Settings storage             localStorage (~60 keys,     KV store in Y.Doc (37 keys,
                                all device-local)           synced across devices)
                                                            API keys stay in localStorage

5. Audio blobs                  serializedAudio in IDB      NOT in Y.Doc: out-of-band
                                OR separate file on FS      (blob store / FS, same as now)

6. Source of truth              Dexie IDB + FS (dual read)  Y.Doc (single CRDT source)
                                                            with optional materializers

7. Versioning                   Dexie .version() upgrades   _v field per table schema
                                (imperative migration)      (declarative, workspace-level)

8. Sync                         none                        Y.Doc CRDT replication
                                                            (multi-device via server-remote)
```


### Tables: What's Good

The 5 normalized tables are correct:
- `recordings`: matches old `Recording` type exactly
- `transformations`: matches old `Transformation` type (minus embedded `steps[]`, which is correct)
- `transformationSteps`: normalized from old `Transformation.steps[]`
- `transformationRuns`: matches old `TransformationRun` (minus embedded `stepRuns[]`)
- `transformationStepRuns`: normalized from old `TransformationRun.stepRuns[]`

### Issue 1: `transformationSteps`: Discriminated Union vs Flat Row

**Current workspace.ts** uses arktype's discriminated union for step types:

```typescript
const inferenceProvider = type.or(
  { 'inference.provider': "'OpenAI'", 'inference.model': type.enumerated(...models) },
  { 'inference.provider': "'Groq'", 'inference.model': type.enumerated(...models) },
  // ...
);
const promptTransformVariant = inferenceProvider.merge({ type: "'prompt_transform'", ... });
const findReplaceVariant = type({ type: "'find_replace'", ... });
const transformationSteps = defineTable(
  transformationStepBase.merge(type.or(promptTransformVariant, findReplaceVariant)),
);
```

**Old model** (`transformation-steps.ts`) uses flat row with ALL fields present:

```typescript
// Every step has ALL fields: prompt_transform fields AND find_replace fields
const TransformationStepV2 = type({
  type: type.enumerated(...TRANSFORMATION_STEP_TYPES),
  'prompt_transform.inference.provider': type.enumerated(...INFERENCE_PROVIDER_IDS),
  'prompt_transform.inference.provider.OpenAI.model': type.enumerated(...models),
  'prompt_transform.inference.provider.Groq.model': type.enumerated(...models),
  // ... each provider's model stored independently
  'find_replace.findText': 'string',
  'find_replace.replaceText': 'string',
  // ...
});
```

**The sync strategy spec** also proposed the flat approach (all fields present).

**Problems with the current discriminated union approach:**

1. **Per-provider model memory lost.** Old model stores `prompt_transform.inference.provider.OpenAI.model`, `prompt_transform.inference.provider.Groq.model`, etc. as separate fields. When you switch providers, your model selection for each is preserved. The workspace's `inference.model` only stores the active provider's model: switching providers loses the previous selection.

2. **Yjs doesn't enforce unions.** Yjs stores whatever you put in the Y.Map. The arktype union only validates on read. If a step is `prompt_transform` type but someone sets a `find_replace.findText` field, Yjs won't prevent it. The flat row approach is honest about this.

3. **Migration complexity.** The old data has flat rows. Migrating to a discriminated union means restructuring every step row. Migrating to a flat row means copying fields as-is.

**Recommendation:** Switch to flat row approach, matching the old model and the spec. Each provider's model gets its own field. All step type fields present on every row, discriminated by `type`.

### Issue 2: `transcription.config` KV: Single Blob vs Individual KVs

**Current workspace.ts:**

```typescript
const transcription = {
  'transcription.config': defineKv(transcriptionConfig), // single discriminated union blob
  'transcription.language': defineKv(type('string')),
  'transcription.prompt': defineKv(type('string')),
  // ...
};
```

**Problem:** `transcription.config` is a single blob containing `{ service, model }`. With LWW conflict resolution, if Device A uses Groq and Device B uses OpenAI, and both edit settings simultaneously, one device's entire config gets overwritten: including the service choice.

**The sync strategy spec** proposed individual KVs for service and model:

```
'transcription.selectedTranscriptionService': 'string',
'transcription.openai.model': 'string',
'transcription.groq.model': 'string',
// ...
```

**Recommendation:** Break `transcription.config` into individual KVs matching the spec. Each service's model gets its own KV entry, preserving selections when switching services.

### Issue 3: KV Key Naming Mismatch

The workspace KV keys differ from the old settings keys:

| Old Settings Key | Workspace KV Key | Notes |
|---|---|---|
| `sound.playOn.manual-start` | `sound.manualStart` | Different naming convention |
| `transcription.copyToClipboardOnSuccess` | `transcription.copyToClipboard` | Shortened |
| `transcription.writeToCursorOnSuccess` | `transcription.writeToCursor` | Shortened |
| `transcription.simulateEnterAfterOutput` | `transcription.simulateEnter` | Shortened |
| `database.recordingRetentionStrategy` | `retention.strategy` | Re-prefixed |
| `database.maxRecordingCount` | `retention.maxCount` | Re-prefixed |

**This is intentional.** The workspace KV is a fresh namespace. Shorter, cleaner keys are better. No need to match old localStorage keys: the migration will map between them.

### Issue 4: Missing KV Entries

The workspace has entries for synced settings only. But some settings from the old model that SHOULD sync are missing:

| Setting | In workspace? | Should sync? |
|---|---|---|
| Per-service transcription model selections | Partially (blob) | Yes: individual KVs |
| `transcription.selectedTranscriptionService` | In blob | Yes: individual KV |
| `completion.openrouter.model` | No | Yes: roams across devices |

### Issue 5: Settings That Should NOT Be in Workspace KV

Verify these are correctly EXCLUDED (they are, just confirming):
- API keys (`apiKeys.*`) ✅ excluded
- API endpoint overrides (`apiEndpoints.*`) ✅ excluded
- Device IDs (`recording.*.deviceId`) ✅ excluded
- Filesystem paths (`transcription.*.modelPath`, `recording.cpal.outputFolder`) ✅ excluded
- Recording method (`recording.method`) ✅ excluded
- FFmpeg config ✅ excluded
- Global shortcuts (`shortcuts.global.*`) ✅ excluded
- Base URLs (`transcription.speaches.baseUrl`, `completion.custom.baseUrl`) ✅ excluded

## Plan

### Wave 1: Polish workspace.ts

- [x] **1.1** Replace `transformationSteps` discriminated union with flat camelCase row schema
  - All prompt_transform fields + all find_replace fields on every row
  - Each inference provider's model as a separate camelCase field
  - `type` field discriminates between step types
  - camelCase for tables (consistent with codebase), dot-notation reserved for KV
- [x] **1.2** Break `transcription.config` blob into individual KVs
  - `transcription.service`: selected service ID
  - `transcription.openai.model`: OpenAI model selection
  - `transcription.groq.model`: Groq model selection
  - `transcription.elevenlabs.model`: ElevenLabs model selection
  - `transcription.deepgram.model`: Deepgram model selection
  - `transcription.mistral.model`: Mistral model selection
- [x] **1.3** Add missing KV entries
  - `completion.openrouter.model` (roams across devices)
  - Audit confirmed: only one entry was missing; all others present or correctly excluded
- [x] **1.4** Review all KV types: all correct
  - `retention.maxCount` (`number.integer >= 1`) and `transcription.temperature` (`0 <= number <= 1`) intentionally differ from settings.ts string types: workspace uses semantically correct types
- [x] **1.5** Add JSDoc comments to every table and KV group explaining the design

### Wave 2: Settings Separation

Two separate reactive state files instead of a single merged interface. The split reflects a real architectural boundary: user preferences (synced) vs device configuration (local).

**Why two files instead of one merged interface:**
- Simpler implementation: no dual-source merging logic
- Clear boundary: consumers know whether a setting syncs or not
- Encryption applies cleanly to just the workspace side later
- Most consumers use one category or the other, not both simultaneously

**`workspace-settings.svelte.ts`**: reads/writes workspace KV (synced across devices):
- ~42 keys: sound toggles, output behavior, UI prefs, recording mode, transcription service + per-service models, language/prompt/temperature, compression, retention policy, in-app shortcuts, selected transformation, completion model, analytics

**`device-config.svelte.ts`**: reads/writes localStorage (device-bound):
- ~36 keys: API keys (secrets), API endpoint overrides, hardware device IDs, recording method, cpal/ffmpeg/navigator config, filesystem model paths, self-hosted server URLs, global OS shortcuts

**Future**: Once encryption lands, API keys (~8) and endpoint overrides (~2) move from device-config to workspace KV. The device-config shrinks to genuinely hardware/OS-bound keys only.

- [x] **2.1** Create `workspace-settings.svelte.ts`
  - Import workspace client, read synced keys from workspace KV
  - Reactive via Yjs observation (workspace KV changes trigger UI updates)
  - Write synced keys back to workspace KV
  - Handle defaults: workspace KV entries need initial values on first creation
- [x] **2.2** Create `device-config.svelte.ts`
  - Read device-bound keys from localStorage (`createPersistedState`)
  - Keep arktype defaults from existing settings.ts schema
  - Write device-bound keys to localStorage
- [x] **2.3** Update consumers to import from the correct file
  - Most settings UI pages are already grouped by category, so imports should be straightforward
  - Transcription service code: reads API key from device-config + model from workspace-settings
  - Recording code: reads device ID from device-config + mode from workspace-settings
- [x] **2.4** Deprecate old unified `settings.svelte.ts` once all consumers are migrated
  > **Note**: Singleton deleted entirely: zero importers remained. The monolithic Settings arktype schema (settings.ts) was also deleted after inlining service param types.

### Wave 3: Migration

Dialog-driven, user-initiated migration from old storage to workspace. Old data is never deleted automatically. The user must explicitly choose to clean it up.

#### Migration State Machine

Single localStorage key with three possible persisted values:

```
localStorage['whispering:migration']

  (absent)        fresh install OR pre-migration user
       │
       │  app mounts → probe for old data (Dexie DB, old localStorage keys)
       │  old data found → set 'pending'
       │  no old data   → set 'cleaned' (skip future probes)
       ▼
  'pending'       old data detected, show migration dialog on mount
       │
       │  user clicks "Migrate Now" → run migration
       │  success → set 'completed'
       │  failure → stays 'pending' (user can retry)
       ▼
  'completed'     migrated, old data still on disk
       │           show "Clean up old data" option in settings
       │
       │  user clicks "Remove old data" in settings
       ▼
  'cleaned'       terminal state, skip all probes on future boots
```

**Why three states:**
- `(absent)` → `'pending'`/`'cleaned'`: Avoids probing for old data on every boot forever. First probe determines which path.
- `'pending'`: Caches the "old data exists" result. After a failed migration, no re-probe needed.
- `'completed'`: Migration done but old data preserved as backup. User can verify things work before cleaning up.
- `'cleaned'`: Terminal. No more probes, no more UI, done.

**Transient UI states** (in dialog component, not persisted):
- `idle`: dialog shown, waiting for user action
- `migrating`: spinner, migration in progress
- `failed`: error message + retry button
- `done`: summary with counts

If the app crashes mid-migration, persisted state is still `'pending'`: user retries on next launch.

#### Migration Dialog UX

```
┌──────────────────────────────────────────────┐
│  Upgrade Your Data                           │
│                                              │
│  We found recordings and settings from an    │
│  older version. Migrate them to the new      │
│  workspace format for sync support.          │
│                                              │
│  Your existing data won't be touched. This  │
│  copies everything into the new format.      │
│                                              │
│              [ Migrate Now ]                 │
│              [ Skip for Now ]                │
└──────────────────────────────────────────────┘
        │                    │
        ▼                    └── close dialog, stays 'pending',
   show spinner                  re-shown next mount
        │
   ┌────┴────┐
   │ success │──► summary: "Migrated 47 recordings, 3 transformations"
   └─────────┘   state → 'completed'
   ┌────┴────┐
   │ failed  │──► error message + [ Retry ] button
   └─────────┘   state stays 'pending'
```

After migration completes, in settings:

```
┌──────────────────────────────────────────────┐
│  Migration complete. Old data still on disk. │
│  [ Remove old data ]                         │
└──────────────────────────────────────────────┘
```

#### Migration Tasks

- [x] **3.1** Create migration module at `apps/whispering/src/lib/services/migration/`
  > **Note**: Implemented via the settings-data-migration spec. Reads old `whispering-settings` blob, maps keys, writes to workspace KV and per-key device localStorage.
  - Read existing data via desktop dual-read facade (desktop) or Dexie (web)
  - Validate with failure collection (not silent drops)
  - Auto-fail any runs/step-runs with `status: 'running'`
  - Write to workspace tables in a single `Y.Doc.transact()` call
  - Normalize `Transformation.steps[]` → `transformationSteps` rows with FK + order
  - Normalize `TransformationRun.stepRuns[]` → `transformationStepRuns` rows with FK + order
  - Map old settings keys → workspace KV (e.g. `sound.playOn.manual-start` → `sound.manualStart`)
  - Web: move `serializedAudio` from Dexie into standalone BlobStore
  - Update `localStorage['whispering:migration']` to `'completed'`
- [ ] **3.2** Create `BlobStore` interface + implementations
  - `createFileSystemBlobStore(basePath)` for desktop
  - `createIndexedDbBlobStore(dbName)` for web
- [ ] **3.3** Migration dialog component
  - On mount: check `localStorage['whispering:migration']`
  - `(absent)`: probe for old data → set `'pending'` or `'cleaned'`
  - `'pending'`: show migration dialog
  - `'completed'`: don't show dialog (cleanup option lives in settings)
  - `'cleaned'`: skip entirely
  - Handle transient states: idle → migrating → done/failed
  - Show summary counts on success (recordings, transformations, settings migrated)
- [ ] **3.4** Cleanup UI in settings page
  - When state is `'completed'`: show "Remove old data" button
  - On click: delete old Dexie DB + old localStorage keys → set `'cleaned'`

### Wave 4: Sync UI + Wiring (future: not in this PR)

This wave is deferred. It requires the sync infrastructure (Better Auth, server-remote) which is a separate workstream.

## Design Decisions (Confirmed)

### Decision 1: Flat Row for `transformationSteps` ✅ Confirmed

**Choice**: Flat row: all fields present on every row, discriminated by `type`.

**Rationale (in order of importance)**:

1. **Row-level atomicity kills discriminated unions.** The workspace API's `table.set()` replaces the entire row (`ykv.set(row.id, row)`). With a discriminated union, switching a step from `prompt_transform` → `find_replace` writes only `find_replace` fields: the `prompt_transform` data (inference provider, model selections, prompt templates) is permanently lost. With a flat row, `set()` writes the complete row including all `prompt_transform.*` fields unchanged. Switch back → everything is still there.

2. **Per-provider model memory.** The old model stores each provider's model independently (`prompt_transform.inference.provider.OpenAI.model`, `prompt_transform.inference.provider.Groq.model`, etc.). Switching providers preserves each provider's model selection. The current workspace's single `inference.model` field only stores the active provider's model: switching providers loses the previous selection.

3. **Yjs honesty.** Y.Map stores whatever keys you set. The flat row approach doesn't pretend the schema enforces something the runtime can't. Schema validation on read is sufficient for type safety; the storage layer doesn't need to match.

4. **Migration simplicity.** Old data has flat rows. Flat row → flat row = field-for-field copy. No restructuring needed.

5. **Schema readability.** One object literal with all fields. No `.merge(type.or())` composition gymnastics.

6. **camelCase for tables, dot-notation for KV.** Table rows are replaced atomically via `table.set()`: dot-notation keys provide zero per-field conflict resolution benefit and force bracket access in TypeScript (`step['prompt_transform.inference.provider.OpenAI.model']`). KV entries are independently LWW-resolved, so dot-notation (`transcription.openai.model`) creates meaningful per-key granularity. Every other table in workspace.ts uses camelCase: this is consistent.

**Alternatives considered**:

- **Discriminated union (current)**: Better compile-time narrowing on `type` field. But the workspace API's row-level atomicity makes this approach fundamentally incompatible: data loss on type switches is unacceptable. The type safety benefit doesn't justify the data integrity risk.

- **Discriminated union with manual stash/restore**: The app could manually save variant data before switching types and restore it when switching back. This is fragile, error-prone, and pushes schema concerns into application logic.

**Target schema** (camelCase: consistent with other tables in workspace.ts; dot-notation reserved for KV keys where per-key LWW benefits from finer granularity):

```typescript
const transformationSteps = defineTable(type({
  id: 'string',
  transformationId: 'string',
  order: 'number',
  type: "'prompt_transform' | 'find_replace'",

  // Prompt transform: active provider
  inferenceProvider: type.enumerated(...INFERENCE_PROVIDER_IDS),

  // Prompt transform: per-provider model memory
  openaiModel: 'string',
  groqModel: 'string',
  anthropicModel: 'string',
  googleModel: 'string',
  openrouterModel: 'string',
  customModel: 'string',
  customBaseUrl: 'string',

  // Prompt transform: prompt templates
  systemPromptTemplate: 'string',
  userPromptTemplate: 'string',

  // Find & replace
  findText: 'string',
  replaceText: 'string',
  useRegex: 'boolean',

  _v: '1',
}));
```

### Decision 2: Individual KVs for Transcription Config ✅ Confirmed

**Choice**: Break `transcription.config` blob into individual KVs.

**Rationale**:

1. **LWW safety.** `transcription.config` is a single KV entry: a blob containing `{ service, model }`. With LWW conflict resolution, if Device A changes the service and Device B changes the model simultaneously, one device's entire blob overwrites the other. Individual KVs (`transcription.service`, `transcription.openai.model`, etc.) give per-key LWW: both changes survive.

2. **Per-service model memory.** Each service's model selection is stored independently. Switching from OpenAI to Groq and back preserves your OpenAI model selection.

3. **Consistency with transformationSteps.** Same principle: individual fields over blobs, discriminated by a type/service selector rather than schema-level unions.

**Target KVs**:
- `transcription.service`: selected service ID (replaces blob)
- `transcription.openai.model`: OpenAI model selection
- `transcription.groq.model`: Groq model selection
- `transcription.elevenlabs.model`: ElevenLabs model selection
- `transcription.deepgram.model`: Deepgram model selection
- `transcription.mistral.model`: Mistral model selection

### Decision 3: KV Key Naming ✅ Confirmed

**Choice**: Keep the new shorter names (`sound.manualStart` not `sound.playOn.manual-start`). The migration handles the mapping. Cleaner namespace is worth a one-time translation.

### Decision 4: Two Separate Settings Files ✅ Confirmed

**Choice**: `workspace-settings.svelte.ts` + `device-config.svelte.ts` instead of a single merged `settings.svelte.ts`.

**Rationale**:

1. **Real architectural boundary.** User preferences (synced) and device configuration (hardware/OS-bound) are fundamentally different things. Two files make this explicit.

2. **Simpler implementation.** No dual-source merging, no "which source does this key come from?" logic. Each file owns its storage backend completely.

3. **Encryption readiness.** When encryption lands, API keys move from device-config to workspace KV. The workspace-settings file is already wired to workspace KV: it's just adding keys. No architectural change needed.

4. **Consumer clarity.** `import { workspaceSettings } from './workspace-settings.svelte'` tells you this setting syncs. `import { deviceConfig } from './device-config.svelte'` tells you it doesn't. No guessing.

**What goes where:**

| `workspace-settings.svelte.ts` (~42 keys) | `device-config.svelte.ts` (~36 keys) |
|---|---|
| Sound toggles (8) | API keys (8): secrets, move to workspace once encrypted |
| Output behavior (6) | API endpoint overrides (2) |
| UI prefs (2) | Hardware device IDs (3) |
| Retention policy (2) | Recording method + cpal/ffmpeg/navigator config (6) |
| Recording mode (1) | Filesystem model paths (4) |
| Transcription service + models (11) | Self-hosted server URLs (3) |
| Transformation selection (1) | Global OS shortcuts (10) |
| Completion model (1) | |
| Analytics (1) | |
| In-app shortcuts (10) | |

### Decision 5: Migration State Machine ✅ Confirmed

**Choice**: 3-state machine in `localStorage['whispering:migration']`: `'pending'` / `'completed'` / `'cleaned'`.

**Rationale**:

1. **Minimal states.** Three persisted values cover every lifecycle phase. Transient states (migrating, failed) live only in the dialog component: no need to persist them.

2. **Crash-safe.** If the app crashes mid-migration, state is still `'pending'`. User retries on next launch. No partial state to recover from.

3. **No auto-delete.** Old data stays until the user explicitly removes it. Migration copies data; it never moves or destroys.

4. **Boot-time efficiency.** `'cleaned'` is a terminal state that skips all probes. Without it, the app would check for old Dexie DB existence on every boot forever.

## Key Reference: Workspace API Behavior

These properties of `@epicenter/workspace` informed the decisions above:

- **`table.set()` replaces the entire row.** No field-level merging. Source: `table-helper.ts` line 63 → `ykv.set(row.id, row)`. Design doc: "Row-level atomicity. `set()` replaces the entire row. No field-level updates."
- **Schema validates on read, not write.** Old data stays old in storage until rewritten. Invalid rows return `{ status: 'invalid' }`.
- **KV uses LWW (last-write-wins).** `YKeyValueLww` resolves conflicts per-key with monotonic timestamps. Finer-grained keys = safer concurrent edits.

## Review

(To be filled after implementation)
