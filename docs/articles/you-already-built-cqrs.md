# Epicenter Is CQRS Without the Ceremony

Every write in Epicenter goes through Yjs. Every read comes from SQLite. That's CQRS (Command Query Responsibility Segregation), and it fell out of the architecture without anyone planning it.

In practice it's two lines: `workspace.tables.posts.set()` writes to a Y.Doc; `SELECT * FROM posts` reads from SQLite.

```
workspace.tables.posts.set()  ──→  Y.Doc (CRDT)    ← command side (writes)
                                        │
                                        │ materializer observes changes
                                        ▼
UI queries                  ←──  SQLite tables      ← query side (reads)
```

## The write side: Yjs

When you call `workspace.tables.posts.set({ id: '1', title: 'Hello', _v: 1 })`, the workspace API writes to a Y.Array inside the Y.Doc. No SQL. No row insertion. The CRDT is the record.

The workspace understands CRDT semantics. Last-Write-Wins resolution, offline merges, multi-device sync. None of that knowledge leaks into the read side.

## The read side: SQLite via the materializer

The materializer attaches to the workspace and calls `table.observe()` on each defined table. When the Y.Doc changes, the observer fires and syncs the delta into a SQLite row.

The schema is derived automatically from your `defineTable()` definitions. You don't write migrations for the read model. If you delete the SQLite file, the workspace rebuilds it from the CRDT on next open. Nothing is lost because nothing was stored there in the first place.

The full flow for a single write:

```
workspace.tables.posts.set()
  → Y.Doc mutates
  → materializer observer fires
  → SQLite row inserted or updated
  → UI queries SQLite
```

## The read side extends naturally

Because the write path and read path are separate, you can add new read models without touching writes at all.

FTS5 is already a second read model. The materializer creates a virtual FTS5 table on top of the SQLite mirror and keeps it in sync with triggers. Keyword search is just `SELECT * FROM posts_fts WHERE posts_fts MATCH 'hello'`. Yjs never knows it happened.

Vector embeddings could be a third. Add a `FLOAT32` column to the SQLite mirror, populate it from an embedding model, index it with DiskANN. Same CRDT source, another query shape. The companion article [SQLite Is a Projection, Not the Database](./sqlite-is-a-projection-not-a-database.md) shows all three layers in detail.

The materializer is the seam between the two sides. It's the only place that knows about both.

## The tradeoff is eventual consistency

Writes land in the Y.Doc first. SQLite catches up asynchronously. For workspace data. Notes, recordings, tabs. That lag is imperceptible and the tradeoff is worth it. You get offline support, multi-device sync, and conflict resolution without any extra work.

For transactional data, it's the wrong model. Billing, permissions, anything where you need to read your own write immediately. Those belong in a server-side database with synchronous reads.

## Naming it doesn't change the code

The workspace was already working before anyone called it CQRS. But naming it tells you what you can do next: add a read model, swap the query layer, reason about each side independently. The write side is a Y.Doc. The read side is SQLite. The materializer connects them.
