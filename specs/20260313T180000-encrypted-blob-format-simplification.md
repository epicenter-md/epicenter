# Encrypted Blob Format Simplification

**Date**: 2026-03-13
**Status**: Complete
**Builds on**: `specs/20260312T120000-y-keyvalue-lww-encrypted.md`, `specs/20260213T005300-encrypted-workspace-storage.md`
**Prerequisite for**: `specs/20260313T180100-client-side-encryption-wiring.md`

> **Note (2026-03-13)**: Further simplified to 2-field `{ v: 1, ct }` by packing the nonce into the ciphertext field. See `specs/20260313T202000-encrypted-blob-pack-nonce.md`.
> **Note (2026-03-14)**: The `{ v: 1, ct }` object wrapper has been replaced with a bare `Uint8Array` with self-describing binary header. See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.
## Overview

Remove the `alg` field from `EncryptedBlob`. The version number (`v`) is the sole contract for the encryption format. Algorithm, nonce size, tag size, and encoding are all implied by the version. This saves 16 bytes per encrypted value and simplifies the type guard.

## Motivation

### Current State

```typescript
type EncryptedBlob = {
  v: 1;
  alg: 'A256GCM';
  ct: string;  // base64-encoded ciphertext + 16-byte GCM auth tag
  iv: string;  // base64-encoded 12-byte nonce
};
```

The `alg` field occupies 16 bytes in every serialized blob (`,"alg":"A256GCM"`). It's redundant because `v: 1` already specifies AES-256-GCM. There's no scenario where version 1 uses a different algorithm. The field exists by convention (JWE includes `alg` and `enc` headers), but JWE is an interop format designed for parties that don't share code. We control both writer and reader.

### Desired State

```typescript
type EncryptedBlob = { v: 1; ct: string; iv: string };
```

The version field is the complete format specification:

| Version | Algorithm | Nonce | Tag | Encoding |
|---------|-----------|-------|-----|----------|
| 1 | AES-256-GCM | 12 bytes | 16 bytes (appended to ct) | raw Uint8Array (was base64 string, changed in `specs/20260314T090000-encrypted-blob-binary-storage.md`) |

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Which field to drop | `alg` (keep `v`) | `v` is 6 bytes vs `alg` at 16 bytes, and `v` is strictly more powerful. It encodes algorithm *and* format, encoding, field names, nonce size |
| Backward compatibility | Not needed | No real data encrypted yet. All apps pass `key: undefined` (passthrough). Zero migration cost if done now. |
| `isEncryptedBlob` check | Simplify to check `v` as number + `ct`/`iv` as strings | Drops the `alg === 'A256GCM'` check. Future versions dispatch on `v` value. |
| Future algorithm changes | Bump `v` | v:2 could be XChaCha20-Poly1305, v:3 could be a binary format. The dispatch in `decryptValue` is a switch on `v`. |

## Space Savings

Per-value savings of 16 bytes (`,"alg":"A256GCM"` removed from JSON):

```
┌─────────────────────────────────────────────────────────┐
│ Value size  │ Before (with alg) │ After (no alg) │ Δ   │
├─────────────┼───────────────────┼────────────────┼─────┤
│ boolean     │ 86 B              │ 70 B           │ -19%│
│ 30 B object │ 116 B             │ 100 B          │ -14%│
│ 500 B row   │ 744 B             │ 728 B          │ -2% │
│ 2 KB chunk  │ 2792 B            │ 2776 B         │ -1% │
└─────────────────────────────────────────────────────────┘

Workspace with 200 KV entries averaging 100 bytes:
  Before: ~21.6 KB encrypted    After: ~18.4 KB encrypted    Δ: -3.2 KB
```

The savings are proportionally largest for small values. Which is exactly what KV settings (booleans, short strings, small objects) tend to be.

## Implementation Plan

### Phase 1: Update Types and Functions

- [x] **1.1** Update `EncryptedBlob` type in `packages/workspace/src/shared/crypto/index.ts`: remove `alg` field
- [x] **1.2** Update `encryptValue()`: stop emitting `alg` in the returned object
- [x] **1.3** Update `decryptValue()`: no changes needed (doesn't read `alg`)
- [x] **1.4** Update `isEncryptedBlob()`: remove `'alg' in value` and `alg === 'A256GCM'` checks, keep `v`/`ct`/`iv` checks
- [x] **1.5** Update `generateEncryptionKey()`: no changes needed

### Phase 2: Update References

- [x] **2.1** Update JSDoc examples in `crypto/index.ts` that show `alg: 'A256GCM'` in sample blobs
- [x] **2.2** Update JSDoc/comments in `y-keyvalue-lww-encrypted.ts` that reference the blob format
- [ ] **2.3** Update the encrypted workspace storage spec (`20260213T005300`) status note to reflect this change
- [ ] **2.4** Update the y-keyvalue-lww-encrypted spec (`20260312T120000`) references to blob format

### Phase 3: Verify

- [x] **3.1** Run `bun test` in `packages/workspace`: all existing encryption tests pass (1 pre-existing failure unrelated)
- [x] **3.2** Run `bun run typecheck` across the monorepo. No new type errors (1 pre-existing failure in @epicenter/ai unrelated)

## Edge Cases

### Future Version Dispatch

When v:2 is added, the decrypt path dispatches on version:

```typescript
function decryptValue(blob: EncryptedBlob, key: Uint8Array): string {
  switch (blob.v) {
    case 1: return decryptAes256Gcm(blob, key);
    // case 2: return decryptXChaCha20(blob, key);
    default: throw new Error(`Unknown encryption version: ${blob.v}`);
  }
}
```

### Mixed-Version Documents

A Y.Doc could contain blobs from different versions if the format evolves. The `isEncryptedBlob` guard checks `typeof v === 'number'` (not `v === 1`), so it recognizes any version. The decrypt function then dispatches on the specific version.

## Success Criteria

- [x] `EncryptedBlob` type has 3 fields: `v`, `ct`, `iv`
- [x] `encryptValue()` produces blobs without `alg`
- [x] `isEncryptedBlob()` validates without checking `alg`
- [x] All existing tests pass (crypto: 39/39, full suite: 410/411: 1 pre-existing failure)
- [x] Monorepo typecheck passes (1 pre-existing failure in @epicenter/ai unrelated)

## References

- `packages/workspace/src/shared/crypto/index.ts`: EncryptedBlob type, encrypt/decrypt, isEncryptedBlob
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: encrypted wrapper (references blob format in docs)
- `specs/20260312T120000-y-keyvalue-lww-encrypted.md`: implementation spec for the encrypted wrapper
- `specs/20260213T005300-encrypted-workspace-storage.md`: original encryption architecture spec
- `apps/api/README.md`: already updated to show `{ v: 1, ct, iv }` format
