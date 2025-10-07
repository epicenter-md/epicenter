---

# vault-core

> This represents a very early, proof-of-concept version of Vault Core. The API, features, architecture, applications, and more are all subject to significant change.
> Take this as a sneak-peek into ongoing work, not a stable library.

A small, adapter-driven data vault. Each adapter owns its schema, validation, migrations, and ingest rules; the vault orchestrates import, export, and ingest, without coupling adapters together. Apps compose multiple adapters at runtime to build cross-adapter UX.

Highlights

- Independent adapters: schemas are table-prefixed and migration-scoped per adapter
- Deterministic import/export shapes with codec-normalized files
- Per-adapter validation (Standard Schema; arktype-backed) enforced at import/ingest
- Migrations applied automatically before writes
- Multi-adapter import: one call processes a mixed bundle by auto-detecting adapters from file paths
- Runtime traversal: get a Drizzle-compatible db and adapter tables map for app-layer joins

Quick links

- Vault constructor: [`createVault()`](packages/vault-core/src/core/vault.ts:31)
- Import (multi-adapter): [`importData()`](packages/vault-core/src/core/vault.ts:176)
- Export: [`exportData()`](packages/vault-core/src/core/vault.ts:116)
- Ingest (adapter-owned parsers): [`ingestData()`](packages/vault-core/src/core/vault.ts:284)
- Runtime traversal: [`getQueryInterface()`](packages/vault-core/src/core/vault.ts:317)
- Adapter definition: [`defineAdapter`](packages/vault-core/src/core/adapter.ts:137)

## Core concepts

Adapters

- An adapter bundles:
  - Drizzle schema with table names prefixed by adapter id (e.g., `example_notes_items`)
  - Versions and transforms for migrations
  - A Standard Schema validator (arktype-backed) for parsed dataset shapes
  - Optional ingestors for raw file formats
- Table prefixing and primary keys are compile-time checked; see [`core/adapter.ts`](packages/vault-core/src/core/adapter.ts:86).
- Adapters remain independent; the vault never couples their storage.

Validation

- During import and ingest, the vault runs a Standard Schema validator:
  - Import uses the adapter’s validator to validate the parsed dataset before table replacement
  - Ingest uses the adapter’s validator on the ingestor output
- Failed validation aborts the operation with detailed path messages; see error formatting in [`runValidation`](packages/vault-core/src/core/vault.ts:44).

Migrations

- Before touching an adapter’s tables, the vault ensures its SQL migrations are applied via [`runStartupSqlMigrations`](packages/vault-core/src/core/vault.ts:37).
- The export flow writes a per-adapter migration metadata file; import detects this metadata and records its tag.

Codecs and format

- A codec defines parse/stringify and normalization/denormalization rules; JSON is the default via [`jsonFormat`](packages/vault-core/src/codecs/json.ts:3).
- Paths follow a deterministic convention (adapterId/tableName/pk.json) computed with the default convention used by export.

Compatible DB

- The vault expects a Drizzle-compatible, SQLite-compatible DB. Use a server environment for DDL-backed features. Tests may make use of `bun:sqlite` in-memory DB.

## API overview

Construct

- Create a vault bound to a DB instance and a set of adapters:
  - [`createVault(options)`](packages/vault-core/src/core/vault.ts:31) where options include `database` (Drizzle-compatible) and `adapters` (array of adapter instances).

Export

- Export adapter data to a codec-normalized file bundle:
  - [`exportData({ codec })`](packages/vault-core/src/core/vault.ts:116) returns `Map<string, File>`: `{ path -> File }`.
  - Exports all registered adapters by default; per-adapter migration metadata is included.

Import (multi-adapter)

- Import a mixed bundle of files; the vault auto-detects adapters based on path and processes each adapter independently:
  - [`importData({ files, codec })`](packages/vault-core/src/core/vault.ts:176)
    - `files`: Map of `path -> File` where path segments encode `adapterId/tableName/...`
    - `codec`: the codec used for decode/denormalize (e.g., `jsonFormat`)
  - For each detected adapter:
    - Ensure migrations
    - Parse files into a dataset keyed by de-prefixed table names
    - Run the import pipeline (versions/transforms)
    - Validate using the adapter’s Standard Schema validator
    - Replace the adapter’s tables atomically

Ingest

- Run adapter-owned parsers on raw files:
  - [`ingestData({ adapter, file })`](packages/vault-core/src/core/vault.ts:284)
  - The vault selects the first ingestor that matches and validates the parsed dataset before replacement.

Runtime traversal

- Query at runtime and compose cross-adapter views in the app:
  - [`getQueryInterface()`](packages/vault-core/src/core/vault.ts:317) returns `{ db, tables }`
    - `db`: Drizzle-compatible DB
    - `tables`: map of `adapterId -> adapter.schema`, suitable for joins

## Import/export formats

Exported paths

- Paths follow `adapterId/tableName/pk.json`, for example:
  - `reddit/reddit_posts/t3_abc123.json`
  - `entity_index/entity_index_entities/entity:subreddit:sveltejs.json`

Record content

- JSON records include only table columns (normalized by codec). Primary key values are encoded in the path, not the JSON body.

Import bundle rules

- A single bundle can contain files for multiple adapters; `importData` will:
  - Skip unknown adapter paths
  - Throw on wrong file extensions
  - Throw on unknown tables in a known adapter
  - Replace tables for each adapter it successfully processes

## Adapter authoring

Minimal shape (TypeScript)

- Use [`defineAdapter`](packages/vault-core/src/core/adapter.ts:137) to declare:
  - `id` (string), `schema` (prefixed Drizzle tables), `versions`, `transforms`,
  - Optionally `metadata` for documentation/UI
  - Optionally `ingestors` for external inputs
    - A Standard Schema `validator` for ingest data
- Prefixing: table names must begin with `adapterId_` (enforced at types); e.g., `example_notes_items`

Validation shape

- The parsed dataset shape is a de-prefixed object keyed by table names:
  - Example: `{ items: Array<Row>, note_links?: Array<Row> }`
- Standard Schema (arktype) validators should accept this parsed shape and return the same shape; the vault serializes/denormalizes for storage as needed.

## Server-backed ingestion

Migrations require DDL, so run vault operations server-side with a DB like Bun SQLite + Drizzle:

- For a reference implementation, see:
  - Vault service singleton: [`apps/vault-demo/src/lib/server/vaultService.ts`](apps/vault-demo/src/lib/server/vaultService.ts
  - Endpoints (SvelteKit +server.ts):
    - Ingest: [`apps/vault-demo/src/routes/api/vault/ingest/+server.ts`](apps/vault-demo/src/routes/api/vault/ingest/+server.ts
    - Import (multi-adapter): [`apps/vault-demo/src/routes/api/vault/import/+server.ts`](apps/vault-demo/src/routes/api/vault/import/+server.ts
    - Export: [`apps/vault-demo/src/routes/api/vault/export/+server.ts`](apps/vault-demo/src/routes/api/vault/export/+server.ts
    - Counts: [`apps/vault-demo/src/routes/api/vault/tables/+server.ts`](apps/vault-demo/src/routes/api/vault/tables/+server.ts

## Demo app

A minimal SvelteKit demo shows:

- Import/export page calling `importData`/`exportData` via server endpoints:
  - [`apps/vault-demo/src/routes/import-export/+page.svelte`](apps/vault-demo/src/routes/import-export/+page.svelte:1)
- Reddit GDPR ingest + entity suggestions → user-curated Entity Index import
  - [`apps/vault-demo/src/routes/reddit-upload/+page.svelte`](apps/vault-demo/src/routes/reddit-upload/+page.svelte:1)
  - Heuristics for subreddits, users, domains:
    - [`apps/vault-demo/src/lib/extract/redditEntities.ts`](apps/vault-demo/src/lib/extract/redditEntities.ts
- Runtime cross-adapter UI (Dashboard, Entities, Notes) using `getQueryInterface()`

## Notes on the new multi-adapter import

- One-call, multi-adapter import is now the default
- Import replaces (not merges) the target adapter’s tables
- Unknown adapters and migration metadata files are skipped
- Strict validation is enforced per adapter; failed validation aborts that adapter’s import

## Limitations and tips

- Ensure your DB supports DDL; client-only mocks are not compatible with migrations
- The vault’s path convention is authoritative for identifying adapters/tables during import
- Use the adapter’s Standard Schema validator for dataset shapes; do not rely on caller-provided validators
