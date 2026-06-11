# Server Remote Adapter Architecture

**Date**: 2026-03-05
**Status**: Superseded by `20260307T000000-remove-server-remote-standalone.md`
**Related**: `20260305T120000-server-package-consolidation.md`, `20260227T120000-server-package-split.md`

## Problem

`server-remote` runs in two modes: deploy to Cloudflare Workers, or run as a standalone Node.js/Bun server. Both share the same Hono routes (auth, AI chat, provider proxy, health) but differ in sync transport, auth backing store, and runtime bindings.

The question: what's the right folder/package structure for hosting these two adapters? The answer matters for self-hosters: someone who clones this repo and wants to deploy their own remote hub needs to quickly find the right entry point, configure it, and run it.

## Current State

Single package, adapters as subdirectories:

```
packages/server-remote/
├── package.json              # all deps (Cloudflare + standalone)
├── src/
│   ├── app.ts                # createSharedApp(): shared Hono routes
│   ├── types.ts              # SharedEnv, AuthInstance, etc.
│   ├── auth/                 # shared auth (middleware, base config)
│   ├── proxy/                # shared AI chat + provider proxy
│   ├── sync/                 # re-exports from sync-core
│   ├── adapters/
│   │   ├── cloudflare/       # wrangler.toml, worker.ts, DO, KV sessions
│   │   └── standalone/       # createRemoteHub(), Bun.serve(), in-memory sync
│   └── index.ts              # exports shared + standalone factory
```

Scripts use `--config` to point wrangler at the nested adapter:

```json
"dev:cloudflare": "wrangler dev --config src/adapters/cloudflare/wrangler.toml"
```

## Options Considered

### Option A: Keep current structure (single package, nested adapters)

```
packages/server-remote/
├── src/
│   ├── core/                 # shared routes, auth, proxy
│   └── adapters/
│       ├── cloudflare/       # wrangler.toml, worker entry
│       └── standalone/       # Bun/Node entry
```

**Pros:**
- Everything server-remote is in one place. One `cd`, one mental model.
- Shared code is just relative imports: no cross-package dependency resolution.
- Already implemented and working.

**Cons:**
- `wrangler.toml` lives at `src/adapters/cloudflare/wrangler.toml`. Every wrangler command needs `--config`. `wrangler secret put`, `wrangler tail`, `wrangler types`: all need the flag. Self-hosters will stumble on this.
- Mixed `package.json`: `postgres` (standalone), `@cloudflare/workers-types` (CF), `wrangler` (CF) are all in one dependency list. Both adapters' deps are installed regardless of which one you use.
- Self-hoster entry point is buried: `packages/server-remote/src/adapters/standalone/start.ts`. Not obvious.

### Option B: Separate packages per adapter

```
packages/server-remote/                  # shared core library
packages/server-remote/       # CF Worker: wrangler.toml at root
packages/server-remote-standalone/       # Node/Bun server: entry point at root
```

**Pros:**
- Each deployable is its own package with config at the root. A self-hoster sees `server-remote-standalone/`, opens it, sees `package.json` with `bun run start`, `.env.example`, and a clear entry point.
- `wrangler.toml` at package root: every wrangler command works without `--config`.
- Dependencies are separated. CF adapter has `wrangler` and Workers types. Standalone has `postgres`. Neither pollutes the other.
- CI/CD is clean: deploy the CF worker from `server-remote/`, deploy standalone from `server-remote-standalone/`.

**Cons:**
- Three packages instead of one. More `package.json` files, more workspace entries.
- Shared code changes require version coordination (but workspace deps handle this automatically in monorepos).
- Scatters related code across three directories.

### Option C: Core in packages, deployables in apps

```
packages/server-remote/         # shared core library
apps/server-cloudflare/         # deployable CF Worker
apps/server-standalone/         # deployable Node/Bun server
```

**Pros:**
- Strong signal: `apps/` = "things you deploy", `packages/` = "things you import".
- Convention matches Turborepo/Nx monorepo patterns.

**Cons:**
- In this monorepo, `apps/` contains Tauri apps and browser extensions: things with their own build toolchains and UI. The server adapters are thin Hono compositions, not full apps. They'd feel out of place next to the Tauri app.
- Scatters server code across two top-level directories.

### Option D: Nested deployables with their own package.json

```
packages/server-remote/
├── package.json              # the shared library
├── src/                      # shared core
├── deploy/
│   ├── cloudflare/
│   │   ├── package.json      # separate deps
│   │   ├── wrangler.toml     # at this package's root
│   │   └── worker.ts
│   └── standalone/
│       ├── package.json
│       └── server.ts
```

**Pros:**
- All server-remote code in one directory. Self-hoster sees `deploy/` and picks their target.
- Each deployable has its own clean `package.json`.

**Cons:**
- Nested packages confuse bun's workspace resolution unless explicitly added to root `workspaces`. Unconventional.
- Tooling (bun, turbo) may not auto-discover `deploy/cloudflare/` as a workspace.

## Decision

**Option B: Separate packages.**

The primary user is a self-hoster who wants to deploy a remote hub. Their experience should be:

1. Go to `packages/server-remote-standalone/` (or `server-remote/`)
2. See `package.json` with clear scripts (`dev`, `start`, `deploy`)
3. Copy `.env.example` → `.env`, fill in credentials
4. `bun run start` (standalone) or `bun run deploy` (Cloudflare)

This is the path of least confusion. Every alternative requires the self-hoster to understand the internal adapter structure before they can deploy.

The shared core (`server-remote`) stays as a library. The adapters are consumers. This matches how the code already works: `createSharedApp()` is a library function that adapters call.

## Target Structure

```
packages/
├── server-remote/                       # @epicenter/server-remote
│   ├── package.json                     # shared deps only (hono, better-auth, sync-core)
│   └── src/
│       ├── index.ts                     # createSharedApp, types, auth, proxy exports
│       ├── app.ts                       # createSharedApp()
│       ├── types.ts                     # SharedEnv, AuthInstance, SharedAppConfig
│       ├── auth/
│       │   ├── better-auth-base.ts      # shared Better Auth config (plugins, PKCE)
│       │   ├── middleware.ts            # shared auth middleware
│       │   └── index.ts
│       ├── proxy/
│       │   ├── chat.ts                  # POST /ai/chat
│       │   ├── passthrough.ts           # ALL /proxy/:provider/*
│       │   └── index.ts
│       └── sync/
│           └── index.ts                 # re-exports from sync-core
│
├── server-remote/                       # @epicenter/server-remote
│   ├── package.json                     # wrangler, @cloudflare/workers-types
│   ├── wrangler.toml                    # at package root
│   ├── .dev.vars                        # local dev secrets
│   ├── drizzle.config.ts
│   ├── better-auth.config.ts
│   └── src/
│       ├── worker.ts                    # CF Worker entry (exports default app + YjsRoom)
│       ├── app.ts                       # CF app assembly (DO stub routing)
│       ├── auth.ts                      # CF Better Auth (Hyperdrive PG, KV sessions)
│       ├── yjs-room.ts                  # Durable Object
│       ├── storage.ts                   # DOSqliteSyncStorage
│       ├── env.ts                       # CLI env loader (drizzle-kit, better-auth CLI)
│       └── db/
│           └── schema.ts               # Drizzle PG schema
│
├── server-remote-standalone/            # @epicenter/server-remote-standalone
│   ├── package.json                     # bun, postgres (optional)
│   ├── .env.example                     # documented env vars
│   └── src/
│       ├── server.ts                    # createRemoteHub() factory
│       ├── start.ts                     # bun entry point
│       ├── app.ts                       # standalone app assembly
│       ├── auth.ts                      # auth modes (none/token/betterAuth)
│       ├── sync-adapter.ts             # Bun WebSocket + sync-core room manager
│       └── storage.ts                  # ephemeral sync storage
```

### Package Dependencies

```
server-remote
├── @epicenter/server-remote (workspace:*)
├── @epicenter/sync (workspace:*)
├── wrangler
├── drizzle-orm, drizzle-kit
└── postgres

server-remote-standalone
├── @epicenter/server-remote (workspace:*)
├── @epicenter/sync (workspace:*)
├── better-auth (for betterAuth mode)
└── postgres (optional, for betterAuth mode)

server-remote (shared core)
├── @epicenter/sync (workspace:*)
├── hono
├── better-auth (base config + types)
└── arktype
```

### Package Scripts

**server-remote:**
```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "typegen": "wrangler types",
    "auth:generate": "bun x @better-auth/cli generate --yes --config ./better-auth.config.ts --output ./src/db/schema.ts",
    "db:push": "drizzle-kit push --config drizzle.config.ts",
    "db:studio": "drizzle-kit studio --config drizzle.config.ts"
  }
}
```

**server-remote-standalone:**
```json
{
  "scripts": {
    "dev": "bun --watch src/start.ts",
    "start": "bun src/start.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

Note how clean the scripts are. No `--config` paths. No `cd` into subdirectories. `wrangler dev` just works because `wrangler.toml` is at the package root.

## Migration Steps

### Phase 1: Create server-remote

1. Create `packages/server-remote/` with `package.json`
2. Move `src/adapters/cloudflare/*` → `packages/server-remote/src/`
3. Move `wrangler.toml` to package root, update `main` path
4. Move `drizzle.config.ts`, `better-auth.config.ts`, `.dev.vars` to package root
5. Update all imports from `../../app` → `@epicenter/server-remote`
6. Update `package.json` scripts (no more `--config` paths)
7. Add to monorepo workspace config
8. Verify `wrangler dev` works from package root

### Phase 2: Create server-remote-standalone

1. Create `packages/server-remote-standalone/` with `package.json`
2. Move `src/adapters/standalone/*` → `packages/server-remote-standalone/src/`
3. Update imports from `../../app` → `@epicenter/server-remote`
4. Create `.env.example` with documented variables
5. Add to monorepo workspace config
6. Verify `bun run start` works

### Phase 3: Clean up server-remote

1. Remove `src/adapters/` directory entirely
2. Remove adapter-specific deps from `package.json` (wrangler, @cloudflare/workers-types)
3. Remove adapter-specific scripts (dev:cloudflare, deploy:cloudflare, typegen)
4. Update `index.ts`: remove standalone adapter re-exports
5. Update any consumers that imported `createRemoteHub` from `@epicenter/server-remote` → `@epicenter/server-remote-standalone`

### Phase 4: Update CLI

1. Update `packages/cli/` imports if it references the standalone factory
2. Grep for any remaining references to the old adapter paths

## Self-Hosting Documentation Plan

After the split, each adapter package should have a clear README:

**server-remote-standalone README:**
```
# Self-Hosted Epicenter Hub

## Quick Start
1. Clone this repo
2. cd packages/server-remote-standalone
3. cp .env.example .env
4. Edit .env with your settings
5. bun install && bun run start

## Auth Modes
- `none`: No auth (development)
- `token`: Pre-shared secret (simple deployments)
- `betterAuth`: Full auth with database (production)
```

**server-remote README:**
```
# Epicenter Hub on Cloudflare Workers

## Deploy
1. cd packages/server-remote
2. cp .dev.vars.example .dev.vars
3. wrangler deploy
4. wrangler secret put BETTER_AUTH_SECRET
```

## Open Questions

1. **Should server-remote-standalone support Node.js (not just Bun)?** Currently uses `hono/bun` for WebSocket support. `@hono/node-ws` exists but is a separate adapter. Decision: start Bun-only, add Node support if requested.

2. **Should the standalone adapter package export its factory function?** Currently `index.ts` re-exports `createRemoteHub` from the standalone adapter. After the split, consumers would import from `@epicenter/server-remote-standalone`. If it's only used as a runnable entry point (not imported programmatically), it doesn't need to export anything: just have `start.ts`.

3. **Naming: `server-remote` vs `server-cloudflare`?** The `server-remote-` prefix is verbose but makes the relationship clear. `server-cloudflare` is shorter but doesn't signal it's the remote hub (vs a hypothetical Cloudflare worker for something else). Decision: use `server-remote` for clarity.
