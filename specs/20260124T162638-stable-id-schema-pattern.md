# Stable ID Schema Pattern

## Summary

This spec describes a schema definition pattern for Epicenter's KV and Table systems where every field has a **stable internal ID** that's decoupled from its developer-facing name. This enables free renaming without data migration.

## The Pattern

Every field in a KV or Table schema is defined with three components:

1. **Internal ID** (`id`): A stable string key used for storage in the Y.Map. Never changes.
2. **Type** (`type`): A Zod (or standard schema) validator for runtime type checking.
3. **Default** (`default`): Optional fallback value when data is missing or invalid.

```typescript
import { z } from 'zod';
import { defineKv, defineTable, field } from 'epicenter';

// KV Definition (id defaults to key name when not specified)
const settings = defineKv({
  'app.theme': field({
    type: z.enum(['light', 'dark', 'system']),
    default: 'system',
  }),  // id defaults to 'app.theme'
  'editor.fontSize': field({
    type: z.number().int().min(8).max(72),
    default: 14,
  }),  // id defaults to 'editor.fontSize'
});

// Table Definition
const recordings = defineTable({
  id: 'recordings',
  name: 'Recordings',
  fields: {
    id: id(),  // Special helper for primary key
    title: field({ type: z.string(), default: 'Untitled' }),  // id defaults to 'title'
    transcript: field({ type: z.string(), default: '' }),
    status: field({
      type: z.enum(['pending', 'transcribing', 'done', 'failed']),
      default: 'pending',
    }),
    createdAt: field({
      type: z.string().datetime(),
      default: () => new Date().toISOString(),  // Dynamic default
    }),
  },
});
```

## How It Works

The developer-facing key (e.g., `'app.theme'`, `'transcript'`) is separate from the storage key (`id`).

**What the Y.Doc stores:**

By default, storage keys match developer-facing keys (since `id` defaults to the key name):

```typescript
// KV Y.Map internally:
{ "app.theme": "dark", "editor.fontSize": 16 }

// Table row Y.Map internally:
{ "id": "rec_abc", "title": "Meeting", "transcript": "...", "status": "done", "createdAt": "2024-01-15T10:30:00Z" }
```

If you've renamed a field (explicitly setting `id`), the storage key differs from the developer key:

```typescript
// After renaming 'app.theme' → 'appearance.colorScheme' with id: 'app.theme'
{ "app.theme": "dark", "editor.fontSize": 16 }
// Developer sees: settings.get('appearance.colorScheme') → 'dark'
```

**What the developer sees:**

```typescript
settings.get('app.theme');           // Returns 'dark'
recordings.get('rec_abc').transcript; // Returns '...'
```

The mapping is transparent. Developers work with readable names; storage uses stable IDs.

## Renaming Is Free

To rename a field, change the developer-facing key and explicitly set `id` to preserve the old storage key:

```typescript
// Before (id defaults to 'transcript')
const recordings = defineTable({
  fields: {
    id: id(),
    transcript: field({ type: z.string(), default: '' }),
  },
});

// After: rename transcript → transcription
const recordings = defineTable({
  fields: {
    id: id(),
    transcription: field({  // ← New developer-facing name
      id: 'transcript',      // ← Explicitly set to old key, data untouched
      type: z.string(),
      default: '',
    }),
  },
});
```

No migration. No data changes. No `legacyKeys` fallback logic. The rename is purely a code change.

**Key insight**: You only need to specify `id` when renaming. For new fields, let it default to the key name.

## What This Eliminates

By making internal keys stable (either explicitly via `id` or implicitly via key name), we eliminate an entire category of CRDT bugs:

| Bug Category | Why It's Eliminated |
|--------------|---------------------|
| **Data resurrection** | Old client writes to "deleted" key? Can't happen. Keys are never deleted. |
| **Split-brain data** | Data in both old and new keys? Can't happen. There's only one key per field. |
| **Legacy key accumulation** | Read logic checking five fallback keys? Gone. One key, one read. |
| **Migration race conditions** | Two clients migrating simultaneously? Not a thing. Nothing to migrate. |
| **Version coordination** | Tracking who's migrated? Unnecessary. Schema handles interpretation. |

The pattern doesn't just make renaming easier. It makes renaming a **non-operation** at the data layer. You're not "handling" renames; you're making them structurally impossible to get wrong.

## The `field()` Helper

```typescript
import { z, ZodType } from 'zod';

type FieldDefinition<T extends ZodType> = {
  id?: string;                            // Internal storage key (defaults to the developer-facing key name)
  type: T;                                // Zod schema for validation
  default?: z.infer<T> | (() => z.infer<T>); // Default value or factory function (makes field optional)
  required?: boolean;                     // If true, missing value is an error (no default allowed)
};

function field<T extends ZodType>(def: FieldDefinition<T>): FieldDefinition<T> {
  return def;
}

// Special helper for table primary key
function id(): FieldDefinition<z.ZodString> {
  return { id: 'id', type: z.string(), required: true };
}
```

**Rules:**
- `id` defaults to the developer-facing key name if not specified
- `id` must be unique within the KV or Table (validated at definition time)
- `default` makes a field optional; missing/invalid data returns the default
- `default` can be a static value or a factory function (e.g., `() => Date.now()`)
- `required: true` makes a field mandatory; missing data is an error
- `required` and `default` are mutually exclusive (a field cannot be both required and have a default)
- `type` uses Zod (or any standard schema compatible validator)

## Read Behavior

When reading a field:

1. Get the raw value from Y.Map using the internal `id`
2. If undefined and has `default`: return default
3. If undefined and `required`: return error status
4. Validate against `type`
5. If invalid and has `default`: return default
6. If invalid and `required`: return error status
7. Return validated value

```typescript
function getDefault(fieldDef: FieldDefinition) {
  if (fieldDef.default === undefined) return undefined;
  // Support both static values and factory functions
  return typeof fieldDef.default === 'function' ? fieldDef.default() : fieldDef.default;
}

function readField(ymap: Y.Map, fieldDef: FieldDefinition, devKey: string) {
  // id defaults to the developer-facing key name
  const storageKey = fieldDef.id ?? devKey;
  const raw = ymap.get(storageKey);

  if (raw === undefined) {
    if (fieldDef.default !== undefined) return { status: 'valid', value: getDefault(fieldDef) };
    if (fieldDef.required) return { status: 'missing' };
    return { status: 'valid', value: undefined };
  }

  const result = fieldDef.type.safeParse(raw);
  if (!result.success) {
    if (fieldDef.default !== undefined) return { status: 'valid', value: getDefault(fieldDef) };
    return { status: 'invalid', error: result.error };
  }

  return { status: 'valid', value: result.data };
}
```

## Write Behavior

Writes always use the internal `id`:

```typescript
function writeField(ymap: Y.Map, fieldDef: FieldDefinition, devKey: string, value: unknown) {
  const storageKey = fieldDef.id ?? devKey;
  const result = fieldDef.type.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid value for field '${devKey}': ${result.error}`);
  }
  ymap.set(storageKey, result.data);
}
```

## Schema Evolution

| Change | How to Handle |
|--------|---------------|
| Add field | Add to schema with `default`. Old data gets the default. |
| Remove field | Remove from schema. Data stays in Y.Doc but isn't read. |
| Rename field | Change developer-facing key, keep same `id`. |
| Change type | If old values fail new validation, they return `default`. |

No migrations. No coordination. Schema is the source of truth.

---

## Why This Pattern?

### The Problem: Renaming in CRDTs

In a CRDT system, renaming a key is surprisingly hard:

1. **Copy approach**: Set new key, delete old key. But if an old client writes to the old key after you delete it, that write "resurrects" the old key.

2. **Legacy keys approach**: Read from new key, fall back to old key. Works but requires maintaining fallback logic forever.

3. **Migration scripts**: Don't work in CRDTs. No central authority to run them. Peers can be offline indefinitely.

### Alternatives Considered

**Option A: Direct Key Names (No Indirection)**

```typescript
const settings = defineKv({
  'app.theme': field({
    type: z.enum(['light', 'dark']),
    default: 'light',
  }),
});
// Y.Map stores: { "app.theme": "dark" }
```

Pros:
- Simple, what you see is what you get
- Easy to debug Y.Doc contents

Cons:
- Renaming requires `legacyKeys` fallback logic
- Legacy keys accumulate forever
- Risk of data loss during concurrent rename operations

**Option B: Auto-Generated IDs**

```typescript
const settings = defineKv({
  'app.theme': field({
    id: generateId(),  // Auto-generate stable ID
    type: z.enum(['light', 'dark']),
  }),
});
```

Cons:
- How do you generate stable IDs? Hash of key name? Then renaming breaks it.
- Random IDs? They change on every code run unless persisted somewhere.
- Adds hidden complexity.

**Option C: Default ID = Key Name, Override When Needed (This Spec) ✅**

```typescript
// ID defaults to 'app.theme' - no need to specify
'app.theme': field({ type: z.enum(['light', 'dark']) }),

// When renaming, explicitly set id to preserve old storage key
'app.colorTheme': field({ id: 'app.theme', type: z.enum(['light', 'dark']) }),
```

Pros:
- Zero boilerplate for the 90% case where you never rename
- Renaming is still trivial: change key, add explicit `id`
- No legacy key fallback logic needed
- No magic or auto-generation
- Duplicates caught at build time
- Y.Doc data is readable (uses same keys as code by default)

Cons:
- If you forget to set `id` when renaming, you get a new storage key (data appears "lost")
- Could be mitigated with a linter rule that detects removed keys without corresponding `id` references

### Why Default-to-Key-Name Wins

This approach gives you the best of both worlds:

1. **Simple case (no renames)**: Just write `field({ type, default })`. No extra thought needed.
2. **Rename case**: Add explicit `id` to preserve the old storage key. Clear and intentional.

The "silent data loss" concern is real but manageable:
- Renames are relatively rare
- A linter can catch removed keys and suggest adding `id`
- Code review should catch renames without `id`

**Option D: Always Explicit IDs**

```typescript
'app.theme': field({
  id: 'theme',
  type: z.enum(['light', 'dark']),
  default: 'light',
}),
```

Pros:
- Never any ambiguity about what's stored
- Grep-friendly

Cons:
- Boilerplate for every single field
- Developers must invent two names for everything
- Most fields are never renamed, so the overhead is wasted

We chose Option C because reducing boilerplate for the common case outweighs the risk of the rare rename case.

---

## Implementation Notes

### Uniqueness Validation

At definition time, validate that all storage IDs (explicit or defaulted) are unique:

```typescript
function defineKv(fields: Record<string, FieldDefinition>) {
  const ids = new Set<string>();
  for (const [devKey, field] of Object.entries(fields)) {
    const storageId = field.id ?? devKey;  // id defaults to devKey
    if (ids.has(storageId)) {
      throw new Error(`Duplicate storage id '${storageId}' in KV definition (used by '${devKey}')`);
    }
    ids.add(storageId);
  }
  // ... create KV accessor
}
```

This catches cases where two fields accidentally map to the same storage key:

```typescript
// This would throw an error:
defineKv({
  'theme': field({ type: z.string() }),              // storageId: 'theme'
  'colorScheme': field({ id: 'theme', type: z.string() }),  // storageId: 'theme' - DUPLICATE!
});
```

### TypeScript Inference

The developer-facing key becomes the TypeScript property name:

```typescript
type SettingsKv = {
  get(key: 'app.theme'): 'light' | 'dark' | 'system';
  get(key: 'editor.fontSize'): number;
  set(key: 'app.theme', value: 'light' | 'dark' | 'system'): void;
  // ...
};
```

The internal `id` is an implementation detail hidden from the type system.

### Debugging and Serialization

Two methods for inspecting data:

**`toJSON()`** - Human-readable keys (for application use, debugging):

```typescript
settings.toJSON()
// { "app.theme": "dark", "editor.fontSize": 16 }

recordings.get('rec_abc').toJSON()
// { "id": "rec_abc", "title": "Meeting", "transcript": "...", "status": "done", "createdAt": "2024-01-15T10:30:00Z" }
```

**`toRaw()`** - Internal storage keys (for low-level debugging, sync inspection):

```typescript
settings.toRaw()
// { "app.theme": "dark", "editor.fontSize": 16 }
// (Same as toJSON when id defaults to key name)

// But if you've renamed a field:
// 'appearance.colorScheme': field({ id: 'app.theme', ... })
settings.toRaw()
// { "app.theme": "dark", ... }  // Shows actual storage key

settings.toJSON()
// { "appearance.colorScheme": "dark", ... }  // Shows developer-facing key
```

You can also get a mapping from internal IDs to developer names:

```typescript
settings.getFieldMapping()
// { "app.theme": "appearance.colorScheme", "editor.fontSize": "editor.fontSize" }
```

---

## Workspace-Level Definition

KV and tables are typically grouped into a workspace:

```typescript
import { z } from 'zod';
import { defineWorkspace, defineKv, defineTable, field, id } from 'epicenter';

export const whispering = defineWorkspace({
  name: 'whispering',

  kv: defineKv({
    'app.theme': field({
      type: z.enum(['light', 'dark', 'system']),
      default: 'system',
    }),
    'recording.autoStart': field({
      type: z.boolean(),
      default: false,
    }),
  }),

  tables: {
    recordings: defineTable({
      id: 'recordings',
      name: 'Recordings',
      fields: {
        id: id(),
        title: field({ type: z.string(), default: 'Untitled' }),
        transcript: field({ type: z.string(), default: '' }),
        status: field({
          type: z.enum(['pending', 'transcribing', 'done', 'failed']),
          default: 'pending',
        }),
      },
    }),

    transformations: defineTable({
      id: 'transformations',
      name: 'Transformations',
      fields: {
        id: id(),
        name: field({ type: z.string(), default: 'Untitled' }),
        steps: field({ type: z.array(TransformationStepSchema), default: [] }),
      },
    }),
  },
});
```

---

## Summary

The Stable ID Schema Pattern separates developer-facing names from internal storage keys. By default, the internal `id` matches the developer-facing key name, keeping things simple. When you need to rename a field, you explicitly set `id` to preserve the old storage key.

This pattern provides:
- **Zero boilerplate** for the common case (no renames)
- **Free renames** when needed (just add explicit `id`)
- **No migration scripts** - schema is the source of truth
- **No legacy key fallback logic** - the mapping is handled by the framework
- **No CRDT coordination issues** - renaming is a code change, not a data change

For CRDT-based systems where traditional migrations don't work, this is the pragmatic choice.

---

## Related

- [CRDT Schema Evolution Without Migrations](../docs/articles/crdt-schema-evolution-without-migrations.md) - Why this pattern exists
- [Flat Y.Map with Dot-Notation Keys](../docs/articles/flat-ymap-dot-notation-pattern.md) - The underlying storage pattern
- [Nested Y.Map Replacement Danger](../docs/articles/nested-ymap-replacement-danger.md) - Why we use flat maps
