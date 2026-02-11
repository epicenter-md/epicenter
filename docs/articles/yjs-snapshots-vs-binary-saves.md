# You Probably Don't Need Yjs Snapshots

**TL;DR**: Yjs snapshots are tiny but require disabling garbage collection forever. If you just want periodic backups, save the full binary instead.

> Snapshots and binary saves serve different access patterns: history rollback vs periodic backups. Pick the one that matches your actual need.

Yjs has a `Y.Snapshot` API that lets you capture document state at any point in time. Sounds perfect for versioning, right? But there's a catch that isn't obvious until you read the fine print.

## The Hidden Requirement

Snapshots require garbage collection to be disabled:

```typescript
// Snapshots only work with gc: false
const doc = new Y.Doc({ gc: false });
```

Why? Snapshots don't store content. They store references into the document's operation history. Think of them as bookmarks into a log of every edit ever made. If garbage collection runs and cleans up that log, your bookmarks point to nothing.

This means your document grows forever. Every keystroke, every deletion, every undo—all preserved.

## What Each Approach Actually Stores

```
Snapshot                          Full Binary
────────                          ───────────
State vector: [A:47, B:23]        Current content: "Hello World"
Delete set: {...}                 (self-contained)

Size: ~100 bytes                  Size: ~varies with content
Requires: original doc + history  Requires: nothing
```

A snapshot is tiny because it's just metadata. The full binary contains all actual content but is self-contained—you can load it into any fresh `Y.Doc` without the original.

## Two Different Access Patterns

Here's where the mental model clicks: these serve fundamentally different use cases.

| Access Pattern                 | Best Tool   | Why                              |
| ------------------------------ | ----------- | -------------------------------- |
| "Restore to Tuesday's version" | Snapshots   | You need the history to exist    |
| "Back up every hour"           | Full binary | Self-contained, works with GC on |
| "Audit trail of all changes"   | Snapshots   | History IS the feature           |
| "Disaster recovery"            | Full binary | Independent of original doc      |

If you're building version history like Google Docs—where users can scrub through every previous state—snapshots make sense. The document growth is the feature, not a bug.

If you're just protecting against data loss with periodic saves, you're paying for history you'll never use.

## The Simpler Path

For periodic backups with garbage collection enabled, you can periodically save the whole binary:

```typescript
const doc = new Y.Doc(); // gc: true by default

// Your document stays small as users edit
// Tombstones get cleaned up automatically

// Periodic backup: just encode current state
const backup = Y.encodeStateAsUpdate(doc);
// Store backup wherever you want
await saveToStorage(backup);

// Later, restore from backup
const freshDoc = new Y.Doc();
Y.applyUpdate(freshDoc, backup);
// Fully restored, no history needed
```

This gives you disaster recovery without the storage overhead. You lose the ability to restore to arbitrary points in time, but you probably didn't need that anyway.

## Production Systems Just Store the Binary

[Y-Sweet](https://github.com/jamsocket/y-sweet), Jamsocket's open-source Yjs server, is a good example. Despite using the word "snapshot" in its codebase, it's not using the `Y.Snapshot` API at all. It serializes the complete document state as a binary blob and persists that to S3 or filesystem. No history, no delete sets, no GC disabled.

This is how production Yjs infrastructure tends to work. The `Y.Snapshot` API exists for version history features, but most persistence layers skip it and store the binary.

See [Y-Sweet "Snapshots" Aren't Yjs Snapshots](./y-sweet-snapshots-are-not-yjs-snapshots.md) for a deeper look at how y-sweet's persistence actually works.

## When Snapshots Are Worth It

Snapshots earn their keep when history itself is valuable:

- Collaborative editing with "see what changed" features
- Legal or compliance requirements for audit trails
- Time-travel debugging during development
- Undo systems that need to go back arbitrarily far

For these cases, accept that your documents will grow and plan your storage accordingly. The tradeoff is intentional.

## The Hybrid Approach

You can combine both: run with GC enabled for small documents, but periodically create "epoch" checkpoints:

```typescript
// Every week: compact + store as new baseline
const compacted = Y.encodeStateAsUpdate(doc);
await saveEpochBaseline(compacted);

// Between epochs: store incremental updates
// For restore: load baseline + replay updates
```

This bounds growth while preserving some history. More complex to implement, but might be the right tradeoff for large-scale systems.

## Summary

| If you need...        | Use...                             | Accept that...                 |
| --------------------- | ---------------------------------- | ------------------------------ |
| Point-in-time restore | Snapshots + `gc: false`            | Documents grow forever         |
| Periodic backups      | `encodeStateAsUpdate` + `gc: true` | No version history             |
| Both                  | Epoch compaction                   | More implementation complexity |

Most apps don't need version history. If yours doesn't, skip snapshots entirely. Save the binary, keep GC on, and move on.

## Related

- [Y-Sweet "Snapshots" Aren't Yjs Snapshots](./y-sweet-snapshots-are-not-yjs-snapshots.md): Deep dive into how y-sweet actually persists documents
- [YKeyValue: The Most Interesting Meta Data Structure in Yjs](./ykeyvalue-meta-data-structure.md): Another case where epoch-based compaction strips history
- [Learn Yjs](https://learn.yjs.dev/): Interactive tutorials from Jamsocket
