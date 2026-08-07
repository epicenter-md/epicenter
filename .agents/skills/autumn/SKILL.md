---
name: autumn
description: 'Autumn billing decisions this repository has made: snake_case ecosystem-scoped feature IDs, one metered feature priced proportionally at runtime rather than one feature per model tier, the interval variants that cause most config failures, and the Workers request-scoped client. Use when changing pricing, plan gates, AI credit charging, metered usage, or autumn.config.ts. Do not use for Autumn SDK or atmn CLI surface area; ask DeepWiki against useautumn/autumn, and remember billing is hosted-only and never moves to a shared package.'
metadata:
  author: epicenter
  version: '2.0'
---

## Reference Repositories

- [Autumn](https://github.com/useautumn/autumn) : usage-based billing over Stripe
- [Autumn TypeScript SDK and CLI](https://github.com/useautumn/typescript)

## Upstream Grounding

Feature types, plan groups, add-ons, `autoEnable`, SDK initialization, the
`atmn` CLI surface, and Stripe connection are upstream behavior with upstream
docs. Ask DeepWiki a narrow question against `useautumn/autumn`, then verify
against local installed types before changing config. This file keeps no copy
of those tables, because a transcribed option list rots silently while reading
as authoritative.

## Domain Model Checks

Validate ProductItem shapes before pushing config. Most failures here come from
invalid interval combinations, missing linked features, or price and reset
variants that do not match the feature type.

Decide fail-open versus fail-closed per endpoint rather than globally. AI credit
charging fails closed, before the expensive provider call, because a fail-open
check hands out the provider spend it was meant to gate.

If Stripe webhooks or CustomerProduct transitions are touched, make the handler
idempotent, since the provider retries and a second apply would double-charge.

## Feature IDs Are snake_case And Ecosystem-Scoped

All IDs use `snake_case`; that is Autumn's own convention. Beyond that, a
feature ID names a model cost tier that any AI feature can consume, not the app
surface that happens to consume it first. Scoping an ID to `chat` means the next
feature either misreports its usage under a name that lies or needs a duplicate
feature for identical cost.

```typescript
// Correct: descriptive, ecosystem-scoped
feature({ id: 'ai_fast', ... })
feature({ id: 'ai_standard', ... })
feature({ id: 'ai_premium', ... })

// Wrong: tied to one surface
feature({ id: 'ai_chat_fast', ... })

// Wrong: abstract tier numbers, and wrong casing
feature({ id: 'ai_tier_1', ... })
feature({ id: 'ai-fast', ... })
```

## Price One Metered Feature Proportionally

Use a single metered feature with `creditCost: 1` and vary `requiredBalance` at
runtime, rather than one metered feature per cost tier. `check()` with
`sendEvent: true` deducts exactly `requiredBalance`, so per-model precision
costs one feature instead of dozens cluttering the dashboard.

The cost table is runtime code, not config: it changes when a provider's
pricing changes, which is far more often than the plan structure does.

```typescript
// worker/billing/ai-model-pricing.ts, not autumn.config.ts
const MODEL_CREDITS: Record<string, number> = {
  'gpt-4o-mini': 1,
  'claude-sonnet-4': 5,
  'claude-opus-4': 30,
};

const credits = MODEL_CREDITS[model];
await autumn.check({
  customerId,
  featureId: 'ai_usage',    // one feature for every model
  requiredBalance: credits, // varies per model
  sendEvent: true,
});
```

`sendEvent: true` deducts atomically, so do not also call `track()` on the happy
path. Refund an error with `track({ featureId: 'ai_usage', value: -credits })`
for the exact amount charged.

Blocking an expensive model needs no new config: omit it from `MODEL_CREDITS`,
and the unknown lookup returns `undefined` and yields a 400.

## The Interval Variants

The **intervals** are mutually exclusive, not `reset` and `price` themselves.
This is the distinction most config failures turn on, because the type names
suggest the fields conflict when only the intervals do.

- `PlanItemWithReset` has `reset.interval`. It may also carry a `price`, but
  that price may not have an `interval`. Use it for a free allocation that
  refreshes, optionally with one-time overage pricing.
- `PlanItemWithPriceInterval` has `price.interval` and no `reset`. That one
  interval drives both the billing cycle and the `included` balance reset for
  consumable features, so a separate `reset` would be redundant, not additive.
- `PlanItemNoReset` has neither. Use it for continuous features like seats, and
  for booleans.

```typescript
// Free plan: reset.interval refreshes the 50 included credits
item({ featureId: aiCredits.id, included: 50, reset: { interval: 'month' } })

// Paid plan: price.interval bills AND resets the 2000 included credits
item({
  featureId: aiCredits.id,
  included: 2000,
  price: { amount: 1, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
})
```

## The Client Is Request-Scoped

Cloudflare Workers do not expose `env` at module scope, so the Autumn client is
created inside the request handler and cannot be hoisted to a module singleton.

`getOrCreate` runs after `authGuard` and before any billing-gated route, and it
must be awaited: a fire-and-forget call lets `check()` race it and fail with
"customer not found." `autoEnable` also fires on customer creation rather than
on first `check()`, so a missing `getOrCreate` silently skips the default grant.

```typescript
app.use('/ai/*', async (c, next) => {
  const autumn = createAutumn(c.env);
  await autumn.customers.getOrCreate({
    customerId: c.var.user.id,
    name: c.var.user.name ?? undefined,
    email: c.var.user.email ?? undefined,
  });
  await next();
});
```

```typescript
const credits = getModelCredits(data.model);
if (!credits) return c.json(error, 400);

const { allowed } = await autumn.check({
  customerId: c.var.user.id,
  featureId: 'ai_usage',
  requiredBalance: credits,
  sendEvent: true,
});

if (!allowed) return c.json(error, 402);
```

## Secrets

`AUTUMN_SECRET_KEY` keeps the same key name in every environment; the secrets
manager swaps the value (`am_sk_test_...` versus `am_sk_prod_...`). Separate key
names per environment would put the environment fork in code, where it can
disagree with the deployment.

```bash
wrangler secret put AUTUMN_SECRET_KEY
infisical run --env=dev --path=/api -- wrangler dev
```

Autumn supports multiple active keys, so rotate by generating a new key,
updating secrets, then revoking the old one.

## Project Files

| File | Purpose |
|------|---------|
| `apps/api/autumn.config.ts` | Feature, credit system, and plan definitions |
| `apps/api/worker/billing/autumn.ts` | `createAutumnClient(env)` adapter and provider error mapping |
| `apps/api/worker/billing/ai-model-pricing.ts` | Model string to proportional credit cost |
| `apps/api/worker/billing/service.ts` | Billing operations, reservations, dashboard DTOs, storage sync |
| `apps/api/worker/billing/policies.ts` | AI credit charging and asset storage policies |
| `apps/api/worker/billing/routes.ts` | `/api/billing/*` routes and billing auth mount |
| `apps/api/worker/index.ts` | Cloud Worker composition and billing policy wiring |

## Resources

- [Autumn Docs](https://docs.useautumn.com)
- [Autumn Dashboard](https://app.useautumn.com)
- [API Keys](https://app.useautumn.com/dev?tab=api_keys)
