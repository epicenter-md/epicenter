# Server package split: @epicenter/server + apps/api

Status: in progress on `braden-w/buffalo`
Started: 2026-05-22
Last updated: 2026-05-23
Owner: braden
Supersedes: specs/20260522T120000-personal-vs-team-deployment-mode.md

## 0. How to read this spec

This spec describes a multi-wave refactor that lives on branch
`braden-w/buffalo`. The intent is one coherent design (sections 1 to 9,
plus 10 for the client-side companion). The execution happens in waves
so the diff stays reviewable. Section A at the end tracks which waves
have landed and which are still ahead.

If you want the design only, read sections 1 to 10 top to bottom and
stop. If you want to know what is actually in the worktree right now,
jump to section A.

The shorthand throughout:

```
Server side       packages/server  (the Hono sub-app factories)
Cloud deployment  apps/api          (composes the library + Autumn extras)
Client side       packages/auth, packages/workspace, packages/svelte-utils,
                  packages/cli, apps/whispering, apps/dashboard, etc.
```

A single shared vocabulary spans all three: `OwnerId`, `TEAM_OWNER_ID`,
`doName(ownerId, ...)`, and `assetKey(ownerId, ...)`. The next nine
sections define that vocabulary.

## 1. The punchline

> Personal mode and team mode are the same product. Personal mode
> **partitions data by user**. Team mode uses one shared owner partition.

The partition is the `owners/<ownerId>` path segment that appears in every
durable identifier. Personal deployments resolve `ownerId` to the signed-in
user's id, giving every user a separate partition. Team deployments resolve
`ownerId` to `TEAM_OWNER_ID` (the literal string `team`), giving every
admitted member the same partition.

Everything in this spec follows from that one sentence.

## 2. Goal

Split `apps/api/` into two layers:

```
packages/server/   the shared library; everything a self-hosted team needs.
apps/api/          Epicenter Cloud's deployment; thin composition on top of
                   @epicenter/server plus cloud-only additions (Autumn gates,
                   billing routes, dashboard SPA, admin endpoints).
```

Self-hosted team customers write their own `apps/server-team/` entrypoint
(roughly 15 lines) that imports `@epicenter/server`.

## 3. The OwnerId concept

`OwnerId` is the shared partition key across server, cloud, and every
client. The branded id and `TEAM_OWNER_ID` live in `@epicenter/constants`
so every package can key local storage, routes, R2 objects, Durable Object
names, and HKDF labels with the same value.

```ts
// packages/constants/src/identity.ts

export const OwnerId = type('string').as<string & Brand<'OwnerId'>>();
export type OwnerId = typeof OwnerId.infer;
export const asOwnerId = (value: string): OwnerId => value as OwnerId;

export const TEAM_OWNER_ID = asOwnerId('team');
```

```ts
// packages/server/src/owner.ts

import type { OwnerId } from '@epicenter/util';

export type RoomDoName = `owners/${string}/rooms/${string}`;
export type AssetR2Key = `owners/${string}/assets/${string}`;

export function doName(ownerId: OwnerId, roomId: string): RoomDoName {
  return `owners/${ownerId}/rooms/${roomId}`;
}

export function assetKey(ownerId: OwnerId, assetId: string): AssetR2Key {
  return `owners/${ownerId}/assets/${assetId}`;
}
```

One value (`ownerId`) produces the partition segment. Every durable string
is built by concatenating it with `owners/`, a resource type, and an id.
Team mode keeps the same shape as personal mode; it just resolves
`ownerId` to the shared `TEAM_OWNER_ID`.

**Why the split between auth and server.** Browser apps, the CLI, and the
workspace daemon all need to talk about Owners to render team-aware UI,
key local storage, and decide which signed-in account they are operating
as. None of them should depend on the Hono server library to do that.
`OwnerId` is a pure type and belongs with shared utilities. The derivations
that touch DO names and R2 keys are server-only and stay in
`@epicenter/server`.

## 4. Every durable string under one rule

```
RULE: `owners/<ownerId>/<resource type>/<id>`

                       personal (ownerId='abc')    team
DO name                owners/abc/rooms/xyz        owners/team/rooms/xyz
R2 object key          owners/abc/assets/xyz       owners/team/assets/xyz
HKDF info label        owner:abc                   owner:team
SQL filter             WHERE owner_id = 'abc'      WHERE owner_id = 'team'
URL path (under /api)  /api/owners/abc/...         /api/owners/team/...
```

The URL path is the durable identifier with an `/api` prefix. Reading the
URL tells you the owner partition directly. No magic mapping.

## 5. URL shape

```
                          Personal cloud                       Team
                          --------------------------------     -------------------------
Rooms WebSocket           WS   /api/owners/:ownerId/rooms/:r   WS   /api/owners/team/rooms/:r
                            ?deviceId=<id>                       ?deviceId=<id>

Asset upload              POST /api/owners/:ownerId/assets     POST /api/owners/team/assets
Asset list                GET  /api/owners/:ownerId/assets     GET  /api/owners/team/assets
Asset usage               GET  /api/owners/:ownerId/assets/usage GET /api/owners/team/assets/usage
Asset delete              DEL  /api/owners/:ownerId/assets/:a  DEL  /api/owners/team/assets/:a
Asset PUBLIC read         GET  /api/owners/:ownerId/assets/:a  GET  /api/owners/team/assets/:a

Session                   GET  /api/session                    GET  /api/session

Auth / UI                 /sign-in, /consent, /auth/*, /dashboard  (no owner route segment)
```

The public asset read carries the owner partition in the URL in both modes.
The ownerId is not a credential; the URL as a whole is. Anyone who can read
the URL already had the ownerId. This is the same capability-URL model as
today, plus an explicit path segment that lets the server compute the R2 key
without a DB lookup.

A safety middleware enforces "URL ownerId matches the resolved owner
partition" on authed routes so Bob cannot reach `/api/owners/alice/...`,
and non-members cannot reach `/api/owners/team/...`.

## 6. The DO attachment (both modes)

```ts
export type Connection = {
  userId: string;
  deviceId: string;
  connectedAt: number;
  actions: ActionManifest;
};
```

Each WebSocket connection carries a `(userId, deviceId)` pair plus the
upgrade timestamp and the device's published action manifest. The DO is
owner-blind; it tracks pairs and broadcasts presence with the `userId` so
clients can render names. In personal mode every connection to a given DO
shares the same `userId` (the DO name partitions by user). In team mode
connections have different `userId` values. Same code path either way.

`deviceId` identifies one Epicenter app on one persistent storage scope:
browser tabs sharing localStorage share an id; separate browsers, the
extension, Tauri windows, and the CLI daemon each get distinct ids. The
client generates and persists its own via `createDeviceId({ storage })`
(from `@epicenter/workspace`); lifespan is the client's concern. The
canonical brand `DeviceId` lives in `@epicenter/workspace`. We refused
the name `clientId` because Yjs already ships `clientID` (a number,
CRDT identifier) and Better Auth uses `clientId` for OAuth client ids;
"device" matches what `PresenceDevice` and the user-facing presence UI
already say.

## 7. /api/session response

```ts
{
  user: AuthUser,                   // who is signed in
  ownerId: OwnerId,                 // partition key
  keyring: Keyring,                 // crypto material
}
```

Flat top-level shape. The wire carries the resolved `ownerId`, not the
deployment's ownership rule. In personal mode, `ownerId === user.id`. In
team mode, `ownerId === TEAM_OWNER_ID`. Two self-hosted team deployments do
not collide on the client because the client keys by `${origin}` too.

The old `localIdentity.subject` field retires.

## 8. Why this asymmetry is the right one

```
Personal cloud has many users. They must NOT share data. Therefore every
durable identifier they touch must include their userId so two users
cannot collide. Hence the prefix.

Self-hosted team has one team. There is no second team in the same
deployment to disambiguate from. Therefore no prefix is needed.

The prefix is the partition. No partition, no prefix. End of asymmetry.
```

Cross-deployment isolation (two different team servers, two different
cloud deployments, etc.) is handled at the Cloudflare layer by
`(script_name, class_name)` Durable Object isolation, per-deployment R2
buckets, per-deployment Postgres, per-deployment KV. The server has
nothing to do here; it cannot reach another deployment's resources by
name.

## 9. Client-side companion: local Yjs prefix

The server design above only solves half the problem. Clients persist
Yjs documents in IndexedDB (browser, extension) and on disk (Tauri, CLI
daemon). Those local stores must partition the same way the server does
so that two signed-in accounts on the same machine cannot collide.

### 10.1 The legacy shape

Today's `packages/workspace/src/document/local-yjs-key.ts` builds:

```
epicenter.owner.<subject>.yjs.<ydoc.guid>
```

`<subject>` was the value of `localIdentity.subject` (the user id today).
That string carries two unearned segments and one missing one:

```
"epicenter." app namespace                EARNED (collides with other
                                          IDB consumers on the origin)
"owner."     decorative middle            NOT EARNED (zero partition info;
                                          the next segment IS the owner)
"<subject>." owner identity               EARNED, but stringly typed and
                                          named for the old Better-Auth
                                          vocabulary instead of the Owner
                                          shape
".yjs."      "this is yjs data"           NOT EARNED (y-indexeddb library
                                          prepends its own `yjs.` already;
                                          the live name in IndexedDB is
                                          `yjs.epicenter.owner.X.yjs.Y`,
                                          with TWO `yjs.` segments)

(missing)    server origin                FAILURE: two self-hosted team
                                          servers signed into the same
                                          browser produce the same
                                          `epicenter.owner.team.yjs.*`
                                          prefix and collide
```

### 10.2 The greenfield shape

```
epicenter/<server-origin>/owners/<ownerId>/<ydoc.guid>
```

`ownerId` is the signed-in user's id for personal owners and `TEAM_OWNER_ID`
for team deployments. The server origin still disambiguates two team
deployments on the same browser profile.

Examples:

```
Personal Alice on Epicenter Cloud:   epicenter/api.epicenter.so/owners/alice/<guid>
Personal Bob   on Epicenter Cloud:   epicenter/api.epicenter.so/owners/bob/<guid>
Team on Acme self-host:              epicenter/team.acme.com/owners/team/<guid>
Team on Beta self-host:              epicenter/team.beta.com/owners/team/<guid>
```

Y-indexeddb still prepends its own `yjs.` at the IndexedDB layer; the
live database name becomes `yjs.epicenter/api.epicenter.so/owners/alice/<guid>`.
Mixed `/` and `.` at the very front is the library's, not ours.

### 10.3 What this earns

```
Cross-server isolation                FIXED (was broken)
Cross-app isolation                   PRESERVED (epicenter/ prefix)
Cross-user isolation                  PRESERVED (owners/<id>/)
Cross-doc isolation                   PRESERVED (caller appends ydoc.guid)
Mirrors server's doName(ownerId, ...) NEW (same address shape on wire and disk)
Type-safe OwnerId input               NEW (OwnerId replaces stringly-typed subject)
Duplicate `.yjs.` segment             REMOVED
Decorative `.owner.` segment          REMOVED
```

### 10.4 New signatures

```ts
// packages/workspace/src/document/local-yjs-key.ts

import type { Owner } from '@epicenter/auth';

const APP = 'epicenter';

/**
 * Per-owner-per-server prefix for client-side persisted Yjs data on this
 * browser profile. Mirrors the server's `doName(ownerId, ...)` shape so the
 * same `(server, ownerId, doc)` tuple lands on the same address on the wire
 * and on disk.
 */
export function getOwnedYjsPrefix(server: string, ownerId: OwnerId): string {
  return `${APP}/${server}/owners/${ownerId}/`;
}

export function createOwnedYjsKey(
  server: string,
  ownerId: OwnerId,
  ydocGuid: string,
): string {
  return `${getOwnedYjsPrefix(server, ownerId)}${ydocGuid}`;
}
```

### 10.5 Caller updates

```
Touched files in packages/workspace/:

  document/local-yjs-key.ts          rewritten (signature change)
  document/local-yjs-key.test.ts     literal-shape assertions updated
  document/local-owner.ts            passes (server, owner) instead of ownerId
  document/attach-local-storage.ts   accepts server + owner, threads through
  document/attach-local-storage.test.ts  prefix assertions updated
  document/wipe-local-storage.ts     accepts server + owner

Touched files in packages/svelte-utils/:

  session.svelte.ts                  pass server + state.owner downstream
  session.svelte.test.ts             update test fixtures

Touched files in packages/auth-svelte/:                (none expected;
                                                       imports re-exported types)
```

The server origin comes from the auth session's source URL (the auth
client already knows the API origin it signs into; it is what
`authBaseURL` carries on the server side and what every client uses to
construct its `fetch` and WebSocket URLs).

### 10.6 What this breaks

```
Durable storage format               yes, every existing IndexedDB blob is
                                     orphaned. Greenfield assumption holds
                                     (no users in production with persisted
                                     encrypted Yjs blobs that need to
                                     migrate). Documented refusal.

Workspace-package signatures         getOwnedYjsPrefix(ownerId: string)
                                     -> getOwnedYjsPrefix(server, owner)
                                     Six callers in two packages.

Tests                                Two test files assert the literal
                                     `epicenter.owner.<x>.yjs.<y>` shape;
                                     both rewritten.
```

### 10.7 Trigger to revisit

If a future client needs to multiplex more than one server simultaneously
(e.g., a CLI that holds accounts on Cloud AND a team server), the design
already supports it: each prefix carries its own server origin segment.
No further change needed.

## 10. Library public API

The authoritative public surface is whatever `packages/server/src/index.ts`
re-exports. Read that file; do not maintain a prose snapshot here.

Earlier drafts of this section pinned a snapshot ("`createServer` returns
a bundle of sub-apps, `ServerOptions = { ownership, signUpPolicy }`, etc.").
That snapshot has rotted three times on this branch alone:

```
1. ApiSessionResponse shape           wave 2 reshuffle
2. Owner discriminated union          collapsed to branded OwnerId + OwnershipMode
3. createServer({...}) bundle         flattened to direct sub-app factories
```

Each rot was followed by silent drift between this section and the source.
The asymmetric move is to refuse the snapshot duty entirely: the source IS
the surface, and any prose copy will lie within a release cycle.

Design intent (which IS stable and belongs here):

- One factory per sub-app; each declares its full URL pattern internally.
- Deployments mount sub-apps on `createBaseApp()`, composing auth and
  billing middleware around each at mount time. No `ServerOptions` bundle
  pretending to configure all of them uniformly.
- Per-request owner partition is resolved by `createRequireOwnership(ownership)`
  middleware so handlers stay mode-blind.
- Internal derivations (`doName`, `assetKey`, etc.) stay
  inside their respective files because no external consumer needs them.

For the concrete shape at any point in time:
- `packages/server/src/index.ts`: public re-exports.
- `apps/api/src/index.ts`: cloud composition reading top-to-bottom.

## 11. Library internals: how mode dispatches

Design intent: the library has minimum mode-based branching. The
`OwnershipRule` value from `personal()` or `team({ isMember })` is read at
construction by the small set of factories that need ownership decisions
(for example `createAssetsApp` and `createRequireOwnership`). After route
registration, every handler reads the resolved `OwnerId` from
`c.var.ownerId` and stays mode-blind.

This invariant is the load-bearing one: any new feature should resolve to
an `OwnerId` once at the boundary and never re-branch on mode inside
handlers.

For the concrete dispatch shape at any point in time, read the actual
factory source under `packages/server/src/routes/`. Earlier drafts of
this section pinned an example; that example rotted under the same
factory-flattening refactors as §10's snapshot. The intent above is
stable; the code is the surface.

## 12. Deployment composition

Design intent: each deployment composes the public sub-apps onto
`createBaseApp()` top-to-bottom, layering its own middleware (auth,
billing, CSRF) around each sub-app at mount time. The base app owns
per-request lifecycle (pg, after-response queue, CORS); deployments own
which sub-apps are mounted and what middleware wraps them.

For the cloud composition, read `apps/api/src/index.ts` top to bottom:
that file is the canonical example and the entire cloud URL surface.
For a self-hosted team deployment, a sibling app directory would compose
the same sub-apps with team-mode middleware (no billing gates, no
admin/dashboard SPA). Earlier drafts of this section pinned both
compositions in prose; those snapshots rotted, but the intent above is
stable.

## 13. Package shape

Design intent:

- `packages/server/` is one library: a parent app (`createBaseApp`), sub-app
  factories (one file per route family), middleware (one file per check),
  and supporting subsystems (`auth/`, `room/`, `db/`, `auth-pages/`).
- Sub-apps declare full URL patterns internally; deployments mount each
  at the root. No `ServerOptions` bundle uniformly configuring all of them.
- `apps/api/` is the only deployment shipped in this repo. Cloud-only
  concerns (Autumn billing, admin routes, dashboard SPA) live there, not
  in the library.

The concrete file layout has moved enough times that mirroring it in
prose has rotted twice this branch. Read `packages/server/src/` and
`apps/api/src/` directly for the current shape.

## 14. Env reads, not opts

The library reads everything from `c.env` at request time. Cloud and team
each declare their own bindings in their own `wrangler.jsonc`; the library
does not see two configurations.

```
Read from c.env (NOT from opts):
  HYPERDRIVE                  postgres connection
  ROOM                        Durable Object namespace
  ASSETS_BUCKET               R2 bucket
  SESSION_KV                  KV for Better Auth secondary storage
  ENCRYPTION_SECRETS          HKDF root keyring
  BETTER_AUTH_SECRET          auth secret
  GOOGLE_CLIENT_ID / SECRET   OAuth provider
  OPENAI_API_KEY etc.         AI provider keys

Cloud-only env (read inside apps/api, NOT inside @epicenter/server):
  AUTUMN_SECRET_KEY
  ADMIN_USER_IDS
```

## 15. Sign-up policy

```ts
type SignUpPolicy = 'open' | 'disabled';
```

`'disabled'` mounts a Better Auth `before` hook on `/sign-up/email` (and
similar paths) that rejects every request. The deployment owner provisions
accounts out of band (via the Better Auth admin API or a CLI tool).

When invitation tokens are designed, `'invite-only'` becomes a third
value. Until that exists, the meaningful gradient is `open` or `disabled`.

## 16. Migration plan (one-shot clean break)

```
1. Create packages/server. Move from apps/api/src/:
     ai-chat*, asset-routes, auth/*, auth-pages, constants, db/schema
     (minus billing-only columns), is-websocket-upgrade, room/*,
     trusted-origins.
   DO NOT move: autumn, autumn.config.ts, billing-routes, billing-plans,
     reconcile handler, dashboard serving, ADMIN_USER_IDS gating.

2. Refactor moved code into sub-app factories:
     createBaseApp, createAuthApp, createSessionApp, createRoomsApp,
     createAssetsApp, createAiApp.
   Each receives the deployment ownership rule where needed; downstream
   handlers work in terms of the resolved OwnerId value.

3. Rewrite URLs to the owner-partition shape (section 5).
   Authed owner routes get the requireOwnership gate.

4. Replace installationId with deviceId everywhere
   (WebSocket query param, DO attachment, presence map).
   DO attachment becomes { userId, deviceId, connectedAt, actions }.
   The canonical brand `DeviceId` (`asDeviceId`, `createDeviceId`,
   `createDeviceIdAsync`) lives in `@epicenter/workspace`. The earlier
   draft proposed `clientId`; refused because `clientID` (number) is
   already the Yjs CRDT identifier and `clientId` (string) is Better
   Auth's OAuth client param.

5. Recreate apps/api/src/index.ts as the cloud composition (section 11.2).
   Cloud-only files live in apps/api/src/.

6. Update apps/api/wrangler.jsonc to point `main` at the new index.ts.

7. Tests split:
     packages/server/*.test.ts      library tests, no Autumn
     apps/api/*.test.ts             cloud tests, Autumn mocked

8. Delete apps/api/src/app.ts.

9. Update apps/dashboard, apps/whispering, apps/cli, anything that
   imports from apps/api/src/... to import from @epicenter/server.

10. Update client URL builders (workspace daemon, browser apps, CLI,
    extension) to use session.ownerId when constructing room and
    asset URLs. Replace any installationId usage with deviceId.
```

## 17. Tests

```
packages/server/
  owner.test.ts                doName and assetKey produce expected
                               `owners/<ownerId>/...` strings
  session.test.ts              /api/session returns user, ownerId, keyring
                               personal: ownerId == auth user id
                               team:     ownerId == TEAM_OWNER_ID
  rooms.test.ts                personal: requires URL ownerId == auth user id
                               team: requires URL ownerId == TEAM_OWNER_ID
                               WS upgrade carries deviceId
  assets.test.ts               personal: public read works without auth via
                               URL ownerId; authed routes require URL match
                               team: public read works without auth
                               provenance (asset.ownerId) recorded both modes
  signup-policy.test.ts        disabled rejects /sign-up/email
                               open allows
  scope-isolation.test.ts      personal: two ownerIds resolve to distinct DO
                               names, distinct R2 keys, distinct keyrings
                               team: every request resolves to the same
                               DO name and R2 key

apps/api/
  autumn-gates.test.ts         plan gate denies free tier on premium models
                               storage gate rejects when balance exhausted
  billing-routes.test.ts       portal redirect, plan status
  admin-routes.test.ts         ADMIN_USER_IDS gate; reconcile aggregation
  index.test.ts                composed app shape (mount points exist)
```

## 18. Non-goals

```
- No @epicenter/server-cloud package. apps/api is the only cloud-shaped
  consumer; one consumer = no package needed.
- No per-feature packages. auth/rooms/assets share singleCredential and
  the OAuth resource boundary.
- No runtime OwnerResolver function. The ownership rule is the deployment-
  level choice; per-request owner is resolved at the auth boundary.
- No mixed personal+team mode. A third OwnershipRule variant can be added
  later without touching handler logic.
- Invitation system (the data model behind invite-only): sibling spec.
- Sign-in page branding per team deployment: out of scope.
- Custom auth providers per team deployment: out of scope.
- Per-asset ACLs in either mode: owner-level visibility is the only knob.
- Versioned HKDF labels: greenfield; add a version when you rotate.
- Server-side teamId field: deployment IS the team. CF script_name is
  the cross-deployment boundary.
- Two factories (createPersonalServer / createTeamServer): one server
  library with `personal()` / `team({ isMember })` is the smaller surface.
- mountDefaults helper: each deployment mounts explicitly for visibility.
```

## 19. Open questions

```
1. Should the WebSocket URL place deviceId in the query string or in a
   subprotocol entry like `device.<deviceId>`? Query string is simpler
   and matches today's pattern; subprotocol is harder to log and slightly
   more secure. Defaulting to query string. (Landed: query string.)

2. The ownership middleware compares URL ownerId to the resolved owner
   partition. Confirm Better Auth's resolved user id matches the shape we put
   in URLs (no encoding mismatch, no case sensitivity).

3. /api/session in team mode returns `ownerId: TEAM_OWNER_ID`. The team
   partition is explicit, shared, and uses the same `owners/<ownerId>`
   shape as personal mode.

4. Should apps/server-team/wrangler.jsonc live in this monorepo as a
   template, or as a downstream example repo? Either works.

5. The Room DO attachment shape change from { installationId } to
   { userId, deviceId, connectedAt, actions } is a wire change; old
   clients and old DOs would not interoperate. Acceptable because
   greenfield. (Landed.)
```

## 20. Success criteria

```
1. Anyone can read apps/api/src/index.ts and apps/server-team/src/index.ts
   top-to-bottom and know exactly what URLs the server serves and what
   middleware runs on each.

2. The library's ownership branch is at the boundary that resolves
   `OwnerId`. After routes are mounted, handlers operate on the resolved
   owner partition uniformly.

3. Adding a hypothetical third ownership rule requires:
     - 1 new `OwnershipRule` variant
     - 1 new `resolveExpectedOwnerId` case
     - 0 changes to handler logic

4. The self-hosted team deployment has zero Autumn code in its dependency
   graph (verifiable via bundle inspection of apps/server-team's compiled
   Worker).

5. Test suite split:
     packages/server tests pass with no @autumn-js dependency installed.
     apps/api tests pass with Autumn mocked.

6. Every durable identifier in the codebase follows the rule:
     owners/<ownerId>/<resource type>/<id>
   where `ownerId` is the signed-in user's id in personal mode and
   `TEAM_OWNER_ID` in team mode. No code constructs durable strings inline;
   everything goes through the resource-specific owner helpers.
```

## 21. References

```
- Personal-vs-team deployment-mode spec (superseded):
  specs/20260522T120000-personal-vs-team-deployment-mode.md
- Workspace project layout (sibling spec):
  specs/20260522T220000-workspace-project-layout.md
- Hono sub-app composition idiom:
  honojs/hono deepwiki, route() and .use('*', mw) per-sub-app
- Cloudflare DO isolation by (script_name, class_name):
  cloudflare/cloudflare-docs deepwiki, Wrangler environments
- Better Auth before-hook for sign-up gating:
  better-auth/better-auth deepwiki, plugin hooks section
- libsignal HKDF label conventions:
  signalapp/libsignal source labels
- Current code (pre-split):
  apps/api/src/app.ts, apps/api/src/asset-routes.ts,
  apps/api/src/auth/encryption.ts, apps/api/src/auth/resource-boundary.ts,
  apps/api/src/room/backends/cloudflare/durable-object.ts
```

## A. Implementation status (waves)

This spec landed in three waves on branch `braden-w/buffalo`. Each wave is
intentionally small enough to review on its own but is part of the same
design described above. A reader picking up this branch should read the
status here first, then the sections it points at.

### Wave 1: server package split                        LANDED

What changed in code:

```
NEW   packages/server/                        @epicenter/server library
NEW   apps/api/src/index.ts                   cloud composition (~30 lines)
NEW   apps/api/src/autumn-gates.ts            ensurePlanId, autumnAiGate, autumnStorageGate
NEW   apps/api/src/admin-routes.ts            reconcile (admin-only)
MOVE  apps/api/src/{auth,room,db,...}         -> packages/server/src/
DEL   apps/api/src/app.ts                     replaced by index.ts
DEL   apps/api/src/ai-chat.ts                 replaced by library + autumnAiGate
DEL   apps/api/src/app.rooms.test.ts          will be rebuilt against new shape
```

Spec sections that describe Wave 1: 1, 2, 3 (server-side derivations
only), 4, 5, 6, 8, 10, 11, 12, 13, 14, 15, 16.

### Wave 2: session shape flatten                       LANDED

The deferred Task #5 from Wave 1, executed by a sibling agent on the
same branch. Removed `LocalIdentity` from the wire and from every
consumer; introduced `Owner` in `@epicenter/auth` as the shared
vocabulary.

```
MOVED Owner type:    @epicenter/server/src/owner.ts (Wave 1)
                     -> @epicenter/auth/src/owner.ts (Wave 2)
                     @epicenter/server now imports Owner from auth.

CHANGED wire shape:
  ApiSessionResponse  was: { user, localIdentity: { subject, keyring } }
                      now: { user, owner, keyring }
  PersistedAuth       was: { grant, localIdentity }
                      now: { grant, owner, keyring }

CHANGED AuthState:
  signed-in           was: { localIdentity }
                      now: { owner, keyring }
  reauth-required     same
```

Files touched in Wave 2:

```
packages/auth/src/owner.ts                NEW (Owner + ownerId)
packages/auth/src/auth-types.ts           flattened
packages/auth/src/auth-contract.ts        flattened
packages/auth/src/create-oauth-app-auth.ts cascaded
packages/auth/src/node/machine-auth.ts    cascaded
packages/svelte-utils/src/session.svelte.ts cascaded
packages/svelte-utils/src/account-popover/...svelte cascaded
plus tests
```

Spec sections that describe Wave 2: 3 (the auth/server split), 7
(`/api/session` actually returns the flat shape now).

### Wave 3: client local-Yjs prefix greenfield          AHEAD

What this wave does:

```
EDIT  packages/workspace/src/document/local-yjs-key.ts
      Signature: getOwnedYjsPrefix(ownerId: string)
              -> getOwnedYjsPrefix(server: string, ownerId: OwnerId)
      Shape:    epicenter.owner.<id>.yjs.
              -> epicenter/<server>/owners/<ownerId>/ (both modes)

EDIT  packages/workspace/src/document/local-owner.ts
      Pass (server, ownerId) instead of ownerId alone.

EDIT  packages/workspace/src/document/attach-local-storage.ts
      Accept server in options; pass (server, ownerId) down.

EDIT  packages/workspace/src/document/wipe-local-storage.ts
      Accept server in options; pass (server, ownerId) down.

EDIT  packages/workspace/src/document/local-yjs-key.test.ts
      Update literal-shape assertions.

EDIT  packages/workspace/src/document/attach-local-storage.test.ts
      Update prefix assertions.

EDIT  packages/svelte-utils/src/session.svelte.ts
      Thread the auth client's server origin into ownerId callers.
```

Spec section that describes Wave 3 in full: 9.

Trigger to start Wave 3: Wave 2 is fully landed and the whole monorepo
typechecks. Verify with:

```
bun install
bun run --filter '*' typecheck       (or per-package, see Wave 2 list above)
```

### Why three waves on one branch

Each wave is reviewable on its own diff:

```
Wave 1   isolates the cloud product from the library
Wave 2   makes the client speak the same Owner vocabulary as the server
Wave 3   makes local storage partition match server partition
```

All three converge on one sentence: every owner has their own isolated
data, identified by the same `(server, owner)` tuple on the wire and on
disk. The waves split the work along package boundaries so the diffs
stay readable, not because the design has phases.

### Documented refusals

```
Refused:  preserve the old `epicenter.owner.<subject>.yjs.` IndexedDB
          format and `LocalIdentity.subject` wire field
Reason:   greenfield; no users with persisted data we cannot ask to
          re-sync; the shape was muddied by a decorative `owner` segment
          and a duplicate `yjs.` segment that y-indexeddb adds itself
User loss: none under the greenfield assumption
Trigger to revisit: a real customer reports persisted data they cannot
          afford to re-sync
```

```
Refused:  add `LocalIdentity.subject` aliases for backwards compatibility
Reason:   the old field name was a holdover from Better-Auth's
          "subject" vocabulary; the new value carries Owner identity,
          not a Better-Auth subject. An alias would lie about the shape.
User loss: clients with pinned old @epicenter/auth versions stop
          compiling; they update along with the cascade
Trigger to revisit: never (clean break by design)
```


## Wave 4 (proposed): name the bag `session`, add `user`, refuse the facade

Status: drafted, queued. Not yet executed.
Supersedes: an earlier draft of wave 4 that proposed a `LocalWorkspace`
            method-bag facade on `auth.state`. The facade was wrong on
            principle: it is a layer that delegates. See "Refused
            alternatives" below.

### The single sentence

> When you are signed in, you have a Session. Session is a named bundle
> of three values (user, owner, keyring). Apps consume those values
> directly through free primitives. There is no facade between them and
> the workspace.

### Context: why the facade is wrong

The fuji branch (`braden-w/examples-fuji-test-improvements`) deleted the
`LocalOwner` facade for the right reason: apps were calling
`signedIn.owner.attachEncryption(ydoc)` which immediately delegated to
`attachEncryption(ydoc, { keyring })`. The mediator earned nothing. The
fuji refactor moved every browser app to:

```ts
const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
const tables = encryption.attachTables(fujiTables);
const idb = attachLocalStorage(ydoc, signedIn);
const collab = openCollaboration(ydoc, { auth: signedIn.auth, ... });
```

Every line at the call site does real work. No facade hiding combinations.

A `LocalWorkspace` facade on `auth.state` would re-create exactly what
fuji deleted, just one layer further up. Wrong direction.

### What actually changes on the client surface

Two changes only. Both are slim renames; the data is the same.

```ts
// @epicenter/auth

type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in';       session: Session }   // wraps the bag
  | { status: 'reauth-required'; session: Session };

type Session = {
  user: AuthUser;            // NEW on auth state (apps want it for UI
                             // without re-hitting /api/session)
  ownerId: OwnerId;
  keyring: Keyring;
};

type PersistedAuth = {
  grant: OAuthTokenGrant;
  session: Session;          // wrapped to match the runtime shape
};

type ApiSessionResponse = Session;  // /api/session returns Session directly
```

That is the whole client-side delta.

### What dies, what stays

```
DIES
  auth.state.signed-in.owner               flat field
  auth.state.signed-in.keyring             flat field
  ApiSessionResponse.user / .owner / .keyring as separate top-level keys
    (still present, but wrapped under Session)

STAYS (because fuji's free-primitive direction is correct)
  attachEncryption, attachLocalStorage, wipeLocalStorage as free functions
  openCollaboration(ydoc, { auth, ... }) owning auth and reconnect
  Apps composing primitives inline in open<App>Browser / open<App>Daemon
  No LocalOwner / LocalWorkspace facade anywhere

ADDED
  user on the persisted cell and on auth.state (single source of truth
  for "who is signed in" without a network round-trip)
```

### Wire change

```
ApiSessionResponse before (current buffalo):
  { user, owner, keyring }

ApiSessionResponse after:
  { user, owner, keyring }   /* same fields, now reflected in `Session`
                                schema and matched 1:1 by AuthState */

PersistedAuth before:
  { grant, owner, keyring }

PersistedAuth after:
  { grant, session: { user, owner, keyring } }
```

The wire is essentially the same; the client groups the auth-bound
trio under a `session` name and persists `user` alongside.

### Cycle: not broken in this wave

The earlier draft proposed breaking workspace's dependency on auth so
auth could name `LocalWorkspace`. Since we are not adding a workspace
facade to auth state, the cycle does not need to break. Workspace
keeps depending on auth for `AuthClient` (consumed by openCollaboration);
auth has no need to import anything from workspace.

If a future wave wants to invert this (e.g., move openCollaboration's
auth dependency to a capability function pair), it can. This wave does
not require it.

### Migration scope

```
@epicenter/auth
  auth-types.ts        Session schema (arktype) replacing the three flat
                       fields on ApiSessionResponse and PersistedAuth.
                       user added.
  auth-contract.ts     AuthState carries session instead of (owner, keyring).
  create-oauth-app-auth.ts
                       Use session shape in persistedAuth, AuthState,
                       comparison helpers, refresh paths.

@epicenter/server
  routes/session.ts    Return Session shape directly (already returns
                       { user, owner, keyring }; just satisfy the new
                       arktype).

@epicenter/svelte-utils
  session.svelte.ts    Read state.signed-in.session.{user,owner,keyring}
                       (was state.owner / .keyring).
  account-popover      Same.

apps/*
  open<App>Browser     Receive SignedIn = Session & { auth: AuthClient }.
                       Read signedIn.owner / .keyring / .user.

  open<App>Daemon /    Already passed AuthClient via DaemonWorkspaceContext
  daemon ctx           (fuji branch); add session-shaped fields if any
                       daemon wants user info.

packages/cli, apps/dashboard, apps/whispering
                       Mechanical cascade for any place that reads
                       state.owner / state.keyring directly.
```

### Refused alternatives

```
Refused:  LocalWorkspace facade on auth.state (the earlier wave 4 draft)
Reason:   re-creates exactly the kind of decorative mediator fuji
          deleted. apps composing primitives inline IS the design;
          a facade undoes that.

Refused:  expose signedIn.workspace.keyring() callback
Reason:   not needed. apps call `attachEncryption(ydoc, { keyring })`
          with `signedIn.keyring` directly. No additional indirection.

Refused:  break workspace -> auth dependency
Reason:   only required for the LocalWorkspace facade we are no longer
          adding. Without that, openCollaboration's `auth: AuthClient`
          is honest.

Refused:  flatten Session into auth.state directly (no `.session` bag)
Reason:   the bag has a name and a domain meaning ("the auth-bound bundle
          that is restored on reauth-required"). Naming it earns its
          keep; future fields like `verifiedAt` or `expiresAt` would
          live there.
```

### Success criteria

```
1. ApiSessionResponse, PersistedAuth, AuthState all expose `session` as
   the auth-bound bundle. `user`, `owner`, `keyring` exist exactly under
   `session.*`.

2. Apps' open<App>Browser receive `SignedIn = Session & { auth }` and
   pass `signedIn.keyring` to attachEncryption, `signedIn` to
   attachLocalStorage, `signedIn.auth` to openCollaboration. No facade.

3. `auth.state.signed-in.user` is readable without a network call.
   account-popover, sign-in banners, and any "you are signed in as X"
   surface can render from cache.

4. LocalOwner / LocalWorkspace does NOT exist anywhere. The encryption
   boundary is exactly the free primitives.

5. Adding a hypothetical third ownership rule requires:
     - 1 new variant on OwnershipRule
     - 0 changes to Session
     - 0 changes to apps
```

### Notes on integrating with the fuji branch

This wave's scope reduces dramatically because the fuji branch already
landed the free-primitive direction. The integration sequence is:

```
1. Rebase fuji onto buffalo. Conflict resolution philosophy:
     - fuji wins at the encryption boundary (free primitives, no facade)
     - buffalo wins on the data vocabulary (Owner replaces subject)
     - server-scoping from buffalo wave 3 moves INSIDE
       attachLocalStorage / wipeLocalStorage where it belongs

2. After rebase, the wave 4 changes are a small follow-up commit:
     - rename auth.state.signed-in fields under `session`
     - add `user` to Session and PersistedAuth
     - cascade through the same client files wave 2 and wave 3 touched
```
