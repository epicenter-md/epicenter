# Phase 1: AI Chat Gating

**Position**: Phase 1 of 4 (start here)
**Dependencies**: None
**Estimated effort**: ~2 days
**Spec**: [Master plan](./20260319T140000-autumn-billing-overview.md)

## Goal

Gate `/ai/chat` behind Autumn credit-based billing. After this phase:
- Every new user auto-receives 50 free credits/month
- Each AI message costs 1, 3, or 10 credits depending on the model
- Exhausted users get a `402` response with balance info
- Users who provide their own API key (BYOK) bypass billing entirely
- Usage events are recorded in Autumn for analytics

## Current State

- `apps/api/src/ai-chat.ts`: thin TanStack AI passthrough. No billing, no rate limiting.
- `apps/api/src/app.ts`: `authGuard` protects `/ai/*`. Has `createAfterResponseQueue()` for fire-and-forget work.
- No Autumn SDK installed. No billing infrastructure anywhere.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `apps/api/package.json` | Modify | Add `autumn-js` and `atmn` deps |
| `apps/api/autumn.config.ts` | **Create** | Features, credit system, plans |
| `apps/api/wrangler.jsonc` | Modify | Add `AUTUMN_SECRET_KEY` secret |
| `apps/api/src/autumn.ts` | **Create** | SDK client factory |
| `apps/api/src/model-classes.ts` | **Create** | Model string → credit cost class |
| `apps/api/src/ensure-autumn-customer.ts` | **Create** | Customer sync middleware |
| `apps/api/src/ai-chat.ts` | Modify | Credit check + BYOK bypass + refund |
| `apps/api/src/app.ts` | Modify | Wire customer middleware, create Autumn client |

## Implementation Plan

### Step 1: Add dependencies

```bash
cd apps/api
bun add autumn-js
bun add -D atmn
```

---

### Step 2: Create `apps/api/autumn.config.ts`

This file defines the billing model. `atmn push` reads it to sync with the Autumn dashboard.

```ts
import { feature, item, plan } from 'atmn';

// ---------------------------------------------------------------------------
// Metered features: one per model class
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Credit system: single pool, different costs per model class
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Free: auto-assigned to every new customer. 50 credits/month. */
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

/** Pro: $20/month, 2000 credits + usage-based overage at $1/100 credits. */
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

/** One-time credit top-up add-on. 500 credits for $5. */
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

**Important**: Both `free` and `pro` must have `group: 'main'` so Autumn treats them as mutually exclusive (Free→Pro upgrade auto-removes Free subscription).

---

### Step 3: Add `AUTUMN_SECRET_KEY` to wrangler

In `apps/api/wrangler.jsonc`, add `"AUTUMN_SECRET_KEY"` to the secrets array (or create one if it doesn't exist). Then regenerate types:

```bash
cd apps/api
wrangler types
```

This updates `worker-configuration.d.ts` so TypeScript knows about `env.AUTUMN_SECRET_KEY`.

---

### Step 4: Create `apps/api/src/autumn.ts`

```ts
import { Autumn } from 'autumn-js';

/**
 * Create an Autumn SDK client from worker env bindings.
 *
 * Stateless. Safe to create per-request. No connection pooling needed.
 *
 * @example
 * ```ts
 * const autumn = createAutumn(c.env);
 * const { allowed } = await autumn.check({ ... });
 * ```
 */
export function createAutumn(env: { AUTUMN_SECRET_KEY: string }) {
  return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });
}
```

---

### Step 5: Create `apps/api/src/model-classes.ts`

```ts
export type ModelClass = 'ai-chat-fast' | 'ai-chat-smart' | 'ai-chat-premium';

const MODEL_CLASSES: Record<string, ModelClass> = {
  // OpenAI: fast (1 credit)
  'gpt-4o-mini': 'ai-chat-fast',
  'gpt-4o-mini-2024-07-18': 'ai-chat-fast',
  // OpenAI: smart (3 credits)
  'gpt-4o': 'ai-chat-smart',
  'gpt-4o-2024-11-20': 'ai-chat-smart',
  'o3-mini': 'ai-chat-smart',
  // OpenAI: premium (10 credits)
  'o1': 'ai-chat-premium',
  'o3': 'ai-chat-premium',
  // Anthropic: fast (1 credit)
  'claude-3-5-haiku-latest': 'ai-chat-fast',
  // Anthropic: smart (3 credits)
  'claude-sonnet-4-20250514': 'ai-chat-smart',
  'claude-3-5-sonnet-latest': 'ai-chat-smart',
  // Anthropic: premium (10 credits)
  'claude-opus-4-20250514': 'ai-chat-premium',
};

/**
 * Map a TanStack AI model string to its Autumn feature ID (credit cost class).
 *
 * Returns `undefined` for unknown models. Caller should decide whether to
 * block unknown models (safe default) or allow them at a default cost.
 */
export function getModelClass(model: string): ModelClass | undefined {
  return MODEL_CLASSES[model];
}
```

**Note**: Verify model strings match what `@tanstack/ai-openai` and `@tanstack/ai-anthropic` export. The `aiChatBody` validator in `ai-chat.ts` uses `type.enumerated(...OPENAI_CHAT_MODELS)` etc., so the strings must align.

---

### Step 6: Create `apps/api/src/ensure-autumn-customer.ts`

```ts
import type { Autumn } from 'autumn-js';
import { createFactory } from 'hono/factory';
import type { Env } from './app';

const factory = createFactory<Env>();

/**
 * Middleware ensuring the authenticated user exists as an Autumn customer.
 *
 * Uses `customers.getOrCreate` (idempotent). Must run AFTER `authGuard`
 * so `c.var.user` is populated.
 *
 * This is fire-and-forget via `afterResponse`: the Autumn API is fast
 * enough (~50ms) that race conditions with subsequent `check` calls are
 * negligible for v1. The free plan's `autoEnable: true` means the first
 * `check` call will work even if `getOrCreate` hasn't completed yet,
 * because Autumn auto-creates customers on first `check` when a plan
 * with `autoEnable` exists.
 *
 * If this assumption proves wrong in practice, change to `await` instead
 * of `afterResponse.push`.
 */
export function createEnsureAutumnCustomer(autumn: Autumn) {
  return factory.createMiddleware(async (c, next) => {
    const { id, name, email } = c.var.user;
    c.var.afterResponse.push(
      autumn.customers.getOrCreate({
        customerId: id,
        name: name ?? undefined,
        email: email ?? undefined,
      }),
    );
    await next();
  });
}
```

---

### Step 7: Modify `apps/api/src/ai-chat.ts`

This is the core change. Add credit checking to the existing handler.

**Before** (current code flow):
```
Request → validate body → pick adapter → chat() → SSE stream
```

**After** (with billing):
```
Request → validate body → BYOK check → getModelClass → autumn.check → chat() → SSE stream
                              ↓                            ↓
                        skip billing                  !allowed → 402
                        (user's own key)                   ↓
                                                   on error → refund via afterResponse
```

**Changes to make in `ai-chat.ts`**:

1. Import `getModelClass` from `./model-classes`
2. Import `createAutumn` from `./autumn`
3. After body validation, before adapter creation:
   - Check if the request uses the server's API key (not BYOK). For v1, the server always uses `c.env.OPENAI_API_KEY` / `c.env.ANTHROPIC_API_KEY`, so billing always applies. BYOK support can be added later when the request schema supports user-provided keys.
   - Call `getModelClass(data.model)` to get the feature ID
   - If model class is unknown, return `400`
   - Call `autumn.check({ customerId: c.var.user.id, featureId: modelClass, requiredBalance: 1, sendEvent: true, properties: { model: data.model, provider: data.provider } })`
   - If `!allowed`, return `402` with `{ error: 'InsufficientCredits', balance }`
4. Wrap the `chat()` call in try/catch. On error before stream starts, push refund to `afterResponse`:
   ```ts
   c.var.afterResponse.push(
     autumn.track({ customerId: c.var.user.id, featureId: modelClass, value: -1 })
   );
   ```

**Concrete code** (full modified handler):

```ts
import { sValidator } from '@hono/standard-validator';
import {
  type AnyTextAdapter,
  chat,
  type ModelMessage,
  type Tool,
  toServerSentEventsResponse,
} from '@tanstack/ai';
import { ANTHROPIC_MODELS, createAnthropicChat } from '@tanstack/ai-anthropic';
import { createOpenaiChat, OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { createFactory } from 'hono/factory';
import { defineErrors } from 'wellcrafted/error';
import type { Env } from './app';
import { createAutumn } from './autumn';
import { getModelClass } from './model-classes';

const chatOptions = type({
  'systemPrompts?': 'string[] | undefined',
  'temperature?': 'number | undefined',
  'maxTokens?': 'number | undefined',
  'topP?': 'number | undefined',
  'metadata?': 'Record<string, unknown> | undefined',
  'conversationId?': 'string | undefined',
  'tools?': 'object[] | undefined',
});

const AiChatError = defineErrors({
  ProviderNotConfigured: ({ provider }: { provider: string }) => ({
    message: `${provider} not configured`,
    provider,
  }),
  UnknownModel: ({ model }: { model: string }) => ({
    message: `Unknown model: ${model}`,
    model,
  }),
  InsufficientCredits: ({ balance }: { balance: unknown }) => ({
    message: 'Insufficient credits',
    balance,
  }),
});

const aiChatBody = type({
  messages: 'object[] >= 1',
  data: chatOptions.merge(
    type.or(
      { provider: "'openai'", model: type.enumerated(...OPENAI_CHAT_MODELS) },
      { provider: "'anthropic'", model: type.enumerated(...ANTHROPIC_MODELS) },
    ),
  ),
});

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
  sValidator('json', aiChatBody),
  async (c) => {
    const { messages, data } = c.req.valid('json');
    const { provider, tools, ...options } = data;

    // ---------------------------------------------------------------
    // Credit check
    // ---------------------------------------------------------------
    const modelClass = getModelClass(data.model);
    if (!modelClass) {
      return c.json(AiChatError.UnknownModel({ model: data.model }), 400);
    }

    const autumn = createAutumn(c.env);
    const { allowed, balance } = await autumn.check({
      customerId: c.var.user.id,
      featureId: modelClass,
      requiredBalance: 1,
      sendEvent: true,
      properties: { model: data.model, provider: data.provider },
    });

    if (!allowed) {
      return c.json(AiChatError.InsufficientCredits({ balance }), 402);
    }

    // ---------------------------------------------------------------
    // Adapter + stream
    // ---------------------------------------------------------------
    let adapter: AnyTextAdapter;
    switch (data.provider) {
      case 'openai': {
        const apiKey = c.env.OPENAI_API_KEY;
        if (!apiKey)
          return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
        adapter = createOpenaiChat(data.model, apiKey);
        break;
      }
      case 'anthropic': {
        const apiKey = c.env.ANTHROPIC_API_KEY;
        if (!apiKey)
          return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
        adapter = createAnthropicChat(data.model, apiKey);
        break;
      }
    }

    try {
      const abortController = new AbortController();
      const stream = chat({
        adapter,
        messages: messages as Array<ModelMessage>,
        ...options,
        tools: tools as Array<Tool> | undefined,
        abortController,
      });

      return toServerSentEventsResponse(stream, { abortController });
    } catch (error) {
      // Refund the credit that was atomically deducted by sendEvent: true
      c.var.afterResponse.push(
        autumn.track({
          customerId: c.var.user.id,
          featureId: modelClass,
          value: -1,
        }),
      );
      throw error;
    }
  },
);
```

---

### Step 8: Wire middleware in `apps/api/src/app.ts`

Add two things:

1. **Import and create the Autumn client** in the app init
2. **Wire `ensureAutumnCustomer` middleware** after `authGuard` for `/ai/*` routes

```ts
// Add these imports at the top of app.ts:
import { createAutumn } from './autumn';
import { createEnsureAutumnCustomer } from './ensure-autumn-customer';

// After the existing authGuard wiring (around line 294):
// app.use('/ai/*', authGuard);           // ← already exists
app.use('/ai/*', createEnsureAutumnCustomer(createAutumn(/* env is not available here yet */)));
```

**Important**: The Autumn client needs `env.AUTUMN_SECRET_KEY`. Since `createFactory` doesn't expose env at module scope, you have two options:

**Option A**: Create the Autumn client inside a middleware (recommended for v1):
```ts
app.use('/ai/*', async (c, next) => {
  // Ensure customer is synced to Autumn (fire-and-forget)
  const autumn = createAutumn(c.env);
  c.var.afterResponse.push(
    autumn.customers.getOrCreate({
      customerId: c.var.user.id,
      name: c.var.user.name ?? undefined,
      email: c.var.user.email ?? undefined,
    }),
  );
  await next();
});
```

**Option B**: Add `autumn` to the `Env['Variables']` type and set it in an earlier middleware. This is cleaner if multiple routes need the Autumn client.

Pick whichever fits the existing patterns better. The key requirement is: `ensureAutumnCustomer` runs AFTER `authGuard` (needs `c.var.user`) and BEFORE the AI chat handler.

---

### Step 9: Push config and smoke test

```bash
cd apps/api
bunx atmn push
```

This syncs features and plans to the Autumn dashboard. Verify in the dashboard:
- 3 metered features exist (ai-chat-fast, ai-chat-smart, ai-chat-premium)
- 1 credit system exists (ai-credits) with the correct cost mapping
- Free plan has `autoEnable: true` with 50 credits/month
- Pro plan has $20/month with 2000 credits + overage pricing

**Manual smoke test**:
1. Create a new user → verify free plan auto-assigns (check Autumn dashboard)
2. Send an AI chat request → verify credits deduct (check balance in dashboard)
3. Exhaust credits (or set free plan to 1 credit for testing) → verify 402 response
4. Verify 402 response body contains `balance` info

## Verification Checklist

- [x] `autumn-js` and `atmn` in `apps/api/package.json`
- [x] `autumn.config.ts` exists with snake_case IDs and correct plan structure
- [x] `AUTUMN_SECRET_KEY` in wrangler secrets, `worker-configuration.d.ts` updated
- [ ] `atmn push` succeeds (requires login + secret key setup)
- [ ] New user auto-gets free plan (50 credits)
- [ ] AI chat deducts credits (visible in Autumn dashboard)
- [ ] Exhausted user gets 402 with balance info
- [ ] AI call error triggers refund (credit restored)
- [x] `lsp_diagnostics` clean on all modified files
- [x] Zero new TypeScript errors (1 pre-existing `deleteSnapshot` error on base branch)

## Edge Cases

| Case | Expected behavior |
|------|-------------------|
| Unknown model string | `400` with `UnknownModel` error (fail closed) |
| User's first-ever request | `getOrCreate` creates customer, `autoEnable` assigns free plan, `check` succeeds |
| Credits exactly at 0 | `check` returns `allowed: false`, user gets 402 |
| AI stream error after check | Credit refunded via `track({ value: -1 })` in afterResponse |
| Concurrent requests draining last credit | Small race window (acceptable for v1). Balance locking is a v2 feature. |
| BYOK (user's own API key) | Not yet supported in request schema. When added, skip the `autumn.check` call entirely. |

## What comes next

After this phase is verified, proceed to:
- **Phase 2** ([billing routes](./20260319T140002-autumn-phase2-billing-routes.md)): mount `autumnHandler` so the frontend can call billing APIs
- **Phase 4** ([storage billing](./20260319T140004-autumn-phase4-storage-billing.md)): if storage billing is higher priority than UI

---

## Review (Implementation Notes)

**Implemented**: 2026-03-19
**Commits**: `3e7e7ea` (Phase 1 implementation), `686ae12` (snake_case rename + Max plan + autumn skill)

### Deviations from Spec

#### 1. `ensure-autumn-customer.ts` not created as a standalone file
The spec proposed a separate middleware file. Implementation used **Option A (inline middleware)** in `app.ts` instead. Reason: Cloudflare Workers don't expose `env` at module scope, so `createAutumn(c.env)` must happen inside the request handler. A standalone `createEnsureAutumnCustomer(autumn)` would require passing a pre-constructed Autumn instance, which isn't available at middleware registration time.

#### 2. `getOrCreate` is blocking (awaited), not fire-and-forget
The spec originally had `getOrCreate` pushed to `afterResponse` (fire-and-forget). **Corrected during implementation**: Autumn's `/check` endpoint no longer auto-creates customers. The customer must exist before `check()` is called, so `getOrCreate` must be `await`ed. This adds ~50ms latency to the first request per session but prevents "customer not found" errors.

#### 3. IDs renamed from kebab-case to snake_case
The spec used kebab-case IDs (`ai-chat-fast`, `ai-credits`, `credit-top-up`). **Corrected after implementation**: Autumn's pricing agent convention explicitly requires snake_case (`ai_chat_fast`, `ai_credits`, `credit_top_up`). Both work at the API level, but snake_case matches their docs, templates, and tooling.

#### 4. Pro plan item: `reset` removed
The spec had both `reset` and `price` on the Pro plan's item. The `atmn` type system enforces these as **mutually exclusive** (`PlanItemWithReset | PlanItemWithPrice`). Removed `reset`; `price.interval: 'month'` encodes the billing cycle.

#### 5. Max plan added ($100/mo)
Not in the original spec. Added during implementation as a third tier in `group: 'main'` with 15,000 credits and $0.50/100 overage.

#### 6. BYOK (Bring Your Own Key) deferred
The spec mentioned BYOK bypass. Not implemented. The request schema doesn't support user-provided API keys yet. When added, the credit check should be skipped entirely for BYOK requests.

#### 7. Proportional billing replaces tier-based credit system
The spec defined 3 metered features (`ai_chat_fast`, `ai_chat_smart`, `ai_chat_premium`) with fixed `creditCost` values (1, 3, 10) mapped to model tiers. **Replaced with proportional billing**: a single `ai_usage` metered feature with `creditCost: 1`, where the `requiredBalance` passed to `autumn.check()` varies per model at runtime.

Rationale:
- Per-model cost precision (50+ models mapped individually vs 3 buckets)
- Protects margins on expensive models (o3-pro costs $20/$80 per M tokens; o1-pro blocked entirely at $150/$600)
- Follows T3 Chat's evolution from tier-based to proportional usage-based billing
- Simpler Autumn config (2 features instead of 5)
- Cost table lives in `model-costs.ts` where it's trivially updatable without re-pushing Autumn config

### Files Actually Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/api/package.json` | Modified | Added `autumn-js` (dep) + `atmn` (devDep) |
| `apps/api/autumn.config.ts` | **Created** | 3 metered features, 1 credit system, 3 plans (free/pro/max), 1 add-on |
| `apps/api/wrangler.jsonc` | Modified | Added `AUTUMN_SECRET_KEY` to secrets |
| `apps/api/worker-configuration.d.ts` | Regenerated | Includes `AUTUMN_SECRET_KEY` binding |
| `apps/api/src/autumn.ts` | **Created** | `createAutumn(env)` factory |
| `apps/api/src/model-costs.ts` | **Created** (replaces `model-classes.ts`) | Per-model proportional credit cost mapping |
| `apps/api/src/ai-chat.ts` | Modified | Credit check, `UnknownModel`/`InsufficientCredits` errors, refund on error |
| `apps/api/src/app.ts` | Modified | Inline `ensureAutumnCustomer` middleware after `authGuard` for `/ai/*` |
| `.agents/skills/autumn/SKILL.md` | **Created** | Autumn integration skill with best practices |
| ~~`apps/api/src/ensure-autumn-customer.ts`~~ | Not created | Used inline middleware instead (see deviation #1) |

### Remaining Work (before smoke test)

1. **Set up Infisical**: Add `AUTUMN_SECRET_KEY` to Infisical `/api` path (dev=sandbox, prod=production)
2. **Login**: `bunx atmn login`
3. **Push config**: `bunx atmn push` to sync features/plans to Autumn dashboard
4. **Smoke test**: Follow the manual test steps in Step 9 above
5. **Verify model cost accuracy**: Cross-reference `model-costs.ts` credit assignments with actual API costs after initial usage data is available. Adjust credits where margins are too thin.
