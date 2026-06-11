# Shared Contract Over Derived Types

There's a concept in psychology called the "third variable problem." You observe that A and B are correlated and assume A causes B. Or B causes A. But neither is right. A hidden third variable, C, causes both.

Ice cream sales and drowning deaths both spike in summer. Ice cream doesn't cause drowning. Summer causes both.

The same pattern shows up in typed codebases. You have a server and a client. The types have to match. So you derive one from the other:

```
Server-first:  Server types → Client types
               (hc<AppType>, tRPC, GraphQL codegen)

Client-first:  Client types → Server types
               (rare, but some contract-first API tools)
```

Both approaches create a dependency arrow between the two. And that arrow drags things across the boundary that don't belong there.

## The problem with derived types

We hit this building a billing dashboard. The API is a Cloudflare Worker running Hono. The dashboard is a SvelteKit SPA. Hono has an `hc` client that infers route types from the server:

```typescript
// Server
const app = new Hono<{ Bindings: Cloudflare.Env }>()
  .get('/balance', (c) => c.json(data));

export type AppType = typeof app;

// Client
import type { AppType } from '@epicenter/api';
const client = hc<AppType>('/');
//    ^ fully typed: client.balance.$get() → typed response
```

Elegant. Until the dashboard's type checker tried to resolve `AppType`. The type chain goes `AppType` → `Hono<Env>` → `Cloudflare.Env` → `DurableObjectNamespace` → `KVNamespace` → half the Cloudflare Workers runtime. The dashboard doesn't need any of this. It just needs to know "GET /balance returns `{ balance: number }`."

This is [honojs/hono#2489](https://github.com/honojs/hono/issues/2489). The `hc` client needs the full `AppType` to infer routes, and `AppType` carries the server's entire type universe. The client is forced to resolve types it will never use.

The server didn't cause the client's type error. The client didn't cause the server's Cloudflare dependency. The coupling caused both problems. A causes B? B causes A? Neither. The derived-type relationship, C, causes both.

## The third file

Extract the types into an independent contract that neither side owns:

```
                ┌──────────────────┐
                │  billing-contract│  ← The "C"
                │                  │
                │  BalanceResponse │
                │  UsageParams     │
                │  UsageResponse   │
                │  ...             │
                └────────┬─────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
     ┌────────▼────────┐  ┌────────▼────────┐
     │  API routes      │  │  Dashboard       │
     │  (satisfies)     │  │  (consumes)      │
     └──────────────────┘  └──────────────────┘
```

The contract file has zero imports. No Cloudflare types, no Hono, no Svelte, no runtime dependencies. Pure type definitions:

```typescript
// billing-contract.ts: the shared boundary
export type BalanceResponse = {
  subscriptions?: Array<{ planId: string; addOn?: boolean }>;
  balances?: Record<string, { balance: number; included_usage: number }>;
};

export type UsageParams = {
  range?: '7d' | '30d' | '90d';
  binSize?: 'hour' | 'day' | 'month';
};
```

The server satisfies the contract:

```typescript
// billing-routes.ts
import type { ModelsResponse } from './billing-contract';

billingRoutes.get('/models', (c) => {
  return c.json({
    credits: MODEL_CREDITS,
    plans: PLANS,
    annualPlans: ANNUAL_PLANS,
  } satisfies ModelsResponse);
});
```

The client consumes the contract:

```typescript
// dashboard api.ts
import type { BalanceResponse, UsageParams } from '@epicenter/api/billing-contract';

export const api = {
  billing: {
    balance: () => get<BalanceResponse>('/api/billing/balance'),
    usage: (params: UsageParams) => post<UsageParams, UsageResponse>('/api/billing/usage', params),
  },
};
```

If the server's response shape drifts from the contract, `satisfies` catches it at compile time. If the client's fetch wrapper drifts, the type annotations catch it. Neither has to resolve the other's dependencies.

## When the third file wins

This pattern isn't always better. For a small API consumed by a single client in the same package, deriving types directly is simpler. No indirection, no extra file.

The third file earns its keep when:

- **Cross-environment boundaries.** Server runs on Cloudflare Workers; client runs in a browser SvelteKit app. The type environments are fundamentally different. Derived types drag one environment into the other.

- **Monorepo package boundaries.** Package A exports types that Package B imports. If A's types carry transitive dependencies that B can't resolve, the derived approach breaks. A shared contract with zero dependencies crosses any package boundary cleanly.

- **Multiple consumers.** A mobile app, a web dashboard, and a CLI all call the same API. Deriving from the server means all three need the server's type environment. A contract gives each consumer exactly the types it needs.

- **External API responses.** When the response shapes come from a third-party API (in our case, Autumn's billing API), neither our server nor our client defines the shape. It's imposed externally. The contract is a natural place to document those shapes once.

## The analogy

In psychology, the "third variable problem" warns against assuming direct causation between two correlated variables. The same intellectual move applies to type derivation. When you see two systems that need matching types, the instinct is to derive one from the other. But sometimes the clearest design is to extract the shared structure into an independent third artifact. A contract, a schema, a spec. That both systems implement against.

The server doesn't own the types. The client doesn't own the types. The contract owns the types. Both sides are consumers.

Ice cream sales and drowning deaths. Server types and client types. The relationship isn't A→B or B→A. It's C→A and C→B.
