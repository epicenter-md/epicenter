# 0138. Principal-scoped workspaces transfer from local storage scopes

- **Status:** Accepted
- **Date:** 2026-07-17
- **Relates:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md)

## Context

The SQLite workspace lane needs names for deployment, credentials, principals,
workspace ids, local persistence, and synchronization authority. The old
`authorityKey` name mixed several jobs: local storage fencing, authenticated
partitioning, and the runtime actor that orders synchronized state. That made
signed-out to signed-in behavior ambiguous.

## Decision

A connection is the authenticated transport to one deployment. It may carry a
token, cookies, or an auth-owned `fetch`, but credentials are not data identity.
The deployment resolves the principal. The stable authenticated scope is the
deployment identity plus `principalId`; credentials can rotate without changing
that scope.

A workspace is an app-defined local-first data unit. When synchronized, the
server-local partition is `(principalId, workspaceId)` inside the deployment
that resolved the principal. One workspace authority governs that partition:
it owns ordering, retry, compaction, baseline acquisition, and confirmed state.
The authority is a runtime role, not a URL, token, principal, or storage key.

Local persistence is named separately as a local storage scope. A local-only
workspace instance is `(localStorageScope, workspaceId)`. A signed-out workspace
that later signs in does not silently become the principal-scoped workspace.
The product performs an explicit transfer from the local storage scope into a
new principal-scoped workspace instance, preserving the app `workspaceId` while
changing the scope that owns persistence and synchronization.

The public composition is therefore:

```txt
deployment
  -> connection authenticates
  -> principal scope (deployment identity + principalId)
  -> workspace (workspaceId)
  -> workspace authority for synchronized ordering

local-only storage scope
  -> explicit transfer
  -> principal-scoped storage scope
```

## Consequences

- SQLite workspace runtimes name local persistence with `storageScopeKey`, not
  authority. `authorityKey` is not retained as a compatibility alias.
- The caller never supplies `principalId` as a data selector. The deployment
  resolves it from authentication.
- Sign-in needs an import or transfer workflow. Silent upload of the signed-out
  local workspace is refused.
- Deployment identity must be normalized once. Bare origin strings are not
  enough if a deployment can live under a path prefix.
- The workspace authority rename can proceed independently from HTTP route and
  durable string migrations. Existing durable strings stay until a separate
  migration decision changes them.

## Considered alternatives

- **Treat authority as origin plus credential.** Rejected because that names a
  connection, not the synchronized data owner. Credentials rotate and can be
  represented as cookies, bearer headers, or auth-owned fetch behavior.
- **Let a local workspace become remote on sign-in.** Rejected because it
  silently reinterprets one local storage scope as another and can upload data
  without a product decision.
- **Include table or row ids in authority identity.** Rejected because tables,
  rows, fields, and row documents are resources inside a workspace. They do not
  define the synchronized authority boundary.
