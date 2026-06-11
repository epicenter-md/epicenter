# Persisted State Redesign

Redesign `createPersistedState` and extract `deviceConfig`'s SvelteMap logic into two reusable utilities in `packages/svelte-utils`, following Svelte 5 ecosystem conventions (runed).

## Context

**Current state:**
- `createPersistedState`: factory function, `.value` accessor, schema required, `onParseError` must return a fallback
- `deviceConfig`: 326-line bespoke module with SvelteMap, cross-tab sync, per-key localStorage. Not reusable.

**Problems:**
1. `createPersistedState` uses `.value` (Vue convention) instead of `.current` (Svelte 5/runed convention)
2. `createPersistedState` is a factory function, not a class (runed uses PascalCase classes)
3. `onParseError` conflates side effects (logging) with providing a fallback value
4. `onUpdateSuccess` and `onUpdateSettled` exist but have zero consumers
5. No multi-key equivalent: `deviceConfig` reimplements SvelteMap + event listeners + parsing inline

## Design Decisions

### 1. Options object, not positional args

Runed uses `new PersistedState(key, initialValue, options?)`: positional for required, object for optional. **We should not follow this.** Reasons:

- Runed has 2 required params. We have 2 required + schema (often provided). Three positional args is where readability degrades.
- Positional args encode order, not semantics. `key` and `defaultValue` are equally required: making one "first" is arbitrary.
- Options objects are self-documenting at call sites. You read `{ key: '...', defaultValue: null }` and know what each thing is.
- The existing codebase already uses options objects for this pattern (`createPersistedState`).
- Adding a required field later doesn't break the signature with options objects.

**Both `PersistedState` and `PersistedMap` use a single options object.** Required fields are enforced by TypeScript, not by position.

### 2. `defaultValue`, not `initialValue`

Runed calls it `initialValue`. We use `defaultValue` because it's used for:
- First visit (no stored value)
- Validation failure (corrupt stored value)
- `reset()` on PersistedMap
- `getDefault()` on PersistedMap

"Default" is the right word. It's a value you can return to, not just a one-time seed. This also matches the existing codebase convention (`DEVICE_DEFINITIONS`, `KV_DEFINITIONS`).

### 3. Schema is required

Both `PersistedState` and `PersistedMap` require a schema. Reasons:

- localStorage is external, untrusted storage. Data can be edited in DevTools, corrupted by other code, or left over from a previous app version. Validation isn't optional. It's the point.
- Requiring schema eliminates the two-overload type system ("with schema" vs "without schema"). One path, one type inference strategy: always infer from `StandardSchemaV1.InferOutput<S>`.
- `defaultValue` uses `NoInfer<T>` to prevent TypeScript from widening the type from the default instead of the schema.
- If you truly don't care about validation, `type('unknown')` is one line. The API shouldn't add complexity to serve that edge case.

### 4. Error types use `defineErrors` from wellcrafted

Consistent with the rest of the codebase. Tagged errors with structured context, not plain discriminated unions.

```ts
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';

export const PersistedError = defineErrors({
  JsonParseFailed: ({ key, raw, cause }: { key: string; raw: string; cause: unknown }) => ({
    message: `Failed to parse stored value for "${key}": ${extractErrorMessage(cause)}`,
    key,
    raw,
    cause,
  }),
  SchemaValidationFailed: ({
    key,
    value,
    issues,
  }: {
    key: string;
    value: unknown;
    issues: ReadonlyArray<StandardSchemaV1.Issue>;
  }) => ({
    message: `Schema validation failed for stored value at "${key}"`,
    key,
    value,
    issues,
  }),
});
export type PersistedError = InferErrors<typeof PersistedError>;
```

Both `PersistedState` and `PersistedMap` use the same error type. For `PersistedMap`, `key` is the definition key (e.g., `'apiKeys.openai'`), not the full prefixed localStorage key.

### 5. `onError` is fire-and-forget, not a fallback provider

Current `onParseError` must return a value. It conflates "handle the error" with "provide the fallback." New design splits these:

- `defaultValue`: always the fallback (explicit, required, no callback needed)
- `onError`: optional side effect (logging, notifications). Receives a `PersistedError`. Returns void.

### 6. Drop unused callbacks

`onUpdateSuccess` and `onUpdateSettled` have zero consumers in the codebase. Removed. Keeping only:
- `onError`: read failures (parse error, validation failure). Receives `PersistedError`.
- `onUpdateError`: write failures (quota exceeded). Receives raw `unknown` error.

### 7. Follow runed conventions

- **PascalCase class**: `PersistedState`, `PersistedMap`
- **`.current` accessor**: consistent with all 34+ runed utilities
- **Options deviate from runed**: options object instead of positional args (justified in §1)

## API Design

### `PersistedState<S>`: single persisted value

```ts
import { PersistedState } from '@epicenter/svelte-utils';
import { type } from 'arktype';

const session = new PersistedState({
  key: 'ffmpeg-session',
  defaultValue: null,
  schema: type({ pid: 'number', outputPath: 'string' }).or('null'),
  onError: (error) => console.warn('Invalid session data:', error.message),
});

session.current;        // typed from schema output
session.current = null;  // persists to localStorage
```

**Options type:**

```ts
type PersistedStateOptions<S extends StandardSchemaV1> = {
  key: string;                                        // required
  schema: S;                                          // required: StandardSchemaV1
  defaultValue: NoInfer<StandardSchemaV1.InferOutput<S>>; // required: fallback
  storage?: 'local' | 'session';                      // default: 'local'
  syncTabs?: boolean;                                  // default: true
  onError?: (error: PersistedError) => void;           // optional: side effects
  onUpdateError?: (error: unknown) => void;            // optional: write failures
};
```

No `storage_empty` error. Empty storage returns `defaultValue` silently. That's the expected first-visit case, not a failure.

**Internal implementation (high level):**

- Uses `$state` for the reactive value
- Reads localStorage on construction, validates via schema, falls back to `defaultValue` on failure
- Cross-tab sync via `storage` event listener (when `syncTabs: true`)
- Same-tab sync via `focus` event listener (always on. Catches DevTools edits)
- Writes to localStorage on `.current` set, calls `onUpdateError` on write failure

### `PersistedMap<D>`: typed multi-key persisted config

```ts
import { PersistedMap } from '@epicenter/svelte-utils';
import { type } from 'arktype';

const deviceConfig = new PersistedMap({
  prefix: 'whispering.device.',
  definitions: {
    'apiKeys.openai': { defaultValue: '', schema: type('string') },
    'apiKeys.anthropic': { defaultValue: '', schema: type('string') },
    'recording.method': {
      defaultValue: 'cpal' as const,
      schema: type("'cpal' | 'navigator' | 'ffmpeg'"),
    },
  },
  onError: (key, error) => console.warn(`Invalid "${key}": ${error.message}`),
  onUpdateError: (key, error) => rpc.notify.error({ ... }),
});

deviceConfig.get('apiKeys.openai');              // '' (typed as string)
deviceConfig.set('apiKeys.openai', 'sk-...');    // persists to localStorage
deviceConfig.getDefault('recording.method');     // 'cpal'
deviceConfig.reset();                            // all keys → defaults
deviceConfig.update({ 'apiKeys.openai': '...' }); // batch set
```

**Options type:**

```ts
type PersistedMapDefinition<S extends StandardSchemaV1> = {
  schema: S;                                          // required
  defaultValue: NoInfer<StandardSchemaV1.InferOutput<S>>; // required
};

type PersistedMapOptions<D extends Record<string, PersistedMapDefinition<any>>> = {
  prefix: string;                                     // required
  definitions: D;                                     // required
  storage?: 'local' | 'session';                      // default: 'local'
  syncTabs?: boolean;                                  // default: true
  onError?: (key: string, error: PersistedError) => void;
  onUpdateError?: (key: string, error: unknown) => void;
};
```

**Instance API:**

```ts
{
  get<K extends keyof D>(key: K): InferDefinitionValue<D[K]>;
  set<K extends keyof D>(key: K, value: InferDefinitionValue<D[K]>): void;
  getDefault<K extends keyof D>(key: K): InferDefinitionValue<D[K]>;
  reset(): void;
  update(partial: Partial<{ [K in keyof D]: InferDefinitionValue<D[K]> }>): void;
}
```

**Internal implementation (high level):**

- Uses `SvelteMap` for per-key reactivity (reading one key doesn't re-render components reading another)
- ONE `storage` event listener for all keys (filters by prefix)
- ONE `focus` event listener for all keys (re-reads all on focus)
- Per-key localStorage read/write with `${prefix}${key}` as the storage key
- Schema validation per key on read

### What `deviceConfig` becomes

```ts
// apps/whispering/src/lib/state/device-config.svelte.ts
import { PersistedMap } from '@epicenter/svelte-utils';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { rpc } from '$lib/query';

const DEVICE_DEFINITIONS = {
  'apiKeys.openai': { defaultValue: '', schema: type('string') },
  'apiKeys.anthropic': { defaultValue: '', schema: type('string') },
  // ... rest of definitions (unchanged shape)
};

export type DeviceConfigKey = keyof typeof DEVICE_DEFINITIONS & string;
export type InferDeviceValue<K extends DeviceConfigKey> =
  (typeof DEVICE_DEFINITIONS)[K]['defaultValue'];

export const deviceConfig = new PersistedMap({
  prefix: 'whispering.device.',
  definitions: DEVICE_DEFINITIONS,
  onError: (key) =>
    console.warn(`Invalid device config for "${key}", using default`),
  onUpdateError: (key, error) =>
    rpc.notify.error({
      title: 'Error updating device config',
      description: extractErrorMessage(error),
    }),
});
```

~100 lines (all definitions), down from 326 lines.

## Required vs Optional Summary

### PersistedState

| Option | Required? | Why |
|--------|-----------|-----|
| `key` | **Required** | Identity: which localStorage key |
| `defaultValue` | **Required** | Fallback: what to use when storage is empty/invalid |
| `schema` | **Required** | localStorage is untrusted storage. Validation is the point, not an afterthought |
| `storage` | Optional | Defaults to `'local'`. `'session'` is rare |
| `syncTabs` | Optional | Defaults to `true`. Only disable for private/ephemeral state |
| `onError` | Optional | Side effect only: `defaultValue` handles fallback |
| `onUpdateError` | Optional | Write failures are rare (quota exceeded) |

### PersistedMap

| Option | Required? | Why |
|--------|-----------|-----|
| `prefix` | **Required** | Namespace: prevents localStorage key collisions |
| `definitions` | **Required** | The whole point: defines the key space with types and defaults |
| `definitions[key].defaultValue` | **Required** | Same reason as PersistedState |
| `definitions[key].schema` | **Required** | Same as PersistedState: untrusted storage, validation required |
| `storage` | Optional | Same as PersistedState |
| `syncTabs` | Optional | Same as PersistedState |
| `onError` | Optional | Same as PersistedState, but receives `key` as first arg |
| `onUpdateError` | Optional | Same as PersistedState, but receives `key` as first arg |

## Migration

### Phase 1: Add new utilities
- [ ] Add `PersistedState` class to `packages/svelte-utils`
- [ ] Add `PersistedMap` class to `packages/svelte-utils`
- [ ] Export both from `packages/svelte-utils/src/index.ts`

### Phase 2: Migrate consumers
- [ ] Migrate FFmpeg session state from `createPersistedState` to `PersistedState`
- [ ] Migrate `device-config.svelte.ts` from bespoke SvelteMap to `PersistedMap`

### Phase 3: Cleanup
- [ ] Remove `createPersistedState` (or keep as deprecated re-export)
- [ ] Verify all tests pass, diagnostics clean

## Open Questions

1. Should `PersistedMap` support `storage: 'session'`? Current `deviceConfig` only uses localStorage. Session storage for a map of config seems unusual.
2. Should we add `connect()`/`disconnect()` methods (like runed)? Not needed today, but nice for pausing persistence during bulk operations.
3. Should `PersistedState` support deep reactivity via Proxy (like runed) or only reassignment? Runed proxies objects for `state.current.nested = 'x'` to auto-persist. Simpler to skip this in v1 and require `state.current = { ...state.current, nested: 'x' }`.

## Review

### Changes made

**New files:**
- `packages/svelte-utils/src/PersistedState.svelte.ts` (214 lines): class with `.current` accessor, `$state` internally, `StandardSchemaV1` validation, cross-tab + focus sync, `defineErrors`-based error types
- `packages/svelte-utils/src/PersistedMap.svelte.ts` (286 lines): class with `SvelteMap` internally, shared event listeners, typed `.get()`/`.set()`/`.reset()`/`.getDefault()`/`.update()`

**Modified files:**
- `packages/svelte-utils/src/index.ts`: barrel exports for `PersistedState`, `PersistedMap`, `PersistedError`
- `packages/svelte-utils/package.json`: updated exports map, removed old `createPersistedState` entry
- `apps/whispering/src/lib/services/desktop/recorder/ffmpeg.ts`: migrated from `createPersistedState` to `PersistedState`, `.value` → `.current` (9 usages)
- `apps/whispering/src/lib/state/device-config.svelte.ts`: 326 → 174 lines, all infrastructure replaced by `PersistedMap`

**Deleted files:**
- `packages/svelte-utils/src/createPersistedState.svelte.ts` (189 lines)

### Notes

- Hit a circular type inference issue: `device-config → rpc → query modules → device-config`. The old factory function pattern let TypeScript infer the return type lazily, but the class constructor needed the type upfront. Fixed with explicit type annotation: `export const deviceConfig: PersistedMap<typeof DEVICE_DEFINITIONS>`.
- `PersistedError` is shared between both utilities (exported from `PersistedState.svelte.ts`, re-exported via barrel). Two variants: `JsonParseFailed` and `SchemaValidationFailed`.
- Pre-existing type errors in `@epicenter/workspace` (`mdast` module, `NumberKeysOf`) are unrelated to this change.
- Open questions (session storage, connect/disconnect, deep proxy) deferred to v2.
