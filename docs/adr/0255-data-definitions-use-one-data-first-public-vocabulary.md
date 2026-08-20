# 0255. Data definitions and opened application data use one data-first public vocabulary

- **Status:** Accepted
- **Date:** 2026-08-20
- **Amends:** [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) at the public noun and package boundary; [ADR-0241](0241-a-store-is-truth-plus-debts-and-sql-is-a-composed-follower.md) at the opened handle and SQL follower names; [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md) at the declaration representation and parser names.
## Context

The store and its declaration have crossed several historical package and noun
boundaries: lens, workspace, database, and data. The current implementation
still exposes the database-named declaration package even though the runtime
package already owns the application data and its composed SQL follower. The
next declaration representation also needs to distinguish an inert definition
from the opened data that operates on it.

## Decision

`@epicenter/data` is the sole public package namespace for this system. The
inert declaration surface is `@epicenter/data/definition`, where
`defineData`, `DataDefinition`, and `parseData` are canonical. An opened
application-facing handle is named `data`, and its live surface is `data.kv`,
`data.tables`, `data.documents`, and `data.transact`. A composed SQL follower is
named `sql`; `db` and `database` remain available only for physical SQL or
storage handles.

Every definition has a `kv` namespace, using `kv: {}` when the application has
no scalar settings. An opened `data` exposes the immutable canonical
declaration as `data.definition`. `data` owns the physical capability at
`data.store`; it is not a second independently opened resource. Applications
therefore use `await using data` for the lifecycle, while integrations use
`data.store` for pressure, persistence, sync, and commit observation.

SQL follows the opened data and reads its definition from `data.definition`:
`createSqliteProjection({ data, sqlite })`. The projection does not accept a
second definition argument that could disagree with the opened data.

This is a clean break. The public surface does not retain aliases or fallback
parsers for `defineDatabase`, `parseDatabase`, `@epicenter/database`,
`DatabaseJson`, `DatabaseView`, or `fromDatabase`.

The data definition uses closed JSON field descriptors. Data-specific
nullability wraps an existing descriptor as `anyOf: [descriptor, { type:
`'null'` }]`; the generic field package remains unaware of this substrate
policy. Data definitions reject JSON Schema `default` annotations because
initialization and recovery belong to the application.

## Consequences

- Authored definitions and serialized definitions share one representation and
  parse through one runtime boundary.
- Missing fields remain nonconforming even when a field accepts JSON `null`.
- `undefined` has no storage representation, and writes validate storage JSON
  without enforcing the current declaration.
- Applications compose initialization and recovery values around `get()`'s
  `Result`; the declaration no longer owns defaults.
- Consumers must migrate in the same clean break. The repository does not carry
  a compatibility package, alias, or ArkType-string parser for old declarations.
