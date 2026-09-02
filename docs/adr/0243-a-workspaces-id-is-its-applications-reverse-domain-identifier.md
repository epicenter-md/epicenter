# 0243. A workspace's id is its application's reverse-domain identifier

- **Status:** Accepted
- **Date:** 2026-08-14
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0204](0204-an-app-is-one-reverse-domain-identifier-that-names-every-place-it-exists.md)
  and [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md)
  at the public name. The reverse-domain value and every place it addresses
  stay the same.

## Context

`defineWorkspace` called its stable reverse-domain application identifier
`namespace`. That word came from the earlier shared SQLite layout, where it
partitioned rows in common relations. The immutable-workspace model no longer
has that ownership shape: one application declares one canonical workspace,
and its identifier names the app's durable world across local storage, sync,
and installation.

`namespace` now explains a retired storage representation more readily than it
explains the value an application author supplies. A bare `id` is clear within
a workspace declaration. But an address can carry a principal id, row id, or
document id too, so a bare `id` there would be ambiguous.

## Decision

**A workspace declaration exposes its reverse-domain application identifier as
`id`.**

```ts
defineWorkspace({
	id: 'so.epicenter.honeycrisp',
	tables: { notes },
});
```

The value remains publisher-chosen, reverse-domain, stable, and unverified by
design. It names the same durable locations as before.

Where a value travels beside other identities, the field is `workspaceId`:
structured row addresses, browser-storage addresses, store-sync query
parameters, and authority partitions. The protocol accepts no `namespace`
alias.

## Consequences

- A declaration reads as an application-owned artifact rather than a storage
  partition.
- Callers can distinguish a workspace identifier from row, principal, and
  document identifiers without relying on context.
- The unmerged migration takes one clean source and wire break. There is no
  compatibility reader because the old shape was never released.
