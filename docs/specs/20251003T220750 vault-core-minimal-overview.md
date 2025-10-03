# Vault Core Minimal Overview

- Date: 2025-10-03
- Status: Draft
- Owner: Vault core maintainers

## Architecture Snapshot

- **Adapters** expose prefixed Drizzle schema plus:
  - `versions`: ordered tuple of `{ tag: '0000', sql: string[] }`
  - `transforms`: registry keyed by non-baseline tags
  - `validator`: Standard Schema parser for ingest payloads
  - `ingestors` (optional): file parsers returning validator-ready payloads
  - `metadata`: table/column descriptions (typed via `AdapterMetadata`)
- **Vault** orchestrator (see `packages/vault-core/src/core/vault.ts`) wires adapters into import, ingest, and export flows without owning IO.

## Migration Workflow (Plan A)

1. Adapter author runs `drizzle-kit` locally, copies SQL into `versions[n].sql`.
2. `createVault` calls `runStartupSqlMigrations(adapter.id, adapter.versions, db)` before touching tables; SQL arrays replay sequentially and ledger tables are managed automatically.
3. Export pipeline writes `__meta__/migration.json` via `createMigrationMetadataFile`.

> Plan B (inline diff using Drizzle internals) is commented out but preserved inside `migrations.ts` for future reference.

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

This document is the minimal reference for contributors implementing adapters or host integrations going forward.
