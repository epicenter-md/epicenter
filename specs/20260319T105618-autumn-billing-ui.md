> **Superseded.** This spec's research is preserved here for reference, but the implementation plan has been restructured into the phase specs:
> - [Master Plan](./20260319T140000-autumn-billing-overview.md)
> - [Phase 2: Billing Routes](./20260319T140002-autumn-phase2-billing-routes.md) (covers Phase 1 below)
> - [Phase 3: Billing UI](./20260319T140003-autumn-phase3-billing-ui.md) (covers Phases 2-4 below)

---

# Autumn Billing UI

**Date**: 2026-03-19
**Status**: Draft
**Author**: OpenCode AI-assisted

## Overview

Add the customer-facing billing UI for Epicenter so users can view credits, compare plans, upgrade, manage billing, and recover from AI-credit exhaustion using Autumn v2.

## Motivation

### Current State

- `apps/api/src/ai-chat.ts` is the AI entrypoint and is planned to enforce Autumn-backed credits.
- `specs/20260318T120000-autumn-ai-billing.md` defines the server-side billing model and Autumn integration.
- There is no billing page, pricing table, upgrade prompt, or billing portal UI yet.
- Epicenter uses Svelte 5, while Autumn's first-party frontend helpers are React hooks.

This creates problems:

1. **No upgrade path**: Even if `/ai/chat` starts returning `402`, users have nowhere to upgrade.
2. **No billing transparency**: Users cannot see remaining credits, reset timing, or active plan.
3. **Framework mismatch**: Autumn docs assume React hooks like `useCustomer`, but Epicenter needs a Svelte-native implementation.

### Desired State

Epicenter should expose Autumn-backed billing routes from the API and build Svelte components on top of those routes for pricing, balance display, subscription management, and upgrade recovery.

## Research Findings

### Autumn backend integration

Autumn provides `autumnHandler` adapters for `hono`, `webStandard`, `next`, and `express`.

| Topic | Finding | Implication |
|---|---|---|
| Handler path | Default path prefix is `/api/autumn` | Mount billing proxy routes under the API app |
| Identity model | `identify()` returns `customerId` and optional `customerData` | Use Better Auth session → `user.id` directly |
| Runtime fit | `autumn-js/hono` works directly with Hono | Prefer Hono adapter over generic webStandard adapter |

**Key finding**: The billing UI does not need direct secret-key access from the frontend. The UI should talk only to `/api/autumn/*` routes mounted in `apps/api/src/app.ts`.

### Autumn customer-facing APIs

Grounded against Autumn docs and repo analysis, the main UI routes are:

| Route | Purpose |
|---|---|
| `POST /api/autumn/customer` | Fetch customer state: balances, subscriptions, purchases |
| `POST /api/autumn/plans.list` | Fetch plans with `customerEligibility` |
| `POST /api/autumn/attach` | Start checkout, upgrade, downgrade, or purchase |
| `POST /api/autumn/billing.preview_attach` | Preview charges before upgrade |
| `POST /api/autumn/billing.update` | Cancel or uncancel plan |
| `POST /api/autumn/billing.open_customer_portal` | Open Stripe billing portal |
| `POST /api/autumn/events.aggregate` | Usage chart / time-series analytics |

**Key finding**: Autumn's React hooks are convenience wrappers over these routes. In Svelte, we should build small query/mutation helpers instead of trying to port React hooks directly.

### Billing model constraints from the existing spec

The billing UI must reflect the already-chosen billing model:

| Decision | Value |
|---|---|
| Customer identity | Better Auth `user.id` |
| Credit pool | `ai-credits` |
| Free plan | 50 credits / month |
| Pro plan | $20 / month, 2000 credits, usage-based overage |
| Add-on | `credit-top-up` |
| BYOK | If user supplies their own provider key, no credits are burned |

**Implication**: The UI should present bundled compute billing, not a generic AI-cost calculator. It should clearly separate “using your own key” from “using Epicenter credits.”

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backend billing routes | Mount `autumnHandler` in `apps/api/src/app.ts` | Matches Autumn docs and avoids custom proxy glue |
| Frontend data layer | Svelte + TanStack Query wrappers around `/api/autumn/*` | Fits existing stack; no React dependency |
| Pricing page source of truth | `plans.list` + `customerEligibility` | Lets Autumn decide upgrade/downgrade/current-plan state |
| Upgrade UX | Inline preview first, redirect only if required | Matches Autumn `previewAttach` + `attach({ redirectMode: 'if_required' })` |
| 402 recovery | Show upgrade prompt inline after AI exhaustion | Keeps user in flow instead of dead-ending |
| Billing portal | Use Stripe portal through Autumn | Avoids rebuilding invoice/payment-method management |
| Carry-over on Free → Pro | Enable `carryOverBalances` | Prevents users from feeling like unused credits were stolen |

## Architecture

```text
Svelte Billing UI
├── CreditBalance
├── PricingTable
├── UpgradePrompt
├── BillingPortalButton
├── SubscriptionManager
└── UsageChart
          │
          ▼
TanStack Query helpers
├── getAutumnCustomer()
├── listAutumnPlans()
├── previewAutumnAttach()
├── attachAutumnPlan()
├── updateAutumnSubscription()
├── openAutumnCustomerPortal()
└── aggregateAutumnEvents()
          │
          ▼
Hono API (`apps/api/src/app.ts`)
└── /api/autumn/* via autumnHandler(identify)
          │
          ▼
Autumn v2 API + Stripe
```

```text
STEP 1: User opens billing page
──────────────────────────────
Frontend fetches customer state + plans list.

STEP 2: UI renders current state
────────────────────────────────
Show current plan, remaining credits, reset date, upgrade/downgrade actions.

STEP 3: User upgrades or buys top-up
────────────────────────────────────
Preview charges, then call attach.
If paymentUrl returned, redirect.
If not, refresh customer state inline.

STEP 4: User exhausts credits in AI chat
───────────────────────────────────────
`/ai/chat` returns 402.
Frontend opens UpgradePrompt using previewAttach.
User upgrades, returns, retries action.
```

## Implementation Plan

### Phase 1: Backend route exposure

- [ ] **1.1** Mount `autumnHandler` from `autumn-js/hono` at `/api/autumn/*` in `apps/api/src/app.ts`
- [ ] **1.2** Implement `identify(c)` using Better Auth session lookup and `user.id`
- [ ] **1.3** Verify unauthenticated behavior for pricing-related reads vs authenticated customer actions

### Phase 2: Frontend query layer

- [ ] **2.1** Add Svelte/TanStack Query wrappers for customer, plans, preview, attach, update, portal, and events routes
- [ ] **2.2** Normalize Autumn responses into small UI-friendly helpers
- [ ] **2.3** Add error handling for expired sessions, failed checkout, and 402 retry flows

### Phase 3: Billing page UI

- [ ] **3.1** Build `CreditBalance` using `balances['ai-credits']`
- [ ] **3.2** Build `PricingTable` using `plans.list` + `customerEligibility`
- [ ] **3.3** Build `SubscriptionManager` for cancel / uncancel states
- [ ] **3.4** Build `BillingPortalButton` using `billing.open_customer_portal`
- [ ] **3.5** Build `UsageChart` using `events.aggregate`

### Phase 4: AI exhaustion recovery

- [ ] **4.1** Detect `/ai/chat` `402` responses in the client
- [ ] **4.2** Show `UpgradePrompt` with `previewAttach({ planId: 'pro' })`
- [ ] **4.3** On success, refetch customer state and support retrying the failed action

## Edge Cases

### BYOK request

1. User provides their own provider key in `/ai/chat`
2. Server skips Autumn billing entirely
3. UI should not imply that all AI actions consume credits

### Scheduled downgrade

1. User downgrades from Pro to Free
2. Autumn marks new plan as `scheduled`
3. UI should show “scheduled” state instead of pretending the downgrade is active immediately

### Upgrade without redirect

1. User already has a saved payment method
2. `attach({ redirectMode: 'if_required' })` returns no `paymentUrl`
3. UI should show success inline and refetch balances/subscriptions

### Canceled but still active subscription

1. User clicks cancel at end of cycle
2. Subscription remains `active` with `canceledAt !== null`
3. UI should show “cancels on …” and a “Keep plan” action

## Open Questions

1. **Where should the billing page live in the Svelte app?**
   - Options: (a) settings/account area, (b) dedicated `/billing` page, (c) both a full page and lightweight settings entry
   - **Recommendation**: Use a dedicated `/billing` page plus a smaller entry point in settings.

2. **How visible should BYOK vs Epicenter billing be?**
   - Options: (a) small helper text only, (b) explicit toggle/state in the AI UI, (c) billing page explanation only
   - **Recommendation**: Make it explicit in both the AI UI and billing page. Hidden pricing logic creates mistrust.

3. **Should top-up purchase live inside the pricing table or separately?**
   - Options: (a) same pricing table, (b) separate “Buy more credits” card, (c) only show after balance is low
   - **Recommendation**: Separate card. A one-time purchase behaves differently from subscription plans.

## Success Criteria

- [ ] Billing page shows current plan, remaining credits, and reset timing
- [ ] Pricing table correctly labels actions as subscribe / upgrade / downgrade / current plan
- [ ] Upgrade flow works with both redirect-required and no-redirect cases
- [ ] Customer can open Stripe billing portal from the UI
- [ ] Customer can cancel and uncancel a subscription from the UI
- [ ] AI `402` exhaustion flow leads to a valid upgrade path instead of a dead end

## References

- `specs/20260318T120000-autumn-ai-billing.md` - server-side billing integration plan
- `apps/api/src/app.ts` - Hono app where `autumnHandler` will be mounted
- `apps/api/src/ai-chat.ts` - AI route that will emit `402` for exhausted credits
- `HOW_TO_MONETIZE.md` - business model context; bundled compute is the paid path, BYOK is not billed
- `https://docs.useautumn.com/documentation/getting-started/display-billing` - billing page patterns
- `https://docs.useautumn.com/documentation/customers/payment-flow` - attach / previewAttach flow
- `https://docs.useautumn.com/react/hooks/autumn-handler` - handler docs
- `https://docs.useautumn.com/react/hooks/useCustomer` - customer data and actions
- `https://docs.useautumn.com/documentation/customers/subscription-lifecycle` - cancel / uncancel / scheduled changes
