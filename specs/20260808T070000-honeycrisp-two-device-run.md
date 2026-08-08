# The two-device run, on Honeycrisp

- **Status:** Draft
- **Date:** 2026-08-08
- **Relates:** [ADR-0225](../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the endpoint, built),
  [ADR-0222](../docs/adr/0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md)
  (the client half, built).

## What is already true

Everything except the run itself.

The endpoint carries a note between two devices with its prose, in both
directions, with a third device catching up from the log on arrival, proved in
real `workerd` against the deployed route and the deployed Durable Object
(`packages/server/workers/e2e.test.ts`). Honeycrisp dials it through
`auth.openWebSocket`. Nothing polls, nothing awaits a read, and a note and its
prose survive a reload.

## What is left, and it is an environment rather than a design

`bun dev:api` is `wrangler dev` behind `infisical run --env=dev`, so a local
hosted API needs Infisical access. Without it the API cannot boot, and neither
can the browser run that would drive two signed-in Honeycrisp windows.

So the remaining work is a session with those secrets, not a decision:

1. `bun dev:honeycrisp` (which starts the API on `localhost:8787`).
2. Sign in on two browser contexts as the same account.
3. Write a note on one, and watch it arrive on the other with its prose.

`apps/api/server.dev.ts` resolves `Bearer dev:<principalId>` on localhost, so a
scripted version needs no OAuth at all; what it needs instead is a Bun-side
`resolveAuthority` for `mountStoreSyncApp`, since a Durable Object is a
Cloudflare construct and the Bun entrypoint has none. That is an in-process
`openSyncAuthority` per name, and it is the same shape the self-hosted instance
will want anyway.

## The one thing worth deciding before the run

**What the desktop host does.** Honeycrisp's `epicenter-host` build currently
opens its own store like every other build, which is a regression pinned in
`apps/honeycrisp/src/lib/platform-selection.test.ts`: its notes are no longer in
the `epicenter.sqlite3` other trusted surfaces read. With ADR-0225 in place the
shape that restores it is available, the window as a replica of a store the host
owns, and the question is only whether the host serves the same route or the
window simply syncs through Cloud like every other device. The second is less
code and makes the desktop host stop being a special case; it also means a
host with no network shares nothing between its own surfaces.

## Gate

- Two real devices: write a note on one, see it on the other, with prose.
