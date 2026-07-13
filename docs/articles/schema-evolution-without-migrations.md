# Schema Evolution Without Migrations

> Historical: this article describes the retired Yjs-record model. Epicenter's
> target record plane uses records epochs. Restore or wholesale replacement
> starts a new epoch outside the sync protocol. See [ADR-0130](../adr/0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md).

Traditional databases have migrations: you write a script, run it against the database, and boom, your schema is updated. Everyone's on the same version.

That doesn't work in a CRDT system.

## Why Migrations Don't Work Here

In Epicenter, data lives in Yjs documents that sync peer-to-peer. There's no central server to run migrations against. Worse:

- Peers can be offline for weeks, then come back online with old code
- Two peers might run different app versions simultaneously
- There's no coordinator to say "everyone stop, we're migrating"

If you tried running a migration script, you'd have to answer: run it where? On whose machine? What happens when an old client syncs stale data into a "migrated" document?

## The Epicenter Approach: Schema Lives in Code

Instead of migrating data to match the schema, Epicenter validates data against the current schema at read time. The schema is defined in your code, and the validation happens when you access values.

For KV stores, this looks like:

```typescript
const result = kv.theme.get();
if (result.status === 'valid') {
  console.log(result.value); // 'dark' | 'light'
} else if (result.status === 'invalid') {
  // Value exists but doesn't match schema
  console.log('Using default');
}
```

For tables, each row is validated when read:

```typescript
const result = tables.posts.get({ id: '123' });
if (result.status === 'valid') {
  const post = result.row;
} else if (result.status === 'invalid') {
  // Row exists but has invalid fields
  console.log(result.errors);
}
```

## What This Means for Schema Changes

**Adding a field**: Just add it to the schema with a default. Old data won't have the field, so reads return the default.

```typescript
// Before
const postFields = { id: field.string(), title: field.string() };

// After: existing posts get status: 'draft' automatically
const postFields = {
  id: field.string(),
  title: field.string(),
  status: field.select(['draft', 'published'], { default: 'draft' }),
};
```

**Removing a field**: Remove it from the schema. The data stays in the Y.Doc, but your code stops reading it. No data loss, no migration, the field is just ignored.

**Changing a type**: If the old value doesn't match the new type, validation fails. The caller decides what to do: use a default, show an error, or something else.

**Renaming a field**: This is trickier. You're essentially adding a new field and removing the old one. There's a separate article on migration patterns for this case.

## The Trade-off

Yes, this means some data can become inaccessible. If you change a field from `integer` to `text`, old integer values will fail validation. They're still in the document, just not readable through the schema.

What you give up:
- Guaranteed migration of all values
- Central authority over schema versions

What you get:
- No migration coordination needed
- Works offline, always
- Old and new code can coexist
- No version vectors or upgrade paths to maintain

## When This Works Well

- **Settings and preferences**: If your theme setting becomes invalid, falling back to "light" is fine
- **User-generated content**: A blog post with an invalid status can default to "draft"
- **Apps that prioritize availability**: Better to show something than to crash on schema mismatch

## When You Might Want More

- **Financial data**: Every transaction matters; you can't lose values to validation failures
- **Legal/compliance**: Audit trails can't have gaps from "invalid" data
- **Strict data contracts**: When downstream systems expect exact formats

For these cases, you might store a version number in the data itself and handle transformations explicitly. But for most local-first apps, the simpler approach works.

## The Mental Model

Think of it this way: the Y.Doc is a bag of bytes that syncs reliably. The schema is a lens for viewing those bytes. When you change the lens, some things come into focus, others blur out. The bytes don't change; your interpretation does.

This is fundamentally different from traditional databases where schema and data are tightly coupled. In Epicenter, they're separate concerns: Yjs handles sync, the schema handles interpretation.
