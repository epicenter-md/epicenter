# 0263. A connection is one server at a time and a replica is derived from it

- **Status:** Superseded
- **Date:** 2026-08-26
- **Superseded by:** [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md). Every clause this record restates has since been reversed: the server URL left the replica address (ADR-0324), switching servers became export and import (ADR-0325), and no runtime surface selects a server at all. It was the last record a reader could cite to keep the code those three records withdrew.
- **Restates:** [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0092](0092-identity-is-the-partition.md), [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md), and [ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md) as one reader-facing contract
- **Relates:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
- **Implemented in part:** The app-facing auth contract now exposes one
  `connection` with a server URL and status. The desktop authority still uses a
  private deployment discriminator in its keychain record because it selects
  credential deserialization; that private persistence detail does not cross
  into apps.

## Context

The surrounding ADRs already make the same architectural choice from
different angles, but the product contract is easy to miss. A person should
not have to combine the words deployment, principal, partition, profile, and
credential to understand what happens when they sign in or change servers.

The other source of confusion is treating a server change as a data move. A
server URL is part of the local replica address, so selecting another server
can safely open another local copy without exporting or overwriting the first.

## Decision

Epicenter has one connection at a time. A connection is one canonical server
URL plus the principal that server resolves for the credential. The desktop
host may connect to multiple servers over time, but only one connection is
active in a host auth generation.

The product has two server shapes:

| | Epicenter Cloud | Self-host |
| --- | --- | --- |
| Credential | OAuth | Operator-supplied bearer |
| Principal | One principal per person | Literal `instance` principal |
| Partitions per server | One per person | One shared partition |
| Meaning of the credential | The person's authority | Shared authority for the server |
| Revocation | Account and session management | Rotate the shared bearer |

Cloud gives each person a private account. A self-hosted server has one shared
data space; everyone with its key uses that same space. A self-host bearer is
not a human account, and self-host does not provide per-person server-side
identity, membership, organizations, or private partitions.

An application's local replica is addressed by:

```text
(application namespace, canonical server URL, principal)
```

Cloud resolves OAuth to a person's principal. Self-host resolves every valid
bearer to `instance`. Alice and Bob therefore have separate physical local
copies on their devices when they use the same self-host, but those copies
sync the same logical partition.

Changing servers starts a new auth generation and opens the replica derived
from the new server URL and principal. It leaves the previous local copy in
place. Switching does not migrate data and does not require export. Export
and import are separate, explicit data-transfer operations.

The host owns credentials and exposes only connection state and brokered
capabilities to its WebViews. OAuth issuer, client, and callback constants
belong to Epicenter Cloud. A self-host URL and bearer can be selected at
runtime; changing the hosted OAuth constants or shipping different defaults
requires a rebuild. The prebuilt client does not derive an OAuth flow from an
arbitrary self-host URL.

## Consequences

- Switching from Cloud to a self-host, and back again, is valid. Returning to a
  previous server reopens its retained local replica.
- Multiple active servers in one host are refused. Apps cannot select their
  own server or credential, so one WebView cannot accidentally sync against a
  second server while its current store is open.
- The server URL and principal remain the storage identity. A generated
  profile id, connection registry, or deployment kind does not become another
  storage identity.
- A self-host is simple to operate and can be shared by a trusted small group,
  but a leaked or copied bearer exposes the whole server. Removing one person
  requires rotating the bearer and redistributing it.
- People who need private data separation use Cloud or separate self-hosted
  servers. Organizations, memberships, and per-person self-host partitions
  remain outside the product contract.
- The host's one active connection is a lifecycle boundary, not a restriction
  on how many server replicas the device may retain locally.

## Considered alternatives

**Forbid server switching or require export before every switch.** Rejected.
The URL is already part of the replica address, so switching cannot collide
with the previous server. Requiring export would confuse connection selection
with explicit data migration and make the normal Cloud-to-self-host path
needlessly fragile.

**Keep multiple server connections active in one host.** Rejected. It would
force every WebView, sync engine, and host capability to carry multiple active
identities. A switch is a new auth generation instead.

**Let each application select its own server.** Rejected. It duplicates
credentials, permits inconsistent app state, and makes it unclear which local
copy an app is editing.

**Give self-host each person's private partition or add organizations.**
Rejected for this product shape. That is multi-tenancy, which brings back
membership, offboarding, authorization, and billing surfaces. Multi-tenancy
remains Cloud-only.

**Call the self-host bearer a shared account.** Rejected as developer
vocabulary. It is a shared credential resolving to the `instance` principal,
not a human account managed by an identity provider.
