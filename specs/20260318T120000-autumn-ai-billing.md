> **Superseded.** This spec's research is preserved here for reference, but the implementation plan has been restructured into the phase specs:
> - [Master Plan](./20260319T140000-autumn-billing-overview.md)
> - [Phase 1: AI Chat Gating](./20260319T140001-autumn-phase1-ai-chat-gating.md) (covers Waves 1-4 below)
> - [Phase 2: Billing Routes](./20260319T140002-autumn-phase2-billing-routes.md)
> - [Phase 3: Billing UI](./20260319T140003-autumn-phase3-billing-ui.md) (covers the "Future" section below)

---

# Autumn AI Billing Integration

## Context

Epicenter has an AI chat endpoint (`/ai/chat`) that streams completions via TanStack AI. Currently there's no usage tracking, no rate limiting, and no billing. We want to gate AI access behind credit-based plans using Autumn V2.

### Current state

- **API**: Single-file Hono app (`apps/api/src/app.ts`) on Cloudflare Workers
- **Auth**: Better Auth with `bearer()`, `jwt()`, `oauthProvider()` plugins. No org plugin. User-scoped model (`user.id` is the identity).
- **AI chat**: `apps/api/src/ai-chat.ts`: thin TanStack AI passthrough. OpenAI + Anthropic only. Returns SSE stream.
- **afterResponse pattern**: `createAfterResponseQueue()` in `app.ts`: push fire-and-forget promises, drain in `waitUntil()`. Already used by `upsertDoInstance()`.
- **Billing**: None. Clean slate.

### Design decisions

1. **Customer = user**. No org plugin, no workspace-level billing. `c.var.user.id` maps to Autumn `customerId`.
2. **Credit system**. Single credit pool with three model classes at different costs. Users spend from one balance however they want.
3. **Atomic check+deduct**. Use `check({ sendEvent: true })` for simplicity. Refund on AI call failure. No balance locking for v1. Each message is 1 fixed-cost unit.
4. **SDK directly, not autumnHandler**. The Autumn handler creates frontend-facing routes (checkout, billing portal). We'll add that later. For v1, the AI endpoint calls the SDK directly.
5. **Autumn events for analytics**. Attach `properties` (model, provider) to track events. Use `events.aggregate` with `groupBy: "properties.model"` for dashboards. No separate `ai_usage_log` table for v1.
6. **Free plan auto-enabled**. New users get credits immediately via `autoEnable: true`. Pro plan adds more credits + overage pricing.
7. **BYOK bypass**. If the request includes the user's own API key (not our server key), skip billing entirely. Billing only applies when users consume our proxied AI compute. This aligns with HOW_TO_MONETIZE.md: "Users who don't want to manage their own API keys pay us for bundled access."

## Plan

### Wave 1: Config + SDK setup (no code changes to existing files)

- [ ] **1.1** Create `apps/api/autumn.config.ts` with features (ai-chat-fast, ai-chat-smart, ai-chat-premium), credit system (ai-credits), and plans (free, pro, credit-top-up)
- [ ] **1.2** Add `autumn-js` and `atmn` dependencies to `apps/api/package.json`
- [ ] **1.3** Add `AUTUMN_SECRET_KEY` to `wrangler.jsonc` secrets array
- [ ] **1.4** Run `wrangler types` to regenerate `worker-configuration.d.ts` with the new secret
- [ ] **1.5** Create `apps/api/src/autumn.ts`: factory function that creates an Autumn SDK client from env bindings

### Wave 2: Customer sync (minimal auth hook)

- [ ] **2.1** Create `apps/api/src/ensure-autumn-customer.ts`: middleware that calls `autumn.customers.getOrCreate({ customerId: c.var.user.id, name, email })` on every auth'd request. Idempotent, fire-and-forget via afterResponse queue.
- [ ] **2.2** Wire `ensureAutumnCustomer` middleware after `authGuard` for `/ai/*` routes in `app.ts`

### Wave 3: Credit gating on AI chat

- [ ] **3.1** Create `apps/api/src/model-classes.ts`: maps each TanStack AI model string to a model class (`ai-chat-fast` | `ai-chat-smart` | `ai-chat-premium`). Export the mapping + a `getModelClass(provider, model)` function.
- [ ] **3.2** Modify `apps/api/src/ai-chat.ts` to:
  1. If request includes a user-provided API key, skip billing (BYOK bypass)
  2. Call `autumn.check({ customerId, featureId: modelClass, requiredBalance: 1, sendEvent: true, properties: { model, provider } })`
  3. If `!allowed`, return 402 with balance info
  4. On AI call error, push `autumn.track({ value: -1 })` refund to afterResponse
  5. No separate track on success: `sendEvent: true` + `properties` on check already records the event

### Wave 4: Push config + verify

- [ ] **4.1** Run `atmn push` to sync features and plans to Autumn dashboard
- [ ] **4.2** Manual smoke test: verify free plan auto-assigns, credits deduct, 402 on exhaustion

### Future: Billing UI (out of scope for v1)

When it's time to build the billing UI, the work breaks into two parts: backend routes and frontend components.

#### Backend: Mount `autumnHandler` on the API

The `autumnHandler` from `autumn-js/hono` creates `/api/autumn/*` routes that proxy requests from frontend React hooks to Autumn's API. It handles customer resolution via an `identify` function. Same pattern as Better Auth's handler.

```ts
// apps/api/src/app.ts: future addition
import { autumnHandler } from 'autumn-js/hono';

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

Routes created by autumnHandler:
- `POST /api/autumn/customer`: get or create customer (used by `useCustomer` hook)
- `POST /api/autumn/attach`: attach plan (checkout/upgrade/downgrade)
- `POST /api/autumn/billing.update`: cancel/uncancel subscriptions
- `POST /api/autumn/billing.open_customer_portal`: Stripe billing portal URL
- `POST /api/autumn/billing.preview_attach`: preview charges before committing
- `POST /api/autumn/plans.list`: list plans with `customerEligibility` data
- `POST /api/autumn/events.aggregate`: usage timeseries data

**Note**: The `autumnHandler` uses the `autumn-js/hono` adapter. For Cloudflare Workers specifically, `autumn-js/webStandard` also works. The Hono adapter is preferred since it integrates with Hono's context.

#### Frontend: Billing page components (Svelte)

Autumn provides React hooks (`useCustomer`, `useListPlans`, `useAggregateEvents`), but Epicenter uses Svelte 5. You'll need to build equivalent Svelte components that call the `/api/autumn/*` routes directly. Key pieces:

**Pricing table**: List plans with upgrade/downgrade awareness:
- `POST /api/autumn/plans.list` returns plans with `customerEligibility.attachAction` (`"activate"` | `"upgrade"` | `"downgrade"` | `"purchase"` | `"none"`)
- Use `attachAction` to set button text: "Subscribe", "Upgrade", "Downgrade", "Current plan"
- Call `POST /api/autumn/attach` with `{ planId, redirectMode: "always" }`: returns a `paymentUrl` to redirect to

**Credit balance display**: Show remaining credits:
- `POST /api/autumn/customer` returns `balances.ai-credits.{ granted, remaining, usage, nextResetAt }`
- Display as progress bar or "82 / 200 credits remaining"
- Use `nextResetAt` to show "Resets in X days"

**Upgrade prompt**: Show when credits are low or exhausted:
- When `/ai/chat` returns 402, show an inline upgrade prompt
- Call `POST /api/autumn/billing.preview_attach` with `{ planId: "pro" }` to show what the charge would be
- On confirm, call `POST /api/autumn/attach` with `{ planId: "pro", redirectMode: "if_required" }`
- If `paymentUrl` is returned, redirect to Stripe checkout; otherwise, plan activates immediately

**Billing portal**: Manage payment methods and invoices:
- Call `POST /api/autumn/billing.open_customer_portal` with `{ returnUrl }` to get Stripe portal URL
- Redirect user to manage subscriptions, payment methods, and download invoices
- Requires enabling the billing portal in [Stripe dashboard settings](https://dashboard.stripe.com/settings/billing/portal)

**Usage chart**: Show AI usage over time:
- Call `POST /api/autumn/events.aggregate` with `{ featureId: "ai-credits", range: "30d" }`
- Returns timeseries data: `[{ period, values: { ai-credits: N } }, ...]`
- Can group by `properties.model` to show per-model breakdown

**Subscription management**: Cancel/uncancel:
- Cancel: `POST /api/autumn/billing.update` with `{ planId: "pro", cancelAction: "cancel_end_of_cycle" }`
- Uncancel: same endpoint with `cancelAction: "uncancel"`
- Show cancellation state when `subscription.canceledAt !== null && subscription.status === "active"`

**Carry-over on upgrade**: Preserve unused credits:
- Pass `carryOverBalances: { enabled: true }` on `attach` when upgrading Free→Pro
- Unused free credits get added as a one-off balance on Pro

#### Other future items

- Per-workspace entity balances (when workspace-level quotas are needed)
- Balance locking (when variable-cost billing like per-token is needed)
- Own `ai_usage_log` table for detailed analytics beyond Autumn events
- Auto top-ups (Autumn handles via Stripe, just needs config)
- Spend limits per customer (built into Autumn, just needs config)
## autumn.config.ts

```ts
import { feature, item, plan } from 'atmn';

// Metered features: one per model class
export const aiChatFast = feature({
  id: 'ai-chat-fast',
  name: 'AI Chat (Fast)',
  type: 'metered',
  consumable: true,
});

export const aiChatSmart = feature({
  id: 'ai-chat-smart',
  name: 'AI Chat (Smart)',
  type: 'metered',
  consumable: true,
});

export const aiChatPremium = feature({
  id: 'ai-chat-premium',
  name: 'AI Chat (Premium)',
  type: 'metered',
  consumable: true,
});

// Single credit pool: different costs per model class
export const aiCredits = feature({
  id: 'ai-credits',
  name: 'AI Credits',
  type: 'credit_system',
  creditSchema: [
    { meteredFeatureId: aiChatFast.id, creditCost: 1 },
    { meteredFeatureId: aiChatSmart.id, creditCost: 3 },
    { meteredFeatureId: aiChatPremium.id, creditCost: 10 },
  ],
});

// Free: auto-assigned to every new customer
export const free = plan({
  id: 'free',
  name: 'Free',
  group: 'main',
  autoEnable: true,
  items: [
    item({
      featureId: aiCredits.id,
      included: 50,
      reset: { interval: 'month' },
    }),
  ],
});

// Pro: $20/mo with 2000 credits + overage at $1/100 credits
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
      price: {
        amount: 1,
        billingUnits: 100,
        billingMethod: 'usage_based',
        interval: 'month',
      },
    }),
  ],
});

// One-time credit top-up add-on
export const creditTopUp = plan({
  id: 'credit-top-up',
  name: 'Credit Top-Up',
  addOn: true,
  items: [
    item({
      featureId: aiCredits.id,
      price: {
        amount: 5,
        billingUnits: 500,
        billingMethod: 'prepaid',
      },
    }),
  ],
});
```

## Key files to create/modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/autumn.config.ts` | Create | Features, credit system, plans |
| `apps/api/src/autumn.ts` | Create | SDK client factory |
| `apps/api/src/model-classes.ts` | Create | Model → class mapping |
| `apps/api/src/ensure-autumn-customer.ts` | Create | Customer sync middleware |
| `apps/api/src/ai-chat.ts` | Modify | Add credit check + tracking |
| `apps/api/src/app.ts` | Modify | Wire customer middleware, pass autumn client |
| `apps/api/wrangler.jsonc` | Modify | Add AUTUMN_SECRET_KEY secret |
| `apps/api/package.json` | Modify | Add autumn-js, atmn deps |

## Model class mapping (draft)

```ts
type ModelClass = 'ai-chat-fast' | 'ai-chat-smart' | 'ai-chat-premium';

// Will need to verify exact model strings from TanStack AI exports
const MODEL_CLASSES: Record<string, ModelClass> = {
  // OpenAI: fast
  'gpt-4o-mini': 'ai-chat-fast',
  'gpt-4o-mini-2024-07-18': 'ai-chat-fast',
  // OpenAI: smart
  'gpt-4o': 'ai-chat-smart',
  'gpt-4o-2024-11-20': 'ai-chat-smart',
  'o3-mini': 'ai-chat-smart',
  // OpenAI: premium
  'o1': 'ai-chat-premium',
  'o3': 'ai-chat-premium',
  // Anthropic: fast
  'claude-3-5-haiku-latest': 'ai-chat-fast',
  // Anthropic: smart
  'claude-sonnet-4-20250514': 'ai-chat-smart',
  'claude-3-5-sonnet-latest': 'ai-chat-smart',
  // Anthropic: premium
  'claude-opus-4-20250514': 'ai-chat-premium',
};
```

## AI chat flow (modified)

```
Request → authGuard → ensureAutumnCustomer → aiChatHandler
                                                  │
                                    getModelClass(provider, model)
                                                  │
                                    autumn.check({ sendEvent: true })
                                                  │
                                         allowed? ─── No → 402
                                                  │
                                                 Yes
                                                  │
                                         chat() → SSE stream
                                                  │
                                         afterResponse.push(
                                           autumn.track({ value: 0, properties: { model, provider } })
                                         )
```

On AI call error before stream starts:
```
afterResponse.push(autumn.track({ customerId, featureId: modelClass, value: -1 }))
```

## Research findings (grounded in Autumn v2 docs + repo)

### Sources consulted

- [Autumn v2 docs](https://docs.useautumn.com): full docs index via llms.txt
- [Autumn repo](https://github.com/useautumn/autumn): DeepWiki analysis of v2 architecture, SDK source, Lua scripts
- [Autumn credit systems guide](https://docs.useautumn.com/documentation/modelling-pricing/credit-systems)
- [Autumn balance locking guide](https://docs.useautumn.com/documentation/customers/balance-locking)
- [Autumn usage-based pricing guide](https://docs.useautumn.com/documentation/modelling-pricing/usage-based-pricing)
- [Autumn setup + Hono adapter](https://docs.useautumn.com/documentation/getting-started/setup)
- [Autumn checking/tracking guide](https://docs.useautumn.com/documentation/getting-started/gating)
- [Autumn changelog](https://docs.useautumn.com/changelog/changelog): v1.0.0 stable (Mar 17 2026)
- [Autumn OpenAPI spec](https://docs.useautumn.com/api/openapi-2.0.0.yml): API v2.2.0
- Real-world patterns from Codebuff AI, Cal.com credit systems

### SDK version

- **`autumn-js` v1.0.0** is the production-ready SDK (Mar 17 2026 stable release)
- `@useautumn/sdk` is Speakeasy-generated and "not yet ready for production": do NOT use
- Autumn API version: 2.2.0

### Validated ✅

1. **Credit system with model classes**: exactly the canonical Autumn pattern. The `creditSchema` mapping is correct.
2. **`customers.getOrCreate` middleware**: critical. As of Mar 2026, `/check` and `/track` no longer auto-create customers. The `ensureAutumnCustomer` middleware handles this correctly.
3. **`sendEvent: true` for atomic check+deduct**: good v1 simplification. Avoids needing balance locking when each message has a fixed credit cost.
4. **`afterResponse` for fire-and-forget tracking**: fits the existing `waitUntil()` pattern perfectly.
5. **SDK directly, not `autumnHandler`**: correct for v1. The handler creates frontend-facing routes (`/api/autumn/*` for checkout, billing portal). Layer that on when you build the billing UI.
6. **Pricing structure**: Free(50)/Pro(2000+overage)/TopUp is a standard AI SaaS pattern matching Cursor, Codebuff, and similar products.

### Issues found and fixed 🔧

#### 1. `free` plan missing `group: 'main'` (FIXED above)

The `pro` plan had `group: 'main'` but `free` didn't. Autumn uses plan groups to manage upgrades/downgrades. Both plans must be in the same group for Free→Pro upgrade to auto-remove the Free subscription. Fixed by adding `group: 'main'` to the free plan config.

**Source**: [Autumn plans docs](https://docs.useautumn.com/documentation/concepts/plans): "Plans can be grouped to enforce mutual exclusivity within a group."

#### 2. Analytics tracking pattern (RECOMMEND CHANGE)

The spec plans `autumn.track({ value: 0, properties: { model, provider } })` after success. This records a 0-value event just to attach metadata. Instead, pass `properties` directly on the `check` call:

```ts
// Before (spec draft):
autumn.check({ customerId, featureId: modelClass, requiredBalance: 1, sendEvent: true })
// ...later...
autumn.track({ customerId, featureId: modelClass, value: 0, properties: { model, provider } })

// After (recommended):
autumn.check({
  customerId,
  featureId: modelClass,
  requiredBalance: 1,
  sendEvent: true,
  properties: { model, provider },  // attach metadata to the check event itself
})
// No separate track call needed on success
```

This eliminates the fire-and-forget `track` call on the happy path entirely. The `sendEvent: true` already records the event: `properties` just tags it. One fewer network call per AI request.

**Source**: [Autumn check docs](https://docs.useautumn.com/documentation/customers/check): `sendEvent` records the usage event atomically with the check.

### Pricing model comparison (why credits are the right call)

All billing models Autumn v2 supports, evaluated for Epicenter:

| Model | How it works | Fit for Epicenter |
|-------|-------------|-------------------|
| **Credit system** ← chosen | Unified pool, different costs per model class | ✅ Best fit. Users get flexibility to mix fast/premium. Simple mental model. |
| **Per-feature metering** | Separate balances per model (100 fast, 10 premium) | ❌ Rigid. Users hate "I have premium credits but need fast ones." |
| **Pure usage-based** | No upfront credits, bill at period end | ⚠️ Risky for a product that's currently free+BYOK. Surprise bills kill trust. |
| **Prepaid credits** | Buy upfront, draw down | ✅ Good as add-on (already in spec as `credit-top-up`). Bad as primary model. |
| **Per-seat + credits** | Charge per workspace/seat + credit allowance | ⚠️ Premature. No org plugin. Layer on when you add workspace-level billing. |
| **Monetary credits** | 1 credit = 1 cent, pass through actual API costs | ⚠️ Transparent but complex. Requires per-model per-token cost tracking. v2+ territory. |

**Conclusion**: Credit system with model classes is correct. It aligns with the HOW_TO_MONETIZE.md strategy ("AI compute. Users who don't want to manage their own API keys pay us for bundled access") and gives flexibility to adjust credit costs per model without code changes.

### Autumn v2 features to be aware of (future leverage)

These aren't needed for v1 but are worth knowing about:

1. **Balance locking**: For when you move to per-token billing: `check({ lock: { enabled: true, lockId } })` → do AI work → `balances.finalize({ lockId, overrideValue: actualTokens })`. Autumn handles the reserve/confirm/release pattern atomically. This is the exact pattern OpenAI uses internally (per their ["Beyond Rate Limits" blog post](https://openai.com/index/beyond-rate-limits/)).

2. **Sub-entity balances**: For per-workspace quotas: `entities.create({ customerId, entityId: workspaceId, featureId: 'ai-credits' })`. Each workspace gets its own credit pool under the parent customer.

3. **Auto top-ups**: Customer can configure automatic credit replenishment when balance falls below a threshold. No code needed. Autumn handles it via Stripe.

4. **Spend limits**: Cap overage spending per customer/entity. Prevents runaway bills for Pro users with usage-based overage.

5. **`previewAttach`**: Preview billing changes before committing (line items, prorations, totals). Useful for building a pricing/upgrade UI.

6. **`carryOverBalances`**: Preserve remaining credits on upgrade (Free→Pro). Pass on `attach` to carry over unused free credits into the Pro balance.

7. **Webhooks**: Autumn handles most webhook logic internally, but exposes events for `customer.plan.changed`, `customer.balance.low`, etc. Useful for sending upgrade nudges.

### Latency considerations

- Autumn `check` is <50ms via multi-region Redis caching
- Your CF Worker already has a serial pg connection via Hyperdrive per request
- The Autumn check adds one HTTP round-trip before the AI stream starts
- For `/ai/chat` this is acceptable: the AI response itself takes 1-30+ seconds
- For any future high-throughput endpoints, consider batching or client-side caching

### Concurrency note

The refund pattern (`track({ value: -1 })` on error) has a small race window between the atomic check+deduct and the refund. For v1 with low concurrency this is fine. For scale, balance locking (see "future leverage" above) eliminates this entirely by reserving credits and only confirming on success.

## Review

_To be filled after implementation._
