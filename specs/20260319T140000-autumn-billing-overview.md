# Autumn Billing Integration. Master Plan

**Last updated**: 2026-03-19
**Status**: Not started

## What We're Building

Adding usage-based billing to Epicenter using [Autumn v2](https://docs.useautumn.com). Two things get billed:

1. **AI chat**: credit-based. Users spend credits per message, with different costs per model tier (fast/smart/premium). Free plan gives 50 credits/month; Pro gives 2000 + overage. Users who bring their own API key (BYOK) skip billing entirely.
2. **Storage**: cumulative. Durable Object storage (workspaces + documents) is metered by bytes. Free plan includes a storage allowance; overages are billed.

## Current State (2026-03-19)

| Layer | What exists | What's missing |
|-------|------------|----------------|
| AI chat | `ai-chat.ts`: ungated TanStack AI passthrough | Credit check, usage tracking, 402 on exhaustion |
| Storage tracking | `durableObjectInstance.storageBytes` updated on every DO access | No billing limits, no Autumn integration |
| Billing infra | Nothing. No Stripe, no Autumn, no plans config | Everything |
| Auth | `authGuard` middleware on `/ai/*`, `/workspaces/*`, `/documents/*` | Works as-is. Billing layers on top |
| Fire-and-forget | `createAfterResponseQueue()` + `waitUntil()` | Works as-is. Autumn `track()` calls fit this pattern |
| Frontend | No billing page, no pricing table, no upgrade flow | Everything |

## Phase Map

| Phase | Spec | Depends on | Summary | Effort |
|-------|------|------------|---------|--------|
| **1** | [`autumn-phase1-ai-chat-gating.md`](./20260319T140001-autumn-phase1-ai-chat-gating.md) |: | SDK setup, customer sync, gate `/ai/chat` behind credits | ~2 days |
| **2** | [`autumn-phase2-billing-routes.md`](./20260319T140002-autumn-phase2-billing-routes.md) | Phase 1 | Mount `autumnHandler` so frontend can call billing APIs | ~30 min |
| **3** | [`autumn-phase3-billing-ui.md`](./20260319T140003-autumn-phase3-billing-ui.md) | Phases 1 + 2 | Svelte billing page, upgrade flow, 402 recovery | ~3-5 days |
| **4** | [`autumn-phase4-storage-billing.md`](./20260319T140004-autumn-phase4-storage-billing.md) | Phase 1 | Bill Durable Object storage via Autumn metered feature | ~2-3 days |

## Dependency Graph

```
Phase 1 (AI Chat Gating)
├──→ Phase 2 (Billing Routes) ──→ Phase 3 (Billing UI)
└──→ Phase 4 (Storage Billing)
```

**Phase 1 is the foundation.** Everything else depends on it. Phases 2/4 are independent of each other. Phase 3 requires Phase 2.

## Design Decisions (apply to all phases)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Billing platform | Autumn v2 (`autumn-js` v1.0.0) | Handles Stripe, credit systems, entitlement gating. Do NOT use `@useautumn/sdk` (not production-ready). |
| 2 | Customer identity | `user.id` from Better Auth | No org plugin, no workspace-level billing. One customer per user. |
| 3 | AI billing model | Credit system with model classes | Single pool, 3 tiers (1/3/10 credits). Users mix fast+premium freely. |
| 4 | Free plan | 50 credits/month, `autoEnable: true` | Every new user gets credits immediately. |
| 5 | Pro plan | $20/mo, 2000 credits + $1/100 overage | Standard AI SaaS pattern (Cursor, Codebuff). |
| 6 | BYOK bypass | Skip billing when user provides own API key | Per HOW_TO_MONETIZE.md: "bundled access" is the paid path. |
| 7 | Check+deduct | `check({ sendEvent: true })` | Atomic. No balance locking needed for v1 (fixed cost per message). |
| 8 | Storage model | `consumable: false` metered feature | Cumulative bytes, doesn't reset monthly. Synced from existing DB tracking. |
| 9 | Frontend billing | Svelte + TanStack Query over `/api/autumn/*` | Autumn's React hooks don't apply. Build equivalent wrappers. |
| 10 | SDK vs handler | SDK directly for gating (Phase 1), `autumnHandler` for UI routes (Phase 2) | Handler creates frontend-facing proxy routes. SDK is for server-side logic. |

## Key Codebase Files

| File | Role |
|------|------|
| `apps/api/src/app.ts` | Hono app. Auth, middleware, routes, DO stubs |
| `apps/api/src/ai-chat.ts` | AI chat endpoint (currently ungated) |
| `apps/api/src/db/schema.ts` | DB schema incl. `durableObjectInstance` with `storageBytes` |
| `apps/api/wrangler.jsonc` | CF Worker config. DO bindings, secrets |
| `apps/api/package.json` | Dependencies |
| `HOW_TO_MONETIZE.md` | Business model context: 3 revenue streams |

## Autumn SDK Quick Reference

```ts
import { Autumn } from 'autumn-js';

// Initialize (once per request, stateless)
const autumn = new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });

// Sync customer (idempotent, must happen before check/track)
await autumn.customers.getOrCreate({ customerId, name, email });

// Check entitlement + deduct atomically
const { allowed, balance } = await autumn.check({
  customerId,
  featureId: 'ai-chat-fast',   // the metered feature, not the credit system
  requiredBalance: 1,
  sendEvent: true,              // deduct on check
  properties: { model, provider },
});
// allowed: true/false
// balance: { granted, remaining, usage, nextResetAt }

// Refund on failure
await autumn.track({ customerId, featureId: 'ai-chat-fast', value: -1 });

// Track cumulative (storage): value is the NEW total, not a delta
await autumn.track({ customerId, featureId: 'storage-bytes', value: totalBytes });
```

**Critical**: As of Mar 2026, `/check` and `/track` no longer auto-create customers. The `customers.getOrCreate` call must happen first.

## What's NOT in scope (future leverage)

These are Autumn v2 features we'll use later, not now:

- **Balance locking**: for per-token billing. Reserve credits → do AI work → finalize with actual token count.
- **Sub-entity balances**: for per-workspace quotas when org plugin is added.
- **Auto top-ups**: customer configures automatic credit replenishment. Autumn + Stripe handle it.
- **Spend limits**: cap overage spending per customer.
- **Webhooks**: `customer.plan.changed`, `customer.balance.low` for nudge emails.
- **Own `ai_usage_log` table**: for analytics beyond Autumn events.

## Supersedes

These older specs contain valuable research but have been restructured into the phase specs above:

- `specs/20260318T120000-autumn-ai-billing.md`: research preserved in Phase 1
- `specs/20260319T105618-autumn-billing-ui.md`: research preserved in Phases 2 + 3
