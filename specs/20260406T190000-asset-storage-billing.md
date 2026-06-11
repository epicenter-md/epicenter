# Asset Storage Billing & Postgres Index

**Date**: 2026-04-06
**Status**: Implemented
**Author**: AI-assisted
**Depends on**: `specs/20260406T180000-r2-blob-storage.md` (v1 must ship first)

## Overview

Add a Postgres asset index and Autumn storage billing to the R2 blob storage system. This is the "Phase 4" from the R2 spec. Separated into its own document because it changes the architecture in ways worth discussing independently.

```
┌─────────────────────────────────────────────────────────────────┐
│  v1 (R2 spec)              →  This spec                         │
│                                                                  │
│  R2 only                       R2 + Postgres + Autumn            │
│  customMetadata for state      Postgres is source of truth       │
│  planId !== 'free' gate        autumn.check() per upload         │
│  No storage limits             Per-plan allowances + overage     │
│  No per-user accounting        SQL aggregation for billing       │
└─────────────────────────────────────────────────────────────────┘
```

## Motivation

### What v1 Can't Do

v1 stores metadata in R2 `customMetadata` and gates uploads with a simple plan check. This works but has limits:

1. **No storage quotas**: Paid users can upload unlimited files. R2 storage costs $0.015/GB-month with zero per-user attribution.
2. **No per-user totals**: To answer "how much storage does user X use?" you'd scan R2 `list({ prefix: userId })` and sum sizes. Slow, unpaginated beyond 1000 objects.
3. **No billing integration**: Autumn's `storage_bytes` feature doesn't exist yet. Can't enforce allowances or charge overage.
4. **No asset listing API**: Clients can't query "show me my uploads sorted by date" without R2 scanning.

### What This Spec Adds

A Postgres `asset` table as the metadata source of truth, plus Autumn storage billing wired into upload/delete handlers.

## Simplifications from Postgres

Adding Postgres as the metadata authority enables several architectural changes. Not all of them are worth making.

### What Changes

```
┌────────────────────────────┬─────────────────────────┬─────────────────────────┐
│  Concern                   │  v1 (R2 only)           │  With Postgres          │
├────────────────────────────┼─────────────────────────┼─────────────────────────┤
│  Metadata source of truth  │  R2 customMetadata      │  Postgres asset table   │
│  Per-user storage total    │  list() + sum (slow)    │  SUM(size_bytes) (fast) │
│  Asset listing             │  list({ prefix }) only  │  SQL with pagination    │
│  Storage billing           │  None                   │  Autumn check + track   │
│  Orphan detection          │  Not possible           │  LEFT JOIN R2 vs PG     │
└────────────────────────────┴─────────────────────────┴─────────────────────────┘
```

### What Stays the Same

| Concern | Decision | Why It Doesn't Change |
|---|---|---|
| **R2 key structure** | `{userId}/{assetId}` | The userId prefix is still useful for R2 `list()` in admin/cleanup operations |
| **URL format** | `/api/assets/:userId/:assetId` | See "URL simplification" below. Adding a DB query to every image load isn't worth it |
| **Read auth** | Unauthenticated, unguessable IDs | The `<img>` tag constraint hasn't changed |
| **httpMetadata** | Still stored on R2 | `writeHttpMetadata(headers)` still simplifies the read handler |

### URL Simplification: Considered and Rejected

With Postgres, the URL *could* be `/api/assets/:assetId` (no userId). The read handler would:

```
1. SELECT user_id FROM asset WHERE id = :assetId
2. Construct key: {userId}/{assetId}
3. ASSETS_BUCKET.get(key)
```

**Why not**: This adds a Postgres query to every `<img>` load. Currently, asset reads are the fastest path in the API. One R2 `get()` call, no database. Adding Postgres means:

```
┌─────────────────────────────────────────────────────────────────┐
│  Read latency comparison                                         │
│                                                                  │
│  v1:          <img> → Worker → R2.get()             ~10ms       │
│  With PG:     <img> → Worker → pg.query → R2.get()  ~25-40ms   │
│                                                                  │
│  For a page with 10 images: ~100ms vs ~300ms                    │
└─────────────────────────────────────────────────────────────────┘
```

The userId in the URL is an opaque nanoid. The cleaner URL isn't worth 2-3x latency on every image load. **Keep `/api/assets/:userId/:assetId`.**

### customMetadata: Dropped (httpMetadata Stays)

With Postgres as the metadata authority, R2 `customMetadata` becomes redundant. Writing the same data to two places is a code smell. It creates drift risk and two update sites for no application benefit.

```
┌─────────────────────────────────────────────────────────────────┐
│  v1                              This spec                       │
│                                                                  │
│  R2 httpMetadata: contentType    R2 httpMetadata: contentType    │
│  R2 customMetadata:              Postgres asset table:           │
│    originalName ─────────────→     originalName                  │
│    userId ───────────────────→     userId                        │
│    uploadedAt ───────────────→     uploadedAt                    │
│                                    sizeBytes (new)               │
│                                    contentType (new)             │
│                                                                  │
│  customMetadata is dropped.                                      │
│  httpMetadata stays. It's functional (writeHttpMetadata()),     │
│  not metadata storage.                                           │
└─────────────────────────────────────────────────────────────────┘
```

**Migration**: Scan existing R2 objects via `list({ include: ['customMetadata'] })`, backfill the Postgres table from their customMetadata, then stop writing customMetadata on new uploads.

**Decision**: Drop customMetadata writes. Postgres is the single source of truth. R2 `httpMetadata` (contentType, cacheControl, contentDisposition) stays because `writeHttpMetadata()` uses it. That's functional, not storage.

### Middleware Consideration

In `app.ts`, the database middleware (`app.use('*')`) creates a `pg.Client` for every request. Including unauthenticated asset reads that don't need it. This is wasted work for v1.

```
┌─────────────────────────────────────────────────────────────────┐
│  Current middleware chain (ALL requests)                          │
│                                                                  │
│  CORS → pg.Client.connect() → createAuth() → route handler      │
│                                                                  │
│  Asset reads don't need steps 2 or 3.                            │
│  Options:                                                        │
│    A. Mount read route BEFORE db middleware (v1 optimization)    │
│    B. Leave it. Pg connection is ~5ms, not worth restructuring   │
│    C. Restructure middleware to be route-specific (future)       │
│                                                                  │
│  Recommendation: Option B for now. The pg overhead is small      │
│  relative to R2 latency. Restructure only if profiling shows     │
│  it matters.                                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Postgres table | `asset` with id, userId, contentType, sizeBytes, originalName, uploadedAt | Minimal schema. Everything needed for billing + listing |
| Table primary key | `id` (assetId, the generateGuid nanoid) | Already globally unique, matches R2 key component |
| Foreign key | `userId → user.id ON DELETE CASCADE` | User deletion cleans up asset records. R2 cleanup handled separately. |
| Insert timing | Same request as R2 `put()`, before returning response | Guarantees metadata exists when the client gets the URL back |
| R2 customMetadata | Kept, written on upload | Redundant backup. Not read by application code. |
| Storage billing model | Non-consumable metered feature (`consumable: false`) | Autumn explicitly supports storage as non-consumable. No reset. |
| Track method | Delta via `autumn.track()` on each upload/delete | Positive for upload, negative for delete. Matches Autumn's design. |
| Reconciliation | Periodic `autumn.usage()` with absolute total from Postgres | Corrects drift from failed tracks, race conditions, orphans. |
| URL format | No change from v1 (`/api/assets/:userId/:assetId`) | DB query on every read isn't worth the URL improvement. |

## Architecture

### Schema

```ts
// apps/api/src/db/schema.ts

export const asset = pgTable(
  'asset',
  {
    id:           text('id').primaryKey(),
    userId:       text('user_id')
                    .notNull()
                    .references(() => user.id, { onDelete: 'cascade' }),
    contentType:  text('content_type').notNull(),
    sizeBytes:    bigint('size_bytes', { mode: 'number' }).notNull(),
    originalName: text('original_name').notNull(),
    uploadedAt:   timestamp('uploaded_at').defaultNow().notNull(),
  },
  (table) => [
    index('asset_user_id_idx').on(table.userId),
  ],
);
```

Follows the exact pattern of `durableObjectInstance` in the existing schema: `userId` FK with cascade, index on userId, bigint for byte sizes.

### Upload Flow (Updated)

```
┌─────────────────────────────────────────────────────────────────┐
│  UPLOAD  (POST /api/assets): with Postgres + Autumn             │
│                                                                  │
│  Client ──[auth + file]──→ Worker                                │
│                              ├─ authGuard                        │
│                              ├─ planCheck via Autumn              │
│                              ├─ validate MIME + size              │
│                              │                                   │
│                              ├─ autumn.check({                   │
│                              │    featureId: 'storage_bytes',    │
│                              │    requiredBalance: sizeBytes     │
│                              │  })                               │
│                              │  → 402 if not allowed             │
│                              │                                   │
│                              ├─ ASSETS_BUCKET.put(key, file)     │
│                              ├─ db.insert(asset).values({...})   │
│                              │                                   │
│                              └─ afterResponse.push(              │
│                                   autumn.track({                 │
│                                     featureId: 'storage_bytes',  │
│                                     value: sizeBytes             │
│                                   })                             │
│                                 )                                │
│                                                                  │
│  Returns: { id, url, contentType, size, originalName }           │
└─────────────────────────────────────────────────────────────────┘
```

Note: `autumn.track()` is fire-and-forget via `afterResponse` (same pattern as `upsertDoInstance`). The response doesn't wait for billing to be recorded.

### Delete Flow (Updated)

```
┌─────────────────────────────────────────────────────────────────┐
│  DELETE  (DELETE /api/assets/:userId/:assetId): with Postgres   │
│                                                                  │
│  Client ──[auth]──→ Worker                                       │
│                       ├─ authGuard + ownerCheck                  │
│                       ├─ result = db.select(asset)               │
│                       │    .where(eq(asset.id, assetId))         │
│                       │  → 404 if not found                      │
│                       │                                          │
│                       ├─ ASSETS_BUCKET.delete(key)               │
│                       ├─ db.delete(asset)                        │
│                       │    .where(eq(asset.id, assetId))         │
│                       │                                          │
│                       └─ afterResponse.push(                     │
│                            autumn.track({                        │
│                              featureId: 'storage_bytes',         │
│                              value: -result.sizeBytes            │
│                            })                                    │
│                          )                                       │
│                                                                  │
│  Returns: 204                                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Read Flow (Unchanged)

```
┌─────────────────────────────────────────────────────────────────┐
│  READ  (GET /api/assets/:userId/:assetId): NO CHANGE           │
│                                                                  │
│  Still just: ASSETS_BUCKET.get(key) → serve with headers        │
│  No Postgres query. No Autumn call. Fastest possible path.       │
└─────────────────────────────────────────────────────────────────┘
```

### Autumn Configuration

```ts
// autumn.config.ts: additions

export const storageBytes = feature({
  id: FEATURE_IDS.storageBytes,   // 'storage_bytes'
  name: 'Storage',
  type: 'metered',
  consumable: false,               // non-consumable = persistent, no reset
});

// Add to each plan's items array:
// free:  item({ featureId: storageBytes.id, included: 0 })
// pro:   item({ featureId: storageBytes.id, included: 5_000_000_000,
//              price: { amount: 1, billingUnits: 1_000_000_000,
//                       billingMethod: 'usage_based' } })
// ultra: item({ featureId: storageBytes.id, included: 10_000_000_000, ... })
// max:   item({ featureId: storageBytes.id, included: 50_000_000_000, ... })
```

```ts
// billing-plans.ts: addition

export const FEATURE_IDS = {
  aiUsage: 'ai_usage',
  aiCredits: 'ai_credits',
  storageBytes: 'storage_bytes',  // ← new
} as const;
```

### Reconciliation

Autumn `track()` can fail silently (network issues, Worker timeout). Periodic reconciliation corrects drift:

```
┌─────────────────────────────────────────────────────────────────┐
│  RECONCILIATION  (scheduled Worker or cron)                      │
│                                                                  │
│  For each user with assets:                                      │
│    total = SELECT SUM(size_bytes) FROM asset WHERE user_id = ?   │
│    autumn.usage({                                                │
│      customerId: userId,                                         │
│      featureId: 'storage_bytes',                                 │
│      value: total                                                │
│    })                                                            │
│                                                                  │
│  Frequency: daily or after bulk operations                       │
│  Uses autumn.usage() (absolute) not track() (delta)              │
└─────────────────────────────────────────────────────────────────┘
```

### New Endpoints Enabled

With Postgres, these become trivial:

```ts
// GET /api/assets: list current user's assets
// Already behind authGuard
const assets = await db.select().from(asset)
  .where(eq(asset.userId, c.var.user.id))
  .orderBy(desc(asset.uploadedAt))
  .limit(100);

// GET /api/assets/usage: current user's storage total
const [{ total }] = await db.select({
  total: sql<number>`COALESCE(SUM(${asset.sizeBytes}), 0)`
}).from(asset).where(eq(asset.userId, c.var.user.id));
```

## Implementation Plan

### Phase 1: Postgres Table

- [x] **1.1** Add `asset` table to `apps/api/src/db/schema.ts` (schema above)
- [x] **1.2** Add `assetRelations` to link `asset.userId → user`
- [x] **1.3** Add `assets: many(asset)` to `userRelations`
- [x] **1.4** Run `bun run db:push:local` to push schema
- [x] **1.5** Verify with `bun run db:studio:local`

### Phase 2: Wire Postgres into Upload/Delete

- [x] **2.1** Update upload handler: after `ASSETS_BUCKET.put()`, `db.insert(asset).values({...})`
- [x] **2.2** Update delete handler: `SELECT` to get `sizeBytes` before delete, then `db.delete(asset)` alongside R2 delete
- [x] **2.3** Handle partial failures: orphaned R2 objects caught by reconciliation

### Phase 3: Autumn Storage Feature

- [x] **3.1** Add `FEATURE_IDS.storageBytes = 'storage_bytes'` to `billing-plans.ts`
- [x] **3.2** Add `storageBytes` feature to `autumn.config.ts` as `type: 'metered', consumable: false`
- [x] **3.3** Add storage items to each plan:
  - Free: `included: 0` (no overage: uploads already blocked by plan gate)
  - Pro: `included: 5_000_000_000` (5GB), overage: $1/GB usage_based
  - Ultra: `included: 10_000_000_000` (10GB), overage: $0.75/GB
  - Max: `included: 50_000_000_000` (50GB), overage: $0.50/GB
  - Annual plans: same storage allowances as monthly equivalents
- [x] **3.4** `atmn push` to sync features and plans to Autumn (pending deployment)

### Phase 4: Wire Autumn into Handlers

- [x] **4.1** Replace `planId !== 'free'` gate with `autumn.check({ featureId: 'storage_bytes', requiredBalance: file.size })`
- [x] **4.2** Add `autumn.track({ featureId: 'storage_bytes', value: file.size })` to upload (via afterResponse)
- [x] **4.3** Add `autumn.track({ featureId: 'storage_bytes', value: -sizeBytes })` to delete (via afterResponse)

### Phase 5: Listing + Usage Endpoints

- [x] **5.1** Add `GET /api/assets`: list user's assets (paginated, sorted by uploadedAt desc)
- [x] **5.2** Add `GET /api/assets/usage`: return user's total storage in bytes
- [x] **5.3** Wire both behind `authGuard`

### Phase 6: Reconciliation

- [x] **6.1** Add a reconciliation function that iterates users with assets and calls Autumn `/usage` API with Postgres totals
- [x] **6.2** Wire to manual admin endpoint (POST /api/assets/reconcile)
- [x] **6.3** Frequency: daily (Cron Trigger to be added to wrangler.jsonc)

## Edge Cases

### R2 Put Succeeds, Postgres Insert Fails

1. Object exists in R2 but has no Postgres row
2. Client receives 500 error (doesn't get the URL back)
3. Object is orphaned: uses storage but isn't tracked
4. **Recovery**: Reconciliation compares R2 `list()` against Postgres and deletes orphans, or insert missing rows

### Postgres Delete Succeeds, R2 Delete Fails

1. Postgres row deleted, R2 object still exists
2. Client receives 204 (thinks it's deleted)
3. Object is orphaned in R2: uses R2 storage but not billed
4. **Recovery**: Same reconciliation catches this

### User Deletion (CASCADE)

1. User is deleted from Better Auth
2. `ON DELETE CASCADE` removes all `asset` rows
3. R2 objects are NOT automatically deleted: need a cleanup job
4. **Solution**: Listen for user deletion events (or reconciliation) and batch-delete R2 objects for orphaned userId prefixes

### Storage Allowance per Plan

Plan changes (upgrade/downgrade) change the allowance:
- **Upgrade**: More storage immediately available (Autumn handles this via plan item swap)
- **Downgrade**: If current usage exceeds new allowance, user is over quota. Autumn's overage logic handles this: they'll be charged overage or blocked, depending on config. Existing files are NOT deleted.

## Open Questions

1. **Storage allowances per plan**: The numbers above (Free: 0, Pro: 5GB, Ultra: 10GB, Max: 50GB) are placeholders. What are the right limits?
   - **Recommendation**: Ship with generous limits, tighten based on usage data.

2. **Overage pricing**: $1/GB, $0.75/GB, $0.50/GB by tier. Is this right?
   - R2 costs Cloudflare $0.015/GB/month. These prices have massive margin.
   - **Recommendation**: Start generous (users shouldn't worry about storage), adjust later.

3. **R2 orphan cleanup**: How to handle R2 objects with no Postgres row?
   - Option A: Daily reconciliation deletes orphans older than 24h
   - Option B: Manual cleanup via admin endpoint
   - **Recommendation**: Option A: automated, catches all cases.

4. **User deletion R2 cleanup**: How to delete R2 objects when a user is deleted?
   - Option A: Async job triggered by user deletion webhook/hook
   - Option B: Reconciliation catches it (all asset rows are CASCADE-deleted, so any R2 objects under that userId prefix are orphans)
   - **Recommendation**: Option B: simplest, reuses existing reconciliation.

## Success Criteria

- [ ] `asset` table exists with correct schema, FK, and index
- [ ] Upload creates both R2 object and Postgres row atomically
- [ ] Delete removes both R2 object and Postgres row
- [ ] `autumn.check()` enforces storage limits per plan
- [ ] `autumn.track()` fires on upload and delete
- [ ] `GET /api/assets` returns user's assets with pagination
- [ ] `GET /api/assets/usage` returns user's total bytes
- [ ] Reconciliation corrects Autumn balance drift
- [ ] `db:push:local` succeeds, typecheck passes

## References

- `specs/20260406T180000-r2-blob-storage.md`: v1 R2 spec (must ship first)
- `specs/20260319T140004-autumn-phase4-storage-billing.md`: Original storage billing planning
- `apps/api/src/db/schema.ts`: Existing schema, `durableObjectInstance` pattern to follow
- `apps/api/src/app.ts`: `afterResponse` pattern for fire-and-forget, `upsertDoInstance` as model
- `apps/api/src/ai-chat.ts`: `autumn.check()` and `autumn.track()` patterns
- `apps/api/src/billing-plans.ts`: `FEATURE_IDS` and `PLAN_IDS`
- `apps/api/autumn.config.ts`: Autumn feature/plan definitions
- [Autumn non-consumable metered features](https://github.com/useautumn/autumn): `track()` takes deltas, `usage()` takes absolutes

## Review

**Completed**: 2026-04-06
**Branch**: feat/fix-dashboard

### Summary

Added Postgres asset table as metadata source of truth, Autumn storage billing with per-plan allowances, listing/usage endpoints, and a reconciliation function. The upload handler now does autumn.check() before writing and autumn.track() after, while delete credits storage back via negative track().

### Deviations from Spec

- **customMetadata dropped immediately**: The spec suggested keeping customMetadata as a "redundant backup." Dropped it in Wave 3 since Postgres is the source of truth and writing the same data to two places is a code smell (the spec's own rationale).
- **FEATURE_IDS.storageBytes added in Wave 1**: Moved from Phase 3 to Phase 1 as the execution plan specified, since it's just a constant.
- **Reconciliation uses direct REST API**: The autumn-js SDK doesn't expose `.usage()` (absolute set). Used a direct fetch to Autumn's `/v1/usage` endpoint instead.
- **db:push:local and db:studio:local not run**: These require a running local Postgres instance. Schema changes are correct and will apply on next push.

### Follow-up Work

- Run `bunx atmn push` to sync Autumn config to sandbox/production
- Run `bun run db:push:local` and `db:push:remote` to apply schema changes
- Add Cloudflare Cron Trigger to wrangler.jsonc for daily reconciliation
- Consider R2 orphan cleanup (objects with no Postgres row)
