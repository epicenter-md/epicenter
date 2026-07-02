---
name: turso
description: Turso and libSQL patterns for embedded SQLite-compatible databases, serverless drivers, sync engines, partial sync, WAL/MVCC behavior, compatibility gaps, CLI usage, and Drizzle integration boundaries. Use when mentioning Turso, libSQL, @libsql/client, remote SQLite, embedded replicas, or local database sync.
metadata:
  author: epicenter
  version: '1.0'
---

# Turso And libSQL

## Upstream Grounding

Grounding repos: `tursodatabase/turso` for sync, embedded replicas, partial sync, and libSQL driver behavior; `drizzle-team/drizzle-orm` for the libSQL adapter.

Use the `drizzle-orm` skill for schema and query builder decisions.

## Driver Boundaries

- Treat Turso/libSQL as SQLite-compatible, not identical to every local SQLite deployment.
- Serverless client usage has network and auth behavior. Keep it behind the runtime boundary that owns secrets.
- Embedded replicas and sync engines have lifecycle and consistency behavior. Document when data is local, when it syncs, and which writes are accepted.
- Do not assume normal multi-process SQLite behavior when using embedded or remote libSQL modes.

## Sync And Compatibility Checks

- Decide whether the feature needs remote writes, local reads, offline reads, or bidirectional sync before choosing the driver mode.
- For partial sync, define the subset boundary explicitly and test that queries do not silently depend on unsynced rows.
- Check current SQLite compatibility before using newer SQLite features, virtual tables, extensions, triggers, or pragma behavior.
- WAL, MVCC, and concurrency details are part of the database contract. Do not hide them behind generic "SQLite" language when they affect correctness.

## Operational Rules

- Keep Turso CLI commands in docs or scripts, not scattered through app code.
- Integration tests should cover auth failure, network failure, sync lag, duplicate writes, and migration compatibility.
- When Drizzle is the ORM, keep the schema and migrations in Drizzle, but put Turso connection, sync, and deployment constraints in this skill's mental model.
