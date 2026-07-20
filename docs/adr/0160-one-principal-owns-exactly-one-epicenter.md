# 0160. One principal owns exactly one Epicenter

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md)
- **Amends:** [ADR-0092](0092-identity-is-the-partition.md) by fixing the partition cardinality to one Epicenter.
- **Relates:** [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), and [ADR-0153](0153-trusted-apps-are-source-built-static-catalog-members.md)

## Context

Workspace IDs add a second durable ownership axis beneath a principal. That
axis requires catalogs, creation and deletion lifecycles, per-workspace routes,
directory fanout, authority namespaces, installed-app declarations, and product
language for choosing among stores. Applications already model projects,
folders, notebooks, and recording collections as ordinary rows, so the platform
plurality has no load-bearing product use.

## Decision

One selected owner owns exactly one Epicenter. A hosted deployment resolves the
authenticated principal and therefore the Epicenter. A self-hosted instance
resolves every valid bearer to its literal `instance` principal. Explicit local
use selects one independent local Epicenter. There is no `EpicenterId`,
`WorkspaceId`, platform workspace catalog, or second Epicenter beneath one
owner.

An Epicenter contains current rows, typed KV, one latent row-owned Yjs document
per ordinary row, and owner-scoped immutable blobs. Rows are addressed by their
permanent table key and generated row ID. Generated row and blob IDs are never
intentionally reused.

Projects and other application divisions are rows. Applications do not create
private platform databases merely to organize one owner's data.

## Consequences

- Server routes and authority tables lose every `workspace_id` dimension.
- Local runtimes select an owner once and share one raw Epicenter lifecycle.
- Applications with a genuine security or isolation boundary need another
  principal or deployment, not another platform workspace.

## Considered alternatives

- **Keep many named workspaces under one principal.** Rejected because no
  current product needs the extra ownership axis, while every storage and sync
  surface pays for it.
- **Give each application its own Epicenter.** Rejected because data outlives
  applications and trusted integrations must share one user-owned state.
- **Model projects as Epicenters.** Rejected because projects are application
  data with application semantics, not platform authorities.
