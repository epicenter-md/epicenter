# OpenCode Switched from JSON Files to SQLite

OpenCode recently migrated all its storage from JSON files to SQLite. If you've updated and seen this message:

```
Performing one time database migration, may take a few minutes...
```

That's the one-time migration converting your existing data. It runs once, and you never see it again.

---

## Thousands of JSON Files, One Per Everything

OpenCode originally stored all its data as individual JSON files. One file per project, session, message, part, todo, permission, and share. The directory structure looked like this:

```
~/.opencode/storage/
  project/*.json
  session/*/*.json
  message/*/*.json
  part/*/*.json
  todo/*.json
  permission/*.json
  session_share/*.json
```

Every message you sent, every response you received, every todo item. Each got its own `.json` file on disk. This works fine when you're starting out. But if you've been using OpenCode for a while, you could have thousands of these files. Reading and writing thousands of small files gets slow as history grows.

They moved to SQLite (via `bun:sqlite` + Drizzle ORM) stored as a single `opencode.db` file.

---

## The Trigger Is a One-Liner

The migration logic in `index.ts` is dead simple:

```typescript
const marker = path.join(Global.Path.data, "opencode.db")
if (!(await Filesystem.exists(marker))) {
  process.stderr.write(
    "Performing one time database migration, may take a few minutes..." + EOL,
  )
  await JsonMigration.run(Database.Client().$client, { progress: ... })
  process.stderr.write("Database migration complete." + EOL)
}
```

If `opencode.db` doesn't exist yet, run the migration. After it completes, the `.db` file exists and the condition is never true again. No migration flags, no version tracking, no cleanup step. The database file itself is the marker.

---

## What the Migration Actually Does

`json-migration.ts` reads every JSON file from the old storage directory and bulk-inserts them into SQLite tables. The order matters because of foreign key dependencies:

```
Projects       → project/*.json
Sessions       → session/*/*.json  (skips orphaned sessions with no matching project)
Messages       → message/*/*.json
Parts          → part/*/*.json
Todos          → todo/*.json
Permissions    → permission/*.json
Session shares → session_share/*.json
```

The whole thing is wrapped in a single `BEGIN TRANSACTION` / `COMMIT` with aggressive SQLite PRAGMAs for speed:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
```

`journal_mode = WAL` enables write-ahead logging for concurrent reads during the import. `synchronous = OFF` tells SQLite not to wait for disk flushes. Dangerous for ongoing writes, but fine for a one-time bulk import where the source data (JSON files) still exists as a fallback. `cache_size = 10000` keeps more pages in memory, and `temp_store = MEMORY` avoids temp files entirely. Inserts happen in batches of 1,000.

---

## Why It Can Take "A Few Minutes"

The progress bar you see during migration is tracking a file-by-file scan. If you've been using OpenCode heavily, you could have thousands of JSON files. One per message part alone. The migration reads every single one, parses the JSON, and inserts it into SQLite in batches.

On a typical setup with a few hundred sessions, it finishes in seconds. Heavy users with months of history might wait a minute or two.

---

## The JSON Files Stay Behind

OpenCode doesn't delete your old JSON files after migration. They stay in `~/.opencode/storage/` untouched. This is a smart safety net: if something goes wrong with the migration, the source data is still there. You could delete them manually to reclaim disk space, but OpenCode won't touch them.

---

## Why They Migrated

**1. Performance. SQLite with WAL mode is dramatically faster**

Reading thousands of small files means thousands of filesystem syscalls. SQLite stores everything in one file and uses memory-mapped I/O with write-ahead logging. Queries that used to scan a directory of JSON files now hit an indexed database.

**2. Reliability. ACID transactions instead of hope**

JSON files can corrupt if the process crashes mid-write. You get a half-written file and lose that session's data. SQLite gives you atomic transactions: either the write completes fully or it doesn't happen at all.

**3. Queryability. Structured data instead of scattered files**

Want to find all sessions for a project? With JSON files, you scan a directory and parse each file. With SQLite, it's a single indexed query. This matters as OpenCode adds features that need to correlate data across sessions, messages, and todos.

---

## A Clean Migration Pattern

OpenCode's approach is worth noting for its simplicity. No migration framework, no version table, no rollback logic. The database file's existence is the migration flag. The old files stick around as an implicit backup. The entire migration runs in one transaction so it either fully succeeds or leaves no partial state.

For a tool that stores local data on the user's machine, this is the right level of complexity. Enterprise migration frameworks would be overkill. A single "does the new file exist?" check does the job.

---

## References

- [OpenCode GitHub Repository](https://github.com/sst/opencode)
- [OpenCode Storage Migration Source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/storage/json-migration.ts)
