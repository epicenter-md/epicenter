# Auth owns tokens only; identity moves to workspace

**Date**: 2026-05-14
**Status**: Superseded (2026-05-14). Do not implement.
**Author**: Braden + Claude
**Superseded by**:
- `specs/20260514T120000-machine-auth-oob-clean-break.md`: replaces this spec's CLI/device-code consolidation. CLI switches to OAuth 2.1 authorization-code with OOB paste and a file-backed session at `~/.epicenter/auth.json`; the device-code grant is removed, not consolidated. Identity continues to load from `/workspace-identity` like every other client.
- The "extract identity from auth into workspace" half of this spec is retracted, not replaced. Identity remains in `@epicenter/auth` as `OAuthSession.identity` (the `WorkspaceIdentity` shape `{ user, encryptionKeys }`), loaded once from `/workspace-identity` after sign-in. See `docs/articles/if-you-dont-trust-the-server-become-the-server.md` and `docs/articles/encryption-at-rest-is-the-gold-standard.md` for the trust-model rationale (server-managed encryption for hosted, self-host for real privacy).
- **Note:** an earlier successor pair (`specs/20260514T154500-id-token-bearing-encryption-keys.md` + `specs/20260514T160000-execute-id-token-and-oob-cli.md`) was itself retracted on 2026-05-14. Those specs proposed moving encryption keys into id_token claims; they introduced a security regression at the leakage surface and were rejected. See their respective `## Retraction` sections.

## Superseded

> Read this section first. **Do not start any Phase 1-5 task below.** The proposed end state of this spec has been retracted. The successor replaces its two load-bearing contributions as follows:
>
> | This spec proposed | Successor decision |
> | --- | --- |
> | Extract identity into `@epicenter/workspace` as a new `WorkspaceIdentityStore` with its own storage adapter, `attach`/`detach` lifecycle, and dedicated error taxonomy. | Retracted, not replaced. Identity stays in `@epicenter/auth` as `OAuthSession.identity`. No new package, no new store, no second adapter, no separate lifecycle. The trust model is "server-managed encryption for hosted; self-host for real privacy." |
> | Consolidate the CLI device-code path onto `/workspace-identity` (Decisions log entry #3). | OOB spec: CLI drops device-code entirely and runs the same OAuth 2.1 authorization-code flow the browser runs, with a manual paste step. Session is a `0o600` file, not `Bun.secrets`. Identity loads from `/workspace-identity` exactly like every other client. |
>
> There is no remaining role for the identity-extraction design in this document. The CLI consolidation lives in the OOB spec.
>
> **What is still useful in this file.** Everything below the metadata is preserved as a historical snapshot. The Pass 1-12 verification work (file paths, line numbers, call-site counts, deepwiki citations, Bun.secrets shape, `createPersistedState` behavior) is accurate as a description of the codebase at commit `a3213ab7f` and may be reused as grounding for the OOB CLI spec. The `## Done when (spec is watertight)` block at the bottom remains legitimately `[x]` for the checks it ran; it just no longer gates anything because the proposed end state has been retracted.

## Sentence

```txt
@epicenter/auth shrinks to a token-lifecycle library (refresh, bearer
on fetch, three-state lifecycle) and stops owning WorkspaceIdentity /
encryption keys, which become the workspace package's job because the
workspace is the actual consumer of encryption material.
```

## Motivation

### Current state (verified at commit `a3213ab7f`)

`@epicenter/auth` owns:

```ts
// packages/auth/src/auth-types.ts
export const AuthUser = type({
  '+': 'delete',
  id: 'string',
  email: 'string',
});

export const WorkspaceIdentity = type({
  '+': 'delete',
  user: AuthUser,
  encryptionKeys: EncryptionKeys,  // from @epicenter/encryption
});

export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken: 'string',
  refreshToken: 'string',
  accessTokenExpiresAt: 'number',
});

export const OAuthSession = type({
  '+': 'delete',
  tokens: OAuthTokenGrant,
  identity: WorkspaceIdentity,
});
```

```ts
// packages/auth/src/auth-contract.ts
export type AuthState =
  | { status: 'signed-in';        identity: WorkspaceIdentity }
  | { status: 'reauth-required';  identity: WorkspaceIdentity }
  | { status: 'signed-out' };

export type AuthClient = {
  state: AuthState;
  onStateChange(fn: (state: AuthState) => void): () => void;
  startSignIn(): Promise<Result<undefined, AuthError>>;
  signOut(): Promise<Result<undefined, AuthError>>;
  fetch(input, init?): Promise<Response>;
  openWebSocket(url, protocols?): Promise<WebSocket>;
  [Symbol.dispose](): void;
};
```

There is also a separate `Session` sugar type in `packages/auth/src/require-session.ts:17-20`, used by daemon/script callers that want a single bundle:

```ts
export type Session = WorkspaceIdentity & {
  fetch: AuthClient['fetch'];
  openWebSocket: AuthClient['openWebSocket'];
};
```

`Session` is purely an ergonomic projection of `AuthClient`. It is not the auth state shape and not the persisted shape; only `requireSession(auth)` in 8 daemon/script call sites uses it (see Pass 4 grounding).

The auth library currently:

1. Runs the OAuth ceremony (browser PKCE in `oauth-launchers/`, device code in `node/machine-auth.ts`).
2. Persists `OAuthSession = { tokens, identity }` to one storage adapter (`sessionStorage`).
3. Refreshes `tokens` on schedule (single-flight, with `sessionEpoch` versioning at `create-oauth-app-auth.ts:71`).
4. Fetches `/workspace-identity` once at sign-in (`create-oauth-app-auth.ts:110-122`); identity is then cached as part of the persisted blob.
5. Exposes `identity` directly on `AuthState` (`auth-contract.ts:6-7`).
6. Guards against quietly swapping identity (`create-oauth-app-auth.ts:87-97`).
7. Wraps `fetch` / `openWebSocket` with bearer injection.

### Problems

1. **The library knows about encryption keys.** That is not an auth concern. Encryption keys are workspace-decryption material that happens to be delivered through `/workspace-identity` because the server bundles them with user info. Routing accident, not semantic coupling.

2. **Two persisted concerns share one storage adapter.** Browser apps must store `OAuthSession` in one place. Tokens want short-lived, narrowly-scoped storage; encryption keys want durable larger storage. The bundle forces lowest-common-denominator storage; an XSS that reads `localStorage` drains the bearer **and** the encryption keys in one read. (See Pass 2 research below: same-origin XSS reads *any* of `localStorage`, `sessionStorage`, IndexedDB. The XSS-defense lever is HttpOnly cookies or a service-worker private cache, not IndexedDB. The split is what unblocks moving tokens to one of those primitives later; the split itself does not deliver XSS resistance, only blast-radius reduction by isolating storage adapters.)

3. **One persisted blob couples token rotation to identity stability.** `create-oauth-app-auth.ts` holds a single `session: OAuthSession | null` (line 67), so every `refreshSession` writes a fresh `OAuthSession` (line 142-146) just to swap the `tokens` half while keeping `identity` byte-for-byte identical. The `sessionEpoch` machinery (line 71, 98, 129, 141, 147) exists exactly to keep the identity half stable across token-only rotations. Once the persisted shape splits, identity is not in the rotation write path at all. (Prior drafts of this spec called this a "dual in-memory cache" `oauthSession` / `currentSession`; that pattern was removed in commit `e1a9bcee4`. The remaining smell is the bundled write, not a duplicated read cache.)

4. **The same-user guard lives at the wrong layer.** `replaceSession` (`create-oauth-app-auth.ts:87-97`) throws if `next.identity.user.id !== session.identity.user.id`. The thing that actually breaks on a quiet user-swap is workspace encryption (encrypted CRDT blobs decrypted with the wrong key). The guard should be enforced by whoever owns those keys.

5. **Identity freshness is aspirationally maintained, actually slipping.** `session.identity` is captured at first sign-in (`create-oauth-app-auth.ts:204`) and then carried verbatim into every refresh write (`create-oauth-app-auth.ts:142-145`). If the server rotates the encryption keyring in `/workspace-identity`, the cached blob is never updated; refresh only touches `tokens`. The same-user guard in `replaceSession` is the only re-fetch path, and only `startSignIn` reaches it. There is no scheduled re-fetch and no key-rotation event. The contract comment in `require-identity.ts:5-8` says identity is stable across `signed-in <-> reauth-required` transitions, which silently implies keys are immutable per signed-in lifetime. That promise is undocumented and weakly held.

6. **The one-sentence test fails.** Asked "what does `@epicenter/auth` do?" the honest answer is "it rotates OAuth tokens behind a fetch **and** caches the user identity and encryption keys returned by `/workspace-identity`." The second clause is the smell.

### Desired state

Two libraries, two single-sentence answers:

```txt
@epicenter/auth
  Rotates OAuth tokens behind a fetch and surfaces a three-state lifecycle.

@epicenter/workspace (or @epicenter/identity, see Open Questions)
  Owns workspace identity: persists encryption keys keyed by user,
  enforces same-user invariants, and provides the runtime handle that
  workspace decryption consumes.
```

Auth state collapses to a status enum plus bound network methods, with no identity surface:

```ts
type AuthClient = {
  state: { status: 'signed-in' | 'reauth-required' | 'signed-out' };
  startSignIn(): Promise<Result<undefined, AuthError>>;
  signOut(): Promise<Result<undefined, AuthError>>;
  fetch(input, init?): Promise<Response>;
  openWebSocket(url, protocols?): Promise<WebSocket>;
  onStateChange(fn: (state: AuthState) => void): () => void;
  [Symbol.dispose](): void;
};
```

The workspace identity store is a separate construct:

```ts
type WorkspaceIdentityStore = {
  state: {
    status: 'attached' | 'loading' | 'detached';
    identity?: WorkspaceIdentity;
  };
  attach(auth: AuthClient): Promise<Result<WorkspaceIdentity, IdentityError>>;
  detach(): Promise<void>;
  require(): WorkspaceIdentity;          // throws if not attached
  onStateChange(fn): () => void;
  [Symbol.dispose](): void;
};
```

Apps compose them with explicit lifecycle coordination instead of relying on the auth library to bundle the work.

## Conceptual model

The motivation above is best understood through one explicit layering. New readers should not have to re-derive it.

**Tokens** (`OAuthTokenGrant`) are the auth artifact.

```
What:         proof that you can act
TTL:          ~1 hour, rotates on refresh
Sensitivity:  bearer = full account access until expiry
Persistence:  must persist refreshToken to survive cold boot
Lost it?      run sign-in again
Owner:        @epicenter/auth
```

**Identity** (`WorkspaceIdentity`) is the "who am I + what crypto do I own."

```
What:         { user: { id, email }, encryptionKeys: [...] }
TTL:          months to forever; rotates only on key rotation events
Sensitivity:  encryptionKeys = decrypt-everything material
Persistence:  MUST persist client-side for offline workspace decryption
Lost it?      fetch /workspace-identity again (requires valid tokens)
Owner:        @epicenter/workspace (target state)
```

**Session handle** (today's `Session` in `require-session.ts`) is a *runtime* object that fuses a view of identity with bound network methods. It is not data; it has methods. You cannot serialize it. It exists for caller ergonomics: daemon/script callers want one local that carries both identity fields and transport instead of mixing `requireIdentity(auth).encryptionKeys` with `auth.openWebSocket`. After this refactor, the role splits:

* Token machinery (bound `fetch`, `openWebSocket`) is exposed by `AuthClient` directly (already true today).
* Identity surface (`user`, `encryptionKeys`) is exposed by `WorkspaceIdentityStore.state.identity` instead of by `AuthState`.
* The bundled `Session` shape stays available as `requireSession`-style sugar at the app/workspace layer, but it now composes `auth.fetch` with the *workspace* identity store, not with auth-owned identity.

## Invariants

| ID | Statement | After this spec |
| --- | --- | --- |
| A | Token rotation is invisible to callers. Bearer is injected; 401 triggers a refresh-then-retry. | Preserved in `@epicenter/auth`. |
| B | A held identity reference survives `signed-in <-> reauth-required` transitions. | Preserved in `@epicenter/workspace`. The identity object reference stays stable across auth-state transitions because identity is owned in a separate store, not derived from auth state. |
| C | Identity cannot be quietly swapped to a different user. Switching users requires explicit sign-out. | **Moves**. The guard moves from `replaceSession` in auth to `attach()` in the workspace identity store. |
| D | Tokens-present implies identity-present and vice versa. | **Dropped**. Replaced by an explicit attach lifecycle. Tokens can exist briefly without identity (between `auth.startSignIn` resolving and `workspace.attach` completing); apps gate UI on `workspace.state.status === 'attached'`, not `auth.state.status === 'signed-in'`. |
| E | Identity is fresh. | **Strengthened**. The workspace identity store has an explicit `refresh()` method and may re-fetch on attach. Key rotation becomes a first-class event rather than a silently-missed update. |
| F | Bearer is never visible to callers. | Preserved. `auth.fetch` and `auth.openWebSocket` are the only ways to use tokens. |

## Architecture

### Package boundaries (after)

```txt
@epicenter/auth                       (shrinks)
  src/
    auth-types.ts                     OAuthTokenGrant only
    auth-contract.ts                  AuthClient, AuthState (no identity)
    auth-state-store.ts               three-state notify bus
    create-oauth-app-auth.ts          token lifecycle, fetch/ws, no identity load
    oauth-launchers/                  unchanged (browser PKCE, extension flow)
    node/
      machine-auth.ts                 device code; persists tokens only
      machine-session-store.ts        keychain adapter for OAuthTokenGrant

  Public exports:
    type AuthClient, AuthState
    type OAuthTokenGrant
    createOAuthAppAuth({ tokensStorage, launcher, ... })
    type OAuthTokensStorage           (renamed from OAuthSessionStorage)
    type OAuthSignInLauncher
    AuthError

@epicenter/workspace                  (grows)
  src/
    identity/
      identity-types.ts               WorkspaceIdentity, AuthUser
      create-workspace-identity-store.ts
                                      attach(auth), refresh(), require(), state
      identity-storage-contract.ts    WorkspaceIdentityStorage interface
      workspace-identity-fetcher.ts   wraps /workspace-identity
      browser-identity-storage.ts     IndexedDB-backed adapter
      keychain-identity-storage.ts    Bun.secrets-backed adapter (node entry)

  Public exports:
    type WorkspaceIdentity, AuthUser
    type WorkspaceIdentityStore, WorkspaceIdentityStorage
    createWorkspaceIdentityStore({ identityStorage, fetch })
    requireIdentity(store)            (replaces requireSession)
    IdentityError
```

### Runtime composition

```txt
   ┌────────────────────────────────────────────────────────────┐
   │                          App                                │
   │                                                             │
   │   const auth     = createOAuthAppAuth({ tokensStorage })   │
   │   const identity = createWorkspaceIdentityStore({          │
   │                       identityStorage,                     │
   │                       fetch: auth.fetch,                   │
   │                    })                                       │
   │                                                             │
   │   auth.onStateChange((state) => {                          │
   │     if (state.status === 'signed-in') identity.attach()    │
   │     if (state.status === 'signed-out') identity.detach()   │
   │   })                                                        │
   └────────────────────────────────────────────────────────────┘
              │                                  │
              ▼                                  ▼
   ┌──────────────────────┐         ┌──────────────────────────┐
   │  @epicenter/auth     │         │  @epicenter/workspace    │
   │                      │         │  identity store          │
   │  - tokens lifecycle  │         │                          │
   │  - bearer-on-fetch   │  fetch  │  - /workspace-identity   │
   │  - 3-state lifecycle │ ───────►│  - encryption keys store │
   │                      │         │  - same-user guard       │
   └──────────────────────┘         │  - refresh / rotation    │
              │                     └──────────────────────────┘
              ▼                                  │
   ┌──────────────────────┐                      ▼
   │  tokensStorage       │         ┌──────────────────────────┐
   │  v1: localStorage    │         │  identityStorage         │
   │  (chrome.storage on  │         │  v1: localStorage        │
   │   extension;         │         │  (chrome.storage on      │
   │   Bun.secrets node)  │         │   extension;             │
   │                      │         │   Bun.secrets node)      │
   │  future: HttpOnly    │         │  future: IndexedDB       │
   │   cookie, service    │         │   adapter (durability,   │
   │   worker private     │         │   quota; not XSS         │
   │   cache              │         │   defense)               │
   └──────────────────────┘         └──────────────────────────┘
```

### Lifecycle: sign-in (browser, cold)

```txt
1. user clicks sign-in
2. auth.startSignIn()
     - launcher runs OAuth PKCE flow
     - createOAuthAppAuth exchanges code for OAuthTokenGrant
     - tokensStorage.set(tokens)
     - auth.state transitions to 'signed-in'
3. identity.attach() runs (driven by app's onStateChange handler)
     - identity store calls /workspace-identity with auth.fetch
     - validates response shape
     - identityStorage.set({ userId, encryptionKeys, user })
     - identity.state transitions to 'attached'
4. UI unblocks; workspace decryption can begin
```

### Lifecycle: cold boot (existing user)

```txt
1. createOAuthAppAuth constructs
     - tokensStorage.get() -> tokens
     - auth.state = 'signed-in' if tokens present, else 'signed-out'
2. createWorkspaceIdentityStore constructs
     - identityStorage.get() -> cached identity
     - identity.state = 'attached' if cached, else 'detached'
3. App renders against the union of (auth.state, identity.state)
     - signed-in + attached    -> happy path, full UI
     - signed-in + detached    -> trigger identity.attach() (re-fetch)
     - signed-out + attached   -> stale identity; identity.detach()
     - signed-out + detached   -> sign-in screen
```

### Lifecycle: reauth-required

```txt
1. auth.fetch hits a 401 it can't recover from
2. auth.state transitions to 'reauth-required'
3. identity.state stays 'attached' (the encryption keys are still valid)
4. App shows a reauth prompt; identity-bearing UI keeps rendering
5. user re-signs-in; auth.state goes back to 'signed-in'
6. identity.refresh() runs (driven by app or by identity store auto-policy)
     - re-fetches /workspace-identity
     - if encryptionKeys still match: no observable change
     - if encryptionKeys differ: surface KeyRotationDetected event
```

### Lifecycle: sign-out

```txt
1. auth.signOut()
     - revokes refresh token at /auth/oauth2/revoke
     - tokensStorage.set(null)
     - auth.state -> 'signed-out'
2. App's onStateChange handler calls identity.detach()
     - identityStorage.set(null)
     - identity.state -> 'detached'
```

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Identity package home | 3 taste | `@epicenter/workspace` | Workspace is the consumer of encryption keys. Open question on whether to spin a dedicated `@epicenter/identity` package; default is keep it folded into workspace. |
| Two storage adapters | 2 coherence | Separate `tokensStorage` and `identityStorage` | Each has a different durability and security profile. The bundled-storage seam was the source of every smell we found. |
| Lifecycle coordination | 2 coherence | App-driven, via `auth.onStateChange` | Forces apps to be explicit about which UI gates on auth vs identity. Avoids implicit "auth state implies identity state" that the bundle hides. |
| Existing OAuthSession blobs | 1 evidence | Clean break: new keys, no shim, no migration | Pre-launch product, login-only UX. One forced sign-in for current testers is the entire migration. No fallback read paths. |
| Machine auth path | 2 coherence | Free to be rewritten end-to-end | Token-only on the auth side, identity on the workspace side, `/workspace-identity` for the fetch. Anything in `packages/auth/src/node/` that doesn't fit the new shape can be deleted; the old keychain entries are stranded by design. |
| Same-user guard location | 2 coherence | `identity.attach()` enforces; not `auth` | The thing that breaks on a quiet swap is encryption-key mismatch. Owner of keys owns the guard. |
| `requireSession` -> `requireIdentity` | 2 coherence | Rename and move to workspace package | Workspace surfaces identity now; consumers narrow there. |
| Identity refresh on attach | 3 taste | Re-fetch by default, with `attach({ useCache: true })` opt-out | Defaults toward freshness; tests and offline-first paths can opt out. |
| Key rotation surfacing | Deferred | Surface an event but no auto-rekey | Auto-rekey would force a workspace re-encryption pass which is way out of scope. Surfacing the event lets workspace and UI decide. |
| `user.email` persistence | 3 taste | Persisted in identity storage alongside encryption keys | One identity blob is simpler than splitting display fields from crypto fields. If `email` ever changes server-side, identity refresh picks it up. |
| `AuthState.session` shape | 2 coherence | Removed | `Session` as a runtime handle no longer makes sense once identity moves out. Apps compose what they need. |
| Two-phase startSignIn ergonomics | Deferred | App-driven for now | Could be smoothed with a higher-level `createSignedInLifecycle({ auth, identity })` helper. Defer until the rough API has real consumers. |

## Type contracts

### Auth package (after)

```ts
// packages/auth/src/auth-types.ts
export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken: 'string',
  refreshToken: 'string',
  accessTokenExpiresAt: 'number',
});
export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

// (WorkspaceIdentity and AuthUser are gone from this package)

// packages/auth/src/auth-contract.ts
export type AuthState =
  | { status: 'signed-in' }
  | { status: 'reauth-required' }
  | { status: 'signed-out' };

export type AuthClient = {
  state: AuthState;
  onStateChange(fn: (state: AuthState) => void): () => void;
  startSignIn(): Promise<Result<undefined, AuthError>>;
  signOut(): Promise<Result<undefined, AuthError>>;
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
  [Symbol.dispose](): void;
};

export type OAuthTokensStorage = {
  get(): OAuthTokenGrant | null;
  set(value: OAuthTokenGrant | null): void | Promise<void>;
};
```

### Workspace identity (new)

```ts
// packages/workspace/src/identity/identity-types.ts
import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

export const AuthUser = type({
  '+': 'delete',
  id: 'string',
  email: 'string',
});
export type AuthUser = typeof AuthUser.infer;

export const WorkspaceIdentity = type({
  '+': 'delete',
  user: AuthUser,
  encryptionKeys: EncryptionKeys,
});
export type WorkspaceIdentity = typeof WorkspaceIdentity.infer;

// packages/workspace/src/identity/identity-storage-contract.ts
export type WorkspaceIdentityStorage = {
  get(): WorkspaceIdentity | null;
  set(value: WorkspaceIdentity | null): void | Promise<void>;
  /**
   * Optional cross-context broadcast. When the adapter supports it
   * (localStorage `storage` event, chrome.storage.onChanged), the
   * identity store wires this to a tab-sync listener so other tabs
   * pick up writes. Bun.secrets is single-process; node-side adapters
   * omit this field.
   */
  subscribe?(fn: (next: WorkspaceIdentity | null) => void): () => void;
};

// packages/workspace/src/identity/create-workspace-identity-store.ts
export type WorkspaceIdentityState =
  | { status: 'attached'; identity: WorkspaceIdentity }
  | { status: 'loading';  identity?: WorkspaceIdentity }
  | { status: 'detached' };

export type IdentityFetcher = (input: {
  fetch: typeof globalThis.fetch;
  baseURL: string;
}) => Promise<Result<WorkspaceIdentity, IdentityError>>;

export type WorkspaceIdentityStore = {
  state: WorkspaceIdentityState;
  onStateChange(fn: (state: WorkspaceIdentityState) => void): () => void;
  attach(opts?: { useCache?: boolean }): Promise<Result<WorkspaceIdentity, IdentityError>>;
  refresh(): Promise<Result<WorkspaceIdentity, IdentityError>>;
  detach(): Promise<void>;
  require(): WorkspaceIdentity;
  [Symbol.dispose](): void;
};

export function createWorkspaceIdentityStore({
  identityStorage,
  fetch,
  baseURL,
  fetchIdentity,
}: {
  identityStorage: WorkspaceIdentityStorage;
  /** Pass `auth.fetch` so requests carry the bearer + 401-retry. */
  fetch: typeof globalThis.fetch;
  /** API base, e.g. EPICENTER_API_URL. */
  baseURL: string;
  /**
   * Override the identity-fetch implementation. Defaults to a GET
   * against `${baseURL}/workspace-identity` and parses with
   * `WorkspaceIdentity.assert`. Tests pass a stub; node passes the
   * default. See Open Question #9.
   */
  fetchIdentity?: IdentityFetcher;
}): WorkspaceIdentityStore;
```

Lifecycle contract:

* `auth.fetch` references are stable for the lifetime of the `AuthClient`. They keep working across `Symbol.dispose` *only* until disposal; once `auth[Symbol.dispose]()` runs, the bound `auth.fetch` may still resolve but with stale state. Disposal order: identity store must dispose *before* auth, because identity reads through `auth.fetch`. Apps are responsible for ordering disposal (mirrors today's `import.meta.hot.dispose` pattern in `apps/*/src/lib/platform/auth/auth.ts`).
* `subscribe` (if provided by the storage adapter) is registered during `createWorkspaceIdentityStore` and unregistered in `[Symbol.dispose]`.

### Error types

```ts
// packages/workspace/src/identity/identity-errors.ts
import {
  defineErrors,
  extractErrorMessage,
  type InferErrors,
} from 'wellcrafted/error';
import type { EncryptionKeys } from '@epicenter/encryption';

export const IdentityError = defineErrors({
  /** Network or HTTP-level failure reaching /workspace-identity. */
  FetchFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to fetch workspace identity: ${extractErrorMessage(cause)}`,
    cause,
  }),
  /** Server returned a non-2xx (401/403/5xx) we cannot recover from. */
  HttpStatus: ({ status }: { status: number }) => ({
    message: `/workspace-identity returned ${status}.`,
    status,
  }),
  /** Response body did not match WorkspaceIdentity shape (arktype assert failed). */
  ResponseInvalid: ({ cause }: { cause: unknown }) => ({
    message: `Workspace identity response failed validation: ${extractErrorMessage(cause)}`,
    cause,
  }),
  /** Storage read or write failed (localStorage quota, keychain unavailable). */
  StorageFailed: ({ cause }: { cause: unknown }) => ({
    message: `Workspace identity storage failed: ${extractErrorMessage(cause)}`,
    cause,
  }),
  /** Attach called before tokens are present (auth.state is 'signed-out'). */
  NoTokensAvailable: () => ({
    message: 'Cannot attach workspace identity: no auth tokens available.',
  }),
  /** /workspace-identity returned a different user than the cached one. */
  UserMismatch: ({
    beforeUserId,
    afterUserId,
  }: {
    beforeUserId: string;
    afterUserId: string;
  }) => ({
    message:
      `Workspace identity changed user (${beforeUserId} -> ${afterUserId}). ` +
      `Sign out before attaching a different user.`,
    beforeUserId,
    afterUserId,
  }),
  /** Server rotated the encryption keyring; carried as a Result variant on refresh. */
  KeyRotationDetected: ({
    before,
    after,
  }: {
    before: EncryptionKeys;
    after: EncryptionKeys;
  }) => ({
    message: 'Encryption keys rotated server-side.',
    before,
    after,
  }),
});
export type IdentityError = InferErrors<typeof IdentityError>;
```

Variant coverage check against lifecycle flows (Pass 3):

| Lifecycle flow | Variant |
| --- | --- |
| Network offline during attach | `FetchFailed` |
| 401 / 403 (auth dropped between fetch and identity load) | `HttpStatus` |
| Server returns malformed JSON / wrong shape | `ResponseInvalid` |
| `identityStorage.set` throws (quota, keychain) | `StorageFailed` |
| `attach()` called with `auth.state === 'signed-out'` | `NoTokensAvailable` |
| Same-user guard catches an identity swap | `UserMismatch` (moved from auth's `replaceSession`) |
| `/workspace-identity` returns rotated `encryptionKeys` | `KeyRotationDetected` |

`KeyRotationDetected` is **not a hard error**: the new identity is still valid and the store commits it. Surfacing it as a `Result.error` variant on `refresh()` lets the caller distinguish "no-op refresh" from "successful rotation" without a second event channel. Asynchronous in-store discoveries (background refresh, tab-sync) use a separate `onKeyRotation(fn)` subscription. See Open Question #4.

## Storage model

| Concern | Type | Browser storage (default) | Node storage | Notes |
| --- | --- | --- | --- | --- |
| Tokens | `OAuthTokenGrant` | `createPersistedState` over `localStorage` (parity with today, key `<app>.auth.tokens`) | `Bun.secrets`, service `epicenter.auth.tokens`, name `current` | `accessToken` ~1h, `refreshToken` longer; both are bearer-equivalent until expiry. |
| Identity | `WorkspaceIdentity` | `createPersistedState` over `localStorage` for the v1 ship (key `<app>.workspace.identity`); pluggable for IndexedDB later | `Bun.secrets`, service `epicenter.workspace.identity`, name `current` | Larger payload (one `EncryptionKey` per server-side secret version). Durable across browser sessions. |

Storage adapters are pluggable per the existing `OAuthSessionStorage` precedent. The default-ship configuration is "two adapters, same backend": identical durability to today, with the bundled-write coupling broken so a future move (HttpOnly cookie for tokens, IndexedDB for identity) only requires swapping one adapter. Open Question #5 captures the security-storage upgrade path.

The browser tab manager uses `chrome.storage.local` instead of `localStorage` (key `local:auth.session` today, splitting to `local:auth.tokens` and `local:workspace.identity`). The contract is the same `OAuthTokensStorage` / `WorkspaceIdentityStorage` shape; the adapter implementation is what changes per app.

### Migration of existing blobs: clean break

Existing persisted `OAuthSession = { tokens, identity }` blobs live in:

* browser/extension: `<app>.auth.session` keys via `createPersistedState` / `chrome.storage.local`
* node/machine: `epicenter.auth.session:current` in OS keychain

**Decision**: clean break everywhere. New code reads only the new keys (`<app>.auth.tokens` and `<app>.workspace.identity`; node keychain services `epicenter.auth.tokens` and `epicenter.workspace.identity`). Old blobs are stranded and ignored. Pre-launch product, login-only UX (epicenter_login_only_ux memory); one forced sign-in across the tester pool is acceptable. No migration shim, no fallback read paths, no schema-tolerant load. If existing testers hit a "please sign in again" prompt, that is the entire migration cost.

This applies to machine auth too: `loadMachineSession` / `saveMachineSession` are deleted, not renamed. The new machine path stores tokens and identity in separate keychain entries with new service names, and there is no read from the old one.

## Implementation plan

> **[SUPERSEDED: do not start.]** This plan is retained as historical record. The work below is replaced by the two successor specs cited at the top of this document. In particular: Phase 1 (workspace identity package) is rejected by the `id_token` spec; Phase 2 (auth shrink to tokens-only with `identity` removed from `AuthState`) is rejected by the `id_token` spec's revert of that change; Phase 2.3 / 3 (CLI consolidation on `/workspace-identity`) is replaced by the OOB spec.

Follows Build, Prove, Remove.

### Phase 1 (Build): workspace identity package

* [ ] **1.1** Add `packages/workspace/src/identity/` directory with the new types: `AuthUser`, `WorkspaceIdentity`, `OAuthTokensStorage` (re-export from auth), `WorkspaceIdentityStorage`, `WorkspaceIdentityState`, `WorkspaceIdentityStore`.
* [ ] **1.2** Implement `createWorkspaceIdentityStore` with `attach`, `refresh`, `detach`, `require`, `state`, `onStateChange`. Single-flight on the in-flight fetch the way `createOAuthAppAuth` single-flights refresh.
* [ ] **1.3** Implement `IdentityError` variants including `UserMismatch` and `KeyRotationDetected`.
* [ ] **1.4** Implement `requireIdentity(store)` accessor parallel to today's `requireSession`.
* [ ] **1.5** Implement default identity storage adapters: an IndexedDB-backed adapter (browser) and a `Bun.secrets`-backed adapter (node, exported from `@epicenter/workspace/node`).
* [ ] **1.6** Unit tests for the store: attach happy path, attach with cached identity, refresh-detects-rotation, user-mismatch guard, detach clears storage, single-flight on attach.
* [ ] **1.7** Re-export new symbols from `@epicenter/workspace` and `@epicenter/workspace/node`.

### Phase 2 (Build): auth package shrink (clean break, no parallel old/new factories)

* [ ] **2.1** Replace `OAuthSessionStorage` with `OAuthTokensStorage`. Same `{ get, set }` shape; persists `OAuthTokenGrant` not `OAuthSession`. Type renamed; no compatibility re-export.
* [ ] **2.2** Rewrite `createOAuthAppAuth` in place to be tokens-only. `state` becomes `{ status: 'signed-in' | 'reauth-required' | 'signed-out' }` with no `identity`. No alternate factory; the old shape is gone.
* [ ] **2.3** Rewrite the node machine-auth path to use `loadMachineTokens` / `saveMachineTokens`. Delete `loadMachineSession` / `saveMachineSession`. The new path hits `${baseURL}/workspace-identity` (Pass 2 finding #2 + Decisions log), so the better-auth `getSession` dependency on the node side is removed.
* [ ] **2.4** Unit tests rewritten against the new factory: refresh writes tokens only, sign-in produces tokens (not identity), state has no `identity` field.

### Phase 3 (Build): app adoption (one app at a time)

For each app under `apps/`:

* [ ] **3.x** Replace `createOAuthAppAuth({ sessionStorage })` with `createOAuthAppAuth({ tokensStorage })`.
* [ ] **3.x** Add `createWorkspaceIdentityStore({ identityStorage, fetch: auth.fetch })`.
* [ ] **3.x** Wire `auth.onStateChange` to drive `identity.attach()` / `identity.detach()`.
* [ ] **3.x** Update components reading `auth.state.session.user` / `.encryptionKeys` to read from `identity.state.identity` (or via the moved `requireIdentity`).
* [ ] **3.x** App-specific tests: cold-boot with cached identity, sign-in adds tokens then identity in order.

Apps to convert (verified via `grep -rln "createOAuthAppAuth\|createMachineAuthClient"`):

```
Browser apps (createOAuthAppAuth from @epicenter/auth-svelte):
  apps/fuji/src/lib/platform/auth/auth.ts
  apps/honeycrisp/src/lib/platform/auth/auth.ts
  apps/opensidian/src/lib/platform/auth/auth.ts
  apps/zhongwen/src/lib/platform/auth/auth.ts
  apps/dashboard/src/lib/platform/auth/auth.ts
  apps/tab-manager/src/lib/session.svelte.ts  (built inside whenReady gate)

Node device-code (machineAuth.* from @epicenter/auth/node):
  packages/cli/src/commands/auth.ts

Daemon/script blocks (createMachineAuthClient + requireSession):
  apps/fuji/blocks/daemon-route.ts
  apps/honeycrisp/blocks/daemon-route.ts
  apps/honeycrisp/blocks/script.ts
  apps/opensidian/blocks/daemon-route.ts
  apps/opensidian/blocks/script.ts
  apps/zhongwen/blocks/daemon-route.ts
  apps/zhongwen/blocks/script.ts

UI consumers of state.identity / requireIdentity:
  apps/dashboard/src/routes/(signed-in)/+layout.svelte:29
  apps/zhongwen/src/routes/(signed-in)/+page.svelte:73
  packages/svelte-utils/src/account-popover/account-popover.svelte:160
  packages/svelte-utils/src/session.svelte.ts:43
```

`whispering` does not currently consume `@epicenter/auth` and is out of scope for this refactor. Earlier drafts listed it by analogy with the other Svelte apps; verification (`grep -rln "@epicenter/auth" apps/whispering`) returned no matches.

### Phase 4 (Prove): wave-wide validation

* [ ] **4.1** Whole-monorepo `bun run typecheck` green.
* [ ] **4.2** `bun test` green per package.
* [ ] **4.3** Browser smoke per app: cold boot signed-in, sign-out, sign-in, force reauth via 401, restore.
* [ ] **4.4** CLI smoke: `epicenter auth login`, `epicenter auth status`, `epicenter auth logout`.

### Phase 5 (Remove): finalize the clean break

Most of the deletions happen in Phase 2 (the rewrite *is* the removal: no parallel old/new path). Phase 5 captures any straggler exports the rewrite missed.

* [ ] **5.1** Confirm `OAuthSession`, `WorkspaceIdentity`, `AuthUser`, `Session` are absent from `packages/auth/src/auth-types.ts` and `auth-contract.ts`.
* [ ] **5.2** Confirm `require-session.ts` and `require-identity.ts` are removed from `packages/auth/`. (Both move; `requireSession`-style sugar can be reborn at the workspace layer if call sites still want a single bundle.)
* [ ] **5.3** Confirm `loadMachineSession` / `saveMachineSession` symbols are absent.
* [ ] **5.4** Verify `index.ts` and `node.ts` exports point only at the new surface.
* [ ] **5.5** Final-pass grep: no file inside `packages/auth/` references `encryptionKeys`, `AuthUser`, or `WorkspaceIdentity`.

## Edge cases

### Tokens present, identity missing on cold boot

```txt
1. createOAuthAppAuth finds tokens in storage; auth.state = 'signed-in'.
2. createWorkspaceIdentityStore finds nothing in storage; identity.state = 'detached'.
3. App's onStateChange handler observes signed-in and triggers identity.attach().
4. attach() fetches /workspace-identity; transitions to attached.
5. UI gated on identity.state.status === 'attached' renders.
```

Failure mode: if the fetch fails (network offline), identity stays detached. App shows a "loading identity" state with retry. Tokens are valid; just no decrypted workspace yet.

### Identity present, tokens missing on cold boot

```txt
1. tokens missing -> auth.state = 'signed-out'.
2. identity stored from a previous session is stale.
3. App's onStateChange handler observes signed-out and triggers identity.detach().
4. UI shows sign-in screen.
```

The store of stale identity data is briefly visible during init. Apps should not render identity-dependent UI until they have confirmed `auth.state.status !== 'signed-out'`.

### `/workspace-identity` returns rotated encryption keys

```txt
1. identity.refresh() (or .attach() with useCache: false) fetches new identity.
2. store compares cached vs returned encryptionKeys.
3. If different: identity.state still updates to 'attached', but onStateChange
   subscribers receive an additional KeyRotationDetected event (Result-error
   surface or separate event channel; see Open Questions).
4. App decides: retry workspace decryption with new keys, warn user, or
   force re-sign-in.
```

### `/workspace-identity` returns a different user

```txt
1. identity.refresh() detects user.id mismatch against cached.
2. attach() returns Result.error(UserMismatch).
3. identity.state stays at its previous value; cached identity is NOT overwritten.
4. App must call signOut() to clear, then sign in again.
```

This is the moved-from-auth same-user guard.

### Sign-out while identity attach is in-flight

```txt
1. auth.signOut() runs; auth.state -> 'signed-out'.
2. identity.attach() is mid-fetch; its single-flight in-flight resolves.
3. App's onStateChange handler calls identity.detach().
4. Whichever resolves last wins. detach() must check state.status before
   transitioning (idempotent: detach over detach is a no-op).
```

Race resolution: the identity store should drop the in-flight attach result if a detach has happened during the fetch. Single-flight + epoch counter, mirroring `createOAuthAppAuth`'s `sessionEpoch`.

### Browser tab opens during sign-in flow

If two tabs are open and one signs in:

```txt
1. tab A signs in; auth.tokensStorage and workspace.identityStorage both
   updated. (createPersistedState broadcasts on `storage` event for
   localStorage-backed adapters by default; see Research finding #5.)
2. tab B's auth.state listener fires; auth.state -> 'signed-in'.
3. tab B's identity.state listener fires; identity.state -> 'attached'.
4. tab B's UI updates.
```

Caveats:

* `sessionStorage`-backed adapters do *not* cross-tab broadcast. If we ever move tokens to `sessionStorage` for the security split, the auth state will not propagate to other tabs without a `BroadcastChannel` shim. Out of scope today; explicit prereq if Open Question #5 ever flips to a non-`localStorage` adapter for tokens.
* The tab-manager extension uses `chrome.storage.local` via `createStorageState` (`apps/tab-manager/src/lib/state/storage-state.svelte.ts`). `chrome.storage.onChanged` fires across all extension contexts (popup, side panel, service worker), so the cross-context behavior is the same shape, but the implementation is not `createPersistedState`. The contract still holds: writes propagate.
* `Bun.secrets` is single-process; node-side this question does not apply.

## Lifecycle stress-test (Pass 3)

Each lifecycle diagram in the section above was walked against the actual code paths that would implement it. This subsection records the holes found and how each is resolved.

### A. Sign-in race: tokens-present without identity

Diagram step 2 (sign-in → app's `onStateChange` handler fires `identity.attach()`) is a deferred operation. Between `auth.state` flipping to `signed-in` and the handler resolving, any consumer reading `auth.state.status` could observe "signed in" with no identity.

```
auth.startSignIn() resolves
     │
     │  (microtask)
     ▼
auth.state: signed-out -> signed-in
     │
     │  (subscribers fire synchronously inside auth-state-store.ts)
     ▼
app's auth.onStateChange runs
     │
     │  identity.attach()  (async I/O: /workspace-identity)
     ▼
identity.state: detached -> attached
```

Resolution (already in spec, made explicit here):

* **UI must not gate on `auth.state.status === 'signed-in'`.** It must gate on `identity.state.status === 'attached'`. The "signed-in + detached" window is the cold-boot edge case (`Tokens present, identity missing`) and is the same shape as the sign-in transitional window.
* Apps that today read `auth.state.identity` (browser layout, account popover) update to read `identity.state.identity`; if the store is detached they fall back to a "loading workspace" UI, not a render-with-undefined.

This is a Class 2 coherence point: the spec's invariant D ("tokens-present implies identity-present") is being dropped *intentionally*, and every UI gate needs to be retrained. New Phase 3 step added.

### B. Cold-boot mismatch: cached identity for the wrong user

Storage today is keyed per-app (e.g., `fuji.auth.session`), not per-user. If two users share one OS account (or one browser profile), nothing prevents tokens for user A landing next to identity for user B. The new `replaceSession` same-user guard kicks in *only* at sign-in time, against the *cached* identity. If the cache and the tokens already disagree at cold boot, the guard never fires.

Resolution:

* `WorkspaceIdentityStore` adds a "trust on read" check: on cold boot, store loads cached identity and treats it as authoritative until `attach({ useCache: false })` runs. If `attach` later returns a different `user.id`, that is the `UserMismatch` path.
* The store does NOT cross-check `cached.user.id` against the auth tokens; auth doesn't expose user id (that's the whole refactor). The store only knows that the tokens, whatever user they belong to, must agree with whichever identity comes back from the server.
* **New explicit decision (Class 1 evidence):** identity storage stays single-tenant per origin. Multi-user-per-origin requires a different storage key scheme (e.g., `<app>.workspace.identity:<userId>` with a "current user id" pointer). Out of scope. Worth an Open Question for tracking; not solving now.

Added Open Question #11.

### C. Sign-out during attach: epoch counter portability

The auth library's `sessionEpoch` (`create-oauth-app-auth.ts:71, 98, 129, 141, 147`) increments on every `replaceSession` / `signOut` call, and any in-flight refresh checks `startedAt === sessionEpoch` before committing. The pattern ports directly to the identity store:

```ts
// in createWorkspaceIdentityStore:
let identityEpoch = 0;
let inFlightAttach: Promise<...> | null = null;

async function attach(opts) {
  const startedAt = ++identityEpoch;
  inFlightAttach = (async () => {
    const result = await fetchIdentity(opts);
    if (startedAt !== identityEpoch) return /* dropped */;
    // ...commit to state + storage
  })();
}

async function detach() {
  ++identityEpoch;
  // ...clear state + storage
}
```

No new concurrency primitive required. Y.Doc lifecycle is irrelevant here because the identity store does not own a Y.Doc; the workspace document layer does, and it is the *consumer* of identity, not a peer participant in identity's own concurrency.

### D. Reauth + key rotation timing

The spec separates `auth.fetch` 401 recovery from `identity.refresh()`. Trace:

```
   t0      auth.fetch hits 401, refresh fails terminally
   t1      auth.state -> 'reauth-required' (identity unchanged)
   t2      app prompts reauth; user re-signs-in via auth.startSignIn
   t3      auth.state -> 'signed-in' (new tokens, same refresh-token rotation)
   t4      app's onStateChange runs identity.refresh()
   t5      /workspace-identity returns;
              user.id matches cached? -> commit, possibly emit KeyRotationDetected
              user.id mismatch?       -> UserMismatch error, identity stays as-is
```

Observation: between t3 and t5 the workspace is rendering against *stale* identity (the keys cached before the rotation). That window is the same as the cold-boot "signed-in + attached cache" window. If the user encrypts a write during that window with the old key, server-side that write is a v(N-1) blob; the rotation event at t5 lets the workspace decide whether to rewrite that blob. **This is not a regression**: today, identity is captured at sign-in and never re-fetched, so the stale window is "forever until next sign-in." The new design strictly improves freshness.

Spec made this explicit (was previously implied by Invariant E).

### E. Tab sync edge case

Covered in the Edge case section above and Research finding #5. The honest framing: tab sync is a property of the storage adapter, not the identity store. The store relies on its `WorkspaceIdentityStorage` to notify on external writes (the same way `createPersistedState` listens for `storage` events today). Identity store needs a `subscribe(fn)` hook on the storage contract, OR it has to poll on focus.

```ts
export type WorkspaceIdentityStorage = {
  get(): WorkspaceIdentity | null;
  set(value: WorkspaceIdentity | null): void | Promise<void>;
  subscribe?(fn: (next: WorkspaceIdentity | null) => void): () => void;
};
```

Added to the type contract. `subscribe` is optional; when present (browser adapter), tab-B picks up tab-A's writes. When absent (Bun.secrets), no cross-process sync.

## Plan feasibility (Pass 4)

Verified against the live tree at commit `a3213ab7f`. Each item is a prerequisite or call-site fact that the implementation plan depends on.

### `packages/workspace/src/identity/` layout

`packages/workspace/src/` already has these top-level directories: `__benchmarks__/`, `__tests__/`, `ai/`, `cache/`, `client/`, `daemon/`, `document/`, `shared/`. No collision with `identity/`. Phase 1.1 can create it as a peer directory.

The workspace barrel (`packages/workspace/src/index.ts`) does NOT currently re-export from `daemon/` or `client/` directly; those have their own subpath exports (`@epicenter/workspace/daemon`, etc.). Identity types do want to be on the root barrel (they're consumed from Svelte and DOM, not just from server/daemon). Phase 1.7 plan stays as written.

### `@epicenter/workspace/node` subpath

Confirmed: `packages/workspace/package.json` exports include `"./node": "./src/node.ts"`. Adding `keychain-identity-storage.ts` and exporting from `src/node.ts` requires no new package.json change.

### Existing identity consumer in workspace already

`packages/workspace/src/document/local-owner.ts:27-32`:

```ts
export function createLocalOwner({
  userId,
  encryptionKeys,
}: {
  userId: string;
  encryptionKeys: () => EncryptionKeys;
}) { ... }
```

`createLocalOwner` is the existing identity-scoped facade. It takes a lazy `encryptionKeys` callback (so rotations are picked up at read time) plus the active `userId`. After this refactor, the wiring becomes:

```
WorkspaceIdentityStore.state.identity   ────►   createLocalOwner({
                                                  userId: identity.user.id,
                                                  encryptionKeys: () =>
                                                    store.require().encryptionKeys,
                                                })
```

This is the **strongest evidence** that the workspace package is the right home (Open Question #1). The identity-scoped abstraction already lives in workspace; the new store is the thing that supplies it.

### Browser/UI consumers of `state.identity`

Grep `state\.identity` across non-test source:

```
apps/dashboard/src/routes/(signed-in)/+layout.svelte:29
packages/svelte-utils/src/account-popover/account-popover.svelte:160
packages/svelte-utils/src/session.svelte.ts:42-43
packages/auth/src/require-identity.ts:14   (auth-internal; deleted)
packages/auth/src/auth-state-store.ts:42,51,63   (auth-internal; rewritten)
```

3 external read sites (dashboard layout, account popover, svelte-utils session). All become reads against `identity.state.identity` after the move; each is a one-line change.

### Daemon/script consumers of `requireSession`

```
apps/fuji/blocks/daemon-route.ts:43
apps/honeycrisp/blocks/script.ts:26
apps/honeycrisp/blocks/daemon-route.ts:28
apps/opensidian/blocks/script.ts:26
apps/opensidian/blocks/daemon-route.ts:24
apps/zhongwen/blocks/script.ts:30
apps/zhongwen/blocks/daemon-route.ts:28
```

7 call sites; all daemon/script entry points. Each uses the bundle `{ user, encryptionKeys, fetch, openWebSocket }` to start a workspace runtime. They become callers of a workspace-side `requireSession(identityStore, auth)` helper that composes `identityStore.require()` + `auth.fetch` + `auth.openWebSocket`. Helper lives in `@epicenter/workspace`'s node subpath since these are all node/daemon callers.

### `api/src/asset-routes.ts` and `api/src/billing-routes.ts`

Mentions of "requireSession" in those files are server-side middleware comments referring to an Elysia/Hono auth gate, NOT the client-side `requireSession` from `@epicenter/auth`. Unrelated namespace collision; out of scope for this refactor.

### Phase 4 / smoke targets

```
typecheck: bun run typecheck (monorepo root via Turborepo)
test:      bun test (per package)
CLI smoke: epicenter auth login / status / logout
           (packages/cli/src/commands/auth.ts:28-89)
Browser:   fuji, honeycrisp, opensidian, zhongwen, dashboard, tab-manager
           Each has a (signed-in) route group; smoke is route entry +
           sign-out + reauth-via-401.
```

`whispering` is excluded (does not use `@epicenter/auth`; verified by grep).

## Open questions

1. **Should this live in `@epicenter/workspace` or a new `@epicenter/identity` package?**
   * Options: (a) fold into workspace, (b) new tiny `@epicenter/identity` package consumed by workspace.
   * **Recommendation**: (a) workspace. Identity is consumed only by workspace decryption today. A separate package adds a workspace coordination layer without removing dependence. Revisit if a second consumer (e.g., billing) appears.

2. **Two-phase ergonomics: is `auth.onStateChange` wiring boilerplate that every app rewrites?**
   * Options: (a) leave app-driven; (b) higher-level `createSignedInLifecycle({ auth, identity })` helper that owns the wiring; (c) auto-attach inside the identity store if you pass it the `AuthClient` instead of a `fetch`.
   * **Recommendation**: defer. Ship (a); upgrade to (b) or (c) once 2-3 apps have real implementations and the boilerplate pattern is visible.

3. **`identity.state.status` enum: do we need `loading`?**
   * Options: (a) two states (`attached`, `detached`); (b) three states (`attached`, `loading`, `detached`); (c) reuse auth's `reauth-required` pattern.
   * **Recommendation**: (b) three states, but `loading` always carries cached identity if available so consumers can keep rendering during refresh. Mirrors how the auth lib's `reauth-required` carries `Session` for the same UX reason.

4. **Key rotation event channel: error result or separate event?**
   * Options: (a) `Result.error(KeyRotationDetected)` so callers handle it inline; (b) a separate `onKeyRotation(fn)` subscription; (c) emit a state transition with a `rotated: true` flag.
   * **Recommendation**: (a) for the `refresh()` return value (caller wants to know synchronously), plus (b) for asynchronous in-store discoveries (e.g., if `refresh()` was triggered by a background timer rather than user action).

5. **Should identity storage on browser be IndexedDB or `createPersistedState` over `localStorage`?**
   * Options: (a) IndexedDB (durable, larger, transactional); (b) `localStorage` via existing `createPersistedState` (simpler, smaller, sync, XSS-readable).
   * **Recommendation**: (a) IndexedDB for the security improvement that motivated this whole spec. But: ship (b) first to keep the migration single-concern, and add an IndexedDB adapter as a follow-up. The contract is pluggable, so swapping the storage backend later is a one-line app change.

6. **Should `WorkspaceIdentity` move with `EncryptionKeys` into `@epicenter/workspace`, or stay where it is?**
   * `EncryptionKeys` currently lives in `@epicenter/encryption`. `WorkspaceIdentity` references it.
   * Options: (a) keep `EncryptionKeys` in `@epicenter/encryption`; identity store imports it; (b) move `EncryptionKeys` into workspace too.
   * **Recommendation**: (a). The encryption package is a primitive shared by other crypto consumers (filesystem, future plugins). Don't fold it.

7. **Auth `state` shape: do we keep an object wrapper or use a bare string?**
   * Options: (a) `state: { status: 'signed-in' | ... }`; (b) `state: 'signed-in' | ...`.
   * **Recommendation**: (a). Leaves room for future fields (e.g., `lastRefreshAt`, `tokenExpiresIn`) without an API break, and is closer to discriminated-union ergonomics.

8. **Migration: do we ship a shim that reads old blobs and splits them, or just force re-sign-in?**
   * **Recommendation**: force re-sign-in (see Decision Hygiene). Revisit if user count grows before this lands. The shim is ~20 lines but the testing surface is non-trivial across browser, extension, and Bun.secrets.

9. **CLI identity-fetch endpoint after consolidation.**
   * Pass 2 finding #2 decided we consolidate node + browser identity onto `/workspace-identity`. But which side spells the call?
   * Options: (a) `createWorkspaceIdentityStore` *always* calls `${baseURL}/workspace-identity`, regardless of platform; (b) the store accepts an injected `identityFetcher` so test/node/browser can each substitute.
   * **Recommendation**: (b) for testability (mirrors today's `refreshOAuthToken` / `revokeOAuthRefreshToken` injection points in `create-oauth-app-auth.ts:41-50`). Default is the `/workspace-identity` HTTP call; tests pass a stub; node passes the same default.

10. **Multi-user-per-origin support.**
    * Today's storage keys are per-app, not per-user (e.g., `fuji.auth.session`). Two users sharing one OS account or browser profile cannot both stay signed in.
    * Options: (a) keep single-tenant (one user at a time per origin); (b) key identity storage by `userId` with a "current user id" pointer.
    * **Recommendation**: (a) for now. Login-only UX (epicenter_login_only_ux memory) does not promise multi-user. Revisit when a multi-account product surface lands.

## Research findings (Pass 2)

Each item below is a claim the spec depended on, the verification source, and how the spec text was updated (or left intact) once the answer came back.

### 1. Better Auth device-code response shape

Claim under test: the CLI's device-code path reads `access_token`, `refresh_token`, `expires_in` from `device.token`. Spec needed to confirm those fields exist.

Source: DeepWiki Q to `better-auth/better-auth`.

Answer (summarized):

```
device.token success body (per RFC 8628 + better-auth tests):
  access_token, token_type ("Bearer"), expires_in, scope.
  refresh_token issued by the underlying oauth-provider when
  offline_access scope is granted (we already do, see
  apps/api/src/auth/create-auth.ts:184-188).

Refresh-token rotation: rotates by default; if a refresh
response omits refresh_token, better-auth's account layer
falls back to the prior token (matches our own browser
fallback at create-oauth-app-auth.ts:319-320).
```

Action: confirmation only. We're taking a clean break on machine auth (see Decisions log); the spec does not need to preserve the old device-code edge handling. New machine path requires `offline_access` and fails loud if the response is malformed. No backwards-compatibility behavior carried forward.

### 2. `authClient.getSession()` shape and `/workspace-identity` divergence

Claim under test: spec assumed there is one canonical "fetch identity" endpoint. Reality: there are two, and they disagree.

Source: DeepWiki Q + on-disk reads of `apps/api/src/app.ts:238-252` and `apps/api/src/auth/create-auth.ts:31-32`.

Answer:

```
/auth/get-session (better-auth, used by node device-code path
                   in machine-auth.ts:fetchOAuthSession):
  { session, user }
  No encryptionKeys. The API doesn't use customSession.

/workspace-identity (Epicenter, used by browser auth in
                     create-oauth-app-auth.ts:loadIdentity):
  { user, encryptionKeys }   (WorkspaceIdentity shape)
  Returned by resolveBearerIdentity in resource-boundary.ts:103.

create-auth.ts comment confirms intent:
  "/workspace-identity is the single Epicenter identity surface;
   this builder no longer enriches /auth/get-session with
   encryption keys."
```

Action:

* This is a real bug or pending migration in `machine-auth.ts:fetchOAuthSession` (lines 298-323). It calls `authClient.getSession()` and `WorkspaceIdentity.assert(data)`, but the server now returns `{ user, session }` without `encryptionKeys`. With arktype `'+': 'delete'` shallow-stripping (see finding #3), the assert fails because `encryptionKeys` is required. The path either: (a) is broken against current production, or (b) is exercised only by the in-repo fake authClient (`machine-auth.test.ts:111-120`) which can return any shape.
* **Spec decision (Class 2)**: this refactor *consolidates* the CLI device-code identity fetch onto the same `/workspace-identity` endpoint the browser uses. The CLI's `fetchOAuthSession` becomes an `identityFetcher` against `${baseURL}/workspace-identity` with `Authorization: Bearer ${accessToken}`. This deletes the better-auth `getSession` dependency on the node side and unifies the source of truth.
* Added to Decisions log; updated Phase 2 implementation plan and Open Questions.

### 3. arktype `'+': 'delete'` recursion

Claim under test: the `OAuthSession` schema strips unknown keys at all levels because `tokens` and `identity` each declare `'+': 'delete'` on their own.

Source: DeepWiki Q to `arktypeio/arktype`.

Answer:

```
'+': 'delete' is shorthand for onUndeclaredKey("delete").

Stripping is SHALLOW by default. Use onDeepUndeclaredKey("delete")
to apply recursively from one place.

If a parent declares '+': 'delete' but a child does not, the parent
strips extras at its own level only; the child preserves them.

In our schemas: OAuthTokenGrant, WorkspaceIdentity, AuthUser, and
OAuthSession all declare '+': 'delete' individually, so the strip
behavior is already correctly applied at every nested level. No
change needed.
```

Action:

* No code change; spec text was loose on this point ("the nested types stripping their own extras"). Made the recursive-via-each-level mechanic explicit so future readers don't assume top-level `'+': 'delete'` propagates.

### 4. IndexedDB XSS-readability

Claim under test: spec's Problem #2 framed IndexedDB as "XSS-resistant" relative to `localStorage`. This is the security claim that motivated the storage-adapter split.

Source: DeepWiki Q to `mdn/content`.

Answer:

```
Same-origin JS can read all of:
  - localStorage
  - sessionStorage
  - IndexedDB

There is no browser storage primitive that hides bearer tokens or
keys from same-origin JS, EXCEPT:
  - HttpOnly cookies (unreadable from JS at all)
  - Service Worker private cache (only reachable via the SW, not
    via document-scope JS)

IndexedDB advantages over localStorage are durability, larger
quota, structured/transactional storage. NOT XSS protection.
```

Action:

* Rewrote Problem #2 to drop the "XSS-resistant" framing. The motivation for splitting storage now reads as: blast-radius reduction (separate adapters can move independently) + unlocking the *future* security move (HttpOnly cookie or service-worker private cache for tokens, IndexedDB for identity).
* Updated Open Question #5 recommendation: ship `localStorage` for both adapters in v1 (matches today, no surprises), and reserve the IndexedDB-for-identity swap for a follow-up driven by storage quota or migration ergonomics, not XSS defense. The actual XSS lever is the HttpOnly-cookie move which is already Out of scope.

### 5. `createPersistedState` cross-tab broadcast

Claim under test: edge case "Browser tab opens during sign-in flow" assumed `createPersistedState` propagates writes between tabs.

Source: on-disk read of `packages/svelte-utils/src/persisted-state.svelte.ts:182-200`.

Answer:

```
createPersistedState registers `window.addEventListener('storage', ...)`
by default (syncTabs: true). The `storage` event fires when
ANOTHER tab writes the same key in localStorage.

sessionStorage does not fire storage events cross-tab. So any
adapter using sessionStorage would silently break the tab-sync
edge case. Today's apps use localStorage for the auth session
adapter, which works.

The extension (tab-manager) uses chrome.storage.local via
createStorageState, which has its own cross-context propagation.
```

Action:

* Spec edge case "Browser tab opens during sign-in flow" kept; added a note that tab-sync is *only* automatic for `localStorage`-backed adapters. If we ever wire an adapter to `sessionStorage` we have to broadcast manually.

## Decisions log

* **Force re-sign-in instead of migration shim.** Constraint: pre-launch product with login-only UX, small tester pool, two storage backends with different failure modes. Revisit when: tester count crosses 50, or if a non-anonymous identity (paying user) lands before this ships.

* **Workspace package home (not new `@epicenter/identity`).** Constraint: identity has exactly one consumer today (workspace decryption). Revisit when: a second consumer needs `WorkspaceIdentity` (billing, plugins, etc.).

* **CLI device-code path now hits `/workspace-identity` instead of `/auth/get-session`.** Constraint: the API server's `/auth/get-session` does not return `encryptionKeys`; only `/workspace-identity` does (see `apps/api/src/auth/create-auth.ts:31-32`). The current `fetchOAuthSession` in `packages/auth/src/node/machine-auth.ts:298-323` would fail to assert `WorkspaceIdentity` against a production response and only works under the in-repo fake authClient. Consolidating both clients on `/workspace-identity` deletes the dependency on better-auth's `getSession` in node and gives the spec one identity endpoint to discuss. Revisit only if a second identity endpoint with different fields appears server-side.

* **Split storage is blast-radius reduction, not XSS defense.** Constraint: same-origin JS can read all browser storage primitives. The XSS lever lives behind HttpOnly cookies / service worker (out of scope). Revisit when: a token-storage migration to one of those primitives lands.

## Implementation outcomes (post-spec)

> The boxes below are deliberately unchecked. They are NOT the spec Done-when (that lives in `## Done when (spec is watertight)` above). They are the exit criteria for the refactor work that this spec authorizes, and remain unchecked until that work is done.

* [ ] `@epicenter/auth` exports no longer contain `WorkspaceIdentity`, `AuthUser`, `OAuthSession`, or `Session`.
* [ ] `@epicenter/auth` `createOAuthAppAuth` accepts `tokensStorage` and writes only token-shaped blobs.
* [ ] `AuthState` is `{ status }` only; the `identity` field is gone from `signed-in` and `reauth-required`.
* [ ] `createWorkspaceIdentityStore` exists in `@epicenter/workspace` with full attach / refresh / detach / require lifecycle.
* [ ] Both browser and CLI device-code paths fetch identity through the same `${baseURL}/workspace-identity` route; no caller of `authClient.getSession()` remains in `packages/auth/`.
* [ ] At least one app exercises the new two-store composition end-to-end (build, sign-in, cold-boot signed-in, sign-out, reauth-required, force-re-attach).
* [ ] All existing auth tests pass against the new shape, OR are rewritten to match.
* [ ] New tests cover: identity rotation surfacing, same-user guard at attach, cold-boot tokens-without-identity, detach-during-attach race, attach-with-no-tokens error.
* [ ] No file inside `packages/auth/` references `encryptionKeys`, `AuthUser`, or `WorkspaceIdentity` (final-pass grep).
* [ ] Bundle size of `@epicenter/auth` measurably smaller (target: at least 20% fewer LOC).

## References

Auth package (today's bundled shape; rewritten by this spec):

* `packages/auth/src/auth-types.ts:4-37` - `AuthUser`, `WorkspaceIdentity`, `OAuthTokenGrant`, `OAuthSession` schemas.
* `packages/auth/src/auth-contract.ts:5-18` - `AuthState` with `identity: WorkspaceIdentity`, and `AuthClient` with bound transport.
* `packages/auth/src/auth-state-store.ts` - notify-on-change pattern to mirror in workspace identity store; `identitiesEqual` and `encryptionKeysEqual` helpers feed the same-user / rotation diff.
* `packages/auth/src/create-oauth-app-auth.ts:56-257` - single `session: OAuthSession | null` cache, `sessionEpoch`, `replaceSession` same-user guard, `loadIdentity` fetch against `/workspace-identity`, `refreshOAuthTokenWithEndpoint` fallback for omitted `refresh_token`.
* `packages/auth/src/node/machine-auth.ts:298-323` - `fetchOAuthSession` currently calls `authClient.getSession()` and asserts `WorkspaceIdentity` on the result; superseded by the consolidated `/workspace-identity` path (Decisions log).
* `packages/auth/src/node/machine-session-store.ts` - `loadMachineSession` / `saveMachineSession`; deleted in Phase 2.3.
* `packages/auth/src/require-identity.ts:10-15` - today's `requireIdentity(auth)`; moves to workspace as `requireIdentity(store)`.
* `packages/auth/src/require-session.ts:17-34` - sugar `Session` bundle for daemon/script callers; rebuilt at the workspace layer.
* `packages/auth-svelte/src/create-auth.svelte.ts` - Svelte adapter that wraps `createOAuthAppAuth` with `$state`; will need a parallel adapter for the identity store.

Encryption and workspace integration:

* `packages/encryption/src/keys.ts:11-30` - `EncryptionKey` / `EncryptionKeys` arktype schemas (versioned, 1-255 byte-cap).
* `packages/encryption/src/keys.ts:58-73` - `encryptionKeysEqual` (used by the rotation diff in the new identity store).
* `packages/encryption/src/derivation.ts` - workspace key derivation; consumes `encryptionKeys`.
* `packages/workspace/src/document/local-owner.ts:27-32` - existing `createLocalOwner({ userId, encryptionKeys: () => ... })`; the wiring sink that consumes the new identity store.
* `packages/svelte-utils/src/session.svelte.ts:21-68` - existing `createSession` Svelte glue that already takes `requireIdentity(auth).encryptionKeys` lazily; the seam where the new store plugs in.

API server:

* `apps/api/src/app.ts:238-252` - `/workspace-identity` route.
* `apps/api/src/auth/resource-boundary.ts:99-114` - `resolveBearerIdentity` (the server-side `WorkspaceIdentity` producer).
* `apps/api/src/auth/create-auth.ts:31-32` - comment confirming `/workspace-identity` is the single identity endpoint.

Storage / persisted state:

* `packages/svelte-utils/src/persisted-state.svelte.ts:101-256` - `createPersistedState` with default cross-tab sync via `storage` event.
* `apps/tab-manager/src/lib/state/storage-state.svelte.ts` - `chrome.storage.local` wrapper used by the extension.

App-side wiring (representative):

* `apps/fuji/src/lib/platform/auth/auth.ts` - representative browser app adapter (before/after pattern is the same for honeycrisp, opensidian, zhongwen, dashboard).
* `apps/tab-manager/src/lib/session.svelte.ts` - extension session built behind a `whenReady` gate.
* `packages/cli/src/commands/auth.ts:28-89` - CLI `auth login/logout/status`.
* `apps/*/blocks/daemon-route.ts` and `apps/*/blocks/script.ts` - daemon/script `requireSession` call sites.

Prior precedent:

* `specs/20260514T071306-collapse-oauth-client-into-auth.md` - prior auth-package consolidation; precedent for moving things between packages without rewriting their internals.
* AGENTS.md - no em dashes, prefer code-and-tree visual style for architecture sections.

## Out of scope

* Server-side `/workspace-identity` endpoint changes. The endpoint stays as-is. This spec only changes client-side ownership of the response.
* Encryption key rotation policy on the server. Surfacing the event client-side is in scope; deciding when to rotate is not.
* `@epicenter/auth-svelte` rework beyond what the new contract requires. A parallel `useIdentity()` helper may be useful but is not in this spec's scope.
* Any change to OAuth ceremony itself: PKCE, device-code, revoke, token endpoint. The launchers are untouched.
* HttpOnly cookie / service worker token storage. The split unblocks this future move but does not deliver it.

## Done when (spec is watertight)

> **[SUPERSEDED.]** This checklist still legitimately reads `[x]` for the verification work that ran against this spec: file paths and line numbers were re-checked against the working tree at commit `a3213ab7f`, type contracts were checked for compilability, and library claims were grounded. It is preserved as historical record. It **no longer gates anything**, because the proposed end state has been retracted in favor of the two successor specs cited at the top of this document. Treat the checks below as "this spec was watertight at the moment it was retired."

* [x] Every file path, type name, and function name in the spec resolves on the current branch (commit `a3213ab7f`). Pass 1 grounding; spec body uses `file.ts:line` references throughout.
* [x] Every protocol / library claim verified via DeepWiki or in-repo source, with a citation in the spec. See `Research findings (Pass 2)`, items 1-5.
* [x] Each of the five lifecycle flows has been mentally executed and strengthened with explicit handling. See `Lifecycle stress-test (Pass 3)`, sections A-E.
* [x] Implementation Plan phases include concrete file paths and call-site counts where applicable. Phase 3 lists all consumers with file paths; `Plan feasibility (Pass 4)` adds counts (3 UI reads, 7 daemon/script `requireSession` callers, 6 browser apps with `createOAuthAppAuth`).
* [x] Open Questions section updated. Old OQs about migration shim and refresh-token tolerance collapsed into clean-break decisions (Decisions log). New OQs surfaced by research: #9 (identity-fetch injection), #10 (multi-user-per-origin). Existing recommendations contradicted by research (XSS-resistance, dual-cache framing) were rewritten in place, not deleted.
* [x] All em/en dash characters removed from the spec. Verified via `grep -P -c '\x{2014}|\x{2013}'` returning 0.
* [x] No paragraph longer than four sentences without a structural break. Audit pass via word-count script; the only outliers are inside fenced code blocks, which are themselves structural breaks.
* [x] `## Decisions log` section captures Class 3 keeps surfaced during research. Four entries: (1) force re-sign-in, (2) workspace package home, (3) CLI consolidation on `/workspace-identity`, (4) storage split as blast-radius reduction (not XSS defense).
* [x] Every `file:line` citation in this spec was re-read against the working tree (Pass 6). All 30+ paths exist (`packages/auth/src/{auth-types,auth-contract,auth-state-store,create-oauth-app-auth,require-identity,require-session,node/machine-auth,node/machine-session-store}.ts`, `packages/encryption/src/keys.ts`, `packages/workspace/src/document/local-owner.ts`, `packages/svelte-utils/src/{session,persisted-state}.svelte.ts`, `apps/api/src/{app,auth/resource-boundary,auth/create-auth}.ts`, `apps/{fuji,honeycrisp,opensidian,zhongwen}/blocks/{daemon-route,script}.ts`, `apps/{dashboard,fuji,honeycrisp,opensidian,zhongwen}/src/lib/platform/auth/auth.ts`, `apps/tab-manager/src/lib/{session,state/storage-state}.svelte.ts`, `packages/cli/src/commands/auth.ts`). All cited line numbers (`create-oauth-app-auth.ts:67,71,87-97,98,110-122,129,141,142-146,147,204,319-320`, `auth-state-store.ts:42,51,63`, `app.ts:238-252`, `resource-boundary.ts:99-114`, `persisted-state.svelte.ts:182-200`, etc.) contain the content the spec attributes to them.
* [x] Type contract snippets compile against the actual dependency surface (Pass 7). Verified: `defineErrors`, `extractErrorMessage`, `InferErrors`, `InferError` all live at `wellcrafted/error` (`node_modules/wellcrafted/dist/error/index.d.ts`); arktype `'+': 'delete'` and `.assert(...)` are the same patterns already used in `packages/auth/src/auth-types.ts`; `EncryptionKeys` is re-exported from the `@epicenter/encryption` barrel; `Bun.secrets` `{ get, set, delete }({ service, name, value? })` matches the existing `machine-session-store.ts` use. Fixed: the `IdentityError` snippet referenced `InferErrors` without importing it; added the `type InferErrors` import to match the existing `auth-errors.ts` pattern.
* [x] Cross-package consumer counts re-derived via grep (Pass 9). `grep -rn 'state\.identity'` returns exactly the four non-test sites the spec lists. `grep -rn 'requireSession'` in `apps/` returns exactly the seven daemon/script call sites the spec enumerates (plus the API-server middleware comments correctly flagged as a namespace collision). `apps/whispering` returns zero matches for `@epicenter/auth`, matching the exclusion note. `tab-manager`'s `local:auth.session` key is the literal string the spec quotes.
* [x] CLI/device-code bug claim verified in code (Pass 11). Read `packages/auth/src/node/machine-auth.ts:298-323` in full: `fetchOAuthSession` calls `authClient.getSession(...)` (line 305), then `WorkspaceIdentity.assert(data)` (line 318). Server `/auth/get-session` returns `{ session, user }` without `encryptionKeys`. arktype `WorkspaceIdentity = type({ '+': 'delete', user, encryptionKeys })` requires `encryptionKeys`, so `assert` would throw `MissingProperty` for `encryptionKeys`. `'+': 'delete'` only strips extras; it does not relax required fields. Conclusion: the spec's "broken against current production" claim in the Decisions log is exact, not editorial. Decisions log #3 fully grounded.
* [x] Svelte adapter wrap pattern verified in code (Pass 12). Read `packages/auth-svelte/src/create-auth.svelte.ts:1-50`: wrapping is via `createSubscriber` from `svelte/reactivity` over `auth.onStateChange`. The "parallel adapter for the identity store" referenced in the References section is a one-function copy of this pattern using `identityStore.onStateChange`. No new dependency, no new pattern.

All boxes above check. This revision pass is complete; the spec is watertight against current `HEAD`.
