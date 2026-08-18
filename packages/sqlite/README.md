# `@epicenter/sqlite`

`@epicenter/sqlite` is the MIT contract for an embedded SQLite handle:
`run`, `all`, and a synchronous `transaction`, plus the value and row types
those agree on. It normalizes nothing else. It owns no application schema, no
synchronization state, and no storage lifecycle.

One adapter per runtime answers the contract:

| Entry point | Engine | Consumer |
| --- | --- | --- |
| `./bun` | `bun:sqlite` | `@epicenter/data`'s Bun store |
| `./durable-object` | a Durable Object's SQL storage | `@epicenter/server`'s replica and authority |
| `./browser` | sqlite.org's WASM build | `apps/sync-lab` |

The browser adapter is the odd one, and deliberately so. The browser store
keeps its durable facts directly in IndexedDB and loads no SQLite at all, so
nothing in `@epicenter/data` opens this adapter on its own. It exists because
the projection takes a handle from its caller rather than initializing WASM
itself, which keeps that initialization where the application can see it.

Schema and transaction invariants belong to the consuming package. The client
store lives in `@epicenter/data`; server authority storage lives in
`@epicenter/server`. An app that keeps a local copy of a provider's data owns
its own file lifecycle: see `apps/local-mail/src/db-file.ts` and
`apps/local-books/src/db-file.ts`.
