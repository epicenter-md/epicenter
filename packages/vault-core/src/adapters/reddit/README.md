# Reddit Adapter

This serves as a test-bench for our first integration test for Epicenter's adapter system.

> Once the spec is determined and implemented, this documentation will be replaced with an official README.

## Implementation Details

This takes in a GDPR-compliant export, available only from the [Reddit website](https://www.reddit.com/settings/data-request).

> As of writing, Reddit only allows you to export data once every ~30 days(?). Please be cognizant of this when testing the adapter.

The zip file is processed directly in-memory, and the contained CSV files are then parsed and validated against a schema.

### Dev

To migrate:

- `cd` project directory
- `bun run migrate`

## Migrations (Plan A)

This adapter ships two kinds of migrations:

1. SQL schema migrations (forward-only; embedded inline)

- Embedded directly in ./migrations/manifest.ts via redditVersions using "sql" (string[]) or "sqlText" (string)
- No node:fs required; core will split "sqlText" on drizzle "--&gt; statement-breakpoint" markers or on semicolons as a fallback
- Note: legacy .sql files may exist in ./migrations/ for reference, but the manifest's inline SQL is the source of truth

2. JS data transforms (version-to-version)

- Location: ./migrations/transforms.ts
- A TransformRegistry keyed by the target tag; each function converts data from the previous version into the current target version
- Typed with defineTransformRegistry and RequiredTransformTags so every forward step is covered

How hosts run this (no node: imports required in core):

- Startup SQL migrations (schema)
  - Call `runStartupSqlMigrations(adapter.id, adapter.versions, db, reporter)` from `@repo/vault-core`
  - Pass the same Drizzle DB that Vault uses; core ensures the ledger tables exist and replays the embedded SQL

- Data transforms + validation (content)
  - Use transformAndValidate(manifest, transforms, dataset, sourceTag, validator?)
  - transforms is the TransformRegistry that converts dataset from sourceTag up to manifest.currentTag
  - validator is optional; when provided, it should return the morphed value or throw on failure (see redditDataValidator)

Quick reference

- Manifest: ./migrations/manifest.ts
- Transforms: ./migrations/transforms.ts
- SQL artifacts: ./migrations/\*.sql
