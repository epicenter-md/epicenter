# Phase 2 + 3: Billing Routes & Billing UI

**Position**: Phases 2-3 of 4
**Dependencies**: Phase 1 (credit system working)
**Estimated effort**: ~2 days

## Architecture Changes from Original Spec

### Change 1: Hono JSX instead of Svelte

The original Phase 3 spec called for a Svelte billing page in a frontend app with TanStack Query wrappers. Changed to:

**Server-rendered Hono JSX billing page in `apps/api`.**

Why:
- Billing is low-frequency (users check it monthly). Form-based interactions don't need SPA reactivity.
- Server-side rendering means Autumn SDK calls happen directly. No proxy layer needed for the billing page.
- Same origin eliminates CORS. Session cookies are already available.
- Fewer moving parts: one file instead of a query layer + 6 components + a new route in a separate app.

### Change 2: Better Auth plugin instead of standalone autumnHandler

The original Phase 2 spec used `autumnHandler` from `autumn-js/hono` with a manual `identify` function. Changed to:

**`autumn()` plugin from `autumn-js/better-auth` added to the `betterAuth()` plugins array.**

Why:
- We already use Better Auth. The plugin is the "designed for" integration path.
- Session-to-customer resolution is automatic (no manual `identify` function).
- `createAuth()` is already per-request in this codebase, so adding one plugin is trivial.
- Routes mount at `/api/auth/autumn/{routeName}`, keeping billing alongside auth.
- One fewer integration seam. The standalone handler is for apps that don't use Better Auth.

Tradeoff acknowledged: tighter coupling to Better Auth. If we ever move away from Better Auth, we'd need to swap to `autumnHandler`. Acceptable since we're already deeply coupled to Better Auth.

What stays the same: the Autumn SDK, plan IDs, credit system, and 402 recovery concept.

## Implementation Plan

### Phase 2: Better Auth Autumn plugin (~10 min)

- [ ] **2.1** Import `autumn` from `autumn-js/better-auth` in `apps/api/src/app.ts`
- [ ] **2.2** Add `autumn({ secretKey: c.env.AUTUMN_SECRET_KEY })` to the `betterAuth()` plugins array in `createAuth()`
- [ ] **2.3** Update `createAuth` signature to accept `secretKey` parameter (since `env` is only available per-request)
- [ ] **2.4** Verify TypeScript compiles cleanly

Routes created automatically by the plugin (all POST, under `/api/auth/autumn/`):
- `listPlans`: list plans with customerEligibility
- `getOrCreateCustomer`: customer state (balances, subscriptions)
- `attach`: subscribe/upgrade/downgrade
- `previewAttach`: preview cost before committing
- `updateSubscription`: cancel/uncancel
- `openCustomerPortal`: Stripe portal URL
- `aggregateEvents`: usage timeseries
- `setupPayment`: add/update payment method

### Phase 3A: Billing page: Hono JSX (~1.5 days)

Create `apps/api/src/billing.tsx` with server-rendered billing pages.

Routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/billing` | GET | Main billing dashboard. Credits, plan, subscription state |
| `/billing/upgrade` | POST | Form handler: attach plan, redirect to Stripe or back to /billing |
| `/billing/cancel` | POST | Form handler: cancel subscription at end of cycle |
| `/billing/uncancel` | POST | Form handler: reverse pending cancellation |
| `/billing/portal` | GET | Redirect to Stripe customer portal |
| `/billing/top-up` | POST | Form handler: purchase credit top-up |
| `/billing/success` | GET | Post-checkout landing page, redirects to /billing |

Data flow (all server-side, no client-side fetch):
```
GET /billing
  → resolve session (auth guard)
  → autumn.customers.getOrCreate({ customerId, expand: ['subscriptions.plan', 'balances.feature'] })
  → autumn.plans.list({ customerId }) ← includes customerEligibility
  → render HTML with Tailwind CDN
```

Page sections:
1. **Credit balance**: remaining/total with HTML progress bar, reset date
2. **Current plan**: name, price, status badge
3. **Plan comparison**: cards for Free/Pro/Max with action buttons based on eligibility
4. **Subscription management**: cancel/uncancel based on subscription state
5. **Credit top-up**: buy 500 credits for $5
6. **Stripe portal link**: manage payment methods, invoices

Implementation checklist:
- [ ] **3A.1** Enable JSX in `apps/api/tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`)
- [ ] **3A.2** Add auth guard to `/billing/*` routes
- [ ] **3A.3** Create base HTML layout component (Tailwind CDN, meta tags, dark mode)
- [ ] **3A.4** Implement GET `/billing`: fetch customer + plans, render dashboard
- [ ] **3A.5** Implement POST `/billing/upgrade`: call `autumn.billing.attach()`, handle redirect vs success
- [ ] **3A.6** Implement POST `/billing/cancel` and `/billing/uncancel`: call `autumn.billing.update()`
- [ ] **3A.7** Implement GET `/billing/portal`: call `autumn.billing.openCustomerPortal()`, redirect
- [ ] **3A.8** Implement POST `/billing/top-up`: call `autumn.billing.attach()` with `credit_top_up` plan
- [ ] **3A.9** Implement GET `/billing/success`: post-checkout confirmation page
- [ ] **3A.10** Style with Tailwind. Clean, minimal, matches Epicenter design language

### Phase 3B: 402 recovery in tab-manager (~30 min)

- [ ] **3B.1** In `apps/tab-manager/src/lib/state/chat-state.svelte.ts`, detect 402 in `onErrorChange` or `onError`
- [ ] **3B.2** Surface a "credits exhausted" state that the UI can render
- [ ] **3B.3** Add upgrade link/button in chat error UI that opens `/billing?upgrade=pro` in a new tab

## Edge Cases

| Case | Behavior |
|------|----------|
| No saved payment method | `attach()` returns `paymentUrl` → redirect to Stripe checkout |
| Payment method on file | `attach()` returns success → redirect to `/billing?upgraded=true` |
| Canceled but active | Show "Cancels on [date]" + "Keep plan" button → POST /billing/uncancel |
| Scheduled downgrade | Show "Switching to Free on [date]" |
| Unauthenticated | Auth guard → redirect to sign-in |
| Network error during checkout | POST handler catches, redirects to `/billing?error=checkout_failed` |
| BYOK request | Server skips billing. Not relevant to billing page. |

## Files to Modify/Create

| File | Action | Purpose |
|------|--------|---------|
| `apps/api/src/app.ts` | Modify | Add `autumn()` plugin to `createAuth()`, mount billing routes |
| `apps/api/src/billing.tsx` | Create | Hono JSX billing page and form handlers |
| `apps/api/tsconfig.json` | Modify | Enable JSX for Hono |
| `apps/tab-manager/src/lib/state/chat-state.svelte.ts` | Modify | Detect 402 and surface credits-exhausted state |

## Verification

- [ ] `/api/auth/autumn/listPlans` returns plan data (plugin working)
- [ ] GET `/billing` renders billing dashboard when authenticated
- [ ] Upgrade flow works (both redirect and no-redirect cases)
- [ ] Cancel and uncancel work
- [ ] Stripe portal opens
- [ ] Credit top-up works
- [ ] 402 in AI chat shows upgrade link in tab-manager
- [ ] `lsp_diagnostics` clean on all modified files
- [ ] Existing routes unaffected (health, auth, AI, workspaces, documents)

---

## Review (Implementation Notes)

**Implemented**: 2026-03-20

### What was built

**Phase 2: Better Auth Autumn plugin**
- Added `autumn()` from `autumn-js/better-auth` to the `betterAuth()` plugins array in `createAuth()`
- Updated `createAuth(db)` → `createAuth(db, secretKey)` to accept the Autumn secret key
- Call site at the per-request auth middleware now passes `c.env.AUTUMN_SECRET_KEY`
- This auto-mounts billing proxy routes at `/api/auth/autumn/{routeName}` for future client-side use

**Phase 3A: Billing page (billing.tsx)**
- Created `apps/api/src/billing.tsx`: 574 lines of Hono JSX server-rendered billing UI
- Routes: GET /billing (dashboard), POST /billing/upgrade, POST /billing/cancel, POST /billing/uncancel, GET /billing/portal, POST /billing/top-up, GET /billing/success
- Styling: Tailwind CDN, dark mode (zinc-950), emerald accents for actions, rose for destructive
- All Autumn SDK calls are server-side via `createAutumn(c.env)`: no client-side fetch needed
- Flash messages for state transitions (?upgraded=true, ?canceled=true, ?error=...)
- Mounted behind `authGuard` at `/billing/*` in app.ts

**Phase 3B: 402 recovery in tab-manager**
- Added `isCreditsExhausted` getter to `ConversationHandle`: checks error message for 'insufficient credits' or '402'
- Added `billingUrl` getter to `aiChatState` public API. Returns `${remoteServerUrl}/billing`
- UI components can check `handle.isCreditsExhausted` and link to `aiChatState.billingUrl`

### Files modified

| File | Changes |
|------|---------|
| `apps/api/src/app.ts` | Import `autumn` plugin + `billing` sub-app. Add plugin to `createAuth()`. Mount `/billing/*` behind authGuard. |
| `apps/api/tsconfig.json` | Added `jsx: react-jsx` and `jsxImportSource: hono/jsx` |
| `apps/api/src/billing.tsx` | New file. Hono JSX billing page with all routes and form handlers |
| `apps/tab-manager/src/lib/state/chat-state.svelte.ts` | Added `isCreditsExhausted` to ConversationHandle, `billingUrl` to aiChatState |

### What's NOT included (follow-up work)

- **Usage chart**: would need a client-side charting library (Chart.js CDN). Low priority.
- **UpgradePrompt Svelte component**: the tab-manager now surfaces `isCreditsExhausted` state, but the UI component that renders the prompt (with styling, dismiss, etc.) needs to be built in the tab-manager's Svelte layer.
- **Runtime verification**: all TypeScript compiles clean but endpoints haven't been tested against live Autumn API. Needs deployment to staging.
- **Tailwind CDN → build step**: the billing page uses the Tailwind CDN play script. For production, consider building Tailwind CSS at compile time instead.
