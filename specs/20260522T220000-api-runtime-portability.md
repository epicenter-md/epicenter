# API Runtime Portability: Self-Hostable Epicenter Server

**Date**: 2026-05-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: chore/modernize-monorepo-tsconfig

> This spec is the audit and written plan only. It does NOT perform the
> refactor. It is the execution detail for tasks P1 and P2 of
> `specs/20260522T200000-cloud-workspace-ownership-model.md` ("Make `apps/api`
> a clean deployable artifact" and "Define the `ENV` schema"), extended with
> the part that spec deferred: the same code must run on Node/Bun, not only as
> a Cloudflare Worker.

## Overview

`apps/api` is a Hono app deployed only as a Cloudflare Worker. This spec audits
every Cloudflare-specific API it uses and plans a runtime-agnostic design where
the Room logic (Yjs sync, the update log, presence, dispatch) is written once
against named contracts, with two backends behind those contracts: the existing
Cloudflare Durable Object and a new Bun/Node implementation. The result lets an
organization self-host a private deployment as one Bun process with one Postgres
and one data directory, while the Cloudflare path keeps working unchanged.

## One-sentence thesis

> The Room, asset storage, and session cache are the only Cloudflare-shaped
> parts of `apps/api`; put each behind one small Epicenter-owned contract with
> two backends, and the same source runs as a Worker or as a Bun process.

## Motivation

### Current State

An organization in Epicenter is a private deployment of this server, not an
in-app entity (`specs/20260522T200000-cloud-workspace-ownership-model.md`).
Today a deployment can only be a Cloudflare Worker. The server hard-codes the
Cloudflare runtime in four places that have no Bun/Node equivalent:

```ts
// apps/api/src/room.ts:37
import { DurableObject } from 'cloudflare:workers';

// apps/api/src/room.ts:167 : the actor model
export class Room extends DurableObject { /* ... */ }

// apps/api/src/room.ts:339 : the WebSocket Hibernation API
this.ctx.acceptWebSocket(server);

// apps/api/src/app.ts:526 : DO naming + routing
const roomStub = c.env.ROOM.get(c.env.ROOM.idFromName(roomName));
```

```ts
// apps/api/src/auth/encryption.ts:1 : module-scope Worker env, unresolvable on Node
import { env } from 'cloudflare:workers';
```

This creates problems:

1. **A private deployment cannot exist without Cloudflare.** The ownership
   model says an organization runs the same stack on its own infrastructure.
   `cloudflare:workers` does not resolve under Bun or Node, so the stack
   physically cannot start there.
2. **The Room cannot be tested or run without Workers globals.** `room.test.ts`
   already carries a hand-written mock of `cloudflare:workers`, `WebSocketPair`,
   and `WebSocket` (`room.test.ts:39-99`) just to exercise the Room logic. The
   logic and the runtime are entangled in one file.
3. **Self-hosting is blocked on a packaging effort that has no design.** The
   ownership-model spec defers P1 to P5 with a one-line "packaging effort"; it
   never names the abstraction boundary or picks a portable storage engine.

### Desired State

One codebase, two backends behind named contracts, selected by which entry file
boots:

```
src/app.ts        Hono app + routes. Runtime-agnostic. One copy.
src/room/core.ts  RoomCore: Yjs sync, update log, presence, dispatch. One copy.

src/worker.ts     Cloudflare entry. Wires the Durable Object backends. (today's default export)
src/server.ts     Bun entry. Wires the in-process backends. (new)

A deployment differs only by which entry file runs and by its ENV file.
```

## Cloudflare API Inventory

Every Cloudflare-specific API in `apps/api`, with file and line. Grep basis:
`cloudflare:`, `DurableObject`, `WebSocketPair`, `ctx.storage`, `acceptWebSocket`,
`Hyperdrive`, `KVNamespace`, `R2Bucket`, `executionCtx`, `setAlarm`.

### Durable Objects + embedded SQLite + Hibernation (`src/room.ts`)

| Line | API | Cloudflare-specific concern |
| --- | --- | --- |
| 37 | `import { DurableObject } from 'cloudflare:workers'` | Module unresolvable off-Workers |
| 167 | `class Room extends DurableObject` | DO actor base class |
| 227 | `constructor(ctx: DurableObjectState, env: Env)` | DO state handle |
| 230 | `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))` | Hibernation auto-response |
| 234 | `ctx.blockConcurrencyWhile(...)` | DO init-before-serve guarantee |
| 239, 246, 256 | `ctx.storage.sql.exec(...)` | DO embedded SQLite (the Yjs update log) |
| 286 | `ctx.getWebSockets()` | Hibernation socket re-enumeration |
| 287, 341 | `ws.deserializeAttachment()` / `ws.serializeAttachment()` | Hibernation attachment persistence |
| 301-306, 550, 765, 823, 837 | `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm` overrides | DO + Hibernation lifecycle callbacks |
| 334, 814, 832 | `ctx.storage.deleteAlarm()` / `setAlarm()` | DO alarm (deferred compaction) |
| 336 | `new WebSocketPair()` | Workers global |
| 339 | `ctx.acceptWebSocket(server)` | Hibernation API registration |
| 372 | `new Response(null, { status: 101, webSocket: client })` | Workers-only `Response.webSocket` |
| 416, 430 | `ctx.storage.sql.databaseSize` | DO SQLite size accessor |
| 887-889 | `ctx.storage.transactionSync(...)` + `ctx.storage.sql.exec` | DO sync transaction (compaction) |

### Worker entry, bindings, DO routing (`src/app.ts`)

| Line | API | Concern |
| --- | --- | --- |
| 104 | `Bindings: Cloudflare.Env` | Env type from `wrangler types` |
| 140 | `c.env.HYPERDRIVE.connectionString` | Hyperdrive binding (Postgres pool) |
| 137-163 | per-request `pg.Client` connect/end | Workers isolate-per-request idiom |
| 159 | `c.executionCtx.waitUntil(...)` | Workers post-response lifetime |
| 224 | `c.json({ runtime: 'cloudflare' })` | Hard-coded runtime label |
| 414-418 | `c.env.ASSETS` Fetcher | Workers Static Assets binding (dashboard SPA) |
| 526, 565 | `c.env.ROOM.get(c.env.ROOM.idFromName(roomName))` | DO namespace binding + name routing |
| 536 | `roomStub.fetch(c.req.raw)` | DO stub fetch (WS upgrade) |
| 539, 566 | `roomStub.getDoc()` / `roomStub.sync(body)` | DO RPC |
| 47 | `export { Room } from './room'` | DO class export for `wrangler types` |
| 588 | `export default app` | Implicit Worker `fetch` entry |

### Module-scope Worker env (`src/auth/encryption.ts`)

| Line | API | Concern |
| --- | --- | --- |
| 1 | `import { env } from 'cloudflare:workers'` | Unresolvable off-Workers |
| 11 | `parseRootKeyring(env.ENCRYPTION_SECRETS)` at module load | Reads Worker env before any request |

### R2 object storage (`src/asset-routes.ts`, `src/auth/create-auth.ts`)

| Line | API | Concern |
| --- | --- | --- |
| `asset-routes.ts:137` | `c.env.ASSETS_BUCKET.put(key, stream, { httpMetadata })` | R2 put |
| `asset-routes.ts:155, 245` | `c.env.ASSETS_BUCKET.delete(key)` | R2 delete |
| `asset-routes.ts:323` | `c.env.ASSETS_BUCKET.get(key, { onlyIf, range })` | R2 conditional + range get |
| `asset-routes.ts:333-372` | `object.writeHttpMetadata`, `.httpEtag`, `.range`, `.uploaded`, `.size`, `.body` | R2 object API |
| `create-auth.ts:120` | `env.ASSETS_BUCKET.delete(keys)` | R2 bulk delete on user delete |

### KV session cache (`src/auth/create-auth.ts`)

| Line | API | Concern |
| --- | --- | --- |
| 38 | `env: Cloudflare.Env` | Env type |
| 156-163 | `env.SESSION_KV.get/put/delete` as Better Auth `secondaryStorage` | KV namespace binding |

### WebSocketPair in the auth failure path (`src/auth/oauth-resource.ts`)

| Line | API | Concern |
| --- | --- | --- |
| 5, 18, 27 | `WebSocketPair` global, `server.accept()`, `Response({ webSocket })` | Workers WS globals (used to close a WS upgrade with `4401` on auth failure) |

### Build/config coupling

| File | Concern |
| --- | --- |
| `wrangler.jsonc` | Entire file: `durable_objects`, `migrations.new_sqlite_classes`, `kv_namespaces`, `hyperdrive`, `r2_buckets`, `assets`, `routes.custom_domain`, `placement`, `vars`, `secrets`, `compatibility_flags: ["nodejs_compat"]` |
| `worker-configuration.d.ts` | Generated by `wrangler types`. Declares `global Cloudflare.Env` with `SESSION_KV: KVNamespace`, `ASSETS_BUCKET: R2Bucket`, `HYPERDRIVE: Hyperdrive`, `ASSETS: Fetcher`, `ROOM: DurableObjectNamespace<Room>` |
| `package.json` | `dev` -> `wrangler dev`; `deploy` -> `wrangler deploy`; `typegen` -> `wrangler types` |
| `env.ts` | Reads `wrangler.jsonc` to recover the local DB URL for Drizzle Kit tooling |

### D1, Queues: none

Confirmed by grep: no `D1Database`, no `Queue`, no `cloudflare:sockets` direct
use. The Room's update log is **DO embedded SQLite** (`ctx.storage.sql`), not
D1. Postgres reaches the Worker through Hyperdrive, not D1. The only stateful
Cloudflare primitives are: Durable Objects, DO embedded SQLite, KV, R2,
Hyperdrive, Workers Static Assets.

### Already portable (confirmed, not redesigned)

| Concern | Why it is already portable |
| --- | --- |
| Hono | Multi-runtime by design. `app.ts` builds a Hono app whose `.fetch` handler is usable by `Bun.serve` and `@hono/node-server`. |
| Drizzle over Postgres | `drizzle-orm/node-postgres` + `pg`. `pg` runs natively on Bun/Node; on Workers it runs over `nodejs_compat`. Schema in `src/db/schema/` is dialect-portable Postgres. |
| Better Auth | `betterAuth()` is runtime-agnostic. The only Cloudflare touch is the `secondaryStorage` KV binding, which is an optional cache (see Phase 3). |
| `@epicenter/sync` | `handleSyncPayload`, `encodeSyncStep1`, `encodeSyncUpdate` are pure Yjs/lib0. No runtime coupling. |
| `@epicenter/encryption` | Pure HKDF over Web Crypto. The coupling is `auth/encryption.ts` reading `env` at module scope, not the library. |
| AI chat, Autumn SDK, billing routes | Pure `fetch` to third-party APIs. They read string secrets off `c.env`; no Cloudflare primitive. |

## Research Findings

### How comparable products ship one codebase to public + private instances

| Product | Public instance | Private instance | Shared mechanism |
| --- | --- | --- | --- |
| GitLab | gitlab.com | self-hosted GitLab | One codebase, runtime selected by deploy |
| Discourse | hosted Discourse | self-hosted Discourse | One Rails app, ENV-configured, a data dir |
| Sentry | sentry.io | self-hosted Sentry | One codebase, Docker compose for self-host |
| Plausible | plausible.io | self-hosted Plausible | One Elixir release, ENV-configured |

**Key finding**: none of them fork. The public and private instances run the
exact same artifact; only ENV and the surrounding infrastructure differ. A
persistent data directory is a normal, expected self-host requirement.

**Implication**: the Bun/Node path must be a second backend in one codebase,
never a fork. The split is by entry file and injected contracts, not by branch.

### Durable Object `idFromName` (DeepWiki, cloudflare/cloudflare-docs, 2026-05-22)

Cloudflare does not document the derivation algorithm, but confirms: `idFromName`
treats the name as an **opaque, deterministic string**; the same name always
maps to the same object; **names over 1,024 bytes are rejected** (produce an
`undefined` id). The Cloudflare backend already converts `name -> fixed opaque
id` and never inspects the name's internal structure.

**Implication**: the portable room store should derive a fixed-width opaque id
from the room name the same way, by hashing. This is parity with the backend
being matched, not an arbitrary choice. See Design Decisions (room file naming).

### Bun `Bun.serve` WebSocket + `bun:sqlite` + `BunFile` (DeepWiki, oven-sh/bun, 2026-05-22)

| Bun API | Surface confirmed | Maps to |
| --- | --- | --- |
| `Bun.serve` WebSocket | `server.upgrade(req, { data })` attaches per-connection `data`, readable as `ws.data` | DO `serializeAttachment` / `deserializeAttachment` |
| `ServerWebSocket` | `send`, `close(code, reason)`, `readyState` (0..3), plus native `subscribe`/`publish` pub-sub | DO hibernation `WebSocket` (`send`, `close`, `readyState`) |
| `bun:sqlite` | Fully **synchronous**: `new Database(path, opts)`, `db.run(sql, params)`, `db.query(sql)` cached prepared statements, WAL via `PRAGMA journal_mode = WAL` | DO `ctx.storage.sql.exec` (also synchronous) |
| `BunFile` | `Bun.file(path).slice(start, end)` offsets a byte range with no copy; `new Response(file.slice(...))` serves HTTP ranges | R2 `object.range` / range GET |

**Key finding 1**: `bun:sqlite` is synchronous, like `ctx.storage.sql`. The
update log writes inside the Yjs `updateV2` callback (`room.ts:256`), which
cannot `await`. A synchronous engine ports that callback verbatim, so `RoomCore`
needs no async-write redesign.

**Key finding 2**: a Bun `ServerWebSocket` already exposes `send`, `close`,
`readyState`, and a per-connection `data` slot. If the `RoomSocket` contract is
shaped around those, Bun's native socket satisfies it structurally with no
wrapper. Only the Durable Object side needs a real adapter, because hibernation
attachment persistence is genuine work at that seam.

**Key finding 3**: `Bun.serve` ships native topic pub-sub (`subscribe`/
`publish`). `RoomCore` does **not** use it: presence and sync fan-out compute a
per-recipient install list and exclude the origin socket, which topic broadcast
cannot express. Manual fan-out stays in `RoomCore`, identical on both backends.

**macOS caveat**: `bun:sqlite` WAL files can persist after close on macOS. The
portable store runs `PRAGMA wal_checkpoint(TRUNCATE)` (and disables persistent
WAL) before closing a room's database on idle eviction.

### Synchronous SQLite engines

| Candidate | Sync API | Bun | Node | Notes |
| --- | --- | --- | --- | --- |
| `bun:sqlite` | Yes | Yes (built in) | No | Zero dependency on Bun. API inspired by `better-sqlite3`. |
| `better-sqlite3` | Yes | Yes | Yes | Native addon. The only sync engine that also covers Node. |
| libSQL / `@libsql/client` | No | Yes | Yes | Async-only API; embedded-replica mode syncs to a remote Turso. |

**Key finding**: libSQL is rejected. Its API is async-only, which would force
the update-log write async and ripple into the synchronous `updateV2` listener;
and its embedded-replica feature syncs to a remote, a cross-deployment
dependency the self-containment invariant forbids. Between the two synchronous
engines, the `RoomUpdateLog` contract makes the choice a one-line swap, so the
self-host runtime decides it (see Design Decisions).

### Asset references outside `apps/api` (grep, 2026-05-22)

`grep -rn "api/assets\|assetId"` across `apps/` and `packages/` returns **zero
matches outside `apps/api`**. No client builds, persists, or consumes an asset
URL today. The asset URL shape is greenfield and can change with no migration.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Abstraction shape | 2 coherence | One `RoomCore` against three Epicenter-owned contracts (`RoomUpdateLog`, `RoomSocket`, `RoomRegistry`); a factory per backend, conformance proven with `satisfies` | One logic implementation, two backends; matches "two backends, not a fork" |
| Where to draw the seam | 2 coherence | At the smallest Epicenter-owned contract, never by reimplementing Cloudflare's `DurableObjectNamespace`/stub API | Duck-typing a foreign API is a flagged smell and a large undocumented surface; the contract is ours and tiny |
| Factories per port | 3 taste | Only where the seam does real work (see Architecture table); let Bun's native `ServerWebSocket` satisfy `RoomSocket` directly | Collapsed-adapter rule: a wrapper that only renames fields is ceremony |
| Portable update-log engine | 1 evidence | `bun:sqlite` primary, `better-sqlite3` behind the same contract for a Node deployment | Both synchronous, verified against `room.ts:256` `updateV2` listener; Bun is the recommended self-host runtime so its built-in engine is the default |
| libSQL / Turso | 1 evidence | Rejected | Async-only API forces a `RoomCore` redesign; embedded-replica sync breaks self-containment |
| Room file naming | 2 coherence | `rooms/<sha256(roomName)>.sqlite`, flat | Parity with `idFromName` (opaque-string treatment, verified); grammar-independent; the readable index already lives in the `durableObjectInstance` Postgres table; a one-row `meta` table inside each file keeps it self-identifying |
| Room file sharding | 3 taste | None (flat directory) | An org deployment has thousands of rooms, not millions; sharding is premature |
| Asset key + URL | 2 coherence | `assets/<assetId>`, flat; URL `/api/assets/<assetId>`; `userId` removed from the key/URL, kept in the `asset` table row | Read is unauthenticated, the unguessable id IS the capability; identity in a shareable URL leaks a stable identifier and is not an authz mechanism. Applies to the R2 backend too |
| Content-addressed assets (`sha256(bytes)`) | 1 evidence | Rejected | A content-hash address is computable by anyone holding the file, which destroys the unguessable-URL-as-credential model |
| Storage engine for the portable Yjs log | 2 coherence | SQLite file per room, not Postgres | A SQLite file per room is the literal analog of one DO's embedded SQLite; keeps synchronous per-update durability and ports `compactUpdateLog` verbatim |
| Asset storage backend (portable) | 2 coherence | Filesystem directory via the `AssetStore` contract; opaque bytes in, opaque bytes out | Asset bytes in Postgres bloat `pg_dump`/WAL; a directory keeps Postgres small. `AssetStore` keeps S3 available as an ENV swap. Confidentiality model owned by `specs/20260522T240000-cloud-asset-access-model.md`: link-shared via the encrypted document, not encrypted at rest, so the contract stays plaintext-only with no encryption, chunking, or AEAD |
| KV session cache | 2 coherence | Bun backend drops `secondaryStorage`; Postgres is the only session store | `create-auth.ts:139-155` documents KV as a pure read-through cache; a single-region self-host has no distant edge to cache for |
| Bun room construction | 1 evidence | Fully synchronous; `RoomRegistry.getRoom(name)` is a `Map` get-or-create with no async init gate | `bun:sqlite` open + replay are synchronous (verified); the DO needs `blockConcurrencyWhile`, Bun needs nothing |
| Postgres connection on Bun/Node | 1 evidence | Module-scope `pg.Pool`, not per-request `pg.Client` | No Hyperdrive doing the pooling, no isolate-per-request; a long-lived process pools once |
| Worker entry stays the default export | 2 coherence | `src/worker.ts` keeps `export default app`; `src/server.ts` is additive | "Portable means also runs on Bun/Node, never no longer runs on Cloudflare" |
| Billing for self-host | 2 coherence | Autumn optional; absent `AUTUMN_SECRET_KEY` => billing disabled | Ownership model: billing is per-deployment. Autumn is Epicenter Cloud's per-user billing and a third-party SaaS call (see Self-Containment Check) |
| `subject:<userId>:rooms:<guid>` key grammar | n/a | Unchanged | Out of scope by mandate; `RoomRegistry.getRoom(name)` receives the same string `app.ts` builds today |
| Multi-process / HA self-host | Deferred | Deferred | A private org deployment is low-scale; single process for v1 (see Open Questions) |

## Architecture

### The abstraction boundary: three contracts, one core

```
                       ┌───────────────────────────────┐
                       │  RoomCore  (src/room/core.ts)  │
                       │  ONE implementation:           │
                       │   - Yjs sync (y-protocols)     │
                       │   - update log load/append     │
                       │   - server-owned presence      │
                       │   - dispatch correlation       │
                       └───────────────────────────────┘
                          │            │            │
              depends on  │            │            │  depends on
                          ▼            ▼            ▼
                 ┌──────────────┐ ┌──────────┐ ┌──────────────┐
                 │ RoomUpdateLog│ │RoomSocket│ │ RoomRegistry │
                 │ loadAll()    │ │ send()   │ │ getRoom(name)│
                 │ append(u)    │ │ close()  │ │  -> RoomHandle│
                 │ replaceAll(c)│ │ readyState│ └──────────────┘
                 │ byteSize()   │ │ data     │
                 └──────────────┘ └──────────┘
```

The three contracts are **vocabulary**: hand-declared `type`s in a
platform-neutral module (`src/room/contracts.ts`), not derived with `ReturnType`.
Each backend is a factory function whose return object proves conformance with
`satisfies`. `RoomCore` imports the contracts, never `cloudflare:workers`.

### A factory per backend only where the seam does real work

```
PORT            Cloudflare backend              Bun backend                Factories
────────────────────────────────────────────────────────────────────────────────────
RoomUpdateLog   ctx.storage.sql calls           bun:sqlite calls           TWO. Genuinely
                                                                           different engines.
RoomSocket      hibernation wrapper:            ServerWebSocket already    ONE (Cloudflare
                serialize/deserializeAttachment has send/close/readyState  only). Bun's socket
                is REAL WORK across hibernation /data -> satisfies it      satisfies the
                                                structurally, no wrapper   contract directly.
RoomRegistry    wraps DurableObjectNamespace    Map<string,RoomCore>,      TWO, both small.
                (idFromName + stub)             lazy create
```

This is the collapsed-adapter rule: a wrapper that only renames fields is
ceremony, so the Bun socket is passed straight to `RoomCore`; the Durable Object
socket gets a factory because hibernation persistence is work the seam earns.

### The contract and the two factories (`RoomUpdateLog`)

```ts
// src/room/contracts.ts: vocabulary. Both factories implement it.
export type RoomUpdateLog = {
  loadAll(): Uint8Array[];
  append(update: Uint8Array): void;
  replaceAll(compacted: Uint8Array): void;
  byteSize(): number;
};

// src/room/backends/durable-object.ts: deps: the DO SQL handle
export function createDurableObjectUpdateLog(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)`);
  return {
    loadAll() { /* sql.exec('SELECT data ...').toArray() */ },
    append(update) { sql.exec('INSERT INTO updates (data) VALUES (?)', update); },
    replaceAll(compacted) { /* transactionSync: DELETE then INSERT */ },
    byteSize() { return sql.databaseSize; },
  } satisfies RoomUpdateLog;
}

// src/room/backends/bun-sqlite.ts: deps: an open bun:sqlite Database
export function createBunSqliteUpdateLog(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)`);
  const insert = db.query('INSERT INTO updates (data) VALUES (?)');
  return {
    loadAll() { /* db.query('SELECT data ...').values() */ },
    append(update) { insert.run(update); },
    replaceAll(compacted) { /* transaction: DELETE then INSERT */ },
    byteSize() { /* PRAGMA page_count * page_size */ },
  } satisfies RoomUpdateLog;
}
```

`RoomCore` consumes a `RoomUpdateLog` and never knows which factory built it.
The same pattern produces `createDurableObjectRoomRegistry(env.ROOM)` and
`createBunRoomRegistry({ dir })`.

### Compaction scheduling stays in the adapter

`RoomCore` owns `compact()` (the logic in `compactUpdateLog`, `room.ts:878`).
*Scheduling* it stays backend-specific and needs no fourth contract:

- Cloudflare adapter: `webSocketClose` with zero connections -> `ctx.storage.setAlarm`;
  `alarm()` -> `roomCore.compact()`.
- Bun adapter: zero connections -> `setTimeout(() => roomCore.compact(), 30s)`.

### `app.ts` route change

```ts
// BEFORE (app.ts:526): Cloudflare-only
const roomStub = c.env.ROOM.get(c.env.ROOM.idFromName(roomName));
return roomStub.fetch(c.req.raw);

// AFTER: backend-agnostic; c.var.rooms is a RoomRegistry
const room = c.var.rooms.getRoom(roomName);
return room.handleUpgrade(c.req.raw);
```

The `roomName` string is unchanged: `subject:${user.id}:rooms:${room}`
(`resolveSubjectRoom`, `app.ts:447`). The ownership model and key grammar are
untouched; only the thing that *resolves* a name to a room is now a contract.

### The deployment: one process, one Postgres, one data directory

```
  one Bun process    src/server.ts
  one Postgres       auth, sessions, metadata only. stays small. fast backups.
  one DATA_DIR       a single mounted directory:
                       DATA_DIR/rooms/<sha256(roomName)>.sqlite   Yjs update log
                       DATA_DIR/assets/<assetId>                   asset blobs
```

`docker run -v /my/data:/data -e DATABASE_URL=... epicenter`. This is the
Discourse/GitLab self-host shape.

### Two entry files, two wirings

```
STEP 1: src/worker.ts   (Cloudflare: keeps export default app)
─────────────────────────────────────────────────────────────
  rooms   = createDurableObjectRoomRegistry(env.ROOM)
  assets  = createR2AssetStore(env.ASSETS_BUCKET)
  db      = per-request pg.Client over env.HYPERDRIVE
  auth    = createAuth({ ..., secondaryStorage: KV })
  static  = env.ASSETS Fetcher

STEP 2: src/server.ts   (Bun: new)
─────────────────────────────────────────────────────────────
  rooms   = createBunRoomRegistry({ dir: `${DATA_DIR}/rooms` })
  assets  = createFilesystemAssetStore(`${DATA_DIR}/assets`)
  db      = module-scope pg.Pool over DATABASE_URL
  auth    = createAuth({ ..., secondaryStorage: undefined })
  static  = Hono serveStatic('apps/dashboard/build')
  listen  = Bun.serve({ fetch: app.fetch, websocket })
```

Both wirings build the same Hono `app` and inject an Epicenter-owned
`AppBindings` object (validated secrets + `rooms` + `assets` + `db`). `app.ts`
stops referencing `Cloudflare.Env` directly.

## ENV Schema for a Self-Hosted Deployment

One ENV file fully describes a deployment. `*` marks values with no current ENV
equivalent that this work introduces.

```bash
# ── Identity of this deployment ───────────────────────────────
BASE_URL=https://epicenter.acme.com        # * replaces hard-coded api.epicenter.so
PORT=8787                                  # * Bun HTTP listen port
TRUSTED_ORIGINS=https://app.acme.com       # * comma-separated; the org's app origins

# ── Database (replaces the Hyperdrive binding) ────────────────
DATABASE_URL=postgres://user:pass@host:5432/epicenter

# ── Persistent data directory (Bun backend) ───────────────────
DATA_DIR=/var/lib/epicenter                # * holds rooms/ and assets/ subdirectories

# ── Secrets ───────────────────────────────────────────────────
BETTER_AUTH_SECRET=...                     # openssl rand -base64 32
ENCRYPTION_SECRETS=1:base64Secret          # version:secret[,version:secret]

# ── Identity / OAuth (optional; email+password works without it)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# ── AI providers (all optional; absent => ProviderNotConfigured;
#    BYOK still works) ──────────────────────────────────────────
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
GROK_API_KEY=...

# ── Billing (optional; absent => billing disabled) ────────────
AUTUMN_SECRET_KEY=...                      # omit on self-host; see Self-Containment

# ── Admin ─────────────────────────────────────────────────────
ADMIN_USER_IDS=                            # comma-separated user ids
```

Notes:

- `BASE_URL` and `TRUSTED_ORIGINS` are new and load-bearing: today both are
  derived from `@epicenter/constants/apps`, which hard-codes Epicenter Cloud's
  domains (see Self-Containment Check, violations 1 and 2).
- `DATA_DIR` is a single knob: one directory, one volume, one backup. Not split
  into per-resource paths.
- The Worker backend keeps using `wrangler.jsonc` secrets/vars + bindings; the
  ENV file above is the **Bun** deployment descriptor. The two stay in sync
  through one shared validation schema (Phase 4).
- No KV URL: the Bun backend drops `secondaryStorage`.

## Self-Containment Check

The invariant (ownership model): a deployment shares nothing with another
deployment except source code, and runs correctly with Epicenter Cloud offline.
Audited every outbound call and every hard-coded value.

### Violations found

| # | Violation | File:line | Fix |
| --- | --- | --- | --- |
| 1 | Hard-coded `api.epicenter.so` as `PRODUCTION_API_ORIGIN`, used for the auth `baseURL` | `app.ts:62-63`, `app.ts:166-176` | `BASE_URL` env |
| 2 | `TRUSTED_ORIGINS` derived from `@epicenter/constants/apps` (Epicenter Cloud app domains) | `trusted-origins.ts:30-60` | `TRUSTED_ORIGINS` env; keep `tauri://localhost` + the shipped extension id as built-in defaults |
| 3 | Autumn billing calls `api.useautumn.com` (Epicenter's third-party SaaS account) unconditionally on signup, AI chat, and asset upload | `create-auth.ts:103`, `ai-chat.ts:82`, `asset-routes.ts:118,248` | Make Autumn optional; absent `AUTUMN_SECRET_KEY` => skip all billing gates |
| 4 | `GOOGLE_CLIENT_ID` (Epicenter Cloud's OAuth client) baked into a tracked file | `wrangler.jsonc:24` | Move to ENV (secret already is); each deployment registers its own OAuth client |
| 5 | Custom domain `api.epicenter.so` in deploy config | `wrangler.jsonc:16-21` | Per-deployment wrangler config / Bun `BASE_URL`; not shared at runtime |
| 6 | Health route reports `runtime: 'cloudflare'` literally | `app.ts:224` | Report the actual runtime |

### Not violations (confirmed)

- **AI provider calls** (OpenAI, Anthropic, Gemini, Grok) and **Google OAuth**
  go to external third parties, not to Epicenter Cloud. Every deployment
  legitimately calls these directly with its own keys. Not shared state.
- **`pg` / Postgres**: each deployment has its own `DATABASE_URL`. No shared
  rows, no shared connection.
- **Durable Objects / `RoomRegistry`**: per deployment. The DO namespace is
  scoped to the Worker; the in-process registry is scoped to the process.
- **`ENCRYPTION_SECRETS`, `BETTER_AUTH_SECRET`**: per deployment, in its ENV.

### Verdict

The codebase is self-contained **except Autumn billing** (violation 3): it is
the only runtime call to an Epicenter-Cloud-owned resource. With
`AUTUMN_SECRET_KEY` absent and billing disabled, a self-hosted deployment makes
zero calls to `api.epicenter.so` or `api.useautumn.com` and runs correctly with
Epicenter Cloud offline. Violations 1, 2, 4, 5, 6 are hard-coded
Epicenter-specific config, not shared runtime state; they are fixed by moving
config into ENV.

## Implementation Plan

Build the portable path behind the contracts, prove it, keep Cloudflare working
at every step. No phase removes the Cloudflare path.

### Phase 1: Extract `RoomCore` and declare the contracts (Cloudflare-only, no behavior change)

- [ ] **1.1** Declare `RoomUpdateLog`, `RoomSocket`, `RoomRegistry` /
  `RoomHandle` as hand-written `type`s in `src/room/contracts.ts`.
- [ ] **1.2** Extract `RoomCore` (`src/room/core.ts`): move Yjs sync, presence,
  dispatch, and update-log orchestration out of `room.ts`. `RoomCore` depends
  only on the contracts. No `cloudflare:workers` import.
- [ ] **1.3** `createDurableObjectUpdateLog(sql)` and the hibernation
  `RoomSocket` adapter, each `satisfies` its contract.
- [ ] **1.4** Reduce the DO `Room` class to an adapter: build the Cloudflare
  factories, hold one `RoomCore`, forward `fetch`/`webSocketMessage`/
  `webSocketClose`/`webSocketError`/`alarm`/`sync`/`getDoc`.
- [ ] **1.5** `createDurableObjectRoomRegistry(env.ROOM)`. Route `app.ts`
  through `c.var.rooms.getRoom(name)`.
- [ ] **1.6** Prove: `room.test.ts` and `app.rooms.test.ts` pass; `wrangler dev`
  serves rooms; `bun run typecheck` clean.

### Phase 2: Bun Room backend

- [ ] **2.1** `createBunSqliteUpdateLog(db)` over `bun:sqlite`, same `updates`
  schema as `room.ts:239`, WAL mode.
- [ ] **2.2** `RoomSocket`: confirm Bun's `ServerWebSocket` satisfies the
  contract directly (`send`, `close`, `readyState`, `data`); add a wrapper only
  if a gap appears.
- [ ] **2.3** `createBunRoomRegistry({ dir })`: `Map<string, RoomCore>`, lazy
  synchronous create, room file at `${dir}/<sha256(roomName)>.sqlite` with a
  self-identifying `meta` row; idle eviction closes the database (WAL-truncate
  checkpoint first, per the macOS caveat).
- [ ] **2.4** Run the `RoomCore` tests directly against the Bun backends, no
  `cloudflare:workers` mock.

### Phase 3: Bun entry point + portable infrastructure

- [ ] **3.1** `src/server.ts`: boot Hono via `Bun.serve` with `fetch` +
  `websocket`; wire the Bun registry. (`@hono/node-server` + `@hono/node-ws`
  remain a Node fallback path.)
- [ ] **3.2** `AssetStore` contract; `createR2AssetStore` (extract from
  `asset-routes.ts`) and `createFilesystemAssetStore(dir)` (range via
  `BunFile.slice`, conditional GET, ETag, content metadata). Change the asset
  key + URL to flat `assetId` on both backends; `userId` stays only on the
  `asset` row.
- [ ] **3.3** Module-scope `pg.Pool` over `DATABASE_URL` for the Bun backend;
  keep the per-request `pg.Client` path for the Worker. `afterResponse`
  promises run normally on Bun (no `waitUntil`).
- [ ] **3.4** Better Auth without `secondaryStorage` for the Bun backend; drop
  `storeSessionInDatabase` / `verification.storeInDatabase` accordingly (per the
  warning in `create-auth.ts:151-155`).
- [ ] **3.5** Serve the dashboard SPA from `apps/dashboard/build` via Hono
  `serveStatic` on the Bun backend.

### Phase 4: Config decoupling + ENV schema

- [ ] **4.1** Runtime-agnostic env accessor: replace
  `import { env } from 'cloudflare:workers'` (`auth/encryption.ts:1`) so the Bun
  backend reads `process.env`. Move `parseRootKeyring` off module scope.
- [ ] **4.2** `BASE_URL` env replaces `PRODUCTION_API_ORIGIN` (violation 1).
- [ ] **4.3** `TRUSTED_ORIGINS` env replaces the `APPS`-derived list (violation
  2); keep `tauri://localhost` + the shipped extension id as defaults.
- [ ] **4.4** Make Autumn optional: absent `AUTUMN_SECRET_KEY` => skip every
  billing gate (violation 3).
- [ ] **4.5** One shared ENV validation schema (arktype) used by both entry
  files; `app.ts` `Env.Bindings` becomes an Epicenter-owned `AppBindings`, not
  `Cloudflare.Env`. Health route reports the real runtime (violation 6).
- [ ] **4.6** Write `.env.example` for the Bun deployment and the self-hosted
  deployment guide.

### Phase 5: Prove self-containment

- [ ] **5.1** Stand up a second deployment (Bun) with its own Postgres, its own
  `DATA_DIR`, its own ENV, billing disabled.
- [ ] **5.2** Take Epicenter Cloud offline; confirm the second deployment signs
  users in, syncs rooms, and serves assets.
- [ ] **5.3** Confirm zero outbound calls to `api.epicenter.so` and
  `api.useautumn.com` from the self-hosted deployment.

## Edge Cases

### Room file naming

1. A room name is `subject:<userId>:rooms:<guid>`, with `:` separators and an
   embedded userId.
2. `sha256(roomName)` hex gives a fixed-width, filesystem-safe, grammar-
   independent filename. The room name stays under the DO 1,024-byte limit, so
   the same names are valid on both backends.
3. The file is opaque; a one-row `meta` table inside it records the room name,
   and the `durableObjectInstance` Postgres table is the human-readable index.

### Asset URL change

1. The asset URL becomes `/api/assets/<assetId>` (no `userId`).
2. Grep confirmed no client persists or consumes an asset URL today, so this is
   a clean greenfield change with no migration.
3. If a future client persists asset URLs, it must store the `assetId` (or a
   derivable form), not a frozen absolute URL.

### `bun:sqlite` WAL files on macOS

1. WAL files can persist after `close()` on macOS builds of SQLite.
2. A self-hosted server is typically Linux, where this does not occur.
3. The Bun update-log store runs `PRAGMA wal_checkpoint(TRUNCATE)` and disables
   persistent WAL before closing a room database on idle eviction.

### App-level ping/pong

1. The DO uses `setWebSocketAutoResponse` (`room.ts:230`) for a `ping`/`pong`
   text frame.
2. The Bun backend has no such API.
3. The Bun adapter answers a `ping` text frame directly, matching what clients
   send.

### A WS upgrade that fails auth

1. `oauth-resource.ts:27` closes a failed WS upgrade with code `4401` using
   `WebSocketPair`.
2. `WebSocketPair` is a Workers global.
3. The Bun adapter performs the equivalent `4401` close through `Bun.serve`'s
   accept-then-close path; the `4401` close-code contract is unchanged.

### Hibernation restore has no Bun equivalent

1. `room.ts:286` re-enumerates sockets after hibernation via `ctx.getWebSockets()`.
2. The Bun backend never hibernates; `connections` is never wiped.
3. The restore step is a no-op on Bun and lives only in the Cloudflare adapter,
   not in `RoomCore`.

## Open Questions

1. **Multi-process / HA for a self-hosted deployment.**
   - Options: (a) single process, vertical scale only; (b) sticky routing of a
     room name to one of N processes; (c) a shared store any process can serve.
   - **Recommendation**: (a) for v1. A room is a stateful in-memory actor; two
     processes cannot co-host one room regardless of storage. Defer HA until a
     self-hosted customer needs it.

2. **`bun:sqlite` vs `better-sqlite3` for a Node-only self-host.**
   - The recommended runtime is Bun (`bun:sqlite`, zero dependency). A Node
     deployment needs `better-sqlite3`.
   - **Recommendation**: ship the `bun:sqlite` backend first; add a
     `better-sqlite3` factory behind `RoomUpdateLog` only when a Node
     deployment is actually requested. Do not build it speculatively.

3. **Idle-eviction policy for the Bun `RoomRegistry`.**
   - Rooms stay resident with no hibernation. The registry needs a policy to
     close idle rooms' SQLite handles and free memory.
   - **Recommendation**: close a room with zero connections after a grace
     window (reuse the 30s compaction window); a later request reopens it.
     Decide the exact window during Phase 2.

4. **`AssetStore` filesystem parity with R2.**
   - R2 gives conditional GET, range, ETag, content metadata. The filesystem
     backend reimplements them (`BunFile.slice` covers range).
   - **Recommendation**: implement range + ETag + content-type (the surface
     `asset-routes.ts:333-372` uses); leave S3 as an ENV swap behind the
     contract. Decide during Phase 3.

## Decisions Log

- Keep the `subject:` DO-name prefix and the full `subject:<userId>:rooms:<guid>`
  grammar: mandated out of scope, and `RoomRegistry.getRoom(name)` receives the
  identical string. Revisit when: the encryption derivation labels are reworked.
- Keep the per-request `pg.Client` connect/end path on the Worker backend even
  though the Bun backend uses a `pg.Pool`: it is correct under Hyperdrive +
  isolate-per-request, and removing it would be a Cloudflare-path behavior
  change this spec forbids. Revisit when: the Worker stops using Hyperdrive.
- Keep `WebSocketPair` in `oauth-resource.ts` for the Worker backend: it is the
  Workers-correct way to close a failed upgrade. The Bun adapter gets its own
  equivalent path. Revisit when: Hono ships a runtime-agnostic WS-reject helper.
- Keep room files flat (no prefix sharding): an org deployment has thousands of
  rooms, not millions. Revisit when: a deployment exceeds ~100k rooms.

## Success Criteria

- [ ] `RoomCore` contains the full Yjs sync / update-log / presence / dispatch
  logic, imports the three contracts, and imports no `cloudflare:workers` symbol.
- [ ] The same `RoomCore` runs behind the Durable Object backend and the
  `bun:sqlite` + in-process-registry backend.
- [ ] `wrangler dev` and `wrangler deploy` still serve rooms, assets, auth, and
  AI chat with no behavior change; `room.test.ts` and `app.rooms.test.ts` pass.
- [ ] `bun run src/server.ts` boots a working server behind a plain Postgres and
  one `DATA_DIR`, with no Cloudflare account.
- [ ] Assets are addressed `/api/assets/<assetId>` on both backends.
- [ ] One ENV file fully describes a Bun deployment; `.env.example` and a
  self-hosted deployment guide exist.
- [ ] A second deployment serves its users, syncs rooms, and serves assets with
  Epicenter Cloud offline, making zero calls to `api.epicenter.so` or
  `api.useautumn.com`.

## References

- `specs/20260522T200000-cloud-workspace-ownership-model.md` - the ownership
  model; this spec is the execution detail for its deferred P1/P2.
- `docs/articles/20260522T210000-an-organization-is-a-deployment.md` - the
  narrative companion.
- `apps/api/src/room.ts` - the Durable Object to be split into `RoomCore` + the
  Cloudflare backend.
- `apps/api/src/app.ts` - `resolveSubjectRoom`, the `/rooms/:room` route, the DB
  middleware, the `Cloudflare.Env` binding type.
- `apps/api/src/auth/encryption.ts` - `import { env } from 'cloudflare:workers'`
  at module scope (Phase 4.1).
- `apps/api/src/asset-routes.ts` - the R2 object API to abstract behind
  `AssetStore`; the `userId/assetId` key to flatten to `assetId`.
- `specs/20260522T240000-cloud-asset-access-model.md` - the asset
  confidentiality model: link-shared via the encrypted document. Pins
  `AssetStore` as plaintext-only, opaque bytes.
- `apps/api/src/auth/create-auth.ts` - the KV `secondaryStorage`, the Autumn
  signup hook, the R2 user-delete cleanup.
- `apps/api/src/auth/oauth-resource.ts` - `WebSocketPair` in the auth-failure
  path.
- `apps/api/src/trusted-origins.ts` - the `APPS`-derived trusted-origin list
  (Phase 4.3).
- `apps/api/wrangler.jsonc` - the Cloudflare bindings and config inventory.
- `apps/api/worker-configuration.d.ts` - the generated `Cloudflare.Env` type.
- `.claude/skills/factory-function-composition` - the contract + `satisfies` +
  factory-per-backend pattern this spec applies.
