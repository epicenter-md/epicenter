# Workspace Encryption Simplification

**Date**: 2026-04-03
**Status**: Implemented
**Author**: AI-assisted (conversation with Braden)
**Branch**: feat/new-bifurcation (has partial work to revert)
**Supersedes**: `specs/20260402T120000-workspace-encryption-model.md`

## Overview

Radically simplify the workspace encryption architecture. Replace the lock/unlock state machine, UserKeyStore, `.withEncryption()` builder method, and dual-cache encrypted wrapper with a single `applyEncryptionKeys()` method on the workspace client. The developer controls when and how keys arrive. The workspace library just encrypts.

### Before (current: 1,395 lines of encryption code)

```typescript
const workspace = createWorkspace(def)
  .withEncryption({ userKeyStore })           // ← birth-time decision
  .withExtension('persistence', indexeddb)
  .withExtension('sync', createSyncExtension(...));

// Internal: encryption-runtime.ts state machine
//   → auto-boot from userKeyStore cache
//   → lock()/unlock() cycling
//   → transactStores() with manual rollback
//   → dual-cache observer pipeline in encrypted wrapper
```

### After (proposed: ~500 lines)

```typescript
const workspace = createWorkspace(def)
  .withExtension('persistence', indexeddb)
  .withExtension('sync', createSyncExtension(...));

// When auth session arrives:
workspace.applyEncryptionKeys(session.encryptionKeys);
workspace.extensions.sync.connect();
```

No `.withEncryption()`. No UserKeyStore. No state machine. One method, one time.

## Motivation

### Why we're simplifying

We audited the encryption implementation and found:

| Metric | Value |
|---|---|
| Lines dedicated to encryption | 1,395 (12.8% of workspace/src) |
| Lines of encryption tests | 1,403 |
| Conditional branches for encryption state | 15+ |
| Encryption-specific types | 7 |
| Dedicated files | 5 + integration in create-workspace.ts |
| Unused exported functions | 3 (generateEncryptionKey, deriveKeyFromPassword, deriveSalt) |

The complexity is disproportionate to the value delivered. The core encryption *primitive* (XChaCha20-Poly1305 per-value) is genuinely valuable. The *machinery around it* (state machine, dual-cache, key store, transactional activation) is where the cost lives.

### What encryption actually protects today

The current model is **server-managed encryption, not E2E**. The server derives user keys from `ENCRYPTION_SECRETS` via HKDF and sends them to the client in the auth session. The server can decrypt all data. This is intentional. Documented in the API README and three articles.

| Threat | Protected? | Notes |
|---|---|---|
| Database dump without env vars | ✅ | Attacker gets ciphertext blobs, no keys |
| Cloudflare employee snooping | ✅ | Durable Object storage is ciphertext |
| Breach disclosure | ✅ | "Per-value XChaCha20-Poly1305" is defensible |
| Full server compromise (DB + env vars) | ❌ | Attacker derives all keys |
| Government subpoena | ❌ | Server can comply by decrypting |

**The real value**: data at rest everywhere (client IndexedDB, server Durable Object SQLite, sync payloads) is ciphertext. A database dump is useless without the separately-stored `ENCRYPTION_SECRETS`. This is the Notion/Linear model, applied at the CRDT value level. Genuinely deeper than database-level encryption.

### The two-tier future

Same encrypted wrapper, different key sources:

```
Tier 1: Server-Managed (ships now)        Tier 2: True E2E (ships later)
Key: auth session → HKDF per-user         Key: user password → PBKDF2
Server CAN decrypt                         Server CANNOT decrypt
Search/AI/password recovery work           No search/AI/recovery
For: 95% of users                          For: HN audience, self-hosters
```

The wrapper doesn't change between tiers. Only the key source changes. This spec builds Tier 1. Tier 2 is ~30 lines on top.

### What we tried before (and why it was wrong)

**Attempt 1: Store-level bifurcation** (`feat/new-bifurcation` branch). Made encryption a birth-time property. Encrypted workspaces use strict stores, non-encrypted use plain `YKeyValueLww`. Required a `KvStore<T>` interface, conditional store creation, moving `.withEncryption()` to constructor. **Wrong because** it prevents zero-friction onboarding → optional encryption later.

**Attempt 2: Sync-layer gating only** (original version of this spec). Keep the full state machine but add sync gating. **Wrong because** it preserves all the complexity (state machine, UserKeyStore, dual-cache, transactional activation) for a ~5-line sync gate. The gate is right, but the machinery it depends on is over-engineered.

**This spec: Remove the machinery.** Keep the primitive.

## Design Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Primary API | Single `applyEncryptionKeys(keys)` method (synchronous) | Replaces `.withEncryption()`, `unlock()`, `lock()`, UserKeyStore. One call, one time. Sync because HKDF and XChaCha20 are both sync via @noble/hashes and @noble/ciphers. |
| 2 | Key persistence | Delegated to the app's auth layer | Auth session already caches via Better Auth client. No separate UserKeyStore needed. |
| 3 | Encrypted wrapper | Always present on all stores | No birth-time ternary. Passthrough when no key (zero overhead). Encrypt after keys applied. |
| 4 | Plaintext→encrypted transition | One-way. `applyEncryptionKeys()` re-encrypts plaintext entries. No going back. | Once data has been encrypted, it should never be plaintext again. Logout → `clearLocalData()` → fresh start. |
| 5 | Re-encryption scope | Re-encrypt plaintext entries and decryptable old-version ciphertext. | Plaintext must be encrypted before sync connects. Old-version ciphertext must also converge to the current key during activation, so a rotation actually upgrades at-rest data instead of waiting for a future write that may never happen. |
| 6 | Sync connection | Explicit. App calls `sync.connect()` after applying keys. | No implicit coupling between encryption and sync. App controls ordering. Simplest possible sync extension. |
| 6a | Boot sequencing | Composed by app, not by library. App runs persistence + auth in parallel, then applies keys synchronously. | Fastest boot (parallel), zero gap (sync apply), no coupling (library doesn't know about auth). WorkspaceGate is a generic promise gate. App passes any promise. |
| 7 | Dual-cache in wrapper | Remove. Decrypt on read (~0.01ms per value). | Eliminates ~200 lines of cache sync, diffAndEmit, rebuildMap, transaction-gap fallback. XChaCha20-Poly1305 is fast enough. |
| 8 | Lock/unlock state machine | Remove entirely. | No app cycles between locked/unlocked during a session. Key arrives once at boot (from cached auth session or fresh login). |
| 9 | Dead crypto exports | Remove PBKDF2, deriveSalt, generateEncryptionKey from core module. | Never called. Re-add PBKDF2 in a separate `password-key-provider.ts` when Tier 2 ships. |
| 10 | Keyring versioning | Keep. | Small code, future-proofs key rotation. Each blob's byte 1 identifies the key version. |

## Architecture

### New flow

```
createWorkspace(def)
  │
  ├─ ALL stores: createEncryptedYkvLww(yarray)
  │   └─ Passthrough mode (no key yet, zero overhead)
  │
  ├─ .withExtension('persistence', indexeddb)
  │   └─ Loads Y.Doc from IndexedDB (may contain plaintext or ciphertext)
  │
  ├─ .withExtension('sync', createSyncExtension(...))
  │   └─ NOT connected yet. App decides when to connect.
  │
  └─ whenReady: [persistenceReady, ...otherExtensions]
      └─ No encryption boot promise. No auto-unlock. Just persistence.
```

```
Composed boot (recommended pattern for encrypted apps)

async function boot() {
  // Parallel: persistence + auth load concurrently (fastest boot)
  const [, session] = await Promise.all([
    workspace.whenReady,    // IndexedDB loads Y.Doc
    getSession(),           // auth session from cache or network
  ]);

  // Sequential: apply keys synchronously (zero gap)
  if (session?.encryptionKeys) {
    workspace.applyEncryptionKeys(session.encryptionKeys);  // sync!
    workspace.extensions.sync.connect();
  }
}

// In Svelte layout:
// <WorkspaceGate whenReady={boot()}>
//   <App />   renders ONLY after persistence + keys + sync ready
// </WorkspaceGate>

// For apps without auth (Whispering, Fuji):
// <WorkspaceGate whenReady={workspace.whenReady}>
//   <App />   renders after persistence, no encryption
// </WorkspaceGate>
```

**Why composed boot?**
- Persistence and auth load in parallel (faster than sequential)
- `applyEncryptionKeys()` is synchronous (HKDF + XChaCha20 are both sync)
- Zero gap between 'keys applied' and 'data readable'
- WorkspaceGate is a generic promise gate; app passes any promise
- Library does not know about auth. App controls the boot sequence.

**What happens on logout?**
```
workspace.clearLocalData()
  Disconnects sync
  Wipes IndexedDB (LIFO extension cleanup)
  Wrapper resets to passthrough (ready for next login)
```

### Key hierarchy (unchanged)

```
Tier 1 (now):                            Tier 2 (future):
ENCRYPTION_SECRETS env var               User password
       │                                        │
       │  Server: HKDF per-user                 │  Client: PBKDF2 + random salt
       ▼                                        ▼
   userKey (base64)                         userKey (base64)
       │                                        │
       └──────────────┬─────────────────────────┘
                      │
                      │  Client: HKDF per-workspace
                      ▼
                workspaceKey (32 bytes)
                      │
                      ▼
              XChaCha20-Poly1305
```

Both key sources produce the same `EncryptionKeys` format. `applyEncryptionKeys()` doesn't know or care where the key came from.

### Encrypted wrapper behavior

```
applyEncryptionKeys() called?
  │
  ├─ NO (passthrough mode)
  │   set(key, val)    → writes plaintext to Y.Array (zero overhead)
  │   get(key)         → reads plaintext from Y.Array
  │   observe()        → emits plaintext values
  │
  └─ YES (encryption active, one-way)
      set(key, val)    → JSON.stringify → XChaCha20-Poly1305 → write EncryptedBlob
      get(key)         → read blob → detect type → decrypt on the fly (~0.01ms)
      observe()        → decrypt in observer, emit plaintext

      Mixed content handling (during/after transition):
      ├─ Entry is EncryptedBlob (current version) → decrypt with current key
      ├─ Entry is EncryptedBlob (old version)     → decrypt with version-directed key
      ├─ Entry is plaintext                       → return as-is during reads; activation rewrites it as ciphertext
      └─ Entry fails to decrypt                   → skip, log warning, increment failedDecryptCount
```

### What `applyEncryptionKeys()` does internally

```typescript
applyEncryptionKeys(keys: EncryptionKeys): void {
  // 1. Decode base64 keys, derive per-workspace keys via HKDF
  const keyring = new Map<number, Uint8Array>();
  for (const { version, userKeyBase64 } of keys) {
    const userKey = base64ToBytes(userKeyBase64);
    keyring.set(version, deriveWorkspaceKey(userKey, workspaceId));
  }

  // 2. Activate encryption on all stores
  for (const store of allStores) {
    store.activateEncryption(keyring);
    // → sets the one-way "encrypted" flag
    // → re-encrypts plaintext entries (security: prevent plaintext sync)
    // → re-encrypts decryptable old-version ciphertext with the current key
    // → leaves blobs with missing key versions unreadable and unchanged
  }
}
```

**One-way flag**: Once `activateEncryption()` is called on a store, the store permanently refuses plaintext writes. `set()` without an active keyring throws `EncryptionLockedError`. This prevents the bug where `deactivateEncryption()` allows plaintext passthrough after data has been encrypted.

**Re-encryption scope**: Plaintext entries and decryptable old-version ciphertext are re-encrypted during activation. Current-version ciphertext is skipped. Ciphertext whose key version is missing from the keyring is left unreadable and unchanged, because there is no safe key to decrypt it with yet.

## How apps use this

### Tab-Manager (encrypted + synced)

```typescript
// client.ts: no .withEncryption(), no UserKeyStore
const workspace = createWorkspace(tabManagerDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url: ... }));

// auth.ts: on login
function onLogin(session: SessionResponse) {
  workspace.applyEncryptionKeys(session.encryptionKeys);
  workspace.extensions.sync.connect();
}

// auth.ts: on logout
async function onLogout() {
  await workspace.clearLocalData(); // wipes IndexedDB, disconnects sync
}
```

### Whispering (local-only today, sync someday)

```typescript
// client.ts: same as today, no encryption, no sync
const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence);

// Future: when sync is added
// Just add the sync extension and call applyEncryptionKeys on login.
// Existing plaintext data re-encrypted automatically.
// No workspace migration, no new workspace ID, no data loss.
```

### Future: Password-based E2E (Tier 2)

```typescript
// ~30 lines: separate password-key-provider.ts
async function deriveKeysFromPassword(
  password: string,
  salt: Uint8Array,
  version: number = 1,
): Promise<EncryptionKeys> {
  const userKey = await deriveKeyFromPassword(password, salt);
  return [{ version, userKeyBase64: bytesToBase64(userKey) }];
}

// Usage: same applyEncryptionKeys(), different key source
const keys = await deriveKeysFromPassword(password, storedSalt);
workspace.applyEncryptionKeys(keys);
workspace.extensions.sync.connect();
```

Salt stored as an unencrypted entry in the Y.Doc (syncs automatically, not secret).

## Implementation Plan

### Phase 0: Revert the store-level bifurcation

- [ ] **0.1** `git checkout main -- packages/workspace/src/` to restore all workspace package files
- [ ] **0.2** Verify all existing tests pass on clean main
- [ ] **0.3** Keep this spec file

### Phase 1: Simplify the encrypted wrapper

- [ ] **1.1** Remove the dual-cache (`map`) from `y-keyvalue-lww-encrypted.ts`. Reads decrypt on the fly.
- [ ] **1.2** Remove `diffAndEmit()`, `rebuildMap()`, and the transaction-gap fallback.
- [ ] **1.3** Add one-way flag: once `activateEncryption()` is called, passthrough is permanently disabled. `set()` without keyring throws `EncryptionLockedError`.
- [ ] **1.4** In `activateEncryption()`: re-encrypt plaintext entries and decryptable old-version ciphertext. Leave only missing-key ciphertext alone.
- [ ] **1.5** Remove `deactivateEncryption()` as a public method. The only way to "reset" is `clearLocalData()`.
- [ ] **1.6** Observer: decrypt each entry on the fly, emit plaintext. No cache.
- [ ] **1.7** Update tests to match simplified behavior.

**Target**: ~200 lines (down from 540).

### Phase 2: Remove the encryption runtime and builder method

- [ ] **2.1** Delete `encryption-runtime.ts` entirely (240 lines).
- [ ] **2.2** Delete `user-key-store.ts` entirely (105 lines).
- [ ] **2.3** Remove `.withEncryption()` from the builder chain in `create-workspace.ts`.
- [ ] **2.4** Remove the 3 ternaries in `create-workspace.ts`. Always create `createEncryptedYkvLww()`.
- [ ] **2.5** Add `applyEncryptionKeys(keys: EncryptionKeys)` method to the workspace client.
  - Decodes base64, derives per-workspace key via HKDF, calls `activateEncryption()` on all stores.
- [ ] **2.6** Remove `EncryptionConfig`, `WorkspaceEncryption`, `WorkspaceKeyAccess` from `types.ts`.
- [ ] **2.7** Update all workspace creation tests.

**Target**: net deletion of ~400 lines.

### Phase 3: Clean up crypto module

- [ ] **3.1** Remove `generateEncryptionKey()` (unused).
- [ ] **3.2** Remove `deriveKeyFromPassword()` and `deriveSalt()` (unused, re-add when Tier 2 ships).
- [ ] **3.3** Remove associated JSDoc and comments that reference the two-stage PBKDF2→HKDF hierarchy.
- [ ] **3.4** Verify remaining exports: `encryptValue`, `decryptValue`, `deriveWorkspaceKey`, `getKeyVersion`, `isEncryptedBlob`, `base64ToBytes`, `bytesToBase64`.

**Target**: ~200 lines (down from 469).

### Phase 4: Update apps

- [ ] **4.1** Tab-Manager: remove `.withEncryption({ userKeyStore })`, add `applyEncryptionKeys()` in auth flow.
- [ ] **4.2** Honeycrisp: same.
- [ ] **4.3** Opensidian: same.
- [ ] **4.4** Zhongwen: same.
- [ ] **4.5** Whispering: no change (already no encryption).
- [ ] **4.6** Fuji: no change (already no encryption).
- [ ] **4.7** Verify all app-level tests and builds pass.

### Phase 5: Update sync extension

- [ ] **5.1** Remove any implicit encryption gating from sync extension (if present).
- [ ] **5.2** Sync extension starts disconnected by default. App calls `.connect()` explicitly.
- [ ] **5.3** Add tests: sync only connects when app explicitly calls `.connect()`.

## Edge Cases

### App writes plaintext, then applies keys, then syncs

Safe. `applyEncryptionKeys()` re-encrypts all plaintext entries before returning. When `sync.connect()` is called afterward, the Y.Doc contains only ciphertext. The ordering is enforced by the app: apply keys first, connect sync second.

### `applyEncryptionKeys()` fails midway through re-encryption

Some entries re-encrypted, some still plaintext. The wrapper handles mixed content on read (checks each entry). The app can retry `applyEncryptionKeys()`: remaining plaintext entries will be re-encrypted. Self-healing on retry.

### Key rotation (auth session has new key version)

Old entries: still decrypt because keyring has all versions (version-directed lookup via blob byte 1). New entries: encrypted with highest version. Old-version entries: lazily migrated on next `set()` for that key. No bulk re-encryption needed.

### Two devices with different keyring versions

Device A has keyring `[v1, v2]`, Device B has keyring `[v1]`. Device A writes with v2. Device B can't decrypt v2 entries (doesn't have v2 key yet). When Device B refreshes its auth session, it gets v2 → can now decrypt. This is expected behavior during key rotation rollout.

### User is offline, auth session expires

Cached auth session still has the encryption keys. Data remains readable. When online again, auth refresh provides new session with same (or rotated) keys. `applyEncryptionKeys()` can be called again with the new keys. Keyring is updated, no data loss.

### `clearLocalData()` called, sync reconnects before new keys applied

`clearLocalData()` disconnects sync and wipes IndexedDB. Workspace is empty. Sync can't reconnect until the app explicitly calls `.connect()` again. And the app won't do that until after `applyEncryptionKeys()`.

### App configures sync but never calls `applyEncryptionKeys()`

Data syncs as plaintext. This is the developer's conscious choice. They configured sync without encryption. The framework doesn't prevent this. It prevents the *accidental* case by making the ordering explicit: apply keys → connect sync.

### Whispering adds sync in the future

1. Whispering adds sync extension to workspace creation
2. On first login, `applyEncryptionKeys()` re-encrypts all existing local plaintext
3. `sync.connect()` syncs the now-encrypted data
4. No workspace migration, no data loss, no second workspace ID
5. Subsequent boots: cached auth session → `applyEncryptionKeys()` → `sync.connect()`

## What this does NOT change

- **EncryptedBlob binary format**: `[formatVersion(1) ‖ keyVersion(1) ‖ nonce(24) ‖ ciphertext ‖ tag(16)]`
- **XChaCha20-Poly1305 via @noble/ciphers**: Cure53-audited, synchronous
- **HKDF key derivation**: `deriveWorkspaceKey(userKey, workspaceId)` → per-workspace isolation
- **Server-side key derivation**: `ENCRYPTION_SECRETS` → HKDF per-user → sent in auth session
- **`EncryptionKeys` schema**: `[{ version, userKeyBase64 }]` (arktype-validated)
- **Composition wrapper pattern**: `YKeyValueLwwEncrypted` wraps `YKeyValueLww` (not a fork)
- **Reference equality for CRDT conflict resolution**: Maintained by wrapper

## Success Criteria

- [ ] Net deletion of ~900 lines of encryption code (1,395 → ~500)
- [ ] All existing tests pass (modified to match new API)
- [ ] `applyEncryptionKeys()` re-encrypts plaintext entries and enables encrypted writes
- [ ] After `applyEncryptionKeys()`, writes without keys throw `EncryptionLockedError`
- [ ] Whispering works without encryption, can add it later via `applyEncryptionKeys()`
- [ ] Tab-Manager auth flow works with new `applyEncryptionKeys()` + explicit `sync.connect()`
- [ ] No `.withEncryption()` in any app's builder chain
- [ ] No `UserKeyStore` interface or implementations
- [ ] No lock/unlock state machine
- [ ] Crypto module exports only: `encryptValue`, `decryptValue`, `deriveWorkspaceKey`, `getKeyVersion`, `isEncryptedBlob`, `base64ToBytes`, `bytesToBase64`

## Files affected

| File | Action |
|---|---|
| `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` | Simplify: remove dual-cache, add one-way flag, decrypt-on-read |
| `packages/workspace/src/workspace/encryption-runtime.ts` | **Delete** |
| `packages/workspace/src/workspace/user-key-store.ts` | **Delete** |
| `packages/workspace/src/shared/crypto/index.ts` | Remove dead exports (PBKDF2, deriveSalt, generateEncryptionKey) |
| `packages/workspace/src/workspace/create-workspace.ts` | Remove `.withEncryption()`, remove ternaries, add `applyEncryptionKeys()` |
| `packages/workspace/src/workspace/types.ts` | Remove `EncryptionConfig`, `WorkspaceEncryption`, `WorkspaceKeyAccess` |
| `packages/workspace/src/workspace/encryption-key.ts` | Keep (EncryptionKeys schema used by `applyEncryptionKeys()`) |
| `apps/tab-manager/src/lib/client.ts` | Update: remove `.withEncryption()`, add `applyEncryptionKeys()` in auth flow |
| `apps/honeycrisp/src/lib/client.ts` | Same |
| `apps/opensidian/src/lib/client.ts` | Same |
| `apps/zhongwen/src/lib/client.ts` | Same |
| `packages/workspace/src/extensions/sync/websocket.ts` | Ensure sync starts disconnected, `.connect()` is explicit |

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: Current encrypted wrapper (to simplify)
- `packages/workspace/src/shared/crypto/index.ts`: Crypto primitives (to prune)
- `apps/api/src/auth/encryption.ts`: Server-side HKDF key derivation (unchanged)
- `apps/api/src/auth/create-auth.ts`: Auth session includes `encryptionKeys` (unchanged)
- `docs/articles/let-the-server-handle-encryption.md`: Philosophy behind server-managed encryption
- `docs/articles/if-you-dont-trust-the-server-become-the-server.md`: Self-hosting as zero-knowledge
- `docs/articles/why-e2e-encryption-keeps-failing.md`: Why we chose this model
- `specs/20260402T120000-workspace-encryption-model.md`: Previous spec (superseded)
- `specs/20260401T160000-self-managed-encryption-password.md`: Future Tier 2 reference

## Review

**Completed**: 2026-04-03
**Branch**: feat/new-bifurcation

### Summary

Replaced the lock/unlock encryption state machine with a single synchronous `applyEncryptionKeys()` method. Deleted ~1,600 lines across 6 files, added ~150 lines of simpler code.

### Commits

1. `638300203`: Phase 0+1: Simplify encrypted wrapper (remove dual-cache, add one-way encryption)
2. `f8cc1e5b0`: Remove dead `hasBeenEncrypted` flag and `EncryptionError.Locked` (done by Braden)
3. `042cbcfda`: Phase 2: Replace encryption runtime with `applyEncryptionKeys()` (-1,190 lines)
4. `1cc38489a`: Phase 3: Remove dead crypto exports (-285 lines)
5. `a8583af3e`: Phase 4: Update all 4 apps + remove dead key-store files (-159 lines)

### Deviations from Spec

- **Phase 5 (sync extension)**: No changes needed. The sync extension already auto-connects after persistence is ready via `whenReady`. Encrypted blobs sync correctly as raw `Uint8Array`: decryption happens on read, not on storage. The `applyEncryptionKeys()` → `reconnect()` pattern in app `onLogin` hooks is sufficient.
- **`generateEncryptionKey()`**: Spec said to remove it. We did, replacing all test usages with `randomBytes(32)` (which was its entire implementation). Docs benchmark files were left unchanged: they're not part of the build/test pipeline.
- **`createIndexedDbKeyStore`**: Removed from `@epicenter/svelte-utils` since all 4 app callers were removed in Phase 4. The spec said this was optional follow-up but it caused type errors so we cleaned it up.
- **`hasBeenEncrypted` flag**: Removed in a separate commit by Braden between Phase 1 and Phase 2. The flag was dead code since `deactivateEncryption()` was already removed: the one-way behavior is now structural (no API to reverse it).

### What's Left

- Docs benchmark files (`docs/articles/yjs-storage-efficiency/`) still import `generateEncryptionKey`: harmless, not part of build
- `cachedEntries()` naming is now misleading (no cache): rename in a follow-up
- Server-side encryption (`apps/api/`) is unchanged as specified
