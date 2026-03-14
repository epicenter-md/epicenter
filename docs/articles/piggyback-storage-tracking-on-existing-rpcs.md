# Piggyback Storage Tracking on Existing RPCs, Not a Separate Pipeline

Cloudflare gives you no external API to list your Durable Object instances or query their storage. The only way to read `ctx.storage.sql.databaseSize` is from inside the DO itself. In Epicenter, every user gets their own DOs for workspace and document sync—so we needed a registry of what exists and how big it's getting. Instead of building a separate polling pipeline, we return storage bytes alongside every RPC response that's already happening.

## Cloudflare Won't Tell You What DOs Exist

If you want to know how much storage a DO is using, you have to ask it from inside—there's no external query API. That means you need a stub pointing at it already, which means you need to already know it exists. Sounds like a chicken-and-egg problem, but in practice every sync request already has a stub. Every `stub.sync()` and `stub.getDoc()` call already reaches into the DO. The storage number is right there; we just had to carry it back.

```typescript
const { stub, doName } = getWorkspaceStub(c);
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
return new Response(data, { ... });
```

The route handler gets its data, returns the response, and pushes the upsert as a fire-and-forget side effect. The client never waits for it.

## The afterResponse Queue Keeps the Isolate Alive

Cloudflare Workers kill the isolate the moment the response finishes. Any `await` you forgot to resolve, any promise you kicked off without waiting—gone. `waitUntil()` is the escape hatch: it tells the runtime "keep this isolate alive until this promise settles."

The `afterResponse` queue collects those promises during the request lifecycle, then drains them all via `waitUntil()` in the middleware's `finally` block.

```typescript
function createAfterResponseQueue() {
	const promises: Promise<unknown>[] = [];
	return {
		push(promise: Promise<unknown>) {
			promises.push(promise);
		},
		drain() {
			return Promise.allSettled(promises);
		},
	};
}
```

`Promise<unknown>` is intentional. These are fire-and-forget operations; callers don't need the return value. The type signals that contract without requiring a cast.

The middleware wires it together:

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
        c.executionCtx.waitUntil(afterResponse.drain().then(() => client.end()));
    }
});
```

`next()` runs the route handler. The handler pushes promises onto the queue. Then `finally` drains them all and closes the DB connection afterward. The response is already on its way to the client before any of that runs.

## The Full Flow

```
┌─────────┐    sync(body)     ┌──────────────┐
│  Client  │ ───────────────► │  Hono Worker  │
└─────────┘                   └──────┬───────┘
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                     stub.sync()          upsertDoInstance()
                          │                     │
                    ┌─────▼─────┐        ┌──────▼──────┐
                    │ Durable   │        │  Postgres   │
                    │ Object    │        │ (Hyperdrive)│
                    │           │        │             │
                    │ returns:  │        │ INSERT ...  │
                    │ {diff,    │        │ ON CONFLICT │
                    │  storage  │        │ DO UPDATE   │
                    │  Bytes}   │        └─────────────┘
                    └───────────┘
```

The two branches run in parallel after the response goes out. The client sees no latency from the storage tracking at all.

## DB Failures Don't Break Sync

`Promise.allSettled()` is the right choice here, not `Promise.all()`. If the upsert fails—Hyperdrive hiccup, schema mismatch, whatever—the sync already succeeded. The storage record is best-effort, not a billing authority. A `.catch()` on the upsert would work too, but `allSettled` in `drain()` means no single failed promise can surface as an unhandled rejection.

The storage numbers in Postgres are approximate. They lag by one request. That's fine for usage dashboards; you don't need millisecond accuracy to know a workspace is growing.

The pattern generalizes to any side effect that shouldn't block the response: audit logs, analytics events, cache invalidations. Push it onto the queue, let the middleware drain it, and the route handler stays focused on what the client actually asked for.
