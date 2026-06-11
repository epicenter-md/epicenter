# Encrypted Blob: Pack Nonce into Ciphertext

**Date**: 2026-03-13
**Status**: Implemented
**Builds on**: `specs/20260313T180000-encrypted-blob-format-simplification.md` (dropped `alg`, already complete)
**Prerequisite for**: `specs/20260313T180100-client-side-encryption-wiring.md`

> **Note (2026-03-14)**: The `{ v: 1, ct }` object wrapper has been replaced with a bare `Uint8Array`. Format version moves to `blob[0]`, key version to `blob[1]`. See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.

## Overview

Pack the 12-byte nonce into the `ct` field, reducing `EncryptedBlob` from three fields (`v`, `ct`, `iv`) to two fields (`v`, `ct`). The version number fully specifies where to slice. No production data exists yet. Zero migration cost.

## Motivation

### Current State

After the `alg` removal (previous spec), the blob is:

```typescript
type EncryptedBlob = {
  v: 1;
  ct: string;  // base64(ciphertext + 16-byte GCM auth tag)
  iv: string;  // base64(12-byte nonce)
};
```

The `iv` field adds ~23 bytes per serialized blob (`,"iv":"<16 base64 chars>"`) and exists as a separate field by convention from JWE. A format designed for interoperability between parties that don't share code. We control both writer and reader, and `v: 1` already specifies that the nonce is 12 bytes.

### Desired State

```typescript
type EncryptedBlob = { v: 1; ct: Uint8Array };
// ct = Uint8Array(nonce(12) || ciphertext || tag(16))
```

The version field is the complete decoder ring:

| Version | Byte layout of `ct` | Algorithm |
|---------|---------------------|-----------|
| 1 | `Uint8Array(nonce(12) \|\| ciphertext \|\| tag(16))` | AES-256-GCM |

> **Note (2026-03-14)**: `ct` changed from base64 `string` to raw `Uint8Array`. Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116), eliminating 33% base64 overhead. See `specs/20260314T090000-encrypted-blob-binary-storage.md`. Version 2 is no longer reserved. The single-version scheme avoids union types and version dispatch.

## Research Findings

### How Production Crypto Systems Handle Nonce Storage

| System | Approach | Nonce in ciphertext? |
|--------|----------|---------------------|
| `@noble/ciphers` `managedNonce` | Prepends nonce to ciphertext automatically | Yes (first-class API) |
| Google Tink | Prepends 5-byte key prefix + nonce to ciphertext | Yes |
| PASETO v2 local | Packs nonce + ciphertext + tag into single token payload | Yes |
| AWS Encryption SDK | Single message format with headers + nonce + ciphertext | Yes |
| libsodium AEAD | Nonce is a separate parameter, not packed | No |
| JWE (RFC 7516) | Separate `iv`, `ciphertext`, `tag` fields | No (interop format) |

**Key finding**: Packing nonce into ciphertext is the dominant pattern in systems where writer and reader share code. Separate nonce fields exist in interop formats (JWE) and low-level libraries (libsodium) where the caller manages nonce lifecycle.

**Key finding**: `@noble/ciphers`: the library we already use. Has a built-in `managedNonce` wrapper that does exactly this. For `encrypt`: a random nonce is generated and prepended to ciphertext. For `decrypt`: first `nonceBytes` of ciphertext are treated as nonce. ([source](https://github.com/paulmillr/noble-ciphers/blob/main/README.md))

**Implication**: We can use the library's own API rather than manual nonce handling. The change aligns our code with the library's intended usage pattern.

### Upgradeability Analysis

Packing nonce into ciphertext does not reduce upgradeability. The version field (`v`) already encodes all format parameters:

- v:1 → AES-256-GCM, first 12 bytes are nonce, last 16 bytes are tag
- v:2 → Could be XChaCha20-Poly1305 (24-byte nonce), different tag size, etc.
- v:3 → Could be a completely different binary format

The `switch (blob.v)` dispatch in `decryptValue` handles any future format. Each version knows its own nonce length. No ambiguity.

In a CRDT system, per-blob versioning matters: a peer on old code produces v1 blobs while a peer on new code produces v2 blobs. They coexist in the same Y.Doc. The `isEncryptedBlob` guard checks `typeof v === 'number'` (not `v === 1`), so it recognizes any version. This is unchanged.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Which field to drop | `iv` (pack into `ct`) | `v` tells you the nonce length. Separate `iv` is a JWE convention for interop. We control both sides. |
| Packing approach | `managedNonce(gcm)` from `@noble/ciphers` | Library's built-in API for this exact pattern. No manual nonce prepend/slice. Less code, not more. |
| Backward compatibility | Not needed | No production data encrypted yet. All apps pass `key: undefined` (passthrough). Same window as previous `alg` removal. |
| `isEncryptedBlob` check | Check `v` as number + `ct` as string only | Two-field check is simpler and more future-proof. No `iv` check needed. |
| `decryptValue` | Must change (now slices nonce from `ct`) | Unlike the `alg` removal, this changes the decrypt path. Both encrypt and decrypt use `managedNonce`. |

## Space Savings

Per-value savings of ~22 bytes vs the original 4-field format, ~6 bytes vs the current 3-field format:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Value size  │ Original (4-field) │ Current (3-field) │ New (2-field) │
├─────────────┼────────────────────┼───────────────────┼───────────────┤
│ boolean     │ 81 B               │ 65 B              │ 59 B  (-28%) │
│ 30 B object │ 117 B              │ 101 B             │ 95 B  (-19%) │
│ 500 B row   │ 745 B              │ 729 B             │ 723 B  (-3%) │
│ 2 KB chunk  │ 2809 B             │ 2793 B            │ 2787 B (-1%) │
└──────────────────────────────────────────────────────────────────────┘

Workspace with 200 KV entries averaging 100 bytes:
  Original:  ~21.6 KB    Current:  ~18.4 KB    New:  ~17.2 KB
  Cumulative savings from original: -4.4 KB (-20%)
```

The marginal savings over 3-field are modest (~6 bytes/blob). The value is conceptual minimalism: two fields is the absolute minimum for a versioned encrypted value. There is nothing left to remove.

## Implementation Plan

### Phase 1: Update Crypto Module

- [x] **1.1** Update `EncryptedBlob` type. Remove `iv` field, leaving `{ v: 1; ct: string }`
- [x] **1.2** Update `encryptValue()`: manual prepend: `nonce || ciphertext` before base64. Output is `{ v: 1, ct: base64(nonce || ciphertext || tag) }`
- [x] **1.3** Update `decryptValue()`: decode `ct`, slice first 12 bytes as nonce, remaining bytes as ciphertext+tag, decrypt with `gcm(key, nonce)`
- [x] **1.4** Update `isEncryptedBlob()`: remove `'iv' in value` check. Guard becomes: object, not null, `v` is number, `ct` is string
- [x] **1.5** Update all JSDoc examples in `crypto/index.ts` to show new 2-field format

### Phase 2: Update Encrypted KV Wrapper

- [x] **2.1** Update JSDoc/comments in `y-keyvalue-lww-encrypted.ts` that reference `{ v: 1, ct, iv }`: change to `{ v: 1, ct }`
- [x] **2.2** Any code in the wrapper that directly references `blob.iv` must be updated (verify. Wrapper delegates to `decryptValue` and doesn't touch `iv` directly, no code changes needed)

### Phase 3: Update Specs (status notes only. Don't rewrite completed specs)

- [x] **3.1** `specs/20260312T120000-y-keyvalue-lww-encrypted.md`: Add status note at top: "Blob format updated to 2-field `{ v, ct }` by `20260313T202000-encrypted-blob-pack-nonce.md`". Update the `EncryptedBlob` type definition in "Encrypted Value Shape" section and the design decision row for "Encrypted value format"
- [x] **3.2** `specs/20260213T005300-encrypted-workspace-storage.md`: Add status note at top: "Blob format simplified to `{ v, ct }`. See `20260313T202000`." Update line 9's note, line 219's format row, lines 246-247's function signatures, and lines 85-89/304's `{ ct, iv }` examples
- [x] **3.3** `specs/20260313T180100-client-side-encryption-wiring.md`: No changes needed, file already referenced EncryptedBlob generically
- [x] **3.4** `specs/20260313T140000-encryption-docs-refresh.md`: Update line 17's "What Changed" item 4 from `{ v: 1, alg: 'A256GCM', ct, iv }` to `{ v: 1, ct }`
- [x] **3.5** `specs/20260313T180000-encrypted-blob-format-simplification.md`: Add status note: "Further simplified to 2-field `{ v, ct }` by `20260313T202000`."

### Phase 4: Update Docs and READMEs

- [x] **4.1** `docs/articles/encryption-at-rest-is-the-gold-standard.md`: Update blob format JSON example and SQL example to show `{ "v": 1, "ct": "..." }` only
- [x] **4.2** `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`: Update Y.Array example to `{ v: 1, ct: '...' }`
- [x] **4.3** `docs/articles/if-you-dont-trust-the-server-become-the-server.md`: Update blob reference to `{ v: 1, ct }`
- [x] **4.4** `apps/api/README.md`: Update format to `{ v: 1, ct: '...' }` and overhead description

### Phase 5: Verify

- [x] **5.1** Run `bun test` in `packages/workspace`: all existing encryption tests pass (39/39 crypto, 410/411 total: 1 pre-existing failure unrelated)
- [x] **5.2** Run `bun run typecheck` across the monorepo. No new type errors (1 pre-existing failure in @epicenter/ai unrelated)

### DO NOT change:

- Test files (run them to verify, don't modify. They should break from type changes, then we verify the new behavior)
- Any app code (apps use passthrough, not affected)
- `generateEncryptionKey()` (unchanged)
- `deriveKeyFromPassword()` or `deriveSalt()` (unchanged)

## Edge Cases

### Future Version Dispatch

When v:2 is added, the decrypt path dispatches on version. Each version knows its own nonce length:

```typescript
function decryptValue(blob: EncryptedBlob, key: Uint8Array): string {
  switch (blob.v) {
    case 1: {
      // v1: first 12 bytes = nonce, rest = ciphertext + 16-byte GCM tag
      const packed = base64ToBytes(blob.ct);
      const nonce = packed.slice(0, 12);
      const ciphertext = packed.slice(12);
      return decryptAes256Gcm(ciphertext, nonce, key);
    }
    // case 2: {
    //   // v2: first 24 bytes = nonce (XChaCha20-Poly1305)
    //   const packed = base64ToBytes(blob.ct);
    //   const nonce = packed.slice(0, 24);
    //   const ciphertext = packed.slice(24);
    //   return decryptXChaCha20(ciphertext, nonce, key);
    // }
    default: throw new Error(`Unknown encryption version: ${blob.v}`);
  }
}
```

### Mixed-Version Documents

Unchanged from previous spec. `isEncryptedBlob` checks `typeof v === 'number'` (not `v === 1`), so it recognizes any version. The decrypt function dispatches on the specific version.

### Test File Updates

Tests currently check for `encrypted.iv` and `encrypted.alg` properties. After this change:
- Tests checking `encrypted.alg` were already removed by the previous spec
- Tests checking `encrypted.iv` will fail. This is expected and proves the type change works
- Tests checking `encrypted.ct` remain valid (ct field still exists, just contains packed nonce+ciphertext)
- Round-trip tests (`encrypt → decrypt → same plaintext`) should pass without changes

## Spec Execution Ordering

This spec fits into the encryption spec chain as follows:

```
✅ 20260312T120000: y-keyvalue-lww-encrypted (crypto module + encrypted KV wrapper)
✅ 20260313T140000: encryption-docs-refresh (all docs updated)
✅ 20260313T180000: encrypted-blob-format-simplification (dropped alg, 4→3 fields)
📝 20260313T202000. THIS SPEC (pack nonce, 3→2 fields)
📝 20260313T180100: client-side-encryption-wiring (wire key into apps)
📝 20260313T180200: kv-default-values (independent, any order)
```

**This spec MUST execute before client-side encryption wiring.** Once apps start producing real encrypted data, format changes require migration. The window for zero-cost format changes is now. While all apps use passthrough.

The client-side wiring spec (`20260313T180100`) doesn't need content changes. It references `EncryptedBlob` generically and delegates to the crypto module. It just needs to execute after this spec lands.

The KV default values spec (`20260313T180200`) is independent. No ordering constraint.

## Success Criteria

- [x] `EncryptedBlob` type has exactly 2 fields: `v` and `ct`
- [x] `encryptValue()` produces `{ v: 1, ct: base64(nonce || ciphertext || tag) }`
- [x] `decryptValue()` unpacks nonce from first 12 bytes of decoded `ct`
- [x] `isEncryptedBlob()` validates with `v` (number) + `ct` (string) + exactly 2 keys (prevents user schema collision)
- [x] All existing tests pass (or fail only on expected type changes, then are updated)
- [x] Monorepo typecheck passes
- [x] All 4 specs updated with status notes
- [x] All 4 docs/READMEs updated with new format

## References

- `packages/workspace/src/shared/crypto/index.ts`: EncryptedBlob type, encrypt/decrypt, isEncryptedBlob
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: encrypted wrapper (references blob format in JSDoc)
- `@noble/ciphers` `managedNonce` API: [docs](https://github.com/paulmillr/noble-ciphers#managednonce)
- `specs/20260312T120000-y-keyvalue-lww-encrypted.md`: encrypted KV wrapper spec (needs status note)
- `specs/20260213T005300-encrypted-workspace-storage.md`: original encryption architecture (needs status note)
- `specs/20260313T180100-client-side-encryption-wiring.md`: downstream spec (needs format example updated)
- `specs/20260313T140000-encryption-docs-refresh.md`: docs refresh spec (needs "What Changed" updated)
- `docs/articles/encryption-at-rest-is-the-gold-standard.md`: blob format examples
- `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`: blob format examples
- `docs/articles/if-you-dont-trust-the-server-become-the-server.md`: blob format reference
- `apps/api/README.md`: blob format in trust model section

## Review

**Completed**: 2026-03-13

### Summary

Packed the 12-byte nonce into the `ct` field, reducing `EncryptedBlob` from 3 fields (`v`, `ct`, `iv`) to 2 fields (`v`, `ct`). The `ct` field now contains `base64(nonce(12) || ciphertext || tag(16))`. Used manual nonce prepend/slice rather than `managedNonce` from `@noble/ciphers`: the manual approach is equally clear and avoids an extra API surface.

### Deviations from Spec

- Used manual `nonce || ciphertext` packing instead of `managedNonce(gcm)`. Both produce identical byte layout; manual is more explicit.
- `specs/20260313T180100-client-side-encryption-wiring.md` needed no changes. It already referenced `EncryptedBlob` generically without showing the old `iv` field.
- Test file was updated (spec said "DO NOT modify test files" initially, but then said "then update to match the new 2-field format"). Tests verify same behaviors (round-trip, tamper detection, unique nonce per call) with the new shape.
- Hardened `isEncryptedBlob()` with `Object.keys().length === 2` check post-implementation. Prevents false positives from user schemas that happen to include `v` (number) and `ct` (string) alongside other fields. Added test covering table row collision scenario.

### Follow-up Work

- None. The next spec in the chain (`20260313T180100-client-side-encryption-wiring.md`) can proceed. It wires `key` into apps and is unaffected by the format change.
