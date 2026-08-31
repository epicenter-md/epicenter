# 0259. A desktop profile is addressed by a server URL and principal pair

- **Status:** Superseded
- **Date:** 2026-08-21
- **Superseded by:** [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md)
- **Provisional number.** Reconcile this number at merge time according to [the ADR numbering rule](README.md).
- **Amends:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) at the address of a retained account replica. The retained-replica and sign-out rules remain; the address gains the server endpoint.
- **Relates:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md), [ADR-0243](0243-a-workspaces-id-is-its-applications-reverse-domain-identifier.md)
- **Unbuilt:** Desktop profile records and profile-qualified app storage are not implemented yet.

## Context

The server principal identifies a partition within one deployment, but it is
not globally sufficient on a client. Hosted Cloud gives each user a distinct
principal, while every self-hosted deployment uses the literal `instance`
principal. A client that keys local data only by principal can therefore open
one self-host's data under another self-host URL. A client that keys only by
URL cannot distinguish two Cloud users on the same server.

The desktop also retains app-local replicas across sign-out. The local address
must therefore survive credential removal and must remain stable while the
credential refreshes, expires, or is replaced for the same principal.

## Decision

**A desktop profile is the local record of one canonical server base URL and
the principal authenticated against that URL.** The remote data-universe
address is `(baseURL, principalId)`. A generated local `profileId` names that
record for storage and host bookkeeping; it is not a server principal and is
never sent as the server's partition identity.

Every desktop application addresses its local replica with `(appId,
profileId)`. The store opener chooses the profile namespace once, so individual
document ids do not carry the profile id. The application never chooses a
different base URL or principal after opening the store.

The profile remains the same when a self-hosted operator wipes and recreates
the server at the same URL. The client does not infer a new installation id,
delete local data, or silently create a second profile. Existing sync and
bootstrap rules decide what happens when the remote state is empty or changed;
detecting replacement of a self-host installation is outside this contract.

## Consequences

- Principal-only local addresses are refused. The server endpoint is part of
  the client partition key.
- A refresh token, access token, or self-host bearer is credential material,
  not profile identity. Credential rotation never moves local data.
- A profile can exist without a credential after sign-out. Re-authentication
  must verify the same server URL and principal before reopening its replica.
- Two self-host servers with the same `instance` principal remain separate
  profiles because their base URLs differ.
- Multiple profiles can coexist on one device without making multiple
  profiles active in one desktop process.

## Considered alternatives

- **Use `principalId` alone.** Rejected because self-host principals are the
  same across deployments.
- **Use the URL alone.** Rejected because one Cloud URL serves many users.
- **Add a server installation id now.** Deferred. A self-host reset at the
  same URL is accepted as the same client profile for now.
- **Put `profileId` into every document id.** Rejected. The store namespace
  owns the profile boundary; row and document ids stay application ids.
