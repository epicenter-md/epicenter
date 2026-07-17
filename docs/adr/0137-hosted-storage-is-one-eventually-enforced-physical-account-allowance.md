# 0137. Hosted storage is one eventually enforced physical account allowance

- **Status:** Accepted
- **Date:** 2026-07-17
- **Relates:** [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md), [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md)

## Context

Epicenter Cloud must offer permanent hosted storage on Free without requiring a
card or turning quota enforcement into a distributed accounting protocol.
Logical user-owned bytes would require format-aware attribution, while exact
account quotas across independent workspace authorities and object storage
would require reservations, debt, or a central write coordinator.

## Decision

Epicenter Cloud meters one physical storage quantity per account: the sum of
the latest absolute `databaseSize` observation for every hosted workspace plus
the hosted blob bytes under that account.

Free has one account-wide included allowance with no overage, debt, expiry, or
automatic deletion. Once a reconciled observation reaches the allowance, the
account enters a binary delete-only state. Reads, downloads, exports, workspace
deletion, record deletion, blob deletion, and operations contractually
classified as non-growing remain available. The deployment does not calculate
the net physical effect of a request to make that classification.
Storage-growing sync rounds, blob uploads, workspace creation, and replica
enrollment stop. Local edits remain queued. Deleting enough data or upgrading
restores growth after reconciliation.

Enforcement is eventually consistent. Epicenter accepts the bounded overshoot
created by reconciliation lag and concurrent bounded operations. It does not
build distributed reservations, byte-perfect quota checks, or customer debt to
recover that overshoot.

Paid plans use the same physical meter with larger included allowances and
overage. A downgrade may place an oversized account directly into delete-only
state, but it never deletes data or creates retroactive debt.

Allowance sizes, paid-plan grants, overage prices, reconciliation cadence, and
operation ceilings are mutable catalog or implementation values, not parts of
this decision. The policy is Cloud-only; a self-hosted instance does not compose
Epicenter billing or account quota policy.

## Consequences

- One absolute meter serves enforcement, billing, and the dashboard. There are
  no logical-byte, per-workspace, per-app, per-table, or per-replica balances.
- Request paths consume one locally projected growth decision. They do not call
  the billing provider or distribute a remaining-byte balance to authorities.
- Reads and deletions fail independently of that projection. If the local
  growth decision cannot be loaded, only growth fails closed and retryably.
- Physical usage may change in page-sized steps. A small record deletion need
  not lower `databaseSize` immediately, and capacity may remain blocked until a
  later observation.
- A sealed sync round is either admitted as ordinary growth or, in delete-only
  state, admitted only when every intent is a record deletion. The authority
  does not estimate a mixed round's net byte effect or partially accept it.
- Exact enforcement, overshoot debt, automatic cleanup, paid hard caps, and
  storage expiration are deliberately refused.

## Considered alternatives

- **Meter logical user-owned bytes.** Rejected because every format and storage
  owner would need durable attribution and agreement on what counts.
- **Bill physical bytes but enforce a logical Free quota.** Rejected because two
  meters would create customer disagreement and reconciliation machinery.
- **Reserve account bytes before every write.** Rejected because exactness would
  require a distributed coordinator across workspace authorities and blobs.
- **Recover overshoot as debt or deletion.** Rejected because Free's permanent,
  no-surprise storage promise is more valuable than byte-perfect enforcement.
