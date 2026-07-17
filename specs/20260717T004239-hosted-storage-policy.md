# Hosted Storage Policy

**Date**: 2026-07-17
**Status**: Draft
**Owner**: Braden
**Branch**: `codex/sqlite-sync-architecture`
**Decisions**: [ADR-0137](../docs/adr/0137-hosted-storage-is-one-eventually-enforced-physical-account-allowance.md)
**Depends on**: [ADR-0131](../docs/adr/0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md)

## One sentence

Epicenter Cloud gives every account one permanent physical-storage meter; Free
enters a binary delete-only state after lagging absolute observations reach its
catalog allowance, with no card, debt, expiry, or data loss, while paid plans
remain growth-enabled through mutable included allowances and overage.

## Destination

```txt
workspace authorities -- absolute databaseSize --\
                                                +--> account observed bytes
hosted blob store ---- absolute listed bytes ---/             |
                                                              v
                                             local growth decision
                                              /              \
                                  request admission      Autumn + dashboard
```

The Cloud owns one projection per principal. The projection sums the newest
absolute observation for each live workspace and one absolute blob aggregate.
It resolves the active catalog policy into one request-path fact:
`growthAllowed`. Shared server code receives that fact through injected policy
callbacks; it does not learn plan ids, prices, allowances, or Autumn concepts.
Reads and deletions do not consult this projection. If the local decision is
unavailable, growth fails closed with a retryable service response while those
recovery paths remain available.

Autumn is the paid billing and customer-balance sink, not the request-path
authority. Reconciliation overwrites the non-consumable `storage_bytes` usage
with the absolute account total. This follows Autumn's supported direct-usage
model and avoids accumulating deltas twice after retries.

## Customer behavior

### Mutable launch catalog

- Free included storage: `100_000_000` bytes.
- Free requires no card and has no storage overage.
- Paid included bytes and per-GB overage remain the existing catalog values
  unless product changes them separately.

Only the behavior belongs in ADR-0137. Every number above remains editable in
`apps/api/worker/billing/catalog.ts` and generated Autumn products.

### New Free account

The auto-enabled Free plan creates a local storage projection with zero observed
bytes and growth allowed. The user can create workspaces, enroll replicas, sync
records, and upload blobs through any Free-supported upload path. Reads and
deletions never depend on the projection being fresh.

### Free reaches the allowance

A completed workspace request reports its authority's absolute physical size.
Blob reconciliation reports the account's absolute listed object bytes. Once
their reconciled sum reaches or exceeds the allowance, the local projection
sets `growthAllowed` to false.

The following remain available:

- reads, downloads, and export;
- record deletion and blob deletion;
- workspace deletion; and
- protocol work that only installs already-confirmed outcomes locally.

The following stop:

- any sealed round containing `create` or `update`;
- new blob uploads;
- workspace creation; and
- replica enrollment.

Queued local edits are not discarded. After enough physical space is reclaimed
and observed, or after the account upgrades, later sync retries can grow again.
There is no promise of instant unblocking after one small deletion.

### Mixed sync rounds

The rule is deliberately syntactic and binary:

```txt
growth allowed      accept the ordinary sealed round
delete-only state   accept only a round made entirely of delete intents
delete-only state   reject every mixed, create-only, or update-only round
```

The authority does not estimate post-transaction bytes, classify shrinking
updates, or partially fold a mixed round. A definitive capacity response does
not advance the authority receipt. The client reopens the rejected sealed
round, reseals deletions first, and leaves every create or update queued. If the
capacity response is lost, the client retries the original sealed digest until
it receives that definitive response. This capacity admission result is a
deployment refusal before ordinary RowIntent folding, not a semantic RowIntent
outcome.

### Paid to Free downgrade

The plan projection switches to Free without mutating stored data or recording
debt. If observed bytes already meet or exceed the Free allowance, growth stops
when the downgrade is projected. Reads, exports, and deletion continue. An
upgrade restores growth as soon as the local plan change is projected, without
waiting for storage to shrink. Deletion restores growth only after the lower
physical total is observed.

### Concurrent workspaces

Two or more workspace authorities may each pass the same stale account gate and
commit bounded rounds. Epicenter absorbs that overshoot. Each response publishes
an absolute authority observation, so reconciliation converges without replaying
deltas or assigning debt. Request-size ceilings, enrollment throttles, upload
ceilings, and the reconciliation cadence must bound operational exposure; they
do not make the customer quota exact.

## Ownership and target shape

### Cloud storage policy

Add one Cloud-owned module under `apps/api/worker/storage/`. It owns:

- a narrowly named storage-observation registry keyed by principal and source;
- the derived account total and local growth decision;
- catalog-policy resolution for the active subscription;
- reconciliation of workspace and blob observations;
- absolute Autumn usage publication; and
- the storage summary returned to the dashboard.

This is not a revival of the deleted generic `durable_object_instance` telemetry
table. Every persisted field must have an immediate reader in reconciliation,
admission, or the dashboard. Prefer two explicit relational concepts:

```txt
storage_observation
  principal_id, source_kind, source_id, observed_bytes, observed_at

storage_account_projection
  principal_id, observed_bytes, growth_allowed, policy_observed_at,
  usage_reconciled_at
```

The exact Drizzle column types and indexes are implementation mechanics. Do not
copy included bytes or prices into authority storage. A workspace deletion
removes its observation in the same Cloud workflow. Stale-source cleanup may
only follow authoritative workspace deletion, never elapsed time.

Projection reads have one failure rule: unknown or unavailable state cannot
authorize growth. The caller receives a retryable service response. Read and
deletion routes never depend on this row, so a projection failure cannot trap
the account's data.

### Workspace authority

The row authority exposes its absolute `databaseSize` beside the sync result and
after the authority transaction completes. The Cloud records that observation
after the response through the existing after-response lifetime. The
self-hosted composition ignores the observation and supplies no account gate.

The portable records route gains an injected admission callback with a small
deployment-neutral vocabulary, such as `allowGrowth` or `deleteOnly`. It does
not import billing code. Enrollment uses the same local Cloud decision and a
separate operational throttle.

SQLite physical usage is page-granular. Current workerd computes
`databaseSize` from allocated pages excluding freelist pages. Repository
implementation tests must still prove the final row-authority schema because
receipt, outcome, and index writes can offset a small deletion.

### Blob store

Keep S3 as the blob index. Do not add a blob metadata row, upload session,
reservation ledger, event stream, or confirmation lifecycle. The Cloud obtains
absolute blob bytes by listing the principal prefix on blob activity and by a
scheduled reconciliation pass. Deletion remains allowed regardless of growth
state.

Before Free blob uploads ship, prove that the existing portable presigned PUT
can bind the declared content length and that R2 rejects a different actual
length from browser and Tauri clients. The current path binds checksum and
content type but does not yet prove the claimed byte count. Its general object
ceiling is 5 GiB, so trusting the claim would make reconciliation overshoot
unacceptably large.

Recommended fallback if that proof fails: keep new Free blob uploads disabled
while retaining blob reads, downloads, listing, and deletion. Do not build a
Free-only proxy upload path or a second multipart policy. Paid direct uploads
remain available and all blob bytes still count toward the shared meter.

### Billing provider and dashboard

Use Autumn's direct balance usage update for the non-consumable storage feature,
not incremental `track` events. A retry writes the same absolute total. Provider
failure does not block data requests; it leaves reconciliation pending and is
logged at its source.

The dashboard reads the Cloud projection for current observed bytes and the
catalog for included bytes. It labels usage as observed rather than real-time.
No per-workspace breakdown, byte history chart, cleanup recommendations, or
customer-configurable cap ships in this wave.

## External evidence

- Cloudflare exposes the current SQLite byte count as
  [`ctx.storage.sql.databaseSize`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#databasesize).
- Cloudflare documents presigned R2 support for GET, HEAD, PUT, and DELETE, but
  not POST form policies, and documents signed content type rather than a byte
  range in its [presigned URL guidance](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- Autumn recommends overwriting usage directly for non-consumable features when
  the application owns the source of truth in its
  [usage tracking guidance](https://docs.useautumn.com/documentation/customers/tracking-usage).

## Explicit refusals

- No logical user-owned byte meter.
- No separate enforcement and billing meters.
- No per-app, per-workspace, per-table, per-replica, or per-device allowance.
- No remaining-byte distribution, distributed reservation, or central write
  coordinator.
- No overshoot debt, later clawback, automatic deletion, or storage expiry.
- No partial acceptance or net-byte simulation for a mixed sealed round.
- No attempt to recognize a shrinking update. Delete is the only growth-safe
  RowIntent kind while blocked.
- No paid hard quota in addition to included storage plus overage.
- No read-only replica type, replica eviction lifecycle, or inactive-replica
  expiry.
- No exact or instant unblock promise after deletion.
- No second blob index, upload receipt database, or Free-only upload transport.
- No allowance or price value in an ADR.

## Implementation path

### Wave 0: Prove the unstable edges

1. Add a live R2 experiment for a presigned PUT whose signed content length
   differs from the uploaded body. Run it from the browser and Tauri HTTP paths.
   Record whether R2 rejects the mismatch.
2. Add a focused final-schema authority test that records `databaseSize` before
   insertion, after insertion, after small and bulk deletion, and after restart.
   Prove that sufficient record deletion lowers the observation without vacuum.
3. Exercise Autumn's non-consumable direct usage update in test mode. Prove that
   setting the same absolute value twice is idempotent and that lowering the
   value after deletion updates usage rather than recording a negative event.
4. Measure the largest bounded growth operation and reconciliation latency.
   Select operational sync, upload, enrollment, and cadence values that make
   absorbed overshoot acceptable. Keep those values out of ADR-0137.

Do not start later waves until the blob result selects the one supported Free
upload behavior and the measured operational envelope makes "bounded" honest.

### Wave 1: Capture policy and catalog

1. Accept ADR-0137 with the implementation wave.
2. Set Free `includedBytes` to `100_000_000` and keep storage overage disabled.
3. Add one deployment-neutral capacity error that distinguishes a retryable
   transport failure from the definitive delete-only admission response.
4. Clarify ADR-0131 during its acceptance pass: deployment capacity admission
   may refuse a sealed round before folding without adding semantic RowIntent
   rejection history.

### Wave 2: Build the Cloud projection

1. Add the narrowly named observation and account-projection schema with a
   generated migration.
2. Build one storage service that upserts absolute observations, recomputes the
   account sum, resolves the active catalog policy, and exposes the local
   growth decision.
3. Project plan changes into the same account row. Upgrade must reopen growth;
   downgrade must never mutate storage or create debt.
4. Add scheduled and activity-triggered reconciliation with source-local error
   logging. Do not make Autumn availability part of request admission.

### Wave 3: Gate row growth

1. Return absolute authority `databaseSize` beside enrollment and sync results.
2. Inject the Cloud growth decision into records enrollment and round admission;
   leave the self-hosted composition policy-free.
3. In delete-only state, accept all-delete rounds and refuse every other sealed
   round without advancing its receipt.
4. Teach the replica to reopen a definitively refused round, reseal deletions
   first, and preserve other intents for later. Preserve exact retry until the
   definitive response arrives.
5. Publish the resulting absolute workspace observation after the response.

### Wave 4: Gate and reconcile blobs

1. Inject the same Cloud growth decision into upload-ticket admission. Never
   gate GET, HEAD-equivalent list/download, or DELETE.
2. If Wave 0 proves signed length enforcement, apply the measured Free upload
   ceiling to the existing presigned PUT path. If it does not, refuse new Free
   upload tickets with the explicit capacity/product response.
3. Sum actual object sizes from the S3 listing. Reconcile after blob activity
   and through the scheduled sweep so abandoned successful PUTs are eventually
   observed.
4. Keep content-addressed duplicate hits growth-free and available while the
   account is blocked.

### Wave 5: Report billing and UI usage

1. Overwrite Autumn `storage_bytes` usage from the reconciled absolute total.
2. Read observed bytes from the Cloud projection in the billing overview and
   included bytes from the active catalog plan.
3. Show one approximate account-wide storage value and the delete-or-upgrade
   recovery message. Do not expose source-level accounting.

### Wave 6: Verify the policy as a state machine

Cover these scenarios at route, service, and protocol boundaries:

- a new no-card Free account can grow from zero;
- crossing the allowance changes only growth admission;
- an all-delete sealed round remains admissible while blocked;
- a mixed round is refused whole, then deletion reseals ahead of queued growth;
- a lost capacity response retries the original digest;
- enough deletion lowers observed physical bytes and eventually reopens growth;
- a paid-to-Free downgrade preserves oversized data and creates no debt;
- an upgrade reopens growth once the local plan change is projected, without
  waiting for storage to shrink;
- concurrent workspaces overshoot, converge from absolute observations, and
  never create a negative balance;
- workspace deletion removes its source observation;
- replica enrollment is blocked while existing replicas can read and delete;
- blob deletion and duplicate lookup remain available while blocked;
- a claimed blob size cannot bypass the supported Free upload ceiling; and
- Autumn or reconciliation failure does not turn a readable account into an
  outage or silently discard queued edits.

### Wave 7: Stop the old story and delete scaffolding

1. Remove comments and tests that describe hosted blobs as permanently
   unmetered.
2. Delete or replace stale storage-billing specs whose paths and ownership no
   longer match the implementation.
3. Run repository type, test, migration, license, and documentation hygiene
   gates.
4. Accept ADR-0137, delete this spent spec, and add the result to git history.

## Success criteria

- Free has permanent no-card hosted storage at the catalog allowance and can
  never incur storage charges or debt.
- One reconciled physical total drives the growth gate, paid billing usage, and
  the dashboard.
- At the Free limit, every read and explicit deletion path works while every
  storage-growing path is closed.
- Mixed rounds preserve all user intent without partial authority acceptance.
- Downgrade never deletes data; deletion or upgrade restores growth.
- Concurrent operations can overshoot only within the measured operational
  envelope, and Epicenter absorbs that cost.
- Shared server code remains deployment-neutral and self-hosting gains no Cloud
  billing dependency.
- No reservation ledger, logical-byte attribution, second blob index, or
  provider call on the sync request path exists.

## Remaining pressure point

The only unresolved product edge is whether R2 can enforce the actual size of
the existing direct presigned upload. This is not permission to add another
upload architecture. Wave 0 resolves it to one of two outcomes: the same
portable path supports bounded Free uploads, or Free launches without new blob
uploads while every existing blob remains durable and recoverable.
