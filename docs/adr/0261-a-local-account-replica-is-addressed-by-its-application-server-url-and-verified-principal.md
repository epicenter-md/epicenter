# 0261. A local account replica is addressed by its application, server URL, and verified principal

- **Status:** Accepted
- **Date:** 2026-08-22
- **Restated by:** [ADR-0263](0263-a-connection-is-one-server-at-a-time-and-a-replica-is-derived-from-it.md) as the reader-facing connection and replica contract
- **Supersedes:** [ADR-0259](0259-a-desktop-profile-is-addressed-by-a-server-url-and-principal-pair.md)
- **Amends:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) at the retained account replica address. The device document, retained-replica, and sign-out rules remain.
- **Relates:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
- **Implemented in part:** The shared connection type and desktop bootstrap
  snapshot now carry the selected server URL. Browser storage follows the
  derived address, which has since gained a storage epoch and a generation
  segment under [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md): `epicenter/v3/<dataId>/account/<canonical server URL>/<principal>/gen/<n>`.
  The three facts this record is about, application, server URL, and verified
  principal, are unchanged.

## Context

An account replica needs both the server URL and the principal because a
principal is meaningful only within one server. This is especially important
for self-hosting: every self-hosted deployment may resolve its bearer to the
same literal `instance` principal while still holding independent data.

The previous decision added a generated `profileId` between those facts and
the local store. That makes a host registry part of the data address even
though the address is already derivable. It also leaves the device document,
which belongs to no account, without a place in the model.

## Decision

**A connection is one canonical server URL plus the principal verified by that
server. An application's retained account replica is addressed by its
application namespace and that connection.** The address is derived, never
minted as a profile id.

```text
application + canonical server URL + verified principal
                         |
                         v
                 retained account replica
```

The server URL is canonicalized before it becomes durable local state. A
connection exists only after the server verifies the principal, normally
through the session endpoint. An account replica cannot be opened with an
empty or unverified principal.

The device document remains addressed by the application namespace alone. It
is device-owned, never syncs, and survives sign-in and sign-out. The authority
document id remains internal replica metadata; it is not another public part
of the connection address.

Signing out removes network authority but retains the account replica. Signing
in again to the same server and principal reopens it. A different server or a
different principal opens a different replica. A self-host reset at the same
URL remains the same local address; the bootstrap and supersession rules in
[ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) and
[ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
decide what the empty or changed remote authority does.

## Consequences

- The local account address is `(application, canonical server URL, principal)`.
- Equivalent URL spellings resolve to one local replica.
- The same principal on two servers resolves to two local replicas.
- A shared `instance` principal on one self-host intentionally shares one
  replica for everyone using that server identity.
- The application namespace remains part of the address even though people
  can think of the result simply as "this account's local copy".
- `profileId`, installation ids, and registry lookups are not storage
  identities. A deterministic encoding of the address is an implementation
  detail and does not create another noun. The canonicalization rules and the
  encoding are part of the storage contract; changing either is a replica
  migration.
- Device data is not account data and is never copied or promoted between
  them.

## Considered alternatives

- **Use principal alone.** Rejected because self-host principals can repeat
  across independent servers.
- **Use server URL alone.** Rejected because one hosted server serves many
  principals.
- **Mint a profile id and look up the address through a registry.** Rejected.
  It makes local data depend on recoverable host metadata and creates a second
  identity that must agree with the server and principal.
- **Put the authority document id into the public address.** Rejected. It is
  replica metadata that can change when the current authority document is
  replaced while the logical account address remains stable.
