# The Best CRDT Migration Is No Migration

I've been building local-first apps with Yjs, and the hardest problem I kept hitting wasn't sync or conflict resolution. It was renaming a column.

Renaming in CRDTs is surprisingly hard (copy/delete doesn't work, legacy keys accumulate).

## The Problem

Say you have a `transcribedText` field and you want to rename it to `transcription`. In a traditional database, you'd write a migration script, run it, done.

In a CRDT? There's no central authority or server to run migrations on. Peers sync directly. Some peers might be offline for weeks. Old code and new code run simultaneously.

I tried several approaches:

**Copy and delete**: Set the new key, delete the old key. But if an old client writes to the old key after deletion, that write can "win" and resurrect the old key. Now you have data in both places.

**Legacy key fallback**: Read from new key, fall back to old key if missing. I tried this pattern extensively. It works, but you accumulate legacy keys forever. Every field rename adds another fallback. Your read logic becomes a graveyard of `legacyKeys: ['oldName', 'olderName', 'ancientName']`. And you still have edge cases where old clients write to old keys after you've "migrated."

**Migration markers**: Track which clients have migrated. Coordinate somehow. This gets complex fast and still doesn't solve the offline client problem.

## The Insight

The best migration is no migration. Don't rename keys. Ever.

Instead, separate the **internal storage key** from the **developer-facing name**. The storage key is a stable identifier that never changes. The name is just a mapping in your schema.

```typescript
// The schema maps names to stable IDs
const recordings = defineTable({
  fields: {
    transcription: field({
      id: 'f_transcript',  // This never changes
      type: z.string(),
      default: '',
    }),
  },
});
```

The Y.Map stores `{ "f_transcript": "Hello world..." }`.

Your code accesses `recordings.get(id).transcription`.

Want to rename `transcription` to `transcript`? Change the schema key:

```typescript
// Rename: transcription → transcript
const recordings = defineTable({
  fields: {
    transcript: field({     // New name
      id: 'f_transcript',   // Same ID - data untouched
      type: z.string(),
      default: '',
    }),
  },
});
```

No migration. No data changes. No legacy fallbacks. The internal ID stays the same; only the mapping changes.

## What This Eliminates

By committing to "internal keys never change," you eliminate an entire category of bugs:

- **Data resurrection**: Old client writes to deleted key? Can't happen. The key was never deleted.
- **Split-brain data**: Data in both old and new keys? Can't happen. There's only one key.
- **Legacy key accumulation**: Read logic checking five fallback keys? Gone. One key, one read.
- **Migration race conditions**: Two clients migrating simultaneously? Not a thing. Nothing to migrate.
- **Version coordination**: Tracking who's migrated? Unnecessary. The schema handles interpretation.

The pattern doesn't just make renaming easier. It makes renaming a non-operation at the data layer. You're not "handling" renames; you're making them structurally impossible to get wrong.

## The Trade-off

Yes, this means your Y.Doc data looks like gibberish:

```typescript
{ "f_transcript": "...", "f_status": "done", "f_created": "2024-01-15" }
```

Instead of:

```typescript
{ "transcript": "...", "status": "done", "createdAt": "2024-01-15" }
```

That's the trade. Human-readable storage keys vs. free renaming forever.

For CRDT-based apps, I'll take free renaming. Debugging is a minor inconvenience. Migration hell is not.

## The Pattern

Every field gets three things:

1. **`id`**: Stable internal key. Never changes. Required.
2. **`type`**: Zod schema for validation.
3. **`default`**: Fallback when data is missing or invalid.

```typescript
const settings = defineKv({
  'app.theme': field({
    id: 'theme',
    type: z.enum(['light', 'dark', 'system']),
    default: 'system',
  }),
  'editor.fontSize': field({
    id: 'font_size',
    type: z.number().min(8).max(72),
    default: 14,
  }),
});
```

Schema changes become trivial:

| Change | What You Do |
|--------|-------------|
| Add field | Add to schema with default |
| Remove field | Delete from schema (data stays, ignored) |
| Rename field | Change schema key, keep same `id` |
| Change type | Old invalid values return `default` |

No coordination. No version vectors. No migration scripts. The schema is the source of truth; the data just is.

## Why This Works in CRDT Land

CRDTs guarantee that all peers eventually converge to the same state. They don't guarantee anything about schema interpretation.

By making schema a code-level concern (not a data-level concern), you sidestep the whole migration problem. Every client interprets the data according to its current schema. Old data that doesn't fit? Return the default. Missing fields? Return the default.

You accept some data loss (invalid values become defaults). But you gain:
- No migration coordination
- Works offline, always
- Old and new code coexist peacefully
- Zero rename cost

For settings, preferences, and most user-generated content, this trade-off is worth it.

## The Rule

In CRDT land, internal keys are forever. Treat them like database column names in a schema you can never migrate. Pick them once, keep them stable.

Everything else can change freely: the API names, the display labels, the documentation. That's just mapping.

The data doesn't care what you call it.
