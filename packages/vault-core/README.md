# Vault Core

Vault Core provides the primitives and runtime to parse, validate, persist, and sync third‑party exports into a Git‑friendly plaintext vault. It’s the foundation for Epicenter’s adapter ecosystem.

> Status: Alpha. APIs may change before 1.0.

## Architecture at a glance

- Importers: end‑to‑end units that parse a source blob, validate with ArkType, and upsert into a Drizzle database.
- Adapters: carry the Drizzle schema and migrations config, plus optional human‑readable metadata for tables/columns.
- VaultService: the orchestrator that runs migrations, imports blobs, and syncs data to/from a filesystem using a single injected codec and a convention profile.
- Conventions & Codec: conventions control file layout (paths, dataset keys); a single Markdown codec serializes/parses records deterministically.
- SyncEngine: a VCS‑focused abstraction (Git implementation provided) that offers a FileStore for read/write/list and simple pull/commit/push.

This separation keeps Importers/Adapters pure (schema + parsing + upsert) and pushes all DB/filesystem glue and VCS specifics into the service layer.

## Key concepts

- Adapter
  - Drizzle schema (tables) and migrations config (`drizzleConfig`).
  - Optional metadata for human‑readable names/descriptions.

- Importer
  - `id`, `name`, `adapter`, `metadata` (optional), `validator` (ArkType), `parse(blob)`, `upsert(db, data)`.
  - Owns the source‑specific parsing and validation; calls into the Adapter’s schema when upserting.

- VaultService
  - Owns the database and the set of Importers.
  - Runs migrations for installed Importers.
  - Import/export flows:
    - `importBlob(blob, importerId)` → parse/validate/upsert into DB.
    - `export(importerId, store)` → DB → files using the configured codec (e.g., Markdown).
    - `import(importerId, store)` → files → DB using the configured codec (handles null/undefined normalization and light type coercions).
  - Optional Git helpers when a SyncEngine is provided: `gitPull()`, `gitCommit(msg)`, `gitPush()`.
  - Accepts a single `codec` and a `conventions` profile to control layout and serialization.

- Conventions & Codec
  - ConventionProfile: provides `pathFor(adapterId, tableName, pkValues)` and `datasetKeyFor(adapterId, tableName)`.
  - Markdown codec: YAML frontmatter + body. Deterministic, quotes numeric‑like strings to avoid accidental type shifts on re‑import. Also provides optional value normalization hooks.
  - Conventions:
    - Omit nulls on export; on import, `VaultService` normalizes `null → undefined` and applies light primitive coercions for common text fields.
    - Paths are derived from sorted primary‑key values to minimize churn.

- SyncEngine
  - Interface: `getStore()`, `pull()`, `commit(message)`, `push()`.
  - `GitSyncEngine`: shells out to `git` and exposes a FileStore rooted at the repo.
  - `LocalFileStore`: read/write/list operations used by both the service and sync engines.

## Typical flows

1. Blob → DB (Importer‑only)

- Call `VaultService.importBlob(blob, importerId)` to parse, validate (ArkType), and upsert using the Importer.

2. DB → Filesystem (Export)

- Call `VaultService.export(importerId, store)`; the service writes deterministic files using the configured codec under `vault/<importerId>/<table>/...` (e.g., `.md` for Markdown).

3. Filesystem → DB (Import)

- Call `VaultService.import(importerId, store)`; values are parsed/denormalized via the configured codec, nulls are dropped, and common primitive coercions are applied. ArkType validation is not run for filesystem imports (only for first‑ingest via `importBlob`).

## DB ↔ FS version compatibility

Vault files (via the Sync Engine) reflect a point-in-time schema. Importing them into a DB with a different schema can fail or silently coerce data. Version awareness lets us reproducibly rebuild state, minimize surprises, and keep migrations the single source of truth for structural changes.

Behavior matrix (per Importer)

| DB State        | Sync Engine version        | Behavior                                                                                                              | Outcome                                                                   |
|-----------------|----------------------------|-----------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| Matches head    | N/A                        | No-op                                                                                                                 | Success (no change)                                                       |
| Older than head | N/A                        | Existing data in database will be migrated                                                                            | Success                                                                   |
| Newer than head | N/A                        | Plan not found in journal → throw                                                                                     | Error (requires updating adapter)                                         |
| Any             | Matches head               | Import directly with `import()` (no validator), then optionally `migrateFunc` (no-ops)                                | Success                                                                   |
| Any             | Older than head            | Use `migrateImportMigrate(targetTag)`: drop importer tables → apply SQL up to target → import → `migrateFunc` to head | Success if migrations are forward-only and include needed data transforms |
| Any             | Newer than head            | Plan not found in journal → throw                                                                                     | Error (requires updating adapter)                                         |
| Any             | Tag not present in journal | Cannot compute plan → throw                                                                                           | Error                                                                     |
| Any             | No FS version available    | Require explicit `targetTag` (CLI flag or manifest)                                                                   | Error until specified                                                     |

Notes

- `migrateImportMigrate(importerId, store, { targetTag })` orchestrates the safe path when FS is at an older schema: it drops only the importer’s tables, applies SQL to reach the FS version, imports without ArkType, then migrates forward to head.
- Exports do not consult FS; the DB is the source of truth and defines the serialized shape.
- Data transforms belong in migrations when schema changes are not shape‑compatible. Without them, forward migration after import can fail.

<!-- 4. Git sync (optional)

- If a `SyncEngine` is provided, you can `gitPull()`, `gitCommit(msg)`, and `gitPush()` around export/import operations to keep the vault in version control. -->

## Minimal wiring example (service)

Pseudocode for a Node environment using LibSQL, Git sync, a single Markdown codec, and default conventions:

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { VaultService, markdownFormat, defaultConvention, GitSyncEngine } from "@repo/vault-core";

// importers: an array of Importer instances (each has id, parse, validator, upsert, adapter)
const importers = [redditImporter /*, ...*/];

const client = createClient({ url: "file:/abs/path/to.db" });
const db = drizzle(client);

const svc = await VaultService.create({
  importers,
  database: db,
  migrateFunc: migrate,
  syncEngine: new GitSyncEngine(process.cwd()),
  codec: markdownFormat,
  conventions: defaultConvention(),
});

// Import an export ZIP
await svc.importBlob(
  new Blob(
    [
      /* bytes */
    ],
    { type: "application/zip" }
  ),
  "reddit"
);

// Export to files, commit, and push
const store = await svc.gitPull().then(() => svc["syncEngine"]!.getStore());
await svc.export("reddit", store);
await svc.gitCommit("Export vault");
await svc.gitPush();
```

Notes

- You can also use `VaultService`.
- The demo CLI in `apps/demo-mcp` shows how to stand up a tiny importer‑driven pipeline with LibSQL.

## Merge‑friendly plaintext by design

- Deterministic serialization (stable key order, consistent newlines).
- YAML frontmatter quotes numeric‑like strings to avoid accidental number/boolean/null coercion on re‑import.
- File paths built from sorted primary keys; nulls omitted to reduce diff noise.
- Import normalization handles `null → undefined` and light primitive coercions for common text fields.

## Roadmap / open questions

- Potential future codecs (YAML, TOML, MDX) and richer frontmatter support.
- More sync engines (e.g., cloud/object storage backends).
- Declarative, column‑aware coercion/normalization derived from Drizzle types.
- Formal import/export test suites per Importer.
