# API Design Decisions: defineTable and defineKv

Designing an API is about trade-offs. Every choice closes some doors and opens others. Here's the reasoning behind Epicenter's versioned schema API.

## The Final API

```typescript
const posts = defineTable('posts')
  .version(schema1)
  .version(schema2)
  .version(schema3)
  .migrate((row) => { ... });

const tables = createTables(ydoc, { posts });
```

This didn't emerge fully formed. We considered many alternatives.

## Naming: `defineTable` vs Alternatives

**Options considered:**

| Name                   | Feel             | Problem                                          |
| ---------------------- | ---------------- | ------------------------------------------------ |
| `table('posts')`       | Clean, short     | Ambiguous - is it getting or creating a table?   |
| `createTable('posts')` | Clear it creates | Conflicts with `createTables()` binding function |
| `defineTable('posts')` | Clear it defines | Slightly verbose                                 |
| `schema('posts')`      | Generic          | Doesn't convey it's for tables                   |

**We chose `defineTable` because:**

- The `define` prefix signals "this is a definition, not a runtime instance"
- Clear distinction from `createTables()` which binds definitions to storage
- Familiar pattern from other libraries (Drizzle's `defineRelations`, etc.)

## Naming: `defineKv` vs `defineKvKey`

Early versions used `defineKvKey`:

```typescript
const theme = defineKvKey('theme')
  .version(...)
  .migrate(...);
```

**We shortened to `defineKv` because:**

- "KVKey" is redundant - "KV" already implies key-value
- The first argument IS the key
- Saying it aloud: "define KV key theme" vs "define KV theme" - the latter is cleaner

## Method Chaining: `.version().migrate()`

**Alternative A: Explicit version numbers**

```typescript
defineTable('posts').v1(schema1).v2(schema2).v3(schema3).migrate(fn);
```

Rejected because:

- Limits versions to whatever we pre-define (v1-v10?)
- Verbose for no benefit
- Version numbers are implicit in call order anyway

**Alternative B: Migration per version**

```typescript
defineTable('posts')
	.version(schema1)
	.version(schema2, (v1) => ({ ...v1, views: 0 }))
	.version(schema3, (v2) => ({ ...v2, author: null }));
```

This has appeal - each version is co-located with its migration. We almost chose this.

Rejected because:

- Can't do direct jumps (v1→v3) without intermediate steps
- Type inference is trickier (each migration is `(prev) => next`)
- Harder to refactor - migration logic spread across multiple calls

**Chosen: `.version().migrate()`**

```typescript
defineTable('posts')
  .version(schema1)
  .version(schema2)
  .version(schema3)
  .migrate((row) => { ... });
```

Benefits:

- Clean separation of schema definitions and migration logic
- Full control over migration strategy (incremental or direct)
- Single place for all migration logic
- Simpler types: `(V1 | V2 | V3) => V3`

## User-Defined vs Library-Managed Discriminator

**Option A: Library injects `__v`**

```typescript
// Library automatically adds __v: 1, __v: 2, etc.
.version(schema1)
.version(schema2)
```

**Option B: User defines discriminator**

```typescript
// User explicitly adds _v (or whatever they want)
.version(z.object({ ..., _v: z.literal(1) }))
.version(z.object({ ..., _v: z.literal(2) }))
```

**We chose Option B because:**

1. **No magic** - What you see in your schema is what's in your data
2. **Simpler implementation** - Library doesn't inject/strip fields
3. **Debugging** - Raw data inspection shows exactly what you defined

We later went further: tables now require `_v` as a number at the type level (`CombinedStandardSchema<{ id: string; _v: number }>`). Passing a table schema without `_v` to `defineTable()` is a compile error. KV stores remain flexible — `_v` is optional there. See [PR #1366](https://github.com/EpicenterHQ/epicenter/pull/1366) for the full rationale.

## Definition/Binding Separation

**Option A: All-in-one**

```typescript
const tables = createTables(ydoc, {
  posts: defineTable('posts').version(...).migrate(...)
});
```

**Option B: Separate definition from binding**

```typescript
// Define (pure, no side effects)
const postsDefinition = defineTable('posts')
  .version(...)
  .migrate(...);

// Bind (connects to Y.Doc)
const tables = createTables(ydoc, { posts: postsDefinition });
```

**We chose Option B because:**

1. **Definitions are reusable** - Same definition, different Y.Docs (great for testing)
2. **Clear phases** - Definition is pure, binding has side effects
3. **Testability** - Test definitions in isolation
4. **Organizational flexibility** - Define in one file, bind in another

## Single `.migrate()` vs Multiple

With multiple versions, you need migration logic. The question is how to structure it.

**Incremental (each version migrates to next):**

```typescript
v1 → v2 → v3
```

**Direct (any version migrates to latest):**

```typescript
v1 → v3
v2 → v3
```

We don't enforce either. The single `.migrate()` function receives any version and must return the latest. How you structure that is up to you:

```typescript
// Incremental style
.migrate((row) => {
  let current = row;
  if (current._v === 1) current = migrateV1toV2(current);
  if (current._v === 2) current = migrateV2toV3(current);
  return current;
})

// Direct style (recommended)
.migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, author: null, _v: 3 };
    case 2: return { ...row, author: null, _v: 3 };
    case 3: return row;
  }
})
```

Both work. We give you the flexibility to choose.

## Deliberate Asymmetry: Tables vs KV

Tables and KV intentionally have different versioning APIs:

```typescript
// Tables — versioning + migration (rows accumulate, schema changes must preserve data)
defineTable(v1Schema, v2Schema).migrate(fn)
createTables(ydoc, { posts })
tables.posts.get('1')

// KV — validate-or-default (preferences reset gracefully)
defineKv(schema, defaultValue)
createKv(ydoc, { theme })
kv.get('theme')
```

Tables accumulate rows that must survive schema changes—migration is mandatory. KV stores hold single preferences where resetting to the default is acceptable. This asymmetry is deliberate: borrowing table migration machinery for KV conflates two fundamentally different data lifecycles.

## Summary

Good API design is about:

- **Clarity** - Names that say what they do
- **Consistency** - Similar things work similarly
- **Flexibility** - Don't over-constrain users
- **Simplicity** - Fewer concepts to learn

We made trade-offs. Someone who wants per-version migrations might disagree with our choice. Someone who likes library-managed version fields might find ours verbose.

But we optimized for clarity and flexibility over magic and brevity. For a foundational API that developers build on, we think that's the right call.
