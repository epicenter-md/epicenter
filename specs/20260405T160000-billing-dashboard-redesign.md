# Billing Dashboard Redesign

**Date**: 2026-04-05
**Status**: Draft
**Author**: AI-assisted

## Overview

Replace the server-rendered Hono JSX billing page with a client-side SvelteKit SPA served from the same Worker, redesign the pricing model ($20/$60/$200 with rollover on Ultra/Max), and surface deep usage analytics powered by Autumn's events API. All consumed type-safely via Hono's `hc` client.

## Philosophy

Epicenter is open source, local-first, and built on the belief that users should own their data. The billing model needs to reflect that. Not contradict it.

### What We Believe

1. **You're paying for compute, not for permission.** Every feature of the product works the same on Free and on Max. Cloud sync, workspaces, document history, encryption. All unlimited, all tiers. The only thing money buys is more AI credits and access to expensive models.

2. **Your credits are yours.** On Ultra and Max, we don't expire them. If you don't use your credits this month, they roll over forever. Expiring credits is how companies punish you for not using their product enough. Pro resets monthly. But upgrading to Ultra carries your balance forward, and from there it never expires.

3. **We show our work.** This spec documents not just *what* we charge but *why*:including the pricing psychology, the cost analysis, and every feature gate we considered and rejected.

4. **Artificial scarcity is dishonest.** We ran the numbers on every feature gate. Cloud sync costs $0.001/user/month. Document history is rows in SQLite. Workspaces hibernate for free. Charging for these isn't a business decision. It's a trust violation. We gate only what has genuine, material cost: AI inference.

5. **The free tier is real.** It's not a 7-day trial with a credit card wall. It's a permanent tier with 50 credits/month, cloud sync, unlimited workspaces, and full encryption. We start new signups on a 14-day Ultra trial so they can experience the full product, then they keep the free tier forever. No bait and switch.

### What This Means in Practice

```
FREE (what every user gets, forever)         PAID (what money adds)
──────────────────────────────────────────         ────────────────────────────────
✓ Cloud sync across all devices              More AI credits (2,500-50,000/mo)
✓ Unlimited workspaces                        Access to all AI models
✓ Unlimited document history                  Credits never expire on Ultra/Max
✓ End-to-end encryption                       Lower overage rates
✓ 50 AI credits/month                         Annual billing discount
✓ Fast/mini AI models
```

Two upgrade paths: "I want more credits or better models" → any paid plan. "I want my credits to roll over" → Ultra or Max.

## Motivation

### Current State

Billing lives in `apps/api/src/billing.tsx`: a server-rendered Hono JSX page deployed to Cloudflare Workers. It shows a credit balance bar, plan cards, and basic actions (upgrade/cancel/top-up/portal). No usage charts, no model breakdown, no history.

```
GET /billing → server-rendered HTML
├── Credit balance (number + progress bar)
├── 3 plan cards (Free/Pro/Max)
├── Subscription status
└── Top-up + portal buttons
```

Pricing: Free (50 credits), Pro ($20/mo, 2000 credits), Max ($100/mo, 15000 credits). Credits reset monthly with no rollover.

### Problems

1. **No usage visibility**: Users can't see which models cost what, how fast they're burning credits, or usage trends over time. They hit 402 errors with no context.
2. **Server-rendered is a dead end**: Can't add charts, interactive tables, real-time updates, or model selectors to Hono JSX. It's static HTML with form submissions.
3. **Credits reset monthly**: Users lose unused credits. Feels punitive, contradicts the open-source/user-first philosophy.
4. **Pricing gaps**: $20 → $100 is a 5× jump. The middle of the market ($40-80 willingness) is lost.
5. **No usage data pipeline exists client-side**: All billing data is fetched and rendered server-side in a single route handler.

### Desired State

A SvelteKit SPA at `apps/dashboard/` (served from the same Cloudflare Worker as the API) that gives users deep visibility into their AI usage. Pricing restructured with better tier spacing and unlimited credit rollover on Ultra/Max plans. All data flows from Autumn's API through typed Hono routes via `hc`.

## Research Findings

### Autumn Events API

Autumn already stores every event sent via `check({ sendEvent: true, properties: { model, provider } })`. Three endpoints expose this data:

| Endpoint | SDK Method | Purpose |
|----------|-----------|---------|
| `POST /v1/events.aggregate` | `autumn.events.aggregate()` | Timeseries data grouped by feature/property. Powers charts. |
| `POST /v1/events.list` | `autumn.events.list()` | Individual events with timestamps and properties. Powers activity feed. |
| `POST /v1/customers.get` | `autumn.customers.getOrCreate()` | Balance, subscriptions, plan info via `expand`. |

**Key finding**: `events.aggregate()` supports `groupBy: "properties.model"` which returns usage broken down by AI model per time period. Combined with `binSize: "day"` and `range: "30d"`, this is exactly what a usage chart needs. No new database tables required.

Aggregate response with groupBy ([Autumn docs](https://docs.useautumn.com/api-reference/events/aggregateEvents)):
```json
{
  "list": [
    {
      "period": 1762905600000,
      "values": { "ai_usage": 150 },
      "grouped_values": {
        "ai_usage": { "claude-sonnet-4": 100, "gpt-4o-mini": 30, "claude-opus-4": 20 }
      }
    }
  ],
  "total": { "ai_usage": { "count": 45, "sum": 150 } }
}
```

Additional parameters: `filterBy` (filter by property values), `customRange` (epoch ms start/end), `range` presets (`24h`, `7d`, `30d`, `90d`, `last_cycle`), `maxGroups` (bucket overflow into "Other").

**Implication**: Zero new tables. Zero per-call logging. The data already exists in Autumn.

### Autumn Rollover Support

Autumn natively supports credit rollover via a `rollover` config on plan items ([Autumn docs](https://docs.useautumn.com/documentation/modelling-pricing/rollovers)):

```typescript
item({
  featureId: aiCredits.id,
  included: 10000,
  price: { amount: 1, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
  rollover: { max: null, expiryDurationType: 'forever' },
})
```

- `max: null` = unlimited rollover (no cap)
- `expiryDurationType: 'forever'` = rolled-over credits never expire
- At each billing cycle: balance resets to `included`, then rollover is added on top
- Rollover balances are consumed after monthly balances (FIFO: shorter-lived credits first)

**Implication**: Unlimited rollover is a single config change per plan item. No custom cron jobs or manual tracking needed.

### Autumn Proration (Automatic)

Plan changes are prorated automatically by Autumn, no custom billing math needed ([Autumn docs](https://docs.useautumn.com/documentation/modelling-pricing/proration)).

| Scenario | Autumn behavior |
|----------|----------------|
| **Upgrade** (e.g., Pro $20 → Ultra $60 on day 15 of 30) | Immediate. Autumn credits remaining Pro time ($10), charges prorated Ultra ($30), net charge $20. |
| **Downgrade** (e.g., Ultra → Pro) | Scheduled for end of billing cycle. User stays on Ultra until then. |
| **Free → Paid** | Immediate. Full price charge, no proration (nothing to credit). |
| **Annual → Monthly** (or vice versa) | Handled via plan group swap with proration. |

Usage-based overage (credits beyond included) is settled at the old rate before the new rate kicks in.

The `billing.previewAttach()` method shows what the customer will be charged before committing: useful for the dashboard's upgrade flow:

```typescript
const preview = await autumn.billing.previewAttach({
  customerId: userId,
  planId: 'ultra',
});
// → { prorationAmount: 2000, currency: 'usd', ... }
// Show: "You'll be charged $20.00 today (prorated)"
```

**Implication**: Zero proration logic on our side. The upgrade flow just calls `previewAttach()` to show the user what they'll pay, then `billing.attach()` to commit. Autumn + Stripe handle the rest.

### Autumn Balance Breakdown (Monthly vs Rollover)

The balance API returns a `breakdown` array that separates each credit source: monthly grant, rollover, top-ups, with per-source remaining balance and reset timing ([Autumn docs](https://docs.useautumn.com/documentation/concepts/balances)):

```json
{
  "balances": {
    "ai_credits": {
      "included_usage": 10000,
      "balance": 11500,
      "usage": 8500,
      "breakdown": [
        {
          "id": "ent_monthly",
          "product_id": "ultra",
          "included_usage": 10000,
          "balance": 10000,
          "usage": 0,
          "interval": "month",
          "next_reset_at": 1745193600000
        },
        {
          "id": "ent_rollover",
          "product_id": "ultra",
          "included_usage": 1500,
          "balance": 1500,
          "usage": 0,
          "interval": "one_off",
          "next_reset_at": null
        }
      ]
    }
  }
}
```

**Deduction order**: Shorter-lived intervals are consumed first (monthly before rollover). This means monthly credits deplete before rollover credits are touched: exactly the behavior we want. Users see their rollover balance as a safety net that only gets used when the monthly grant runs out.

**What this gives the dashboard**:
- Credit Balance card can show: `Monthly: 10,000 | Rollover: 1,500 | Total: 11,500`
- Progress bar segments can visually distinguish monthly vs rollover
- `next_reset_at` gives the exact "Resets in N days" countdown
- Top-up credits appear as a separate breakdown entry with `interval: "one_off"`

**Implication**: The dashboard doesn't compute any of this. The API returns it structured. We just render the `breakdown` array.

### Autumn Billing Controls (Spend Limits, Usage Alerts, Auto Top-Ups)

Autumn provides per-customer billing controls that go beyond our basic plan structure. These are configured via `autumn.customers.update()` and apply individually, not at the plan level ([Autumn docs](https://docs.useautumn.com/documentation/customers/billing-controls)).

#### Spend Limits

Cap how much overage a user can accumulate. Without a spend limit, usage-based features allow unlimited overage (the user is billed for whatever they use). With a spend limit, `check()` returns `allowed: false` once the cap is reached.

```typescript
await autumn.customers.update({
  customerId: userId,
  billingControls: {
    spendLimits: [{
      featureId: 'ai_credits',
      enabled: true,
      overageLimit: 5000, // max 5,000 overage credits beyond included
    }],
  },
});
```

The `overageLimit` is measured in feature units (credits), not dollars. So a limit of 5,000 on the Pro plan (2,500 included) means the user can use up to 7,500 total credits, then they're blocked until the next cycle.

**Use case for Epicenter**: Power users on Max who want to cap their own spending to avoid surprise overage bills. This is a dashboard settings feature: the user sets their own limit, not us.

#### Usage Alerts

Fire a `balances.usage_alert_triggered` webhook when usage crosses a threshold. Two types:

- `usage`: absolute count (e.g., "fire when 2,000 credits used")
- `usage_percentage`: percentage of included allowance (e.g., "fire at 80%")

```typescript
await autumn.customers.update({
  customerId: userId,
  billingControls: {
    usageAlerts: [{
      featureId: 'ai_credits',
      threshold: 80,
      thresholdType: 'usage_percentage',
      enabled: true,
      name: '80% usage warning',
    }],
  },
});
```

Alerts fire once per threshold crossing (not on every subsequent `track` call). They re-arm when usage drops below the threshold.

**Use case for Epicenter**: Send email notifications when credits are running low. Users could configure their own alert thresholds in the dashboard settings. The webhook hits our API, which sends an email via a transactional email service.

#### Auto Top-Ups

Automatically purchase more credits when balance drops below a threshold. Requires a one-off prepaid plan item (our existing `credit_top_up` plan) and a payment method on file.

```typescript
await autumn.customers.update({
  customerId: userId,
  billingControls: {
    autoTopups: [{
      featureId: 'ai_credits',
      enabled: true,
      threshold: 100,   // when balance drops below 100
      quantity: 500,    // buy 500 credits ($5 via credit_top_up plan)
      purchaseLimit: {  // safety: max 5 auto-purchases per month
        interval: 'month',
        intervalCount: 1,
        limit: 5,
      },
    }],
  },
});
```

When triggered, Autumn creates an invoice via Stripe, charges the customer's card, and adds the credits: all automatically. The `purchaseLimit` prevents runaway spending.

**Use case for Epicenter**: Users who never want to run out. They set "auto-buy 500 credits when I drop below 100" in the dashboard. This is especially useful for Max users doing heavy AI work who don't want to hit a wall mid-conversation.

**Implication**: All three billing controls are per-customer API calls: zero infrastructure on our side. Autumn stores the config, evaluates it on every `check()`/`track()` call, and fires webhooks or auto-charges as needed. The dashboard just needs UI to configure these settings and proxy the `customers.update()` call.

### shadcn-svelte Component Inventory

The monorepo's `packages/ui/` already contains 60+ shadcn-svelte components ([source](https://github.com/huntabyte/shadcn-svelte)). Components relevant to the dashboard:

| Component | Package path | Dashboard use |
|-----------|-------------|---------------|
| Card | `@epicenter/ui/card` | KPI blocks (balance, plan, usage) |
| Progress | `@epicenter/ui/progress` | Credit balance bar |
| Badge | `@epicenter/ui/badge` | Status indicators (Active, Cancelled, Free) |
| Tabs | `@epicenter/ui/tabs` | Overview / Usage / Activity sections |
| Table | `@epicenter/ui/table` | Model cost reference, activity feed |
| Dialog | `@epicenter/ui/dialog` | Confirmations (upgrade, cancel) |
| Sheet | `@epicenter/ui/sheet` | Side panel for detailed model breakdown |
| Separator | `@epicenter/ui/separator` | Section dividers |
| Skeleton | `@epicenter/ui/skeleton` | Loading states |
| Select | `@epicenter/ui/select` | Time range picker (7d/30d/90d) |

**Not in `packages/ui/` yet**: Chart component. shadcn-svelte's Chart uses [LayerChart](https://github.com/techniq/layerchart) under the hood ([shadcn-svelte docs](https://www.shadcn-svelte.com/docs/components/chart)). This needs to be added.

### Hono RPC Client (`hc`)

Hono's `hc` provides fully typed API consumption without codegen. The API already exports types from `@epicenter/api`:

```typescript
// apps/api/src/app.ts: export the app type
export type AppType = typeof app

// apps/dashboard/: consume with full type inference
import { hc } from 'hono/client'
import type { AppType } from '@epicenter/api'

const client = hc<AppType>('/api')  // same origin, relative path
const res = await client.billing.balance.$get()
//                       ^ fully typed, autocomplete
```

**Implication**: New Hono routes in `apps/api` are automatically available type-safely in the dashboard. No schema duplication, no codegen step.

### Svelte 5 + SvelteKit

The dashboard will use Svelte 5 runes ([Svelte docs](https://svelte.dev/docs/svelte/$state)) for reactive state and SvelteKit for routing/SSR. Key patterns:

- `$state()` for local reactive state (selected time range, active tab)
- `$derived()` for computed values (credit percentage, usage projections)
- TanStack Query (`@tanstack/svelte-query`) for server state caching. Matches the existing pattern in `apps/whispering/`

### TanStack AI Telemetry

`@tanstack/ai` exposes usage data via the AG-UI streaming protocol ([TanStack AI docs](https://tanstack.com/ai/latest/docs/guides/streaming)):

- `RUN_FINISHED` event includes finish reason and usage (token counts)
- Observability event client provides `text:usage`, `text:request:completed` events with model/provider metadata
- `@tanstack/ai-svelte` package exists for Svelte integration

**Current state in our codebase**: `ai-chat.ts` already sends `properties: { model, provider }` with every `check()` call. Token-level usage tracking could be added later via `onFinish` callbacks but is not required for the dashboard MVP. Credit-level data from Autumn events is sufficient.

## Pricing Strategy & Rationale

### Why These Numbers: Behavioral Economics

The pricing structure ($20/$60/$200) isn't arbitrary. It's grounded in well-documented pricing psychology:

**Three visible plans, not four.** The compromise effect (Simonson 1989, Journal of Consumer Research) shows that when people face three options, they disproportionately choose the middle one. It feels safe. The center-stage effect (Valenzuela & Raghubir 2009, Journal of Consumer Psychology) compounds this: people's gaze settles on the center position and they attribute higher quality to it. Free is NOT shown as a plan card on the pricing page. It's the default state every user starts in (Autumn `autoEnable`). Showing Free as a selectable tier validates staying free and breaks the center-stage effect by making the grid 4 items wide.

**$200 as anchor, $60 as target.** Anchoring (Tversky & Kahneman 1974) means the highest visible price becomes the reference point. When users see $200 first, $60 feels reasonable by comparison. The decoy effect (Huber, Payne & Puto 1982, JCR) works here too. Pro at $20 delivers $0.008/credit, while Ultra at $60 delivers $0.006/credit. Pro is objectively worse value per credit, making Ultra the obvious upgrade. The $200 Max tier exists primarily to make Ultra look like a deal, though some users will genuinely choose it (pure upside).

**Why $60, not $50 or $80.** $50 is too close to $20 (2.5×): the jump doesn't feel significant. $80 triggers "business expense" thinking; the personal credit card ceiling for most professionals is ~$50-75/month. $60 sits at 3× the entry tier, significant but still in "personal expense" territory. Round number pricing ($60 > $59) signals quality in professional contexts (Schindler & Kibarian 1996; Troll et al. 2024 meta-analysis on charm pricing).

**Why $20 base, not $30.** The base tier's job is conversion, not margin. Lower price = more conversions = more users in the upgrade funnel. If 20% of Pro users upgrade to Ultra, a $20 base generates more total revenue than $30 because it feeds more users into the funnel (see financial modeling in conversation history). The $20 price point also has strong market precedent (ChatGPT Plus, Claude Pro, Cursor Pro).

**Credit-per-dollar improves at each tier.** This is intentional. The rational choice is always to go higher if you can afford it:

```
Pro:    $0.008/credit  (baseline)
Ultra:  $0.006/credit  (25% cheaper → 4× credits for 3× price)
Max:    $0.004/credit  (50% cheaper → 20× credits for 10× price)
```

Each step up is a better deal, but the absolute price jumps ($20→$60→$200) create natural stopping points that sort users by willingness to pay.

### The Netflix Comparison

Netflix runs three visible tiers: Ad-supported ($8.99), Standard ($19.99), Premium ($26.99). The ad-supported tier functions as a price floor anchor. It's deliberately constrained so Standard looks worth the upgrade. Premium anchors high so Standard looks reasonable. Netflix killed the old Basic (no-ads, SD) tier because it competed with Standard without serving as a useful anchor. It muddied decisions rather than clarifying them.

Our parallel:

| Netflix | Epicenter | Function |
|---------|-----------|----------|
| Ad-supported ($8.99) | Pro ($20) | Entry point / floor anchor |
| Standard ($19.99) | Ultra ($60) | Target tier, recommended, "most popular" |
| Premium ($26.99) | Max ($200) | Ceiling anchor, makes middle look reasonable |
| (Basic: killed) | (Free: not shown as a plan) | Removed from pricing page to avoid muddying the decision |

### Feature Gating Philosophy: Generous by Default

**Principle: Paid tiers differ ONLY in credit amount, overage rate, and model access. Everything else. Including cloud sync. Is the same across ALL plans, including Free.**

Most SaaS products gate features to create upgrade pressure: "Want more than 3 projects? Upgrade." "Need version history? That's on Pro." We considered all of these and rejected every one that didn't have a genuine cost basis. We calculated the actual infrastructure cost per user for each feature, and if it was negligible, we made it free.

The logic is simple: if it doesn't cost us meaningful money to provide, it shouldn't cost you money to access. Gating cheap features to manufacture upgrade pressure is dishonest, and users can tell.
| Feature | Free | Any Paid Plan | Rationale |
|---------|------|---------------|-----------|
| AI credits | 50/mo (resets) | Scales by plan (rollover on Ultra/Max) | Core monetization. Real compute cost. |
| Model access | Cheap models only (mini/flash/haiku) | All models | Cost protection on Free. Paid users already paid for credits. Restricting models is double-charging. |
| Cloud sync | ✓ | ✓ | DO cost verified at $0.001/user/month at 10K users ($0.20/GB storage, WebSocket hibernation = free idle). Gating sync to drive upgrades is not worth losing the habit formation and retention that multi-device sync creates. |
| Document history | ✓ Unlimited | ✓ Unlimited | Snapshots are rows in a DO's SQLite. Marginal cost is zero. Gating history contradicts "own your data." |
| Workspaces | ✓ Unlimited | ✓ Unlimited | DOs at rest cost nothing (hibernation). Artificial workspace limits are manufactured scarcity. |
| Encryption | ✓ | ✓ | Gating security is ethically wrong and bad for trust. |

**Cloud sync cost analysis** (Cloudflare DO with SQLite, 2026 pricing):

```
Per user: 2 DOs, ~10 syncs/day, ~5MB CRDT data
DO storage: $0.20/GB-month (5GB included free)
WebSocket hibernation: idle DOs = $0 duration charges

  1,000 users  →  5 GB storage  →  $0/mo   (within included tier)
 10,000 users  →  50 GB storage →  ~$10/mo ($0.001/user)
100,000 users  →  500 GB storage → ~$108/mo ($0.001/user)
```

Source: [Cloudflare DO pricing docs](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/durable-objects/platform/pricing.mdx)

**What we considered, costed, and rejected** (we're showing our work so you can hold us to it):
- ~~Cloud sync gating~~: At $0.001/user/month, sync costs are a rounding error. Free sync creates habit formation (multi-device use), increases engagement, and is a massive competitive differentiator for a local-first tool. The upgrade value of gating sync ($0.001/user saved) is dwarfed by the retention value of free sync.
- ~~Document history limits (7d/30d/90d)~~: Storage cost per snapshot row is negligible. Charging users to access their own history feels predatory and directly contradicts the "own your data" ethos.
- ~~Workspace count limits (1/3/10)~~: DOs hibernate when idle. An unused workspace costs essentially nothing. Limiting count is artificial scarcity with no cost basis.
- ~~Priority inference~~: No queue system exists. Don't promise features that don't exist to justify a price.
- ~~Per-tier model restrictions~~: Paid users already pay for credits. If someone on Pro wants to spend 30 credits on one Opus call instead of 30 mini calls, that's their choice. The margin is the same either way.

**The result is two upgrade paths:**

1. "I ran out of credits" or "I want better models" → upgrade to any paid plan
2. "I want my unused credits to roll over" → upgrade to Ultra or Max

Simple. Honest. Generous.

### Credit Rollover: Ultra/Max Only

Rollover is an Ultra and Max perk. Pro resets monthly, like Free but with more credits and all models.

```
Free:   50 credits/mo    ─ resets monthly, cheap models only
Pro:    2,500 credits/mo  ─ resets monthly, all models
Ultra:  10,000 credits/mo ─ ∞ rollover, all models
Max:    50,000 credits/mo ─ ∞ rollover, all models
```

**Why not rollover on all paid plans?**

We investigated this thoroughly. Autumn's billing platform supports rollover via plan item config (`rollover: { max: null, expiryDurationType: 'forever' }`), and month-to-month accumulation works on any plan that has it configured. But there's a hard technical constraint: **Autumn does not support carry-over of balances on plan downgrades.** ([Source: Autumn billing.attach tests](https://github.com/useautumn/autumn/blob/27179c4a90ad47b744673d8fca071e9d813d0f5c/server/tests/integration/billing/attach/params/carry-over-balances/carry-over-balance-scheduled.test.ts#L24-L60): `carryOverBalances` is rejected with `InvalidRequest` on scheduled/downgrade changes.)

If we put rollover on Pro, here's the trap:

1. User on Max accumulates 80,000 credits over months
2. User downgrades to Pro
3. Autumn cannot carry over the balance on downgrade: credits are lost
4. User is furious: "You said my credits are mine!"

By limiting rollover to Ultra/Max, we avoid creating a promise we can't keep. Pro users get a generous monthly allocation that resets cleanly. When they upgrade to Ultra, we enable `carryOverBalances: { enabled: true }` on the attach call, so their unused Pro credits transfer into their new rollover balance.

**How upgrade carry-over works** ([Source: Autumn billing.attach API](https://github.com/useautumn/autumn/blob/27179c4a90ad47b744673d8fca071e9d813d0f5c/shared/api/billing/attachV2/attachParamsV1.ts#L47-L75)):

```typescript
// In our upgrade handler:
await autumn.billing.attach({
  customerId: userId,
  planId: 'ultra',
  carryOverBalances: {
    enabled: true,
    featureIds: ['ai_credits'],  // carry credits from old plan
  },
});
// User's unused Pro credits become part of their Ultra rollover balance
```

| Scenario | Behavior |
|----------|----------|
| Pro → Ultra (upgrade) | Unused Pro credits carry forward into Ultra's rollover balance |
| Ultra → Max (upgrade) | Full rollover balance carries forward |
| Max → Ultra (downgrade) | Rollover balance preserved (both plans have rollover, same tier) |
| Max → Pro (downgrade) | Rollover balance lost (Autumn limitation; Pro has no rollover) |
| Ultra → Pro (downgrade) | Rollover balance lost (Autumn limitation; Pro has no rollover) |

**Behavioral economics still supports this design:**

- **Loss aversion** (Kahneman & Tversky 1979): Ultra/Max users with accumulated balances won't churn because leaving means losing their stockpile.
- **Mental accounting** (Thaler 1985): The rollover balance feels like a savings account: the larger it gets, the stronger the retention.
- **Upgrade incentive**: "Your Pro credits expired. On Ultra, they never do" is a strong, honest nudge.

Free and Pro reset monthly. This creates two clear nudges:
- Free → Paid: "Your credits expired. On Pro, you get 50× more."
- Pro → Ultra: "Your unused credits expired. On Ultra, they roll over forever."

### BYOK (Bring Your Own Key) Policy

Users can provide their own API keys for AI providers (OpenAI, Anthropic, Gemini, Grok). When a user provides their own key:

- **No credit check.** The `autumn.check()` call is skipped entirely.
- **No model gating.** Even Free users can use Opus with their own key.
- **No credit deduction.** The user pays the provider directly.
- **No refund logic.** On error, there's nothing to refund on our side.

This makes sense because:

1. **Zero cost to us.** BYOK requests use the user's key, not ours. We have no provider bill.
2. **Consistent with the philosophy.** "You're paying for compute, not for permission." If the user is paying their provider directly, we have no compute cost to gate.
3. **Encourages adoption.** A free user who brings their own key still uses our workspace, sync, and UI. They're engaged users who may upgrade later for the convenience of not managing keys.

Implementation in `ai-chat.ts`: if the request body includes a user-provided API key field, skip the credit check block and use the provided key instead of `c.env.[PROVIDER]_API_KEY`. The adapter creation switch already accepts any key. It just needs to accept one from the request body as an alternative to the env secret.

```typescript
// BYOK flow in ai-chat.ts:
const userKey = data.apiKey;  // optional field in request body
const isByok = !!userKey;

if (!isByok) {
  // Standard billing flow: check credits, deduct, gate models
  const credits = MODEL_CREDITS[data.model];
  if (!credits) return c.json(AiChatError.UnknownModel({ model: data.model }), 400);
  const { allowed } = await autumn.check({ ... });
  if (!allowed) return c.json(AiChatError.InsufficientCredits({ balance }), 402);
}

// Create adapter with either user's key or server key
const apiKey = userKey ?? c.env[`${provider.toUpperCase()}_API_KEY`];
```
### Reverse Trial Strategy

Every new signup gets 14 days of Ultra for free (no credit card required). After 14 days, they downgrade to Free (50 credits/mo, cheap models only).

Why this works:

1. **Loss aversion**: They had 10,000 credits and all models. Now they have 50 credits and mini-only. That gap hurts.
2. **Habit formation**: They used Sonnet/Opus for two weeks. Going back to mini feels like a downgrade.
3. **Accumulated credits at risk**: "Upgrade to keep your remaining credits" is a strong nudge.

Amplitude and other SaaS companies document that reverse trials convert 2-3× better than standard free tiers. Implementation in Autumn is native: Ultra plan gets `freeTrial: { durationLength: 14, durationType: 'day', cardRequired: false }` with `autoEnable: true`. When the trial expires, the Free plan (also `autoEnable`, no trial) activates as fallback. Autumn handles deduplication (one trial per customer) and supports `fingerprint` on customer creation for cross-account abuse prevention. No webhooks, no cron jobs, no manual downgrade logic. See [Autumn Trials docs](https://docs.useautumn.com/documentation/modelling-pricing/trials) and [Trial - card not required example](https://docs.useautumn.com/examples/trial-card-not-required).

### Annual Pricing

All paid plans offer annual billing at ~17% discount (2 months free):

| Plan | Monthly | Annual (per month) | Annual total | Savings |
|------|---------|-------------------|-------------|---------|
| Pro | $20/mo | ~$17/mo | $200/yr | $40/yr |
| Ultra | $60/mo | ~$50/mo | $600/yr | $120/yr |
| Max | $200/mo | ~$167/mo | $2,000/yr | $400/yr |

Annual locks in 12 months of revenue and reduces churn. The monthly/annual toggle on the pricing page serves as a natural "cheaper per unit" framing without resorting to $/day tricks that feel manipulative.

### Visual Summary

#### The Pricing Page (What Users See)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│            Choose your plan          [Monthly] [Annual]         │
│                                                                 │
│  ┌───────────────┐  ┌────────────────────┐  ┌───────────────┐  │
│  │     Pro        │  │     Ultra ★        │  │      Max      │  │
│  │               │  │   RECOMMENDED      │  │               │  │
│  │    $20/mo      │  │     $60/mo         │  │   $200/mo     │  │
│  │  ($17 annual)  │  │   ($50 annual)     │  │ ($167 annual) │  │
│  │               │  │                    │  │               │  │
│  │  2,500 cr/mo   │  │  10,000 cr/mo      │  │ 50,000 cr/mo  │  │
│  │  Resets monthly │  │  ∞ rollover        │  │ ∞ rollover    │  │
│  │  All models    │  │  All models        │  │ All models    │  │
│  │  $1/100 over   │  │  $0.75/100 over    │  │ $0.50/100     │  │
│  │               │  │                    │  │               │  │
│  │  [Subscribe]   │  │  [Subscribe]       │  │ [Subscribe]   │  │
│  └───────────────┘  └────────────────────┘  └───────────────┘  │
│                                                                 │
│  Currently on Free (50 credits/mo). Upgrade to unlock all        │
│  models. On Ultra/Max, unused credits roll over forever.         │
│                                                                 │
│  All plans include: cloud sync, unlimited workspaces,            │
│  unlimited document history, end-to-end encryption.              │
│                                                                 │
│  Need a quick boost? Credit Top-Up: $5 for 500 credits          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Note: Free is not shown as a plan card. Three plans only. This is intentional (see "Why These Numbers" above).

#### How the Psychology Works

```
User's eye path on the pricing page:

    $200 ←── ANCHOR
      │   The first big number recalibrates expectations.
      │   (Tversky & Kahneman 1974: anchoring effect)
      │
      │   "That's more than I need"
      │
      ▼
    $60 ←── TARGET
      │   Feels reasonable after seeing $200.
      │   Center position draws the eye.
      │   (Valenzuela & Raghubir 2009: center-stage effect)
      │   (Simonson 1989: compromise effect)
      │   ★ RECOMMENDED badge reinforces this.
      │
      │   "This one looks right"
      │
      ▼
    $20 ←── ENTRY
            If $60 is too much, $20 is still a win.
            Worse $/credit than Ultra. That's the point.
            (Huber, Payne & Puto 1982: decoy effect)
            They start paying, then upgrade later.
```

#### The User Journey

```
DAY 0                          DAY 1-14                      DAY 14
──────────────────────────────   ─────────────────────────────   ─────────────
Sign up                        Experience the full product    Trial ends
└→ 14-day Ultra trial            └→ 10,000 credits             └→ Downgrade to Free
   No credit card required         All AI models                 50 credits/mo
   10,000 credits                  Cloud sync (keeps working)    Mini/Flash models
   All models                      Build habits                  Cloud sync (keeps working)
   Cloud sync                      Accumulate data
                                   Save rollover credits


DAY 14+: THE NUDGES
───────────────────────

  ┌────────────────────────────────────────────────┐
  │  Nudge 1: Credits run out                          │
  │  "You've used 50/50 credits this month."            │
  │  [Upgrade to Pro: 2,500 credits/mo for $20]        │
  └────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────┐
  │  Nudge 2: Tries an expensive model                  │
  │  "Claude Sonnet requires a paid plan."               │
  │  [Upgrade to Pro: all models for $20/mo]            │
  └────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────┐
  │  Nudge 3: Loss aversion after trial                 │
  │  "Your trial ended. You had 10,000 credits           │
  │   and all models. Upgrade to get them back."         │
  │  [See plans]                                        │
  └────────────────────────────────────────────────┘
```

Every nudge is informational, not coercive. The user's existing features (sync, workspaces, history) are never threatened. Only credits and model access change.

#### Credit Economics at a Glance

```
                 Pro ($20)    Ultra ($60)    Max ($200)
                 ─────────    ───────────    ──────────
Credits/mo       2,500        10,000         50,000
$/credit         $0.008       $0.006         $0.004
Overage          $1/100       $0.75/100      $0.50/100
Rollover         Resets       ∞              ∞

Value scaling:
  Pro → Ultra:   3× price  →  4× credits   (25% cheaper per credit)
  Ultra → Max:   3.3× price → 5× credits   (33% cheaper per credit)

Every step up is objectively better value.
The rational choice is always to go higher. If you can afford it.
The price jumps ($20→$60→$200) sort users by willingness to pay.
```

#### What We Gate vs. What's Free

```
┌─────────────────────────────────────────────────────────────────┐
│  FREE FOR EVERYONE (no exceptions)                             │
│                                                               │
│  ✓ Cloud sync             Cost: $0.001/user/mo at scale       │
│  ✓ Unlimited workspaces    Cost: $0 (DOs hibernate)            │
│  ✓ Unlimited history       Cost: $0 (SQLite rows)              │
│  ✓ E2E encryption          Cost: $0 (CPU only)                 │
│  ✓ 50 AI credits/month     Cost: ~$0.15 (mini/flash calls)     │
│                                                               │
│  We ran the numbers. None of this costs enough to gate.        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  PAID ONLY (genuine cost basis)                                │
│                                                               │
│  Credits beyond 50/mo     AI inference has real provider cost  │
│  All AI models            Expensive models (Opus, o3-pro)      │
│                           cost 10-55× what mini models cost.   │
│                           Gating on Free protects margins.    │
∞ credit rollover         Ultra/Max perk. Incentive to upgrade:
  (Ultra/Max only)          "your credits roll over forever."
│                                                               │
│  That's it. Everything else is free.                           │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dashboard deployment | SvelteKit SPA in `adapter-static` mode, served from the same Worker as the API | Same-origin = zero auth complexity. No CORS, no cookie config. SvelteKit builds to static assets; Hono serves them via static middleware on `/dashboard/*`. |
| API communication | Hono `hc` client with relative paths | Same origin means `hc<AppType>('/api')` with no cross-origin config. Fully typed with zero codegen. |
| Usage data source | Autumn `events.aggregate()` API | Data already exists. We send model/provider properties on every check(). No new tables. |
| Chart library | LayerChart via shadcn-svelte Chart component | Official shadcn-svelte integration. Composable, SSR-safe. |
| State management | TanStack Query + Svelte 5 runes | Matches existing patterns in apps/whispering. Server state caching + local reactivity. |
| Credit rollover | Ultra/Max only: unlimited, forever expiry. Pro resets monthly. | Autumn can't carry over balances on downgrades. Rollover on Pro would create a promise we can't keep. Ultra/Max rollover is the upgrade incentive. |
| Free/Pro rollover | Reset monthly (no rollover) | Free: trial nudge. Pro: generous monthly allocation, upgrade to Ultra for rollover. |
| Pricing tiers | $20 / $60 / $200 (3 visible plans) | Compromise effect targets Ultra. $200 anchors high. Free hidden as default state. See "Pricing Strategy & Rationale" above. |
| Feature gating | Credits + model access (Free vs Paid only) | No per-tier feature gates. Cloud sync, workspaces, history, encryption free on all tiers. Paid tiers differ only in credit amount, overage rate, and model access. See "Feature Gating Philosophy" above. |
| Reverse trial | 14-day Ultra trial for new signups | Loss aversion drives 2-3× better conversion than standard free tier. No credit card required. |
| Annual pricing | 2 months free (~17% discount) | Locks in revenue, reduces churn. Monthly/annual toggle on pricing page. |
| Server-rendered billing page | Delete (`billing.tsx`). Clean break. | Dashboard replaces it entirely. No deprecation period: redirect `/billing` HTML requests to dashboard URL. |
| BYOK | User-provided API keys bypass billing entirely | Zero cost to us. Consistent with "pay for compute, not permission." Free users with their own keys still use our platform. |
| Migration | Delete old plans, push new ones | No existing users on old plans. Clean slate via `atmn push`. |

## Architecture

### System Overview

```
apps/api/ (Cloudflare Worker: serves BOTH API and dashboard)
┌──────────────────────────────────────────────────────────────┐
│  /dashboard/*  ───→ Static SvelteKit SPA                     │
│                    (adapter-static, served by Hono)         │
│                    ┌─────────────────────────────────┐    │
│                    │ @epicenter/ui             │    │
│                    │ Card, Progress, Badge     │    │
│                    │ Tabs, Table, Select       │    │
│                    │ Chart (LayerChart)        │    │
│                    └─────────────────────────────────┘    │
│                    ┌─────────────────────────────────┐    │
│                    │ @tanstack/svelte-query    │    │
│                    │ for server state caching  │    │
│                    └─────────────────────────────────┘    │
│                                                              │
│  /api/*        ───→ Hono API routes                          │
│                    GET  /api/billing/balance                │
│                      → autumn.customers.getOrCreate          │
│                    POST /api/billing/usage                  │
│                      → autumn.events.aggregate()             │
│                    POST /api/billing/events                 │
│                      → autumn.events.list()                  │
│                    GET  /api/billing/plans                  │
│                      → autumn.plans.list()                   │
│                    GET  /api/billing/models                 │
│                      → MODEL_CREDITS static map              │
│                    POST /api/billing/upgrade                │
│                      → autumn.billing.attach()               │
│                    POST /api/billing/cancel                 │
│                    POST /api/billing/top-up                 │
│                    GET  /api/billing/portal                 │
│                                                              │
│  /auth/*       ───→ Better Auth (existing)                   │
│  /ai/*         ───→ AI chat (existing)                       │
│  /workspaces/* ───→ Yjs sync (existing)                      │
└──────────────────────────────────────────────────────────────┘

Same origin = same cookies = zero auth complexity.
SvelteKit builds to static assets. Hono serves them.
hc<AppType> uses relative paths. No CORS configuration needed.
```

### Dashboard Page Structure

```
/billing (dashboard SPA)
├── Credits Section                Card + Progress
│   ├── Current balance / included
│   ├── Rollover balance (if any)
│   └── Resets in N days
│
├── Tabs
│   ├── Overview
│   │   ├── Usage Chart            LayerChart (area/bar, 7d/30d/90d)
│   │   │   └── Grouped by model (via events.aggregate groupBy)
│   │   ├── Top Models Table       Table (model, credits, call count)
│   │   └── Burn Rate              "At this rate, you'll use N credits this month"
│   │
│   ├── Models
│   │   └── Model Cost Guide       Table (model, provider, credits/call)
│   │       └── Sourced from MODEL_CREDITS map via /billing/models
│   │
│   └── Activity
│       └── Recent Events          Table (timestamp, model, credits, provider)
│           └── Paginated via events.list()
│
├── Plan Section                   3 plan cards (Pro/Ultra/Max)
│   ├── Ultra highlighted as ★ RECOMMENDED (center-stage effect)
│   ├── Free shown as "Current plan" text, NOT as a plan card
│   ├── Upgrade/downgrade buttons → previewAttach() shows cost → billing.attach()
│   ├── Monthly/Annual toggle
│   └── Credit allocation + overage rate per plan
│
└── Actions
    ├── Buy credits → /billing/top-up (existing)
    └── Manage billing → /billing/portal (existing, Stripe redirect)
```

### New Pricing Model

```
                    Free        Pro         Ultra       Max
Price               $0/mo       $20/mo      $60/mo      $200/mo
Annual price        :           ~$17/mo     ~$50/mo     ~$167/mo
Credits/mo          50          2,500       10,000      50,000
$/credit            :           $0.008      $0.006      $0.004
Rollover            Resets      Resets      ∞ forever   ∞ forever
Overage             None        $1/100      $0.75/100   $0.50/100
Model access        Mini/Flash   All         All         All
Cloud sync          ✓           ✓           ✓           ✓
Group               main        main        main        main
autoEnable          true        false       false       false
```

Note: Cloud sync, document history, workspaces, and encryption are unlimited
on ALL tiers including Free. Rollover is an Ultra/Max perk. Pro resets monthly.
See "Feature Gating Philosophy" and "Credit Rollover" sections for rationale.

Updated `billing-plans.ts`:
```typescript
export const PLAN_IDS = {
  free: 'free',
  pro: 'pro',
  ultra: 'ultra',        // NEW (replaces implicit gap)
  max: 'max',
  creditTopUp: 'credit_top_up',
} as const;

export const MAIN_PLAN_IDS = [
  PLAN_IDS.free, PLAN_IDS.pro, PLAN_IDS.ultra, PLAN_IDS.max,
] as const;
```

Updated `autumn.config.ts` plan items (Ultra/Max gain `rollover`, Pro does NOT):
```typescript
// Ultra/Max plan items get rollover:
item({
  featureId: aiCredits.id,
  included: 10000,  // Ultra (or 50000 for Max)
  price: { amount: 0.75, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
  rollover: { max: null, expiryDurationType: 'forever' },
})

// Pro plan items do NOT get rollover:
item({
  featureId: aiCredits.id,
  included: 2500,
  price: { amount: 1, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
  // no rollover: Pro resets monthly
})
```

### Hono Route Types (API side)

New routes are chained on the existing `app` so `typeof app` includes them for `hc`:

```typescript
// apps/api/src/billing-routes.ts
const billingApi = new Hono<Env>()
  .get('/balance', async (c) => {
    const autumn = createAutumn(c.env);
    const customer = await autumn.customers.getOrCreate({
      customerId: c.var.user.id,
      expand: ['subscriptions.plan', 'balances.feature'],
    });
    return c.json(customer);
  })
  .post('/usage', sValidator('json', usageQuerySchema), async (c) => {
    const autumn = createAutumn(c.env);
    const data = c.req.valid('json');
    const result = await autumn.events.aggregate({
      customerId: c.var.user.id,
      featureId: FEATURE_IDS.aiUsage,
      ...data, // range, binSize, groupBy, filterBy
    });
    return c.json(result);
  })
  // ... events, plans, models

// apps/api/src/app.ts
app.route('/billing', billingApi);
export type AppType = typeof app; // hc<AppType> gets all routes typed
```

## Implementation Plan

### Phase 1: Pricing + Rollover + Trial + Annual (API-only)

- [x] **1.1** Update `billing-plans.ts`: add Ultra plan ($60/mo, 10,000 credits), update Pro (2,500 credits), update Max ($200/mo, 50,000 credits), update overage rates. Add annual plan variants (`pro_annual`, `ultra_annual`, `max_annual`) with ~17% discount.
- [x] **1.2** Update `autumn.config.ts`:
  - Add Ultra plan definition with `freeTrial: { durationLength: 14, durationType: 'day', cardRequired: false }` and `autoEnable: true`
  - Add `rollover: { max: null, expiryDurationType: 'forever' }` to Ultra/Max plan items only (NOT Pro: Pro resets monthly)
  - Add annual plan variants with `price: { interval: 'year' }` and discounted amounts ($200/yr, $600/yr, $2000/yr)
  - Update Free plan: keep `autoEnable: true` (acts as fallback when Ultra trial expires)
  > **Note**: Annual plan items use `reset: { interval: 'month' }` (PlanItemWithReset variant) so credits reset monthly even on annual billing. The plan-level price has `interval: 'year'` for billing.
- [x] **1.3** Add model gating in `ai-chat.ts`: check user's plan via Autumn customer data from `ensureAutumnCustomer` middleware (stash `planId` on `c.var`). Free tier → reject models above 2 credits (mini/flash/haiku only). Define `FREE_TIER_MAX_CREDITS` constant.
- [x] **1.4** Add BYOK support in `ai-chat.ts`: if request includes user-provided API key, skip credit check and model gating entirely. Use provided key for adapter creation.
- [ ] **1.5** Delete old plans in Autumn: no existing users, clean slate
- [ ] **1.6** Push new plans to Autumn sandbox: `bunx atmn preview` then `bunx atmn push`
- [ ] **1.7** Verify in Autumn dashboard: all plans correct, trial config on Ultra, rollover on Ultra/Max only, annual variants present

### Phase 2: API Routes for Dashboard

- [x] **2.1** Create `apps/api/src/billing-routes.ts` with typed Hono routes:
  - `GET /billing/balance`: customer balance + subscription + breakdown via `autumn.customers.getOrCreate()`
  - `POST /billing/usage`: usage aggregation via `autumn.events.aggregate()`
  - `POST /billing/events`: event list via `autumn.events.list()`
  - `GET /billing/plans`: plan list via `autumn.plans.list()`
  - `GET /billing/models`: static MODEL_CREDITS map as JSON
  - `POST /billing/preview`: preview upgrade cost via `autumn.billing.previewAttach()`
  - `POST /billing/controls`: update per-user billing controls (spend limits, alerts, auto top-ups) via `autumn.customers.update()`
- [x] **2.2** Wire into `app.ts`, ensure `authGuard` covers new routes
- [x] **2.3** Export `AppType` from `apps/api/src/app.ts` for `hc` consumption
  > **Note**: Routes mounted at `/api/billing/*` so the dashboard can use `hc<AppType>` with relative paths. Added upgrade, cancel, uncancel, top-up, portal, and controls routes beyond original spec.
- [ ] **2.4** Verify routes with manual curl/httpie against local dev server

### Phase 3: Dashboard SPA Scaffold

- [x] **3.1** Create `apps/dashboard/` SvelteKit project with `adapter-static` (builds to static assets)
- [x] **3.2** Configure: `@epicenter/ui` dependency, `@epicenter/api` type import, TanStack Query, tailwindcss
- [x] **3.3** Set up Hono `hc` client with relative paths (same origin, no CORS needed)
- [x] **3.4** Add Chart component to `packages/ui/` via `bunx shadcn-svelte@latest add chart`
  > UsageChart upgraded from CSS bars to LayerChart stacked area chart with gradient fills, model-colored series, and interactive tooltips.
- [x] **3.5** Create billing page layout with Tabs (Overview / Models / Activity)

### Phase 4: Dashboard UI Implementation

- [x] **4.1** Credit Balance section: Card + segmented Progress bar (monthly vs rollover from `breakdown` array), rollover display, reset countdown from `next_reset_at`
- [x] **4.2** Usage Chart: Bar chart with tooltips, time range selector (Select), grouped by model via `events.aggregate({ groupBy: "properties.model" })`
  > **Note**: Used simple CSS bar chart instead of LayerChart for MVP. LayerChart integration can be added later for area/line charts.
- [x] **4.3** Top Models table: model name, total credits used (from aggregate totals)
- [x] **4.4** Model Cost Guide: static table from `/billing/models`, sorted by credit cost
- [x] **4.5** Activity Feed: paginated event list from `/billing/events`, timestamp + model + credits
- [x] **4.6** Plan Comparison: 3 plan cards (Pro/Ultra/Max), current plan highlighted, monthly/annual toggle. Upgrade button calls `previewAttach()` to show prorated cost before confirming with `billing.attach()`
- [x] **4.7** Actions: top-up button, manage billing (portal) link

### Phase 5: Deploy + Cutover

- [ ] **5.1** Add Hono static asset middleware to serve dashboard SPA from `/dashboard/*`
  > **Note**: Deployment-specific. In dev, the dashboard runs on its own Vite server. In production, static assets will be served via Cloudflare Workers site configuration or custom Hono middleware.
- [ ] **5.2** Build pipeline: SvelteKit builds to `apps/dashboard/build/`, Worker bundles the static output
  > **Note**: Deferred to deployment phase. `bun run build` in apps/dashboard/ produces static files.
- [x] **5.3** Delete `apps/api/src/billing.tsx` and its import/route in `app.ts`. Add redirect: `GET /billing → 302 /dashboard`
- [x] **5.4** Link from desktop apps (Whispering "Manage billing →" opens browser to `/dashboard`)
  > Added to settings sidebar as external link with ExternalLinkIcon. Opens `{APPS.API.url}/dashboard` in system browser via Tauri opener.
- [x] **5.5** Add upgrade handler with `carryOverBalances: { enabled: true }` for Pro → Ultra/Max upgrades
  > **Note**: Implemented in Wave 3 (billing-routes.ts upgrade endpoint).

### Phase 6: Billing Controls UI (Post-MVP)

- [ ] **6.1** Add "Settings" tab to dashboard with billing controls:
  - Spend limit: toggle + overage cap input (calls `autumn.customers.update({ billingControls: { spendLimits } })`)
  - Usage alerts: threshold percentage input (calls `autumn.customers.update({ billingControls: { usageAlerts } })`)
  - Auto top-up: toggle + threshold + quantity inputs (calls `autumn.customers.update({ billingControls: { autoTopups } })`)
- [ ] **6.2** Add webhook endpoint `POST /webhooks/autumn` to receive `balances.usage_alert_triggered` events → trigger email notification via transactional email service
- [ ] **6.3** Add upgrade preview to plan comparison: when user clicks "Upgrade", show `previewAttach()` result ("You'll be charged $X today") in a confirmation Dialog before committing

### Phase 7: Trial UX Polish (Post-MVP)

- [ ] **7.1** Trial countdown banner in dashboard header: "Your Ultra trial ends in N days" (from `subscription.trialEndsAt`)
- [ ] **7.2** Trial expiration nudge: "Your trial ended. You had X credits and all models. Upgrade to get them back."
- [ ] **7.3** Add payment method CTA during trial: `autumn.billing.setupPayment()` → Stripe setup page → seamless transition to paid when trial ends
## Edge Cases

### Rollover Balance Display (Ultra/Max Only)

1. User on Ultra with 1,500 unused credits rolls into next month
2. Balance shows: 10,000 (monthly) + 1,500 (rollover) = 11,500 total
3. Autumn's balance API **confirmed** to return a `breakdown` array with per-source balance, interval, and `next_reset_at`. Monthly credits appear with `interval: "month"`, rollover credits with `interval: "one_off"`. The dashboard renders this directly: no computation needed.
4. Pro users see only the monthly balance (no rollover breakdown needed)

### Plan Downgrade with Rollover

1. User on Max (50,000/mo) with 80,000 accumulated credits downgrades to Pro (2,500/mo)
2. Autumn handles subscription swap at end of billing cycle
3. **Resolved**: Autumn does NOT support `carryOverBalances` on downgrades ([source](https://github.com/useautumn/autumn/blob/27179c4a90ad47b744673d8fca071e9d813d0f5c/server/tests/integration/billing/attach/params/carry-over-balances/carry-over-balance-scheduled.test.ts#L24-L60)). Rollover balance is lost on downgrade to Pro. This is why rollover is Ultra/Max only: Pro users never accumulate a balance that could be lost.

### Free Tier → Paid Upgrade

1. User on Free with 30/50 credits remaining upgrades to Pro
2. Autumn's group swap should give them 2,500 Pro credits immediately
3. The 30 remaining free credits are lost (free has no rollover): this is expected and acceptable

### Dashboard Auth

1. User opens dashboard without being logged in
2. **Resolved**: Same-origin deployment. Dashboard is served from the same Worker as the API, so session cookies are automatically available. No cross-origin auth complexity.
3. SvelteKit's `load` function checks for a valid session on page load. If no session, redirect to `/sign-in` with a `callbackURL` back to `/dashboard`.

### Autumn API Rate Limits

1. Dashboard loads multiple data sources in parallel (balance, usage, plans)
2. If Autumn rate-limits, individual sections should show error states independently (not crash the whole page)
3. TanStack Query's `staleTime` and caching prevent excessive re-fetches

## Open Questions

1. ~~**Dashboard domain**: `app.epicenter.so` vs `dashboard.epicenter.so`?~~ **Resolved**: Same-origin. Dashboard is served from the API Worker at `/dashboard/*`. No separate domain needed.

2. ~~**Rollover on plan downgrade**: Does Autumn preserve rollover balance when switching plans within the same group?~~ **Resolved**: No. Autumn rejects `carryOverBalances` on downgrades. Rollover is Ultra/Max only to avoid creating a promise we can't keep. See "Credit Rollover" section.

3. **Chart library**: shadcn-svelte's Chart component uses LayerChart. Should we evaluate alternatives (e.g., Chart.js, unovis)?
   - **Recommendation**: Use LayerChart via shadcn-svelte Chart. It's the official integration and composable. Don't add dependencies we don't need.

4. **Token-level tracking**: Should we log per-request token counts (input/output) for more granular cost breakdown?
   - **Recommendation**: Defer. Credit-level data from Autumn is sufficient for MVP. Token tracking via TanStack AI's `onFinish` callback can be added later if users want "cost per conversation" views.

5. **Credit Top-Up pricing**: Current top-up is $5/500 credits ($0.01/credit = $1/100 credits). Should this change with the new pricing?
   - **Recommendation**: Keep at $5/500 ($1/100 credits). It's at the Pro overage rate, which is intentionally more expensive than plan credits to incentivize upgrading. Ultra/Max users with their lower overage rates would just let overage kick in naturally.

## Success Criteria

- [ ] 4 plans visible in Autumn dashboard (Free/Pro/Ultra/Max) with correct pricing and rollover
- [ ] Ultra plan shows 14-day free trial config with `cardRequired: false` and `autoEnable: true`
- [ ] Annual plan variants present (`pro_annual`, `ultra_annual`, `max_annual`)
- [ ] `bunx atmn preview` shows clean state (config matches remote)
- [ ] Free tier users cannot call models costing >2 credits (model gating enforced in `ai-chat.ts`)
- [ ] Dashboard SPA loads at `/dashboard` path on the same Worker with auth
- [ ] Credit balance displays correctly including rollover portion
- [ ] Usage chart renders 30-day data grouped by model
- [ ] Model cost table shows all supported models with credit costs
- [ ] Plan upgrade flow works (dashboard → Stripe checkout → back to dashboard)
- [ ] Hono routes return correct typed responses via `hc`
- [ ] `billing.tsx` deleted, `/billing` redirects to dashboard
- [ ] New user signup triggers Ultra auto-trial (14 days, no card)

## References

### Codebase Files

- `apps/api/autumn.config.ts`: Feature + plan definitions for `atmn push`
- `apps/api/src/billing-plans.ts`: Runtime plan metadata (IDs, prices, credits)
- `apps/api/src/autumn.ts`: `createAutumn(env)` factory
- `apps/api/src/model-costs.ts`: Model → credit cost mapping
- `apps/api/src/ai-chat.ts`: Credit check + refund logic
- `apps/api/src/billing.tsx`: Current server-rendered billing page
- `apps/api/src/app.ts`: Hono app, middleware, route wiring
- `packages/ui/`: shadcn-svelte component library (60+ components)
- `packages/ui/README.md`: Component management guide (`#` path alias, styling patterns)

### External Documentation

- [Autumn Events Aggregate API](https://docs.useautumn.com/api-reference/events/aggregateEvents): timeseries with groupBy
- [Autumn Events List API](https://docs.useautumn.com/api-reference/events/listEvents): individual event history
- [Autumn Rollovers](https://docs.useautumn.com/documentation/modelling-pricing/rollovers): rollover config (max, expiry)
- [Autumn Track Usage](https://docs.useautumn.com/api-reference/core/track): negative value = credit refund
- [Autumn Prepaid Pricing](https://docs.useautumn.com/documentation/modelling-pricing/prepaid-pricing): top-up model
- [shadcn-svelte Chart](https://www.shadcn-svelte.com/docs/components/chart): LayerChart integration
- [shadcn-svelte DataTable](https://www.shadcn-svelte.com/docs/components/data-table): TanStack Table
- [shadcn-svelte Dashboard Example](https://shadcn-svelte.com/examples/dashboard): layout reference
- [Hono RPC Client](https://hono.dev/docs/guides/rpc): `hc` type-safe client
- [TanStack AI Streaming](https://tanstack.com/ai/latest/docs/guides/streaming): RUN_FINISHED event, usage data
- [TanStack AI Observability](https://tanstack.com/ai/latest/docs/guides/observability): event client for telemetry
- [Svelte 5 Runes](https://svelte.dev/docs/svelte/$state): $state, $derived, $props
- [LayerChart](https://github.com/techniq/layerchart): chart library used by shadcn-svelte
- [Autumn Trials](https://docs.useautumn.com/documentation/modelling-pricing/trials): freeTrial config, card-not-required, auto-trial
- [Autumn Trial Example (no card)](https://docs.useautumn.com/examples/trial-card-not-required): autoEnable + freeTrial pattern
- [Autumn Plan Items](https://docs.useautumn.com/documentation/concepts/plan-items): reset intervals, billing intervals (month/year), rollover
- [Autumn Proration](https://docs.useautumn.com/documentation/modelling-pricing/proration): automatic proration on plan changes
- [Autumn Balances](https://docs.useautumn.com/documentation/concepts/balances): breakdown array, deduction order, stacking
- [Autumn Billing Controls](https://docs.useautumn.com/documentation/customers/billing-controls): spend limits, usage alerts, auto top-ups, overage controls
- [Autumn Spend Limits & Usage Alerts](https://docs.useautumn.com/documentation/modelling-pricing/spend-limits): threshold types, webhook payload
- [Autumn Preview Attach](https://docs.useautumn.com/api-reference/billing/previewAttach): preview billing changes before committing
