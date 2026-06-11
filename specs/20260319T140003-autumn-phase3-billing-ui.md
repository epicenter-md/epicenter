# Phase 3: Billing UI

**Position**: Phase 3 of 4
**Dependencies**: Phase 1 (credit system working) + Phase 2 (billing routes mounted)
**Estimated effort**: ~3-5 days
**Spec**: [Master plan](./20260319T140000-autumn-billing-overview.md)

## Goal

Build a Svelte billing page and upgrade flow so users can:
- See their remaining credits and reset date
- Compare plans and upgrade/downgrade
- Recover from AI credit exhaustion (402) with an inline upgrade prompt
- Open the Stripe billing portal to manage payment methods
- Cancel and reactivate subscriptions

## Current State

- Phase 1 done: `/ai/chat` returns 402 when credits are exhausted
- Phase 2 done: `/api/autumn/*` routes proxy billing data to the frontend
- No billing UI exists. Users who hit 402 have no upgrade path.
- Epicenter uses Svelte 5. Autumn's React hooks (`useCustomer`, `useListPlans`) don't apply.

## Architecture

```
Svelte Billing Page
├── CreditBalance          ← shows remaining credits + reset date
├── PricingTable           ← plan comparison with upgrade/downgrade actions
├── UpgradePrompt          ← inline recovery from 402 exhaustion
├── BillingPortalButton    ← link to Stripe billing portal
├── SubscriptionManager    ← cancel / reactivate subscription
└── UsageChart             ← AI usage over time
        │
        ▼
TanStack Query helpers     ← thin wrappers over POST /api/autumn/*
        │
        ▼
Hono API (apps/api)        ← /api/autumn/* via autumnHandler
        │
        ▼
Autumn v2 API + Stripe
```

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Data layer | TanStack Query wrappers over `/api/autumn/*` | Fits existing stack. No React dependency. |
| Pricing page truth | `plans.list` + `customerEligibility` | Autumn decides upgrade/downgrade/current state |
| Upgrade UX | Preview first, redirect only if required | `previewAttach` shows cost, `attach({ redirectMode: 'if_required' })` avoids unnecessary redirects |
| 402 recovery | Inline upgrade prompt | Keeps user in flow instead of dead-ending |
| Billing portal | Stripe portal via Autumn | Avoids rebuilding invoice/payment-method management |
| Carry-over | `carryOverBalances: { enabled: true }` on Free→Pro | Unused free credits preserved on upgrade |

## Data Flow: Key Autumn Response Shapes

### `POST /api/autumn/customer` response

```ts
{
  balances: {
    'ai-credits': {
      granted: 50,
      remaining: 32,
      usage: 18,
      nextResetAt: '2026-04-01T00:00:00Z',
    },
  },
  subscriptions: [...],
  purchases: [...],
}
```

### `POST /api/autumn/plans.list` response

```ts
{
  plans: [
    {
      id: 'free',
      name: 'Free',
      customerEligibility: {
        attachAction: 'none', // already on this plan
      },
    },
    {
      id: 'pro',
      name: 'Pro',
      price: { amount: 20, interval: 'month' },
      customerEligibility: {
        attachAction: 'upgrade', // can upgrade to this
      },
    },
  ],
}
```

`attachAction` values: `"activate"` | `"upgrade"` | `"downgrade"` | `"purchase"` | `"none"`

### `POST /api/autumn/attach` request/response

```ts
// Request
{ planId: 'pro', redirectMode: 'if_required', carryOverBalances: { enabled: true } }

// Response: redirect needed (no saved payment method)
{ paymentUrl: 'https://checkout.stripe.com/...' }

// Response: no redirect needed (payment method on file)
{ success: true }
```

## Implementation Plan

### Sub-phase A: Query layer (days 1-2)

Build TanStack Query wrappers that call the `/api/autumn/*` routes. These are the data primitives the UI components consume.

- [ ] **A.1** Create `getAutumnCustomer()`: fetches `POST /api/autumn/customer`
- [ ] **A.2** Create `listAutumnPlans()`: fetches `POST /api/autumn/plans.list`
- [ ] **A.3** Create `previewAutumnAttach(planId)`: fetches `POST /api/autumn/billing.preview_attach`
- [ ] **A.4** Create `attachAutumnPlan(planId, options)`: calls `POST /api/autumn/attach`, handles redirect vs inline success
- [ ] **A.5** Create `updateAutumnSubscription(planId, cancelAction)`: calls `POST /api/autumn/billing.update`
- [ ] **A.6** Create `openAutumnCustomerPortal(returnUrl)`: calls `POST /api/autumn/billing.open_customer_portal`
- [ ] **A.7** Create `aggregateAutumnEvents(featureId, range)`: calls `POST /api/autumn/events.aggregate`
- [ ] **A.8** Add error handling: expired sessions → re-auth, failed checkout → show error, network failures → retry

**Pattern**: Each wrapper is a function that returns a Wellcrafted `queryOptions` or `mutationOptions` object for TanStack Query. Example:

```ts
import { queryOptions } from 'wellcrafted/query';

export function autumnCustomerQuery() {
  return queryOptions({
    queryKey: ['autumn', 'customer'],
    queryFn: async () => {
      const res = await fetch('/api/autumn/customer', { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(`Autumn customer fetch failed: ${res.status}`);
      return res.json();
    },
  });
}
```

### Sub-phase B: Billing page components (days 2-4)

Build each component. Priority order (most urgent first):

- [ ] **B.1** `UpgradePrompt`: **Most urgent.** Detects 402 from `/ai/chat`, shows preview of Pro plan cost, handles upgrade. This directly unblocks the AI exhaustion dead-end.
  - Triggered when AI chat returns 402
  - Calls `previewAutumnAttach('pro')` to show what the charge would be
  - On confirm: calls `attachAutumnPlan('pro', { redirectMode: 'if_required', carryOverBalances: { enabled: true } })`
  - If `paymentUrl` returned → redirect to Stripe checkout
  - If no redirect needed → refetch customer state, show success, allow retry

- [ ] **B.2** `CreditBalance`: Shows remaining credits as progress bar or "32 / 50 credits remaining". Shows reset date ("Resets in 12 days"). Uses `autumnCustomerQuery()`.

- [ ] **B.3** `PricingTable`: Lists plans from `listAutumnPlans()`. Button text based on `attachAction`:
  - `"none"` → "Current plan" (disabled)
  - `"activate"` → "Subscribe"
  - `"upgrade"` → "Upgrade"
  - `"downgrade"` → "Downgrade"
  - `"purchase"` → "Buy"

- [ ] **B.4** `BillingPortalButton`: Button that calls `openAutumnCustomerPortal({ returnUrl: window.location.href })` and redirects to the Stripe portal URL. Requires enabling billing portal in [Stripe dashboard settings](https://dashboard.stripe.com/settings/billing/portal).

- [ ] **B.5** `SubscriptionManager`: Shows current subscription state. Handles:
  - Active: show "Cancel at end of cycle" button
  - Canceled but still active (`canceledAt !== null`): show "Cancels on [date]" + "Keep plan" button
  - Cancel: `updateAutumnSubscription('pro', 'cancel_end_of_cycle')`
  - Uncancel: `updateAutumnSubscription('pro', 'uncancel')`

- [ ] **B.6** `UsageChart`: Shows AI usage over time using `aggregateAutumnEvents('ai-credits', '30d')`. Returns timeseries data. Can group by `properties.model` for per-model breakdown. Lower priority. Can ship after the core billing flow works.

### Sub-phase C: Integration (day 4-5)

- [ ] **C.1** Create billing page route (recommendation: `/billing` as a dedicated page)
- [ ] **C.2** Add billing link to settings/account area
- [ ] **C.3** Wire 402 detection in AI chat client code to trigger `UpgradePrompt`
- [ ] **C.4** Add "Buy more credits" card for the `credit-top-up` add-on (separate from pricing table. One-time purchase behaves differently from subscriptions)
- [ ] **C.5** Handle BYOK visibility: make it explicit in both the AI UI and billing page that using your own API key doesn't consume credits

## Edge Cases

| Case | Expected behavior |
|------|-------------------|
| BYOK request | Server skips billing. UI should NOT imply credits are consumed. |
| Scheduled downgrade (Pro→Free) | Show "Scheduled" state, not "Free". Downgrade happens at end of cycle. |
| Upgrade without redirect | User has saved payment method. `attach` returns success. Refetch balances inline. |
| Canceled but active | Subscription active with `canceledAt !== null`. Show "Cancels on [date]" + "Keep plan" action. |
| Network error during checkout | Show error, allow retry. Don't assume payment failed. |
| Unauthenticated pricing page | `plans.list` may work without auth (public pricing). `customer` requires auth. |

## Open Questions (decide during implementation)

1. **Where does the billing page live?** Recommendation: dedicated `/billing` route + smaller entry in settings.
2. **How visible is BYOK vs Epicenter billing?** Recommendation: explicit in both AI UI and billing page.
3. **Top-up in pricing table or separate?** Recommendation: separate "Buy more credits" card.

## Verification Checklist

- [ ] Billing page shows current plan, remaining credits, and reset timing
- [ ] Pricing table correctly labels actions (subscribe / upgrade / downgrade / current)
- [ ] Upgrade works with both redirect-required and no-redirect cases
- [ ] Stripe billing portal opens from the UI
- [ ] Cancel and uncancel subscription works
- [ ] AI 402 exhaustion triggers UpgradePrompt with working upgrade path
- [ ] BYOK state is visible and credits are not confusingly displayed

## What comes next

After this phase, the full billing loop is closed. Users can:
1. Use AI for free (50 credits/month)
2. Hit the limit → see upgrade prompt → upgrade to Pro
3. Manage their subscription from the billing page
4. View usage over time

Phase 4 ([Storage billing](./20260319T140004-autumn-phase4-storage-billing.md)) adds storage metering independently.
