# Bare Uint8Array Encrypted Blob Format

**Date**: 2026-03-14
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace the `{ v: 1, ct: Uint8Array }` object wrapper with a bare `Uint8Array` stored directly in the CRDT. The format version moves from a JSON field into the first byte of the binary, aligning with Tink, Vault Transit, and AWS Encryption SDK patterns. Saves ~9 bytes per blob in Yjs encoding overhead.

## Motivation

### Current State

Encrypted values are stored as a two-field JS object in the Yjs CRDT:

```typescript
type EncryptedBlob = { v: 1; ct: Uint8Array };

// Detection:
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    Object.keys(obj).length === 2 &&
    obj.v === 1 &&
    obj.ct instanceof Uint8Array
  );
}
```

Binary layout of `ct`:

```
ct[0]      = key version (1 byte)
ct[1..24]  = random nonce (24 bytes)
ct[25..]   = XChaCha20-Poly1305 ciphertext || tag (16 bytes)
```

This creates problems:

1. **Redundant versioning**: `v` on the object and `ct[0]` (key version) inside the binary are two separate version domains. The format version (`v`) could live as the first byte of the binary instead of a JSON field.
2. **9 bytes wasted per blob**: Yjs `writeAny` encodes the `{ v, ct }` object wrapper as type tag 118 (object) + key count + field names "v" and "ct" + value encodings. A bare Uint8Array uses type tag 116 + length + raw bytes. The wrapper adds ~9 bytes of encoding overhead per blob.
3. **Misalignment with industry**: Google Tink, HashiCorp Vault Transit, and AWS Encryption SDK all pack everything into the binary. No JSON wrappers.
4. **`Object.keys().length` check is hostile to evolution**: The current guard rejects any blob with extra fields, making the format impossible to extend without breaking old clients.

### Desired State

Encrypted values are stored as bare `Uint8Array` values directly in the CRDT. A self-describing binary header identifies the format:

```typescript
type EncryptedBlob = Uint8Array;

// Detection:
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return value instanceof Uint8Array && value[0] === 1;
}
```

## Research Findings

### How Production Systems Store Encrypted Data

| System | Format | Key ID location | Wrapper? |
|---|---|---|---|
| **Google Tink** | `type(1) \|\| keyId(4) \|\| cipher-specific...` | Bytes 1-4 of binary | No wrapper---pure binary |
| **Vault Transit** | `vault:v{N}:{base64ct}` | String prefix | No wrapper---string with prefix |
| **AWS Encryption SDK** | `version(1) \|\| algSuite(2) \|\| ... \|\| ct` | Binary header | No wrapper---pure binary |
| **Bitwarden** | `{encType}.{iv}\|{ct}\|{mac}` | Numeric type prefix | No wrapper---string with prefix |
| **Better Auth** | `$ba${version}${ciphertext}` | String prefix | No wrapper---string with prefix |
| **Epicenter (current)** | `{ v: 1, ct: Uint8Array }` | `v` field on JS object | **Yes---JSON object wrapper** |

**Key finding**: Every production encryption system embeds format identification in the payload itself. None use a sibling JSON field.

**Implication**: Moving `v` into the binary as ct[0] aligns with universal practice and simplifies the type system.

### CRDT Detection Reliability

The encrypted KV wrapper (`y-keyvalue-lww-encrypted.ts`) stores values in a Y.Array where `val` is either:
- A **plaintext user value**: Always a JS object from `JSON.parse()` (table rows with `id`, `_v`, etc.)
- An **encrypted blob**: Currently `{ v, ct }`, proposed to be `Uint8Array`

User values are NEVER Uint8Arrays because:
1. All user data flows through schema definitions that produce JS objects
2. The `set()` path does `JSON.stringify(val)` before encryption---the raw value is always an object
3. In plaintext mode, `inner.set(key, val)` stores the raw object directly
4. Yjs stores objects and Uint8Arrays with different type tags (118 vs 116), making them distinguishable at the encoding level

`value instanceof Uint8Array` is a reliable discriminant in this codebase. The risk is theoretical (someone adding a bare Uint8Array as a table value), not practical.

### Yjs Encoding Overhead

From `lib0/encoding.js` `writeAny` type tags:

| Stored value | Yjs encoding | Overhead |
|---|---|---|
| `{ v: 1, ct: Uint8Array(N) }` | tag(118) + keyCount(1) + "v"(2) + intTag+value(2) + "ct"(3) + tag(116) + varuint(N) + N | **~11 + N bytes** |
| `Uint8Array(N)` | tag(116) + varuint(N) + N | **~2 + N bytes** |

**Savings: ~9 bytes per blob.** At 10,000 entries, that's 90KB saved from the Yjs document.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Blob storage type | Bare `Uint8Array` | Aligns with Tink/Vault/AWS; saves 9 bytes; simpler type |
| Format version location | `ct[0]` (first byte of binary) | Self-describing; every production system does this |
| Key version location | `ct[1]` (second byte) | Follows format version; same as current design |
| Detection mechanism | `instanceof Uint8Array && ct[0] === 1` | User values are never Uint8Arrays;
truncated blobs fail decrypt and get quarantined |
| TypeScript type | `type EncryptedBlob = Uint8Array` (branded or plain) | Simplest possible type; detection via `isEncryptedBlob()` |

## Architecture

### v:1 Binary Layout

```
 Byte:  0         1         2                        26
        +---------+---------+------------------------+---------------------------+
        | format  | key     |        nonce           |    ciphertext + tag       |
        | version | version |      (24 bytes)        |    (variable + 16)        |
        +---------+---------+------------------------+---------------------------+
        |  0x01   | 0x01-FF | random (CSPRNG)        | XChaCha20-Poly1305 output |
        +---------+---------+------------------------+---------------------------+

 Total: 1 + 1 + 24 + len(plaintext) + 16 bytes

 format version (ct[0]):
   0x01 = XChaCha20-Poly1305, layout as shown above
   0x02+  = reserved for future algorithms/layouts

 key version (ct[1]):
   Matches the version number from ENCRYPTION_SECRETS env var.
   e.g., ENCRYPTION_SECRETS="2:secret2,1:secret1" → key version 1 or 2.

 nonce (ct[2..25]):
   24 random bytes from CSPRNG. XChaCha20's 192-bit nonce is safe
   for random generation (no collision risk up to 2^72 messages).

 ciphertext + tag (ct[26..]):
   XChaCha20-Poly1305 authenticated encryption output.
   Last 16 bytes are the Poly1305 authentication tag.
   Plaintext was: JSON.stringify(userValue) → TextEncoder.encode().
```

### Detection Logic

```
 Value stored in CRDT
        │
        ▼
 instanceof Uint8Array?
   │    NO───┼───YES
   │         │
   │    ct[0] === 1?
   │         │
   │    NO───┼───YES
   │    │         │
   ▼    ▼         ▼
 PLAINTEXT      ENCRYPTED (v:1)
```

### Encrypt / Decrypt Flow

```
 ENCRYPT:
   userValue
     → JSON.stringify()
     → TextEncoder.encode()
     → xchacha20poly1305(key, nonce).encrypt(data)
     → pack: [formatVer, keyVer, ...nonce, ...ciphertext]
     → Uint8Array stored in CRDT

 DECRYPT:
   Uint8Array from CRDT
     → ct[0] = format version (must be 1)
     → ct[1] = key version (select key from keyring)
     → nonce = ct[2..25]
     → ciphertext = ct[26..]
     → xchacha20poly1305(key, nonce).decrypt(ciphertext)
     → TextDecoder.decode()
     → JSON.parse()
     → userValue
```

## Implementation Plan

### Phase 1: Core Type and Crypto Changes

- [x] **1.1** Change `EncryptedBlob` type from `{ v: 1; ct: Uint8Array }` to `Uint8Array` in `packages/workspace/src/shared/crypto/index.ts`
- [x] **1.2** Update `encryptValue()` to return a bare `Uint8Array` with format version at byte 0:
  - `packed[0] = 1` (format version)
  - `packed[1] = keyVersion`
  - `packed.set(nonce, 2)`
  - `packed.set(ciphertext, 2 + NONCE_LENGTH)`
- [x] **1.3** Update `decryptValue()` to read format version from byte 0, key version from byte 1, nonce from bytes 2-25, ciphertext from byte 26+
- [x] **1.4** Update `getKeyVersion()` to read from `blob[1]` instead of `blob.ct[0]`
- [x] **1.5** Add `getFormatVersion()` function: `return blob[0]`
- [x] **1.6** Rewrite `isEncryptedBlob()`:
  ```typescript
  function isEncryptedBlob(value: unknown): value is EncryptedBlob {
    return value instanceof Uint8Array && value[0] === 1;
  }
  ```
- [x] **1.7** Update all JSDoc on EncryptedBlob, encryptValue, decryptValue, isEncryptedBlob, getKeyVersion with new binary layout documentation
- [x] **1.8** Update module-level JSDoc encryption flow diagram

### Phase 2: Encrypted KV Wrapper Updates

- [x] **2.1** Update `y-keyvalue-lww-encrypted.ts`: the `maybeDecrypt` function uses `isEncryptedBlob(value)` which will now check for Uint8Array instead of object shape. Verify this works with no call-site changes needed.
- [x] **2.2** Update any type annotations that reference the old `EncryptedBlob` shape (e.g., `EncryptedBlob | T` in generics)
- [x] **2.3** Verify the observer and quarantine logic still works with Uint8Array values

### Phase 3: Test Updates

- [x] **3.1** Update `crypto.test.ts`: all tests that construct or assert on `{ v: 1, ct }` must change to bare Uint8Array
- [x] **3.2** Update `isEncryptedBlob` test cases: object-based tests become Uint8Array-based tests
- [x] **3.3** Update `y-keyvalue-lww-encrypted.test.ts`: any assertions on inner CRDT values that check for `{ v, ct }` shape
- [x] **3.4** Run full test suite: `bun test` in `packages/workspace`: all tests must pass

### Phase 4: Documentation

- [x] **4.1** Update encryption skill (`.agents/skills/encryption/SKILL.md`) with bare Uint8Array format
- [x] **4.2** Update HKDF key derivation spec if it references the old blob format
- [x] **4.3** Verify no other specs reference `{ v: 1, ct }` pattern

## Edge Cases

### Synced Data from Old Clients

Since there is zero production data, this is not a concern. All clients will be updated simultaneously before any data is written.

### Future Format Version

If a future format version (ct[0] = 2) is encountered by a client that only understands v:1, the `isEncryptedBlob` check will fail (ct[0] !== 1), and the value will be treated as plaintext. This is a safe failure mode---the value will be quarantined by the encrypted wrapper's error containment, not silently corrupted.

A more robust approach would check `ct[0] >= 1` in `isEncryptedBlob` and handle unknown versions explicitly in `decryptValue` with a clear error message: "Unknown encryption format version: {ct[0]}".

### Uint8Array vs User Data Collision

User values stored in plaintext mode are always JS objects (from schema definitions). They are never Uint8Arrays. If this invariant ever changes (e.g., a table stores raw binary data), the detection logic would need to be updated. This should be documented as a constraint in the encrypted wrapper's JSDoc.

## Open Questions (Resolved)

1. **Should `isEncryptedBlob` check `ct[0] === 1` (exact version) or `ct[0] >= 1` (any known version)?**
   - **Resolved**: Exact check (`=== 1`). Implementation uses `value instanceof Uint8Array && value[0] === 1`. Unknown format versions fall through to plaintext handling and get quarantined by the encrypted wrapper's error containment.

2. **Should `EncryptedBlob` be a branded type or plain `Uint8Array`?**
   - **Resolved**: Branded. `type EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>`. Contrary to the original recommendation, the brand was adopted using the codebase's existing `Brand<T>` utility. All construction goes through `encryptValue` which casts `as EncryptedBlob`, so the brand adds type safety at call sites without ceremony at construction sites.

## Success Criteria

- [x] `EncryptedBlob` type is `Uint8Array` (no object wrapper): branded via `Uint8Array & Brand<'EncryptedBlob'>`
- [x] `isEncryptedBlob` detects bare Uint8Array with format version check (`instanceof Uint8Array && value[0] === 1`)
- [x] `encryptValue` returns a bare Uint8Array with format version at byte 0, key version at byte 1
- [x] `decryptValue` reads format version from byte 0, key version from byte 1, nonce from bytes 2-25
- [x] `getKeyVersion` reads from `blob[1]`
- [x] All 485+ tests pass in `packages/workspace`
- [x] No TypeScript errors (lsp_diagnostics clean on all changed files)
- [x] Binary layout documented in JSDoc with byte offsets
- [x] Encryption skill updated with new format
- [x] No remaining references to `{ v: 1, ct }` pattern in source code

## References

- `packages/workspace/src/shared/crypto/index.ts`: Core encrypt/decrypt/type functions (PRIMARY)
- `packages/workspace/src/shared/crypto/crypto.test.ts`: Unit tests for crypto primitives
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: Encrypted wrapper that calls encrypt/decrypt
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts`: Integration tests for encrypted wrapper
- `.agents/skills/encryption/SKILL.md`: Encryption skill documentation
- `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`: HKDF spec (may reference old blob format)

## Review

**Completed**: 2026-03-14

### Summary

Replaced the `{ v: 1, ct: Uint8Array }` object wrapper with a bare `Uint8Array` stored directly in the CRDT. Format version lives at byte 0, key version at byte 1, followed by the 24-byte nonce and XChaCha20-Poly1305 ciphertext. `isEncryptedBlob` is now a simple `instanceof Uint8Array && value[0] === 1` check. Saves ~9 bytes per blob in Yjs encoding overhead.

### Deviations from Spec

- **Branded type chosen**: Spec recommended plain `Uint8Array`, but implementation uses `Uint8Array & Brand<'EncryptedBlob'>` for type safety at call sites.
- **Exact version check chosen**: Spec recommended `ct[0] >= 1` for forward compatibility, but implementation uses exact `=== 1` check. Unknown format versions fall through to plaintext handling and get quarantined.
- **Algorithm changed**: During implementation, the cipher was changed from AES-256-GCM (12-byte nonce) to XChaCha20-Poly1305 (24-byte nonce). This changed the binary layout offsets: nonce is bytes 2-25 (24 bytes) instead of the 12 bytes that AES-GCM would use.
