# Server-Default-Workspace Route: Stop Resolving Workspace IDs On The Client

**Date**: 2026-05-21
**Status**: Implemented on `redesign/server-owned-presence` (see amendment below)
**Author**: AI-assisted (with adversarial review)
**Branch**: `redesign/server-owned-presence`
**Builds on**: server-owned-presence (recommended to land first, but the two are orthogonal)

> **Superseded, 2026-05-22:** The `/me/apps/:appId/docs/:docId` route this spec adds, along with server-resolved personal-workspace provisioning, was reverted by `specs/20260522T160000-revert-cloud-workspace-sync-layer.md`. A cloud document is now owned by `subject:${userId}` and synced through the single route `/rooms/:room` via `roomWsUrl`. Read this spec as historical context only.

## Post-implementation amendment (2026-05-21)

Goal 5 and Appendix B planned to **preserve** the `/workspaces/:workspaceId/...`
route family "for the daemon and a future workspace-switching UI". That
rationale was wrong: the daemon syncs through `/rooms/:room` via `roomWsUrl`,
not the explicit-workspace route. Once `cloud-app-sync.ts` was deleted, the
explicit route had zero clients, so it was removed along with
`resolveWorkspaceSyncDocRoute`, the client `workspaceAppDocWsUrl` builder, and
`app.workspaces.test.ts`. `resolveAuthorizedWorkspaceSyncDoc` stays as the
shared resolver the `/me/...` path delegates to. Re-add the explicit route
family if a workspace-switching UI ever needs to name a workspaceId.

## One sentence

The relay resolves "this user's default workspace" from the auth token; the client deletes `cloud-app-sync.ts` and its deferred-collaboration wrapper because the URL stops needing a workspaceId.

## TL;DR

```
Today                                          After

client                                         client
  GET /api/workspaces -> defaultWorkspaceId       (no client-side lookup)
  build URL with embedded workspaceId             build URL from (apiUrl, appId, docId)
  wrap openCollaboration in a deferred shell      call openCollaboration directly
  mirror status / dispatch / devices / etc.       (shell deleted)
  subscribe to auth, reconnect on transitions     subscribe to auth, reconnect on transitions
                                                  (same listener, no factory wrapping it)

server                                         server
  /workspaces/:workspaceId/apps/:appId/docs/:docId  (kept for explicit-workspace cases)
                                                  /me/apps/:appId/docs/:docId  (new)
  membership check from URL param                 membership check from server-resolved id
  PersonalWorkspaceMissing as 409 on              PersonalWorkspaceMissing as 4401 WS close
  /api/workspaces                                 with { code: 'no_default_workspace' }
```

Net: ~700 lines deleted on the client, ~100 added on the server, one entire client-side state machine removed, the deferred-collaboration mirror disappears.

## Problem

`openCollaboration` requires `url: string` synchronously. The Cloud URL embeds workspaceId, which requires `GET /api/workspaces` to obtain. Apps construct workspace bundles synchronously at boot. These three facts force a wrapper that:

1. Returns a `Collaboration<TActions>` synchronously
2. Resolves workspaceId asynchronously
3. Attaches the real `openCollaboration` once a URL is buildable
4. Mirrors every method on `Collaboration` so the deferred handle is indistinguishable from a real one
5. Survives sign-out and re-attaches on sign-in

That wrapper lives in `packages/workspace/src/document/cloud-app-sync.ts:165-296` as `attachDeferredCollaboration`. It mirrors `status`, `whenConnected`, `whenDisposed`, `onStatusChange`, `reconnect`, `devices`, `dispatch`, and `[Symbol.dispose]` from `Collaboration`. Every method has an "attached" branch and a "not yet attached" branch. The wrapper is shaped exactly like a state machine that should belong to the supervisor, but the supervisor cannot own it because it cannot produce its own URL.

The root cause is one design choice: **the client embeds workspaceId in the URL.** Once that assumption is refused, the entire wrapper has no reason to exist.

### What this costs us today

```
Concern                                         Lives in
─────────────────────────────────────────────  ─────────────────────────────────
deferred Collaboration mirror                   cloud-app-sync.ts:165-296
factory closure over auth/apiUrl/appId          cloud-app-sync.ts:47-150
/api/workspaces fetch + null-handling           cloud-app-sync.ts:68-86
auth.onStateChange resubscription wiring        cloud-app-sync.ts:88-96
double action-key validation                    cloud-app-sync.ts:174-180
  (already runs in open-collaboration.ts:127)
workspaceAppDocWsUrl(apiUrl, { workspaceId,     transport.ts:26-40
  appId, docId })
test scaffolding for all of the above           cloud-app-sync.test.ts (~430 lines)
the "PersonalWorkspaceMissing" UI distinction   apps/* would surface lookupFailure
  (deleted in the in-flight diff, but the         (already collapsed in the in-flight
   underlying 409 path remains)                    cleanup)
```

## Goals

1. **Delete the client-side workspaceId lookup.** `/api/workspaces` is no longer on the cloud-sync critical path. The endpoint can stay for workspace-switching UIs that genuinely need a list of workspaces; the sync path stops consulting it.
2. **Add a server route that resolves the default workspace internally.** `/me/apps/:appId/docs/:docId` and its POST/dispatch siblings. The route looks up the user's default workspace from the auth token and dispatches to the same `AuthorizedWorkspaceSyncDoc` machinery the explicit-workspace route already uses.
3. **Delete `attachDeferredCollaboration`.** Apps call `openCollaboration` directly with a static URL.
4. **Preserve `openCollaboration`'s `url: string` signature.** No widening to `string | (() => Promise<string | null>)`. The asymmetric win here is refusing the assumption that forced the deferred wrapper, not absorbing the wrapper into the primitive.
5. **Preserve the existing `/workspaces/:workspaceId/...` routes.** Useful for workspace-switching, multi-workspace flows, and the daemon path. New route is additive.

## Non-goals

- **Multi-workspace UI changes.** Workspace switching, workspace listing, member management: out of scope. The `/api/workspaces` endpoint and its consumers remain.
- **Daemon path changes.** The daemon knows its workspaceId from config and uses the explicit-workspace route. Leave it.
- **Token claim audit.** This spec assumes the auth token identifies the user, and the user has at most one default workspace. Those invariants already exist in `apps/api/src/cloud-workspaces.ts`. Do not redesign.
- **Widening `openCollaboration.url`.** Considered and rejected (see Decisions Log).
- **Changing `Collaboration`'s public shape.** Same surface, same semantics, same consumers.

## Design

### Wire surface

Three new HTTP routes mirror the explicit-workspace ones. Same handlers, same DO machinery; only the workspaceId source differs.

```
GET  /me/apps/:appId/docs/:docId            (WS upgrade + HTTP snapshot)
POST /me/apps/:appId/docs/:docId            (HTTP sync)
POST /me/apps/:appId/docs/:docId/dispatch   (dispatch endpoint)
```

`/me` is the conventional "current authenticated user" prefix. The route handler resolves the user's default workspace internally and forwards to the existing `AuthorizedWorkspaceSyncDoc` resolution flow.

### Server changes (`apps/api/src/`)

**Add `resolveAuthorizedDefaultWorkspaceSyncDoc` in `workspace-sync-doc.ts`:**

```ts
type ResolveAuthorizedDefaultWorkspaceSyncDocInput = {
    user: AuthUser;
    appId: string | undefined;
    docId: string | undefined;
    getDefaultWorkspaceForUser: (params: {
        userId: string;
    }) => Promise<string | null>;
    checkWorkspaceMembership: (params: {
        userId: string;
        workspaceId: string;
    }) => Promise<boolean>;
};

type ResolveAuthorizedDefaultWorkspaceSyncDocResult =
    | { data: AuthorizedWorkspaceSyncDoc; error?: never }
    | {
            data?: never;
            error: {
                name:
                    | 'InvalidWorkspaceSyncDoc'
                    | 'WorkspaceForbidden'
                    | 'PersonalWorkspaceMissing';
                message: string;
                status: 400 | 403 | 409;
            };
      };

export async function resolveAuthorizedDefaultWorkspaceSyncDoc(
    input: ResolveAuthorizedDefaultWorkspaceSyncDocInput,
): Promise<ResolveAuthorizedDefaultWorkspaceSyncDocResult> {
    const workspaceId = await input.getDefaultWorkspaceForUser({
        userId: input.user.id,
    });
    if (workspaceId == null) {
        return {
            error: {
                name: 'PersonalWorkspaceMissing',
                message: "User has no default workspace",
                status: 409,
            },
        };
    }
    return resolveAuthorizedWorkspaceSyncDoc({ ...input, workspaceId });
}
```

The existing `resolveAuthorizedWorkspaceSyncDoc` is unchanged. The new resolver is a thin lookup-then-delegate.

**Add the route handlers in `app.ts`:**

The three new routes mirror the existing `/workspaces/:workspaceId/apps/:appId/docs/:docId` handlers structurally. Extract the post-resolution body into a shared helper so the duplication is one resolver call deep:

```ts
async function resolveDefaultWorkspaceSyncDocRoute(
    c: Context<Env>,
): Promise<
    | { data: AuthorizedWorkspaceSyncDoc; response?: never }
    | { data?: never; response: Response }
> {
    const result = await resolveAuthorizedDefaultWorkspaceSyncDoc({
        user: c.var.user,
        appId: c.req.param('appId'),
        docId: c.req.param('docId'),
        getDefaultWorkspaceForUser: async ({ userId }) => {
            // The default workspace is the personal workspace this user owns.
            // The same query that backs /api/workspaces.
            const [row] = await c.var.db
                .select({ id: schema.organization.id })
                .from(schema.organization)
                .innerJoin(
                    schema.member,
                    eq(schema.member.organizationId, schema.organization.id),
                )
                .where(
                    and(
                        eq(schema.member.userId, userId),
                        eq(schema.organization.metadata, /* personal marker */),
                    ),
                )
                .limit(1);
            return row?.id ?? null;
        },
        checkWorkspaceMembership: async ({ userId, workspaceId }) => {
            // Reuse the existing implementation; the default workspace is
            // trivially a member of itself, but keep one code path so the
            // membership invariant is enforced everywhere.
            // ... same body as resolveWorkspaceSyncDocRoute
        },
    });

    if (result.error) {
        return {
            response: c.json(
                { name: result.error.name, message: result.error.message },
                result.error.status,
            ),
        };
    }
    return { data: result.data };
}
```

Then register three routes (`GET`, `POST`, `POST .../dispatch`) that call `resolveDefaultWorkspaceSyncDocRoute` instead of `resolveWorkspaceSyncDocRoute`. The post-resolve bodies (`upsertDoInstance`, `rooms.handleWebSocket`, `sync.handleHttpSync`) are identical. Implementer chooses whether to extract a shared helper or duplicate; six lines duplicated three times is acceptable.

Mount the new routes under the same auth middleware as the explicit-workspace ones:

```ts
app.use('/me/*', requireOriginForCookieMutations);
app.use('/me/*', requireCookieOrBearerUser);
```

**Permanent close for 409 PersonalWorkspaceMissing:**

The WebSocket upgrade handler must reject with a permanent-failure signal the supervisor can recognize. Two options:

- **A.** Refuse the WebSocket upgrade (return 409 before `rooms.handleWebSocket`). Browser sees a normal WebSocket open failure; supervisor retries with backoff indefinitely. **Wrong**: this is supposed to be a permanent failure.
- **B.** Accept the upgrade, then close with code 4401 and reason `JSON.stringify({ code: 'no_default_workspace' })`. The supervisor's `parsePermanentFailure` (`sync-supervisor.ts:160-179`) already parses this shape; the supervisor parks in `failed` with `reason.code === 'no_default_workspace'`. Apps can read `status.reason.code` to render UI.

**Choose B.** This is the only option that reuses existing supervisor machinery.

For HTTP routes (POST sync, POST dispatch), 409 with a JSON body is correct; the supervisor never sees those.

### Client changes (`packages/workspace/src/document/`)

**Delete `cloud-app-sync.ts` entirely.**

**Delete `cloud-app-sync.test.ts` entirely.**

**Update `transport.ts`:**

Drop the `workspaceId` parameter from `workspaceAppDocWsUrl` and rename for clarity. Add a sibling that takes `workspaceId` for explicit-workspace consumers (daemon).

```ts
/**
 * Build the WebSocket URL for the authenticated user's default-workspace
 * app document. The server resolves which workspaceId to use from the auth
 * token; the client never names one.
 */
export function defaultWorkspaceAppDocWsUrl(
    apiUrl: string,
    params: { appId: string; docId: string },
): string {
    const base = apiUrl.replace(/\/+$/, '');
    return websocketUrl(
        `${base}/me/apps/${encodeURIComponent(params.appId)}` +
            `/docs/${encodeURIComponent(params.docId)}`,
    );
}

/**
 * Build the WebSocket URL for an explicit-workspace app document. Used by
 * daemons and any caller that already owns a workspaceId.
 */
export function workspaceAppDocWsUrl(
    apiUrl: string,
    params: { workspaceId: string; appId: string; docId: string },
): string {
    // unchanged
}
```

**Update `packages/workspace/src/index.ts`:**

Drop the re-exports for `cloud-app-sync.ts` (`cloudWorkspaceSync` / `openCloudAppSync`, `resolveDefaultCloudWorkspaceId`, `CloudAppSync`, `DefaultCloudWorkspaceAuth`, any `lookupFailure` types still present). Export `defaultWorkspaceAppDocWsUrl` alongside `workspaceAppDocWsUrl`.

### App-level changes

Four consumers of `openCloudAppSync` exist today (confirmed by grep `2026-05-21`):

```
apps/fuji/src/lib/browser.ts
apps/honeycrisp/browser.ts
apps/opensidian/src/lib/opensidian/browser.ts
apps/tab-manager/src/lib/session.svelte.ts
```

Each drops the factory, calls `openCollaboration` directly, and adds a small `auth.onStateChange` listener.

```ts
// apps/honeycrisp/browser.ts (after)
export function openHoneycrispBrowser({ owner, installationId, auth }) {
    const workspace = openHoneycrispWorkspace(owner.attachEncryption);
    const { ydoc: rootYdoc, tables, kv } = workspace;
    const idb = owner.attachLocal(rootYdoc);

    const collaboration = openCollaboration(rootYdoc, {
        url: defaultWorkspaceAppDocWsUrl(APP_URLS.API, {
            appId: 'honeycrisp',
            docId: 'root',
        }),
        openWebSocket: auth.openWebSocket,
        waitFor: idb.whenLoaded,
        installationId,
        actions: workspace.actions,
    });

    const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
        const ydoc = new Y.Doc({ guid: workspace.noteBodyDocGuid(noteId), gc: true });
        const body = attachRichText(ydoc);
        const childIdb = owner.attachLocal(ydoc);
        const sync = openCollaboration(ydoc, {
            url: defaultWorkspaceAppDocWsUrl(APP_URLS.API, {
                appId: 'honeycrisp',
                docId: workspace.noteBodyDocGuid(noteId),
            }),
            openWebSocket: auth.openWebSocket,
            waitFor: childIdb.whenLoaded,
            installationId,
            actions: {},
        });
        onLocalUpdate(ydoc, () => {
            tables.notes.update(noteId, { updatedAt: DateTimeString.now() });
        });
        return {
            ydoc, body, idb: childIdb, sync,
            [Symbol.dispose]() { ydoc.destroy(); },
        };
    });

    // Auth transitions: tell live sockets to retry.
    // Sign-in -> a previously-rejected socket reconnects with the new token.
    // Sign-out -> the server closes the existing socket on its own (4401);
    //   reconnect() ensures the supervisor doesn't sit in 'failed' if the
    //   user signs back in.
    const unsubscribeAuth = auth.onStateChange(() => {
        collaboration.reconnect();
        for (const child of noteBodyDocs.values()) {
            child.sync.reconnect();
        }
    });

    return {
        ydoc: rootYdoc, tables, kv,
        batch: workspace.batch,
        idb, noteBodyDocs, collaboration,
        async wipe() { /* unchanged */ },
        [Symbol.dispose]() {
            unsubscribeAuth();
            noteBodyDocs[Symbol.dispose]();
            rootYdoc.destroy();
        },
    };
}
```

Three apps, same pattern. `createDisposableCache` needs `.values()` iteration if it does not have it already; verify during implementation.

### What about Tab Manager?

`apps/tab-manager/` does not consume `openCollaboration` directly today (grep returns zero hits on `openCollaboration`, `cloudWorkspaceSync`, `resolveDefaultCloudWorkspaceId`, `workspaceAppDocWsUrl`). The Tab Manager path is unaffected. If a future Tab Manager surface needs cloud sync, it uses the same `defaultWorkspaceAppDocWsUrl` pattern.

## What we are paying

```
deletions (client):
  cloud-app-sync.ts                          ~280 lines
  cloud-app-sync.test.ts                     ~430 lines
  index.ts re-exports                        ~10 lines
  workspaceAppDocWsUrl workspaceId param +    ~30 lines
    its tests (or just its tests if you keep
    the function for daemon use)
  client total                               ~750 deleted

additions (server):
  workspace-sync-doc.ts:
    resolveAuthorizedDefaultWorkspaceSyncDoc  ~30 lines
  app.ts:
    resolveDefaultWorkspaceSyncDocRoute       ~35 lines
    three new route handlers                  ~60 lines
    middleware mounts                         ~2 lines
  workspace-sync-doc.test.ts: new resolver    ~40 lines
  app.workspaces.test.ts: new route paths     ~60 lines
  server total                                ~230 added

additions (client):
  3x browser.ts inline auth.onStateChange     ~15 lines
  defaultWorkspaceAppDocWsUrl + tests         ~30 lines
  client additions                            ~45 added

net: ~475 lines deleted of source + ~430 lines deleted of test
     ~140 lines added of source + ~100 lines added of test
     Approximate net delete: ~665 lines
```

The line count is not the prize. The deletion of `attachDeferredCollaboration` and its mirror is.

## Sequence diagrams

### App startup, signed-in user

```
browser bundle      openCollaboration       sync-supervisor       relay
─────────────      ─────────────────       ───────────────       ─────

construct
collaboration ──▶  return Collaboration
                   handle (sync)
                          │
                          ▼
                   supervisor loop
                   parks until waitFor
                   (idb.whenLoaded)
                          │
                   waitFor resolves
                          │
                          ▼
                   attemptConnection ────────────▶ accept upgrade
                                                    server resolves
                                                    user.defaultWorkspace
                                                    from auth token
                                                    ◀────── snapshot
                          status: 'connecting'
                                                    ◀────── presence_snapshot
                                                            (from presence spec)
                          status: 'connected'
```

### App startup, signed-out user

```
browser bundle      openCollaboration       sync-supervisor       relay
─────────────      ─────────────────       ───────────────       ─────

construct
collaboration ──▶  return Collaboration
                   handle (sync)
                          │
                   waitFor resolves
                          │
                          ▼
                   attemptConnection ────────────▶ no auth -> close 4401
                                                    { code: 'auth_required' }
                          status: 'failed' (auth-rejected)
                          park in failed state
```

(or: client-side `auth.openWebSocket` refuses to open if `auth.state.status !== 'signed-in'`, depending on how the auth package is structured. Behavior matches today.)

### Sign-in after construction

```
browser bundle               supervisor (was parked in 'failed')   relay
─────────────                ─────────────────────────────         ─────

auth.onStateChange fires
collaboration.reconnect() ──▶ wake cycle controller
                              attemptConnection ────────────────▶ accept upgrade
                                                                  resolves default workspace
                                                                  ◀────── snapshot
                              status: 'connected'
```

### Sign-in, but user has no default workspace

```
browser bundle               supervisor                            relay
─────────────                ──────────                            ─────

reconnect()  ──────────────▶ attemptConnection ────────────────▶ resolve default -> null
                                                                  close 4401
                                                                  { code: 'no_default_workspace' }
                             status: 'failed'
                             reason.code === 'no_default_workspace'
                             park
```

UI reads `collaboration.status.reason?.code` to render "your account has no workspace" instead of "connecting..."

## Composition with `server-owned-presence`

The two specs are orthogonal. They touch disjoint files and disjoint phases of the request lifecycle.

### File-by-file overlap

```
File                                          Presence      Default-route   Conflict?
──────────────────────────────────────────── ────────────  ─────────────   ────────
apps/api/src/room.ts                          heavy edit    none            no
apps/api/src/sync-handlers.ts                 heavy edit    none            no
apps/api/src/workspace-sync-doc.ts            none          add             no
apps/api/src/app.ts                           none          add 3 routes    no
packages/workspace/.../open-collaboration.ts  heavy edit    none            no
packages/workspace/.../dispatch.ts            edit          none            no
packages/workspace/.../presence.ts (new)      adds          n/a             no
packages/workspace/.../sync-supervisor.ts     none          none            no
packages/workspace/.../cloud-app-sync.ts      none          DELETE          no
packages/workspace/.../transport.ts           none          edit            no
packages/workspace/.../index.ts               none          edit            no
packages/workspace/.../run-handler.ts         edit          none            no
apps/*/browser.ts                             "no change"   heavy edit      no*
```

\* The presence spec explicitly notes `apps/*/browser.ts: no change (uses Collaboration.devices)`. This spec heavily edits browser.ts but does not touch `Collaboration.devices`. Both claims hold under both orderings.

### Conceptual boundary

```
This spec changes:    how the CLIENT decides which connection to open (URL routing)
Presence spec changes: how the SERVER publishes who's here within a connection

Boundary:              the openCollaboration interface, which both specs preserve
```

`openCollaboration({ url, ... })` is the contract. This spec changes the URL the supervisor opens. Presence spec changes what `onTextFrame` does inside `openCollaboration` and where `devices.list()` reads from. They meet at the interface and pass through each other.

### Ordering

**Recommended: presence spec first, then this spec.** Reasons:

1. Presence spec is queued up and intended to ship soon.
2. Presence spec is the bigger surgery (rewires `room.ts`, `open-collaboration.ts`, `sync-handlers.ts`). This spec's changes (route addition, file deletion) sit cleanly on top of either codebase state.
3. After presence lands, this spec's browser.ts edits leave `Collaboration.devices` reading from the presence tracker; switching from the deferred wrapper to direct `openCollaboration` preserves that behavior trivially.

Both orderings work. The reverse order (this spec first, presence second) is also clean. **Do not interleave commits between the two specs.** Each lands as its own PR sequence.

### Shared touch-points

Two JSDoc paragraphs that both specs mention but in different sentences. Update during whichever spec lands the relevant change:

- `packages/workspace/src/document/open-collaboration.ts` header (lines 1-24): presence spec rewrites the "per-peer liveness via awareness" paragraph. This spec does not touch that header.
- `packages/workspace/src/index.ts` header (lines 1-90): presence spec updates the liveness paragraph; this spec updates the cloud-sync paragraph. Independent sentences in the same file.

No merge conflict expected for either touch-point.

### What this spec assumes about presence

Nothing implementation-specific. This spec assumes:

- `Collaboration.devices.list()` and `.subscribe()` continue to exist with their current semantics. Both specs preserve this.
- The supervisor's permanent-close mechanism (4401 + JSON reason) continues to exist. Neither spec touches it.
- `auth.onStateChange` continues to fire on sign-in/sign-out. No spec touches the auth package.

If the presence spec evolves to change `Collaboration.devices` semantics (e.g., snapshot gating delays the first device read), this spec is unaffected because it does not read `devices` in any new way.

## Decisions Log

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Resolve workspaceId server-side vs widen `openCollaboration.url` to a resolver function | 3 taste | Server-side resolution | Widening the URL signature absorbs the deferred wrapper into the primitive. Server-side resolution refuses the assumption that forced the wrapper. The product sentence ("apps connect to their default workspace's doc") survives either way; refusing the assumption deletes more code. |
| Reject upgrade with 409 vs accept and close with 4401 | 1 evidence | Accept and close with 4401 | Verified by reading `sync-supervisor.ts:160-179`: only `parsePermanentFailure` distinguishes permanent from transient. A rejected upgrade looks identical to a network blip. |
| Keep `/workspaces/:workspaceId/...` routes alongside `/me/...` | 3 taste | Keep both | Daemon path uses explicit-workspace today. Workspace-switching UI may use it later. Both route families share `resolveAuthorizedWorkspaceSyncDoc`; the duplication is one resolver call. Revisit when: any caller besides the daemon needs the explicit-workspace path, or none do for 6 months. |
| Keep `/api/workspaces` endpoint | 3 taste | Keep | Workspace-listing UI consumers exist (or will). Endpoint is independent of the sync path. Revisit when: no consumer remains after 6 months. |
| Rename `workspaceAppDocWsUrl` to `defaultWorkspaceAppDocWsUrl` and keep old name for explicit-workspace | 2 coherence | Two functions, distinct names | One function per route family. The name carries which workspaceId source is in use. |
| Inline 5-line auth listener in browser.ts vs extract `attachAuthReconnect` helper | 3 taste | Inline | Three call sites, five lines each. Extract when a fourth app appears. |

## Migration

Pre-launch, local-first, no external users. Clean break.

- Single bundled PR.
- Order of changes inside the PR (one commit each, reviewable):
  1. **Add server-side default resolver and routes.** New file change in `workspace-sync-doc.ts`, three new routes in `app.ts`, middleware mounts. No client changes yet. Tests cover the new resolver and the three new route paths.
  2. **Add `defaultWorkspaceAppDocWsUrl` to client transport.** New function in `transport.ts`, exported from `index.ts`. No consumer yet.
  3. **Switch each browser bundle to the new URL builder and direct `openCollaboration`.** One commit per app (fuji, honeycrisp, opensidian). Auth-reconnect listener added inline. The deferred wrapper still exists at this point but is no longer imported by any app.
  4. **Delete `cloud-app-sync.ts` and `cloud-app-sync.test.ts`.** Drop re-exports from `index.ts`. Final cleanup commit.

Step 4 is pure deletion. If any consumer is missed in step 3, step 4 fails to typecheck and the missing consumer is found.

If presence spec is mid-flight at the same time, finish presence first, then start this sequence on top of the presence-landed branch.

## Test plan

**Delete:**

- `packages/workspace/src/document/cloud-app-sync.test.ts` entirely.
- Any tests in `packages/workspace/src/document/transport.test.ts` that assert on `workspaceAppDocWsUrl(apiUrl, { workspaceId, ... })`, if keeping the function for daemon use. Add tests for `defaultWorkspaceAppDocWsUrl`.

**Add:**

- `apps/api/src/workspace-sync-doc.test.ts`:
  - `resolveAuthorizedDefaultWorkspaceSyncDoc` returns `PersonalWorkspaceMissing` when the user has no default workspace.
  - `resolveAuthorizedDefaultWorkspaceSyncDoc` delegates to the workspace resolver when the user has one.
  - Invalid appId / docId return the same errors as the explicit-workspace path.
- `apps/api/src/app.workspaces.test.ts` (or a new `app.me.test.ts`):
  - `GET /me/apps/:appId/docs/:docId` requires a valid auth cookie/bearer.
  - WebSocket upgrade for an unauthenticated user closes with 4401 `auth_required`.
  - WebSocket upgrade for an authenticated user with a workspace upgrades successfully.
  - WebSocket upgrade for an authenticated user with no workspace closes with 4401 `no_default_workspace`.
  - POST `/me/apps/:appId/docs/:docId` HTTP sync round-trips for an authenticated user.
  - POST `/me/apps/:appId/docs/:docId/dispatch` round-trips for an authenticated user.
- `packages/workspace/src/document/transport.test.ts`:
  - `defaultWorkspaceAppDocWsUrl` builds the expected URL.
  - URL-encodes the path segments.

**Reuse:**

- Existing tests for `resolveAuthorizedWorkspaceSyncDoc` continue to cover the explicit-workspace path.
- Existing `dispatch.test.ts` tests stay; they exercise the supervisor's HTTP POST shape, which is unchanged.

## Risks and mitigations

```
Risk                                          Mitigation
The default-workspace query is more expensive Same query the existing /api/workspaces
than membership-by-id (extra join)            handler runs today. No new cost.

A user with multiple workspaces hits /me/...  Server picks "default" by the same rule
and gets routed to the wrong one              /api/workspaces uses today. If the rule
                                              is wrong, fix it at the source; this spec
                                              does not change the rule.

A future feature needs explicit-workspace     The explicit-workspace routes stay. New
sync (e.g. switching workspaces in UI)        feature uses `workspaceAppDocWsUrl(...)`.

PersonalWorkspaceMissing UX: user sees the   The supervisor's status carries
4401-permanent-close state with no recovery   reason.code 'no_default_workspace'. Apps
path                                          render a remediation prompt (sign-out,
                                              contact support, create workspace).
                                              Already true on the in-flight branch.

Auth-reconnect listener inlined in 3 apps    If a fourth app appears, factor
diverges over time                            attachAuthReconnect. Linter check
                                              optional.
```

## Open questions

These should not block the spec going green. They are answerable during implementation.

1. **Default-workspace query implementation.** The exact SQL/Drizzle for "find this user's default workspace" lives in the `/api/workspaces` handler today. Lift it into a shared helper or duplicate the query? Recommend lift; one source of truth for the default-workspace rule.

2. **Keep `workspaceAppDocWsUrl` exported, or move it to the daemon package?** Daemon is the only consumer. If only the daemon path uses it, the function belongs in `packages/workspace/src/daemon/` not in `document/transport.ts`. Recommend: leave in `transport.ts` for now; move when the daemon package boundaries are otherwise being touched.

3. **Should `defaultWorkspaceAppDocWsUrl` be in a different file from `workspaceAppDocWsUrl`?** Both build URLs for the same kind of resource. Keep in `transport.ts`. Decision is low-stakes.

4. **`auth.openWebSocket` behavior on signed-out.** Today the WebSocket open will fail one way or another (no token to attach, server closes 4401, etc.). The supervisor parks in `failed`. Verify the precise close code/reason path during implementation; document in `auth.ts` if it's not already.

5. **Verify `createDisposableCache.values()` exists.** The browser.ts auth-reconnect loop iterates over the child docs. If `createDisposableCache` does not currently expose iteration, add it. Out of scope to change its API otherwise.

## Out of scope: the centralization audit

The presence spec's appendix asked whether other things could be moved to server authority and concluded no. This spec answers a sibling question: what assumptions in the client routing layer could be refused?

```
Concern                       Current ownership       Should change?
─────────────────────────     ────────────────────    ──────────────
workspaceId in URL            Client embeds it        YES, this spec
defaultWorkspaceId lookup     Client GET fetch        YES, this spec (deleted)
Workspace membership check    Server checks           No change
Auth identity                 Server (Worker)         No change
Doc id namespace              App-owned               No change
Installation id               Client-generated        No change (per presence spec)
Liveness/presence             Client gossip           Presence spec
```

The only refusal available here is the workspaceId-in-URL one. Everything else is correctly placed or covered by other specs.

## Definition of done

- `cloud-app-sync.ts` and `cloud-app-sync.test.ts` deleted.
- `attachDeferredCollaboration` no longer exists anywhere in the codebase.
- `defaultWorkspaceAppDocWsUrl` exists in `packages/workspace/src/document/transport.ts` and is re-exported from `packages/workspace/src/index.ts`.
- `workspaceAppDocWsUrl` is deleted: it lost its only caller with `cloud-app-sync.ts` and the daemon uses `roomWsUrl`. See the amendment above.
- `apps/api/src/workspace-sync-doc.ts` exports `resolveAuthorizedDefaultWorkspaceSyncDoc`.
- `apps/api/src/app.ts` registers `GET /me/apps/:appId/docs/:docId`, `POST /me/apps/:appId/docs/:docId`, and `POST /me/apps/:appId/docs/:docId/dispatch`.
- WebSocket upgrade for a user with no default workspace closes with 4401 `{ code: 'no_default_workspace' }` and the supervisor parks in `failed` with that reason.
- `apps/fuji/src/lib/browser.ts`, `apps/honeycrisp/browser.ts`, `apps/opensidian/src/lib/opensidian/browser.ts` call `openCollaboration` directly with `defaultWorkspaceAppDocWsUrl`, each with an inline `auth.onStateChange` reconnect listener.
- All tests in the Test Plan section pass.
- The decision (default-workspace routing is server-side; the client never owns workspaceId for the sync path) is recorded in this spec and its Decisions Log. This project keeps decision records in `specs/`, so no separate `docs/adr/` file is created.
- One bundled PR with the commit sequence in the Migration section.
- JSDoc updates land in the same PR:
  - `packages/workspace/src/index.ts` header rewrites the cloud-sync paragraph (workspaceId is no longer client-side).
  - `packages/workspace/src/document/transport.ts` header documents the two URL builders and their auth contracts.
  - `apps/api/src/app.ts:480-490` legacy-route comment updates to mention the `/me/...` family.

## Appendix A: Why not widen `openCollaboration.url` to a resolver function

The alternative shape considered:

```ts
url: string | (() => Promise<string | null>)
```

The supervisor calls the resolver per cycle, parks in offline if it returns null, dispatches a connect if it returns a URL. The deferred wrapper collapses into the supervisor.

This works. It is a smaller change to the server (zero changes) and a smaller change to the apps (zero changes). But it preserves the underlying assumption, that the client is responsible for producing the URL, and pays for that assumption by widening a primitive's signature.

Refusing the assumption (server resolves the workspaceId) deletes the resolver-function shape, the deferred wrapper, the `/api/workspaces` fetch, and the `lookupFailure` UI distinction. The product sentence is unchanged either way.

The asymmetric win is the refusal, not the absorption.

## Appendix B: Why preserve the explicit-workspace routes

The daemon (`packages/workspace/src/daemon/attach-daemon-infrastructure.ts:73`) connects to a specific workspace it knows from config. There is no "user" for the daemon to default into; it's a service principal with an explicit target.

Workspace-switching in a future UI would also need explicit routes: "let me see my other workspace" is exactly the explicit-workspace path.

Keeping both route families is one shared resolver call deep. The cost is small; the asymmetry is honest about the two use cases.
