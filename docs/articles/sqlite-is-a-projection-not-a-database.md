# SQLite Is a Projection, Not the Database

Yjs is the database. SQLite is a read cache that happens to look like one.

Every write in the workspace goes through a Yjs CRDT. The Y.Doc is the source of truth: it handles conflict resolution, offline merges, and multi-device sync. SQLite doesn't participate in any of that. It sits downstream, populated by an observer that watches the Y.Doc and mirrors changes into rows and columns. If you delete the SQLite file, nothing is lost. The workspace rebuilds it from the CRDT on next open. The same way a database rebuilds a materialized view from the underlying tables.

That distinction matters because it changes what SQLite is for. It's not where you write. It's where you read.

## Yjs stores data in a format optimized for merging, not querying

Each table is a Y.Array of timestamped cell entries:

```
Y.Array("table:recordings")
  { key: "rec_abc", val: { id: "rec_abc", title: "Team standup",
    transcriptionStatus: "DONE", createdAt: "2026-03-30", _v: 1 },
    ts: 1743964800000 }
  { key: "rec_def", val: { id: "rec_def", title: "Client call",
    transcriptionStatus: "PENDING", createdAt: "2026-03-31", _v: 1 },
    ts: 1743965000000 }
  ...

The `ts` field is what makes Last-Write-Wins work. Two devices edit the same row offline; after sync, the higher timestamp wins, regardless of which update arrived first. The Y.Array grows monotonically. Entries are never deleted, just superseded by newer ones with the same key.

This is great for sync. It's terrible for queries. To find all recordings transcribed this week, you'd scan every entry, apply LWW per key to get current rows, filter by status and date, and reconstruct the result. That's O(n) over the raw CRDT data every time.

SQLite fixes this. The observer collapses the Y.Array into a normal relational table: one row per recording, one column per field, kept current as the CRDT changes. Queries that would require custom traversal logic become standard SQL.

## The layers build on each other

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 0: Yjs CRDT                                              │
│                                                                 │
│  Y.Array of { key, val, ts } entries                           │
│  Source of truth. All writes go here.                           │
│  Handles offline merges, conflict resolution, multi-device sync │
└────────────────────────────┬────────────────────────────────────┘
                             │ observer syncs on change
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Persistent mirror (auto-generated SQLite tables)      │
│                                                                 │
│  CREATE TABLE recordings (                                      │
│    id TEXT PRIMARY KEY,                                         │
│    title TEXT,                                                  │
│    transcription_status TEXT,                                   │
│    created_at INTEGER                                           │
│  );                                                             │
│                                                                 │
│  Schema derived from defineTable() definitions.                 │
│  Rebuilt from Yjs if lost. Never the source of truth.          │
└────────────────────────────┬────────────────────────────────────┘
                             │ FTS5 virtual tables + triggers
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Full-text search (FTS5)                               │
│                                                                 │
│  CREATE VIRTUAL TABLE recordings_fts USING fts5(               │
│    title, content='recordings', content_rowid='rowid'          │
│  );                                                             │
│                                                                 │
│  Triggers keep the FTS index in sync with the mirror.          │
│  Enables keyword search over text fields.                       │
└────────────────────────────┬────────────────────────────────────┘
                             │ FLOAT32 columns + DiskANN indexes
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Vector embeddings (libSQL/Turso)                      │
│                                                                 │
│  ALTER TABLE recordings ADD COLUMN embedding F32_BLOB(1536);   │
│  CREATE INDEX recordings_idx                                    │
│    ON recordings(libsql_vector_idx(embedding));                 │
│                                                                 │
│  Nearest-neighbor search over semantic embeddings.             │
│  Each layer adds one capability without touching the one below. │
└─────────────────────────────────────────────────────────────────┘
```

Each layer is optional. A CLI tool that only needs SQL queries stops at Layer 1. A search feature adds Layer 2. An AI assistant that needs semantic retrieval adds Layer 3. The Yjs layer is always there regardless.

## Any tool that speaks SQL can now read workspace data

This is the practical payoff. The workspace API is TypeScript-first. It understands Yjs, CRDT semantics, table helpers, and LWW resolution. That's fine for application code. It's not fine for a coding agent that just wants to answer a question about your recordings.

```
┌─────────────────────────────────────────────────────────────────┐
│  Coding Agent / MCP Tool                                        │
│                                                                 │
│  "Show me all recordings transcribed this week"                 │
│                                                                 │
│  Option A: TypeScript workspace API                             │
│    workspace.tables.recordings.getAllValid()                     │
│      .filter(r => r.transcriptionStatus === 'DONE'             │
│           && r.createdAt > weekAgo)                             │
│    → requires understanding Yjs, CRDT, table helpers            │
│                                                                 │
│  Option B: SQL against the materialized mirror                  │
│    SELECT * FROM recordings                                     │
│    WHERE transcription_status = 'DONE'                          │
│      AND created_at > 1743278400000                             │
│    → any agent can write this                                   │
│                                                                 │
│  Option C: Full-text search (FTS5)                              │
│    SELECT * FROM recordings_fts                                 │
│    WHERE recordings_fts MATCH 'meeting notes'                   │
│    → keyword search over text fields                            │
│                                                                 │
│  Option D: Vector similarity (libSQL/Turso)                     │
│    SELECT * FROM vector_top_k('recordings_idx',                 │
│      vector32('[0.12, 0.87, ...]'), 10)                         │
│    JOIN recordings ON recordings.rowid = id                     │
│    → nearest-neighbor over semantic embeddings                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Option A requires the agent to know the workspace API. Options B through D require only SQL. A language every coding agent, analytics tool, CLI, and MCP server already understands. The materialized SQLite layer is what makes workspace data universally queryable without coupling every consumer to the CRDT internals.

## Writes still go through Yjs

The projection is read-only by design. If an MCP tool or CLI command needs to write data, it goes through the workspace API, which writes to the Y.Doc. The observer picks up the change and updates SQLite. The flow is always:

```
write → Y.Doc → observer → SQLite
read  → SQLite (or Y.Doc directly, for simple lookups)
```

Writing directly to SQLite would bypass conflict resolution entirely. Two devices editing the same row offline would produce a split-brain state with no way to merge. Yjs exists precisely to prevent that. SQLite is downstream of it, not a peer.

## Rebuilding from scratch is the proof

The clearest way to understand the relationship: delete the SQLite file. The workspace still works. Open it, and the observer replays the entire Y.Doc into a fresh SQLite database. All your data is there. Nothing was lost because nothing was stored there in the first place. It was always in the CRDT.

That's what "projection" means. SQLite is a view over the Yjs data, materialized to disk for query performance. The CRDT is the record; SQLite is the index.
