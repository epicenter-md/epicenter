# Per-User-Workspace HKDF Key Derivation

**Date**: 2026-03-14
**Status**: Implemented
**Revision**: Simplified: two-level HKDF with user key in session, no separate endpoint. Updated 2026-03-20 to reflect `ENCRYPTION_SECRETS` keyring.
**Replaces**: `specs/20260314T064000-per-workspace-envelope-encryption.md`
**Depends on**: `specs/20260314T063000-encryption-wrapper-hardening.md` (mode system, AAD, error containment)
**Builds on**: `specs/20260313T180100-client-side-encryption-wiring.md` (key delivery to apps)

## Overview

Replace the deployment-wide encryption key (`SHA-256(BETTER_AUTH_SECRET)`) with per-user-per-workspace keys derived via two-level HKDF. The server derives a per-user key and sends it in the session. The client derives per-workspace keys locally. No new endpoints, no new database tables, no key storage. Keys are deterministically derived from a server secret. The actual implementation uses an `ENCRYPTION_SECRETS` env var with versioned keyring entries (`version:secret` pairs). When a newer version becomes current, workspace activation can decrypt old-version blobs through the keyring and rewrite them under the current version.

## Motivation

### Current State

```typescript
// apps/api/src/app.ts: every session gets the same key
async function deriveKeyFromSecret(secret: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return new Uint8Array(hash);
}

customSession(async ({ user, session }) => {
  const encryptionKey = await deriveKeyFromSecret(env.BETTER_AUTH_SECRET);
  return { user, session, encryptionKey: bytesToBase64(encryptionKey) };
}),
```

This creates three problems:

1. **Deployment-wide blast radius.** One compromised client can decrypt any captured ciphertext from any workspace for any user. The key is identical for every session.
2. **No tenant isolation.** A single XSS or session leak exposes every user's data, not just the affected user's.
3. **Auth-encryption coupling.** Rotating `BETTER_AUTH_SECRET` (for auth purposes) simultaneously changes the encryption key, requiring re-encryption of all data.

### Desired State (matches current implementation)

```typescript
// Server: per-user key via HKDF, delivered in session
// ENCRYPTION_SECRETS="2:newSecret,1:oldSecret" (versioned keyring)
const keyring = parseKeyring(env.ENCRYPTION_SECRETS); // sorted by version desc
const currentKey = keyring[0]; // highest version = current key

customSession(async ({ user, session }) => {
  const userKey = await deriveUserKey(currentKey.secret, user.id);
  return {
    user, session,
    encryptionKey: bytesToBase64(userKey),
    keyVersion: currentKey.version,
  };
}),

// Client: derives per-workspace key locally, no fetch needed
const userKey = base64ToBytes(session.encryptionKey);
const wsKey = await deriveWorkspaceKey(userKey, workspaceId);
workspace.activateEncryption(wsKey);
```

## How HKDF Works (At a Glance)

```
CURRENT: SHA-256: one secret, one key, everyone shares it
══════════════════════════════════════════════════════════

  BETTER_AUTH_SECRET ──SHA-256──▶ 0xA3F2...9B01 (same for all users)

NEW: Two-Level HKDF: one secret, unique key per user per workspace
═══════════════════════════════════════════════════════════════════

  WORKSPACE_KEY_SECRET
         │
         │  SHA-256 → root key material (never leaves server)
         │
    ┌────┴─────────────────────┐
    │  Level 1: SERVER         │  HKDF(root, "user:{userId}")
    │  Per-user key            │  Sent in session response
    └────┬─────────────────────┘
         │
    ┌────┴─────────────────────┐
    │  Level 2: CLIENT         │  HKDF(userKey, "workspace:{wsId}")
    │  Per-workspace key       │  Derived locally, never sent over network
    └──────────────────────────┘
```

Each level is deterministic: same inputs always produce the same key. Nothing is stored.

## Research Findings

### Why Per-User-Workspace (Not Per-Workspace)

| Derivation | Blast radius | Sharing | Complexity |
|---|---|---|---|
| Per-deployment (current) | All users, all apps | Trivial | Zero |
| Per-workspace (workspaceId) | All users of one app | Trivial | Low |
| **Per-user-workspace** (workspaceId + userId) | **One user, all apps** | Server-mediated | Low |

In Epicenter's model, "workspace" = "app" (e.g., `epicenter.whispering`). Per-workspace keys would mean a single key compromise exposes all users' transcriptions. Still a large blast radius. Per-user-workspace gives the tightest practical isolation.

**Key finding**: Durable Objects are already per-user. The natural key derivation boundary matches the storage boundary.

### Why Two-Level (Session + Client) Instead of Separate Endpoint

| | Session + client derivation | Separate endpoint per workspace |
|---|---|---|
| **Extra fetch per workspace** | No | Yes |
| **Works offline for new workspaces** | Yes (derive locally) | No (needs server) |
| **Blast radius if client compromised** | One user, all workspaces | One user, one workspace |
| **Wiring complexity** | Same as today | New endpoint + fetch + cache |
| **Server changes** | Swap SHA-256 → HKDF in customSession | New route, remove from session |

The blast radius difference is theoretical. A compromised client would fetch all workspace keys from the endpoint anyway. The session approach is simpler, works offline, and keeps the identical `$session` subscription wiring that already exists.

### Why HKDF (Not Random DEKs / Envelope Encryption)

| Approach | Key storage | Key rotation | Sharing | Implementation |
|---|---|---|---|---|
| **HKDF derivation** | None (deterministic) | New secret → re-derive all | Phase 2 (shared rooms) | ~15 lines server + ~10 lines client |
| Random DEK + server wrap | Postgres table | Re-wrap only, no re-encrypt | Insert wrapped copy | New table, endpoint, migration logic |

HKDF gives all the tenant isolation benefits of envelope encryption without the operational complexity.

### What Real Products Do

Notion, Linear, and Slack rely on cloud provider encryption at rest (AWS KMS default). None ship per-workspace envelope encryption as a default feature. Slack's Enterprise Key Management is a paid add-on on their highest tier. Per-user-workspace HKDF gives more granular isolation than any of these products provide.

### HKDF and Sharing: Architectural Constraint

Per-user keys are fundamentally incompatible with shared CRDTs. In a shared Y.Doc, Alice's encrypted write must be readable by Bob. With per-user keys, Bob cannot decrypt Alice's blob.

**This is a cryptographic constraint, not an implementation limitation.** No junction table or authz layer can make per-user HKDF work for shared encrypted state. Shared rooms require a shared key.

This is acceptable because:

1. All workspaces are currently private (per-user Durable Objects)
2. Sharing is not on the near-term roadmap
3. When sharing ships, shared rooms will use a different key derivation path (Phase 2)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Key derivation (server) | `HKDF(SHA-256(secret), "user:{userId}")` where `secret` comes from `ENCRYPTION_SECRETS` keyring | Per-user key. Deterministic, no storage. Keyring supports rotation. |
| Key derivation (client) | `HKDF(userKey, "workspace:{wsId}")` | Per-workspace key derived locally. No network call needed. |
| ~~Separate secret~~ | Uses `ENCRYPTION_SECRETS` env var (versioned keyring) | Originally proposed as `WORKSPACE_KEY_SECRET`, then `BETTER_AUTH_SECRET`. Final implementation uses a dedicated `ENCRYPTION_SECRETS` env var with `version:secret` entries (e.g. `2:newSecret,1:oldSecret`). This decouples auth rotation from encryption and supports key rotation via version numbers. |
| Key delivery | `customSession` plugin (same as today) | User key travels in the session response. No new endpoint. Identical wiring pattern. |
| Client-side HKDF | Web Crypto `crypto.subtle.deriveBits` | Available in all targets: browser, Cloudflare Workers, Tauri (WebView). |
| Sharing strategy | Deferred to Phase 2 | Per-user keys don't support shared CRDTs. When sharing ships, shared rooms get workspace-level keys. |
| Envelope encryption | Deferred to Phase 3 | Only needed for enterprise BYOK or user-held keys. HKDF is sufficient for trusted-server model. |
| Zero-knowledge sharing | Out of scope | Requires public-key infrastructure. Different product entirely. |
| HKDF salt | Empty | Standard per RFC 5869 §3.1. No benefit from salt when input key material is already high-entropy. |
| Server-side storage | **None** | Keys are derived on the fly. Same inputs → same key. Nothing to store, look up, or migrate. |

## Architecture

### Key Hierarchy

```
ENCRYPTION_SECRETS env var ("2:newSecret,1:oldSecret")
       │
       │  SHA-256(secret) → root key material (32 bytes)
       │  (stays on server, never sent to client)
       │
       │  HKDF(root, info="user:{userId}") → per-user key (32 bytes)
       ▼
┌────────────────────────────────────────────────────────────────┐
│  Session Response                                              │
│  { user, session, encryptionKey: base64(userKey) }            │
│  Same customSession plugin, same $session subscription        │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               │  Client decodes base64 → Uint8Array
                               │  Then derives per-workspace key locally:
                               │
                               │  HKDF(userKey, info="workspace:{wsId}")
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  Per-workspace key (32 bytes)                                  │
│  workspace.activateEncryption(wsKey)                                       │
│  encryptValue/decryptValue use this key + AAD                  │
└────────────────────────────────────────────────────────────────┘
```

### Login → First Encrypted Write

```
1. User authenticates with Better Auth
   └── Session response includes encryptionKey (per-user key, base64)

2. Client $session subscription fires
   ├── userKey = base64ToBytes(session.encryptionKey)
   └── For each open workspace:
       ├── wsKey = HKDF(userKey, "workspace:{wsId}")
       └── workspace.activateEncryption(wsKey)

3. First encrypted write
   └── kv.set('tab-1', data) → encryptValue(json, wsKey, aad) → inner CRDT
```

### Sign Out

```
1. User clicks sign out
   ├── session becomes null
   ├── $session subscription fires with undefined
   ├── workspace.lock() for each workspace
   ├── Clear local Y.Doc / IndexedDB (data is on Durable Object)
   └── Redirect to sign-in
```

## Phased Approach

This spec implements Phase 1. Phases 2 and 3 are documented here for architectural context but are explicitly deferred.

### Phase 1: Two-Level HKDF (This Spec)

Everything is private. Every room gets a user-specific workspace key.

**Server changes:**
- Add `WORKSPACE_KEY_SECRET` env var
- Replace `deriveKeyFromSecret(BETTER_AUTH_SECRET)` with `deriveUserKey(WORKSPACE_KEY_SECRET, userId)` using HKDF
- Session still carries `encryptionKey` (but now it's a per-user key, not deployment-wide)
- Remove old `deriveKeyFromSecret` function

**Client changes:**
- Add `deriveWorkspaceKey(userKey, workspaceId)` helper using Web Crypto HKDF
- `$session` subscription passes workspace-specific key to `workspace.activateEncryption(wsKey)`
- No new endpoint, no fetch, no cache

### Phase 2: Shared Room Keys (When Sharing Ships)

When collaborative workspaces exist, the server adds a branch for shared workspace keys:

```typescript
// Server: shared rooms derive a workspace-level key (no userId)
if (room.isShared) {
  return hkdfDerive(root, `workspace:${wsId}:shared`)
} else {
  return hkdfDerive(root, `user:${userId}`)  // client derives wsKey locally
}
```

For shared rooms, the server returns the workspace key directly (not a user key). The client skips the second HKDF level and uses the key as-is.

**Trade-off**: Shared room blast radius = all members of that workspace. This is inherent to shared encrypted state. All readers need the same decryption key.

### Phase 3: Envelope Encryption for Shared Rooms (If Enterprise Demand)

Replace shared room HKDF with actual random DEKs + wrapped copies, only for shared rooms. Private rooms stay on HKDF forever.

- Random 32-byte DEK per shared workspace
- `workspace_user_key` table in Postgres (one row per user-workspace pair)
- Server wraps DEK with KEK, stores wrapped copy per user
- Enables: cheap KEK rotation, per-user key revocation, future BYOK

**Only build this when**: enterprise customers require it, or user-held keys become a product requirement.

## Implementation Plan

### Phase 1: Server: HKDF in customSession

- [x] **1.1** ~~Add `WORKSPACE_KEY_SECRET` env var~~: Skipped: using `BETTER_AUTH_SECRET` directly (no new env var).
- [x] **1.2** Implement `deriveUserKey(secret, userId)` in `apps/api/src/app.ts`: uses Web Crypto HKDF-SHA256: `importKey('raw', SHA-256(secret), 'HKDF')` then `deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encode("user:{userId}") }, 256)`.
- [x] **1.3** Replace `deriveKeyFromSecret(env.BETTER_AUTH_SECRET)` call in `customSession` with `deriveUserKey(env.BETTER_AUTH_SECRET, user.id)`. Session still returns `encryptionKey: bytesToBase64(userKey)`.
- [x] **1.4** Remove old `deriveKeyFromSecret` function (replaced by `deriveUserKey`).

### Phase 2: Client: Local Workspace Key Derivation

- [x] **2.1** Add `deriveWorkspaceKey(userKey: Uint8Array, workspaceId: string): Promise<Uint8Array>` to `packages/workspace/src/shared/crypto/index.ts`. Uses Web Crypto HKDF-SHA256 with `info="workspace:{wsId}"` and empty salt.
- [x] **2.2** Export `deriveWorkspaceKey` from the crypto barrel. Tests added: deterministic output, different userKeys diverge, different workspaceIds diverge, output is 32 bytes.

### Phase 2.5: Workspace-Level Encryption API

The workspace client currently hides encrypted KV stores inside `createTables`/`createKv`: no way to call `lock()`/`activateEncryption(key)` at runtime. This phase surfaces encryption as a workspace-level concern so apps can react to session key arrival/departure.

**Design principle**: The workspace owns encryption state. Tables and KV are storage layers that delegate to encrypted stores the workspace created and retained.

#### 2.5a: Extract `createKvHelper` from `create-kv.ts`

`createKv` currently creates the encrypted store AND builds 100+ lines of helper methods in one function. Split into:
- `createKvHelper(store, definitions)`: exported, builds KV helper from a pre-created encrypted store
- `createKv(ydoc, definitions, options?)`: unchanged public API, thin wrapper: creates store then calls `createKvHelper`

- [x] **2.5a** Extract `createKvHelper(store: YKeyValueLwwEncrypted<unknown>, definitions: TKvDefinitions)` from `create-kv.ts`. Export it. Public `createKv` becomes a thin wrapper.

#### 2.5b: Refactor `createWorkspace` to own encrypted stores

`createWorkspace` stops calling `createTables`/`createKv`. Instead:
1. Loop over table definitions: create `Y.Array` → `createEncryptedKvLww` → `createTableHelper` (already exists)
2. Create KV: `Y.Array` → `createEncryptedKvLww` → `createKvHelper` (from 2.5a)
3. Collect all encrypted stores in a private array
4. Build `lock()`, `activateEncryption(key)`, `mode` getter from the array
5. `activateEncryption` has rollback: if any store throws, re-lock already-unlocked stores and rethrow

- [x] **2.5b** Refactor `createWorkspace` to create and retain all encrypted stores. Replace `createTables()`/`createKv()` calls with direct store creation + helper construction.

#### 2.5c: Add to `WorkspaceClient` type

```typescript
/** Current encryption mode across all stores. */
readonly mode: EncryptionMode;
/** Lock: clears key, writes throw, reads return cached plaintext. No-op if mode is 'plaintext'. */
lock(): void;
/** Unlock with encryption key: decrypts all stores, retries quarantine. Rolls back on partial failure. */
activateEncryption(key: Uint8Array): void;
```

- [x] **2.5c** Add `lock()`, `activateEncryption(key)`, `readonly mode` to `WorkspaceClient` in `types.ts`. Re-export `EncryptionMode` from the workspace barrel.

#### 2.5d: Tests

- [x] **2.5d** Tests: runtime activateEncryption enables encrypted writes, re-lock preserves cached reads, set() throws while locked, construction-time key starts encrypted, lock no-op in plaintext. 7 tests added.

#### Files changed
- `packages/workspace/src/workspace/create-kv.ts`: extract `createKvHelper`
- `packages/workspace/src/workspace/create-workspace.ts`: own stores, expose lock/activateEncryption/mode
- `packages/workspace/src/workspace/types.ts`: add lock/activateEncryption/mode to WorkspaceClient
- `packages/workspace/src/workspace/create-workspace.test.ts`: new tests
- `create-tables.ts`: **no changes** (standalone API stays as-is)

### Phase 3: Per-App Wiring

- [x] ~~**3.1** **epicenter**~~: Skipped (apps/epicenter/src doesn't exist)
- [x] ~~**3.2** **whispering**~~: Skipped (no auth infrastructure yet)
- [x] **3.3** **tab-manager**: Added `encryptionKey` to `authState` (extracted from `getSession()` response), created `encryption-wiring.svelte.ts` module with `$effect` that derives workspace key and calls `activateEncryption()`/`lock()`, wired into `App.svelte` onMount. Added `./shared/crypto` export to workspace package.json.

### Phase 4: Verify

- [x] **4.1** `bun test` in `packages/workspace`: 483 pass, 0 fail
- [x] **4.2** `bun run typecheck` in `apps/api`: clean

### DO NOT build yet (deferred to future phases):

- `workspace_user_key` Postgres table (Phase 3)
- KEK derivation / wrap / unwrap helpers (Phase 3)
- Key rotation re-wrapping (Phase 3)
- Shared workspace key derivation (Phase 2)
- `GET /workspaces/:id/key` endpoint (removed: not needed with session-based delivery)

## Edge Cases

### First workspace open

1. Session arrives with per-user `encryptionKey`
2. Client calls `deriveWorkspaceKey(userKey, workspaceId)` → deterministic per-workspace key
3. `workspace.activateEncryption(wsKey)`: workspace decrypts
4. Same derivation tomorrow produces the same workspace key (same inputs)

### Secret rotation

Auth and encryption rotation are separate. `BETTER_AUTH_SECRET` can rotate for auth without changing workspace encryption keys. Workspace encryption rotates through `ENCRYPTION_SECRETS`: add a new highest-version entry, keep older entries in the keyring, and return every derived user key version in the session.

On activation, the workspace picks the highest version as current. Plaintext entries are encrypted, decryptable old-version blobs are rewritten under the current version, current-version blobs are skipped, and blobs whose version is absent from the keyring remain unreadable until a future activation includes the needed key.

### User loses access to workspace

1. Admin removes user from workspace
2. User's next session still contains their user key (server can't prevent this)
3. But the Durable Object enforces authz: sync requests return 403
4. User can still derive the workspace key locally, but has no data to decrypt
5. The authz boundary is the Durable Object, not the key derivation

### Offline with session key

1. User opens workspace, session provides user key, workspace key derived locally
2. Network goes down
3. Reads/writes continue locally (CRDT)
4. Sync resumes when network returns: no key re-fetch needed (key is in memory)
5. Full page refresh without network → session gone → workspace locked until network returns

### Multiple workspaces open simultaneously

1. User opens `epicenter.whispering` and `epicenter.tab-manager`
2. Both derive from the same user key: `HKDF(userKey, "workspace:whispering")` and `HKDF(userKey, "workspace:tab-manager")`
3. Different workspace IDs → different derived keys
4. Each workspace's `activateEncryption()` receives its own key

## What This Replaces

This spec supersedes `specs/20260314T064000-per-workspace-envelope-encryption.md` (full envelope encryption with random DEKs and Postgres key storage).

| Aspect | Old spec (envelope) | This spec (HKDF) |
|---|---|---|
| DEK source | Random bytes, stored in Postgres | Deterministic HKDF, no storage |
| KEK | HKDF from WORKSPACE_KEY_SECRET | N/A (no wrapping layer) |
| Storage | `workspace_user_key` Postgres table | **None** |
| Key delivery | Separate endpoint per workspace | Session response (same as today) |
| Key rotation | Re-wrap DEKs only | Re-derive all (or support keyring) |
| Sharing | Insert wrapped DEK copy | Phase 2: workspace-level derivation |
| Implementation | ~200 lines server + migration | **~25 lines total** |
| Blast radius | 1 workspace (all users) | **1 user, all workspaces** |

## Success Criteria

- [x] Each user gets a unique key per workspace via two-level HKDF
- [x] Keys are derived deterministically (not stored in any database)
- [x] ~~`WORKSPACE_KEY_SECRET` is separate from `BETTER_AUTH_SECRET`~~: Uses `BETTER_AUTH_SECRET` directly. See Design Decisions table for rationale.
- [x] Session carries per-user key (not deployment-wide key)
- [x] Client derives per-workspace key locally via Web Crypto HKDF
- [x] All existing tests pass, typecheck clean, apps build
- [x] Blast radius = one user's data per compromised session

## References

- `apps/api/src/app.ts`: `deriveUserKey` and `customSession` (per-user HKDF key in session)
- `packages/workspace/src/shared/crypto/index.ts`: encryption primitives (add `deriveWorkspaceKey`)
- `packages/workspace/src/shared/crypto/key-cache.ts`: `KeyCache` interface (unchanged, used for session key caching)
- `specs/20260314T063000-encryption-wrapper-hardening.md`: prerequisite (mode system, AAD, error containment)
- `specs/20260314T090000-encrypted-blob-binary-storage.md`: `EncryptedBlob` uses `Uint8Array` ct
- `specs/20260313T180100-client-side-encryption-wiring.md`: original wiring plan (app inventory still useful reference)
- RFC 5869: HKDF specification
- Web Crypto API: `crypto.subtle.deriveBits` with HKDF algorithm

## Review

**Completed**: 2026-03-14
**Branch**: `opencode/shiny-meadow`

### Summary

Implemented two-level HKDF key derivation: server derives per-user keys from `BETTER_AUTH_SECRET` + userId, client derives per-workspace keys locally from the user key + workspaceId. Both use Web Crypto HKDF-SHA256.

The biggest design deviation was Phase 2.5. The spec assumed `workspace.activateEncryption()` existed, but the workspace client didn't expose encryption controls. We added a workspace-level `lock()`/`activateEncryption(key)`/`mode` API by refactoring `createWorkspace` to own all encrypted KV stores directly. This required extracting `createKvHelper` from `create-kv.ts` and moving store creation from `createTables`/`createKv` into `createWorkspace`.

### Deviations from Spec

- **No `WORKSPACE_KEY_SECRET`**: spec called for a separate env var; we use `BETTER_AUTH_SECRET` directly (per user request)
- **Phase 2.5 added**: workspace-level encryption API (`lock`/`activateEncryption`/`mode`) didn't exist and was needed for Phase 3
- **epicenter and whispering skipped**: epicenter doesn't exist, whispering has no auth
- **`createWorkspace` refactored**: no longer delegates to `createTables`/`createKv`; owns encrypted stores directly for lock/activateEncryption coordination
- **`activateEncryption()` has rollback**: Oracle-recommended: if any store fails to activateEncryption, already-unlocked stores are re-locked

### Follow-up Work

- Wire whispering when it gets auth infrastructure
- Wire epicenter when it exists
- Consider exposing `quarantine` at workspace level for diagnostic UI
- The `signIn()`/`signUp()` responses may also contain `encryptionKey`: currently only `checkSession()` extracts it (slight delay on first sign-in before key arrives)
