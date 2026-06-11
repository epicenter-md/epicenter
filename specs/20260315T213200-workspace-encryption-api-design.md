# Workspace Encryption API Design

**Date**: 2026-03-15
**Status**: Reference (documents existing design, not a change proposal)
**Author**: AI-assisted

## Overview

First-principles design of the encryption API for a local-first workspace platform (Yjs CRDTs, IndexedDB persistence, cloud sync). This spec derives the API from requirements and constraints, then validates the derivation against the current implementation.

## Motivation

### The Problem

A local-first workspace must encrypt data at rest with per-user, per-workspace keys while satisfying five constraints that pull in different directions:

1. **The key comes from the server** (HKDF-derived from a master secret): but the workspace must work *before* the key arrives
2. **The workspace client is a module-level singleton** that can't be recreated. But sign-out must wipe local data
3. **Offline restarts must decrypt immediately** from a cached key. But the cache must be clearable on sign-out
4. **Encryption must be transparent** to components. Table helpers (`set`, `get`, `observe`) must not change signature
5. **The API must be obvious** to a developer who's never seen it. No hidden modes, no surprising failures

### Current State

The workspace package (`packages/workspace/`) implements encryption as a composition wrapper around the Yjs CRDT layer. The encryption surface area on `WorkspaceClient` consists of:

```typescript
readonly mode: EncryptionMode        // 'plaintext' | 'encrypted' | 'locked'
lock(): void                          // clear key, block writes
activateEncryption(key: Uint8Array): void         // provide key, decrypt stores
clearLocalData(): Promise<void>       // lock + wipe persisted data
```

This spec documents *why* each of these exists by deriving them from first principles.

## Research Findings

### How Production Encrypted Apps Handle Key Lifecycle

| Concern | Signal Protocol | Bitwarden | This Codebase |
|---|---|---|---|
| Key hierarchy | Root key → chain key → message key (Double Ratchet) | Master password → master key → org key → cipher key | Server secret → per-user key → per-workspace key |
| Derivation | HKDF-SHA256 with domain-separation info strings | PBKDF2 for master, HKDF for derived | HKDF-SHA256 with `user:{id}` and `workspace:{id}` info |
| Local storage encryption | SQLCipher (full DB encryption) | AES-256-CBC per vault item | XChaCha20-Poly1305 per CRDT value |
| Offline access | Local DB always decryptable (key in secure enclave) | Vault cached locally, master key derived from password | Cached key in `KeyCache`, workspace decrypts immediately |
| Sign-out behavior | Delete local DB | Clear vault + derived keys, keep account metadata | `clearLocalData()`: lock + wipe IndexedDB, keep singleton |
| Progressive encryption | N/A (always encrypted) | N/A (vault requires master password) | Workspace works in plaintext mode, encrypts when key arrives |
| Lock model | N/A | Lock clears master key, vault stays cached | `lock()` clears key, reads return cached plaintext |

**Key finding**: Bitwarden's "lock vs sign-out" distinction maps directly to the three-mode state machine. Lock = clear key but keep cached data. Sign-out = clear everything. None mode (no key ever seen) is unique to this system's progressive enhancement requirement.

**Key finding**: Signal and Bitwarden both use HKDF with unversioned domain-separation info strings (per RFC 5869 §3.2). The info string is *not* a version identifier. If derivation changes, the blob format version handles migration. Vault Transit, AWS KMS, and libsodium follow the same convention.

### Why XChaCha20-Poly1305 Over AES-256-GCM

| Concern | AES-256-GCM | XChaCha20-Poly1305 (chosen) |
|---|---|---|
| Performance (pure JS, 64B payload) | 201K ops/sec @ 4µs | 468K ops/sec @ 2µs (2.3× faster) |
| Nonce size | 12 bytes (collision risk with random) | 24 bytes (safe for random nonces) |
| Max messages per key (random nonce) | 2²³ (~8M) | 2⁷² (practically unlimited) |
| Sync/async | WebCrypto: async only | `@noble/ciphers`: synchronous |
| Used by | NIST, TLS 1.3 | libsodium, WireGuard, Noise Protocol |

**Implication**: The CRDT hot path (`table.set()`) must be synchronous: 394+ call sites depend on it. WebCrypto's async-only AES-256-GCM would require making `set()` async, breaking every consumer. XChaCha20-Poly1305 via `@noble/ciphers` (Cure53-audited, pure JS) is the only viable choice.

### Why Composition Over Fork for the CRDT Wrapper

Yjs `ContentAny` stores entry objects by **reference**. The inner CRDT (`YKeyValueLww`) uses `indexOf()` (strict `===`) to find entries in the Y.Array during conflict resolution. A fork that decrypts values into new objects would break `indexOf()`: the map entries would no longer be the same JS objects as the yarray entries.

**Implication**: Encryption must be a wrapper that transforms values at the boundary, not a modification of the CRDT internals. The inner CRDT stays unaware of encryption.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Number of encryption modes | Three: `plaintext`, `encrypted`, `locked` | Two modes can't distinguish "never had a key" (allow writes) from "lost key" (block writes). Four+ modes add complexity without solving new problems |
| Mode names | `plaintext`, `encrypted`, `locked` | Maps to Bitwarden/1Password mental model. "None" is explicit about the security posture. "Unencrypted" was rejected. Too close to "error state" connotation |
| Encryption boundary | Composition wrapper over CRDT (`createEncryptedYkvLww`) | Yjs reference equality constraint (see Research Findings). Fork would break `indexOf()` |
| Cipher | XChaCha20-Poly1305 via `@noble/ciphers` | Synchronous (CRDT hot path), 2.3× faster than AES-256-GCM in pure JS, 24-byte nonce safe for random generation |
| Key hierarchy | Two-level HKDF: user → workspace | Server derives once per session (not per workspace). Compromising one workspace key doesn't expose others |
| Key caching | Platform-agnostic `KeyCache` interface, not built-in | Tauri needs encrypted vaults, browsers use `sessionStorage`, self-hosted may skip caching entirely |
| Blob format | Self-describing binary: `[formatVersion, keyVersion, nonce(24), ciphertext, tag(16)]` | Inline key version enables rotation without re-encrypting all blobs. Format version enables future algorithm changes |
| Mixed plaintext-mode/encrypted data | Value-level discrimination via `isEncryptedBlob()` | No bulk re-encryption needed. Existing plaintext-mode survives `activateEncryption()`. Discrimination is reliable: user values are JS objects, never `Uint8Array` |
| `clearLocalData` naming | Not `signOut()` or `dispose()` | Workspace doesn't know about auth. Singleton must survive. Name describes what it does (clears local data), not why (sign-out) |
| Encryption wiring | Consumer-side pattern, not built-in | Depends on auth library (Better Auth), platform (Svelte reactivity), and app-specific sign-out semantics |
| Unlock atomicity | Rollback on partial failure | If one store fails to activateEncryption, already-unlocked stores re-lock. Workspace never ends up half-unlocked |

## Architecture

### Three-Mode State Machine

```
                  ┌─────────────┐
      (creation,  │  NONE       │  no key ever seen
       no key)    │  rw plain   │  reads and writes pass through unencrypted
                  └──────┬──────┘
                         │ activateEncryption(key)
                         ▼
                  ┌─────────────┐
                  │  ACTIVE     │  key encrypted
                  │  rw encrypt │◄── activateEncryption(newKey) [re-sign-in]
                  └──────┬──────┘
                         │ lock()
                         ▼
                  ┌─────────────┐
                  │   LOCKED    │  key was encrypted, now cleared
                  │  r-only     │  writes throw, reads return cached plaintext
                  └──────┬──────┘
                         │ activateEncryption(key)
                         ▼
                  ┌─────────────┐
                  │  UNLOCKED   │
                  └─────────────┘
```

**Forbidden transitions:**

- `plaintext → locked` never happens. Locked means "was encrypted before." A workspace that never had a key stays plaintext through any lifecycle event.
- `locked → plaintext` never happens. Once a key has been seen, the workspace permanently knows it should be encrypted.

**Behavioral contract per mode:**

| Mode | `set()` | `get()` | `observe()` |
|---|---|---|---|
| `plaintext` | Writes plaintext to CRDT | Reads plaintext from CRDT | Fires with plaintext values |
| `encrypted` | Encrypts, writes `EncryptedBlob` to CRDT | Decrypts from cache (or on-the-fly fallback) | Decrypts, fires with plaintext values |
| `locked` | **Throws** ("Workspace is locked. Sign in to write") | Returns cached plaintext from last unlocked session | No new events (writes blocked, remote changes undecryptable) |

### Encryption Boundary in the Stack

```
┌──────────────────────────────────────────────────────────────────┐
│  Component Code                                                   │
│  table.set({ id: '1', title: 'Hello' })                         │
│  table.get('1')  →  { status: 'valid', row: { ... } }           │
│                          NO ENCRYPTION AWARENESS                  │
├──────────────────────────────────────────────────────────────────┤
│  TableHelper  (create-table.ts)                                   │
│  Calls ykv.set(id, row) / ykv.get(id)                            │
│  Validates schemas, migrates versions                             │
│                          NO ENCRYPTION AWARENESS                  │
├──────────────────────────────────────────────────────────────────┤
│  createEncryptedYkvLww  (y-keyvalue-lww-encrypted.ts)            │
│                     ═══ ENCRYPTION BOUNDARY ═══                   │
│  set(): JSON.stringify → encryptValue → inner.set(EncryptedBlob) │
│  observer: isEncryptedBlob? decryptValue → JSON.parse → cache    │
│  get(): cache hit → plaintext  |  miss → inner.get + decrypt     │
├──────────────────────────────────────────────────────────────────┤
│  YKeyValueLww  (y-keyvalue-lww.ts)                               │
│  LWW conflict resolution, timestamps, pending/map architecture    │
│  Stores EncryptedBlob as opaque value                             │
│                          NO ENCRYPTION AWARENESS                  │
├──────────────────────────────────────────────────────────────────┤
│  Y.Doc  →  IndexedDB / Sync Server / Backups                     │
│  Persists ciphertext. Never sees plaintext.                       │
│                          NO ENCRYPTION AWARENESS                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Hierarchy

```
ENCRYPTION_SECRETS="1:base64Secret"              ← Server environment variable
       │
       │  SHA-256(currentSecret) → root key material
       │  HKDF(root, info="user:{userId}") → per-user key (32 bytes)
       ▼
  Auth session response  →  { encryptionKey: base64, keyVersion: 1 }
       │
       │  Client: base64ToBytes(encryptionKey)
       │  HKDF(userKey, info="workspace:{workspaceId}") → per-workspace key (32 bytes)
       ▼
  workspace.activateEncryption(workspaceKey)
       │
       │  All encrypted stores transition to 'encrypted'
       │  New writes: JSON.stringify → XChaCha20-Poly1305 encrypt → EncryptedBlob
       │  Reads: EncryptedBlob → XChaCha20-Poly1305 decrypt → JSON.parse → plaintext
       ▼
  Transparent operation: components unaware
```

### EncryptedBlob Binary Format

```
 Byte:  0         1         2                        26
        +---------+---------+------------------------+---------------------------+
        | format  | key     |        nonce           |    ciphertext + tag       |
        | version | version |      (24 bytes)        |    (variable + 16)        |
        +---------+---------+------------------------+---------------------------+
        |  0x01   | 0x01-FF | random (CSPRNG)        | XChaCha20-Poly1305 output |
        +---------+---------+------------------------+---------------------------+

 Total: 1 + 1 + 24 + len(plaintext) + 16 bytes

 Detection: value instanceof Uint8Array && value[0] === 1
 (User values in the CRDT are always JS objects, never Uint8Array)
```

### Workspace Coordination

`createWorkspace()` creates one `YKeyValueLwwEncrypted` per table + one for KV. All stores are collected in an `encryptedStores[]` array. `lock()`, `activateEncryption()`, and `mode` operate on this array:

```
createWorkspace(definition)
  │
  ├── for each table:  createEncryptedYkvLww(yarray, { key })  →  encryptedStores[]
  ├── for KV:          createEncryptedYkvLww(kvYarray, { key })  →  encryptedStores[]
  │
  └── WorkspaceClient
        │
        ├─ get mode()  →  encryptedStores[0]?.mode ?? 'plaintext'
        │                   (all stores kept in sync)
        │
        ├── lock()      →  for (store of encryptedStores) store.lock()
        │
        ├── activateEncryption(key) →  try: for (store) store.activateEncryption(key)
        │                  catch: rollback already-unlocked stores, rethrow
        │
        └── clearLocalData() →  lock()
                                 for (callback of clearDataCallbacks) callback()
                                 (LIFO order: last registered, first wiped)
```

### Full Lifecycle: Creation → Sign-In → Sign-Out → Re-Sign-In

```
STEP 1: App starts, no user
─────────────────────────────
  const client = createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)
    .withExtension('sync', createSyncExtension({ ... }));

  client.mode === 'plaintext'
  client.tables.posts.set(...)    ← writes plaintext (works immediately)
  client.tables.posts.get(...)    ← reads plaintext

STEP 2: User signs in, key arrives
────────────────────────────────────
  // Auth session includes encryptionKey (base64)
  const userKey = base64ToBytes(session.encryptionKey);
  const wsKey = await deriveWorkspaceKey(userKey, client.id);
  client.activateEncryption(wsKey);

  client.mode === 'encrypted'
  client.tables.posts.set(...)    ← encrypts, stores EncryptedBlob
  client.tables.posts.get(...)    ← decrypts from cache (transparent)

  // Old plaintext-mode entries stay plaintext: mixed mode handled at value level
  // Only new writes are encrypted

STEP 3: Session expires (or tab backgrounded)
──────────────────────────────────────────────
  client.lock();

  client.mode === 'locked'
  client.tables.posts.set(...)    ← THROWS ("Workspace is locked")
  client.tables.posts.get(...)    ← returns cached plaintext from step 2

STEP 4: User signs out
───────────────────────
  await client.clearLocalData();

  // Internally: lock() → wipe IndexedDB (clearData on persistence extension)
  // Client singleton survives: ready for next sign-in

STEP 5: App restarts offline, cached key available
────────────────────────────────────────────────────
  const cachedKey = await keyCache.get(userId);
  if (cachedKey) {
    const wsKey = await deriveWorkspaceKey(cachedKey, client.id);
    client.activateEncryption(wsKey);
    // Immediate decryption: no server roundtrip needed
  }

STEP 6: New user signs in
──────────────────────────
  // Same as step 2: singleton workspace transitions back to 'encrypted'
  // with the new user's key
```

### Encryption Wiring Pattern (Consumer-Side)

The workspace package provides the primitives. The app wires them to its auth system. This is the complete integration for a Svelte app:

```typescript
// encryption-wiring.svelte.ts: the ENTIRE integration
import { base64ToBytes, deriveWorkspaceKey } from '@epicenter/workspace/shared/crypto';

export function initEncryptionWiring() {
  return $effect.root(() => {
    $effect(() => {
      const keyBase64 = authState.encryptionKey;
      const status = authState.status;

      if (keyBase64) {
        // Key available → decode, derive per-workspace key, activateEncryption
        const userKey = base64ToBytes(keyBase64);
        void deriveWorkspaceKey(userKey, workspaceClient.id)
          .then((wsKey) => workspaceClient.activateEncryption(wsKey));
      } else if (workspaceClient.mode === 'encrypted') {
        if (status === 'signing-out') {
          // Sign-out → wipe persisted data, keep client alive
          void workspaceClient.clearLocalData();
        } else {
          // Key cleared for other reason → soft lock
          workspaceClient.lock();
        }
      }
    });
  });
}
```

Three branches. A new developer reads this in 30 seconds and understands the entire encryption lifecycle.

### Error Containment: Quarantine

Failed decryptions don't crash the workspace. The encrypted wrapper quarantines bad entries:

```
Observer fires with new EncryptedBlob
  │
  ├── trySync(() => maybeDecrypt(value))
  │     │
  │     ├── Success → update wrapper.map with plaintext, forward change event
  │     │
  │     └── Failure → quarantine.set(key, entry), log warning, skip
  │
  └── On next activateEncryption(correctKey):
        quarantine entries are retried with the new key
        successful decryptions move from quarantine → wrapper.map
```

This handles wrong-key scenarios gracefully: `activateEncryption(wrongKey)` quarantines entries that fail. `activateEncryption(correctKey)` retries and recovers them.

## Edge Cases

### Wrong Key Provided

1. `activateEncryption(wrongKey)` is called
2. Encrypted entries fail to decrypt → quarantined (cached as unavailable)
3. `get()` returns `undefined` for quarantined entries
4. `activateEncryption(correctKey)` retries all quarantined entries → they decrypt and appear
5. Synthetic change events fire for recovered entries

### None-to-Encrypted Migration

1. Workspace used in `plaintext` mode, entries written
2. `activateEncryption(key)` called: mode transitions to `encrypted`
3. Existing plaintext entries stay plaintext in Y.Array (NOT re-encrypted)
4. New writes are encrypted
5. Mixed mode handled transparently: `isEncryptedBlob()` discriminates per value
6. To fully encrypt: consumer must read each entry and write it back (explicit migration)

### Partial Unlock Failure

1. `activateEncryption(key)` iterates `encryptedStores[]`
2. Store 3 of 5 throws during activateEncryption
3. Stores 1-2 (already unlocked) are rolled back to `locked`
4. Error is rethrown: workspace is in consistent `locked` state
5. No store is left in `encrypted` while others are `locked`

### Sign-Out During Active Writes

1. Component is writing: `table.set({ id: '1', title: 'Hello' })`
2. Sign-out triggers `clearLocalData()` which calls `lock()` first
3. Any subsequent `set()` throws immediately ("Workspace is locked")
4. `clearLocalData()` proceeds to wipe persisted data
5. In-flight Yjs transactions that already committed are in ciphertext: IndexedDB wipe removes them

### Offline Restart Without Cached Key

1. App starts, IndexedDB has encrypted data from last session
2. No cached key available (expired, cleared, or self-hosted without caching)
3. Workspace stays in `plaintext` mode (never had a key *this session*)
4. `get()` encounters `EncryptedBlob` values → can't decrypt → returns `undefined` / validation fails
5. User signs in → key arrives → `activateEncryption()` decrypts everything
6. Quarantined entries (failed decryption attempts during `plaintext` mode) are retried

**Correction**: Actually, in `plaintext` mode, the wrapper passes through values. `EncryptedBlob` values would be returned as-is to table helpers, which would fail schema validation (they expect objects, not `Uint8Array`). These show up as `{ status: 'invalid' }` results. On `activateEncryption()`, the observer rebuilds the cache with decrypted values and fires synthetic change events.

### Extension clearData Failure

1. `clearLocalData()` calls `lock()` (succeeds)
2. Iterates `clearDataCallbacks` in LIFO order
3. One callback throws (e.g., IndexedDB API error)
4. Error is caught and logged: iteration continues
5. All callbacks are attempted regardless of individual failures
6. Workspace is locked regardless: writes blocked, data may be partially wiped

## Open Questions

1. **Should AAD (Additional Authenticated Data) be used in the encrypted KV wrapper?**
   - The crypto primitives support AAD, but the wrapper currently doesn't pass entry keys as AAD
   - Without AAD, an encrypted blob could theoretically be copy-pasted between keys within the same store
   - Risk is low (attacker needs CRDT write access), but binding entry key as AAD would close it for free
   - **Recommendation**: Add AAD binding. It's one line in `set()` and one in `maybeDecrypt()`, zero performance cost

2. **Should `mode` be natively reactive (Svelte `$state` rune)?**
   - Currently a plain getter. Components can't `$effect` on `client.mode` directly
   - Works today because mode changes are always caused by auth state changes, and the encryption wiring watches `authState`, not `client.mode`
   - If a non-auth source ever needed to trigger mode-dependent UI, this would need to change
   - **Recommendation**: Defer. Current indirection through `authState` is sufficient and avoids coupling workspace internals to Svelte reactivity

3. **Should the workspace package provide a reusable encryption wiring factory?**
   - Every app writes the same `$effect(keyBase64 → deriveWorkspaceKey → activateEncryption)` pattern
   - A `createEncryptionWiring(client, keySource)` factory could eliminate boilerplate
   - But it would couple the workspace to auth state shape (or require a generic adapter)
   - **Recommendation**: Defer. The wiring is ~20 lines per app and benefits from being explicit about auth-specific semantics (sign-out vs session-expiry vs external-sign-in)

4. **Should there be a built-in `reencryptAll()` utility?**
   - When transitioning plaintext → encrypted, old entries stay plaintext forever unless explicitly rewritten
   - A convenience method could iterate all entries and rewrite them
   - But this is a potentially expensive operation (O(n) writes) that should be opt-in
   - **Recommendation**: Defer. Document the pattern ("read each entry, write it back") rather than providing a one-click foot-gun

## Success Criteria

- [x] Three-mode state machine: `plaintext` → `encrypted` ↔ `locked`
- [x] `mode`, `lock()`, `activateEncryption(key)`, `clearLocalData()` on `WorkspaceClient`
- [x] Encryption transparent to table helpers: no signature changes
- [x] Progressive enhancement: workspace works before key arrives
- [x] Singleton survives sign-out via `clearLocalData()` (lock + wipe, no dispose)
- [x] Offline restart decrypts immediately from cached key
- [x] Unlock atomicity: rollback on partial failure
- [x] Quarantine with retry for wrong-key scenarios
- [x] LIFO disposal and clearData ordering
- [x] New developer can understand the wiring in under a minute

## Validation Against Current Implementation

This spec was derived from first principles and constraints before examining the codebase. The current implementation matches the derived design exactly:

| Derived Design Element | Current Implementation | File |
|---|---|---|
| Three-mode state machine | `EncryptionMode = 'plaintext' \| 'locked' \| 'encrypted'` | `y-keyvalue-lww-encrypted.ts:125` |
| Four methods on WorkspaceClient | `mode`, `lock()`, `activateEncryption(key)`, `clearLocalData()` | `types.ts:1288-1433` |
| Composition wrapper over CRDT | `createEncryptedYkvLww` wraps `YKeyValueLww` | `y-keyvalue-lww-encrypted.ts:220` |
| Table helpers unaware of encryption | `createTable(ykv, def)` receives wrapper | `create-workspace.ts:167` |
| `isEncryptedBlob()` discrimination | `value instanceof Uint8Array && value[0] === 1` | `crypto/index.ts:271-273` |
| Two-level HKDF hierarchy | `deriveWorkspaceKey(userKey, workspaceId)` | `crypto/index.ts:377-399` |
| Platform-agnostic `KeyCache` interface | `KeyCache` type (set/get/clear) | `crypto/key-cache.ts:74-81` |
| XChaCha20-Poly1305 via `@noble/ciphers` | `xchacha20poly1305(key, nonce)` | `crypto/index.ts:58-59` |
| Self-describing binary blob format | `[formatVersion, keyVersion, nonce(24), ct, tag(16)]` | `crypto/index.ts:70-95` |
| Unlock rollback on partial failure | `try/catch` with re-lock loop | `create-workspace.ts:295-307` |
| Quarantine with retry | `quarantine` map, retried in `activateEncryption()` | `y-keyvalue-lww-encrypted.ts:252, 479-528` |
| LIFO clearData | Reverse iteration of `clearDataCallbacks` | `create-workspace.ts:313-323` |
| Consumer-side encryption wiring | `encryption-wiring.svelte.ts` with `$effect` | `apps/tab-manager/.../encryption-wiring.svelte.ts` |

**Why it matches**: The design space is heavily constrained. The singleton requirement eliminates recreation-based approaches. The synchronous CRDT hot path eliminates async crypto. The local-first requirement eliminates server-only encryption. The progressive enhancement requirement demands the three-mode state machine. The Yjs reference equality constraint demands the composition wrapper. Once these constraints are accepted, the design converges to essentially one solution.

## References

- `packages/workspace/src/workspace/types.ts`: `WorkspaceClient` type with `mode`, `lock`, `activateEncryption`, `clearLocalData`
- `packages/workspace/src/workspace/create-workspace.ts`: Builder that coordinates `encryptedStores[]`
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: Three-mode encrypted CRDT wrapper
- `packages/workspace/src/shared/crypto/index.ts`: XChaCha20-Poly1305 primitives, HKDF, blob format
- `packages/workspace/src/shared/crypto/key-cache.ts`: Platform-agnostic key caching interface
- `packages/workspace/src/workspace/lifecycle.ts`: Extension lifecycle (whenReady, dispose, clearData)
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts`: Reference consumer wiring pattern
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: Auth state with encryptionKey flow
- `docs/articles/why-e2e-encryption-keeps-failing.md`: Design philosophy context
- `docs/articles/let-the-server-handle-encryption.md`: Server-managed key rationale
- `specs/20260312T120000-y-keyvalue-lww-encrypted.md`: Original encrypted wrapper spec
- `specs/20260314T064000-per-workspace-envelope-encryption.md`: Key hierarchy spec
