# The two-device run, on Honeycrisp

- **Status:** Draft
- **Date:** 2026-08-08
- **Relates:** [ADR-0225](../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the endpoint, built),
  [ADR-0226](../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md)
  (the host owns no data, so there is one topology to run).

## What is already true

Everything except the run itself.

The endpoint carries a note between two devices with its prose, in both
directions, with a third device catching up from the log on arrival, proved in
real `workerd` against the deployed route and the deployed Durable Object
(`packages/server/workers/e2e.test.ts`). Honeycrisp dials it through
`auth.openWebSocket`. Nothing polls, nothing awaits a read, and a note and its
prose survive a reload.

ADR-0226 removed the one design question that was left. There is now a single
topology: every surface owns its own store and reaches one authority per
account, so the desktop host is not a case to handle.

## What is left, and it is an environment rather than a design

`bun dev:api` is `wrangler dev` behind `infisical run --env=dev`, so a local
hosted API needs Infisical access. Without it the API cannot boot, and neither
can the browser run that would drive two signed-in Honeycrisp windows.

So the remaining work is a session with those secrets:

1. `bun dev:honeycrisp` (which starts the API on `localhost:8787`).
2. Sign in on two browser contexts as the same account.
3. Write a note on one, and watch it arrive on the other with its prose.

## The scripted version, if the manual one is not enough

`apps/api/server.dev.ts` resolves `Bearer dev:<principalId>` on localhost, so a
scripted run needs no OAuth. What it needs instead is a Bun-side
`resolveAuthority` for `mountStoreSyncApp`, because a Durable Object is a
Cloudflare construct and the Bun entrypoint has none.

That is an in-process `openSyncAuthority` per name over Bun SQLite, plus Bun's
own WebSocket upgrade. It is the same thing the self-hosted instance needs, so
it is not test-only scaffolding: `apps/self-host` cannot serve this route
without it either.

## Gate

- Two real devices: write a note on one, see it on the other, with prose.
