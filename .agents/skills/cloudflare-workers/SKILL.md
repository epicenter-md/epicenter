---
name: cloudflare-workers
description: Cloudflare Workers patterns for Worker runtime APIs, Durable Objects, KV, R2, D1, Queues, WebSockets, streaming responses, bindings, wrangler configuration, and deployment limits. Use when users mention Cloudflare Workers, Durable Objects, KV, R2, D1, Queues, wrangler, or edge runtime behavior.
metadata:
  author: epicenter
  version: '1.0'
---

# Cloudflare Workers

## Upstream Grounding

Grounding repos: `cloudflare/cloudflare-docs` for Workers, Durable Objects, KV, R2, D1, Queues, WebSockets, bindings, wrangler, and limits; `honojs/hono` for Hono on Workers.

## When to Apply This Skill

Use this pattern when you need to:

- Work on `apps/api` Worker code, bindings, or `wrangler` configuration.

## Request Lifecycle Rules

- Every async side effect must be awaited, returned, or passed to `c.executionCtx.waitUntil(...)`. Floating promises are unsafe because the isolate can stop after the response.
- Call `waitUntil` as a method on `c.executionCtx`. Do not destructure it.
- Keep `waitUntil` work bounded and best-effort. Use Queues for guaranteed or long-running work.
- For Hyperdrive plus `pg`, create a fresh `pg.Client` per request and close it after all queued work that uses the client settles. Hyperdrive is the pool.
- Node-style database drivers require `nodejs_compat` in Worker configuration.
- Skip generic response-header middleware, including CORS, for WebSocket upgrade requests. The `101` response headers are immutable.
- Put stateful or long-lived WebSockets in Durable Objects. Prefer hibernation-aware APIs when the object owns many idle sockets.
- Trust generated Worker binding types such as `Cloudflare.Env`; regenerate them when bindings or `wrangler` config change.
