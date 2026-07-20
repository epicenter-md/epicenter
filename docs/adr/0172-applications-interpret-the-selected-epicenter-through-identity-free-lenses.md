# 0172. Applications interpret the selected Epicenter through identity-free lenses

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md) and [ADR-0158](0158-installed-apps-declare-workspace-ids-but-run-no-bun-modules.md)
- **Amends:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) by allowing simultaneous release-local interpretations of one selected Epicenter, and [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md) by replacing identity-bearing workspace definitions with identity-free Epicenter lenses. ADR-0132, ADR-0135, ADR-0160, ADR-0169, and ADR-0171 separately own KV, document, identity, row-lifetime, and mutation invariants retained or replaced from ADR-0130.
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0153](0153-trusted-apps-are-source-built-static-catalog-members.md), [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md), and [ADR-0171](0171-tables-mutate-rows-through-create-update-and-delete.md)

## Context

Applications need typed table and KV interpretations over schema-opaque durable
data. Giving a lens an ID, provider role, or storage lifecycle would make an
application release, rather than the selected owner, authoritative over data.
Requiring exact lens equality would also prevent two trusted apps from reading
the same rows through different release-local interpretations.

## Decision

Trusted applications bring identity-free, release-local Epicenter lenses. A
lens declares table and KV interpretations, validates values at the application
boundary, and preserves unknown canonical data. It does not identify, create,
own, migrate, authorize, or synchronize the Epicenter.

Several lenses may interpret the selected owner concurrently. Opening a lens
creates a typed application view over the one already selected raw owner; it
does not open another database or lifecycle:

```ts
const lens = defineEpicenter({ tables: { notes }, kv: settings });
using epicenter = await runtime.open(lens);

const note = await epicenter.tables.notes.create({ title: 'Hello' });
await epicenter.tables.notes.update(note.id, { title: 'Hello again' });
using document = await epicenter.tables.notes.document.open(note.id);

const rows = await epicenter.sql(
  `SELECT row_id, json_extract(fields_json, '$.title') AS title
   FROM rows
   WHERE table_key = ?`,
  ['notes'],
  resultSchema,
);
```

The lens and result schema remain in the calling JavaScript realm. Browser
workers, desktop hosts, servers, synchronization, artifacts, and installed-app
catalog metadata receive only schema-opaque permanent storage vocabulary.

Installed applications are trusted extensions with full authority over the
selected Epicenter. A lens is not a permission boundary. App installation and
uninstall never create or delete durable stores, and no installed-app workspace
inventory survives.

A lens also cannot mint a durable logical database identity under any noun.
There is no `defineDatabase({ id })`, database ID or `database_id` column,
named-database catalog, or per-application partition beneath the selected
owner. Renaming the refused workspace plurality to "database" does not readmit
it.

## Consequences

- Two apps can interpret the same table differently without negotiating a
  canonical schema or duplicating storage.
- Lens changes never migrate user data or enter synchronization identity.
- A trusted app can access any selected-owner data exposed by the platform. A
  product needing isolation uses another principal or deployment.
- Runtime hosts own schema-opaque operations and one lifecycle; typed views own
  no storage resources.

## Considered alternatives

- **Put an ID on each lens.** Rejected because it restores platform workspace
  identity through the type layer.
- **Register lenses with the storage owner.** Rejected because it creates lens
  equality, serialization, and lifecycle where local validation is sufficient.
- **Treat lenses as permissions.** Rejected because trusted same-origin app code
  already has the selected owner's authority.
- **Give every app a database.** Rejected because user data outlives apps and
  integrations need one shared owner.
