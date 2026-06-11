# Per-Workspace Envelope Encryption

**Date**: 2026-03-14
**Status**: Superseded by `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`
**Depends on**: `specs/20260314T063000-encryption-wrapper-hardening.md` (mode system, AAD, error containment)
**Builds on**: `specs/20260313T180100-client-side-encryption-wiring.md` (key delivery to apps)
> **Superseded (2026-03-14)**: This full envelope encryption spec has been replaced by a simpler HKDF-based approach with tighter per-user blast radius. See `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`.
>
> **Key differences**: Random DEKs + Postgres storage → deterministic HKDF derivation (no storage). Per-workspace blast radius → per-user-per-workspace blast radius. Envelope encryption deferred to Phase 3 (if enterprise demand warrants it).
>
> The original content below is preserved for context but should not be executed as-is.

## Overview

Replace the deployment-wide encryption key (`SHA-256(BETTER_AUTH_SECRET)`) with per-workspace data encryption keys (DEKs). Each workspace gets a random 32-byte DEK, wrapped (encrypted) by a server-derived key encryption key (KEK) and stored in Postgres. This limits blast radius to one workspace per compromised key and enables key rotation without re-encrypting data.

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

1. **Deployment-wide blast radius.** One compromised client can decrypt any captured ciphertext from any workspace in the deployment. The key is identical for every user and workspace.
2. **No key rotation.** Rotating `BETTER_AUTH_SECRET` changes the encryption key for every workspace simultaneously. Existing ciphertext becomes unreadable unless you re-encrypt everything in one atomic operation.
3. **No path to workspace sharing.** If users A and B share a workspace, they need the same DEK. With a deployment-wide key this is trivially true, but it's the wrong kind of "sharing". It means every user can read every workspace.

### Desired State

```typescript
// Server: per-workspace DEK, lazy creation
const dek = await getOrCreateWorkspaceDek({ db, workspaceId, userId });

// Client: workspace-scoped key fetch
const response = await fetch(`/workspaces/${workspaceId}/key`);
const { dek } = await response.json();
workspaceKeyCache.set(workspaceId, base64ToBytes(dek));

// Workspace: closes over its own key
createEncryptedKvLww(yarray, {
  key: workspaceKeyCache.getSync(workspaceId),
});
```

## Research Findings

### Key Hierarchy Options

| Option | DEK source | Storage | Master compromise | Key rotation | Sharing |
|--------|-----------|---------|-------------------|--------------|---------|
| A: HKDF derivation | `HKDF(master, userId + wsId)` | None | All keys compromised | Re-derive all | Broken (different per user) |
| B: Random DEK + server KEK wrap | `randomBytes(32)`, wrapped by KEK | Postgres | Re-wrap needed | Re-wrap only, no re-encrypt | Works (same DEK, multiple wrapped copies) |
| C: Random DEK + password wrap | `randomBytes(32)`, wrapped by PBKDF2(password) | Postgres | N/A (zero-knowledge) | Re-wrap on password change | Needs public-key envelopes |

**Key finding**: Option A doesn't work for workspace sharing. Alice and Bob would derive different keys and can't read the same Yjs ciphertext. Option B is the right balance for both cloud and self-hosted.

**Implication**: Use Option B for server-managed mode. Defer Option C (zero-knowledge + sharing) to a future spec requiring public-key infrastructure.

### Performance Overhead

| Operation | Cost | Frequency |
|-----------|------|-----------|
| `SELECT workspace_user_key` | ~5-20ms (Hyperdrive) | Once per workspace open |
| `INSERT` new DEK + wrap | ~10-30ms | Once per workspace creation |
| HKDF KEK derivation | Sub-ms | Once per workspace key fetch |
| AES-GCM unwrap (32 bytes) | Sub-ms | Once per workspace key fetch |
| Per-value encrypt/decrypt | Unchanged | Every write/read (key is in memory) |

**Key finding**: The only added latency is one Postgres query per workspace open. This is a workspace-open cost, not a per-sync-message cost. Negligible.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Key hierarchy | Random DEK per workspace, wrapped by server KEK | Blast radius = 1 workspace. KEK rotation = re-wrap, not re-encrypt. Sharing = insert wrapped copy. |
| KEK derivation | `HKDF(SHA-256(WORKSPACE_KEY_SECRET), 'kek-v' + version)` | Separate secret from `BETTER_AUTH_SECRET` so auth rotation and key rotation are independent. HKDF with version label supports KEK rotation. |
| DEK delivery | `GET /workspaces/:id/key` endpoint (lazy) | Fetch on workspace open, not on login. Avoids loading keys for workspaces the user hasn't opened. Session token authenticates the request. |
| Storage | `workspace_user_key` table in Postgres | One row per (workspace, user) pair. Wrapped DEK + nonce + scheme + KEK version. ~300-500 bytes per row. |
| KeyCache scope | Per-workspace (not per-user) | `workspaceKeyCache.get(workspaceId)` returns the DEK for that workspace. Multi-workspace support is a map lookup. |
| Migration from global key | One-time decrypt + re-encrypt per workspace | No existing production data (all apps use passthrough). If data existed, would need a migration worker. |
| Zero-knowledge sharing | Deferred | Requires public-key envelopes (each user's DEK copy wrapped to their public key). Large effort, different UX. Out of scope. |

## Architecture

### Key Hierarchy

```
WORKSPACE_KEY_SECRET (env var, separate from BETTER_AUTH_SECRET)
       │
       │  HKDF(SHA-256(secret), 'kek-v1')
       ▼
┌──────────────┐
│  KEK v1      │  (server-side only, never leaves the server)
└──────┬───────┘
       │  AES-GCM wrap
       ▼
┌──────────────────────────────────────────────────┐
│  workspace_user_key table (Postgres)             │
│                                                  │
│  workspace_id │ user_id │ wrapped_dek │ kek_v │  │
│  ws-1         │ usr-A   │ base64(...) │ 1     │  │
│  ws-1         │ usr-B   │ base64(...) │ 1     │  │  ← same DEK, different wraps
│  ws-2         │ usr-A   │ base64(...) │ 1     │  │
└──────────────────────────────────────────────────┘
       │
       │  unwrap → raw 32-byte DEK
       ▼
┌──────────────────────────────────────────────────┐
│  Client (in-memory)                              │
│                                                  │
│  workspaceKeyCache.set('ws-1', dek)              │
│  key: cache.getSync('ws-1') │
│  createEncryptedKvLww(yarray, { key })        │
└──────────────────────────────────────────────────┘
```

### Login → First Encrypted Write

```
1. User authenticates with Better Auth
   └── Session token issued (no encryption key in session anymore)

2. App opens workspace 'ws-1'
   └── Client: GET /workspaces/ws-1/key (session cookie authenticates)

3. Server handles key request
   ├── Check user has access to ws-1
   ├── SELECT wrapped_dek, wrap_nonce, kek_version FROM workspace_user_key
   │   WHERE workspace_id = 'ws-1' AND user_id = current_user
   ├── If no row: generate random DEK, wrap with KEK, INSERT, return
   ├── Derive KEK: HKDF(SHA-256(WORKSPACE_KEY_SECRET), 'kek-v' + version)
   ├── Unwrap: AES-GCM decrypt(wrapped_dek, kek, wrap_nonce)
   └── Return { dek: base64(raw_dek), kekVersion: 1 }

4. Client receives DEK
   ├── workspaceKeyCache.set('ws-1', base64ToBytes(dek))
   └── wrapper.activateEncryption(dek)  ← from hardening spec

5. First encrypted write
   └── kv.set('tab-1', data) → encryptValue(json, dek, aad) → inner CRDT
```

## Implementation Plan

### Phase 1: Server Infrastructure

- [ ] **1.1** Add `WORKSPACE_KEY_SECRET` env var to `wrangler.jsonc` and local dev config. Separate from `BETTER_AUTH_SECRET`.
- [ ] **1.2** Create `workspace_user_key` Drizzle schema and Postgres migration.
- [ ] **1.3** Implement server-side helpers: `deriveKek(secret, version)`, `wrapDek(dek, kek)`, `unwrapDek(wrappedDek, nonce, kek)`, `getOrCreateWorkspaceDek({ db, workspaceId, userId })`.
- [ ] **1.4** Add `GET /workspaces/:id/key` Hono route. Authenticates via session, checks workspace access, returns unwrapped DEK as base64.

### Phase 2: Client Key Cache

- [ ] **2.1** Create `WorkspaceKeyCache` interface: `set(workspaceId, key)`, `getSync(workspaceId)`, `clear()`. In-memory implementation (Map). Replaces per-user `KeyCache` for the encryption use case.
- [ ] **2.2** Create `fetchWorkspaceKey(workspaceId)` async helper that calls the endpoint, decodes the DEK, stores in cache, and calls `wrapper.activateEncryption(key)`.

### Phase 3: Per-App Wiring

- [ ] **3.1** Remove `encryptionKey` from `customSession` plugin response. Session no longer carries the key.
- [ ] **3.2** **epicenter**: On workspace open, call `fetchWorkspaceKey`. Pass `key: workspaceKeyCache.getSync(wsId)` to `createWorkspace`.
- [ ] **3.3** **whispering**: Same pattern.
- [ ] **3.4** **tab-manager**: Same pattern. Verify Chrome extension can call the key endpoint.

### Phase 4: Key Rotation Support

- [ ] **4.1** Add `rewrapWorkspaceKeys({ db, fromVersion, toVersion, limit })`: batch re-wrap DEKs when KEK version changes. Background-safe (idempotent, limit-based).
- [ ] **4.2** Support a small keyring of encrypted + retired KEK versions. Unwrap tries current version, falls back to `kek_version` from the row.

### Phase 5: Workspace Sharing (Future)

- [ ] **5.1** `shareWorkspaceDek({ db, workspaceId, ownerUserId, targetUserId })`: reads owner's wrapped DEK, unwraps, re-wraps for target user's KEK, inserts new row.
- [ ] **5.2** Access control check before sharing.

### Phase 6: Verify

- [ ] **6.1** `bun test` in `packages/workspace`: all pass
- [ ] **6.2** `bun run typecheck`: clean
- [ ] **6.3** Manual: sign in → open workspace → verify DEK fetched → new writes produce EncryptedBlob → sign out → workspace locked

## Edge Cases

### First workspace open (no DEK exists yet)

1. `GET /workspaces/ws-1/key` → no row in `workspace_user_key`
2. Server generates `randomBytes(32)` DEK, wraps with current KEK, inserts row
3. Returns freshly created DEK
4. Subsequent opens hit the existing row

### KEK rotation

1. Admin changes `WORKSPACE_KEY_SECRET` and bumps KEK version
2. Old wrapped DEKs use `kek_version: 1`, new KEK is version 2
3. Unwrap checks row's `kek_version`, derives the matching KEK
4. Background job calls `rewrapWorkspaceKeys` to migrate rows to version 2
5. Old version KEK can be retired once all rows are re-wrapped

### User loses access to workspace

1. Remove row from `workspace_user_key` for that user
2. User's next `GET /workspaces/:id/key` returns 403
3. Client can't fetch DEK → workspace stays locked
4. Ciphertext in the Yjs doc is still encrypted with the workspace DEK: removing access doesn't require re-encryption (user already had the DEK in memory during their session)

### Offline with cached key

1. User opens workspace, DEK cached in memory
2. Network goes down
3. Reads/writes continue locally (CRDT)
4. Sync resumes when network returns: no key re-fetch needed (key is in memory)
5. Full page refresh without network → no key available → workspace locked until network returns (unless persistent KeyCache is implemented)

## Open Questions

1. **Should the key endpoint return the DEK directly, or should the client derive it?**
   - Direct: simpler, fewer client-side crypto operations.
   - Client-derive: server never sees the raw DEK (true for Option C, not for Option B).
   - **Recommendation**: Direct for server-managed mode. The server already wraps/unwraps: it has the raw DEK transiently. Pretending otherwise is security theater for cloud mode.

2. **Should we implement persistent `WorkspaceKeyCache` now?**
   - Without it: every page refresh requires a network roundtrip before decryption works.
   - With it: workspace decrypts instantly from cache, auth roundtrip happens in background.
   - **Recommendation**: Start with in-memory only. Add `sessionStorage` persistence as a fast follow if refresh latency is noticeable.

3. **Workspace ID source: where does the workspace ID come from?**
   - Currently workspaces are implicitly single per user (no workspace ID in URLs or schemas).
   - Per-workspace keys require an explicit workspace ID.
   - **Recommendation**: Use the Yjs doc name as the workspace ID. It's already unique per workspace.

4. **Should the DEK endpoint be part of the sync WebSocket handshake or a separate HTTP call?**
   - WebSocket: fewer round-trips, key arrives with the sync connection.
   - HTTP: simpler, cacheable, no coupling between key delivery and sync protocol.
   - **Recommendation**: Separate HTTP endpoint. Keep concerns decoupled. The key fetch is a one-time cost per workspace open.

## Success Criteria

- [ ] Each workspace has its own unique random DEK
- [ ] DEKs are wrapped with a server KEK and stored in Postgres
- [ ] `WORKSPACE_KEY_SECRET` is separate from `BETTER_AUTH_SECRET`
- [ ] `GET /workspaces/:id/key` returns the unwrapped DEK for authorized users
- [ ] Key rotation (KEK version bump) requires only re-wrapping, not re-encrypting data
- [ ] Workspace sharing inserts a wrapped DEK copy for the new user
- [ ] All existing tests pass, typecheck clean, apps build
- [ ] Removed deployment-wide `encryptionKey` from session response

## References

- `apps/api/src/app.ts`: current `deriveKeyFromSecret` and `customSession` (to be replaced)
- `packages/workspace/src/shared/crypto/index.ts`: encryption primitives (unchanged)
- `packages/workspace/src/shared/crypto/key-cache.ts`: `KeyCache` interface (to be extended/replaced with `WorkspaceKeyCache`)
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: `lock()` and `activateEncryption()` from hardening spec
- `specs/20260314T063000-encryption-wrapper-hardening.md`: prerequisite (mode system, AAD, error containment)
- `specs/20260313T180100-client-side-encryption-wiring.md`: original wiring plan (Phases 1-3 still apply for per-app integration)
- NIST SP 800-38D: AES-GCM nonce uniqueness requirements
- AWS Encryption SDK concepts: envelope encryption pattern reference
