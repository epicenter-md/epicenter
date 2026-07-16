# How CRDTs Evolve Schemas Without Traditional Migrations

> Historical: this article describes the retired Yjs-record model. Epicenter's
> target record plane keeps schema-opaque canonical JSON and applies
> release-local lenses without user-data migration. See
> [ADR-0125](../adr/0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md).

I'm building Epicenter, a local-first workspace system using Yjs CRDTs. When I started thinking about schema evolution, I assumed I'd need something like database migrations: version numbers, up/down scripts, the whole ceremony.

Then I realized: CRDTs don't work like databases. And that changes everything.

## The Traditional Migration Problem

In a typical database, schema and data are tightly coupled:

```sql
ALTER TABLE posts ADD COLUMN status VARCHAR(20);
```

The database _enforces_ the schema. Every row must match it. Old clients can't even connect until they run the migration. You need coordination, downtime, rollback scripts.

This works because there's a single source of truth: the database server.

## The CRDT Reality

CRDTs are peer-to-peer. There's no server to enforce anything. Data just... exists in Y.Maps and Y.Arrays. Schema is something you check at read time, if you bother.

Here's what that looks like in Epicenter:

```typescript
// Read a row
const result = table.get({ id: '1' });

switch (result.status) {
  case 'valid':    // Row passes schema validation
  case 'invalid':  // Row exists but fails validation
  case 'not_found': // Row doesn't exist
}
```

Notice what's _not_ there: no error when the row doesn't match the schema. The row just... exists. You get back `'invalid'` status and can decide what to do.

## How Epicenter Handles Schema Changes

### For KV Stores: Schema Lives in Code

KV stores (settings, preferences) use a flat Y.Map with string keys:

```typescript
const settings = {
  theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
  fontSize: defineKv(field.integer(), () => 14),
};
```

The schema exists in your code, not in the data. The Y.Map just stores whatever you write to it.

**Add a new setting?**

```typescript
const settings = {
  theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
  fontSize: defineKv(field.integer(), () => 14),
  // New field: just add it
  language: defineKv(field.select(['en', 'es', 'fr']), () => 'en' as const),
};

// Old clients: ignore language (they don't know about it)
// New clients: read language, get default 'en' if never set
```

No migration needed. Old clients just don't read that key. New clients get the default.

**Remove a setting?**

```typescript
// Just remove it from the code
const settings = {
  theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
  // fontSize: removed from code
};

// The data stays in Y.Map forever
// But nobody reads it anymore
```

The old data persists in the Y.Map. It just becomes invisible to your application code.

### For Tables: Per-Field Schemas

Tables work similarly, but with a twist: each field has its own validator and default.

```typescript
const tables = {
  posts: defineTable({
    id: field.string(),
    title: field.string(),
    status: field.select(['draft', 'published'], { default: 'draft' }),
  }),
};
```

**Add a field with a default:**

```typescript
const tables = {
  posts: defineTable({
    id: field.string(),
    title: field.string(),
    status: field.select(['draft', 'published'], { default: 'draft' }),
    // New field
    priority: field.integer({ default: 0 }),
  }),
};
```

When you read an old row that doesn't have `priority`, you get the default: `0`.

When you write that row (even just updating the title), the new field gets added with its default value.

**Old clients writing to new-schema rows?**

This is where it gets interesting. If an old client (without `priority` in their schema) edits a row that a new client created (with `priority`), the old client only touches fields it knows about:

```typescript
// Old client (no priority field)
rowMap.set('title', 'Updated title');

// The priority field? Untouched. Still there.
```

Yjs uses field-level last-write-wins. The old client doesn't overwrite the whole row; it just patches the fields it changes. The `priority` field survives.

### Type Changes: The Hard Case

Want to change a field from `text` to `integer`? Or rename it? That's a breaking change.

Epicenter's answer: **epoch bumps**.

An epoch creates a new Y.Doc. Old data lives in the old epoch. New data lives in the new epoch. You write a script to transform data from old to new:

```typescript
async function migrateToV2() {
  const oldClient = await workspace.create({ epoch: 0 });
  const newClient = await workspaceV2.create({ epoch: 1 });

  for (const post of oldClient.tables.posts.getAllValid()) {
    newClient.tables.posts.upsert({
      id: post.id,
      title: post.title,
      views: parseInt(post.views, 10) || 0, // Text → Integer
    });
  }

  head.bumpEpoch(); // Tell everyone to use the new epoch
}
```

Breaking changes are rare. Additive changes (the common case) don't need epochs at all.

## The Tradeoffs

This approach accepts something traditional migrations fight against: **data loss is sometimes okay**.

For settings? If someone's custom theme preference gets reset to default because they were offline during a schema change, that's usually fine. Settings are recoverable.

For critical data (financial records, user content), this isn't enough. You need guarantees. That's where version numbers and custom migration logic come in.

Epicenter provides the tools:

```typescript
// Store version in your data
const row = {
  id: '1',
  title: 'Hello',
  _v: 2, // Schema version
};

// Read path checks version
if (row._v < currentVersion) {
  row = applyMigrations(row, row._v, currentVersion);
}
```

But you have to build it yourself. The framework doesn't enforce it because enforcement is impossible in a peer-to-peer system.

## When This Works Well

**Settings and preferences:**
- Data loss is acceptable
- Defaults make sense
- "Latest schema wins" is fine

**Additive changes:**
- New nullable fields
- New fields with sensible defaults
- New tables

**Tolerant apps:**
- Where stale data can be recomputed
- Where invalid rows can be filtered out
- Where users understand "sync means eventual consistency"

## When This Doesn't Work

**Critical data:**
- Financial transactions
- User-generated content that can't be recreated
- Audit logs

**Complex transformations:**
- Splitting one field into multiple
- Changing data types
- Denormalization that depends on related records

**Strict compatibility requirements:**
- Multiple app versions must coexist indefinitely
- No way to coordinate "everyone update by X date"

For those cases, you need traditional migration tooling: version numbers, transformation scripts, compatibility layers. You can build it on top of Epicenter's primitives, but it's not free.

## The Core Insight

Traditional databases: schema defines structure, data must conform.

CRDTs: data exists regardless, schema validates on read.

This flips the entire migration problem. Instead of "how do I change all the data to match the new schema," you ask "how do I handle data that doesn't match the schema I expect?"

The answer: defaults, validation results, and occasionally epoch bumps for breaking changes.

It's not that migrations are impossible with CRDTs. It's that the usual reasons for migrations (coordinated schema changes, data transformation, compatibility) don't map cleanly to a peer-to-peer, offline-first world.

So you design around them. Schema in code. Validation at read time. Accept some data loss for settings. Use epoch bumps for breaking changes. Build custom migration logic when you need guarantees.

The result is simpler than you'd expect. No migration scripts. No version coordination. Just: "my code expects these fields, here are the defaults."

And for 80% of apps? That's enough.

---

_See also:_

- Removed Schema Migration Patterns spec, recoverable through [Spec History](../spec-history.md) - Full technical breakdown
- [Workspace Schema Versioning spec](../../specs/20260124T125300-workspace-schema-versioning.md) - How to build explicit versioning when you need it
- [The Nested Y.Map Trap](./yjs-nested-maps-lww-trap.md) - Why schema structure matters in CRDTs
