# Neon → PlanetScale Postgres via Cloudflare Hyperdrive

**Status**: Done
**Date**: 2026-03-05
**Package**: `packages/server-cloudflare`

## Summary

Skip the planned Neon Phase 1 / PlanetScale Phase 2 migration path. Go straight to PlanetScale Postgres from day 1, using Cloudflare Hyperdrive to proxy TCP connections from Workers.

## Why

The Neon HTTP driver (`@neondatabase/serverless`) can't connect to a local Postgres instance. It only speaks Neon's proprietary HTTP API. This breaks local dev: `wrangler dev` can't route auth queries to `localhost:5432`.

Hyperdrive solves this cleanly:
- **Production**: proxies TCP connections from Workers to PlanetScale Postgres with connection pooling
- **Local dev**: `localConnectionString` in `wrangler.toml` routes `wrangler dev` directly to local Postgres
- **Same driver everywhere**: `postgres` (postgres.js) + `drizzle-orm/postgres-js`: zero conditional logic, no driver swapping

## Driver

- **Package**: `postgres` (postgres.js) v3.4+
- **Drizzle adapter**: `drizzle-orm/postgres-js`
- **Behavior**: Lazy connection: no I/O at import time. `postgres(connectionString)` returns a SQL tagged template function. Connections are established on first query. This preserves the module-level singleton pattern.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Worker Runtime                                      │
│                                                      │
│  import postgres from 'postgres'                     │
│  const sql = postgres(env.HYPERDRIVE.connectionString)│
│  const db = drizzle(sql, { schema })                 │
│                                                      │
│  env.HYPERDRIVE is a Cloudflare Hyperdrive binding   │
│  that provides a connectionString property           │
└──────────────┬──────────────────────────────────────┘
               │
     ┌─────────▼──────────┐
     │   Cloudflare        │
     │   Hyperdrive        │
     │   (TCP proxy +      │
     │    conn pooling)    │
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │   PlanetScale       │
     │   Postgres          │
     └────────────────────┘

Local dev (wrangler dev):
  localConnectionString → postgres://braden@localhost:5432/epicenter
  (bypasses Hyperdrive, connects directly)
```

**CLI tools** (`auth:generate`, `db:push`, `db:studio`) use `DATABASE_URL` from `.dev.vars` directly: they don't run inside the Worker runtime and don't use Hyperdrive.

## Code Changes

| File | Change |
|---|---|
| `package.json` | Remove `@neondatabase/serverless`, add `postgres` |
| `src/auth.ts` | Swap neon→postgres driver, use `env.HYPERDRIVE.connectionString` |
| `better-auth.config.ts` | Swap neon→postgres driver (CLI uses `DATABASE_URL` from env) |
| `wrangler.toml` | Add `[[hyperdrive]]` binding, remove `DATABASE_URL` from secrets comment |

### Files unchanged

- `drizzle.config.ts`: drizzle-kit has its own internal driver, reads `DATABASE_URL` from env
- `src/env.ts` / `src/hono.ts`: CLI env validation unchanged; Worker types updated by `wrangler types`
- `.dev.vars`: still provides `DATABASE_URL` for CLI tools
- `src/db/schema.ts`: pure schema definitions, no driver references

## Manual Setup (User Runs)

```bash
# 1. Create PlanetScale Postgres database (via dashboard at planetscale.com)

# 2. Create Hyperdrive config pointing to PlanetScale
wrangler hyperdrive create epicenter-db \
  --connection-string="postgres://USER:PASS@HOST:PORT/epicenter?sslmode=require"
# → Returns an ID. Paste into wrangler.toml replacing <created-via-wrangler-cli>

# 3. Remove old DATABASE_URL secret from Workers (if set)
wrangler secret delete DATABASE_URL

# 4. Regenerate Worker types (picks up HYPERDRIVE binding)
cd packages/server-cloudflare && bun run typegen

# 5. Install dependencies
bun install

# 6. Push schema to PlanetScale (for production)
DATABASE_URL="postgres://<planetscale-string>" bun run db:push
```

## Verification

1. `grep -r "neondatabase\|neon-http" packages/server-cloudflare/src/` → no results
2. `bun run typecheck` in `packages/server-cloudflare` → passes
3. `bun run dev` → wrangler uses `localConnectionString`, auth endpoints work against local Postgres
4. `bun run db:studio` → drizzle-kit connects to local Postgres via `.dev.vars`
5. Test auth: `POST /auth/sign-up/email` and `POST /auth/sign-in/email` succeed
