# Why Reads Should Be Pure

> Historical: this article reasons about the retired migrate-on-read record
> model. The target builds and validates a complete successor database before
> activation. See [ADR-0125](../adr/0125-record-schemas-are-immutable-evolution-creates-a-successor-database.md).

When designing Epicenter's migrate-on-read pattern, we faced a question: after reading and migrating old data, should we automatically write the migrated version back to storage?

We decided no. Reads should be pure.

## The Temptation

The argument for auto write-back seems compelling:

```typescript
// User reads v1 data
const post = tables.posts.get('post-1');
// Internally: read v1 → migrate to v3 → return v3

// If we wrote back automatically:
// Storage now contains v3, future reads are faster
```

Data gets "upgraded" over time. Future reads skip the migration. Seems efficient.

## Why We Didn't Do It

### 1. Reads Causing Writes Is Unexpected

The principle of least surprise matters. When you call `get()`, you expect to... get something. Not modify storage.

```typescript
// This looks like a read-only operation
const post = tables.posts.get('post-1');

// But with auto write-back, it's actually:
// 1. Read from storage
// 2. Validate
// 3. Migrate
// 4. Write back to storage  ← SURPRISE!
// 5. Return value
```

Debugging becomes harder when "read" operations have side effects.

### 2. Increased Sync Traffic

In a local-first app, writes sync to other devices and the server. Auto write-back means:

```
User opens app
→ Reads 100 old records
→ Triggers 100 writes
→ Syncs 100 changes to server
→ Syncs to user's other devices
```

The user did nothing, but their app is churning through bandwidth. On mobile with metered connections, this is hostile.

### 3. Concurrent Read Conflicts

What if two clients read the same v1 record simultaneously?

```
Client A: read v1 → migrate to v3 → write v3
Client B: read v1 → migrate to v3 → write v3
```

Both write the same data, but they're still two writes that need to merge. In Yjs, this creates unnecessary history. With some CRDTs, it could cause conflicts.

### 4. Testing Becomes Harder

Pure reads are easy to test:

```typescript
// Setup
storage.write({ id: '1', title: 'Test', _v: 1 });

// Test
const result = table.get('1');
expect(result._v).toBe(3); // Migrated

// Verify storage unchanged
expect(storage.read('1')._v).toBe(1); // Still v1
```

With auto write-back, the same test modifies storage, making assertions about "before and after" states complicated.

### 5. Intentionality Matters

Sometimes you want old data to stay old. Maybe you're debugging, analyzing migration behavior, or intentionally preserving history. Auto write-back removes that choice.

## The Alternative: Explicit Write-Back

If users want to persist migrations, they can do it explicitly:

```typescript
const result = tables.posts.get('post-1');
if (result.status === 'valid') {
	// Explicitly persist the migrated version
	tables.posts.upsert(result.row);
}
```

Or batch it:

```typescript
// Migrate all old data explicitly
const allPosts = tables.posts.getAllValid();
for (const post of allPosts) {
	tables.posts.upsert(post);
}
```

This is intentional. The user knows they're writing. Sync traffic is expected.

## When Auto Write-Back Makes Sense

To be fair, auto write-back isn't always wrong:

**Consider it when:**

- Migration is computationally expensive (rare)
- You control the network layer and can batch/debounce
- Users expect writes (e.g., "upgrade all my data" button)

**Avoid it when:**

- Reads should be predictable
- Bandwidth matters
- You want simple, testable code

For Epicenter's general-purpose API, predictability wins.

## Implementation

Our implementation is simple because we don't write back:

```typescript
function get(id: string): GetResult<TRow> {
  const raw = storage.read(id);
  if (!raw) return { status: 'not_found', id };

  const validated = unionSchema.validate(raw);
  if (validated.issues) return { status: 'invalid', ... };

  const migrated = migrate(validated.value);
  return { status: 'valid', row: migrated };
  // Note: no write!
}
```

Clean, predictable, testable.

## Conclusion

"Reads should be pure" isn't a universal law, but it's a good default. Side effects in unexpected places create surprising behavior, debugging nightmares, and architectural complexity.

For Epicenter, we chose purity. If you need to persist migrations, do it explicitly. Your future self debugging a sync issue will thank you.
