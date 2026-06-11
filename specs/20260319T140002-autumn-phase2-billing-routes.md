# Phase 2: Backend Billing Routes

**Position**: Phase 2 of 4
**Dependencies**: Phase 1 (SDK installed, customer sync working)
**Estimated effort**: ~30 minutes
**Spec**: [Master plan](./20260319T140000-autumn-billing-overview.md)

## Goal

Mount Autumn's `autumnHandler` in `apps/api/src/app.ts` so the frontend can call billing APIs (fetch customer state, list plans, attach plans, open billing portal, etc.) without direct access to the Autumn secret key.

After this phase:
- `/api/autumn/*` routes exist and proxy to Autumn's API
- Frontend can fetch customer balances, plan lists, and initiate checkouts
- Phase 3 (Billing UI) is unblocked

## Current State

- Phase 1 completed: `autumn-js` is installed, SDK client works, customer sync is wired
- No frontend-facing billing routes exist
- The AI chat handler calls the SDK directly (correct for server-side gating)
- Frontend has no way to fetch billing data or trigger plan changes

## What `autumnHandler` does

The `autumnHandler` from `autumn-js/hono` creates a set of POST routes under a path prefix. It acts as a secure proxy. The frontend sends requests to your API, the handler resolves the customer via `identify()`, injects the secret key, and forwards to Autumn's API.

Routes created:

| Route | Purpose | Used by |
|-------|---------|---------|
| `POST /api/autumn/customer` | Get customer state (balances, subscriptions) | CreditBalance, UpgradePrompt |
| `POST /api/autumn/plans.list` | List plans with `customerEligibility` data | PricingTable |
| `POST /api/autumn/attach` | Checkout, upgrade, downgrade, purchase | PricingTable, UpgradePrompt |
| `POST /api/autumn/billing.preview_attach` | Preview charges before committing | UpgradePrompt |
| `POST /api/autumn/billing.update` | Cancel/uncancel subscriptions | SubscriptionManager |
| `POST /api/autumn/billing.open_customer_portal` | Get Stripe billing portal URL | BillingPortalButton |
| `POST /api/autumn/events.aggregate` | Usage timeseries data | UsageChart |

## Files to Modify

| File | Action | Purpose |
|------|--------|---------|
| `apps/api/src/app.ts` | Modify | Mount `autumnHandler` + `identify` function |

That's it. One file, one change.

## Implementation

### Step 1: Add the handler to `app.ts`

Add this import at the top:

```ts
import { autumnHandler } from 'autumn-js/hono';
```

Add this route block **after** the auth routes and **before** the `authGuard` declarations. The handler needs to be mounted with its own auth resolution (the `identify` function), not behind `authGuard`:

```ts
// ---------------------------------------------------------------------------
// Billing: Autumn handler proxies frontend billing requests to Autumn API
// ---------------------------------------------------------------------------

app.use(
  '/api/autumn/*',
  autumnHandler({
    identify: async (c) => {
      const session = await c.var.auth.api.getSession({
        headers: c.req.raw.headers,
      });
      return {
        customerId: session?.user.id,
        customerData: {
          name: session?.user.name,
          email: session?.user.email,
        },
      };
    },
  }),
);
```

**Why `identify` instead of reusing `authGuard`**: The `autumnHandler` expects an `identify` function that returns `{ customerId, customerData }`. It handles unauthenticated cases internally (some routes like `plans.list` may work without auth for public pricing pages). Using `authGuard` would 401-reject before the handler gets a chance to decide.

**Why before `authGuard`**: If you place this after `app.use('/ai/*', authGuard)`, it still works because `/api/autumn/*` doesn't match `/ai/*`. But placing it in the auth section keeps routing organized.

### Step 2: Verify the `autumn-js/hono` export

Make sure the `autumn-js` package version (installed in Phase 1) exports the Hono adapter. Check:

```bash
cd apps/api
bun x tsc --noEmit
```

If the import fails, the adapter might be at a different path. Check `node_modules/autumn-js` for the correct export.

### Step 3: Test the routes

After deploying (or running locally):

```bash
# Unauthenticated: should return plans list
curl -X POST http://localhost:8787/api/autumn/plans.list

# Authenticated: should return customer state
curl -X POST http://localhost:8787/api/autumn/customer \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json"
```

## Verification Checklist

- [x] `autumnHandler` mounted at `/autumn/*` in `app.ts` (path adjusted: see deviations)
- [x] `identify` function uses Better Auth session lookup
- [ ] `POST /autumn/plans.list` returns plan data
- [ ] `POST /autumn/customer` returns customer balances (when authenticated)
- [x] `lsp_diagnostics` clean on `app.ts`
- [ ] No existing routes broken (health, auth, AI, workspaces, documents all still work)

## What comes next

Phase 3 ([Billing UI](./20260319T140003-autumn-phase3-billing-ui.md)) builds Svelte components that call these routes.

---

## Review (Implementation Notes)

**Implemented**: 2026-03-20

### Deviations from Spec

#### 1. Path prefix: `/autumn/*` instead of `/api/autumn/*`
The spec used `/api/autumn/*` (Autumn's default `pathPrefix`). Changed to `/autumn/*` with explicit `pathPrefix: '/autumn'` for consistency with the rest of the app's routing convention: all other routes use single-level prefixes (`/auth/*`, `/ai/*`, `/workspaces/*`, `/documents/*`). Phase 3 frontend code should target `/autumn/*`.

#### 2. Handler created per-request, not at module scope
The spec showed `autumnHandler({...})` called once at route registration. In Cloudflare Workers, `env.AUTUMN_SECRET_KEY` isn't available at module scope, only inside request handlers via `c.env`. The implementation wraps the handler in an async middleware that resolves the secret key per-request: `app.use('/autumn/*', async (c, next) => { return autumnHandler({ secretKey: c.env.AUTUMN_SECRET_KEY, ... })(c, next); })`. The `autumnHandler` factory is lightweight (no connections, no state), so per-request creation has negligible overhead.

#### 3. Session resolved in outer closure, not inside `identify`
The `identify` function receives a generic Hono `Context` without the app's `Env` type, so `c.var.auth` would be untyped. Instead, the session is resolved in the outer middleware where `c.var.auth` is properly typed, and the `identify` function captures it via closure. This avoids `as any` casts while keeping the same behavior.

### Files Modified

| File | Changes |
|------|---------|
| `apps/api/src/app.ts` | Added `autumnHandler` import from `autumn-js/hono`, mounted billing proxy at `/autumn/*` between OAuth discovery routes and `authGuard` |
