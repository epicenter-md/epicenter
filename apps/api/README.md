# Epicenter API

The hub server. Handles authentication, real-time sync, and AI inference—everything that needs a single authority across devices.

Runs on Cloudflare Workers with Durable Objects. Each user gets dedicated Durable Objects for their workspaces and documents, providing per-user isolation with WebSocket-based real-time sync.

## Why a hub exists

Local-first doesn't mean no server. It means your data lives on your machine and you aren't dependent on a cloud service to function. But some operations genuinely need a single authority: user identity, API key storage, AI proxying. Trying to make every device a peer for these operations led to three failed attempts at distributed key management before we split into hub (central authority) and local (device-side execution).

The hub handles auth, sync relay, and AI. Local servers handle filesystem access, offline editing, and low-latency operations. Neither tries to do the other's job. See [Why Epicenter Split Into Hub and Local Servers](/docs/articles/why-epicenter-split-into-hub-and-local-servers.md) for the full story.

## Stack and priorities

Hono handles HTTP routing. We originally wanted Elysia—it's faster, the API is more ergonomic, and it runs natively on Bun. But Elysia depends on Bun-specific APIs that don't exist in the Cloudflare Workers runtime, and Workers compatibility was non-negotiable. Hono runs on Cloudflare Workers, Node.js, Deno, Bun, and AWS Lambda. When we build self-hosting adapters, the route layer comes along for free.

Cloudflare Durable Objects are the current deployment target. Three things make them a natural fit for per-user Yjs sync:

- **Single-threaded per object.** Each user's WorkspaceRoom or DocumentRoom runs in its own isolate. No mutex, no race conditions on CRDT state—the runtime guarantees it.
- **Built-in SQLite.** The update log lives inside the Durable Object's storage. No external database for sync state, no connection pooling, no cold-start latency from network hops.
- **WebSocket Hibernation.** Idle connections don't consume compute. A user can leave a tab open for hours and the DO sleeps until the next message arrives. Costs stay proportional to actual sync traffic, not connection count.

We're focused on Durable Objects to keep the maintenance surface small and iterate fast. The Cloudflare-specific code lives in three files: `workspace-room.ts`, `document-room.ts`, and `base-sync-room.ts`. Everything else—routes, auth, AI, validation—is runtime-portable Hono code.

We want self-hosting adapters. The plan is to stabilize the API surface on Durable Objects first, then extract the sync room logic into a runtime-agnostic layer backed by Node.js WebSockets + SQLite. If you want to deploy today, fork the repo and use the existing `wrangler.jsonc`—everything you need is in there.

Better Auth handles identity: email/password and Google OAuth for sign-in, plus an OAuth provider plugin that turns the hub into a standards-compliant OAuth server. Desktop and mobile clients authenticate via OAuth/PKCE flows, get a token, and use it for all subsequent API calls and WebSocket connections.

## Encryption and trust model

Workspace data is encrypted at the CRDT level using AES-256-GCM via @noble/ciphers (audited by Cure53). The encryption wraps YKeyValueLww—a synchronous layer that encrypts individual values within the data structure itself. Durable Objects see the CRDT skeleton (key names like `tab-1`, timestamps for conflict resolution) but every value is an opaque ciphertext blob: `{ v: 1, ct: Uint8Array }`. Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116), so there is no base64 overhead.

The encryption key derives from the deployment's auth secret (`BETTER_AUTH_SECRET`). This is server-managed, deployment-level encryption—the same model used by Notion, Linear, and most SaaS products, but applied deeper (individual CRDT values rather than database-level). The server can decrypt data to power search indexing, AI summarization, and password recovery.

| Deployment | Key source | Who can decrypt | Trade-off |
|---|---|---|---|
| Epicenter Cloud | Derived from deployment secret | Epicenter infrastructure | Enables search, AI, password reset, device migration |
| Self-hosted | Same derivation, your secret | Only you | Functionally zero-knowledge—the key never leaves your infra |

Self-hosting makes this zero-knowledge in practice. The encryption key sits on a machine you control; Epicenter never sees it. Same binary, same API surface—the deployment is the trust boundary.

### Why not zero-knowledge?

Zero-knowledge means the server can't read your data. The cost: password recovery doesn't work (the server can't re-derive your key), search doesn't work (the server can't index ciphertext), AI doesn't work (the server can't read your notes to summarize them), and device migration requires a key transfer ceremony.

PGP has been trying to make key management practical for thirty years. Signal works because messaging is one-dimensional—the server is a relay that never processes content. Most apps aren't relays. Epicenter needs to search documents, run AI against notes, and let users reset passwords without losing everything.

### Overhead

Encryption adds a fixed ~28 bytes per value (12-byte nonce + 16-byte GCM auth tag) with zero proportional expansion—`ct` is stored as a raw `Uint8Array` via Yjs binary serialization. For typical workspace data (100–2000 byte values), total overhead is 14–28%. Performance impact is negligible—AES-256-GCM via @noble/ciphers encrypts 1 KB in ~0.01 ms, and decrypting an entire workspace (500 entries) takes under 5 ms.

For the full argument:

- [Why E2E Encryption Keeps Failing](/docs/articles/why-e2e-encryption-keeps-failing.md)—PGP, Signal, and the structural problem
- [Let the Server Handle Encryption](/docs/articles/let-the-server-handle-encryption.md)—the pragmatic alternative
- [If You Don't Trust the Server, Become the Server](/docs/articles/if-you-dont-trust-the-server-become-the-server.md)—self-hosting as the clean answer
- [Encrypted Workspace Storage spec](/specs/20260213T005300-encrypted-workspace-storage.md)—implementation details

## Architecture

```
Cloudflare Workers
├── Hono app (src/app.ts)
│   ├── /auth/*          Better Auth (email/password, Google OAuth, OAuth provider)
│   ├── /ai/chat         AI streaming (OpenAI, Anthropic via @tanstack/ai)
│   ├── /workspaces/:id  Yjs sync (WebSocket upgrade or HTTP)
│   └── /documents/:id   Yjs sync with snapshots
│
├── WorkspaceRoom (Durable Object, SQLite-backed)
│   └── Per-user Yjs document for workspace data (settings, transcripts, notes)
│
└── DocumentRoom (Durable Object, SQLite-backed)
    └── Per-user Yjs document for long-form content, with snapshot history
```

API keys for AI providers are environment secrets (`wrangler secret put`). They never leave the hub—the client sends a session token, the hub validates it and swaps in the real key before forwarding to the provider.

## Development

### Local Postgres setup

The API needs a local PostgreSQL instance for development. The connection string is configured in `wrangler.jsonc` under the Hyperdrive `localConnectionString`.

```bash
brew install postgresql
brew services start postgresql

# Homebrew creates a role matching your macOS username. Create the postgres role and database:
psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"
psql -U postgres -c "CREATE DATABASE epicenter;"

# Push the schema
bun run db:push:local
```

### How database URLs work

There are three layers, each with a different URL source:

| Layer | Source | Used by |
|---|---|---|
| Local dev (runtime) | `wrangler.jsonc` Hyperdrive `localConnectionString` | `bun dev:local` (wrangler) |
| Local dev (drizzle-kit) | `DATABASE_URL` from `.dev.vars` (generated from Infisical dev env) | `db:push:local`, `db:studio:local` |
| Remote | `DATABASE_URL` injected by `infisical run` | `db:push:remote`, `db:studio:remote` |

`dev:local` regenerates `.dev.vars` from Infisical's dev environment on every run. Infisical dev has `DATABASE_URL` set to the local Postgres URL, so `.dev.vars` always points to local. The `:remote` scripts use `infisical run` which injects the production `DATABASE_URL` at runtime without touching `.dev.vars`.

### Running the server

```bash
bun dev:local        # Local dev server (uses local Postgres)
bun dev:remote       # Dev with remote secrets via Infisical
bun deploy           # Deploy to Cloudflare Workers
bun run typecheck    # Type check
bun test             # Run tests
```

### Database commands

```bash
bun run auth:generate    # Generate Better Auth schema
bun run db:generate      # Generate Drizzle migrations
bun run db:push:local    # Push schema to local Postgres
bun run db:push:remote   # Push schema to remote (via Infisical)
bun run db:studio:local  # Open Drizzle Studio (local)
bun run db:studio:remote # Open Drizzle Studio (remote, via Infisical)
```

See `wrangler.jsonc` for Durable Object bindings, KV namespaces, and Hyperdrive (Postgres connection pool) configuration.
