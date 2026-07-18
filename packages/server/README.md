# `@epicenter/server`

`@epicenter/server` is the AGPL server engine shared by the hosted and
self-hosted deployments. It owns the durable workspace authority: scalar
first-push registration, pull, acquisition, compaction, and the complete server-side
SQLite transaction domain.

Portable scalar wire parsing and field folding live in MIT
`@epicenter/row-sync`. Embedded SQLite API normalization lives in MIT
`@epicenter/sqlite`. Neither package owns server schema or authority lifecycle.

The current scalar authority implementation is in
`src/workspace-authority/authority.ts`. Runtime-specific Bun and Durable Object
owners open that same implementation through `src/records/`.
