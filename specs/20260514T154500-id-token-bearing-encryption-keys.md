# id_token carries encryption keys; delete the /workspace-identity client

**Date**: 2026-05-14
**Status**: **Retracted (2026-05-14)**
**Author**: Braden + Claude

## Retraction

This spec is retracted. Do not implement any part of it.

**Why retracted:**

1. **Trust-model commit (Path B).** Epicenter is honest about its trust model: the hosted product is server-managed encryption (server holds keys; defense against database breach but not against the operator), and self-hosting is the privacy escape hatch ("if you don't trust the server, become the server"). This is the position the existing articles in `docs/articles/` already document. Under that trust model, the existing `/workspace-identity` route is the correct key-delivery channel; there is no need to optimize the delivery into the id_token.

2. **Security regression at the leakage surface.** Moving symmetric encryption keys into id_token claims widens the at-rest leak surface. Sentry/Datadog/Honeycomb default scrubbers strip `access_token` and `refresh_token` but not `id_token` (it's been "public identity claims" by OIDC convention). `jwt.io` paste habits, browser devtools pretty-printing, OIDC SDK auto-storage of decoded claims, and standard logging middleware all treat id_tokens as inspectable. RFC 9700 §2.6 and RFC 8725 §3.11 specifically caution against this.

3. **Architectural novelty without precedent.** No major OIDC provider (Auth0, Okta, Microsoft, Google) puts capability material in id_token claims; OIDC id_tokens exist for federation, and Epicenter does not federate. The well-trodden alternative is what GitHub, Stripe, AWS SSO, Notion, Linear, Figma, Slack, and Spotify all do: persist tokens, fetch identity at an `/api/me`-style endpoint, never use id_tokens.

**What stays:**

The existing architecture is correct under Path B:
- `/workspace-identity` remains the identity-and-keys endpoint for browser, extension, and CLI clients. A future rename to `/api/me` (better aligned with REST convention) is tracked separately; it does not change the trust model.
- `OAuthSession = { tokens, identity }` remains the persisted shape on disk (`~/.epicenter/auth.json` for CLI) and in localStorage (browser) and chrome.storage (extension). Nested shape supports local-first offline cold-boot decryption.
- `createOAuthAppAuth.loadIdentity` continues to call `/workspace-identity` once at sign-in.

**Related reading:**

- `docs/articles/if-you-dont-trust-the-server-become-the-server.md`: the trust-model rationale this spec was inadvertently rejecting.
- `docs/articles/encryption-at-rest-is-the-gold-standard.md`: how the current encryption layer is correct.
- `docs/articles/let-the-server-handle-encryption.md`: the broader server-managed-keys argument.

**Original spec content preserved below as a historical record.** Do not execute.

---

**(retracted) Original metadata:**
- Supersedes: `specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md` (R2 alternative path)
- Composes with: `specs/20260514T120000-machine-auth-oob-clean-break.md` (originally proposed CLI inheritance of the id_token identity path; the OOB CLI spec is being decoupled to use `/workspace-identity` directly)

## Pass 2 status (read me first)

* **Browser authorization-code flow: VERIFIED.** `customIdTokenClaims` exists, fires on initial code exchange and on every `refresh_token` grant, can return `workspace_encryption_keys`. Signing alg + discovery work. Phase 1, 2, 4 (browser parts), 5 are implementable as written.
* **CLI flow: RESOLVED via composition.** The original draft's SHOW-1 ("device-code returns no id_token") dissolves once the OOB spec lands: the CLI uses authorization_code + PKCE against the same `/oauth2/token` endpoint as the browser, so it receives the same `{ access_token, refresh_token, id_token }` bundle and `customIdTokenClaims` fires on every refresh. Verified via DeepWiki against `better-auth/better-auth` and via direct read of `node_modules/@better-auth/oauth-provider/dist/index.mjs:418-446`.
* **Hook signature: corrected docs error, not a real blocker.** Real signature is `({ user, scopes, metadata })`. Env access works via per-request closure capture in `createAuth({ env })` at `apps/api/src/app.ts:173`. The architecture section reflects the real signature.

## Composition with the OOB CLI spec

The two specs share one persisted shape and one identity-decode path. They land in three waves:

```
Wave 1  (server, additive)
  ├── id_token Phase 1   add customIdTokenClaims to oauthProvider({ ... })
  └── OOB     Phase 1   add /auth/cli-callback page + secureHeaders

Wave 2  (client schema)
  ├── id_token Phase 2   OAuthTokenGrant gains idToken; identity is decode-on-read
  └── OOB     Phase 2   ~/.epicenter/auth.json persists OAuthTokenGrant (4 fields)

Wave 3  (adoption)
  ├── id_token Phase 3   browser apps + extension
  └── OOB     Phase 3-4 OOB launcher + machine-auth rewrite
                         (built on top of Wave 2 schema; never wires /workspace-identity)

Wave 4  (cleanup)
  ├── OOB     Phase 5-6 daemon smoke + docs
  └── id_token Phase 5  delete /workspace-identity (env-flagged 503 first, then code)
```

**Persisted shape (single source of truth, browser + extension + CLI):**

```ts
export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken: 'string',
  refreshToken: 'string',
  idToken: 'string',
  accessTokenExpiresAt: 'number',
});
```

```
browser localStorage     →  key  `<app>.auth.tokens`         value: OAuthTokenGrant JSON
extension chrome storage →  key  `local:auth.tokens`         value: OAuthTokenGrant JSON
CLI file (mode 0o600)    →  path `~/.epicenter/auth.json`    value: OAuthTokenGrant JSON
```

No nesting. No pre-decoded `user` or `encryptionKeys` on disk. No storage-instance metadata. Identity is `decodeIdTokenClaims(grant.idToken)` everywhere it is needed. The OOB spec writes the same arktype the browser writes; one schema, three cells.

## Sentence

```txt
@epicenter/auth ships one token bundle (access_token, refresh_token,
id_token). The id_token is a server-signed JWT whose claims include the
calling user and their encryption keys. Clients decode the id_token to
get identity; there is no separate /workspace-identity fetch, no
WorkspaceIdentityStore, no second storage adapter.
```

This is a packaging change, not a trust-model change. The server still derives encryption keys (HKDF of `BETTER_AUTH_SECRET` and `userId`) and the server still knows them. We are not adopting Signal- or Bitwarden-style zero-knowledge encryption in this spec. That is a separate, larger product decision tracked in `## Out of scope`.

## Trust model (state explicitly, do not bury)

```
Today's trust model is:
  Server derives per-user encryption keys from a server secret.
  Server can decrypt any user's data.
  Client receives the keys at sign-in via /workspace-identity.

After this spec:
  Server derives per-user encryption keys from a server secret.   (unchanged)
  Server can decrypt any user's data.                              (unchanged)
  Client receives the keys as a claim inside a server-signed JWT.  (new)
```

The change is the channel, not the secret.

This refactor is **not** a stepping stone to zero-knowledge encryption. A real ZK migration would change identity flow significantly: the client generates a master key from a user secret (master password / WebAuthn PRF / device-to-device approval), the server stops deriving keys at all, and the `workspace_encryption_keys` claim is removed (not replaced). What survives the transition is "id_token carries identity claims," which is just OIDC convention, not a property this spec invented. Do not justify this spec as ZK groundwork; justify it as deleting a hand-rolled identity surface in favor of the standard one.

## Motivation

The prior spec (`20260514T091255-tokens-only-auth-extract-identity-to-workspace.md`) correctly identified the smell in today's `OAuthSession = { tokens, identity }` blob: bundled storage, dual-write coupling on refresh, identity freshness slipping, the same-user guard at the wrong layer. Its proposed fix was to extract identity into a new `@epicenter/workspace` store with its own storage adapter and lifecycle.

That fix is correct, but it leaves the system *more* complex than it needs to be. The simpler answer the prior spec did not pursue:

```
The id_token IS the identity surface.
```

OpenID Connect already defines the id_token as the carrier for "who is the calling user and what does the server vouch for about them." Epicenter's `WorkspaceIdentity` shape (`{ user: { id, email }, encryptionKeys }`) is exactly an id_token claims body. We have been hand-rolling a second one at `/workspace-identity`.

The smell the prior spec attacked dissolves at a higher level: tokens and identity live in one bundle because the id_token is part of the token bundle. There is no second storage adapter to coordinate, no `attach`/`detach` lifecycle, no `KeyRotationDetected` event channel, and no same-user guard at the storage layer because token rotation is the only thing that can change identity, and the new tokens carry their own bound id_token.

## Conceptual model

```
OAuth bundle (one storage cell)
├── access_token      JWT, ~1h, bearer for /api/*
├── refresh_token     opaque, rotates, survives cold boot
└── id_token          JWT, ~24h, carries `user` + `encryption_keys`
                      claim. Decoded for identity. Not sent as bearer.
```

Identity is now "decode `tokens.id_token.payload`," not "load from a separate store." No state machine for identity; the state machine for tokens covers it.

Auth state:

```ts
type AuthState =
  | { status: 'signed-in';        // tokens present and valid (or in-flight refresh)
      identity: WorkspaceIdentity } // derived sync from id_token
  | { status: 'reauth-required';
      identity: WorkspaceIdentity } // last-known identity from last valid id_token
  | { status: 'signed-out' };
```

The `identity` field returns. It was correctly identified as load-bearing by today's design; the prior spec dropped it. This spec keeps it but defines it as a *derived view* of the token bundle, not a separately-stored object.

```ts
// pseudocode in the auth library
const identity = useMemo(
  () => tokens.id_token ? decodeIdTokenClaims(tokens.id_token) : null,
  [tokens.id_token]
);
```

## Invariants

| ID | Statement | After this spec |
| --- | --- | --- |
| A | Token rotation is invisible to callers. | Preserved. |
| B | A held identity reference survives `signed-in <-> reauth-required` transitions. | Preserved: identity is decoded from the last valid id_token; the value object is stable until a new id_token arrives. |
| C | Identity cannot be quietly swapped to a different user. | Preserved: token refresh returns a fresh id_token signed by the server; signature verification + `sub` equality enforces the guard. |
| D | Tokens-present implies identity-present and vice versa. | Preserved by structural collapse: the id_token IS in the token bundle. Cannot have one without the other. |
| E | Identity is fresh. | Strengthened: every refresh produces a fresh id_token. The "captured at sign-in, stale forever" failure mode is gone. |
| F | Bearer is never visible to callers. | Preserved: `auth.fetch` still wraps the bearer. id_token is not used as a bearer. |

Note the prior spec dropped invariant D as a coherence improvement; this spec preserves it as a coherence improvement. Both are reasonable answers. The argument for keeping D is that it matches OAuth/OIDC convention (id_token is always paired with access_token in OIDC flows) and removes a window where UI has to reason about "signed-in but not attached."

## Architecture

### Server side: `@better-auth/oauth-provider` claim hooks

Verified in `node_modules/@better-auth/oauth-provider/dist/index.mjs:257-302, 619-841`. The installed plugin (`1.5.6`) exposes three claim hooks. Their actual runtime signatures (verified at `index.mjs:284-315`):

```ts
// dist/index.mjs:284-315  (createIdToken; called from createUserTokens at :433
// for both authorization_code and refresh_token grants when scopes include `openid`)
const customClaims = opts.customIdTokenClaims ? await opts.customIdTokenClaims({
    user,                                    // BetterAuth user record
    scopes,                                  // string[]
    metadata: parseClientMetadata(client.metadata), // OAuth client metadata, NOT request ctx
}) : {};

// Final payload is built as:
const payload = {
    ...userClaims,        // sub, profile?, email? (from userNormalClaims; only present
                          // when 'profile' / 'email' scopes are granted)
    ...customClaims,      // workspace_encryption_keys
    auth_time, acr,
    iss,
    sub: resolvedSub,     // OVERRIDES customClaims.sub. Pairwise pseudonym if
                          // opts.pairwiseSecret is set; otherwise === user.id.
    aud, nonce, iat, exp, sid,
};
```

```ts
// dist/index.mjs:254-279, 619-631, 831-841  (access_token; same hook fires
// at issuance AND inside opaque-token introspection at :831)
const customClaims = opts.customAccessTokenClaims ? await opts.customAccessTokenClaims({
    user,
    scopes,
    resource: ctx.body.resource,
    referenceId,
    metadata: parseClientMetadata(client.metadata),
}) : {};
```

The hook does NOT receive `ctx`. Env access (Cloudflare Workers bindings) inside the hook works through closure capture: `createAuth({ db, env, baseURL })` is called per-request at `apps/api/src/app.ts:173`, so the `customIdTokenClaims` closure constructed inside `oauthProvider({ ... })` captures `env` from the enclosing factory call.

So `apps/api/src/auth/create-auth.ts` extends:

```ts
oauthProvider({
  loginPage: '/sign-in',
  consentPage: '/consent',
  requirePKCE: true,
  cachedTrustedClients: trustedOAuthClientIds,
  validAudiences: [baseURL],
  allowDynamicClientRegistration: false,
  scopes: [
    'openid', 'profile', 'email', 'offline_access', 'workspaces:open',
  ],

  // NEW:
  customIdTokenClaims: async ({ user, scopes }) => {
    if (!scopes.includes('workspaces:open')) return {};
    const encryptionKeys = await deriveUserEncryptionKeys(user.id);
    return { workspace_encryption_keys: encryptionKeys };
  },

  silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
}),
```

The `workspaces:open` scope already exists in your config. Gating the claim by scope means the keys are only emitted to clients that explicitly requested them, not to every OIDC-only client of your provider.

### Server side: `jwt()` algorithm choice

Today the `jwt()` plugin is called with default options. Default signing algorithm is EdDSA (Ed25519). For broader client-side verifier compatibility (Tauri Rust crates, browser `jose`, mobile platforms), use `ES256`:

```ts
plugins: [
  jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
  oauthProvider({ ... }),
],
```

Verification target: confirm that `apps/api/src/auth/create-auth.ts:233` `jwt()` call accepts the `jwks.keyPairConfig` option in your installed version. The OIDC discovery doc may hardcode `id_token_signing_alg_values_supported`; if so, this needs a plugin-level override or accepting EdDSA.

### Server side: delete `/workspace-identity` (Phase 2; not Phase 1)

`apps/api/src/app.ts:238-252` keeps `/workspace-identity` during Phase 1 as a fallback for clients that haven't migrated. Phase 2 deletes it.

`apps/api/src/auth/resource-boundary.ts:99-114` `resolveBearerIdentity` keeps its current shape; it now has zero callers from `/workspace-identity`, but `resolveBearerUser` is a sibling that handles `/api/*` routes and stays.

### Client side: `@epicenter/auth` after

```
@epicenter/auth                       (still shrinks, but less than prior spec)
  src/
    auth-types.ts                     OAuthTokenGrant + IdTokenClaims (new)
    auth-contract.ts                  AuthClient, AuthState (with derived identity)
    auth-state-store.ts               unchanged shape; identity now derived
    create-oauth-app-auth.ts          tokens-only storage; identity is a getter
                                      that decodes tokens.id_token
    decode-id-token.ts                small JWT-decode helper (no verify required;
                                      server is the only issuer and TLS already
                                      authenticates the server)
    oauth-launchers/                  unchanged
    node/
      machine-auth.ts                 device code flow returns id_token now
      machine-session-store.ts        renamed to machine-tokens-store; persists
                                      the full bundle including id_token

  Public exports:
    type AuthClient, AuthState
    type OAuthTokenGrant   (now includes idToken: string)
    type IdTokenClaims     (decoded shape: { user, encryptionKeys, sub, exp, ... })
    type WorkspaceIdentity (still { user, encryptionKeys } -- derived view)
    type AuthUser
    createOAuthAppAuth({ tokensStorage, launcher, ... })
    AuthError
    requireIdentity(auth)  (unchanged signature; reads auth.state.identity)
```

No new package. No `WorkspaceIdentityStore`. No `attach`/`detach`. No second storage adapter.

### Client side: token storage shape

```ts
export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken: 'string',
  refreshToken: 'string',
  idToken: 'string',                           // NEW
  accessTokenExpiresAt: 'number',
});
```

One adapter, one cell, one write per refresh. Identity is `decodeIdTokenClaims(tokens.idToken)` and is recomputed on read. No epoch counter for identity, because identity does not have its own write path.

### Client side: `decode-id-token.ts`

```ts
import { type } from 'arktype';
import { EncryptionKeys } from '@epicenter/encryption';

export const IdTokenClaims = type({
  '+': 'delete',
  sub: 'string',
  iss: 'string',
  aud: 'string | string[]',
  exp: 'number',
  iat: 'number',
  email: 'string',
  workspace_encryption_keys: EncryptionKeys,
});
export type IdTokenClaims = typeof IdTokenClaims.infer;
```

Two server-side preconditions enforce this schema; both must hold or the assert throws.

**Email scope must be granted alongside `workspaces:open`.** `userNormalClaims` (verified at `node_modules/@better-auth/oauth-provider/dist/index.mjs:162-179`) only injects `email` when the granted scope set contains `email`. The custom claim hook fires when `workspaces:open` is granted, but `email` and `workspaces:open` are independent. Every Epicenter OAuth client must request `openid email workspaces:open` together, not just `openid workspaces:open`. Add a server-side guard inside `customIdTokenClaims` that throws if `scopes.includes('workspaces:open') && !scopes.includes('email')` so a misconfigured client fails at issuance, not at the client decode boundary.

**`pairwiseSecret` must remain unset.** `createIdToken` builds `sub: resolvedSub = await resolveSubjectIdentifier(user.id, client, opts)` (`index.mjs:288, 303`). When `opts.pairwiseSecret` is set, `sub` becomes a per-client pseudonym, which silently breaks the same-user guard `claims.sub === identity.user.id` across different OAuth clients of the same provider. Today `pairwiseSecret` is not set; flag this as a load-bearing assumption with a comment in `apps/api/src/auth/create-auth.ts` so a future contributor does not enable it without first switching the same-user guard from `sub` to a non-pairwise claim.

```ts
/**
 * Decode (NOT verify) a server-issued id_token.
 *
 * Verification is unnecessary because:
 * 1. The token arrived over TLS from the only server we trust.
 * 2. The token was returned by an authenticated /token call.
 * 3. The bearer (access_token) is the access-control mechanism; id_token
 *    is informational metadata about the user the bearer represents.
 *
 * If you need to verify (e.g. exchanging an id_token at a foreign
 * relying party), use jose.jwtVerify against the server's JWKS endpoint.
 */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const [, payload] = idToken.split('.');
  if (!payload) throw new Error('Malformed id_token');
  const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  return IdTokenClaims.assert(decoded);
}
```

No new dependency on `jose`. `atob` is available in browsers, Tauri WebView, Bun, and Node 16+; the function uses `globalThis.atob` semantics and works in every Epicenter runtime without a per-runtime branch.

### Client side: `AuthState.identity` derivation

```ts
// in create-oauth-app-auth.ts
function deriveStateFromTokens(tokens: OAuthTokenGrant | null): AuthState {
  if (!tokens) return { status: 'signed-out' };
  const identity = projectIdentity(decodeIdTokenClaims(tokens.idToken));
  if (isAccessTokenExpiredBeyondRefresh(tokens)) {
    return { status: 'reauth-required', identity };
  }
  return { status: 'signed-in', identity };
}

function projectIdentity(claims: IdTokenClaims): WorkspaceIdentity {
  return {
    user: { id: claims.sub, email: claims.email },
    encryptionKeys: claims.workspace_encryption_keys,
  };
}
```

`identitiesEqual` and `encryptionKeysEqual` from `auth-state-store.ts` remain; they fire on token rotation now, not on a separate identity write path.

### Lifecycle: sign-in (browser, cold)

```
1. user clicks sign-in
2. auth.startSignIn()
     - launcher runs OAuth PKCE flow
     - exchange code for { access_token, refresh_token, id_token }
     - tokensStorage.set(bundle)
     - state derived: signed-in + identity (from id_token decode)
3. UI unblocks
```

One step, not two. No second fetch.

### Lifecycle: cold boot (existing user)

```
1. tokensStorage.get() -> bundle
2. derive state from bundle
   - bundle present, access_token valid     -> signed-in + identity
   - bundle present, access_token expired   -> signed-in (refresh on first
                                               fetch) + identity from cached
                                               id_token
   - bundle present, refresh_token expired  -> reauth-required + identity
                                               from last id_token
   - bundle missing                          -> signed-out
3. UI renders
```

The "tokens present, identity missing" cold-boot edge case from the prior spec cannot occur because tokens-present implies id_token-present.

### Lifecycle: reauth-required

```
1. auth.fetch hits a terminal 401
2. state -> reauth-required + last identity
3. user re-signs-in
4. new bundle arrives with fresh id_token
5. if claims.sub differs from prior identity.user.id:
     state -> signed-out, then throw a UserMismatch banner
     (mirrors today's same-user guard, just at the token-bundle level)
6. otherwise state -> signed-in + (possibly refreshed) identity
```

Key rotation: if a future refresh returns an id_token where `workspace_encryption_keys` differs from the prior one, `encryptionKeysEqual` returns false. The state store emits the standard onStateChange event with the new identity; consumers re-derive workspace decryption. No `KeyRotationDetected` event channel; the regular state-change event is sufficient because identity is no longer a peer object.

### Lifecycle: sign-out

```
1. auth.signOut()
2. revoke refresh token
3. tokensStorage.set(null)
4. state -> signed-out (identity disappears with the token bundle)
```

### Tab sync

Unchanged from today. The token-bundle adapter (`createPersistedState` over `localStorage`, or `chrome.storage.local` for the extension) is the single thing being synced. Other tabs receive the new bundle, re-derive their state, get the new identity. No `subscribe?` on a second adapter.

## CLI / authorization-code OOB path

Resolved by `specs/20260514T120000-machine-auth-oob-clean-break.md`. The CLI moves off device-code entirely and uses the same authorization_code + PKCE flow as the browser, against the same `/auth/oauth2/authorize` and `/auth/oauth2/token` endpoints. That path runs through `@better-auth/oauth-provider`'s `handleAuthorizationCodeGrant` → `createUserTokens` → `createIdToken`, so the token response is `{ access_token, refresh_token, id_token }` whenever scopes include `openid` (verified at `node_modules/@better-auth/oauth-provider/dist/index.mjs:418-446`).

End-state for the CLI:

```
1. epicenter auth login → OOB launcher prints authorize URL
2. user completes sign-in on the hosted /auth/cli-callback page
3. user pastes the displayed code into the terminal
4. POST /auth/oauth2/token returns { access_token, refresh_token, id_token, expires_in }
5. CLI writes OAuthTokenGrant to ~/.epicenter/auth.json (mode 0o600)
6. createMachineAuthClient decodes idToken via decodeIdTokenClaims at every read
7. /workspace-identity is never called
```

The CLI's persisted file matches the browser localStorage cell exactly (same `OAuthTokenGrant` arktype, four fields). No platform-specific identity adapter, no second decode path.

## Storage model

| Concern | Type | Browser storage | Node storage | Notes |
| --- | --- | --- | --- | --- |
| Token bundle | `OAuthTokenGrant` (access + refresh + id_token + expiry) | `createPersistedState` over `localStorage`, key `<app>.auth.tokens` | `Bun.secrets`, service `epicenter.auth.tokens`, name `current` | One cell. ~1.5-2.5 KB total (access + id JWTs). |

Browser tab manager uses `chrome.storage.local` via `createStorageState`. Key path: `local:auth.tokens`.

### Migration: clean break, same as prior spec

Existing `OAuthSession = { tokens, identity }` blobs are stranded. New code reads only `<app>.auth.tokens`. Pre-launch product, login-only UX, one forced sign-in per tester. The migration is a sign-in prompt, not code.

Old keys to ignore:
- `<app>.auth.session` (browser, extension)
- `epicenter.auth.session:current` (node keychain)

## Implementation plan

Follows Build, Prove, Remove.

### Phase 1 (Build): server-side id_token claim

* [ ] **1.1** Verify `@better-auth/oauth-provider@1.5.6` `customIdTokenClaims` hook signature against installed code (`node_modules/@better-auth/oauth-provider/dist/index.mjs:287-302`). Document the exact param shape in a comment alongside the new option in `apps/api/src/auth/create-auth.ts`.
* [ ] **1.2** Add `customIdTokenClaims` to `oauthProvider({ ... })` in `apps/api/src/auth/create-auth.ts`. Gate on `scopes.includes('workspaces:open')`. Inject `deriveUserEncryptionKeys` the same way `apps/api/src/app.ts:243` injects it for `/workspace-identity` today.
* [ ] **1.3** Set `jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } })` to lock the signing algorithm to one with broad verifier support. Verify OIDC discovery doc reflects the change.
* [ ] **1.4** Add a server-side test: an OAuth authorize+token+verify flow with `workspaces:open` scope returns an id_token whose decoded payload contains a valid `workspace_encryption_keys` array. Use `apps/api/src/__tests__/` adjacent to `resource-boundary.test.ts` if it exists.
* [ ] **1.5** Leave `/workspace-identity` route in place (Phase 1 is additive on the server).

### Phase 2 (Build): client-side decode + state derivation

* [ ] **2.1** Add `idToken: 'string'` to `OAuthTokenGrant` in `packages/auth/src/auth-types.ts`.
* [ ] **2.2** Create `packages/auth/src/decode-id-token.ts` with `IdTokenClaims` arktype schema and `decodeIdTokenClaims` function. ~30 lines including JSDoc.
* [ ] **2.3** In `packages/auth/src/create-oauth-app-auth.ts`, refactor:
  - `loadIdentity` (currently calls `/workspace-identity`) becomes `deriveIdentityFromBundle(tokens)` which decodes the id_token.
  - `replaceSession` is unchanged in shape; the same-user guard now compares `decodeIdTokenClaims(next.idToken).sub` vs cached `identity.user.id`.
  - Delete the dedicated `/workspace-identity` fetch and its associated error variants.
* [ ] **2.4** Update `AuthState` discriminated union to include `identity` on `signed-in` and `reauth-required` (revert the prior spec's removal). Type stays:
  ```ts
  type AuthState =
    | { status: 'signed-in';        identity: WorkspaceIdentity }
    | { status: 'reauth-required';  identity: WorkspaceIdentity }
    | { status: 'signed-out' };
  ```
* [ ] **2.5** Rewrite `packages/auth/src/auth-state-store.ts` to derive state from token-bundle changes, not from a separate identity write path. The `identitiesEqual` and `encryptionKeysEqual` diff fires on token rotation when the new id_token's claims differ.
* [ ] **2.6** Unit tests: refresh produces new id_token, identity derives correctly, signature/decode failures map to a `IdTokenInvalid` error variant, same-user guard catches a `sub` mismatch.

### Phase 3 (Build): adopt across browser apps and CLI

* [ ] **3.1** Apps using `createOAuthAppAuth` from `@epicenter/auth-svelte` have zero call-site changes if `AuthState.identity` is preserved. Verify each of the 6 browser apps boots and renders identity.
* [ ] **3.2** Daemon/script call sites in `apps/*/blocks/*.ts` use `requireSession(auth)` today; that helper survives unchanged because `AuthState.identity` is preserved.
* [ ] **3.3** CLI adoption is owned by `specs/20260514T120000-machine-auth-oob-clean-break.md` Phase 3 (OOB launcher) and Phase 4 (rewrite `machine-auth.ts`). When that spec lands on top of this one, `~/.epicenter/auth.json` already persists `OAuthTokenGrant` (the four-field shape including `idToken`) and identity comes from `decodeIdTokenClaims`; no `/workspace-identity` call appears in the CLI code path.
* [ ] **3.4** CLI smoke is owned by the OOB spec's Verification Plan section.

### Phase 4 (Prove): wave-wide validation

* [ ] **4.1** `bun run typecheck` green.
* [ ] **4.2** `bun test` green per package.
* [ ] **4.3** Browser smoke per app: cold boot signed-in, sign-out, sign-in, force reauth via 401, restore.
* [ ] **4.4** CLI smoke per command.

### Phase 5 (Remove): delete /workspace-identity

Only proceed after Phase 4 is green AND a measurable wait period has passed in production with id_token issuance observed working (suggested: at least one calendar week with no related error reports). Phase 5 is irreversible at the code level; if id_token issuance breaks after the route is gone, every browser client cold-boots into a permanently signed-out state until a hotfix re-adds the route.

Reversibility option (recommended): land Phase 5 behind an env-flag check rather than a code deletion in the same PR. Introduce `DELETE_WORKSPACE_IDENTITY=true` for one release; if production is healthy, follow up with the actual deletion PR. This converts an irreversible code change into a one-line config rollback during the watch window.

* [ ] **5.1** Add an env-gated `503 Gone` response on the route (one-line shim) and ship it. Watch one release.
* [ ] **5.2** Delete `app.get('/workspace-identity', ...)` route in `apps/api/src/app.ts:238-252`.
* [ ] **5.3** Decide whether `resolveBearerIdentity` in `apps/api/src/auth/resource-boundary.ts:99-114` has any remaining callers. If not, delete; keep `resolveBearerUser` which is still used by `/api/*`.
* [ ] **5.4** Final grep: `grep -rn '/workspace-identity'` in `apps/` and `packages/` returns zero matches.

## What this spec DOES NOT do

These are explicit non-goals, listed so the next reviewer does not mistake omission for oversight:

* **Adopt zero-knowledge encryption.** Server still derives and knows all encryption keys. See `## Out of scope` for the path to a true E2E follow-up.
* **Move tokens to HttpOnly cookies or service-worker private cache.** The same-origin-XSS attack surface is unchanged. Spec 20260514T091255's research finding #4 stands: only HttpOnly/SW changes that profile, and both are larger projects.
* **Change OAuth ceremony.** PKCE, device-code, revoke, token endpoint are untouched.
* **Introduce per-user master password or WebAuthn PRF.** Both are zero-knowledge enablers and belong in the E2E follow-up.
* **Multi-user-per-origin.** Still single-tenant per app installation. The id_token's `sub` claim is the source of truth for "which user," and there's exactly one bundle stored per app.

## Out of scope (tracked for future specs)

* **True zero-knowledge encryption.** Requires user-typed master password, or WebAuthn PRF, or device-to-device approval (Bitwarden TDE). Demands a full UX design pass for sign-up, sign-in, recovery, multi-device, and account deletion. Notable references:
  - Signal SVR3 paper: <https://eprint.iacr.org/2024/887.pdf>
  - Bitwarden Trusted Device Encryption: <https://bitwarden.com/help/about-trusted-devices/>
  - WebAuthn PRF extension: <https://w3c.github.io/webauthn/#prf-extension>
* **JWT signature verification on the client.** Today we trust on TLS. If we ever consume id_tokens from a foreign relying party, switch to `jose.jwtVerify` against the JWKS endpoint at `/jwks`.
* **id_token revocation.** OIDC id_tokens are not directly revocable; they expire. If a key rotation needs to be enforced sooner than the id_token expiry, the only mechanism is forcing a token refresh, which we already do via the standard refresh path on a 401.
* **Cross-origin id_token sharing between apps.** Each app under `apps/*` has its own token bundle. If we ever ship a shared identity across apps, that is a session-cookie + cross-subdomain design.

## Decisions log

* **Server-mediated trust model is honest, and we are not changing it in this spec.** Constraint: pure OAuth 2.1 + hosted-dashboard + no second secret cannot produce a client-only key. Bitwarden's own design says so. Adopting zero-knowledge requires either a master password, WebAuthn PRF, or device-to-device approval; each is a substantial product decision. Revisit when: a paying customer or regulator requires zero-knowledge.

* **id_token over a parallel signed-blob endpoint.** Constraint: OIDC already defines this exact carrier. `@better-auth/oauth-provider@1.5.6` exposes `customIdTokenClaims` as a runtime hook. Inventing a parallel signed-identity endpoint would be duplicating a well-specified standard.

* **Trust on TLS, do not verify the id_token signature client-side.** Constraint: the only issuer is our own server, the channel is TLS, the token arrives directly from `/token`. JWT signature verification protects against MITM in a federated context that does not apply here. Revisit when: a foreign relying party consumes Epicenter id_tokens.

* **Keep `WorkspaceIdentity` value type; reject the prior spec's `WorkspaceIdentityStore` runtime store.** Constraint: identity is fully derivable from the token bundle. A store adds a parallel lifecycle for no informational gain.

* **Sign id_tokens with `ES256`, not the EdDSA default.** Constraint: broadest verifier-library support (browser `jose`, Rust `jsonwebtoken`, mobile platforms). Negligible signature-size and CPU cost difference.

* **Single persisted shape across browser, extension, and CLI.** All three persist `OAuthTokenGrant = { accessToken, refreshToken, idToken, accessTokenExpiresAt }` with no nesting and no pre-decoded identity. Constraint: this is a clean break (zero existing users, zero stored data to migrate), so the asymmetric win is to land one arktype that validates every cell. Refused: a Codex-style nested `{ tokens: {...}, last_refresh: ... }` shape (Codex nests because it discriminates `auth_mode`; we do not). Refused: a pre-decoded `{ ..., user, encryptionKeys }` cache on disk (re-introduces the freshness skew bug the spec was written to kill). Refused: a `version` / `users` map for future multi-account (YAGNI under clean break; one signed-in identity per cell, re-login is the migration mechanism).

* **Composes with the OOB CLI spec, not standalone.** Constraint: the original draft's CLI path (`device-code`) returned no `id_token`. The OOB CLI spec replaces that path with authorization_code + PKCE, which routes CLI sign-in through the same `/oauth2/token` endpoint the browser uses, so the id_token claim hook is the one true identity surface across every consumer.

## Open questions

### Resolved (kept here for audit trail)

**SHOW-1. CLI device-code path. RESOLVED via composition.** The OOB CLI spec (`specs/20260514T120000-machine-auth-oob-clean-break.md`) deletes the device-code path entirely and replaces it with authorization_code + PKCE OOB. That re-routes the CLI through the same `/oauth2/token` endpoint as the browser, which already returns `{ access_token, refresh_token, id_token }` and re-runs `customIdTokenClaims` on every refresh (verified via DeepWiki and at `index.mjs:418-446`). No upstream Better Auth change required.

**SHOW-2. Hook signature was misstated; env-access claim was unverified. RESOLVED in spec body.** The `customIdTokenClaims` hook receives `{ user, scopes, metadata }` (no `ctx`), and Cloudflare env access works via closure capture in `createAuth({ env })` per-request. No code change required; Phase 1.1 verifies against the corrected signature.

### Verified, no longer open

* **id_token issuance on refresh.** `customIdTokenClaims` fires from `createUserTokens` (`index.mjs:403-447`), which is invoked by both `handleAuthorizationCodeGrant` and `handleRefreshTokenGrant`. Invariant E (identity is fresh on every refresh) holds for the browser path. Verified at `index.mjs:418-446`.

### Open but non-blocking

1. **id_token size at 5+ key versions.** Today: 1 version, ~120 bytes overhead. At 10 versions: ~1.2 KB overhead, total id_token ~2 KB. Acceptable. At 100 versions: unworkable. Future spec: cap id_token to N most recent versions; force workspace re-encryption to evict older ones. Not a today-problem.

2. **`decodeIdTokenClaims` shape.** Free function in `@epicenter/auth`. Apps that want a stable surface can re-export. Method on `AuthClient` makes test-stubbing harder.

3. **`auth.state.identity` between `signed-out` and first sign-in.** The discriminated union answers this: `identity` is absent on `signed-out`. Apps that hold a stale identity in component state must clear it on signed-out transitions; document this in the JSDoc on `AuthState`.

4. **Naming: `WorkspaceIdentity` vs `IdentityClaims`.** Now that the type is a derived view of an id_token rather than a server-side bundle, `IdentityClaims` (or `DecodedIdentity`) signals provenance better. Renaming touches `requireIdentity`, `requireSession`, `account-popover.svelte`, every `auth.state.identity` access, and the `@epicenter/auth` public exports. Recommendation: defer to a follow-up rename PR after this spec lands; touching it here triples the diff.

## Verification targets (Pass 2, before implementation)

* [x] **V1. PARTIAL.** `customIdTokenClaims` exists at `node_modules/@better-auth/oauth-provider/dist/index.mjs:291-295`. Signature is `({ user, scopes, metadata })`, NOT `({ user, scopes, ctx })` as the spec's first draft claimed. `metadata = parseClientMetadata(client.metadata)` (OAuth client metadata, not request context). Spec corrected in `### Server side: @better-auth/oauth-provider claim hooks`. Phase 1.1 must verify against the corrected signature.
* [x] **V2. RESOLVED via composition with the OOB CLI spec.** The device-code question is moot once the CLI moves to authorization_code + PKCE. Verified via DeepWiki against `better-auth/better-auth`: `authorization_code` grant with `openid` + `offline_access` scopes returns `{ access_token, refresh_token, id_token }`; `customIdTokenClaims` fires on both initial code exchange and every `refresh_token` grant. Verified locally at `node_modules/@better-auth/oauth-provider/dist/index.mjs:418-446`.
* [x] **V3. VERIFIED.** `jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } })` is honored at `node_modules/better-auth/dist/plugins/jwt/utils.mjs:22-24`: `const { alg, ...cfg } = options?.jwks?.keyPairConfig ?? { alg: 'EdDSA', crv: 'Ed25519' }`. The default applies only when the entire `keyPairConfig` is missing; passing `{ alg: 'ES256' }` overrides cleanly (jose's `generateKeyPair('ES256')` defaults to P-256, which is what we want).
* [x] **V4. VERIFIED.** `id_token_signing_alg_values_supported` reads `jwtPluginOptions?.jwks?.keyPairConfig?.alg` at `node_modules/@better-auth/oauth-provider/dist/index.mjs:3910`. Setting alg on the jwt plugin propagates to discovery automatically; no override needed.
* [x] **V5. VERIFIED via different mechanism than the spec implied.** The hook does NOT receive `ctx`. Env access works because `createAuth({ env })` is called per-request at `apps/api/src/app.ts:173`, so the closure built inside `oauthProvider({ customIdTokenClaims: async (...) => { ... } })` captures `env` from the enclosing factory call. Spec body corrected.
* [x] **V6. VERIFIED.** `globalThis.atob` works in browsers, Tauri WebView, Bun, and Node 16+. The 5-line decoder handles base64url replacement (`-` → `+`, `_` → `/`). No need for `jose`. Spec text corrected to remove the stray `Buffer.from` reference.

## References

Today's bundled shape (rewritten by this spec):

* `packages/auth/src/auth-types.ts:4-37` - `AuthUser`, `WorkspaceIdentity`, `OAuthTokenGrant`, `OAuthSession`.
* `packages/auth/src/auth-contract.ts:5-18` - `AuthState` with `identity`.
* `packages/auth/src/auth-state-store.ts` - notify-on-change pattern; `identitiesEqual`, `encryptionKeysEqual`.
* `packages/auth/src/create-oauth-app-auth.ts:56-257` - `loadIdentity` calls `/workspace-identity`; that call is deleted.
* `packages/auth/src/node/machine-auth.ts:298-323` - `fetchOAuthSession` calls `authClient.getSession()`; replaced by id_token decode.

Server side:

* `apps/api/src/app.ts:238-252` - `/workspace-identity` route (deleted in Phase 5).
* `apps/api/src/auth/resource-boundary.ts:99-114` - `resolveBearerIdentity` (callers go to zero).
* `apps/api/src/auth/create-auth.ts:155-256` - `betterAuth` plugin config (gains `customIdTokenClaims`).

Encryption:

* `packages/encryption/src/keys.ts:11-30` - `EncryptionKey` / `EncryptionKeys` arktype schemas. Reused in `IdTokenClaims`.
* `packages/encryption/src/keys.ts:58-73` - `encryptionKeysEqual` (used by the token-bundle diff).

Workspace integration:

* `packages/workspace/src/document/local-owner.ts:27-32` - `createLocalOwner` still consumes a lazy `() => encryptionKeys`; the closure now reads through `auth.state.identity.encryptionKeys` instead of the prior spec's `identityStore.require().encryptionKeys`.

Better Auth plugin (verified):

* `node_modules/@better-auth/oauth-provider/dist/index.mjs:257-302, 619-841` - `customAccessTokenClaims`, `customIdTokenClaims`, `customUserInfoClaims` hooks.

Prior spec (this spec's predecessor):

* `specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md` - the WorkspaceIdentityStore variant; this spec rejects the separate-store approach in favor of id_token-as-identity.

## Pass 2 findings

What changed during the grilling pass and the subsequent OOB-spec composition pass:

* **V2 (device-code) initially failed, now resolved by composition.** SHOW-1 was deferred during the grill, then dissolved when the OOB CLI spec re-routed the CLI through authorization_code + PKCE (same `/oauth2/token` path as the browser). DeepWiki + local source confirm `customIdTokenClaims` fires on every grant including refresh.
* **V1 hook signature corrected.** `({ user, scopes, metadata })` not `({ user, scopes, ctx })`. Env access works via per-request `createAuth({ env })` closure capture, not via the hook's metadata field.
* **V3, V4, V5, V6 verified.** ES256 alg propagates to discovery; `atob` portable; refresh_token grant re-runs `customIdTokenClaims` so identity stays fresh on every refresh (`index.mjs:418-446`).
* **Email scope dependency surfaced.** `userNormalClaims` only injects `email` when `scopes.includes('email')`. Without an email scope guard, an Epicenter client requesting `openid workspaces:open` (and not `email`) would receive an id_token whose `IdTokenClaims.assert` throws on the missing required field. Add a server-side guard inside `customIdTokenClaims`.
* **Pairwise sub fragility surfaced.** Same-user guard `claims.sub === identity.user.id` only holds while `opts.pairwiseSecret` is unset. Comment in `create-auth.ts` warns future contributors.
* **Forward-compat-with-ZK claim retracted.** The trust-model section no longer claims this is a stepping stone to zero-knowledge. The honest framing is: this deletes a hand-rolled identity surface in favor of OIDC's standard one. ZK is a separate, larger product decision.
* **Phase 5 reversibility added.** A one-release env-flagged `503 Gone` shim sits between "Phase 4 green" and the actual route deletion, so a regression in id_token issuance can be rolled back via config rather than a hotfix PR.
* **Persisted shape unified across browser, extension, and CLI.** Single `OAuthTokenGrant` arktype with four fields. No nesting; no pre-decoded identity on disk. The OOB CLI spec writes the same arktype to `~/.epicenter/auth.json` that the browser writes to localStorage. This is the asymmetric win clean-break gave us: refusing platform-specific schemas collapses one decode path, one validator, one set of tests.

## Diff vs prior spec (`20260514T091255`)

| Concern | Prior spec | This spec |
| --- | --- | --- |
| Storage adapters | Two: tokens in `@epicenter/auth`, identity in new `@epicenter/workspace` store with own `attach`/`detach` lifecycle. | One: token bundle (now includes id_token) in `@epicenter/auth`. Identity is a derived view, not a stored object. |
| Identity shape on `AuthState` | Removed (state is `signed-in` enum only). | Preserved (state is `signed-in` + `identity`). Reverts the prior spec's removal. |
| Same-user guard layer | Inside `WorkspaceIdentityStore.attach()`. | Inside `replaceSession`, comparing `decodeIdTokenClaims(next.idToken).sub` vs cached identity. |
| Identity freshness on refresh | Carried verbatim across refresh writes; freshness aspirational. | Strengthened: every refresh issues a fresh id_token, identity re-derives. |
| Key rotation event channel | New `KeyRotationDetected` event variant. | Standard `onStateChange` event; no separate channel needed because identity is no longer a peer object. |
| Migration | Clean break, sign-in prompt. | Clean break, sign-in prompt. Same. |
| CLI path | Acknowledged as currently broken; deferred. | Same; SHOW-1 in this spec makes the deferral explicit and lists three resolution paths. |
| Server changes | None mandatory. | New `customIdTokenClaims` hook on `oauthProvider({ ... })`; ES256 signing alg; eventual `/workspace-identity` deletion. |
| New package | Yes (`@epicenter/workspace` identity store). | No. |

A future reader should follow this spec, not the prior one. The prior spec's smell diagnosis is still correct (bundled `OAuthSession` couples token rotation to identity stability); this spec's fix dissolves the smell at a higher level (id_token IS identity) instead of splitting concerns into two stores. The asymmetric win: refusing to add a second store collapses ~80% of the prior spec's lifecycle, attach/detach, and event-channel work.

## Done when (spec is watertight)

This is the gating checklist for this spec. Every item is satisfied by edits in this document.

* [x] All six verification targets in `## Verification targets (Pass 2)` are answered with a concrete file/line reference proving (or disproving) the claim. V2 disproves the CLI plan; spec amended to drop the dependent CLI work.
* [ ] The trust-model section is reviewed by Braden and confirmed to match product intent ("not zero-knowledge in this spec; that is a separate decision").
* [x] Every Phase 1-5 step lists at least one concrete file path or call site. CLI steps are explicitly deferred.
* [x] LOC estimates removed from the spec body. (`Roughly 20 lines` rewritten in the `decode-id-token.ts` section.)
* [x] Decisions log includes: trust model, hook choice, signature-verification choice, algorithm choice, rejection of the prior spec's separate-store approach.
* [x] No em or en dashes in spec body. AGENTS.md forbids them.
* [ ] No paragraph longer than four sentences without a structural break. (Best-effort, reader to verify.)
* [ ] **NEW.** Braden chooses one of the three CLI resolution paths in `## CLI / device-code path` (or explicitly defers to a follow-up spec) before any code lands on Phase 1.
