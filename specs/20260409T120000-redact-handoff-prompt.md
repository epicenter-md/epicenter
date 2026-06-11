# Handoff Prompt: Vault E2E Encryption: Phase 1 (Crypto Helpers) [Implemented]

Execute Phase 1 of the spec at `specs/20260409T120000-redact-password-encrypted-vault.md`. This phase adds 3 password-based key derivation functions to the existing crypto module and writes tests for them.

## Context

### What This Project Is

Epicenter is a local-first workspace platform. Data is stored in Yjs CRDTs, encrypted with XChaCha20-Poly1305 via `@noble/ciphers`. Encryption keys are currently derived server-side and delivered via auth sessions. We're adding password-based E2E encryption so users can create vault workspaces the server can't decrypt.

### The Existing Crypto Module

All crypto primitives live in one file: `packages/workspace/src/shared/crypto/index.ts`. It currently exports:

```typescript
// From @noble/ciphers
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
// From @noble/hashes
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Already uses these module-level instances:
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Existing exports:
export function encryptValue(plaintext: string, key: Uint8Array, aad?: Uint8Array, keyVersion?: number): EncryptedBlob
export function decryptValue(blob: EncryptedBlob, key: Uint8Array, aad?: Uint8Array): string
export function getKeyVersion(blob: EncryptedBlob): number
export function isEncryptedBlob(value: unknown): value is EncryptedBlob
export function deriveWorkspaceKey(userKey: Uint8Array, workspaceId: string): Uint8Array
export function bytesToBase64(bytes: Uint8Array): string
export function base64ToBytes(base64: string): string
export type { EncryptedBlob }
```

The `EncryptionKeys` type is defined in `packages/workspace/src/workspace/encryption-key.ts`:

```typescript
// EncryptionKeys is a non-empty tuple:
export type EncryptionKeys = [EncryptionKey, ...EncryptionKey[]];
export type EncryptionKey = { version: number; userKeyBase64: string };
```

It's re-exported from `@epicenter/workspace` (the package's public API).

### What @noble/hashes Already Has

`@noble/hashes ^2.0.1` is already in `packages/workspace/package.json`. It ships `pbkdf2` at `@noble/hashes/pbkdf2.js`:

```typescript
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
// pbkdf2(hash, password, salt, opts) → Uint8Array
// opts: { c: iterations, dkLen: keyLength }
// Synchronous. Same Cure53-audited library as hkdf and sha256.
```

### How These New Functions Will Be Used (Downstream: NOT Part of This Phase)

```typescript
// Future vault unlock flow:
import { deriveKeyFromPassword, generateSalt, buildEncryptionKeys } from '@epicenter/workspace/crypto';

const salt = generateSalt();                                    // setup
const userKey = deriveKeyFromPassword('hunter2', salt, 600_000); // unlock
workspace.applyEncryptionKeys(buildEncryptionKeys(userKey));     // activate
```

### Existing Test File

Tests live at `packages/workspace/src/shared/crypto/crypto.test.ts`. They use `bun:test` with `describe`/`test`/`expect`. They import from `./index`. Add the new tests in a new `describe` block at the end of the file, following the same patterns.

## Task

Add 3 functions to `packages/workspace/src/shared/crypto/index.ts` and write tests for them in `crypto.test.ts`.

### Function 1: `deriveKeyFromPassword`

```typescript
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

const PBKDF2_ITERATIONS_DEFAULT = 600_000;

/**
 * Derive a 32-byte key from a password and salt using PBKDF2-HMAC-SHA256.
 *
 * Uses `@noble/hashes`: same Cure53-audited library as `hkdf`, `sha256`,
 * and `xchacha20poly1305` in this module. Synchronous, matching the
 * existing crypto pattern.
 *
 * The derived key is a user key. Pass it to `deriveWorkspaceKey()` or
 * `buildEncryptionKeys()` to get a workspace-scoped encryption key.
 *
 * @param password - The user's password
 * @param salt - Random 32-byte salt (use `generateSalt()`)
 * @param iterations - PBKDF2 iterations (default: 600,000 per OWASP 2026)
 * @returns A 32-byte derived key
 *
 * @example
 * ```typescript
 * const salt = generateSalt();
 * const userKey = deriveKeyFromPassword('hunter2', salt);
 * const wsKey = deriveWorkspaceKey(userKey, 'epicenter.redact');
 * ```
 */
export function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS_DEFAULT,
): Uint8Array {
  return pbkdf2(sha256, textEncoder.encode(password), salt, { c: iterations, dkLen: 32 });
}
```

### Function 2: `generateSalt`

```typescript
const SALT_LENGTH = 32;

/**
 * Generate a random 32-byte salt for PBKDF2 key derivation.
 *
 * Uses `randomBytes` from `@noble/ciphers`: same CSPRNG used for
 * encryption nonces in `encryptValue()`.
 *
 * @returns A 32-byte random Uint8Array
 *
 * @example
 * ```typescript
 * const salt = generateSalt();
 * const key = deriveKeyFromPassword('password', salt);
 * ```
 */
export function generateSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH);
}
```

### Function 3: `buildEncryptionKeys`

```typescript
/**
 * Build an `EncryptionKeys` array from a password-derived user key.
 *
 * Returns the same shape that `applyEncryptionKeys` expects,
 * so password-derived keys plug directly into the existing encryption flow
 * without any changes to the encryption core.
 *
 * @param userKey - A 32-byte user key (from `deriveKeyFromPassword`)
 * @param version - Key version (default: 1)
 * @returns `EncryptionKeys` array ready for `workspace.applyEncryptionKeys()`
 *
 * @example
 * ```typescript
 * const userKey = deriveKeyFromPassword('hunter2', salt);
 * workspace.applyEncryptionKeys(buildEncryptionKeys(userKey));
 * ```
 */
export function buildEncryptionKeys(
  userKey: Uint8Array,
  version: number = 1,
): EncryptionKeys {
  return [{ version, userKeyBase64: bytesToBase64(userKey) }];
}
```

Note: `buildEncryptionKeys` needs to import the `EncryptionKeys` type. It's at `../../workspace/encryption-key` relative to `crypto/index.ts`. Use `import type { EncryptionKeys } from '../../workspace/encryption-key';`.

### Tests to Write

Add a `describe('deriveKeyFromPassword')` block and a `describe('buildEncryptionKeys')` block to `crypto.test.ts`. Tests needed:

**deriveKeyFromPassword:**
1. [x] Same inputs produce same key (deterministic)
2. [x] Different passwords produce different keys
3. [x] Different salts produce different keys
4. [x] Output is 32 bytes
5. [x] Default iterations is 600,000 (test that omitting the param still works)
6. [x] Integrates with `deriveWorkspaceKey`: the output is a valid user key that `deriveWorkspaceKey` accepts

**generateSalt:**
1. [x] Output is 32 bytes
2. [x] Two calls produce different salts

**buildEncryptionKeys:**
1. [x] Returns array with one entry matching `{ version, userKeyBase64 }` shape
2. [x] Default version is 1
3. [x] Custom version is respected
4. [x] `userKeyBase64` round-trips through `base64ToBytes` back to the original key
5. [x] Integrates end-to-end: `deriveKeyFromPassword` → `buildEncryptionKeys` → the userKeyBase64 can be decoded and passed to `deriveWorkspaceKey` to produce a valid workspace key that encrypts/decrypts via `encryptValue`/`decryptValue`

## MUST DO

- [x] Add the `import { pbkdf2 } from '@noble/hashes/pbkdf2.js';` alongside the existing noble imports at the top of `crypto/index.ts`
- [x] Add `import type { EncryptionKeys } from '../../workspace/encryption-key';` for the `buildEncryptionKeys` return type
- [x] Export the `EncryptionKeys` type from `crypto/index.ts` as a re-export (so consumers can `import { buildEncryptionKeys, type EncryptionKeys } from '@epicenter/workspace/crypto'`)
- [x] Place the 3 new functions AFTER the existing `deriveWorkspaceKey` function and BEFORE the `bytesToBase64`/`base64ToBytes` helpers (group key derivation functions together)
- [x] Place the 2 new constants (`PBKDF2_ITERATIONS_DEFAULT`, `SALT_LENGTH`) alongside the existing constants (`NONCE_LENGTH`, `TAG_LENGTH`, `HEADER_LENGTH`) near the top
- [x] Also export the `PBKDF2_ITERATIONS_DEFAULT` constant (apps need it for their vault metadata)
- [x] Follow the existing JSDoc style in the file exactly: detailed, with `@example` blocks
- [x] Use `textEncoder` (already defined at module scope) instead of `new TextEncoder()`
- [x] Use `bun:test` with `describe`/`test`/`expect` in the test file, matching existing patterns
- [x] Run `bun test packages/workspace/src/shared/crypto/crypto.test.ts` after writing tests
- [x] Run `bun run typecheck` from the workspace root after making changes

## MUST NOT DO

- Do not modify any existing functions or types
- Do not modify any files outside of `packages/workspace/src/shared/crypto/index.ts` and `packages/workspace/src/shared/crypto/crypto.test.ts`
- Do not change the `package.json`: `@noble/hashes` is already a dependency
- Do not add any new dependencies
- Do not use WebCrypto (`crypto.subtle`): everything must be synchronous via `@noble/hashes`
- Do not create new files
- Do not use `interface`: use `type` for all TypeScript types
- Do not suppress type errors with `as any`, `@ts-ignore`, or `@ts-expect-error`

## Review

**Completed**: 2026-04-09

### Summary

Added 3 password-based key derivation functions (`deriveKeyFromPassword`, `generateSalt`, `buildEncryptionKeys`) and the `PBKDF2_ITERATIONS_DEFAULT` constant to the crypto module. Added 13 tests covering determinism, output size, parameter defaults, round-trips, and end-to-end integration through the full encrypt/decrypt pipeline. All 52 crypto tests pass, zero type errors in changed files.

### Deviations from Spec

None. Implementation matches the spec exactly.

### Follow-up Work

- Phase 2: Vault workspace creation flow using these primitives
- Wire `buildEncryptionKeys` into `applyEncryptionKeys` in the vault unlock UI
