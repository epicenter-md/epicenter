# Phase 4: Storage Billing

**Position**: Phase 4 of 4
**Dependencies**: Phase 1 (Autumn SDK installed, customer sync working)
**Estimated effort**: ~2-3 days
**Spec**: [Master plan](./20260319T140000-autumn-billing-overview.md)

## Goal

Bill users for Durable Object storage (workspace + document data). After this phase:
- Storage is tracked as a cumulative Autumn metered feature (`consumable: false`)
- Free plan includes a storage allowance (e.g., 50 MB)
- Pro plan includes more storage (e.g., 5 GB) with overage billing
- Users who exceed their allowance get blocked from creating new workspaces/documents (or get a warning)

## Current State

**What already exists** (this is a strength. We're not starting from zero):

- `apps/api/src/db/schema.ts` defines `durableObjectInstance` with `storageBytes` (bigint), `storageMeasuredAt` (timestamp)
- `apps/api/src/app.ts` has `upsertDoInstance()` that records `storageBytes` on every workspace/document access
- Every GET, POST (sync), and WebSocket upgrade to a workspace or document already triggers `upsertDoInstance` with the current `storageBytes` value
- Storage bytes come from the DO itself: `stub.getDoc()` returns `{ data, storageBytes }` and `stub.sync()` returns `{ diff, storageBytes }`

**What's missing**:
- No Autumn feature for storage
- No aggregation of per-DO bytes into per-user totals
- No limits or billing on storage usage
- No user-facing storage indicator in the UI

## Design: Hybrid Approach

We use the **existing DB-level storage tracking** (already works, real-time) and **periodically sync totals to Autumn** (handles limits and billing).

### Why not track every byte change in Autumn directly?

- `upsertDoInstance` fires on every single DO access (GET, POST sync, WebSocket). That's potentially hundreds of calls per session.
- Autumn's `track()` is an HTTP call (~50ms). Adding it to every DO operation would add unacceptable latency.
- Storage doesn't need sub-second billing accuracy. A periodic sync (every few minutes or on significant changes) is fine.

### Why not skip Autumn and just use the DB?

- Autumn handles the limits, billing, and upgrade flow. Without it, you'd need to build your own "storage exceeded" logic, plan-aware limits, and Stripe billing integration.
- Autumn's `check()` already gates access. Reusing the same pattern as AI credits keeps the system consistent.

### The design

```
DO access → upsertDoInstance (existing, real-time)
                    ↓
        durableObjectInstance table (per-DO bytes)
                    ↓
        Periodic aggregation job (new)
                    ↓
        SUM(storageBytes) per user → autumn.track({ featureId: 'storage-bytes', value: totalBytes })
                    ↓
        Autumn handles limits + billing
                    ↓
        On workspace/document creation → autumn.check({ featureId: 'storage-bytes' })
                    ↓
        Allowed? → create. Denied? → 402 "storage limit reached"
```

## Autumn Feature Configuration

Add to `apps/api/autumn.config.ts`:

```ts
/**
 * Storage metering: cumulative, does not reset monthly.
 * `consumable: false` means Autumn treats this as persistent allocation
 * (like seats or storage), not event-based usage.
 */
export const storageBytes = feature({
  id: 'storage-bytes',
  name: 'Storage',
  type: 'metered',
  consumable: false,
});
```

Update plan items:

```ts
// Free plan: add storage allowance
export const free = plan({
  id: 'free',
  name: 'Free',
  group: 'main',
  autoEnable: true,
  items: [
    item({ featureId: aiCredits.id, included: 50, reset: { interval: 'month' } }),
    item({ featureId: storageBytes.id, included: 50_000_000 }), // 50 MB, no reset
  ],
});

// Pro plan: add storage allowance with overage
export const pro = plan({
  id: 'pro',
  name: 'Pro',
  group: 'main',
  price: { amount: 20, interval: 'month' },
  items: [
    item({
      featureId: aiCredits.id,
      included: 2000,
      reset: { interval: 'month' },
      price: { amount: 1, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
    }),
    item({
      featureId: storageBytes.id,
      included: 5_000_000_000, // 5 GB
      price: { amount: 1, billingUnits: 1_000_000_000, billingMethod: 'usage_based', interval: 'month' }, // $1/GB overage
    }),
  ],
});
```

**Note**: The exact storage limits (50 MB free, 5 GB pro) are placeholders. Adjust based on actual usage patterns.

## Implementation Plan

### Step 1: Add storage feature to `autumn.config.ts`

- [ ] **1.1** Add `storageBytes` feature definition (`consumable: false`)
- [ ] **1.2** Add storage items to free and pro plans
- [ ] **1.3** Run `atmn push` to sync to Autumn dashboard

### Step 2: Create storage aggregation function

- [ ] **2.1** Create `apps/api/src/aggregate-user-storage.ts`

This function queries the `durableObjectInstance` table, sums `storageBytes` per user, and reports the total to Autumn.

```ts
import type { Autumn } from 'autumn-js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sum } from 'drizzle-orm';
import * as schema from './db/schema';

/**
 * Aggregate total storage bytes for a user and report to Autumn.
 *
 * Queries all DO instances for the user, sums their storageBytes,
 * and calls autumn.track with the total. Autumn uses this to enforce
 * storage limits and calculate overage billing.
 *
 * For `consumable: false` features, the `value` in track() represents
 * the CURRENT total, not a delta. Autumn maintains the high-water mark.
 */
export async function syncUserStorageToAutumn(
  db: NodePgDatabase<typeof schema>,
  autumn: Autumn,
  userId: string,
) {
  const result = await db
    .select({ total: sum(schema.durableObjectInstance.storageBytes) })
    .from(schema.durableObjectInstance)
    .where(eq(schema.durableObjectInstance.userId, userId));

  const totalBytes = Number(result[0]?.total ?? 0);

  await autumn.track({
    customerId: userId,
    featureId: 'storage-bytes',
    value: totalBytes,
  });

  return totalBytes;
}
```

**Important question**: For `consumable: false`, does Autumn's `track()` expect the current total or a delta? This needs verification against Autumn docs. If it expects a delta, the function needs to track the last-reported value and compute the difference. If it expects the absolute total (like a gauge), the above is correct.

### Step 3: Wire storage sync into existing flows

Two strategies (pick one):

**Strategy A: Sync on DO access (piggyback on existing upsertDoInstance)**

- [ ] **3A.1** After `upsertDoInstance` completes, push `syncUserStorageToAutumn` to afterResponse
- [ ] **3A.2** Add debouncing. Don't sync on every single request. Track a `lastSyncedAt` timestamp per user and only sync if >5 minutes have passed.

**Strategy B: Scheduled job (Cloudflare Cron Trigger)**

- [ ] **3B.1** Add a cron trigger to `wrangler.jsonc` (e.g., every 15 minutes)
- [ ] **3B.2** In the cron handler, query all users with `storageBytes` changes since last sync
- [ ] **3B.3** For each changed user, call `syncUserStorageToAutumn`

**Recommendation**: Strategy A for v1. It's simpler. No new cron infrastructure. The debounce ensures we don't over-call Autumn. Strategy B is better at scale but adds operational complexity.

### Step 4: Gate workspace/document creation

- [ ] **4.1** Before creating a new workspace or document, check storage entitlement:

```ts
const { allowed } = await autumn.check({
  customerId: c.var.user.id,
  featureId: 'storage-bytes',
});

if (!allowed) {
  return c.json({ error: 'StorageLimitReached', message: 'Upgrade your plan for more storage' }, 402);
}
```

- [ ] **4.2** Decide WHERE to gate: on first access to a new workspace/document name? Or on a dedicated "create workspace" endpoint? Currently, workspaces are created implicitly on first access (the DO creates itself). Options:
  - **Option A**: Check on first WebSocket connect / first sync to a new DO name. If the user is over their storage limit, reject the connection.
  - **Option B**: Add an explicit "create workspace" / "create document" endpoint that checks storage first.
  - **Recommendation**: Option A for v1. It requires no new endpoints and catches the creation point.

### Step 5: Push config and test

- [ ] **5.1** Run `atmn push` to sync updated plans
- [ ] **5.2** Verify storage feature appears in Autumn dashboard
- [ ] **5.3** Test: user with storage near limit → create new workspace → should succeed or fail based on limit
- [ ] **5.4** Test: verify storage total in Autumn dashboard matches DB sum

## Open Questions (decide during implementation)

1. **Track absolute total or delta?** Need to verify Autumn's `track()` behavior for `consumable: false` features.
2. **What storage limits for free/pro?** 50 MB / 5 GB are placeholders. Check actual usage patterns first.
3. **Hard gate or soft warning?** Should exceeding storage block creation (hard) or just warn (soft)?
4. **Include snapshots in storage count?** Snapshots are stored in DO SQLite. The `storageBytes` from `stub.getDoc()` may or may not include them.
5. **Sync frequency?** 5-minute debounce? Per-request? Cron? Depends on acceptable billing lag.

## Verification Checklist

- [ ] `storage-bytes` feature in `autumn.config.ts` with `consumable: false`
- [ ] Free and Pro plans include storage allowances
- [ ] `atmn push` succeeds with updated config
- [ ] Storage aggregation function correctly sums per-user bytes
- [ ] Storage total syncs to Autumn (visible in dashboard)
- [ ] Storage-exceeded user blocked from creating new workspaces/documents
- [ ] `lsp_diagnostics` clean on all modified files

## What comes next

After all 4 phases:
- AI chat is gated behind credits ✓
- Backend billing routes exist ✓
- Users can see credits, upgrade, manage billing ✓
- Storage is metered and billed ✓

Future enhancements (not part of this spec set):
- Per-token billing (balance locking)
- Per-workspace quotas (sub-entity balances)
- Auto top-ups, spend limits
- Dedicated analytics table for usage data
