# Simplified Auth: Bearer Tokens for Hub, Open Mode for Local Server

**Date**: 2026-02-23
**Status**: Draft
**Author**: AI-assisted

## Overview

Simplify the authentication architecture by using a single token type (Better Auth session token) and eliminating JWT entirely. The Tauri app uses bearer tokens for hub communication to bypass unreliable webview cookies. The local server operates in open mode, relying on localhost-only binding and CORS restrictions for security.

## Motivation

### Current State

The hub server runs Better Auth with the `bearer()` plugin. The local server validates sessions by making a raw `fetch` to the hub on every unique token, caching results for 5 minutes:

```typescript
// packages/server/src/auth/local-auth.ts (line 108)
const response = await fetch(`${hubUrl}/auth/get-session`, {
	headers: { Authorization: `Bearer ${token}` },
});
```

The sync layer has its own independent auth system with three modes:

```typescript
// packages/sync/src/types.ts
type SyncProviderConfig = {
	token?: string; // Mode 2: static shared secret
	getToken?: () => Promise<string>; // Mode 3: dynamic token fetcher
};
```

The proxy plugin (`packages/server/src/proxy/plugin.ts`) also validates sessions via an injected `validateSession` callback, which in practice would also be a fetch-based check.

This creates problems:

1. **Hub coupling**: Every unique token triggers an HTTP roundtrip to the hub. The 5-minute cache helps, but each new token still incurs network latency + a DB lookup on the hub.
2. **Hub-down fragility**: If the hub is unreachable, the local server falls back to stale cache entries only. New tokens cannot be validated at all.
3. **Environment variable sprawl**: The local server would need `BETTER_AUTH_SECRET` and database access to run Better Auth locally, which defeats the stateless-sidecar design.
4. **Parallel auth systems**: Sync auth (static token / `getToken`) and HTTP auth (Bearer → hub fetch) are completely separate. A user authenticates twice through different mechanisms.
5. **No offline grace period**: Once the cache expires, a valid user gets 401'd if the hub is down: even though their session hasn't actually expired.

### Desired State

A unified auth system using a single session token. The Tauri app authenticates with the hub via Bearer tokens. The local server and local sync layer run without auth, secured by network isolation. Hub-hosted sync and proxy services validate the session token directly against the database.

## Research Findings

### Tauri Webview Cookies Are Unreliable

Tauri's reliance on the system webview (WebKit on macOS, WebView2 on Windows) introduces significant cookie management issues:

- WebKit rejects `Secure` cookies from `tauri://` origins (Issue #2604).
- Two independent cookie jars exist: the webview vs `@tauri-apps/plugin-http` (Issue #13045).
- Debug vs Release builds show inconsistent cookie persistence (Issue #2490).
- Lucia Auth explicitly recommends bearer tokens over cookies for Tauri apps.

**Conclusion**: Tauri apps must use bearer tokens for reliable authentication.

### Better Auth Native App Support

Better Auth provides built-in support for native apps via the `bearer()` plugin:

- The `bearer()` plugin adds a `set-auth-token` response header (source: `packages/better-auth/src/plugins/bearer/index.ts`).
- Sign-in and sign-up endpoints already return `{ token: session.token }` in the response body.
- `createAuthClient` supports `fetchOptions.auth.type: "Bearer"` with a token callback.
- Community plugins like `@daveyplate/better-auth-tauri` implement similar patterns.

### Local Server Doesn't Need Auth

The local server's security model relies on network isolation rather than cryptographic tokens:

- It binds to `localhost` only, preventing external access.
- CORS is restricted to `tauri://localhost`.
- Any local process capable of hitting the API could also read the underlying Yjs files or SQLite database directly.
- Auth on localhost is "defense-in-depth theater": it adds complexity without a meaningful security gain.
- This matches the security model of Docker Desktop, VS Code Server, Raycast, and Obsidian sync.

### Better Auth Token Architecture

Better Auth uses two cookies, not one:

| Cookie                    | Format                                                       | Purpose                       |
| ------------------------- | ------------------------------------------------------------ | ----------------------------- |
| `session_token`           | Opaque random string, HMAC-SHA256 signed                     | Database lookup key           |
| `session_data` (optional) | `compact` (base64+HMAC), `jwt` (HS256), or `jwe` (encrypted) | Read-cache to skip DB lookups |

**Key finding**: The `session_token` is never a JWT. It's a random string that maps to a `session` table row. The HMAC signature prevents cookie tampering, not token forgery.

**Implication**: You cannot validate a `session_token` without the hub's database. This is why the current local-auth.ts must fetch from the hub.

### Better Auth JWT Plugin (Previous Research)

Better Auth provides a `jwt()` plugin for service-to-service auth:

| Aspect                 | Detail                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| Token endpoint         | `GET /auth/token` (requires active session via cookie or bearer)                  |
| JWKS endpoint          | `GET /auth/jwks` (public, no auth required)                                       |
| Default algorithm      | EdDSA with Ed25519 curve                                                          |
| Default TTL            | 15 minutes                                                                        |
| Key storage            | `jwks` database table (`id`, `publicKey`, `privateKey`, `createdAt`, `expiresAt`) |
| Key rotation           | Optional `rotationInterval` (seconds) + `gracePeriod` (default 30 days)           |
| Private key encryption | AES256 GCM by default (can disable)                                               |

**Implication**: While JWT allows local validation, it adds significant complexity (JWKS, rotation, short TTLs, refresh logic) that is unnecessary if the local server doesn't require auth.

### Bearer Plugin Does NOT Validate JWTs

The `bearer()` plugin only handles **opaque session tokens**, not JWTs.

When a request arrives with `Authorization: Bearer <token>`:

1. Bearer plugin extracts the token.
2. Attempts to deserialize it as a **session cookie** (HMAC-SHA256 signed).
3. If valid session token → converts to cookie header → normal session flow.
4. If JWT → fails silently.

### JWKS Validation with jose

The `jose` library provides `createRemoteJWKSet` for fetching and caching public keys. This was the proposed mechanism for local JWT validation before the architecture was simplified.

### Sync Auth Integration

The sync provider's Mode 3 (`getToken` callback) supports dynamic token fetching. The sync server validates tokens in the WebSocket `open` handler.

## Why Not JWT?

The original spec proposed JWT to avoid hub roundtrips on the local server. However, if the local server doesn't need auth at all, there are no roundtrips to avoid. JWT adds complexity (JWKS, jose, token refresh, 15-minute TTL) for a problem that doesn't exist in our threat model.

### Exception: Third-Party OAuth Flow (Cross-Origin)

The "no JWT" decision above applies to first-party use: the Tauri app, local sidecar, and hub sync. These are same-origin or trusted-origin contexts where opaque session tokens work perfectly. The hub can always look up a session in its own database.

Third-party hosted workspaces (e.g., `myapp.com` embedding Epicenter) are a different scenario. They're cross-origin with the hub, so cookies don't apply, and passing raw session tokens to third-party code would be a credential leak. The standard solution is OAuth: the hub acts as an identity provider, third-party apps are relying parties, and the authorization code flow naturally produces JWTs (`access_token`, `id_token`) scoped for cross-origin use. Better Auth's `oauthProvider` plugin handles this. It's a full OAuth 2.1/OIDC provider that issues JWTs signed with keys available at `/jwks`, verified by the hub on WebSocket upgrade for Yjs sync room access.

This is not the same JWT complexity that was rejected. The rejected pattern was "issue JWTs so the local server can validate without hitting the hub", that required `jose` on the sidecar, JWKS caching, token refresh, and TTL management for a threat model that didn't need it. The OAuth pattern is "the hub IS the identity provider, and third-party apps receive standard OAuth tokens." No local JWT validation, no `jose` dependency on the sidecar. The hub verifies its own tokens. See `specs/20260225T210000-workspace-apps-orchestrator.md`, section "Third-Party Auth Flow (Login with Epicenter)" for the full design.

## Design Decisions

| Decision           | Choice                             | Rationale                                                                           |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Auth Token Type    | Better Auth Session Token (Opaque) | Simplest model. Supported natively by Better Auth and the `bearer()` plugin.        |
| Hub Auth Mechanism | Bearer Token                       | Bypasses unreliable Tauri webview cookies.                                          |
| Local Server Auth  | None (Open Mode)                   | Secured by localhost binding and CORS. Auth on localhost is unnecessary complexity. |
| Local Sync Auth    | None (Open Mode)                   | Same as local server.                                                               |
| Hub Sync Auth      | Session Token via Query Param      | Validated by `auth.api.getSession()` at connect time.                               |
| Proxy Plugin Auth  | Session Token via Bearer Header    | Validated by Better Auth directly on the hub.                                       |
| JWT Usage          | Eliminated                         | Over-engineered for the threat model. Adds complexity without benefit.              |
| `jose` Dependency  | Dropped                            | No longer needed for JWT validation.                                                |
| JWKS Endpoint      | Dropped                            | No longer needed.                                                                   |
| Token Storage      | `tauri-plugin-store`               | Persistent, secure storage for the session token on the client.                     |

## Architecture

The new architecture uses ONE token type (Better Auth session token) and eliminates JWT entirely:

```
Tauri App                    Hub Server                   Local Server
    │                         │                              │
    │── POST /auth/sign-in ──►│                              │
    │◄── { token: "ses..." } ─│  (session token in body +    │
    │    + set-auth-token hdr  │   set-auth-token header)     │
    │                         │                              │
    │  store token in         │                              │
    │  tauri-plugin-store     │                              │
    │                         │                              │
    │── Bearer ses... ───────►│  bearer() converts to cookie │
    │◄── 200 OK ──────────────│  Better Auth validates       │
    │                         │                              │
    │── http://localhost ─────────────────────────────────────►│
    │   (no auth needed)       │                              │  localhost-only
    │◄── 200 OK ──────────────────────────────────────────────│  CORS: tauri://localhost
    │                         │                              │
    │── ws://hub/rooms?token=ses... ─►│                      │
    │                         │  auth.api.getSession()       │
    │                         │                              │
    │── ws://localhost/rooms ──────────────────────────────────►│
    │   (no auth needed)                                      │  open mode
```

### Key Points

- **Hub auth**: Session token via `Authorization: Bearer` header. The `bearer()` plugin converts this to a cookie, which Better Auth validates via database lookup.
- **Local server auth**: None. Localhost-only binding and CORS restriction to `tauri://localhost` provide sufficient isolation.
- **Hub sync auth**: Session token passed via query parameter, validated by `auth.api.getSession()` during the WebSocket handshake.
- **Local sync auth**: Open mode (no auth).
- **Proxy plugin auth**: Session token via Bearer header, validated by Better Auth directly (runs on the hub where the database is accessible).

## Implementation Plan

### Phase 1: Local Server Cleanup

- [ ] **1.1** Remove `packages/server/src/auth/local-auth.ts`.
- [ ] **1.2** Remove the hub fetch validator from the local server startup.
- [ ] **1.3** Remove `hubUrl` configuration requirement from the local server (it now defaults to open mode).

### Phase 2: Hub Sync Auth

- [ ] **2.1** Update hub sync layer to use Better Auth `getSession()` for token validation.
- [ ] **2.2** Ensure the `?token=` query parameter is correctly extracted and passed to the validator.

### Phase 3: Proxy Auth

- [ ] **3.1** Update the proxy plugin to validate Bearer tokens using Better Auth's internal API.
- [ ] **3.2** Ensure the proxy runs on the hub where it has database access.

### Phase 4: Frontend Integration

- [ ] **4.1** Configure `createAuthClient` to use `tauri-plugin-store` for token persistence.
- [ ] **4.2** Set `fetchOptions.auth.type` to `"Bearer"` in the auth client.
- [ ] **4.3** Update the sync provider to pass the stored session token in the connection URL.

### Phase 5: Cleanup

- [ ] **5.1** Remove any remaining JWT-related code or configuration.
- [ ] **5.2** Update documentation to reflect the simplified bearer-only model.

## Success Criteria

- [ ] Tauri app successfully signs in and receives an opaque session token.
- [ ] Hub API requests succeed using the `Authorization: Bearer` header.
- [ ] Local server accepts requests from the Tauri app without requiring a token.
- [ ] Local server rejects requests from non-Tauri origins via CORS.
- [ ] Hub sync connections are authorized using the session token.
- [ ] Local sync connections work in open mode.
- [ ] No JWT, `jose`, or JWKS complexity remains in the codebase.

## Revision History

- **v1 (original)**: Proposed a 3-token JWT architecture for local server and sync validation. Over-engineered for the threat model.
- **v2 (current)**: Simplified to bearer-only for hub communication and open mode for the local server. Eliminated JWT, `jose`, and JWKS entirely.
