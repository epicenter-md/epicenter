# 0176. The hosted product lives in apps/hosted and deploys as epicenter

- **Status:** Proposed
- **Date:** 2026-07-19
- **Relates:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), and [ADR-0175](0175-one-epicenter-durable-object-owns-one-principals-accepted-state.md)

## Context

`apps/api` contains the hosted UI, OAuth, billing, account lifecycle, AI
gateways, synchronization, blobs, and Durable Object wiring. Calling the whole
deployable `api` under-describes its ownership and obscures its deliberate pair
with `apps/self-host`.

## Decision

The hosted deployable lives at `apps/hosted`. Its Cloudflare Worker is named
`epicenter`. The self-hosted reference remains `apps/self-host`, and both
compose the shared Hono implementation from `packages/server`.

The installed public origin remains `api.epicenter.so`. An origin is a stable
network address with client blast radius, not a repository or Worker name.

## Consequences

- Repository paths describe deployment ownership rather than one transport.
- Hosted-only OAuth, billing, and account policy stay visibly outside the
  shared server package.
- Renaming the Worker does not require renaming the public API origin.

## Considered alternatives

- **Keep `apps/api`.** Rejected because the greenfield repository should name
  the whole hosted product, not one surface it exposes.
- **Name the Worker `epicenter-api`.** Rejected because the account and origin
  already establish context, while the Worker owns more than HTTP API routes.
