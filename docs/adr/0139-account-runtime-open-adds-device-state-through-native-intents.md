# 0139. Account runtime open adds device state through native intents

- **Status:** Accepted
- **Date:** 2026-07-17
- **Supersedes:** [ADR-0138](0138-device-account-workspace-adoption.md)
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

Device and Account remain separate local persistence owners, but ADR-0138's
byte-copy adoption puts device rows into the account replica's confirmed table.
Those rows never become account intents, so they do not upload. Requiring an
empty account also discards the row authority's existing first-create-wins law
and grows inspection, marker, retry, and collision machinery around a transfer
that can use normal workspace mutations.

## Decision

Opening an account workspace eagerly acquires its storage owner and first adds
any matching device workspace through native account intents, before account
synchronization starts. The storage edge performs the transition while holding
exclusive leases for both physical owners:

```txt
for each current device row
  -> admit create(table, original rowId, fields, compact document)

for the current device KV map
  -> admit update(set every present key, unset nothing)

after every intent is durable in the account store
  -> delete the device store
  -> start ordinary account synchronization
```

Create on a current local or confirmed authority row is a no-op. This makes row
addition idempotent without target inspection: absent account rows are added,
existing account rows remain unchanged, and retry repeats the same creates.
The local replica admission law mirrors that authority law for a create whose
current projection is already live.

KV uses its existing keywise authority order. Account-only keys remain because
the device update unsets nothing. Within the aggregate capacity bound,
device-only keys are added and the device value wins on overlap as the later
account write. If unseen authority state makes the merged aggregate exceed its
capacity, the existing fold law no-ops the whole update. Addition does not
acquire a baseline or turn one bounded aggregate into a partial per-key import.
Values that must never leave one physical device do not belong in workspace KV.

The account runtime does not wait for a baseline or contact the server during
addition. Local intent durability is the same durability boundary used by any
offline account edit. It deletes the device source before enabling account
synchronization, so a crash retry cannot replay a create after another replica
has observed and deleted the imported row.

Bun extends its existing process-local root ownership across both roots for the
Account runtime lifetime. Browser runtimes hold equivalent origin-wide storage
leases across workers; worker-local queues are not an exclusivity boundary. The
public `open()` promise resolves only after owner acquisition and local addition.

Application migrations remain separate. They run against the opened account
workspace through ordinary typed operations. The storage transition accepts no
table filters, KV filters, conflict callbacks, remapping policy, or application
migration hook.

## Consequences

- Existing Device and Account runtime constructors remain the public ownership
  choice. Account callers gain no second transfer API or option.
- An account workspace may already contain rows, documents, and KV. Addition
  never checks account emptiness and never reads target values first.
- Ordinary rows use first-create-wins. Device KV overlays only keys present on
  the device and follows normal server order and capacity folding on overlap.
- An operational failure before source deletion leaves the device source. The
  next signed-in boot retries before opening the account runtime. A native
  semantic no-op, including a KV capacity no-op against unseen authority state,
  is not an operational failure. No adoption marker or retained backup exists.
- Runtime `open()` becomes an eager storage boundary instead of returning a
  handle whose first operation owns initialization failure.
- Device and Account physical owners remain mutually exclusive for the Account
  runtime lifetime. Bun Account transports cannot resolve to `undefined`;
  local-only ownership belongs to the Device runtime.
- Byte serialization, empty-target refusal, optional deletion, live-runtime
  transfer, row comparison, row remapping, field merge, document merge, target
  baseline acquisition, and conflict UI are refused.
- Sign-in means that existing device workspace state joins the selected
  account. Product copy must describe that upload before authentication.
- The old root-Yjs and IndexedDB migration remains outside this decision. This
  transition reads only the SQLite device workspace owned by ADR-0130.

## Considered alternatives

- **Copy the SQLite database into account storage.** Rejected because device
  canonical rows become false server-confirmed state and never upload.
- **Inspect the account and copy only when empty.** Rejected because native
  create and KV fold laws already define addition to a populated account.
- **Read target KV and fill only absent keys.** Rejected because it makes import
  depend on baseline acquisition and still races another account writer. Normal
  KV authority order already owns overlapping writes.
- **Write KV one key at a time.** Rejected because local intents compact at the
  single reserved KV address, while synchronizing between keys would create a
  partial, order-dependent transfer and require network receipts.
- **Expose application migration callbacks from the storage transition.**
  Rejected because ownership transfer is schema-blind. Application-specific
  interpretation remains an ordinary migration after account open.
- **Claim the device workspace for the account.** Rejected because it changes
  all device writes and server enrollment to avoid a transfer already expressible
  as native intents.
