---
name: auth
description: 'Epicenter auth packages: `@epicenter/auth` and the Svelte wrapper at `@epicenter/svelte/auth`, OAuth sessions, identity state, auth-owned fetch/WebSocket, and workspace lifecycle binding. Use when editing Epicenter auth clients, session state, hosted sign-in, or auth/workspace integration.'
metadata:
  author: epicenter
  version: '6.0'
---

# Epicenter Auth

## Upstream Grounding

When changes depend on Better Auth OAuth provider behavior, bearer token
verification, cookie handling, token rotation, plugin shape, JWKS, or generated
API shape, ask DeepWiki a narrow question against `better-auth/better-auth`
before relying on memory. Use it to orient, then verify decisive details against
local installed types, source, tests, or official docs before changing code.

Known Better Auth source landmarks:

```txt
packages/oauth-provider/src/oauth.ts
packages/oauth-provider/src/authorize.ts
packages/oauth-provider/src/token.ts
packages/oauth-provider/src/revoke.ts
packages/oauth-provider/src/client-resource.ts
packages/better-auth/src/plugins/jwt/index.ts   (ES256 signing + JWKS)
```

Better Auth remains the auth server and session engine. Epicenter extends it
through plugins and options; it does not replace Better Auth's server-side
session model.

The composition: Better Auth provides the auth-server machinery, OAuth covers
the app/resource boundary, and `AuthState{ownerId}` drives workspace boot.
Better Auth owns users, account cookies, login, consent, token issuing,
revocation, JWKS, and metadata. Epicenter clients store `PersistedAuth`, not
Better Auth sessions. `/api/session` is the adapter that verifies an OAuth
access token, resolves the request to an `ownerId`, and returns
`ApiSessionResponse`.

This is not the shortest Better Auth browser-cookie path; it is an idiomatic
composition of Better Auth as the auth server beneath a cross-client OAuth
runtime.

Do not suggest removing Better Auth unless the user has a concrete blocker that
cannot be handled with configuration, a small adapter, or an upstream fix.
Building OAuth by hand means owning PKCE validation, redirect URI validation,
state and mix-up protections, trusted clients, token signing, refresh token
rotation, revocation, JWKS, metadata, consent, account sessions, and security
fixes forever.

## Current Model

Epicenter app clients use one OAuth app auth factory:

```ts
const auth = createOAuthAppAuth({
	baseURL: EPICENTER_API_URL,
	clientId,
	launcher,
	persistedAuthStorage,
});
```

There is exactly one factory. The old split between `createCookieAuth` and
`createBearerAuth` (and `BearerSession` / `auth.bearerToken`) is fully removed,
not legacy-but-present. Do not reintroduce those names.

The public surface lives in one package plus a Svelte subpath:

- `@epicenter/auth`: framework-agnostic core. Owns the persisted auth cell,
  refresh, refresh-token revocation, `/api/session` verification, the network
  gate, authenticated fetch, and WebSocket opening. Also exports the Node
  machine-auth surface for CLI and daemons.
- `@epicenter/svelte/auth`: Svelte 5 wrapper (in the `@epicenter/svelte`
  package, which also owns `createSession` / `SignedIn`). Mirrors `auth.state`
  through `createSubscriber` so templates and `$derived` reads are reactive.
- `createSession` / `SignedIn` from `@epicenter/svelte`: workspace lifecycle
  binding over an `AuthClient`.

The API server composes Better Auth like this:

```txt
Hono app
  -> CORS
  -> per-request DB
  -> createAuth({ db, env, baseURL })
  -> singleCredential
  -> /auth/* Better Auth handler
  -> /api/session (mountSessionApp: cookie-or-bearer + ownership)
  -> protected resources (bearer + ownership)
```

`createAuth()` configures Better Auth with Drizzle (Postgres via Hyperdrive),
Google sign-in (plus GitHub when its credentials are present), and exactly two
plugins:

```ts
jwt({ jwks: { keyPairConfig: { alg: JWT_SIGNING_ALG } } }), // ES256
oauthProvider({
	loginPage: '/sign-in',
	consentPage: '/consent',
	requirePKCE: true,
	accessTokenExpiresIn: 600,
	cachedTrustedClients: trustedOAuthClientIds,
	validAudiences: [apiBaseURL],
	allowDynamicClientRegistration: false,
	scopes: [...EPICENTER_OAUTH_SCOPES],
})
```

There are no bearer, device-authorization, or custom-session plugins. Local
email/password is disabled (`emailAndPassword: { enabled: false }`): enabling
unverified local credentials reopens an account-linking takeover on
better-auth 1.5.6 (no `requireLocalEmailVerified` gate). Only Google is a
trusted linking provider; see the `better-auth-security-best-practices`
skill's Account Linking note.

## Public Surface

Auth has one public client interface (copied verbatim from
`packages/auth/src/auth-contract.ts`):

```ts
export type AuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			ownerId: OwnerId;
	  }
	| {
			status: 'reauth-required';
			ownerId: OwnerId;
	  };

export type AuthClient = {
	state: AuthState;
	baseURL: string;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
```

`AuthState` arms carry `ownerId` directly. There is no nested
identity object and no `user` field in state: profile (user/email) is fetched
by surfaces that display it, not held in state. `ownerId` is
present in `signed-in` and `reauth-required` because it belongs to local
workspace operations: even when the OAuth grant needs reauth, the cached owner
id picks the right local storage partition.

Read `auth.state` synchronously. Use `auth.onStateChange(fn)` for future
changes only; it does not replay. Consumers that need bootstrap behavior must
read `auth.state` once and then register the listener.

Do not expose raw tokens above auth storage and transport boundaries. UI,
workspace binding, AI fetches, and sync consume capabilities: `auth.fetch` and
`auth.openWebSocket`.

## The Persisted Cell

`PersistedAuth` is the single durable auth record (copied verbatim from
`packages/auth/src/auth-types.ts`):

```ts
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	userId: UserId,
	ownerId: OwnerId,
});

export type PersistedAuth = typeof PersistedAuth.infer;

export const ApiSessionResponse = type({
	'+': 'delete',
	user: AuthUser,
	ownerId: OwnerId,
});

export type ApiSessionResponse = typeof ApiSessionResponse.infer;
```

The grant is a nested object; identity is split out:

```txt
PersistedAuth
  grant: { accessToken, refreshToken, accessTokenExpiresAt }  -> online-only server access
  userId   -> stored explicitly so the instance daemon can read it
  ownerId  -> local storage partition selection
```

The grant lets the app call the server and is useless offline on its own.
`userId` / `ownerId` remain useful offline: they select
this user's local workspace data. `userId` is stored explicitly rather than
synthesised from `ownerId` so the instance daemon can read it when
`ownerId === INSTANCE_OWNER_ID` (in instance mode `ownerId` is the literal pinned id
and is structurally not a `UserId`). Profile data is intentionally absent;
application surfaces fetch it when they display it.

The app can boot from a cached `PersistedAuth` without calling the network.
Refresh failure must preserve the cached `ownerId` so local workspace data can
remain available. The cached owner id selects the local storage partition; it
does not decrypt anything.

## Network Gate (local-first invariant)

The runtime tracks a `networkAccess` state per signed-in cell (internal to
`createOAuthAppAuth`):

```txt
networkAccess: 'unverified' | 'verified' | 'paused'
```

`bearerForNetwork` is the gate. It NEVER attaches a bearer until `/api/session`
verifies the current persisted auth in this runtime:

```txt
signed-out / paused        -> no bearer
refresh stale grant        -> if refresh fails, no bearer (offline = fail closed)
unverified -> call /api/session
  ok                       -> mark verified, attach bearer
  AuthRejected (401/403)   -> pauseNetworkAuth() -> reauth-required
  Unavailable (offline)    -> no bearer; local workspace boot can continue by ownerId
```

Fail closed offline: server access is refused until the current persisted auth
has been verified by the API, but local workspace boot continues because the
cached `ownerId` selects the right local partition. A different-`ownerId`
`/api/session` response wipes the local cell (same-owner guard).

`auth.fetch` layers retry on top of the gate: verify-before-attach,
`credentials: 'omit'`, one forced-refresh retry on a 401, and
`pauseNetworkAuth()` on a second 401.

## Sign-In Flow

Apps ask auth to start hosted sign-in. `startSignIn` takes NO arguments:

```ts
await auth.startSignIn();
```

The launcher decides how the runtime completes OAuth and returns one of two
shapes:

- `'launched'`: control moved to a redirect / deep-link callback. The browser
  redirect launcher navigates to the hosted `/sign-in` and usually does not
  resolve before the page unloads.
- `'completed'` with `{ grant }`: the launcher exchanged a token grant in
  process (extension, OOB CLI). The runtime then calls `/api/session`,
  resolves identity, and persists `PersistedAuth`.

The return value of `startSignIn` is not the "user is signed in" signal.
Observe `auth.state.status === 'signed-in'` for completion.

## PersistedAuthStorage Port

Storage is a small port (copied verbatim from
`packages/auth/src/persisted-auth-storage.ts`):

```ts
export type PersistedAuthStorage = {
	initial: PersistedAuth | null;
	set(value: PersistedAuth | null): void | Promise<void>;
};
```

`initial` is read exactly once, synchronously, at construction to seed the
state machine; it is never re-read. `set` is the only write path (no watch
hook: cross-context sign-out propagates via the server, where the next
bearer-bearing call hits a revoked token and reauth-requires organically).

Adapters:

- `createWebStoragePersistedAuthStorage({ key, storage })`: sync Web Storage
  (`localStorage` / `sessionStorage`). A corrupt record reads as signed-out
  instead of throwing; write failures propagate so an unpersistable credential
  fails its sign-in or refresh.
- `loadPersistedAuthStorage({ read, write })`: pre-load an async-backed store
  (extension `chrome.storage.local`, a file) into a synchronous port. Await it
  before constructing the client so `initial` stays synchronous.
- `parsePersistedAuth` / `serializePersistedAuth`: the shared decode/encode
  helpers (re-validate against the arktype on both sides).

## CLI and Daemon (machine auth)

`packages/auth/src/node/machine-auth.ts` is the Node surface. One auth file per
API target lives at `<dataDir>/auth/<host>.json` with mode `0o600` (`:` in the
host replaced by `_`); `machineAuthFilePath({ baseURL })` resolves it. Loading
refuses a file whose permissions are wider than `0o600`.

- `loginWithOob(...)`: runs the OOB OAuth dance once, calls `/api/session` for
  the identity, persists `PersistedAuth`, and returns the email for CLI output.
  It deliberately BYPASSES `createOAuthAppAuth`: login is a one-shot human
  action, and routing it through the factory would double the round-trip count.
- `createMachineAuthClient(...)`: the daemon boot entry point. Loads the cell
  and constructs a normal `createOAuthAppAuth` client over a file-backed
  storage port. Its launcher errors on `startSignIn` (a human must run
  `epicenter auth login` to refresh the cell); daemons never sign in
  interactively.
- `status` / `logout`: read the cell and reach the server through a regular
  client. `status` returns `'unverified'` on network failure so the CLI can
  still print the cached identity.

## Transport

Use `auth.fetch` for HTTP resources:

```ts
const response = await auth.fetch(`${EPICENTER_API_URL}/api/ai/chat`, {
	method: 'POST',
	body,
});
```

`auth.fetch` runs the network gate (verify-before-attach), sends
`credentials: 'omit'` so OAuth tokens stay the resource credential, retries one
401 after a forced refresh, and pauses network auth on a second 401. Storage
writes are awaited before a refreshed token is used.

Use `auth.openWebSocket` for sync:

```ts
const collaboration = openCollaboration(workspace.ydoc, {
	url: roomWsUrl({ baseURL, ownerId, guid: workspace.ydoc.guid, nodeId }),
	waitFor: idb.whenLoaded,
	openWebSocket: signedIn.openWebSocket,
	onReconnectSignal: signedIn.onReconnectSignal,
});
```

Browsers cannot attach `Authorization` headers to `new WebSocket()`, so auth
carries the bearer token as a WebSocket subprotocol
(`BEARER_SUBPROTOCOL_PREFIX`). The API's `singleCredential` middleware
normalizes that subprotocol into `Authorization` and rejects requests that
carry multiple credentials.

## Stateless access tokens and revocation windows

The OAuth provider issues JWT access tokens that the resource server verifies
statelessly against JWKS (no per-request introspection). That is fast, but it
means a token cannot be revoked before it expires: signing out revokes the
refresh token, not the already-issued access token. Three mitigations follow
from that one invariant and only make sense together. Treat them as a unit.

```txt
stateless JWT access token  ->  cannot revoke before exp
  1. short access-token TTL          (accessTokenExpiresIn: 600 / 10 min)
  2. bound WebSocket connection lifetime + force re-auth on reconnect
  3. classify verify failures: 401 (bad token) vs 503 (JWKS unreachable)
```

1. Keep `accessTokenExpiresIn` short (10 minutes). The client refreshes
   transparently (refresh tokens rotate; the runtime refreshes on a skew window
   and on any 401), so the UX cost is ~nil and the post-revocation window stays
   small.

2. A route that authenticates only at the WebSocket upgrade MUST bound the
   connection lifetime, or a socket opened with a valid token outlives the
   token. The rooms Durable Object closes an over-age socket and the client
   reconnects through a fresh authenticated upgrade. Crucially, a per-frame
   check misses idle sockets (their only traffic is the auto-responded `ping`),
   so the bound also needs an alarm-driven sweep over `getWebSockets()`.

3. Close codes and statuses carry meaning the client acts on:

   ```txt
   WS close 4401  -> permanent auth failure; client gives up
   WS close 4408/4503 -> transient; client reconnects with backoff
   HTTP 401 (InvalidToken)  -> discard and refresh the token
   HTTP 503 (ServerError)   -> retry; the token is fine, JWKS was unreachable
   ```

   Never flatten a JWKS-fetch failure into a 401, or a transient server fault
   makes clients discard and refresh a good token and pause network auth.

## Workspace Binding

Workspace construction reads identity from `createSession` and gives lower
layers callbacks for data they need at their own boundary. The build callback
receives a `SignedIn` value (copied verbatim from
`packages/svelte-utils/src/session.svelte.ts`):

```ts
export type SignedIn = {
	server: string;
	baseURL: string;
	ownerId: OwnerId;
	openWebSocket: AuthClient['openWebSocket'];
	onReconnectSignal: AuthClient['onStateChange'];
};
```

Use it against the real `createSession`:

```ts
import { createSession, type SignedIn } from '@epicenter/svelte/auth';

export const session = createSession({
	auth,
	build: (signedIn: SignedIn) => {
		const workspace = createWorkspace({
			id: workspaceId,
			tables,
			kv,
		});
		const idb = attachLocalStorage(workspace.ydoc, {
			server: signedIn.server,
			ownerId: signedIn.ownerId,
		});
		const collaboration = openCollaboration(workspace.ydoc, {
			url: roomWsUrl({
				baseURL: signedIn.baseURL,
				ownerId: signedIn.ownerId,
				guid: workspace.ydoc.guid,
				nodeId,
			}),
			waitFor: idb.whenLoaded,
			openWebSocket: signedIn.openWebSocket,
			onReconnectSignal: signedIn.onReconnectSignal,
		});
		return {
			workspace,
			[Symbol.dispose]() {
				collaboration[Symbol.dispose]();
				idb[Symbol.dispose]();
			},
		};
	},
});
```

`server` is the API host alone (local-storage partition names); `baseURL` is
the full origin (`roomWsUrl` wants the scheme for the `wss://` upgrade).

`createSession` owns workspace lifecycle. A sign-out disposes the payload. A
`reauth-required` transition keeps the existing payload mounted (OAuth sessions
publish a signed-out gap before a different owner mounts, so two consecutive
identity-bearing states are always the same owner). `session.current` is the
nullable payload; `session.require()` throws when signed-out.

Local workspace data must not be wiped just because network auth failed. Wiping
Yjs or local storage is a separate destructive user action.

## Server Routes and Deployment Seam

`/api/session` is mounted via `mountSessionApp(app, { ownership })`, which wires
`requireCookieOrBearerUser` (the endpoint serves both browser apps and API
clients) plus `createRequireOwnership`, then mounts the handler. The handler
returns `{ user: { id, email }, ownerId }`.

External-only protected routes (AI chat, rooms) use `requireBearerUser`, which
skips the cookie path and always answers 401 with a standard OAuth
`WWW-Authenticate` header. Both auth middlewares verify the bearer through
`verifyAccessToken` from `oauthProviderResourceClient`:

```txt
audience = c.var.authBaseURL          (the API origin)
issuer   = <API origin> + /auth
jwksUrl  = <API origin> + /auth JWKS
```

A token-verification failure (expired, bad audience/issuer/signature) is a real
401 (`OAuthError.InvalidToken`); an unreachable JWKS is a retryable 503
(`OAuthError.ServerError`). Never flatten the latter into a 401.

The deployment seam lives in `packages/server/src/ownership.ts`:

```ts
export type OwnershipRule =
	| { kind: 'personal' }
	| { kind: 'instance'; ownerId: OwnerId };

export const personal = (): OwnershipRule => ({ kind: 'personal' });
export const instance = (): OwnershipRule => ({
	kind: 'instance',
	ownerId: INSTANCE_OWNER_ID,
});
```

`resolveOwnerPartition(rule, c)` is the single switch on `rule.kind`. Personal
mode returns the user's id branded as `OwnerId` (`ownerId === userId`). Instance
mode returns the literal `INSTANCE_OWNER_ID`; there is no admission predicate,
since the operator bearer already gated the request (ADR-0075). `createRequireOwnership`
sets `c.var.ownerId` and, on routes with a `:ownerId` segment, rejects a URL
mismatch with `OwnerMismatch` (403).

Note: the same-origin dashboard SPA (`apps/api/ui`) uses
`createSameOriginCookieAuth`, not PKCE. Served same-origin by the API, it already
holds a first-party Better Auth session cookie after Google sign-in, so minting a
bearer (and an unused `offline_access` refresh token) via PKCE against its own
origin would be redundant. The cookie client uses that cookie directly
(`credentials: 'include'`, no `Authorization`), reads `/api/session` once for
`ownerId`, and is a plain `AuthClient` (no `openWebSocket`: a billing surface
has no sync). It is the cookie-credential sibling of `createOAuthAppAuth`, not a
mode flag on it.

## Common Pitfalls

- Do not let `accessTokenExpiresAt` decide local identity state. It is a
  transport refresh hint only; the resource server is the source of truth for
  token validity.
- Do not hide persistence failures in storage adapters. If `set` cannot save
  the refreshed cell, the failure must propagate, not silently look saved.
- Do not import `requireSignedIn`, `InferSignedIn`, `openFuji`,
  `encryptionKeys`, `EncryptionKeys`, `keyring`, or `Keyring`. They do not
  exist in Epicenter workspace auth. Workspace binding goes through
  `createSession` / `SignedIn`.
