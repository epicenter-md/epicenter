# 0087. First-party OAuth clients are seeded without a declared client type

- **Status:** Proposed
- **Date:** 2026-07-01

## Context

Whispering's desktop cloud sign-in (PR #2239) opens the system browser for OAuth
and receives the code through a custom URL scheme (`epicenter-whispering://auth/callback`),
justified in the spec only as "mirrors Fuji"
(`apps/whispering/specs/20260602T140000-cloud-sync-and-account.md`), never against
the standards that govern desktop OAuth. A grounding pass set out to decide the one
implicit question the seed left open: the trusted-client projection
(`packages/constants/src/oauth-seed.ts`) stamped each client with an OIDC `type`
(`native` or `user-agent-based`), and it was unclear which value the Whispering and
Fuji rows should carry. That framing was itself the bug: each of those rows is a
single `oauth_client` whose `redirectUris` span both the app's web `/auth/callback`
origins **and** the desktop custom scheme, so no single `type` is honest, and the
field turned out to be dead weight regardless of its value.

## Decision

First-party OAuth clients declare no `type`. The `TrustedOAuthClient` shape drops
the field, `buildTrustedOAuthClients` stops authoring it, and
`projectTrustedOAuthClientToRow` writes `type: null`, so the `oauth_client.type`
column is NULL for every seeded first-party row. Public-client and PKCE behavior
are fixed by `public: true`, `tokenEndpointAuthMethod: 'none'`, and
`requirePKCE: true`, none of which is the `type` label.

This is grounded, not guessed:

- **The field is inert on our write path**, verified in the pinned
  `@better-auth/oauth-provider@1.6.18` source. The only reads of `type` are
  `isPKCERequired` (which treats `native`, `user-agent-based`, and
  `public === true` identically, and is null-safe) and `checkOAuthClient` (a
  consistency check that runs only on `/oauth2/register`). Our rows are written by
  a direct parameterized `INSERT` in `apps/api/scripts/seed-oauth-clients.ts` and
  dynamic registration is disabled (`allowDynamicClientRegistration: false`), so no
  read path ever branches on the value. No Epicenter code reads it either.
- **The RFC-correct label would still be ambiguous.** RFC 8252 §3/§5/§8.12 make an
  app that opens an external user-agent and catches a custom-scheme callback a
  *native* client, and §7.1/§7.2 make both custom-scheme and claimed-https native
  redirect mechanisms; the browser-based-apps BCP defers such desktop apps to
  RFC 8252. But Whispering and Fuji ship *one* client id across a browser web build
  and a native desktop build, so even the RFC-correct `native` would misdescribe
  the web form factor. There is no honest single value, which is the signal that
  the field should not be set at all.

Keeping `type = EXCLUDED.type` in the seed upsert means a re-seed re-asserts NULL,
clearing any legacy `user-agent-based` / `native` value already in a deployment.
This ADR flips to `Accepted` when the change lands and `bun run oauth:seed:remote`
has run against production.

## Consequences

- The native-vs-user-agent-based question disappears rather than being answered.
  There is no longer a field whose value is debatable, so no recurring temptation
  to "fix" a dual-form-factor client's type and no ADR-sized decision attached to a
  decorative label.
- The trusted-client config reads as pure identity + redirect surface
  (`clientId`, `name`, `redirectUris`); the `Extract<SchemaClient['type'], ...>`
  union and seven authored `type:` lines are deleted.
- The justification for the desktop flow is now RFC 8252 + RFC 7636 + RFC 8707
  (external user-agent, PKCE S256, resource-indicator audience binding), citable
  and durable, rather than "mirrors Fuji."
- **Cost:** the `oauth_client.type` column is NULL for first-party rows, so a
  human inspecting the table cannot read an app's form factor from that column;
  they read it from `public`, `redirectUris`, and the app itself. This is
  information the column never reliably carried for a dual-form-factor client
  anyway.
- **Operational cost:** landing requires an `oauth:seed:remote` run (an operator
  action, per the `:remote` blast-radius convention), idempotent and touching only
  metadata.
- The `epicenter-whispering://` / `epicenter-fuji://` schemes are not the
  reverse-domain form RFC 8252 §7.1 recommends (SHOULD, e.g. `com.epicenter.*`).
  This ADR does not change the scheme; renaming it would rewrite registered
  redirect URIs and the bundle plists, far larger than a metadata change, for a
  SHOULD. Recorded as a known deviation to revisit if the schemes are reworked.

## Considered alternatives

- **Stamp the dual-form-factor rows `native`.** Sets an inert field to the
  security-sensitive form factor's label and needs this ADR to defend a value
  nothing reads. Rejected: it dresses up a decorative field instead of removing it.
- **Split each app into two client ids (web = `user-agent-based`, desktop =
  `native`).** The only shape under which every `type` is honest. Rejected: it
  *adds* a platform-selected client id in the app, a second seed row, and a second
  redirect set purely to make an inert field honest, negative asymmetry. If
  `@better-auth/oauth-provider` ever branches request-path behavior on
  `native`-vs-`user-agent-based`, revisit both this refusal and the split then, and
  supersede this ADR.
