# Self-Managed Encryption Password

**Date**: 2026-04-01
**Status**: Draft
**Author**: AI-assisted (Sisyphus + Oracle + Librarian research)

## Overview

Add an opt-in mode where users provide their own encryption password instead of relying on the server-derived key. The server never sees the encryption key in this mode. Functionally zero-knowledge. Users can switch between server-managed and self-managed encryption, and change their encryption password.

## Motivation

### Current State

Encryption keys derive from the server's `ENCRYPTION_SECRETS` environment variable. The flow:

```
Server: HKDF(SHA-256(ENCRYPTION_SECRETS), "user:{userId}") → userKey
  → sent to client as userKeyBase64 in session response
Client: HKDF(userKey, "workspace:{workspaceId}") → workspaceKey
  → activateEncryption(workspaceKey) on all stores
```

The server can derive every user's key. For Epicenter Cloud, this is intentional. It enables search, AI, and password recovery. For self-hosted deployments, the user controls the server, so it's functionally zero-knowledge.

```typescript
// apps/api/src/auth/encryption.ts: server always sends the key
export async function deriveUserEncryptionKey(userId: string) {
    const userKey = await deriveUserKey(currentKeySecret, userId);
    return {
        userKeyBase64: bytesToBase64(userKey),
        keyVersion: currentKeyVersion,
    };
}
```

```typescript
// apps/honeycrisp/src/lib/client.ts: client always receives it
onLogin(session) {
    workspace.unlockWithKey(session.userKeyBase64);
}
```

This creates one problem:

1. **No true zero-knowledge option for cloud users.** A user on Epicenter Cloud who wants the server unable to read their data has no path to that today. The only option is self-hosting, which not everyone can do. The articles ("If You Don't Trust the Server, Become the Server") argue this is acceptable, but offering an opt-in ZK mode costs very little given the existing architecture.

### Desired State

Two encryption modes per workspace, switchable at runtime:

```typescript
// Server-managed (default, unchanged):
onLogin(session) {
    workspace.unlockWithKey(session.userKeyBase64);  // server sends key
}

// Self-managed (opt-in):
// Server sends no key. Client prompts for password.
const userKey = await deriveKeyFromPassword(password, salt);
await workspace.encryption.unlock(userKey);
```

The encryption layer itself (`createEncryptedYkvLww`, `activateEncryption`, HKDF derivation) stays identical. Only the key source changes.

## Research Findings

### Existing Infrastructure Readiness

Investigated every component in the encryption stack to determine what already supports this and what doesn't.

| Component | Ready? | Evidence |
|---|---|---|
| `activateEncryption(nextKey)` with previous-key fallback | ✅ | Lines 444-489 of `y-keyvalue-lww-encrypted.ts`: saves `previousKey`, decrypts with fallback, re-encrypts only entries that need it |
| `deriveKeyFromPassword(password, salt)` | ✅ | `crypto/index.ts`: PBKDF2 with 600K iterations, returns 32-byte key |
| `deriveSalt(userId, workspaceId)` | ⚠️ | Exists but has concatenation collision bug (`"user1" + "23ws"` === `"user12" + "3ws"`) |
| `deriveWorkspaceKey(userKey, workspaceId)` | ✅ | HKDF-SHA256 per-workspace isolation, key-source agnostic |
| `unlock(userKey)` API | ✅ | `create-workspace.ts` line 961. Accepts any `Uint8Array`, doesn't care about source |
| `UserKeyStore` caching | ✅ | Interface + IndexedDB implementation, stores base64 key regardless of source |
| Auto-boot from cache | ✅ | `create-workspace.ts` lines 1002-1016. Reads cached key on startup |
| Server keyring parsing | ✅ | `apps/api/src/auth/encryption.ts`: `ENCRYPTION_SECRETS` supports versioned keys |
| Password change / `changeKey` | ❌ | No explicit API. But `activateEncryption` with fallback handles the mechanics |
| Mode flag (self-managed vs server-managed) | ❌ | Doesn't exist anywhere |
| Multi-device password change detection | ❌ | `failedDecryptCount` exists but nothing watches it for re-prompting |

### How Other E2EE Apps Handle This

Research from librarian agents across Notesnook, Standard Notes, Anytype, SecSync, and Matrix.

| Product | Key Source | Password Change | Multi-device |
|---|---|---|---|
| Standard Notes | PBKDF2 from password → per-item keys | Re-encrypt all items with new key | Other devices prompted for new password |
| Notesnook | Client-side, XChaCha20 + Argon2 | Re-derive key, re-encrypt | Sync delivers new ciphertext, old key fails |
| Bitwarden | PBKDF2 from master password → HKDF split for auth/encryption | Server never sees master password; re-encrypt vault on change | All devices re-prompted |

The pattern is consistent: PBKDF2 from password, re-encrypt on change, other devices detect failure and re-prompt.

### Key Transition Mechanics (Already Implemented)

The `activateEncryption` code already handles old-key→new-key transitions:

```
activateEncryption(nextKey):
  1. Save previousKey = currentKey
  2. Set currentKey = nextKey
  3. For each entry in inner.map:
     a. Try decrypt with nextKey → success? Already on current key, skip
     b. Try decrypt with previousKey → success? Mark for re-encryption
     c. Both fail → warn, skip (failedDecryptCount increases)
  4. Re-encrypt marked entries with nextKey (batched in Y.Transaction)
  5. Diff old vs new plaintext map, emit synthetic change events
```

This means calling `unlock(newKey)` while the old key is active already re-encrypts everything. A `changePassword` API is a thin wrapper. Derive new key, call unlock.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where to store mode flag | Server-side (workspace settings table or user preferences) | Server needs to know whether to include `userKeyBase64` in the session response. Client-side only wouldn't sync across devices. |
| One password or two | Two: auth password (email/password for Better Auth) + encryption password (PBKDF2 for workspace key) | Same-password requires SRP or similar protocol change to prevent server from seeing the password. Two passwords is simpler and the auth layer stays untouched. |
| Salt derivation | `HKDF(SHA-256(userId + ":" + workspaceId), 16)`: fix concatenation collision with separator | Deterministic from known values, no storage needed. The separator prevents `("user1", "23ws")` colliding with `("user12", "3ws")`. |
| Password change mechanism | Thin wrapper over existing `unlock()` which calls `activateEncryption` with previous-key fallback | The mechanics already work. No new CRDT primitive needed. |
| Features disabled in self-managed mode | Server-side search, AI summarization, password recovery for encryption key | Server can't read data without the key. Auth password recovery still works (Better Auth handles that). |
| `changePassword` API location | On `WorkspaceEncryption` (exposed via `workspace.encryption.changePassword`) | Consistent with existing `workspace.encryption.unlock` and `workspace.encryption.lock` |
| Multi-device password change detection | Watch `failedDecryptCount` after sync delivers new entries | Already computed as `inner.map.size - map.size`. No new state needed. |
| Mode switching direction | Both directions supported: server→self, self→server | Server→self: client re-encrypts with password-derived key. Self→server: server sends its derived key, client re-encrypts with that. Both use `activateEncryption`. |

## Architecture

### Key Derivation. Two Paths, Same Destination

```
SERVER-MANAGED (default):
  ENCRYPTION_SECRETS + userId
    → HKDF(SHA-256(secret), "user:{userId}")
    → userKey (32 bytes, sent to client in session)
    → HKDF(userKey, "workspace:{workspaceId}")
    → workspaceKey
    → activateEncryption(workspaceKey)

SELF-MANAGED (opt-in):
  User enters encryption password
    → PBKDF2(password, salt, 600K iterations) ~500ms
    → userKey (32 bytes, never leaves client)
    → HKDF(userKey, "workspace:{workspaceId}")    ← same as above
    → workspaceKey                                  ← same as above
    → activateEncryption(workspaceKey)              ← same as above
```

Everything below `userKey` is identical. The entire change is above the `userKey` boundary.

### Password Change Flow

```
1. User is unlocked (old key active, plaintext cached in wrapper.map)
2. User enters old password + new password
3. Client: PBKDF2(oldPassword, salt) → oldUserKey
4. Client: verify bytesEqual(oldUserKey, activeUserKey) → reject if wrong
5. Client: PBKDF2(newPassword, salt) → newUserKey
6. Client: workspace.encryption.unlock(newUserKey)
   └─ activateEncryption(newWorkspaceKey):
      ├─ previousKey = oldWorkspaceKey (saved automatically)
      ├─ Try each entry with newKey → fails (encrypted with old)
      ├─ Fallback to previousKey → succeeds → mark for re-encrypt
      └─ Re-encrypt all entries with newKey (batched transaction)
7. Sync propagates new ciphertext to other devices
8. Client: update UserKeyStore cache with newUserKey
```

### Multi-Device After Password Change

```
Device A: changes password → re-encrypts → syncs new ciphertext
                                              │
Device B: receives new ciphertext via sync ───┘
  → activateEncryption auto-runs on observer? No.
  → Old cached key tries to decrypt new blobs → fails
  → failedDecryptCount > 0
  → UI detects this → shows "Encryption password changed" prompt
  → User enters new password → PBKDF2 → unlock → data readable
```

### Mode Switch Flow

```
SERVER-MANAGED → SELF-MANAGED:
  1. User clicks "Manage my own encryption password"
  2. Server marks workspace as self-managed
  3. Client prompts for new encryption password
  4. Client: PBKDF2(password, salt) → newUserKey
  5. Client: workspace.encryption.unlock(newUserKey)
     └─ activateEncryption re-encrypts with new key
  6. Server stops sending userKeyBase64 for this workspace

SELF-MANAGED → SERVER-MANAGED:
  1. User clicks "Let Epicenter manage encryption"
  2. User enters current encryption password (to verify identity)
  3. Server derives key: HKDF(secret, userId) → serverUserKey
  4. Server sends serverUserKey to client
  5. Client: workspace.encryption.unlock(serverUserKey)
     └─ activateEncryption re-encrypts with server key
  6. Server marks workspace as server-managed
  7. Future sessions include userKeyBase64 automatically
```

## Implementation Plan

### Phase 1: Fix Existing Bugs

Before adding new features, fix the issues found during analysis.

- [ ] **1.1** Fix `deriveSalt` concatenation collision. Add `":"` separator between `userId` and `workspaceId`
- [ ] **1.2** Fix `bytesToBase64` stack bomb. Replace `String.fromCharCode(...bytes)` spread with loop (in `crypto/index.ts`, the shared version. The server version at `apps/api/src/auth/encryption.ts` line 104 already uses a loop)

### Phase 2: Core Encryption Primitives

Add `changePassword` capability to the workspace encryption runtime. No UI, no server changes. Just the primitive.

- [ ] **2.1** Add `changePassword(oldPassword: string, newPassword: string): Promise<void>` to `WorkspaceEncryption` type in `create-workspace.ts`
  - Derive old key, verify against active key
  - Derive new key, call `unlock(newKey)` (which handles re-encryption via `activateEncryption`)
  - Update `UserKeyStore` cache
  - Requires `userId` in scope. Pass via `EncryptionConfig` or closure from `withEncryption`
- [ ] **2.2** Add `unlockWithPassword(password: string): Promise<void>` convenience method alongside `unlockWithKey`
  - Wraps `deriveKeyFromPassword` + `deriveSalt` + `unlock`
  - Requires `userId` in scope
- [ ] **2.3** Export `deriveKeyFromPassword` and `deriveSalt` from the workspace package public API (currently internal to `crypto/index.ts`)
- [ ] **2.4** Write tests: password-based unlock, password change with re-encryption verification, wrong old password rejection

### Phase 3: Server Mode Flag

Make the server aware of encryption mode so it can conditionally send (or not send) the key.

- [ ] **3.1** Add `encryptionMode` field to workspace/user settings (database schema). Values: `'server'` (default) | `'self'`
- [ ] **3.2** Update `customSession()` hook in `create-auth.ts`: skip `deriveUserEncryptionKey` when mode is `'self'`
- [ ] **3.3** Add API endpoint: `POST /workspaces/:id/encryption-mode` to toggle the mode
  - When switching to `'self'`: just flip the flag (client handles re-encryption)
  - When switching to `'server'`: flip the flag and return the server-derived key so the client can re-encrypt
- [ ] **3.4** Update session response types to make `userKeyBase64` and `keyVersion` nullable

### Phase 4: Client Integration

Wire the mode into the client auth flow and workspace initialization.

- [ ] **4.1** Update `onLogin` handler pattern. Check if `session.userKeyBase64` is present
  - If present: `workspace.unlockWithKey(session.userKeyBase64)` (unchanged)
  - If absent: rely on auto-boot from cache, or signal UI to prompt
- [ ] **4.2** Add `workspace.encryption.mode: 'server' | 'self' | 'unknown'` reactive state
  - Derived from session response (key present = server, key absent = self)
  - `'unknown'` before session loads
- [ ] **4.3** Add `workspace.encryption.needsPassword: boolean` reactive state
  - True when: mode is `'self'` AND not unlocked AND no cached key
  - UI components bind to this to show/hide the password prompt
- [ ] **4.4** Add `workspace.encryption.passwordChanged: boolean` reactive state
  - True when: unlocked but `failedDecryptCount > 0` after sync
  - Triggers re-prompt on other devices after password change

### Phase 5: UI Components

Build the Svelte components for password management.

- [ ] **5.1** `EncryptionPasswordGate.svelte`: wraps page content, shows password prompt when `needsPassword` is true
  - Password input, submit button, error state for wrong password
  - Shows ~500ms spinner during PBKDF2 derivation
  - On success: slot content renders (workspace data visible)
- [ ] **5.2** `EncryptionPasswordChanged.svelte`: banner/dialog shown when `passwordChanged` is true
  - "Your encryption password was changed on another device. Enter your new password."
  - Password input, submit on enter
- [ ] **5.3** `ChangeEncryptionPassword.svelte`: settings panel component
  - Old password, new password, confirm new password
  - Calls `workspace.encryption.changePassword(old, new)`
  - Success toast, error handling for wrong old password
- [ ] **5.4** `EncryptionModeSwitch.svelte`: settings panel toggle
  - Switch between "Epicenter manages encryption" and "I manage my own password"
  - Server→self: prompts for new encryption password
  - Self→server: prompts for current password (verification), then switches
  - Warning copy: "Self-managed encryption cannot be recovered if you forget your password"

### Phase 6: Documentation

- [ ] **6.1** Update `apps/api/README.md` encryption section. Document the two modes
- [ ] **6.2** Update or create article explaining the self-managed option and when to use it
- [ ] **6.3** Add JSDoc to new public APIs (`changePassword`, `unlockWithPassword`, `encryptionMode`)

## Edge Cases

### Password change interrupted mid-re-encryption

1. User initiates password change. `activateEncryption` starts re-encrypting entries.
2. App crashes or tab closes during re-encryption.
3. Some entries are encrypted with new key, some with old key.

**Outcome**: On next launch, the cached key is the new key (cache updates after `unlock` succeeds). `activateEncryption` runs with `previousKey` = undefined (no old key in memory). Entries still on old key fail to decrypt and show in `failedDecryptCount`. User can't recover without the old password.

**Mitigation**: `activateEncryption` uses `inner.doc.transact()` for re-encryption writes (line 481), so all CRDT mutations are batched. Yjs transactions are atomic within a single JS event loop tick. XChaCha20 is synchronous, so the entire re-encryption completes in one transaction. The risk of partial re-encryption is extremely low (process kill, not a JS exception).

**Recommendation**: Accept the risk. For belt-and-suspenders, keep the old key in the `UserKeyStore` as a fallback entry until re-encryption is confirmed complete. Defer to Open Questions.

### User forgets encryption password

1. Self-managed mode. User forgets their encryption password.
2. No recovery possible. Server doesn't have the key.

**Outcome**: Data is permanently inaccessible. Auth still works (different password). Workspace can be reset (delete encrypted data, start fresh).

**Mitigation**: Clear warning during self-managed setup. Consider recovery codes (see Open Questions).

### Two devices change password simultaneously

1. Device A changes password to "alpha". Device B changes password to "beta". Both online.
2. Both re-encrypt all entries with their respective new keys.
3. Sync delivers both sets of encrypted entries.

**Outcome**: LWW timestamp resolution picks the latest write per entry. Some entries end up encrypted with "alpha" key, some with "beta" key. Neither device can decrypt all entries.

**Mitigation**: This is a user error (changing password on two devices simultaneously). The `failedDecryptCount` mechanism will surface the problem. The user would need to pick one password and re-enter it on both devices. In practice, password changes are rare and sequential.

**Recommendation**: Accept the risk. Document that password changes should be done on one device at a time.

### Switching modes while other devices are offline

1. Device A switches from server-managed to self-managed. Sets encryption password.
2. Device B is offline. Has server-derived key cached.
3. Device B comes online. Sync delivers entries encrypted with password-derived key.

**Outcome**: Device B's cached server key can't decrypt new entries. `failedDecryptCount > 0`. But Device B doesn't know the encryption password. It was using server-managed mode.

**Mitigation**: The mode flag syncs via the server. When Device B reconnects, its next `getSession()` call returns no `userKeyBase64` (server knows mode changed). The client detects this and shows the password prompt.

### Self-managed mode with no `userId` available

1. `deriveSalt(userId, workspaceId)` requires `userId`.
2. In self-managed mode, the user is authenticated (Better Auth handles auth). `userId` is available from the session.
3. But what about pre-auth state? If the user isn't signed in yet, there's no `userId` for salt derivation.

**Outcome**: Not a problem. Self-managed encryption still requires authentication (Better Auth sign-in). The encryption password is a second layer on top of auth. `userId` is always available when the encryption prompt appears.

## Open Questions

1. **Should we support recovery codes for self-managed mode?**
   - If yes: generate N random words at setup time, user stores them. Recovery code derives the same key as the password (via a different path). Adds complexity.
   - If no: simpler implementation, but "forgot password = data gone" is harsh.
   - **Recommendation**: Defer. Ship without recovery codes. The self-managed audience understands the tradeoff (they opted in). Add recovery codes later if user feedback demands it.

2. **Should the old key be kept as a fallback in `UserKeyStore` during password change?**
   - If yes: cache stores `{ current: base64, previous: base64 }`. Auto-boot tries current, falls back to previous. Protects against interrupted re-encryption.
   - If no: simpler cache, but interrupted re-encryption means data loss.
   - **Recommendation**: Keep it simple. Single key in cache. The re-encryption is transactional (synchronous XChaCha20 in a Yjs transaction). The risk is negligible.

3. **Per-workspace or per-user encryption mode?**
   - Per-workspace: different workspaces can have different modes. More granular. User might forget which workspaces are self-managed.
   - Per-user: all workspaces use the same mode. Simpler mental model.
   - **Recommendation**: Per-user. A user who opts into self-managed encryption wants it everywhere. Simplifies UI and reduces confusion. The mode flag lives on the user record, not workspace settings.

4. **Should self-managed mode use a single password for all workspaces?**
   - Yes (single password): one PBKDF2 derivation → userKey → HKDF per workspace. Same as server-managed but with a different key source. User remembers one password.
   - No (per-workspace passwords): more secure isolation, but absurd UX.
   - **Recommendation**: Single password. HKDF already provides per-workspace isolation from a single userKey. This mirrors the server-managed model exactly.

5. **What happens to server-side search/AI indexes when switching to self-managed?**
   - The server can no longer read data. Existing indexes become stale.
   - Options: (a) delete indexes on switch, (b) keep stale indexes, (c) show warning that search/AI won't work
   - **Recommendation**: Delete indexes on switch to self-managed. Show a clear warning before switching: "Server-side search and AI features will be disabled."

6. **Should `EncryptionConfig` accept `userId` directly, or should it be injected later?**
   - `withEncryption({ userKeyStore, userId })`: requires userId at workspace creation time, which may not be available yet (pre-auth).
   - `withEncryption({ userKeyStore })` with userId injected via `unlockWithPassword(password, userId)`: more flexible but less ergonomic.
   - **Recommendation**: Accept `userId` on the method calls (`unlockWithPassword`, `changePassword`), not in config. The workspace is created before auth completes. userId arrives with the session.

## Success Criteria

- [ ] A workspace can be unlocked with a user-provided password via `unlockWithPassword(password, userId)`
- [ ] Password change re-encrypts all entries and syncs new ciphertext to other devices
- [ ] Other devices detect password change (`failedDecryptCount > 0`) and prompt for new password
- [ ] Server omits `userKeyBase64` from session response when mode is `'self'`
- [ ] Mode can be switched in both directions (server→self, self→server) with re-encryption
- [ ] Auto-boot from cached key works identically in both modes
- [ ] `deriveSalt` concatenation collision is fixed
- [ ] Wrong old password is rejected with a clear error
- [ ] Self-managed setup shows an unrecoverable-password warning
- [ ] All existing tests continue to pass (server-managed mode is unchanged)
- [ ] New tests cover: password-based unlock, password change, wrong password, mode switch

## References

- `packages/workspace/src/shared/crypto/index.ts`: Encryption primitives, `deriveKeyFromPassword`, `deriveSalt`, `deriveWorkspaceKey`
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: Encrypted KV wrapper, `activateEncryption` with previous-key fallback
- `packages/workspace/src/workspace/create-workspace.ts`: `withEncryption()` builder, `unlock`, `lock`, `EncryptionRuntime`
- `packages/workspace/src/workspace/user-key-store.ts`: `UserKeyStore` interface
- `apps/api/src/auth/encryption.ts`: Server-side key derivation, keyring parsing
- `apps/api/src/auth/create-auth.ts`: `customSession()` hook that sends `userKeyBase64`
- `packages/svelte-utils/src/auth/create-auth.svelte.ts`: Client auth with `onLogin`/`onLogout` hooks
- `packages/svelte-utils/src/indexed-db-key-store.ts`: IndexedDB `UserKeyStore` implementation
- `docs/articles/if-you-dont-trust-the-server-become-the-server.md`: Philosophy article on trust model
- `docs/articles/let-the-server-handle-encryption.md`: Philosophy article on server-managed keys
- `docs/articles/why-epicenter-doesnt-encrypt-without-authentication.md`: Why no encryption pre-auth
- `specs/20260328T120000-key-version-propagation.md`: Related DRAFT spec for keyVersion propagation
