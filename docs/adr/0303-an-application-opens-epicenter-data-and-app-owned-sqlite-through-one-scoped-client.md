# 0303. An application opens Epicenter Data and app-owned SQLite through one scoped client

- **Status:** Accepted
- **Date:** 2026-08-31
- **Unbuilt:** The runtime-neutral client, its host binding, and its browser and desktop openers.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (the host brokers capabilities without owning application meaning), [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (a definition is pure and opening is one call), [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (provider copies keep their application-owned schema and lifecycle), and [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) (the physical storage mappings)

## Context

An application needs one runtime-neutral way to reach the two persistence models
the platform supports. Epicenter Data is a declared, structured local-first
model; SQLite is an app-owned relational store such as a provider mirror or
search index. Their meanings and lifecycles differ, but application code should
not select IndexedDB, OPFS, Bun SQLite, or a native file.

The application also needs one stable identity for local storage. Repeating that
identity in every opener invites path and namespace drift, while inferring it
from a URL confuses deployment with application identity.

## Decision

An application creates one client with its declared application ID and opens
either persistence model through that client:

```ts
const epicenter = createEpicenterClient({
	appId: 'so.epicenter.local-mail',
});

const data = await epicenter.openData(definition);
const mail = await epicenter.openSqlite('mail');
```

`openData(definition)` opens the Epicenter Data API declared by the definition.
`openSqlite(name)` opens a SQLite database private to the application. The
client verifies that the definition's ID agrees with the client identity and
derives every physical address from the scoped identity and logical name.

The public client contains these two openers only. Authentication and native
desktop capabilities remain separate opt-in packages, even when the host
implements them through the same injected binding.

The host may inject the authoritative application ID and capabilities into the
page. `createEpicenterClient` wraps and validates that binding; application code
does not reach through `window` directly. A standalone browser or native build
provides the same client with its build-time application ID and runtime
fallbacks.

## Consequences

- `defineData()` stays pure. It declares meaning; it does not open storage.
- Application code has one composition point and no runtime branches for storage.
- The client is scoped once, so `openSqlite('mail')` cannot accidentally open another app's database.
- A provider app still owns its schema, ingestion, versioning, readiness, and deletion policy. The platform supplies only the opening mechanism.
- The API does not promise identical durability across runtimes. It promises one application-facing contract over runtime-specific adapters.
- Adding another host capability to this client requires evidence that it is universal. Auth and native APIs do not enter by default.

## Considered alternatives

- **Put `defineData` inside the client constructor.** Rejected because the definition is inert data and has a different lifetime from the runtime binding.
- **Expose `auth` and `desktop` on every client.** Rejected because most applications do not need either capability and unused authority would become the default API.
- **Infer the app ID from the URL.** Rejected because URLs are deployment addresses, not stable application identities.
