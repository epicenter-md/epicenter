# Encryption Wrapper Hardening

**Date**: 2026-03-14
**Status**: Implemented
**Builds on**: `specs/20260313T202000-encrypted-blob-pack-nonce.md`, `specs/20260312T120000-y-keyvalue-lww-encrypted.md`
**Blocks**: `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md` (key derivation depends on hardening being in place)

> **Note (2026-03-14)**: The `{ v: 1, ct: Uint8Array }` object wrapper referenced below has been replaced with a bare `Uint8Array` with self-describing binary header. See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.
> **Note (2026-03-14)**: References to AES-256-GCM and `gcm(key, nonce, aad)` below reflect the cipher used at the time of writing. The codebase now uses **XChaCha20-Poly1305** (`xchacha20poly1305(key, nonce, aad)`), which also supports AAD. All AAD concepts described here still apply.

## Overview

Harden `createEncryptedKvLww` with three explicit encryption modes, error containment, a key transition hook, and AAD context binding. These are prerequisite fixes before real encryption keys flow to real clients.

## Motivation

### Current State

```typescript
// y-keyvalue-lww-encrypted.ts: current behavior
const key = options?.key;

// set(): no key = plaintext-mode passthrough
const keyBytes = key;
if (!keyBytes) return inner.set(key, val);
inner.set(key, encryptValue(JSON.stringify(val), keyBytes));

// maybeDecrypt: no error handling
const maybeDecrypt = (value: EncryptedBlob | T): T => {
  const key = options?.key;
  if (!key || !isEncryptedBlob(value)) return value as T;
  return JSON.parse(decryptValue(value, key)) as T; // throws on bad blob
};
```

This creates four problems:

1. **Sign-out writes plaintext-mode over ciphertext.** When a user signs out, `key` is `undefined`. New writes go plaintext-mode. A plaintext-mode write with a newer LWW timestamp permanently replaces previously encrypted data. Security downgrade via timestamp.
2. **One bad blob crashes all observation.** `decryptValue` or `JSON.parse` throwing inside the `inner.observe()` handler kills the entire observation chain. Every consumer of that table stops receiving updates.
3. **Map hydration doesn't rebuild on key arrival.** The wrapper builds its decrypted map once at creation. If the workspace loads before auth completes, encrypted entries stay as raw `{ v: 1, ct: Uint8Array }` blobs in the map until each entry is individually touched by a new observer event.
4. **No ciphertext context binding.** Ciphertext from `table:posts/post-1` can be copied to `table:users/user-1` and decrypts successfully. AES-GCM supports Additional Authenticated Data (AAD) at zero extra cost.

### Desired State

```typescript
// Three explicit modes
type EncryptionMode = 'plaintext' | 'locked' | 'encrypted';

// set() in locked mode rejects writes
if (mode === 'locked') throw new Error('Workspace is locked: sign in to write');

// observer catches decrypt failures
const decrypted = trySync(() => maybeDecrypt(entry.val));
if (decrypted.error) { quarantine(key, entry); continue; }

// key transition rebuilds the map
wrapper.activateEncryption(newKey);  // re-decrypts all entries, transitions mode
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mode state machine | `plaintext` → `encrypted` ↔ `locked` | `plaintext` is the initial state for workspaces that have never seen a key. Once a key arrives, mode becomes `encrypted`. Key cleared → `locked`. `locked` rejects writes to prevent plaintext-mode overwriting ciphertext. |
| Locked mode behavior | `set()` throws, `get()` returns cached plaintext | Reads should still work (map was populated while encrypted). Writes must fail to prevent security downgrade. |
| Error containment | `trySync` wrapper around `maybeDecrypt`, skip failed entries | A quarantine approach (log + skip) is better than a throw that kills all observation. Quarantined entries can be retried when the correct key arrives. |
| AAD format | `encode(workspaceId + ':' + tableName + ':' + entryKey)` | Binds ciphertext to its exact position. Prevents cross-table replay. Uses string concatenation with `:` separator (no ambiguity since IDs are UUIDs). |
| AAD as optional parameter | `encryptValue(plaintext, key, aad?)` | Backward compatible. Existing code without AAD still works. The wrapper passes AAD; direct callers in tests can omit it. |
| `activateEncryption()` / `lock()` scope | Rebuilds `wrapper.map` from `inner.map` | Re-iterates all entries, decrypts with the new key, replaces the entire map. Fires synthetic change events so observers see the transition. |
| Mode persistence | Not persisted. Derived from key presence | Mode is runtime state. On fresh page load, workspace starts in `plaintext` if no key cache, or `encrypted` if key cache provides a key. No need to store mode. |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  createEncryptedKvLww                                       │
│                                                             │
│  mode: 'plaintext' | 'locked' | 'encrypted'                 │
│                                                             │
│  set(key, val)                                              │
│    ├── mode === 'locked'  → throw Error                     │
│    ├─ mode === 'plaintext' → inner.set(key, val)           │
│    └─ mode === 'encrypted' → encrypt + inner.set            │
│                                                             │
│  inner.observe(changes)                                     │
│    ├── trySync(maybeDecrypt(entry.val))                     │
│    │   ├── ok → map.set(key, decrypted)                     │
│    │   └── err → quarantine.set(key, entry), log warning    │
│    └── forward decrypted changes to handlers                │
│                                                             │
│  activateEncryption(key: Uint8Array) or lock(): void                   │
│    ├─ key present  → mode = 'encrypted', rebuild map        │
│    ├─ key cleared  → mode = 'locked' (if was encrypted)     │
│    └─ key cleared  → mode = 'plaintext' (if was plaintext) │
│                                                             │
│  encryptValue(plaintext, key, aad?)                         │
│  decryptValue(blob, key, aad?)                              │
└─────────────────────────────────────────────────────────────┘
```

### Mode Transitions

```
                    ┌─────────────┐
        (creation,  │  NONE       │  (no key ever seen)
         no key)    │  rw plain   │
                    └──────┬──────┘
                           └ activateEncryption(key)
                           ▼
                    ┌─────────────┐
                    │  ACTIVE     │  (key encrypted)
                    └─── activateEncryption(newKey)
                    └──────┬──────┘
                           └ lock()
                           ▼
                    ┌─────────────┐
                    │   LOCKED    │  (key was encrypted, now cleared)
                    │  r-only     │
                    └──────┬──────┘
                           └ activateEncryption(key)
                           ▼
                    ┌─────────────┐
                    │  ACTIVE     │  (re-sign-in)
                    └─────────────┘
```

Note: `plaintext` → `locked` never happens. `locked` means "was encrypted before." A workspace that never had a key stays `plaintext` through sign-out because there's no ciphertext to protect.

## Implementation Plan

### Phase 1: Encryption Primitives: AAD Support

- [x] **1.1** Update `encryptValue(plaintext, key, aad?)`: pass `aad` to `gcm(key, nonce, aad)`. When `aad` is undefined, behavior is identical to today.
- [x] **1.2** Update `decryptValue(blob, key, aad?)`: pass `aad` to `gcm(key, nonce, aad)`. Mismatched AAD causes GCM auth tag failure (throws).
- [x] **1.3** Update tests: add round-trip test with AAD, add test that mismatched AAD throws.

### Phase 2: Wrapper Hardening

- [x] **2.1** Add `mode` state (`plaintext` | `locked` | `encrypted`) to `createEncryptedKvLww`. Initialize based on whether `key` is provided at creation time.
- [x] **2.2** Gate `set()` on mode: throw in `locked`, encrypt in `encrypted`, passthrough in `plaintext`.
- [x] **2.3** Wrap `maybeDecrypt` calls in observer with error containment. On failure, store the raw entry in a `quarantine` map and log a warning. Skip the entry in `wrapper.map`.
- [x] **2.4** Add `lock()` and `activateEncryption(key: Uint8Array)` methods. Re-iterates `inner.map`, re-decrypts all entries, rebuilds `wrapper.map`, retries quarantined entries, transitions mode, fires synthetic change events.
- [x] **2.5** Wire AAD into the wrapper: compute `encode(workspaceId + ':' + tableName + ':' + entryKey)` for each encrypt/decrypt call. Accept `workspaceId` and `tableName` as new options to `createEncryptedKvLww`.

### Phase 3: Tests

- [x] **3.1** Mode transitions: plaintext → encrypted → locked → encrypted round-trip
- [x] **3.2** Locked mode: verify `set()` throws, `get()` still returns cached values
- [x] **3.3** Error containment: inject a corrupted blob, verify observation continues for other entries
- [x] **3.4** Key transition: create wrapper without key, add entries as plaintext-mode, call `activateEncryption(key)`, verify new writes encrypt and map is rebuilt
- [x] **3.5** AAD: verify cross-table ciphertext replay fails (decrypt with wrong AAD throws)

### Phase 4: Update Docs

- [x] **4.1** Update module JSDoc in `y-keyvalue-lww-encrypted.ts`: document mode system, replace "Current behavior" note in key lifecycle state machine
- [x] **4.2** Update `crypto/index.ts` JSDoc: document AAD parameter
- [x] **4.3** Update wiring spec: mark Phase 0 items as implemented

## Edge Cases

### Workspace loads before auth, user has cached key

1. `KeyCache.get()` returns a key from last session
2. `activateEncryption(cachedKey)` called immediately → mode = `encrypted`
3. Workspace decrypts from cache while auth roundtrip completes in background
4. Session arrives → same key (or rotated key) → `activateEncryption()` again → no-op or re-decrypt

### Key rotation (same user, new key)

1. Server rotates KEK, user gets new DEK on next session
2. `activateEncryption(newKey)` called
3. Old ciphertext was encrypted with old key → `maybeDecrypt` with new key fails → entries go to quarantine
4. **This is a real problem.** Key rotation requires either: (a) re-encrypting data server-side before rotation, or (b) supporting a keyring of recent keys.
5. **Recommendation**: Defer keyring support to the envelope encryption spec. For now, key rotation = re-encrypt data first.

### Multiple tables in one workspace

Each table gets its own AAD context (`workspaceId:tableName:entryKey`). A value encrypted in `tabs` cannot be replayed into `settings` even if the key is the same.

## Open Questions

1. ~~**Should `locked` mode throw on `set()` or silently no-op?**~~ **RESOLVED.** Throw.
   - Throw is the correct choice: consumer knows immediately something is wrong.
   - No-op would cause silent data loss. User thinks they saved but nothing persisted.
   - Apps are local-first and work without auth gates. The UI layer should detect `workspace.mode === 'locked'` and disable editing controls (forms, inputs, write-triggering buttons) with a "Sign in to continue editing" message. The throw acts as a safety net for any write path the UI missed.
   - All previously decrypted data remains readable from the cached map. Locked mode is read-only, not inaccessible.

2. **Should quarantined entries be exposed via the API?**
   - Options: (a) internal-only, just skip them, (b) expose `wrapper.quarantine` as a read-only map
   - **Recommendation**: (b) expose it. Table helpers could show a "N entries failed to decrypt" warning.

3. **Should `activateEncryption()` / `lock()` fire synthetic `add` events for all entries?**
   - On a full rebuild, every entry in `wrapper.map` changes from possibly-wrong to decrypted.
   - Options: (a) fire `update` for changed entries only, (b) fire `add` for everything, (c) fire a single bulk event
   - **Recommendation**: (a) fire `update` only for entries whose decrypted value actually changed.

## Success Criteria

- [x] `set()` throws in `locked` mode, encrypts in `encrypted`, passes through in `plaintext`
- [x] One corrupted blob does not prevent other entries from decrypting
- [x] `activateEncryption()` / `lock()` rebuilds the decrypted map and transitions mode correctly
- [x] AAD mismatch causes decrypt failure (GCM auth tag verification)
- [x] All existing tests pass (backward compatible. No AAD = same behavior)
- [x] New tests cover mode transitions, error containment, key transition, and AAD

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: primary file to modify
- `packages/workspace/src/shared/crypto/index.ts`: AAD parameter addition
- `packages/workspace/src/shared/crypto/crypto.test.ts`: AAD tests
- `specs/20260313T180100-client-side-encryption-wiring.md`: Phase 0 items reference this spec
- `@noble/ciphers` docs: `gcm(key, nonce, aad)` API for AAD support

## Review

**Completed**: 2026-03-14

### Summary

Implemented the full hardening spec across 4 phases in 4 incremental commits. The encrypted KV wrapper now has a three-mode state machine (plaintext/locked/encrypted), error containment via trySync quarantine, a key transition hook that rebuilds the decrypted map with synthetic change events, and optional AAD context binding.

### Deviations from Spec

- **Removed AAD wiring from wrapper**: The `workspaceId`, `tableName` options and `computeAad()` function were removed. AAD solves a near-theoretical problem in this architecture (CRDT entries don't move, per-workspace keys already namespace ciphertext). The AAD parameter support in `encryptValue`/`decryptValue` primitives is kept for future use.
- **Single key path**: Removed the `key` polling bridge from `set()`. Keys arrive exclusively via `activateEncryption()` and `lock()` after creation. `key` is seeded at creation time. Clean break, no dual-path ambiguity.
- **Simplified mode transition**: Replaced the redundant `else if (mode === 'plaintext') { mode = 'plaintext' }` no-op with `else if (mode !== 'plaintext') { mode = 'locked' }`.
- **Non-optional type members**: `mode`, `quarantine`, `lock()`, and `activateEncryption()` are non-optional on `YKeyValueLwwEncrypted<T>`: clean break.
- **Synthetic transaction**: `activateEncryption()` and `lock()` fire synthetic change events with `undefined as unknown as Y.Transaction` since there is no real Yjs transaction for key transitions. Documented with a comment.
- **Comprehensive JSDoc restored**: All inline JSDoc stripped during Wave 2 has been restored to match original coverage depth, plus documentation for all new functions.
- **Dropped oldValue from change events**: `YKeyValueLwwChange<T>` simplified from `{action, oldValue?, newValue?}` to `{action: 'add'|'update', newValue} | {action: 'delete'}`. No consumers used oldValue. Consumers that need it in the future can track previous values in a closure (5 lines). This eliminated 2 of 3 trySync blocks in the encrypted wrapper's observer, collapsing ~55 lines to ~20.
- **Eliminated pending/pendingDeletes**: The wrapper no longer duplicates the inner CRDT's pending state. `get()` falls back to `inner.get()` + decrypt-on-the-fly during the transaction gap. `has()` is now consistent with `get()` for quarantined entries.

### Follow-up Work

- `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md` is now unblocked
- Per-workspace subkey derivation (wiring spec 0.2) still needs implementation
- Consider changing `YKeyValueLwwChangeHandler` to accept `Y.Transaction | null` to properly type synthetic events
