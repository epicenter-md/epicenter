# 0160. Applications bind typed data definitions without an application namespace

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), and [ADR-0158](0158-installed-apps-declare-workspace-ids-but-run-no-bun-modules.md)

## Context

Workspace and Database are not user-visible lifecycle boundaries. Keeping either
identifier beneath Epicenter would force catalogs, prefixes, per-database
lifecycle, route parameters, and migration machinery without changing what a
person experiences: their applications read and write one shared body of data.
Applications still need typed interpretations of that data, and independently
authored definitions need stable collision-resistant keys.

## Decision

Applications define tables and singleton values, then bind any convenient group
of those definitions to an open `Epicenter`. The group has no durable identity,
completeness claim, lifecycle, or runtime owner:

```ts
export const recordings = defineTable({
  key: "so.epicenter.whispering.recordings",
  fields: {
    createdAt: field.instant(),
    transcript: field.string(),
    note: optional(field.string()),
  },
});

export const language = defineValue({
  key: "so.epicenter.whispering.transcription.language",
  value: field.string(),
});

const whispering = epicenter.bind({
  tables: { recordings },
  values: { language },
});

await whispering.tables.recordings.create({
  createdAt: Temporal.Now.instant(),
  transcript: "Hello",
});
await whispering.values.language.set("en");
```

There is no `defineWorkspace`, `defineDatabase`, `defineDatabaseModel`,
`DatabaseId`, application-owned storage prefix, or automatic key prefixing.
`bind` is a synchronous borrowed typed lens. It creates no storage and only the
`Epicenter` owns disposal.

Every table and value definition carries one globally qualified durable key.
Applications share data by importing the same canonical definition. They
compose by binding definitions from any number of modules in one object. A
release-local object property such as `recordings` is only an ergonomic TypeScript
name; the definition's qualified key is the durable identity.

Table rows have runtime-minted globally unique IDs that callers cannot replace
or reuse. A table may expose one latent row-owned document for every live row;
the document has no independent public ID or lifetime. Deleting the row revokes
open handles and deletes its document state.

Values are singleton values, not a second database. They use the same qualified
key space and synchronization law as rows, with `get`, `set`, and `unset` as
their public surface. Their private representation is not public API.

Definitions validate release-local reads and writes. They do not enumerate a
complete schema, migrate stored data, grant access, create indexes, or rewrite
nonconforming data. Typed local queries may compile to private SQLite, but the
definition never becomes SQL DDL.

## Consequences

- Applications can share one table directly without sharing an application or
  database namespace.
- Repeating the publisher prefix in durable keys is intentional. Refusing a
  prefix helper avoids a second namespace object and makes every definition's
  identity visible where it is declared.
- Renaming a durable key is a new data identity. With the zero-legacy-data
  premise, no alias or migration API is retained.
- A definition group is ordinary composition data. It does not earn a public
  `Model`, `Definition`, `Schema`, or `Database` noun.

## Considered alternatives

- **Application or database IDs that prefix relative keys.** Rejected because
  the prefix becomes another durable owner and makes cross-application
  composition depend on hidden rewriting.
- **`defineDatabase` returning a model or definition.** Rejected because there
  is no database lifecycle or identity left for the function to define.
- **A bare string table name.** Rejected because globally shared storage needs a
  collision-resistant durable key even when applications have no identity.

