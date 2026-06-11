# EncryptedBlob: Binary Storage via Yjs writeAny

**Date**: 2026-03-14
**Status**: Implemented & Superseded by `specs/20260314T230000-bare-uint8array-encrypted-blob.md`
**Author**: AI-assisted

> **Note (2026-03-14)**: The `{ v: 1, ct: Uint8Array }` object wrapper has been replaced with a bare `Uint8Array` with a self-describing binary header (`blob[0]` = format version, `blob[1]` = key version). See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.

## Overview

Replace base64 string encoding in `EncryptedBlob.ct` with raw `Uint8Array` storage. Yjs's `writeAny` natively serializes `Uint8Array` as binary (type tag 116), eliminating the 33% base64 overhead that currently inflates every encrypted value.

## Motivation

### Current State

Every encrypted value goes through a base64 round-trip before storage:

```typescript
// packages/workspace/src/shared/crypto/index.ts, line 117-138
function encryptValue(plaintext: string, key: Uint8Array, aad?: Uint8Array): EncryptedBlob {
  const nonce = randomBytes(12);
  const cipher = aad ? gcm(key, nonce, aad) : gcm(key, nonce);
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = cipher.encrypt(data);

  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);

  return {
    v: 1,
    ct: bytesToBase64(packed),  // ← 33% expansion here
  };
}
```

The `EncryptedBlob` type stores `ct` as a `string`:

```typescript
// packages/workspace/src/shared/crypto/index.ts, line 73-76
type EncryptedBlob = {
  v: 1;
  ct: string;
};
```

This creates one problem:

1. **33% storage overhead from base64 encoding.** AES-256-GCM ciphertext is the same length as plaintext. The nonce (12 bytes) and auth tag (16 bytes) add a fixed 28 bytes. But `bytesToBase64` then expands the entire binary payload by 4:3. For a 200-byte value, encrypted storage is ~318 bytes instead of ~230 bytes: 59% overhead vs the achievable 15%.

### Desired State

```typescript
type EncryptedBlob = {
  v: 2;
  ct: Uint8Array;  // raw binary: nonce(12) || ciphertext || tag(16)
};
```

Overhead drops to just the fixed 28 bytes of crypto metadata per value. No proportional expansion.

## Research Findings

### Yjs writeAny/readAny Binary Serialization

Verified directly from source code in `dmonad/lib0` (the encoding library Yjs uses):

**`writeAny` encoding table** (from `dmonad/lib0/src/encoding.js`):

| Data Type | Type Tag | Encoding Method | Handles recursion? |
|-----------|----------|----------------|--------------------|
| undefined | 127 |: |: |
| null | 126 |: |: |
| integer | 125 | writeVarInt |: |
| float32 | 124 | writeFloat32 |: |
| float64 | 123 | writeFloat64 |: |
| bigint | 122 | writeBigInt64 |: |
| boolean (false) | 121 |: |: |
| boolean (true) | 120 |: |: |
| string | 119 | writeVarString |: |
| object | 118 | custom | Yes: recurses `writeAny` per property value |
| array | 117 | custom | Yes: recurses `writeAny` per element |
| **Uint8Array** | **116** | **writeVarUint8Array** |: |

**Critical path for our use case:**

When Yjs serializes `{ key: "tab-1", val: { v: 2, ct: Uint8Array(...) }, ts: 123 }`:

1. Top-level object → ContentAny → `writeAny(object)` → type 118
2. For each property, recurses `writeAny` on the value
3. `val` property → another object → type 118, recurse again
4. `ct` property → `Uint8Array` → **type 116 → `writeVarUint8Array` → raw binary**

**`readAny` decoding** (from `dmonad/lib0/src/decoding.js`):

```javascript
const readAnyLookupTable = [
  decoder => undefined,     // 127
  decoder => null,          // 126
  readVarInt,               // 125
  readFloat32,              // 124
  readFloat64,              // 123
  readBigInt64,             // 122
  decoder => false,         // 121
  decoder => true,          // 120
  readVarString,            // 119
  decoder => { /* object: recurses readAny */ }, // 118
  decoder => { /* array: recurses readAny */ },  // 117
  readVarUint8Array          // 116: returns Uint8Array
]
```

Round-trip is symmetric. `readAny` for type 116 calls `readVarUint8Array`, which returns a `Uint8Array`.

**Version compatibility:**

- This encoding has been stable across all `lib0@0.2.x` versions (current: `^0.2.117`)
- DeepWiki confirms `writeAny`/`readAny` type tags are unchanged between Yjs v13 and v14
- The encoding table is the core binary format contract. Changing it would break all existing documents

### Storage Overhead Comparison

For a plaintext JSON value of P bytes:

| | Current (base64 string) | Proposed (Uint8Array) |
|---|---|---|
| **Crypto overhead** | 28 bytes (nonce+tag) | 28 bytes (nonce+tag) |
| **Encoding expansion** | ×4/3 on entire payload | 0% (raw binary) |
| **Wrapper structure** | `{"v":1,"ct":"..."}` | `{v:2, ct: Uint8Array}` |
| **Yjs encoding** | type 119 (string) for ct | type 116 (binary) for ct |
| **Per-value overhead** | ~51 bytes + 33% of P | ~30 bytes + 0% of P |

Concrete numbers:

| Value size | Current overhead | Proposed overhead | Savings |
|-----------|-----------------|-------------------|---------|
| 10 bytes | ~540% | ~280% | ~48% smaller |
| 50 bytes | ~135% | ~56% | ~43% smaller |
| 100 bytes | ~84% | ~28% | ~42% smaller |
| 200 bytes | ~59% | ~14% | ~38% smaller |
| 500 bytes | ~43% | ~6% | ~35% smaller |
| 1 KB | ~38% | ~3% | ~34% smaller |

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Version bump `v: 1` → `v: 2` | **No** | No backward compatibility needed. Monorepo deploys atomically. All clients update together. Keeping `v: 1` avoids union types and version dispatch. |
| Keep `{ v, ct }` wrapper object | Yes | Preserves `isEncryptedBlob` shape-checking pattern. Alternative (bare `Uint8Array`) loses version info. |
| `isEncryptedBlob` checks `ct instanceof Uint8Array` | Yes | Direct type check, no ambiguity. `typeof ct === 'string'` removed entirely. |
| Remove `bytesToBase64`/`base64ToBytes` from crypto exports | No. Keep for now | Still used by `apps/api/src/app.ts` for key transport (JSON over HTTP). Separate concern from blob storage. |
| `encryptValue` returns `{ v: 1, ct: Uint8Array }` | Yes | All writes use binary. No base64 in the encrypt path. |
| `decryptValue` uses `blob.ct` directly | Yes | No version dispatch. Single code path. |
| Backward compatibility with old base64 `ct: string` | **None** | Old data is not migrated. Coordinated deploy means no mixed-version clients. |
| `BaseRow._v` namespace guard | No change needed | The `_v` vs `v` guard exists to prevent `isEncryptedBlob` false positives on table rows. With `ct instanceof Uint8Array`, table rows with a `ct` string field won't match. |

## Architecture

### Current Flow (before this change)

```
set('tab-1', { url: '...' })
  │
  ├── JSON.stringify({ url: '...' })           → '{"url":"..."}'  (P bytes)
  ├── AES-GCM encrypt                          → nonce(12) + ciphertext(P) + tag(16)
  ├── bytesToBase64(packed)                     → base64 string ((P+28)×4/3 chars)
  └── inner.set('tab-1', { v:1, ct: "..." })   → stored via ContentAny
                                                   └── writeAny(string) → type 119
```

### New Flow (after this change)

```
set('tab-1', { url: '...' })
  │
  ├── JSON.stringify({ url: '...' })           → '{"url":"..."}'  (P bytes)
  ├── AES-GCM encrypt                          → nonce(12) + ciphertext(P) + tag(16)
  └── inner.set('tab-1', { v:1, ct: packed })  → stored via ContentAny
                                                   └── writeAny(Uint8Array) → type 116
                                                       (raw binary, no expansion)
```

### Decode Path

```
decryptValue(blob, key)
  │
  └── blob.ct (Uint8Array, direct access)
      └── slice nonce(0..12), ciphertext(12..)
          └── AES-GCM decrypt → plaintext string
```

## Implementation Plan

### Phase 1: Core Crypto Changes

- [x] **1.1** Update `EncryptedBlob` type: `type EncryptedBlob = { v: 1; ct: Uint8Array }`
- [x] **1.2** Update `encryptValue` to return `{ v: 1, ct: Uint8Array }` (remove `bytesToBase64` call, return packed bytes directly)
- [x] **1.3** Update `decryptValue` to use `blob.ct` directly (no version dispatch)
- [x] **1.4** Update `isEncryptedBlob` type guard: `v === 1 && ct instanceof Uint8Array`

### Phase 2: Test Updates

- [x] **2.1** Update `crypto.test.ts`: shape assertions expect `{ v: 1, ct: Uint8Array }`
- [x] **2.2** Update `crypto.test.ts`: tampered ciphertext/nonce tests use Uint8Array operations
- [x] **2.3** Update `crypto.test.ts`: isEncryptedBlob tests check `v: 1` + `Uint8Array` only
- [x] **2.4** Update `y-keyvalue-lww-encrypted.test.ts`: corrupt blob entries use `Uint8Array` instead of string
- [x] **2.5** Add binary storage overhead benchmark test

### Phase 3: Documentation Updates

- [x] **3.1** Update JSDoc on `EncryptedBlob` type
- [x] **3.2** Update JSDoc on `encryptValue`/`decryptValue`/`isEncryptedBlob`
- [x] **3.3** Update module-level JSDoc (flow diagram)

## Edge Cases

### Corrupted Blob

1. Test pushes `{ v: 1, ct: new Uint8Array([1,2,3]) }` (valid shape, invalid ciphertext)
2. `decryptValue` throws (GCM auth tag verification fails)
3. Error containment in `tryDecryptEntry` quarantines the entry
4. No change to error containment behavior

### `isEncryptedBlob` False Positive Risk

Current guard checks `Object.keys(value).length === 2 && v === 1 && ct instanceof Uint8Array`.

- A table row `{ id: "x", _v: 1, ct: someUint8Array }` has 3+ keys → rejected by key count check
- A KV value `{ v: 1, ct: someUint8Array }` with exactly 2 keys and matching types → would match. Pathologically unlikely in practice, documented in JSDoc.

## Success Criteria

- [x] `encryptValue` returns `{ v: 1, ct: Uint8Array }`: no base64 in the hot path
- [x] `decryptValue` round-trips correctly using `blob.ct` directly
- [x] `isEncryptedBlob` checks `v === 1 && ct instanceof Uint8Array`
- [x] All existing tests pass (crypto, encrypted KV, comparison)
- [x] New benchmark test shows measurable reduction in `Y.encodeStateAsUpdate` size for encrypted documents
- [x] No references to `bytesToBase64`/`base64ToBytes` remain in the encrypt/decrypt path (only in key transport)
- [x] `bun test` passes across the workspace package

## Files Changed

### Implementation

| File | What Changed |
|------|-------------|
| `packages/workspace/src/shared/crypto/index.ts` | `EncryptedBlob` type (`ct: Uint8Array`), `encryptValue` (drop base64), `decryptValue` (direct `blob.ct`), `isEncryptedBlob` (single check) |
| `packages/workspace/src/shared/crypto/crypto.test.ts` | Shape assertions, tamper tests use Uint8Array, isEncryptedBlob tests simplified, storage benchmark |
| `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts` | Corrupt blob entries use `Uint8Array` instead of string |

### No Change Needed

| File | Why |
|------|-----|
| `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` | Uses `encryptValue`/`decryptValue`/`isEncryptedBlob` via imports. The `EncryptedBlob \| T` union type widens automatically. No code changes. |
| `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts` | Unaware of encryption. Stores whatever value type it receives. |
| `apps/api/src/app.ts` | Uses `bytesToBase64` for key transport over JSON. Separate concern, no change |

 ## Review

**Completed**: 2026-03-14

### Summary

All phases implemented: `EncryptedBlob.ct` changed from base64 string to raw `Uint8Array`, base64 removed from the encrypt/decrypt hot path, `isEncryptedBlob` simplified to check `ct instanceof Uint8Array`. Subsequently superseded by `specs/20260314T230000-bare-uint8array-encrypted-blob.md`, which removed the `{ v: 1, ct }` object wrapper entirely in favor of a bare `Uint8Array` with a self-describing binary header. The algorithm was also changed from AES-256-GCM to XChaCha20-Poly1305 during the same session.

### Deviations from Spec

- **No version bump**: Spec proposed `v: 2` but the design decision table already said no. Implementation kept `v: 1`.
- **Superseded same day**: The bare-uint8array spec went further and removed the object wrapper entirely, making this spec's format (`{ v: 1, ct: Uint8Array }`) an intermediate step that never shipped to users.
