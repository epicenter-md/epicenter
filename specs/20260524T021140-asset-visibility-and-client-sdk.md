# Asset visibility (server-flagged) and `createEpicenterCloud` client SDK

Status: draft
Owner: braden
Date: 2026-05-24

## 1. Goal

Two changes that compose:

1. **Server-flagged visibility on assets.** Each asset row carries a
   `visibility` column (`'private' | 'public'`). The read handler gates auth
   on the flag at request time. One R2 object per asset, ever. Publishing
   and unpublishing are flag flips, not re-uploads.

2. **`createEpicenterCloud(...)` client SDK.** A typed factory that wraps
   the cloud HTTP surface (assets first; session, billing, rooms can land
   later) and gives app developers ergonomic primitives:
   `epicenter.assets.upload(file, { visibility })`,
   `epicenter.assets.setVisibility(id, v)`, `epicenter.assets.delete(id)`,
   `epicenter.assets.url(id)`.

The library stores bytes and gates reads. It does not encrypt assets,
does not enforce any UX, does not refcount. Developers building apps on
top decide their app's visibility defaults, whether to encrypt
client-side, and when to delete.

## 2. Final shapes

### 2.1 Schema delta

```ts
// packages/server/src/db/schema/app.ts (current)
export const asset = pgTable(
  'asset',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    originalName: text('original_name').notNull(),
    uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  },
  (table) => [index('asset_owner_id_idx').on(table.ownerId)],
);
```

```ts
// packages/server/src/db/schema/app.ts (after)
export const asset = pgTable(
  'asset',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    originalName: text('original_name').notNull(),
    /**
     * Visibility flag. `'private'` (default) requires auth + owner match
     * to read; `'public'` serves bytes to anyone with the URL. Flipping
     * this is the publish/unpublish primitive. The R2 object is never
     * duplicated; the flag IS the visibility decision.
     */
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('private'),
    uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  },
  (table) => [
    index('asset_owner_id_idx').on(table.ownerId),
    // Speeds up the public-read path: GET /:id branches on visibility,
    // so an (id, visibility) index lets the planner answer 'is this
    // public?' from the index alone.
    index('asset_visibility_idx').on(table.visibility),
  ],
);
```

Generated migration (Drizzle will produce something like this):

```sql
-- apps/api/drizzle/0004_asset_visibility.sql
ALTER TABLE "asset"
  ADD COLUMN "visibility" text NOT NULL DEFAULT 'private';
--> statement-breakpoint
CREATE INDEX "asset_visibility_idx"
  ON "asset" USING btree ("visibility");
```

Existing rows backfill to `'private'`. Behavior preserved: every asset
that exists today continues to require auth, which is what today's mount
in `apps/api` already enforces in practice (auth is on the whole
`/assets/*` prefix today, so the "capability URL" comment was
aspirational).

### 2.2 ID entropy bump

```text
TODAY:    15-char nanoid, 36-char alphabet → ~77 bits entropy
AFTER:    21-char nanoid, 36-char alphabet → ~108 bits

Slack's ~2015 file-token brute force is the cautionary tale: 77 bits is
close to the line if the URL is the credential. Signal and Bitwarden
both ship 128+ bits. The change is one literal in the nanoid call site.
```

The route param regex tightens to `{[a-z0-9]{21}}` to match.

### 2.3 API contract

URL shape uniform across modes (unchanged from today's design):

```text
POST   /api/owners/:ownerId/assets                  upload
GET    /api/owners/:ownerId/assets                  list
GET    /api/owners/:ownerId/assets/usage            storage total
GET    /api/owners/:ownerId/assets/:assetId         read (conditional auth)
PATCH  /api/owners/:ownerId/assets/:assetId         modify metadata
DELETE /api/owners/:ownerId/assets/:assetId         drop
```

Bodies and responses:

```ts
// POST /api/owners/:ownerId/assets
// multipart/form-data:
//   file:        File
//   visibility:  'private' | 'public'   (defaults to 'private' if absent)
//
// → 201
//   {
//     id: string,
//     url: string,           // /api/owners/:ownerId/assets/:assetId
//     visibility: 'private' | 'public',
//     contentType: string,
//     size: number,
//     name: string,
//   }

// PATCH /api/owners/:ownerId/assets/:assetId
// application/json:
//   { visibility: 'private' | 'public' }
//
// → 200
//   { id, visibility }
//
// Reserved for future fields: name (rename). Adding a field here does
// not break callers because PATCH is partial: clients only send what
// they want to change.

// PUT /api/owners/:ownerId/assets/:assetId       (FUTURE, NOT IN THIS SPEC)
// multipart/form-data:
//   file: File
// → 200: replaces bytes, same id, same URL, same metadata except
//   contentType/size/name if the new file differs. Document deletes
//   any cached copies are stale.

// DELETE /api/owners/:ownerId/assets/:assetId
// → 204 + 'x-deleted-size-bytes' header for the storage gate
```

### 2.4 Auth posture per route

```text
ROUTE                              AUTH REQUIRED
─────────────────────────────────────────────────────
POST   /assets                     yes
GET    /assets                     yes (list = owner's own)
GET    /assets/usage               yes
GET    /assets/:id                 CONDITIONAL on row.visibility
PATCH  /assets/:id                 yes (owner only)
DELETE /assets/:id                 yes (owner only)
```

The conditional GET is the one shape that's new. Today's middleware
chain in `apps/api` applies auth to the whole `/assets/*` prefix; that
needs to change for this spec to deliver public reads.

### 2.5 Mount in `apps/api/src/index.ts`

```ts
// Methods that always require auth.
const cloudAssetsAuthedMethods = ['POST', 'PATCH', 'DELETE'] as const;
const cloudAssetsAuthedListGets = ['/owners/:ownerId/assets',
                                   '/owners/:ownerId/assets/usage'];

const cloudAssets = new Hono<Env>()
  .on(
    cloudAssetsAuthedMethods,
    '/owners/:ownerId/assets/*',
    requireCookieOrBearerUser,
    requireUrlOwnerIdMatchesAuth,
    attachOwner,
    autumnStorageGate,
  )
  .on(
    ['POST'],
    '/owners/:ownerId/assets',
    requireCookieOrBearerUser,
    requireUrlOwnerIdMatchesAuth,
    attachOwner,
    autumnStorageGate,
  )
  // List + usage GETs need auth too:
  .use(cloudAssetsAuthedListGets[0],
       requireCookieOrBearerUser, requireUrlOwnerIdMatchesAuth, attachOwner)
  .use(cloudAssetsAuthedListGets[1],
       requireCookieOrBearerUser, requireUrlOwnerIdMatchesAuth, attachOwner)
  // GET /:id falls through to the library handler with NO auth above.
  // The handler runs auth conditionally based on row.visibility.
  .route('/', assets);
```

### 2.6 Conditional auth in the library GET handler

The library's `createAssetPublicRoutes` (renamed: it now serves both
visibility modes) does the visibility lookup and gates auth inline:

```ts
// packages/server/src/asset-routes.ts (shape)
export function createAssetReadRoute(mode: OwnershipMode): Hono<Env> {
  const isPersonal = mode === 'personal';
  return new Hono<Env>().get(
    '/:assetId{[a-z0-9]{21}}',
    describeRoute({ description: 'Read an asset', tags: ['assets'] }),
    async (c) => {
      const { assetId } = c.req.param();
      const urlOwnerId = asOwnerId(c.req.param('ownerId')!);

      const [row] = await c.var.db
        .select({
          ownerId: schema.asset.ownerId,
          visibility: schema.asset.visibility,
          contentType: schema.asset.contentType,
          originalName: schema.asset.originalName,
        })
        .from(schema.asset)
        .where(and(
          eq(schema.asset.id, assetId),
          eq(schema.asset.ownerId, urlOwnerId),
        ))
        .limit(1);

      if (!row) return c.json(AssetError.NotFound(), 404);

      if (row.visibility === 'private') {
        const session = await c.var.auth.api.getSession({
          headers: c.req.raw.headers,
        });
        const sessionOwnerId = isPersonal
          ? session?.user?.id
          : (session ? TEAM_OWNER_ID : undefined);
        if (sessionOwnerId !== urlOwnerId) {
          return c.json(AssetError.Unauthorized(), 401);
        }
      }

      // Serve from R2 with ETag/range, as today.
      const r2Key = assetKey(urlOwnerId, assetId);
      const object = await c.env.ASSETS_BUCKET.get(r2Key, {
        onlyIf: c.req.raw.headers,
        range: c.req.raw.headers,
      });

      // Cache-Control differs by visibility. Private assets must never
      // hit a shared cache (Cloudflare edge, corporate proxies). Public
      // assets get a short max-age so that visibility flips become
      // visible to new requests within ~60s without an explicit purge.
      // Longer max-age + active purge on PATCH is a future optimization.
      const cacheControl = row.visibility === 'public'
        ? 'public, max-age=60'
        : 'private, no-store';

      return new Response(object.body, {
        headers: {
          'content-type': row.contentType,
          'etag': object.httpEtag,
          'cache-control': cacheControl,
          // ... range/content-length/etc. as today
        },
      });
    },
  );
}
```

Important detail: this handler reads `c.req.param('ownerId')` directly
because `attachOwner` did NOT run upstream for public reads.
`attachOwner` requires `c.var.user`, which is only set when auth
succeeded. The URL provides ownerId; the row lookup constrains it.

### 2.7 `createEpicenterCloud` client SDK

New package or new entry inside an existing client package: TBD per
§3 placement. The factory binds an authed fetch and a base URL:

```ts
// packages/cloud-client/src/index.ts (or similar)
import type { AuthFetch } from '@epicenter/auth';

export type EpicenterCloudOptions = {
  /** Base URL of the cloud API (no trailing slash). */
  baseURL: string;
  /**
   * Fetch with OAuth bearer auto-attach + refresh. Produced by
   * `createOAuthAppAuth(...)` from `@epicenter/auth`. The cloud SDK
   * does not own auth state; it composes onto an existing auth fetch.
   */
  fetch: AuthFetch;
};

export type EpicenterCloud = ReturnType<typeof createEpicenterCloud>;

export function createEpicenterCloud(opts: EpicenterCloudOptions) {
  const base = opts.baseURL.replace(/\/+$/, '');

  /**
   * Lazy-cached session. Most apps read it once; the SDK caches the
   * resolved ownerId so per-call URL construction stays sync.
   */
  let cachedOwnerId: OwnerId | null = null;
  async function getOwnerId(): Promise<OwnerId> {
    if (cachedOwnerId) return cachedOwnerId;
    const res = await opts.fetch(`${base}/api/session`);
    if (!res.ok) throw new Error(`session fetch ${res.status}`);
    const session = (await res.json()) as ApiSessionResponse;
    cachedOwnerId = session.ownerId;
    return session.ownerId;
  }

  const assets = {
    async upload(
      file: File,
      params: { visibility?: 'private' | 'public' } = {},
    ) {
      const ownerId = await getOwnerId();
      const fd = new FormData();
      fd.append('file', file);
      fd.append('visibility', params.visibility ?? 'private');
      const res = await opts.fetch(
        `${base}/api/owners/${ownerId}/assets`,
        { method: 'POST', body: fd },
      );
      if (!res.ok) throw new Error(`upload ${res.status}`);
      return res.json() as Promise<UploadResponse>;
    },

    async list() {
      const ownerId = await getOwnerId();
      const res = await opts.fetch(
        `${base}/api/owners/${ownerId}/assets`,
      );
      return res.json() as Promise<AssetRow[]>;
    },

    async usage() {
      const ownerId = await getOwnerId();
      const res = await opts.fetch(
        `${base}/api/owners/${ownerId}/assets/usage`,
      );
      return res.json() as Promise<{ totalBytes: number }>;
    },

    async setVisibility(
      id: string,
      visibility: 'private' | 'public',
    ) {
      const ownerId = await getOwnerId();
      const res = await opts.fetch(
        `${base}/api/owners/${ownerId}/assets/${id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visibility }),
        },
      );
      if (!res.ok) throw new Error(`patch ${res.status}`);
      return res.json() as Promise<{ id: string; visibility: 'private' | 'public' }>;
    },

    async delete(id: string) {
      const ownerId = await getOwnerId();
      const res = await opts.fetch(
        `${base}/api/owners/${ownerId}/assets/${id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`delete ${res.status}`);
    },

    /**
     * Build the full URL for an asset. Useful for embedding in Yjs docs,
     * <img src> attributes, share buttons. Sync; uses the cached
     * ownerId.
     *
     * For URLs that need to be shareable BEFORE the session has loaded,
     * call `await ensureReady()` once at app boot.
     */
    url(id: string): string {
      if (!cachedOwnerId) {
        throw new Error(
          'epicenter.assets.url called before session resolved. ' +
          'await epicenter.ready() first, or use any async assets method.',
        );
      }
      return `${base}/api/owners/${cachedOwnerId}/assets/${id}`;
    },
  };

  return {
    /** Resolve session and cache ownerId. Call once at app boot. */
    async ready() { await getOwnerId(); },
    assets,
  };
}
```

Developer ergonomics:

```ts
// app boot
const auth = createOAuthAppAuth({ ... });
const epicenter = createEpicenterCloud({
  baseURL: 'https://api.epicenter.so',
  fetch: auth.fetch,
});
await epicenter.ready();   // resolve session once

// later
const { id, url } = await epicenter.assets.upload(file, {
  visibility: 'public',
});
yjsDoc.set(refId, { url, contentType: file.type, name: file.name });

// publish a previously-private asset
await epicenter.assets.setVisibility(id, 'public');

// unpublish
await epicenter.assets.setVisibility(id, 'private');

// delete
await epicenter.assets.delete(id);
```

## 3. Files changed

### Phase 1: Schema + migration

```text
packages/server/src/db/schema/app.ts
  add visibility column to asset table
  add asset_visibility_idx
apps/api/drizzle/0004_asset_visibility.sql
  generated by `bun db:generate` from apps/api
```

### Phase 2: Server routes

```text
packages/server/src/asset-routes.ts
  - bump nanoid alphabet length from 15 to 21
  - tighten route regex from {15} to {21}
  - rename createAssetPublicRoutes -> createAssetReadRoute
    (it's not "public" anymore; it's the conditional reader)
  - replace inline ownerId resolution from c.var.ownerId for the
    public-read path with reading c.req.param('ownerId') + lookup-
    by-id constrained on ownerId (attachOwner does NOT run for
    visibility=public reads, so c.var.ownerId is unset)
  - add PATCH /:assetId handler (visibility flip only for now)
  - upload accepts `visibility` form field; persists to row
  - response shape on upload + patch returns { id, visibility, ... }

packages/server/src/routes/assets.ts
  - update doc comments (no more "public read mounts first"; the
    handler is now visibility-aware regardless of mount order)
  - public-read sub-app mount removes (it's now the same sub-app)

packages/server/src/middleware/attach-owner.ts
  (unchanged)
```

### Phase 3: Deployment composition

```text
apps/api/src/index.ts
  - split assets middleware by HTTP method:
      * POST/PATCH/DELETE on /owners/:ownerId/assets and
        /owners/:ownerId/assets/*: requireCookieOrBearerUser,
        requireUrlOwnerIdMatchesAuth, attachOwner, autumnStorageGate
      * GET on /owners/:ownerId/assets (list) and /assets/usage:
        same chain (auth required)
      * GET on /owners/:ownerId/assets/:assetId: NO upstream auth;
        the library handler runs conditional auth itself.
```

### Phase 4: Client SDK

```text
packages/cloud-client/   (NEW PACKAGE; or land in existing client
                          package: see §4 decision)
  src/index.ts           createEpicenterCloud + assets surface
  src/types.ts           UploadResponse, AssetRow, etc.
  package.json           depends on @epicenter/auth (AuthFetch type),
                         no runtime dep on hono
  README.md              minimal usage example
```

## 4. Decisions log

```text
Decision                              Resolution
─────────────────────────────────────────────────────────────────────
Server-flagged visibility or          SERVER-FLAGGED. Single R2
key-in-fragment encryption?           object, real revocation,
                                       developer-layer encryption
                                       (if desired). Honest about
                                       server-trust posture.

Content-addressed (sha256) or         NANOID. "No double hosting"
random nanoid?                        is met by server-flagged
                                       visibility; content addressing
                                       would force refcounting (which
                                       conflicts with the "primitives
                                       only" stance).

PATCH or PUT for visibility flip?     PATCH. One field changes;
                                       partial update is canonical.
                                       PUT is reserved for future
                                       bytes-replace.

Will we support asset replacement?    NOT NOW. PUT verb is reserved;
                                       no API collision when added.

Nanoid entropy?                       21 chars (~108 bits). Up from
                                       15 (~77). Slack lesson;
                                       industry baseline.

Encryption at upload?                 DEVELOPER LAYER. The platform
                                       stores bytes. Apps that want
                                       client-side encryption do it
                                       themselves and store the key
                                       in their Yjs doc.

Public read auth model?               CAPABILITY URL. visibility
                                       === 'public' assets are
                                       readable by anyone with the
                                       URL. The 21-char nanoid IS
                                       the credential.

Default visibility?                   PRIVATE. Existing rows
                                       backfill private; new uploads
                                       without an explicit
                                       visibility default private.
                                       Apps that want public-by-
                                       default pass visibility on
                                       every upload.

Client SDK auth wiring?               COMPOSE on @epicenter/auth's
                                       AuthFetch. SDK does not own
                                       auth state; it consumes the
                                       authed fetch handle.

Client SDK ownerId resolution?        LAZY CACHE. First call fetches
                                       /api/session; ownerId is
                                       cached for sync URL building
                                       via assets.url(id). Apps can
                                       call epicenter.ready() at
                                       boot.

Client SDK package?                   TBD. Either new package
                                       @epicenter/cloud-client, or
                                       land inside an existing one.
                                       Author chooses at execution
                                       time; either works.

GC of orphaned assets?                APPLICATION RESPONSIBILITY.
                                       The platform exposes DELETE;
                                       it doesn't scan Yjs docs.
                                       R2 lifecycle rules can be
                                       set on a /tmp/ prefix later
                                       for failed-upload sweeps.

Cache strategy for public reads?      SHORT max-age (60s) + no
                                       active purge in v1. A flip
                                       from public to private becomes
                                       visible to new requests
                                       within ~60s; in-flight
                                       cached copies persist for
                                       that window. Apps needing
                                       hard revocation should not
                                       publish in the first place.
                                       Future: longer s-maxage +
                                       Cloudflare cache purge on
                                       PATCH.

Cache strategy for private reads?     'private, no-store'. No
                                       shared cache should ever
                                       hold a private asset.
```

## 5. Execution plan

### 5.1 Branch

`braden-w/asset-visibility` off main. Does not stack on owner-
partition work (already merged).

### 5.2 Sequencing

```text
Phase 1: schema + migration   (one commit)
  ↓ verify: bun db:generate; bun db:push:local; smoke test
Phase 2: server routes        (one commit)
  ↓ verify: bun --filter @epicenter/server typecheck + test
Phase 3: apps/api wiring      (one commit)
  ↓ verify: bun --filter @epicenter/api typecheck;
            manual: curl POST/GET/PATCH/DELETE against local
Phase 4: client SDK           (one commit)
  ↓ verify: bun --filter <sdk-pkg> typecheck;
            integration test in a sample app
```

### 5.3 Manual verification recipes

```bash
# Upload private
curl -X POST -H "Authorization: Bearer $T" \
  -F "file=@cat.png" -F "visibility=private" \
  http://localhost:8787/api/owners/$USER/assets

# Read as owner: 200
curl -H "Authorization: Bearer $T" \
  http://localhost:8787/api/owners/$USER/assets/$ID

# Read without auth: 401
curl http://localhost:8787/api/owners/$USER/assets/$ID

# Publish
curl -X PATCH -H "Authorization: Bearer $T" \
  -H "content-type: application/json" \
  -d '{"visibility":"public"}' \
  http://localhost:8787/api/owners/$USER/assets/$ID

# Read without auth: 200 now
curl http://localhost:8787/api/owners/$USER/assets/$ID

# Unpublish
curl -X PATCH -H "Authorization: Bearer $T" \
  -H "content-type: application/json" \
  -d '{"visibility":"private"}' \
  http://localhost:8787/api/owners/$USER/assets/$ID

# Read without auth again: 401
curl http://localhost:8787/api/owners/$USER/assets/$ID
```

## 6. Out of scope

- Asset bytes replacement (`PUT /assets/:id`). Reserved verb; not
  implemented.
- Asset rename (PATCH of `name`/`originalName`). Schema allows it;
  the PATCH handler this spec ships only accepts `visibility`.
- Pre-signed R2 upload URLs for files >5 MB. Today's proxied upload
  stays. Revisit at scale.
- Client-side encryption helpers in the SDK. Apps that want this
  encrypt before calling `epicenter.assets.upload` and store the
  key in their Yjs doc; the platform doesn't help.
- R2 lifecycle rules. Mentioned in decisions as a future lever;
  not configured here.
- GC of orphaned uploads (failed multipart, abandoned references).
  Cloudflare's 7-day default multipart abort covers the obvious
  case; explicit GC is application territory.
- Rate limiting on public reads. Today's Worker-level limits apply;
  asset-specific rate limits become a concern only at abuse scale.
- Signed URLs with expiry (Discord 2023 precedent). Documented as
  a future option; not built now.
- Metering of egress on public reads. The autumnStorageGate runs
  on POST/PATCH/DELETE only; viral public assets generate egress
  that is invisible to the owner's bill. Worker-level egress caps
  apply. Revisit if abuse appears.
- OwnerId is visible in public asset URLs
  (`/api/owners/:ownerId/assets/:assetId`). Apps that need
  anonymous publish must layer their own indirection (e.g., a
  proxy under their own domain).
- Multi-account-in-one-tab. The SDK caches `ownerId` on first
  resolve and never invalidates. Sign-out-then-sign-in-as-a-
  different-user in the same tab produces 403s on next call,
  not silent cross-owner writes. Add an `invalidate()` method or
  wire to an auth event when an app actually needs this.
- Hard revocation. PATCH visibility flips have a ~60s CDN cache
  lag (see section 4 cache strategy). Active purge on flip is a future
  optimization; not needed for v1.
