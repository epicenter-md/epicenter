# Handoff: R2 Blob Storage v1 Implementation

## Task

Implement R2 blob storage for asset uploads in `apps/api/`. Three endpoints: upload (POST), read (GET), delete (DELETE). Five files to touch. No Postgres, no Autumn storage feature. Just R2 with a paid-plan gate.

Read the full spec at `specs/20260406T180000-r2-blob-storage.md` before starting.

## Context

### Codebase

This is a Cloudflare Workers API built with Hono, using `bun` as the runtime/package manager. The app is at `apps/api/` in a monorepo.

### Current `wrangler.jsonc` bindings (no R2 yet)

```jsonc
// apps/api/wrangler.jsonc (relevant sections)
{
  "kv_namespaces": [{ "binding": "SESSION_KV", ... }],
  "durable_objects": {
    "bindings": [
      { "name": "WORKSPACE_ROOM", ... },
      { "name": "DOCUMENT_ROOM", ... }
    ]
  },
  "hyperdrive": [{ "binding": "HYPERDRIVE", ... }]
  // No r2_buckets yet: you add this
}
```

### Existing auth guard pattern (`apps/api/src/app.ts` lines 269-302)

```ts
const authGuard = factory.createMiddleware(async (c, next) => {
  const wsToken = c.req.query('token');
  const headers = wsToken
    ? new Headers({ authorization: `Bearer ${wsToken}` })
    : c.req.raw.headers;

  const result = await c.var.auth.api.getSession({ headers });
  if (!result) return c.json({ error: 'Unauthorized' }, 401);

  c.set('user', result.user);
  c.set('session', result.session);
  await next();
});
app.use('/ai/*', authGuard);
app.use('/workspaces/*', authGuard);
app.use('/documents/*', authGuard);
app.use('/api/billing/*', authGuard);

// Plan derivation middleware (runs after authGuard on /ai/* routes)
app.use('/ai/*', async (c, next) => {
  const autumn = createAutumn(c.env);
  const customer = await autumn.customers.getOrCreate({
    customerId: c.var.user.id,
    name: c.var.user.name ?? undefined,
    email: c.var.user.email ?? undefined,
    expand: ['subscriptions.plan'],
  });
  const mainSub = customer.subscriptions.find(
    (s: { addOn?: boolean }) => !s.addOn,
  );
  c.set('planId', mainSub?.planId ?? 'free');
  await next();
});
```

### Existing constants pattern (`apps/api/src/constants.ts`)

```ts
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
```

### ID generation (`packages/workspace/src/shared/id.ts`)

```ts
import { customAlphabet } from 'nanoid';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const nanoid15 = customAlphabet(ALPHABET, 15);

export type Guid = string & Brand<'Guid'>;

export function generateGuid(): Guid {
  return nanoid15() as Guid;
}
```

### Billing plan IDs (`apps/api/src/billing-plans.ts`)

```ts
export const FEATURE_IDS = {
  aiUsage: 'ai_usage',
  aiCredits: 'ai_credits',
} as const;

export const PLAN_IDS = {
  free: 'free',
  pro: 'pro',
  ultra: 'ultra',
  max: 'max',
  // ...
} as const;
```

### Autumn SDK (`apps/api/src/autumn.ts`)

```ts
import { Autumn } from 'autumn-js';

export function createAutumn(env: { AUTUMN_SECRET_KEY: string }) {
  return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });
}
```

### Env types (`apps/api/src/app.ts`)

```ts
export type Env = {
  Bindings: Cloudflare.Env;
  Variables: {
    db: Db;
    auth: Auth;
    user: Session['user'];
    session: Session['session'];
    afterResponse: AfterResponseQueue;
    planId: string | undefined;
  };
};
```

### The `afterResponse` pattern (fire-and-forget after response)

```ts
// Used throughout app.ts for non-blocking work after the response:
c.var.afterResponse.push(somePromise);
// All queued promises settle via executionCtx.waitUntil() in the middleware
```

## Design Requirements

### 1. Add R2 binding

Add to `wrangler.jsonc`:

```jsonc
"r2_buckets": [
  {
    "binding": "ASSETS_BUCKET",
    "bucket_name": "epicenter-assets"
  }
]
```

Then run `bunx wrangler types` to regenerate `worker-configuration.d.ts`.

### 2. Add constant

In `apps/api/src/constants.ts`, add:

```ts
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
```

### 3. Create `apps/api/src/asset-routes.ts`

A Hono route group with three endpoints. Use `createFactory<Env>()` from `hono/factory` to match the existing pattern.

#### POST `/`: Upload

1. Extract file from `multipart/form-data` body (the `file` field)
2. Validate content type against allowlist:
   ```ts
   const ALLOWED_MIME_TYPES = new Set([
     'image/png', 'image/jpeg', 'image/gif', 'image/webp',
     'application/pdf',
   ]);
   ```
3. Validate file size against `MAX_ASSET_BYTES` (return 413 if exceeded)
4. If MIME type not allowed, return 415 with `{ error: 'File type not allowed', allowed: [...ALLOWED_MIME_TYPES] }`
5. Generate assetId via `generateGuid()` from `@epicenter/workspace`
6. Construct R2 key: `${c.var.user.id}/${assetId}`
7. Put to R2:
   ```ts
   await c.env.ASSETS_BUCKET.put(key, file.stream(), {
     httpMetadata: {
       contentType: file.type,
       contentDisposition: `inline; filename="${file.name}"`,
       cacheControl: 'private, max-age=31536000, immutable',
     },
     customMetadata: {
       originalName: file.name,
       userId: c.var.user.id,
       uploadedAt: new Date().toISOString(),
     },
   });
   ```
8. Return JSON:
   ```ts
   return c.json({
     id: assetId,
     url: `/api/assets/${c.var.user.id}/${assetId}`,
     contentType: file.type,
     size: file.size,
     originalName: file.name,
   }, 201);
   ```

#### GET `/:userId/:assetId`: Read (unauthenticated)

1. Construct key: `${userId}/${assetId}`
2. Call R2 with conditional + range support:
   ```ts
   const object = await c.env.ASSETS_BUCKET.get(key, {
     onlyIf: c.req.raw.headers,
     range: c.req.raw.headers,
   });
   ```
3. If `object === null`: return 404
4. If object exists but has no `body` (precondition failed): return 304
5. Build response headers:
   ```ts
   const headers = new Headers();
   object.writeHttpMetadata(headers);
   headers.set('etag', object.httpEtag);
   headers.set('x-content-type-options', 'nosniff');
   // Content-Disposition and Cache-Control come from writeHttpMetadata
   // (stored in httpMetadata during upload)
   ```
6. Return the body as a streaming response with those headers

#### DELETE `/:userId/:assetId`: Delete (authenticated, owner only)

1. Verify `c.var.user.id === userId` param: if not, return 403
2. Construct key and delete: `await c.env.ASSETS_BUCKET.delete(key)`
3. Return 204

### 4. Mount in `app.ts`

The read endpoint must be unauthenticated. Upload and delete require auth + plan check. Structure:

```ts
import assetRoutes from './asset-routes';

// authGuard for write operations only
app.use('/api/assets', authGuard);        // POST (upload)
app.use('/api/assets/*', authGuard);      // DELETE. BUT this conflicts with GET

// Better approach: apply authGuard inside asset-routes.ts per-endpoint,
// or mount the read route separately before the guard.
```

**Important routing detail**: The GET read endpoint must NOT go through authGuard. The cleanest way is to handle auth inside `asset-routes.ts` by importing the authGuard factory, or by mounting the read route on a separate path before the auth middleware. Check how the existing route structure handles this: the implementer should decide the cleanest approach that matches codebase conventions.

For the plan gate on uploads, follow the `/ai/*` middleware pattern: after authGuard validates the session, derive `planId` via Autumn and check `planId === PLAN_IDS.free` → return 402.

### 5. Add placeholder to `billing-plans.ts`

```ts
export const FEATURE_IDS = {
  aiUsage: 'ai_usage',
  aiCredits: 'ai_credits',
  storageBytes: 'storage_bytes', // ← add this
} as const;
```

## Available Tools

- `createFactory<Env>()` from `hono/factory`: use for route groups
- `sValidator` from `@hono/standard-validator` + `type` from `arktype`: for param validation
- `describeRoute` from `hono-openapi`: for OpenAPI tagging
- `generateGuid` from `@epicenter/workspace`: for asset IDs
- `createAutumn` from `./autumn`: for plan derivation
- `PLAN_IDS`, `FEATURE_IDS` from `./billing-plans`

## MUST DO

- Load the `elysia` skill (for Hono patterns), `typescript` skill, `error-handling` skill, and `monorepo` skill
- Use `generateGuid()` from `@epicenter/workspace` for asset IDs: do NOT invent a new ID generator
- Use `object.writeHttpMetadata(headers)` on the read endpoint: don't manually set Content-Type
- Pass `onlyIf` and `range` from request headers to `ASSETS_BUCKET.get()` for ETag/range support
- Set `x-content-type-options: nosniff` on every read response
- Store `contentDisposition` and `cacheControl` in R2 `httpMetadata` during upload (so `writeHttpMetadata` sets them on read)
- Follow existing code patterns: `describeRoute()` for OpenAPI tags, `sValidator` for param validation
- Run `bunx wrangler types` after adding the R2 binding
- Run typecheck after all changes: `bun run typecheck` from the monorepo root
- Keep changes minimal: 5 files only: `wrangler.jsonc`, `worker-configuration.d.ts` (regenerated), `constants.ts`, `asset-routes.ts` (new), `app.ts`, `billing-plans.ts`

## MUST NOT DO

- Do NOT add a Postgres table: that's Phase 4
- Do NOT add `autumn.check()` or `autumn.track()` for storage: that's Phase 4
- Do NOT install new dependencies: everything needed is already in the project
- Do NOT modify any files outside `apps/api/`
- Do NOT use `as any` or `@ts-ignore`
- Do NOT support SVG uploads: SVG is an XSS vector
- Do NOT add magic byte validation: unnecessary for v1
- Do NOT create a public bucket or custom domain: bucket stays private
- Do NOT add auth to the read endpoint: unauthenticated reads are intentional
