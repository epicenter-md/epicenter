---
name: autumn
description: 'Autumn billing in Epicenter: the `catalog.ts` pricing source, `autumn-js` reservations and checks, the `atmn` CLI, plan gates, and metered AI usage. Use when changing billing, pricing, credits, plan access, refunds, or usage events.'
metadata:
  author: epicenter
  version: '1.3'
---

# Autumn Billing Integration Guide

Autumn is the usage-based billing provider behind Epicenter's hosted cloud
(`apps/api`). This skill covers the conventions and API surface. It does not
re-derive the billing design: that lives in `docs/guides/billing-autumn-boundary.md`,
which is current and authoritative. Read the guide before changing anything in
`apps/api/worker/billing/`; use this skill for naming rules, feature-type
semantics, the SDK/CLI surface, and upstream grounding.

## Reference and links

- [Autumn](https://github.com/useautumn/autumn): usage-based billing platform
- [Autumn TypeScript SDK + CLI](https://github.com/useautumn/typescript): `autumn-js` SDK and `atmn` CLI
- [Autumn docs](https://docs.useautumn.com), [dashboard](https://app.useautumn.com), and [API keys](https://app.useautumn.com/dev?tab=api_keys)

## Upstream grounding

When an Autumn noun (Feature, Product/Plan, ProductItem, Price, Customer,
subscription, credit system), a pricing shape, an SDK call, CLI behavior, or a
usage-event semantic affects correctness, verify against source before relying
on memory. If DeepWiki MCP is available, ask a narrow question against
`useautumn/autumn`; otherwise use the installed package types, upstream source,
or official docs. Treat DeepWiki as orientation, then confirm decisive details
against the local billing code and installed `autumn-js` types before changing
code.

Skip DeepWiki for the hosted-only Epicenter boundaries already documented in
`AGENTS.md`, the boundary guide, and below.

Autumn's own API keeps moving. As of this writing the notable upstream surface
we do not yet use is `ai_credit_system` + `trackTokens` (see "Forward path"
below). Re-query DeepWiki before assuming any API here is still the newest way.

---

## Source of truth in this repo

Do not scatter pricing or SDK calls. There is one path:

| File | Role |
|------|------|
| `apps/api/worker/billing/catalog.ts` | The one source of pricing truth: `FEATURE_IDS`, `PLAN_IDS`, `PLANS`, free-tier ceiling, per-minute transcription rate. Nothing else holds plan or feature config. |
| `apps/api/worker/billing/autumn-products.ts` | Maps the catalog onto `atmn` `feature()` / `plan()` / `item()` builders. |
| `apps/api/autumn.config.ts` | The `atmn` entry point: re-exports the builders from `autumn-products.ts`. |
| `apps/api/worker/billing/autumn.ts` | The only file that imports `autumn-js`. Owns `createAutumnClient(env)` (fail-closed), provider-error mapping, and the provider-vs-bug classifier. |
| `apps/api/worker/billing/service.ts` | Every Autumn round-trip. Owns the AI reservation lock (the `lockId` never leaves it) and the dashboard DTOs. |
| `apps/api/worker/billing/policies.ts` | Cloud-only middleware that wraps the inference gateway routes and settles reservations around the response. |
| `apps/api/worker/billing/routes.ts` | `/api/billing/*` HTTP shape and the single provider-error `onError` boundary. |
| `packages/constants/src/ai-providers.ts` | `AI_MODELS` / `MODELS_BY_ID`: the model to `{ provider, label, credits }` table. This is where per-model credit cost lives. |

`docs/guides/billing-autumn-boundary.md` explains why the layering is shaped
this way (fail-closed reads vs guards, the reservation lock, the opaque error).

---

## Domain model checks

- Use Autumn's current nouns precisely: Feature, Plan (the config builder; the
  API also calls attachable products "products"), ProductItem/`item`, Price,
  Customer, and subscription.
- Validate item shapes before pushing config. Most failures come from invalid
  interval combinations, a missing linked feature, or a price/reset variant that
  does not match the feature type.
- Decide fail-open versus fail-closed at every call site. Epicenter fails closed:
  `createAutumnClient` sets `failOpen: false`, so a provider outage throws
  instead of silently allowing paid work.
- If subscription state transitions or Stripe webhooks are touched, keep the
  handler idempotent across retries.

---

## Naming conventions (critical)

**All IDs use `snake_case`.** This is Autumn's explicit convention.

Feature IDs are **descriptive** (not abstract tier numbers) and
**ecosystem-scoped** (not tied to a single app feature). `ai_usage` is the one
metered feature every AI capability consumes.

```typescript
// CORRECT: descriptive, ecosystem-scoped
feature({ id: 'ai_usage', ... })
feature({ id: 'ai_credits', ... })
plan({ id: 'pro', ... })
plan({ id: 'credit_top_up', ... })

// WRONG: tied to a single feature ("chat")
feature({ id: 'ai_chat_usage', ... })

// WRONG: abstract tier numbers
feature({ id: 'ai_tier_1', ... })

// WRONG: kebab-case
feature({ id: 'ai-usage', ... })
```

IDs in `FEATURE_IDS` and `PLAN_IDS` are durable: they appear in Autumn
subscriptions, Stripe webhooks, and historical events. Renaming needs a
coordinated migration; adding new IDs is safe.

---

## Feature types

| Type | Use case | Example |
|------|----------|---------|
| `metered` (`consumable: true`) | Usage that resets periodically | `ai_usage` (AI invocations) |
| `metered` (`consumable: false`) | Persistent allocation | `storage_bytes`, seats |
| `credit_system` | A credit pool that maps to metered features via `creditSchema` | `ai_credits` |
| `ai_credit_system` | A dollar balance for LLM token usage, priced from models.dev + markups | not used yet (see Forward path) |
| `boolean` | Feature flag on/off | advanced analytics |

A `credit_system` requires linked `metered` features with `consumable: true`;
each entry in `creditSchema` gives a `creditCost` (credits per unit).

```typescript
// packages/.../autumn-products.ts (built from catalog.ts)
export const aiUsage = feature({
  id: 'ai_usage', name: 'AI Usage', type: 'metered', consumable: true,
});

export const aiCredits = feature({
  id: 'ai_credits', name: 'AI Credits', type: 'credit_system',
  creditSchema: [{ meteredFeatureId: aiUsage.id, creditCost: 1 }],
});
```

### Proportional billing (how Epicenter prices models today)

Rather than one metered feature per model, there is a **single** metered feature
(`ai_usage`) with `creditCost: 1`, and the per-call cost is varied at runtime
through `requiredBalance`. Per-model integer costs live in `AI_MODELS`
(`packages/constants/src/ai-providers.ts`), not in `autumn.config.ts`, so the
Autumn dashboard stays a handful of features instead of dozens.

```typescript
// packages/constants/src/ai-providers.ts
export const AI_MODELS = [
  { id: 'gpt-5.4-mini', provider: 'openai', label: 'Fast', credits: 2 },
  { id: 'gpt-5.5',      provider: 'openai', label: 'Best', credits: 10 },
  // ...
] as const;
// MODELS_BY_ID resolves id -> { provider, label, credits }
```

`reserveAiChat` looks the model up in `MODELS_BY_ID`, then holds exactly
`credits` against `ai_usage`. An unknown id is `AiChatError.UnknownModel`, which
is how expensive or unlisted models are blocked (omit them from `AI_MODELS`).
The free tier additionally rejects any model whose cost exceeds
`FREE_TIER_MAX_CREDITS_PER_CALL` with `AiChatError.ModelRequiresPaidPlan`.

---

## AI usage: reserve with a lock, then settle

Epicenter does **not** use `check({ sendEvent: true })` or deduct-then-refund
for AI chat. It takes a **hold** (a lock), does the work, then confirms or
releases. The full rationale (crash-safety on Cloudflare Workers via the lock
TTL) is in the boundary guide; the shape is:

```typescript
// service.ts (chat): hold N credits
const check = await autumn.check({
  customerId: identity.principalId,
  featureId: FEATURE_IDS.aiUsage,
  requiredBalance: credits,
  lock: { lockId, enabled: true, expiresAt: Date.now() + LOCK_TTL_MS },
  properties: { model, provider },
});

// policies.ts (around the gateway): settle after the response
await next();
c.var.afterResponseQueue.push(
  c.res.status >= 400 ? reservation.release() : reservation.confirm(),
);

// service.ts: confirm commits the hold, release returns it
await autumn.balances.finalize({ lockId, action }); // action: 'confirm' | 'release'
```

If the worker dies before finalizing, Autumn auto-releases at `expiresAt`, so a
failed request never permanently overcharges. `lock.enabled: true` is required.

### Transcription: settle after, no lock

STT cost (audio duration) is unknown until the call returns, so the transcription
path uses a cheap pre-gate plus a post-success `track`:

```typescript
// pre-gate: is the wallet non-empty? (fail closed on a provider outage)
await autumn.check({ customerId, featureId: FEATURE_IDS.aiUsage, requiredBalance: 1 });

// after a 200, off the after-response queue: charge per minute
await autumn.track({
  customerId, featureId: FEATURE_IDS.aiUsage,
  value: credits, async: true,
  properties: { model, provider, seconds },
});
```

There is no negative-`track` refund anywhere in the codebase. Chat rolls back
with `release()`; transcription only ever settles a positive charge after
success. Use `track` with a positive value; reach for a lock when you need
rollback.

---

## Forward path: `ai_credit_system`

Autumn now ships a purpose-built feature type for exactly what the proportional
scheme hand-rolls. An `ai_credit_system` is a **dollar** balance (not integer
credits) priced from models.dev cost plus configurable markups, metered with a
dedicated `trackTokens({ customerId, modelId, inputTokens, outputTokens })` call:

```typescript
// upstream example, NOT how Epicenter is configured today
export const aiCredits = feature({
  id: 'ai_credits', name: 'AI Credits', type: 'ai_credit_system',
  defaultMarkup: 30,                              // models.dev cost + 30%
  providerMarkups: { openrouter: { markup: 25 } },
  modelMarkups: {
    'anthropic/claude-opus-4-5': { markup: 20 },
    'openai/gpt-4o-mini': { markup: -100 },       // free
    'custom/my-model': { markup: 25, inputCost: 0.01, outputCost: 0.03 },
  },
});
```

Adopting it would delete the `AI_MODELS` credit table and the manual
`requiredBalance` math, at the cost of handing token-cost truth to the vendor
and re-pricing from integer credits to dollars. That is a pricing and
architecture decision (write a spec, coordinate the durable-ID migration), not a
docs change. Flagged here so nobody re-implements model-cost tables believing
Autumn cannot do it.

---

## SDK: `autumn-js`

### Build the client through the repo adapter

Always construct through `createAutumnClient`, never `new Autumn(...)` directly.
The one invariant that matters is `failOpen: false`:

```typescript
// apps/api/worker/billing/autumn.ts: the ONLY autumn-js import site
export function createAutumnClient(env: { AUTUMN_SECRET_KEY: string }) {
  return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY, failOpen: false });
}
```

The SDK defaults `failOpen: true` (a vendor outage silently allows the request),
which is wrong for paid features. `failOpen: false` makes `check()` throw on an
outage so the guard fails closed. The client is stateless; build it per request.

### Customer sync (must be blocking)

`check()` does not auto-create customers, so the customer must exist first:

```typescript
await autumn.customers.getOrCreate({
  customerId: identity.principalId,
  email: identity.principalEmail,
  expand: ['subscriptions.plan', 'balances.feature'],
});
```

`expand` returns the active subscription and balances in one round-trip, which
is how `reserveAiChat` resolves the plan tier without a second call.

### Provider errors

`autumn-js` throws two unrelated class families: `AutumnError` (the service
answered non-2xx) and the `HTTPClientError` family (the network never reached
it). `isProviderError` checks both; `tryAutumn` turns provider throws into the
opaque `BillingError` and rethrows real bugs. Never widen `BillingError` to
include provider text.

---

## CLI: `atmn`

### Setup

```bash
bun x atmn login       # OAuth login, saves keys to .env
bun x atmn env         # verify org and environment
```

### Config

`apps/api/autumn.config.ts` is the entry point `atmn` resolves. It re-exports
builders from `worker/billing/autumn-products.ts`, which are built from
`catalog.ts`. To change pricing, edit `catalog.ts`, not the config file.

```typescript
import { feature, item, plan } from 'atmn';
```

### Push / pull

```bash
bun x atmn preview     # dry run, shows what would change
bun x atmn push        # push to sandbox (interactive confirmation)
bun x atmn push --prod # push to production
bun x atmn push --yes  # auto-confirm (CI)
bun x atmn pull        # pull remote config, regenerate SDK types
```

### Inspection

```bash
bun x atmn customers   # browse customers
bun x atmn plans       # browse plans
bun x atmn features    # browse features
bun x atmn events      # browse usage events
```

---

## Environment and secrets

| Key | Environment | Prefix |
|-----|-------------|--------|
| `AUTUMN_SECRET_KEY` | Sandbox (test) | `am_sk_test_...` |
| `AUTUMN_SECRET_KEY` | Production | `am_sk_prod_...` |

Use the **same key name** in both environments; let Infisical swap the value per
environment. For Cloudflare Workers: `wrangler secret put AUTUMN_SECRET_KEY`.
Local dev injects it via `infisical run` (see the `monorepo` skill).

---

## Plan structure

### Groups

Every Epicenter subscription plan shares one Autumn group (`group: 'main'` in
`autumn-products.ts`), so they are mutually exclusive: attaching a new plan
replaces the old one. Autumn handles the Stripe swap (upgrade: immediate with
proration; downgrade: end of cycle).

### Add-ons

`credit_top_up` is `addOn: true`: it stacks on any plan with no group conflict.
Its single item is `interval: 'one_off'` with a prepaid billing method (a
lifetime credit grant, no reset).

### `autoEnable`

Only the free plan sets `autoEnable: true`, so `customers.getOrCreate` assigns
it on creation. `autoEnable` is only valid on plans with no base price.

### Plan items: `reset.interval` vs `price.interval`

The **intervals** are mutually exclusive, not `reset` and `price` themselves.
`buildCreditsItem` in `autumn-products.ts` picks the variant per plan:

- **Free** (no overage sold): `included` + `reset: { interval: 'month' }`. The
  reset refreshes the grant; there is no price.
- **Paid** (overage sold): `included` + `price` with an `interval`. The
  `price.interval` drives **both** the overage billing cycle and the balance
  reset; there is no separate `reset`. Rollover plans add
  `rollover: { max: null, expiryDurationType: 'forever' }`.

The `included` field's own description reads "Balance resets to this each
interval for consumable features," which is why paid items need no `reset`.

---

## Stripe integration

- **Sandbox**: built-in Stripe test account, no setup.
- **Production**: connect via Dashboard, Integrations, Stripe (OAuth).
- `atmn push` creates the Stripe products/prices automatically.
- Autumn is the source of truth for customer state; Stripe handles payments.

---

## Common gotchas

1. **Build the client through `createAutumnClient`.** Bare `new Autumn(...)`
   loses `failOpen: false`, so an outage silently allows paid work.
2. **`getOrCreate` must be awaited** before any `check()`. Fire-and-forget
   causes "customer not found."
3. **AI chat uses a lock, not `sendEvent` or refund.** Reserve with
   `check({ lock })`, settle with `balances.finalize`. The TTL is the whole
   point: it self-heals if the worker dies mid-request.
4. **`lock.enabled: true` is required.** `lockId` and `expiresAt` alone do not
   place a hold.
5. **`featureId` for AI is always `ai_usage`.** Cost varies through
   `requiredBalance` (chat) or the tracked `value` (transcription), never
   through a per-model feature.
6. **Per-model cost lives in `AI_MODELS`**, not `autumn.config.ts` and not any
   `ai-model-pricing.ts` (there is no such file).
7. **Gateway guard failures answer in the OpenAI error shape**
   (`{ error: { message, code } }`), because the metered routes are the
   OpenAI-compatible `/v1/*` gateway. The variant name becomes `error.code`.
8. **Provider failure vs domain denial vs bug are three different things.**
   Provider failure to the wire is the opaque 503 `BillingError`; "out of
   credits" / "needs a paid plan" are typed `AiChatError` variants with real
   payloads; a local `TypeError` must stay a real 500. Never collapse them.
9. **`snake_case` for every ID.** Autumn's convention.
</content>
</invoke>
