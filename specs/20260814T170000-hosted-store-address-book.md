# Hosted store address book

- **Status:** Draft
- **Date:** 2026-08-14
- **Decision owner:** [ADR-0242](../docs/adr/0242-hosted-postgres-registers-store-addresses-before-an-authority-accepts-data.md)
- **Branch:** `claude/value-is-a-named-row`

## One sentence

Give the hosted control plane a durable list of every `(principal, namespace)`
authority before that authority may hold data, so account deletion can erase
every hosted replica in an open namespace ecosystem.

## Current state

The migration introduces `StoreAuthority`, one opaque Durable Object per
`(principal, namespace)`. The account-deletion route still deletes the hosted
auth user, blobs, billing customer, and storage observations, but it cannot
enumerate the new authorities. `StoreAuthority.deleteStore()` exists as the
per-object erase primitive with no caller.

The existing `storage_observation` table is not the solution. It measures
observed usage for allowances; it is not an admission gate, an exhaustive
address list, or a deletion fence. A namespace with no measurement yet must
still be discoverable and erasable.

## Target shape

```txt
authenticated open (principal, namespace)
  -> Postgres: register address, unless account is deleting
  -> named StoreAuthority: accept opaque sync bytes

account deletion
  -> Postgres: install principal deletion fence
  -> Postgres: list registered namespaces
  -> every named StoreAuthority: deleteAll(), seal, close live sockets
  -> Postgres: remove address rows and hosted auth identity
```

Postgres stores only the address and lifecycle state. The Durable Object stores
the opaque document snapshot and tail. Neither side can substitute for the
other.

## Implementation slice

1. Add a hosted-only Postgres schema and data module for store addresses,
   keyed by `(principal_id, namespace)`, plus a principal-level deletion fence.
   Do not extend `storage_observation`.
2. At the authenticated `/api/store` boundary, validate the namespace and
   register its address before resolving the Durable Object or forwarding a
   WebSocket. Repeated opens must be idempotent. A fenced account receives a
   permanent denial, not a reconnect loop.
3. Restore account deletion as a first-class coordinator step: install the
   fence, enumerate the registered addresses, call `deleteStore()` for each,
   and delete the registry rows only after every authority is sealed. Sealing
   clears application bytes, closes live sockets, and refuses an upgrade that
   passed Postgres admission immediately before the fence. Keep the auth user
   last so a partial deletion remains retryable.
4. Add route and integration coverage for: first open registers before bytes,
   registration failure prevents an authority write, account deletion erases
   several namespaces, a deletion retry resumes safely, an already-connected
   socket is closed, and a sync attempt racing with deletion is denied.

## Completion evidence

- A live hosted account can create two distinct third-party namespaces, delete
  its account, and prove both corresponding Durable Objects are empty.
- A failed deletion can be retried without a missing address or a newly created
  authority.
- No workspace content, update bytes, snapshots, or schemas enter Postgres.
- Once implementation lands, flip ADR-0242 to `Accepted` and delete this spec.
