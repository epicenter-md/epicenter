---
name: hono
description: Hono patterns for TypeScript API routes, middleware, request and response typing, streaming, WebSockets, and Cloudflare Workers deployment. Use when users mention Hono, honojs, Cloudflare Worker handlers, Hono middleware, or Hono route typing.
metadata:
  author: epicenter
  version: '1.0'
---

# Hono

## Upstream Grounding

Grounding repos: `honojs/hono` for route typing, middleware, streaming, and WebSockets; `cloudflare/cloudflare-docs` for Worker runtime behavior.

## Middleware And Context

- Middleware is onion-style and order-sensitive. Resource setup belongs before auth; auth belongs before protected routes.
- Use `createFactory<Env>()` and `Env['Variables']` to type `c.var` and `c.set()`.
- Middleware that continues must `await next()`. Middleware that rejects or redirects should return the response and skip `next()`.
- Handlers should return Hono response helpers such as `c.json()`, `c.text()`, `c.html()`, or a `Response`.
- On Cloudflare Workers, read bindings from `c.env` and request lifecycle APIs from `c.executionCtx`.
- Register CORS before auth routes when cookie auth or credentialed cross-origin frontend calls are involved.
- Test route behavior with `app.request()` or `testClient` plus mocked bindings and execution context before reaching for a network server.
- Keep WebSocket upgrade detection explicit whenever generic middleware might mutate response headers.
