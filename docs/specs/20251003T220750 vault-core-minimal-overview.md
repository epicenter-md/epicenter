# Vault Core Minimal Overview

- Date: 2025-10-03
- Updated: 2025-10-20
- Status: Draft
- Owner: Vault core maintainers

## Architecture Snapshot

- Adapters expose prefixed Drizzle schema plus:
  - versions: ordered tuple array of { tag: '0000', sql: string[] }
  - transforms: registry keyed by non-baseline tags
  - validator: Standard Schema parser for adapter payloads
  - ingestors (optional): file parsers returning validator-ready payloads
  - metadata: table and column descriptions (typed via AdapterMetadata)
- Vault orchestrator wires adapters into import, ingest, and export flows without owning IO. It performs multi-adapter import by auto-detecting adapters from file paths. See [packages/vault-core/src/core/vault.ts](packages/vault-core/src/core/vault.ts).
- Adapters remain independent; cross-adapter relationships are composed by hosts using the query interface.

## Migration Workflow (Plan A)

1. Adapter authors generate SQL locally (for example with Drizzle) and copy statements into the adapter migrations file. Example: [packages/vault-core/src/adapters/reddit/migrations/versions.ts](packages/vault-core/src/adapters/reddit/migrations/versions.ts).
2. Before touching tables, the vault runs per-adapter SQL migrations; ledger tables are managed automatically. See [packages/vault-core/src/core/migrations.ts](packages/vault-core/src/core/migrations.ts).
3. The export pipeline writes a migration metadata file alongside data files. See [packages/vault-core/src/core/import/migrationMetadata.ts](packages/vault-core/src/core/import/migrationMetadata.ts).

## Import Path (Files ➜ DB)

1. Host collects adapter files + codec (`ImportOptions`).
2. `createVault.importData`:
   - Runs migrations
   - Rehydrates dataset from codec files (skipping metadata directory)
   - Detects source tag from metadata when available
3. `runImportPipeline` selects effective versions/transforms, runs `transformAndValidate`, and accepts optional overrides for tests.
4. A **required** `dataValidator` (drizzle-arktype) morphs + validates the transformed dataset.
5. `replaceAdapterTables` truncates and inserts into each adapter table.

## Ingest Path (File ➜ DB)

1. `createVault.ingestData` picks the matching `Ingestor.matches`.
2. `Ingestor.parse` returns the payload.
3. Adapter Standard Schema `validator` is mandatory; morphs value via `runValidation`.
4. `replaceAdapterTables` writes rows (same helper as import).

## Export Path (DB ➜ Files)

1. Each adapter table is read via Drizzle.
2. Codec transforms rows (`normalize` / `denormalize`) and writes deterministic file paths using adapter conventions.
3. Migration metadata file is added to the export bundle.

## Host Responsibilities

- Supply a Drizzle DB instance (core manages migration ledger tables automatically).
- Pass adapter list to vault (`UniqueAdapterIds` enforces unique IDs).
- Provide codecs for import/export and drizzle-arktype validators for import.
- Offer UI/CLI to run adapter transforms or ingestion pipelines as needed.

## Key Entry Points

- [`packages/vault-core/src/core/vault.ts`](packages/vault-core/src/core/vault.ts)
- [`packages/vault-core/src/core/migrations.ts`](packages/vault-core/src/core/migrations.ts)
- [`packages/vault-core/src/core/import/importPipeline.ts`](packages/vault-core/src/core/import/importPipeline.ts)
- [`packages/vault-core/src/core/adapter.ts`](packages/vault-core/src/core/adapter.ts)

# This document is the minimal reference for contributors implementing adapters or host integrations going forward.

> Plan B (inline diff using Drizzle internals) remains documented in comments in [packages/vault-core/src/core/migrations.ts](packages/vault-core/src/core/migrations.ts) for future exploration.

## Import Path (multi-adapter: files to DB)

1. Host collects a bundle as a map of file paths to File objects and selects a codec. Codec determines file extension and normalize or denormalize behavior. See [packages/vault-core/src/core/codec.ts](packages/vault-core/src/core/codec.ts).
2. The vault import groups files by detected adapter ID using the path convention adapterId/tableName/pk.json. Unknown adapters are skipped.
3. For each detected adapter, the vault:
   - runs SQL migrations for that adapter
   - parses each file, enforces the codec file extension, and skips the migration metadata directory
   - denormalizes records with the codec and filters to actual table columns
   - applies the adapter versions and transforms during the import pipeline. See [packages/vault-core/src/core/import/importPipeline.ts](packages/vault-core/src/core/import/importPipeline.ts).
   - validates the transformed dataset using `drizzle-arktype` (NOT THE ADAPTER VALIDATOR)
   - replaces adapter tables atomically by truncating and inserting rows
4. When present, the migration tag is detected from the metadata file and used for transform selection.

### Edge cases and errors

- Unknown adapter in a bundle: skipped
- Unknown table for a detected adapter: error with explicit message
- Wrong codec extension: error for the specific file
- No adapter validator: error for that adapter

## Ingest Path (single file to DB)

1. The vault selects the matching ingestor based on adapter ingestors metadata.
2. The ingestor parses the file and returns a payload in the adapter expected shape.
3. The adapter Standard Schema validator morphs and validates the payload.
4. The vault replaces the adapter tables using the same helper as the import path.

## Export Path (DB to files)

1. Each adapter table is read via Drizzle from the host-supplied database.
2. The codec normalizes rows and writes deterministic file paths using adapter conventions.
3. A migration metadata file is added to the export bundle.

## Host Responsibilities

- Supply a Drizzle-compatible database; vault-core manages migration ledger tables automatically.
- Pass the adapter list into the vault; adapter IDs must be unique.
- Provide a codec for import and export; callers do not pass validators or transform overrides.
- Execute vault operations in an environment that supports DDL (for example a server runtime backed by SQLite) to allow migrations to run.
- Offer UI or CLI to trigger import, export, and ingest operations as appropriate for your app.

## Key Entry Points

- [packages/vault-core/src/core/vault.ts](packages/vault-core/src/core/vault.ts)
- [packages/vault-core/src/core/migrations.ts](packages/vault-core/src/core/migrations.ts)
- [packages/vault-core/src/core/import/importPipeline.ts](packages/vault-core/src/core/import/importPipeline.ts)
- [packages/vault-core/src/core/adapter.ts](packages/vault-core/src/core/adapter.ts)
- [packages/vault-core/src/core/import/migrationMetadata.ts](packages/vault-core/src/core/import/migrationMetadata.ts)
- [packages/vault-core/src/core/codec.ts](packages/vault-core/src/core/codec.ts)

This document is a minimal reference for contributors implementing adapters or host integrations.
