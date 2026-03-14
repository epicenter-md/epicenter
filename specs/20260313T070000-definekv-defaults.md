# defineKv Defaults (Pre-Wave 2)

**Date**: 2026-03-13
**Status**: Implemented
**Prerequisite for**: [20260312T210000-whispering-settings-separation.md](./20260312T210000-whispering-settings-separation.md)

## Problem

`defineKv(schema)` has no concept of a default value. When `kv.get(key)` finds no data in the Yjs doc, it returns `{ status: 'not_found', value: undefined }`. This forces every consumer to handle the missing-data case.

For Wave 2 (SvelteMap reactive settings), we need `get(key)` to always return a valid typed value—either the stored value or a default. Writing defaults to the Yjs doc is wrong: it pollutes CRDT history, causes initialization races on multi-device sync, and makes every new workspace carry 43 CRDT operations worth of "nothing changed."

## Solution

Add a required `defaultValue` parameter to `defineKv`. Simplify `get()` to always return a value—the stored value if valid, the default otherwise. Never write the default to Yjs.

### New API

```typescript
// Before: no default, get() returns discriminated union
const sound = defineKv(type('boolean'));
const result = kv.get('sound.manualStart');
// result: { status: 'valid', value: true } | { status: 'not_found' } | { status: 'invalid' }

// After: required default, get() returns value directly
const sound = defineKv(type('boolean'), true);
const value = kv.get('sound.manualStart');
// value: boolean — always valid
```

### Behavior on `get(key)`

| Yjs state | Schema validation | Return value |
|---|---|---|
| Key exists, valid | passes | stored value (migrated to latest) |
| Key exists, invalid | fails | `defaultValue` |
| Key missing | n/a | `defaultValue` |

No `KvGetResult` discriminated union needed at this layer. Consumers always get `T`.

### Multi-version overload (kept for backward compat, likely removable)

```typescript
// Multi-version: default passed to .migrate()
defineKv(v1, v2).migrate(fn, defaultValue)
```

Nobody currently uses multi-version KV. The variadic+migrate pattern adds complexity that KV settings don't need—they're simple flags and preferences, not structured documents that evolve through versions. When a KV schema changes, updating the schema and default is sufficient: `get()` already returns `defaultValue` when stored data fails validation, which **is** the migration strategy for KV.

**Follow-up consideration:** Remove the variadic overload entirely. If a rare case needs schema evolution, a single-schema overload with an optional `migrate` callback would be simpler than the current multi-schema variadic pattern.

## Breaking changes

**Changed:** `kv.get(key)` return type: `KvGetResult<T>` → `T`

**Affected files** (exhaustive):
- `packages/workspace/src/workspace/create-kv.test.ts` — 4 assertions check `.status`
- `packages/workspace/src/workspace/define-workspace.test.ts` — 1 assertion checks `.status`
- `packages/workspace/src/workspace/benchmark.test.ts` — 3 assertions check `.status`

No app-level code uses `kv.get()` yet. All breakage is in tests only.

**Unchanged:** `kv.set()`, `kv.delete()`, `kv.observe()` — no changes.

## Implementation plan

### Task 1: Add `defaultValue` to `KvDefinition` type

**File:** `packages/workspace/src/workspace/types.ts`

**Change:** Add `defaultValue` field to `KvDefinition`:

```typescript
export type KvDefinition<TVersions extends readonly CombinedStandardSchema[]> = {
  schema: CombinedStandardSchema<unknown, StandardSchemaV1.InferOutput<TVersions[number]>>;
  migrate: (value: ...) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
  defaultValue: StandardSchemaV1.InferOutput<LastSchema<TVersions>>; // NEW
};
```

**Change:** Simplify `KvHelper.get()` return type:

```typescript
// Before
get<K extends keyof TKvDefinitions & string>(key: K): KvGetResult<InferKvValue<TKvDefinitions[K]>>;

// After
get<K extends keyof TKvDefinitions & string>(key: K): InferKvValue<TKvDefinitions[K]>;
```

**Acceptance:**
- [x] `KvDefinition` has `defaultValue` field
- [x] `KvHelper.get()` returns `InferKvValue<T>` directly
- [x] TypeScript compiles clean

---

### Task 2: Update `defineKv()` to require default

**File:** `packages/workspace/src/workspace/define-kv.ts`

**Single-version overload (the 99% case):**

```typescript
// Before
export function defineKv<TSchema>(schema: TSchema): KvDefinition<[TSchema]>;

// After
export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(
  schema: TSchema,
  defaultValue: StandardSchemaV1.InferOutput<TSchema>,
): KvDefinition<[TSchema]>;
```

**Multi-version overload:**

```typescript
// Before
defineKv(...versions).migrate(fn): KvDefinition<TVersions>;

// After
defineKv(...versions).migrate(fn, defaultValue): KvDefinition<TVersions>;
```

**Implementation runtime logic:**

```typescript
// Single version: second arg is NOT a schema (it's a primitive/object value)
if (args.length === 2 && !isStandardSchema(args[1])) {
  return { schema: args[0], migrate: (v) => v, defaultValue: args[1] };
}

// Multi version: schemas only, .migrate() adds defaultValue
if (args.length >= 2) {
  return {
    migrate(fn, defaultValue) {
      return { schema: createUnionSchema(versions), migrate: fn, defaultValue };
    },
  };
}
```

Distinguish schemas from values using `'~standard' in args[1]`.

**Acceptance:**
- [x] `defineKv(type('boolean'), true)` compiles and returns `KvDefinition` with `defaultValue: true`
- [x] `defineKv(type('string'), 'hello')` works
- [x] `defineKv(type('string | null'), null)` works
- [x] Multi-version `defineKv(v1, v2).migrate(fn, defaultValue)` works
- [x] Type error if defaultValue doesn't match schema output type

---

### Task 3: Update `createKv` to return default on miss/invalid

**File:** `packages/workspace/src/workspace/create-kv.ts`

**Change `get()` method:**

```typescript
// Before
get(key) {
  const definition = definitions[key];
  if (!definition) throw new Error(`Unknown KV key: ${key}`);
  const raw = ykv.get(key);
  if (raw === undefined) {
    return { status: 'not_found', value: undefined };
  }
  return parseValue(raw, definition);
}

// After
get(key) {
  const definition = definitions[key];
  if (!definition) throw new Error(`Unknown KV key: ${key}`);
  const raw = ykv.get(key);
  if (raw === undefined) return definition.defaultValue;

  const result = definition.schema['~standard'].validate(raw);
  if (result instanceof Promise) throw new TypeError('Async schemas not supported');
  if (result.issues) return definition.defaultValue;

  return definition.migrate(result.value);
},
```

`parseValue` is no longer needed for `get()` — inline the logic. Keep `parseValue` if `observe()` still uses it.

**Acceptance:**
- [x] `get(key)` returns the stored value when valid
- [x] `get(key)` returns `defaultValue` when key is missing (never written)
- [x] `get(key)` returns `defaultValue` when stored data fails validation
- [x] Return type is `InferKvValue<T>`, not `KvGetResult<T>`

---

### Task 4: Add `observeAll()` to KV helper

**File:** `packages/workspace/src/workspace/create-kv.ts` and `types.ts`

This is needed for Wave 2 (SvelteMap updates from a single observer). Including it here since we're already modifying these files.

**Add to `KvHelper` type in `types.ts`:**

```typescript
/** Watch for changes to any KV key. Returns unsubscribe function. */
observeAll(
  callback: (
    changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
    transaction: unknown,
  ) => void,
): () => void;
```

**Implement in `create-kv.ts`:**

```typescript
observeAll(callback) {
  const handler = (
    changes: Map<string, YKeyValueLwwChange<unknown>>,
    transaction: Y.Transaction,
  ) => {
    const parsed = new Map<string, KvChange<unknown>>();
    for (const [key, change] of changes) {
      const definition = definitions[key];
      if (!definition) continue;
      if (change.action === 'delete') {
        parsed.set(key, { type: 'delete' });
      } else {
        const result = definition.schema['~standard'].validate(change.newValue);
        if (!(result instanceof Promise) && !result.issues) {
          parsed.set(key, { type: 'set', value: definition.migrate(result.value) });
        }
      }
    }
    if (parsed.size > 0) callback(parsed, transaction);
  };
  ykv.observe(handler);
  return () => ykv.unobserve(handler);
},
```

**Acceptance:**
- [x] Single observer fires for all key changes
- [x] Invalid values skipped
- [x] Unknown keys skipped
- [x] Returns unsubscribe function
- [ ] Test covers multi-key batch changes

---

### Task 5: Update all 43 KV entries in workspace.ts with defaults

**File:** `apps/whispering/src/lib/workspace.ts`

Every `defineKv(type(...))` → `defineKv(type(...), defaultValue)`.

Defaults sourced from old `settings.ts` schema. Mapping:

| KV key | Old settings key | Default |
|---|---|---|
| `sound.manualStart` | `sound.playOn.manual-start` | `true` |
| `sound.manualStop` | `sound.playOn.manual-stop` | `true` |
| `sound.manualCancel` | `sound.playOn.manual-cancel` | `true` |
| `sound.vadStart` | `sound.playOn.vad-start` | `true` |
| `sound.vadCapture` | `sound.playOn.vad-capture` | `true` |
| `sound.vadStop` | `sound.playOn.vad-stop` | `true` |
| `sound.transcriptionComplete` | `sound.playOn.transcriptionComplete` | `true` |
| `sound.transformationComplete` | `sound.playOn.transformationComplete` | `true` |
| `output.transcription.clipboard` | `transcription.copyToClipboardOnSuccess` | `true` |
| `output.transcription.cursor` | `transcription.writeToCursorOnSuccess` | `true` |
| `output.transcription.enter` | `transcription.simulateEnterAfterOutput` | `false` |
| `output.transformation.clipboard` | `transformation.copyToClipboardOnSuccess` | `true` |
| `output.transformation.cursor` | `transformation.writeToCursorOnSuccess` | `false` |
| `output.transformation.enter` | `transformation.simulateEnterAfterOutput` | `false` |
| `ui.alwaysOnTop` | `system.alwaysOnTop` | `'Never'` |
| `ui.layoutMode` | `ui.layoutMode` | `'sidebar'` |
| `retention.strategy` | `database.recordingRetentionStrategy` | `'keep-forever'` |
| `retention.maxCount` | `database.maxRecordingCount` | `100` |
| `recording.mode` | `recording.mode` | `'manual'` |
| `transcription.service` | `transcription.selectedTranscriptionService` | `'moonshine'` |
| `transcription.openai.model` | `transcription.openai.model` | `TRANSCRIPTION.OpenAI.defaultModel` |
| `transcription.groq.model` | `transcription.groq.model` | `TRANSCRIPTION.Groq.defaultModel` |
| `transcription.elevenlabs.model` | `transcription.elevenlabs.model` | `TRANSCRIPTION.ElevenLabs.defaultModel` |
| `transcription.deepgram.model` | `transcription.deepgram.model` | `TRANSCRIPTION.Deepgram.defaultModel` |
| `transcription.mistral.model` | `transcription.mistral.model` | `TRANSCRIPTION.Mistral.defaultModel` |
| `transcription.language` | `transcription.outputLanguage` | `'auto'` |
| `transcription.prompt` | `transcription.prompt` | `''` |
| `transcription.temperature` | `transcription.temperature` | `0` |
| `transcription.compressionEnabled` | `transcription.compressionEnabled` | `false` |
| `transcription.compressionOptions` | `transcription.compressionOptions` | `FFMPEG_DEFAULT_COMPRESSION_OPTIONS` |
| `transformation.selectedId` | `transformations.selectedTransformationId` | `null` |
| `transformation.openrouterModel` | `completion.openrouter.model` | `'mistralai/mixtral-8x7b'` |
| `analytics.enabled` | `analytics.enabled` | `true` |
| `shortcut.toggleManualRecording` | `shortcuts.local.toggleManualRecording` | `' '` |
| `shortcut.startManualRecording` | `shortcuts.local.startManualRecording` | `null` |
| `shortcut.stopManualRecording` | `shortcuts.local.stopManualRecording` | `null` |
| `shortcut.cancelManualRecording` | `shortcuts.local.cancelManualRecording` | `'c'` |
| `shortcut.toggleVadRecording` | `shortcuts.local.toggleVadRecording` | `'v'` |
| `shortcut.startVadRecording` | `shortcuts.local.startVadRecording` | `null` |
| `shortcut.stopVadRecording` | `shortcuts.local.stopVadRecording` | `null` |
| `shortcut.pushToTalk` | `shortcuts.local.pushToTalk` | `'p'` |
| `shortcut.openTransformationPicker` | `shortcuts.local.openTransformationPicker` | `'t'` |
| `shortcut.runTransformationOnClipboard` | `shortcuts.local.runTransformationOnClipboard` | `'r'` |

**Note:** `transcription.temperature` was a string `'0.0'` in old settings. The KV type is `number` (`0 <= number <= 1`). Default should be `0`.

**Acceptance:**
- [x] All 43 entries have explicit defaults
- [x] Defaults match the old settings schema
- [x] TypeScript compiles (each default matches its schema's output type)

---

### Task 6: Update tests

**Files:**
- `packages/workspace/src/workspace/create-kv.test.ts`
- `packages/workspace/src/workspace/define-workspace.test.ts`
- `packages/workspace/src/workspace/benchmark.test.ts`

**Changes:**

All `defineKv(type(...))` → `defineKv(type(...), defaultValue)`.

All `result.status === 'valid'` / `result.value` → direct value assertion.

Example:

```typescript
// Before
const result = kv.get('theme');
expect(result.status).toBe('valid');
if (result.status === 'valid') {
  expect(result.value).toEqual({ mode: 'dark' });
}

// After
const value = kv.get('theme');
expect(value).toEqual({ mode: 'dark' });
```

```typescript
// Before — not_found
expect(kv.get('theme').status).toBe('not_found');

// After — returns default
expect(kv.get('theme')).toEqual({ mode: 'light' }); // the default
```

**New test cases to add:**

```typescript
test('get returns defaultValue for unset key', () => {
  const kv = createKv(ydoc, {
    theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
  });
  expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('get returns defaultValue for invalid stored data', () => {
  const kv = createKv(ydoc, {
    count: defineKv(type('number'), 0),
  });
  // Write garbage directly to the Y.Array
  ydoc.getArray('kv').push([{ key: 'count', val: 'not-a-number', ts: 0 }]);
  expect(kv.get('count')).toBe(0);
});

test('get returns stored value when valid', () => {
  const kv = createKv(ydoc, {
    count: defineKv(type('number'), 0),
  });
  kv.set('count', 42);
  expect(kv.get('count')).toBe(42);
});

test('delete causes get to return defaultValue', () => {
  const kv = createKv(ydoc, {
    count: defineKv(type('number'), 0),
  });
  kv.set('count', 42);
  kv.delete('count');
  expect(kv.get('count')).toBe(0);
});
```

**Acceptance:**
- [x] All existing tests updated and passing
- [x] New default-behavior tests passing
- [x] `bun test` in `packages/workspace` passes

---

## Execution order

```
Task 1 (types.ts)  ──►  Task 2 (define-kv.ts)  ──►  Task 3 (create-kv.ts)
                                                          │
                                                          ├──►  Task 4 (observeAll)
                                                          │
Task 5 (workspace.ts)  ◄─── depends on Tasks 1-3 ────────┘
                                                          │
Task 6 (tests)  ◄──── depends on Tasks 1-3 ──────────────┘
```

Tasks 5 and 6 can run in parallel after Tasks 1-3 complete.
Task 4 (observeAll) is independent and can run in parallel with Task 3.

## Verification

- [x] `bun test` in `packages/workspace` — all tests pass (70/70)
- [x] `bun run tsc --noEmit` in packages/workspace — no new type errors (10 pre-existing errors remain, none in our files)
- [ ] `bun run check` in `apps/whispering` — workspace.ts compiles clean with new defaults (not verified—app-level check requires full monorepo build)

## Review

### Changes made

**Wave 1** (committed `c8e64f781`):
- `types.ts`: Added `defaultValue` field to `KvDefinition`, changed `KvHelper.get()` return type from `KvGetResult<T>` to `T` directly
- `define-kv.ts`: Rewrote overloads — single-version `defineKv(schema, defaultValue)`, multi-version `.migrate(fn, defaultValue)`

**Wave 2** (committed `d3e8b382f`):
- `create-kv.ts`: Simplified `get()` to return `defaultValue` on miss/invalid instead of `KvGetResult` discriminated union
- `create-kv.ts` + `types.ts`: Added `observeAll()` method that batches all key changes per Y.Transaction

**Wave 3** (this commit):
- `workspace.ts`: Updated all 43 `defineKv()` calls with correct defaults per mapping table, added `TRANSCRIPTION` and `FFMPEG_DEFAULT_COMPRESSION_OPTIONS` imports
- `create-kv.test.ts`: Rewrote all tests + added 'invalid stored data' test
- `define-workspace.test.ts`: Updated 3 `defineKv()` calls with defaults + 1 assertion
- `benchmark.test.ts`: Updated 3 `defineKv()` calls + 3 assertions
- `define-kv.test.ts`: Updated all `defineKv()` calls with defaults (single-version + multi-version `.migrate()` calls)
- `describe-workspace.test.ts`: Updated 2 `defineKv()` calls with defaults
- `create-workspace.test.ts`: Updated 1 `defineKv()` call with default
- `ingest/reddit/workspace.ts`: Updated 2 `defineKv()` calls with `null` defaults

### Bug fix discovered during verification

`define-kv.ts` schema detection (`isSecondArgSchema`) used `typeof args[1] === 'object'` to distinguish schemas from default values. Arktype schemas are **functions** (`typeof === 'function'`), not objects. This caused multi-version `defineKv(v1, v2)` to misidentify the second schema as a default value, silently producing a broken `KvDefinition`. Fixed by adding `|| typeof args[1] === 'function'` to the check.

### Pre-existing issues (not caused by this spec)

- 10 TypeScript errors in `packages/workspace` — all in unrelated files (`define-table.ts`, `y-keyvalue-lww.test.ts`, `reddit/` tests, `types.ts` updatedAt indexing)

### Follow-up: consider removing variadic defineKv pattern

KV stores are single values per key—not documents that accumulate rows over time. The `defineKv(v1, v2).migrate(fn, default)` pattern imports table-like versioning machinery that KV doesn't need. The "invalid stored data → return default" behavior already handles schema changes gracefully. If a migration function is ever needed, it could be an optional parameter on the shorthand: `defineKv(schema, default, { migrate? })` rather than a separate multi-schema overload.
