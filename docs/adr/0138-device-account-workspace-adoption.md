# 0138. Device and account workspace adoption

- **Status:** Superseded
- **Date:** 2026-07-17
- **Superseded by:** [ADR-0139](0139-account-runtime-open-adds-device-state-through-native-intents.md)
- **Relates:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md)

## Context

The SQLite workspace lane needs names for deployment, credentials, principals,
workspace ids, local persistence, and synchronization authority. The old
`authorityKey` and `storageScopeKey` names mixed several jobs: local persistence
fencing, authenticated partitioning, and the runtime actor that orders
synchronized state. That made signed-out to signed-in behavior ambiguous.

## Decision

A connection is the authenticated transport to one deployment. It may carry a
token, cookies, or an auth-owned `fetch`, but credentials are not data identity.
The deployment resolves the principal. The stable account identity is the
deployment identity plus `principalId`; credentials can rotate without changing
that identity.

A workspace is an app-defined local-first data unit. It owns workspace KV and
tables. Tables contain rows. Rows contain fields plus an optional
lifecycle-bound document.

SQLite runtimes expose two constructors:

```txt
createDevice*WorkspaceRuntime()
  -> opens unsigned, device-owned local persistence
  -> has no deployment, principal, credential, or sync transport

createAccount*WorkspaceRuntime({ account })
  -> opens account-owned local persistence
  -> account = deployment identity + principalId + transport
  -> syncs through the account transport when provided
```

The caller does not construct or pass public storage keys. Runtime persistence
identity is private implementation detail derived from either `device` or the
opaque account handle.

When synchronized, the server-local partition is `(principalId, workspaceId)`
inside the deployment that resolved the principal. One workspace authority
governs that partition: it owns ordering, retry, compaction, baseline
acquisition, and confirmed state. The authority is a runtime role, not a URL,
token, principal, account, or storage key.

Signed-out data belongs to the device runtime. Signed-in data belongs to the
account runtime. A device workspace that later signs in does not silently become
the account workspace. The product performs explicit adoption:

```txt
device runtime
  -> inspect device workspace
  -> user confirms adoption after sign-in
  -> refuse if account workspace is non-empty
  -> copy the whole workspace into the account runtime
  -> optionally delete the device workspace
```

Adoption preserves the app `workspaceId` while changing the owner from device to
account. It is copy-first by default. Merge, collision handling, partial import,
live-runtime rebind, live-runtime import, and cross-store atomic transfer are
refused until a product need earns them.

This adoption rule applies to data created by the SQLite workspace runtime. It
does not require a reader or transfer path from the replaced root-Yjs,
room-backed, or IndexedDB workspace system. ADR-0130 deliberately abandons that
legacy storage under the first-party clean-break assumption.

## Consequences

- Public SQLite workspace runtime APIs use Device, Account, and adoption nouns.
  `authorityKey`, `storageScopeKey`, `scope`, and `kind` are not retained as
  compatibility names for runtime identity.
- The caller never supplies `principalId` as a data selector. Auth resolves the
  principal, then passes an account handle to the runtime.
- Sign-in needs an adoption workflow. Silent upload of the signed-out local
  SQLite workspace is refused.
- Empty account refusal deletes merge and collision policy from the first
  implementation. If the account workspace already has rows, KV, or documents,
  adoption stops and the product must ask the user to choose a different action.
- Deployment identity must be normalized once. Bare origin strings are not
  enough if a deployment can live under a path prefix.
- Existing durable strings stay until a separate migration decision changes
  them.

## Considered alternatives

- **Treat authority as origin plus credential.** Rejected because that names a
  connection, not the synchronized data owner. Credentials rotate and can be
  represented as cookies, bearer headers, or auth-owned fetch behavior.
- **Let a device workspace become account-owned on sign-in.** Rejected because
  it silently uploads local data and reinterprets one owner as another without a
  product decision.
- **Merge a device workspace into a non-empty account workspace.** Rejected
  because it creates row, KV, document, and deletion conflict policy before the
  product has a proven need for it.
- **Include table or row ids in authority identity.** Rejected because tables,
  rows, fields, and row documents are resources inside a workspace. They do not
  define the synchronized authority boundary.
