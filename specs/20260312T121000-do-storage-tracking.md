# DO Storage Tracking Registry

**Status:** Implemented
**Scope:** 3 files modified, 1 migration generated, 2 atomic commits

## Problem

No visibility into which Durable Object instances exist per user, what type they are, or how much storage they consume. A user dashboard needs this data to show storage usage. The Worker already accesses DOs on every request—we just need to record the access and piggyback storage size on existing RPC responses.

## Architecture Decisions

1. **Single table** `durable_object_instance` with `do_type` discriminator
2. **Composite PK**: `(userId, doType, resourceName)`—not `doName` alone
3. **`doName` as a regular column** with UNIQUE constraint (not PK)
4. **`resourceName` denormalized** for queryable display without parsing `doName`
5. **Both `createdAt` + `lastAccessedAt`** timestamps retained
6. **Separate `storageMeasuredAt`** from `lastAccessedAt`—storage isn't measured on every access (e.g. WebSocket upgrades)
7. **Piggyback storage size** on existing `sync()` and `getDoc()` RPC responses—no separate RPC
8. **`afterResponse` queue pattern** in DB middleware—ensures upsert completes before `client.end()` without blocking the HTTP response
9. **Skip snapshot route tracking** in v1—any document access via `getDoc()`/`sync()` captures the instance before snapshots are used
10. **WebSocket upgrades** upsert `lastAccessedAt` only (no `storageBytes`)—next HTTP call fills in storage

## Implementation Plan

### Task 1: Schema definition + migration

- [x] Add imports to `schema.ts`: `bigint`, `index` from `drizzle-orm/pg-core`
- [x] Add `durableObjectInstance` table definition
- [x] Add `durableObjectInstanceRelations`
- [x] Add `durableObjectInstances: many(durableObjectInstance)` to `userRelations`
- [x] Generate migration via `bun run db:generate` from `apps/api/`
- [x] Verify generated SQL looks correct

**Table definition:**

```typescript
/** Discriminator for the type of Durable Object instance. */
export type DoType = 'workspace' | 'document';

export const durableObjectInstance = pgTable(
	'durable_object_instance',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		doType: text('do_type').notNull().$type<DoType>(),
		resourceName: text('resource_name').notNull(),
		doName: text('do_name').primaryKey(),
		storageBytes: bigint('storage_bytes', { mode: 'number' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
		storageMeasuredAt: timestamp('storage_measured_at'),
	},
	(table) => [index('doi_user_id_idx').on(table.userId)],
);
```

**Relations:**

```typescript
export const durableObjectInstanceRelations = relations(
	durableObjectInstance,
	({ one }) => ({
		user: one(user, {
			fields: [durableObjectInstance.userId],
			references: [user.id],
		}),
	}),
);
```

**Existing `userRelations` addition:**

```typescript
// Add to the existing userRelations spread:
durableObjectInstances: many(durableObjectInstance),
```

**Verification:**
- `bun run db:generate` from `apps/api/` succeeds
- Generated SQL contains `CREATE TABLE "durable_object_instance"` with `do_name` as PK and index on `user_id`
- `bun run typecheck` from `apps/api/` passes

### Task 2: DO RPC return type changes (`base-sync-room.ts`)

- [x] Change `sync()` return type from `Promise<Uint8Array | null>` to `Promise<{ diff: Uint8Array | null; storageBytes: number }>`
- [x] Change `getDoc()` return type from `Promise<Uint8Array>` to `Promise<{ data: Uint8Array; storageBytes: number }>`
- [x] Read `this.ctx.storage.sql.databaseSize` in each method

**`sync()` change (base-sync-room.ts:244–257):**

```typescript
async sync(body: Uint8Array): Promise<{ diff: Uint8Array | null; storageBytes: number }> {
	const { stateVector: clientSV, update } = decodeSyncRequest(body);

	if (update.byteLength > 0) {
		Y.applyUpdateV2(this.doc, update, 'http');
	}

	const serverSV = Y.encodeStateVector(this.doc);
	const diff = stateVectorsEqual(serverSV, clientSV)
		? null
		: Y.encodeStateAsUpdateV2(this.doc, clientSV);

	return { diff, storageBytes: this.ctx.storage.sql.databaseSize };
}
```

**`getDoc()` change (base-sync-room.ts:266–268):**

```typescript
async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
	return {
		data: Y.encodeStateAsUpdateV2(this.doc),
		storageBytes: this.ctx.storage.sql.databaseSize,
	};
}
```

**Verification:**
- `bun run typecheck` from `apps/api/` passes (will fail until Task 3 updates callers—Tasks 2+3 are in the same commit)

### Task 3: Worker upsert logic (`app.ts`)

Three sub-tasks: afterResponse middleware, upsert helper, route handler modifications.

#### 3a: afterResponse queue in DB middleware

- [x] Add `afterResponse: AfterResponseQueue` to `Env.Variables`
- [x] Create `createAfterResponseQueue()` utility function
- [x] Use `afterResponse.drain().then(() => client.end())` in `finally` block

**`createAfterResponseQueue()` utility (app.ts):**

```typescript
function createAfterResponseQueue() {
	/**
	 * Tracked promises whose resolution values are intentionally ignored.
	 * `unknown` is the semantic contract for fire-and-forget: we track these
	 * promises to completion via `Promise.allSettled`, but never inspect what
	 * they resolve to.
	 */
	const promises: Promise<unknown>[] = [];
	return {
		/** Enqueue a fire-and-forget promise to run after the response is sent. */
		push(promise: Promise<unknown>) {
			promises.push(promise);
		},
		/** Settle all queued promises. Returns a single promise suitable for `executionCtx.waitUntil()`. */
		drain() {
			return Promise.allSettled(promises);
		},
	};
}
```

**Env type (app.ts):**

```typescript
type AfterResponseQueue = ReturnType<typeof createAfterResponseQueue>;

export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		db: Db;
		auth: Auth;
		user: Session['user'];
		session: Session['session'];
		afterResponse: AfterResponseQueue;
	};
};
```

**DB middleware (app.ts):**

```typescript
app.use('*', async (c, next) => {
	const client = new pg.Client({
		connectionString: c.env.HYPERDRIVE.connectionString,
	});
	const afterResponse = createAfterResponseQueue();
	try {
		await client.connect();
		c.set('db', drizzle(client, { schema }));
		c.set('afterResponse', afterResponse);
		await next();
	} finally {
		c.executionCtx.waitUntil(afterResponse.drain(() => client.end()));
	}
});
```

#### 3b: Upsert helper function

- [x] Add `upsertDoInstance` function in `app.ts` (above the route definitions, below the factory)

```typescript
/**
 * Fire-and-forget upsert for DO instance tracking.
 *
 * Records that a user accessed a DO, optionally updating storage bytes.
 * Uses INSERT ON CONFLICT so the first access creates the row and
 * subsequent accesses update `lastAccessedAt` (and `storageBytes` when
 * provided). Errors are caught and logged—this is best-effort telemetry,
 * not billing authority.
 */
function upsertDoInstance(
	db: Db,
	params: {
		userId: string;
		doType: schema.DoType;
		resourceName: string;
		doName: string;
		storageBytes?: number;
	},
): Promise<unknown> {
	const now = new Date();
	return db
		.insert(schema.durableObjectInstance)
		.values({
			userId: params.userId,
			doType: params.doType,
			resourceName: params.resourceName,
			doName: params.doName,
			storageBytes: params.storageBytes ?? null,
			lastAccessedAt: now,
			storageMeasuredAt: params.storageBytes != null ? now : null,
		})
		.onConflictDoUpdate({
			target: schema.durableObjectInstance.doName,
			set: {
				lastAccessedAt: now,
				...(params.storageBytes != null && {
					storageBytes: params.storageBytes,
					storageMeasuredAt: now,
				}),
			},
		})
		.catch((e) => console.error('[do-tracking] upsert failed:', e));
}
```

#### 3c: Route handler modifications

- [x] `GET /workspaces/:workspace` — destructure `getDoc()` result, add upsert (with storageBytes for HTTP, without for WS)
- [x] `POST /workspaces/:workspace` — destructure `sync()` result, add upsert with storageBytes
- [x] `GET /documents/:document` — same pattern as workspace GET
- [x] `POST /documents/:document` — same pattern as workspace POST

**Pattern for GET routes (using workspace as example, document is identical with `'document'` doType):**

```typescript
app.get(
	'/workspaces/:workspace',
	describeRoute({
		description: 'Get workspace doc or upgrade to WebSocket',
		tags: ['workspaces'],
	}),
	async (c) => {
		const { stub, doName } = getWorkspaceStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					doType: 'workspace',
					resourceName: c.req.param('workspace'),
					doName,
				}),
			);
			return stub.fetch(c.req.raw);
		}

		const { data, storageBytes } = await stub.getDoc();
		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'workspace',
				resourceName: c.req.param('workspace'),
				doName,
				storageBytes,
			}),
		);
		return new Response(data, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
```

**Pattern for POST routes (using workspace as example):**

```typescript
app.post(
	'/workspaces/:workspace',
	describeRoute({
		description: 'Sync workspace doc',
		tags: ['workspaces'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const { stub, doName } = getWorkspaceStub(c);
		const { diff, storageBytes } = await stub.sync(body);

		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'workspace',
				resourceName: c.req.param('workspace'),
				doName,
				storageBytes,
			}),
		);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
```

**Verification:**
- `bun run typecheck` from `apps/api/` passes
- All 4 main routes (`GET`/`POST` for workspaces + documents) include upsert calls
- WebSocket upgrade paths only pass `lastAccessedAt` (no `storageBytes`)
- HTTP paths pass `storageBytes` from DO RPC response

## Atomic Commit Strategy

### Commit 1: `feat(api): add durable_object_instance schema and migration`

**Files:**
- `apps/api/src/db/schema.ts` — new table + relations + updated `userRelations`
- `apps/api/drizzle/0001_*.sql` — generated migration

**Why separate:** Schema is a DB-only change. The new table doesn't affect existing code. Can be deployed (migration applied) independently before the runtime change ships.

### Commit 2: `feat(api): track DO instances with storage size on every access`

**Files:**
- `apps/api/src/base-sync-room.ts` — `sync()` and `getDoc()` return `{ data/diff, storageBytes }`
- `apps/api/src/app.ts` — `afterResponse` queue, `upsertDoInstance` helper, route handler updates

**Why together:** The RPC return type change and the Worker code that destructures the new shape must ship atomically. If deployed separately, the Worker would try to use a `Uint8Array` as a `{ data, storageBytes }` object (or vice versa).

## Data Flow Diagram

```
Client                    Worker (app.ts)              DO (base-sync-room.ts)      Postgres
  │                           │                              │                        │
  │── POST /workspaces/foo ──▶│                              │                        │
  │                           │── stub.sync(body) ──────────▶│                        │
  │                           │                              │ apply update            │
  │                           │                              │ read databaseSize       │
  │                           │◀── { diff, storageBytes } ──│                        │
  │                           │                              │                        │
  │                           │ push upsert to afterResponse │                        │
  │◀── Response(diff) ───────│                              │                        │
  │                           │                              │                        │
  │                           │──── (waitUntil) upsert ─────────────────────────────▶│
  │                           │                              │                        │ INSERT ON
  │                           │                              │                        │ CONFLICT
  │                           │◀─── (waitUntil) client.end() ◀──────────────────────│
```

## Not in Scope (v1)

- **Snapshot route tracking** — covered by `getDoc()`/`sync()` accesses
- **Upsert throttling** — add later if traffic warrants it
- **Deletion cleanup** — when DOs are deleted, rows become stale; a future cleanup job can handle this
- **Dashboard query endpoint** — separate feature; this spec only covers the write path

## Review

**Completed**: 2026-03-13
**Branch**: `opencode/playful-cactus`

### Summary

Implemented the DO storage tracking registry. The `durable_object_instance` table tracks every Durable Object access per user with storage size piggybacked on existing `sync()` and `getDoc()` RPC responses.

### Post-Implementation Refinements

After the initial implementation, several improvements were made:

- **`createAfterResponseQueue()` utility**: Extracted the raw `Promise<unknown>[]` array into a factory function with `push()` and `drain()` methods. Encapsulates the `Promise.allSettled → cleanup` pattern and makes the middleware more readable.
- **`DoType` union type**: Added `type DoType = 'workspace' | 'document'` with `$type<DoType>()` on the column definition. Narrows the `doType` parameter from `string` to a compile-time checked union.
- **`doName` as primary key**: Simplified from composite PK `(userId, doType, resourceName)` + unique constraint on `doName` to just `doName` as the single PK. The composite was redundant since `doName` = `user:{userId}:{doType}:{resourceName}`. Added `userId` index for FK cascade performance and user-scoped queries. `doType` and `resourceName` remain as data columns for query convenience.
- **Stub functions return `doName`**: `getWorkspaceStub()` and `getDocumentStub()` now return `{ stub, doName }` instead of just the stub. Eliminates duplicate `doName` template literal construction across 6 upsert call sites.
- **Fixed indentation**: Corrected `doName` property indentation in 4 upsert calls that had an extra tab level.
- **Fixed `userRelations` closing brace**: Removed extra tab on the closing `}));`.
- **Migration regenerated**: `0001_futuristic_santa_claus.sql` with `doName` as PK, `userId` index, and no composite PK.

### Deviations from Original Spec

- **Table placement in schema.ts**: Moved `durableObjectInstance` table definition before `userRelations` (not at end of file) to avoid TypeScript `const` temporal dead zone errors from forward references.
- **No new errors introduced**: 3 pre-existing Better Auth type errors in `app.ts` remain unchanged.

### Follow-up Work

- Apply migration to production database (`bun run db:migrate:remote`)
- Dashboard query endpoint for per-user storage display (separate spec)
- Upsert throttling if traffic warrants it
- Stale row cleanup job for deleted DOs
