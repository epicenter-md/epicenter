# Vault Demo (SvelteKit)

Overview

- The demo shows how independent adapters can be composed into one runtime Vault:
  - Import/Export of adapter data
  - Reddit GDPR upload with entity suggestions → user-curated Entity Index import
  - Notes creation with entity linking
  - Cross-adapter views: Dashboard, Entities, Notes
- Adapters are independent; the app composes them through runtime joins exposed by [getQueryInterface()](packages/vault-core/src/core/vault.ts:317).

Quick start (Bun)

- Prerequisite: Bun installed.
- From repo root:

  ```
  bun install
  bun run dev -w apps/vault-demo
  ```

- Open http://localhost:5173
- Note: The demo uses an in-memory DB with a vault singleton at [apps/vault-demo/src/lib/vault/singleton.ts](apps/vault-demo/src/lib/vault/singleton.ts) so data persists across routes during a single browser session.

Key flows

- Import/Export
  - Visit /import-export
  - Import: select a folder or multiple files exported by Vault and choose the adapter; the page calls [importData()](packages/vault-core/src/core/vault.ts:176) using [jsonFormat](packages/vault-core/src/codecs/json.ts:3).
  - Export: click Export to get a list of files; download per file. The page uses [exportData()](packages/vault-core/src/core/vault.ts:116).

- Reddit GDPR upload + suggestions → Entity Index import
  - Visit /reddit-upload
  - Ingest a Reddit file via [ingestData()](packages/vault-core/src/core/vault.ts:284) with [redditAdapter()](packages/vault-core/src/adapters/reddit/src/adapter.ts:12).
  - Click “Suggest entities” to scan imported rows using [apps/vault-demo/src/lib/extract/redditEntities.ts](apps/vault-demo/src/lib/extract/redditEntities.ts:1) with heuristics: subreddits r/..., users u/..., URL domains.
  - Select entities and import into Entity Index via [importData()](packages/vault-core/src/core/vault.ts:176) using [entityIndexAdapter()](packages/vault-core/src/adapters/entity-index/src/adapter.ts:89) validator.

- Notes creation + entity linking
  - Visit /notes/new
  - Create a note with title, body, and pick entities to link; the page writes to Example Notes through [importData()](packages/vault-core/src/core/vault.ts:176) using [exampleNotesAdapter()](packages/vault-core/src/adapters/example-notes/src/adapter.ts:147).
  - Visit /entities and click an entity; the detail shows occurrences and “Linked Notes”, parsed from the Notes adapter’s entity_links JSON column (see [packages/vault-core/src/adapters/example-notes/src/adapter.ts](packages/vault-core/src/adapters/example-notes/src/adapter.ts:1)).

- Dashboard
  - Visit /dashboard to see per-adapter table row counts aggregated at runtime via [getQueryInterface()](packages/vault-core/src/core/vault.ts:317).

Architecture notes

- Vault wiring is centralized in [apps/vault-demo/src/lib/vault/client.ts](apps/vault-demo/src/lib/vault/client.ts:1) using [createVault()](packages/vault-core/src/core/vault.ts:31).
- The demo uses an in-memory MockDrizzle at [apps/vault-demo/src/lib/vault/mockDrizzle.ts](apps/vault-demo/src/lib/vault/mockDrizzle.ts:1).
- Adapters
  - Reddit: [packages/vault-core/src/adapters/reddit/src/adapter.ts](packages/vault-core/src/adapters/reddit/src/adapter.ts:1)
  - Entity Index: [packages/vault-core/src/adapters/entity-index/src/adapter.ts](packages/vault-core/src/adapters/entity-index/src/adapter.ts:1)
  - Example Notes: [packages/vault-core/src/adapters/example-notes/src/adapter.ts](packages/vault-core/src/adapters/example-notes/src/adapter.ts:1)

Data model highlights

- Entity Index stores canonical entities and occurrences; they are user-curated in this demo, not auto-derived.
- Example Notes stores notes with entity_links as a TEXT JSON array; validators (arktype) accept string[] and serialize to DB-ready JSON.
- All export/import uses [jsonFormat](packages/vault-core/src/codecs/json.ts:3).

Limitations

- No persistence beyond a browser session; refresh clears data.
- Export is per-file downloads; no archive bundling.
- The Reddit heuristic extractor is intentionally simple.

Test references

- [packages/vault-core/tests/fixtures/entity-index-fixture.ts](packages/vault-core/tests/fixtures/entity-index-fixture.ts:1)
- [packages/vault-core/tests/example-notes.spec.ts](packages/vault-core/tests/example-notes.spec.ts:1)
- [packages/vault-core/tests/entity-index.spec.ts](packages/vault-core/tests/entity-index.spec.ts:1)
