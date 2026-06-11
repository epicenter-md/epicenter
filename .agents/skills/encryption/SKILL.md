---
name: encryption
description: 'Encryption: HKDF, XChaCha20-Poly1305, blob formats, key hierarchy/rotation. Use for "encrypt this", "key management", crypto primitives, EncryptedBlob.'
---

# Encryption Patterns

## Reference Repositories

When working with encryption, consult these repositories for patterns and documentation:

- [noble-ciphers](https://github.com/paulmillr/noble-ciphers) : Audited JS implementation of ChaCha, Salsa, AES (our crypto primitive library)
- [libsodium](https://github.com/jedisct1/libsodium) : Crypto primitives, secretbox/AEAD patterns, XChaCha20-Poly1305
- [Signal Protocol (libsignal)](https://github.com/signalapp/libsignal) : Key hierarchy, HKDF usage, Double Ratchet, message encryption
- [Vault Transit](https://developer.hashicorp.com/vault/docs/secrets/transit) : Key versioning, rotation, ciphertext format (`vault:v1:base64`)
- [Bitwarden](https://github.com/bitwarden/server) : Client-side vault encryption, key hierarchy (master key -> org key -> cipher key)
- [AWS KMS](https://docs.aws.amazon.com/kms/) : Envelope encryption patterns, key rotation lifecycle
- [age](https://github.com/FiloSottile/age) : Simple file encryption design philosophy

## Upstream Grounding

When crypto primitive behavior, nonce requirements, AEAD semantics, or implementation APIs affect correctness, verify against the primitive library source and official cryptography docs before changing code. If DeepWiki MCP is available, use it only as orientation: ask `signalapp/libsignal` for key hierarchy, HKDF, message encryption, or Double Ratchet design patterns; ask `bitwarden/server` for vault-style key hierarchy, organization keys, and client-side encryption patterns. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Do not copy a protocol design from either repo without adapting it to Epicenter's threat model and verifying against local code, installed types, tests, and official docs.

Skip DeepWiki for Epicenter blob format and keyring conventions already documented below.

### What We Borrow From Each

| Concern | Inspiration | Why |
|---|---|---|
| Key derivation | Signal Protocol | HKDF-SHA256 with domain-separation info strings (unversioned, per RFC 5869) |
| Symmetric cipher | libsodium / WireGuard | XChaCha20-Poly1305: 2.3x faster in pure JS, 24-byte nonce safe for random generation |
| Key hierarchy | Bitwarden | Root secret -> per-user key -> per-workspace key |
| Key version in ciphertext | Tink / Vault | Key version byte prefix inside ct binary |
| Key rotation model | Vault Transit | Keyring with versioned secrets, lazy re-encryption |
| Design philosophy | age | Simplicity over configurability |

## Epicenter's Encryption Architecture

### Environment Variables

```bash
# Required. Completely independent from BETTER_AUTH_SECRET.
# Always uses versioned format: "version:secret" pairs, comma-separated.
# Generate secret: openssl rand -base64 32

# Single key (initial setup):
ENCRYPTION_SECRETS="1:base64encodedSecret"

# After rotation (add new version, keep old for decryption):
ENCRYPTION_SECRETS="2:newBase64Secret,1:oldBase64Secret"
```

- ONE env var: `ENCRYPTION_SECRETS` (always plural, always versioned format)
- Format: `version:secret` pairs, comma-separated. Highest version = current key for new encryptions.
- Completely decoupled from `BETTER_AUTH_SECRET`--rotating one never affects the other
- Matches Better Auth's own `BETTER_AUTH_SECRETS` convention

### Key Hierarchy

```
ENCRYPTION_SECRETS="1:base64Secret"
       |
       |  Parse -> keyring[{ version: 1, secret: "base64Secret" }]
       |  Current = highest version
       |
       |  SHA-256(currentSecret) -> root key material
       |  HKDF(root, info="user:{userId}") -> per-user key (32 bytes)
       |
       |  HKDF(userKey, info="workspace:{wsId}") -> per-workspace key (32 bytes)
       v
  XChaCha20-Poly1305 encrypt/decrypt with @noble/ciphers
```

### Key Delivery Best Practices

**Prefer inline key delivery over separate endpoints.** If the session already authenticates the user, derive and embed key material in the session response. HKDF-SHA256 derivation adds <0.1ms:the optimization of splitting key delivery from session delivery costs more in complexity (version-tracking state, extra round-trips, duplicated callbacks) than it saves in compute.

**Make unlock operations idempotent.** Calling `unlock()` with the same key twice should be a no-op, and calling it with a different key should cleanly replace the active key. This eliminates client-side version tracking:the client receives the key, calls unlock, done. No mutable `lastVersion` state, no conditional fetches.

**Embed key version in the ciphertext, not in application logic.** The blob header (`blob[1]`) carries the version that encrypted it. Decryption reads the version from the blob and selects the matching key from the keyring. Clients never need to track which version they’re using:the data is self-describing.

**Minimize client-side key state.** Ideally zero mutable state. The session carries the key, the client passes it to `unlock()`, the workspace derives per-workspace keys internally. No caches to invalidate, no version comparisons, no separate fetch methods.

### Why XChaCha20-Poly1305 Over AES-256-GCM

| Concern | AES-256-GCM | XChaCha20-Poly1305 (chosen) |
|---|---|---|
| Performance (pure JS, 64B) | 201K ops/sec @ 4us | 468K ops/sec @ 2us (2.3x faster) |
| Nonce size | 12 bytes (collision risk with random) | 24 bytes (safe for random nonces) |
| Max messages per key (random nonce) | 2^23 (8M) | 2^72 (practically unlimited) |
| Nonce-reuse impact | Catastrophic (full key recovery) | Catastrophic (but 2^72 makes it irrelevant) |
| Used by | NIST, TLS 1.3 | libsodium, WireGuard, TLS 1.3, Noise Protocol |

AES-256-GCM via WebCrypto uses hardware AES-NI and is faster, but it's async. We need synchronous encrypt/decrypt for the CRDT hot path.

### Key Derivation

- Uses Web Crypto HKDF with SHA-256 hash
- Empty salt (acceptable for HKDF when input key material has high entropy)
- Info strings are domain-separation labels, NOT version identifiers
- Treat HKDF info strings as protocol strings. Document their allowed shape, keep them stable, and require a migration or format boundary when they change.
- `user:{userId}` for per-user keys, `workspace:{wsId}` for per-workspace keys
- Different secrets with the same info string produce cryptographically independent keys (RFC 5869)

### EncryptedBlob Format

```typescript
type EncryptedBlob = Uint8Array;

// Bare Uint8Array with self-describing binary header.
// v:1 binary layout:
//   blob[0]     = format version (0x01 = XChaCha20-Poly1305)
//   blob[1]     = key version (which secret from ENCRYPTION_SECRETS keyring)
//   blob[2..25] = random nonce (24 bytes, XChaCha20)
//   blob[26..]  = XChaCha20-Poly1305 ciphertext || authentication tag (16 bytes)
```

- `blob[0]` = format version. Currently always 1 (XChaCha20-Poly1305).
- `blob[1]` = key version, identifying which secret encrypted this blob
- Detection: `value instanceof Uint8Array && value[0] === 1`
- User values in the CRDT are always JS objects, never Uint8Arrays
- Use `getKeyVersion(blob)` to read `blob[1]` without decrypting
- Use `getFormatVersion(blob)` to read `blob[0]` without decrypting

### Key Rotation

```bash
# Rotate by adding a new highest-version entry:
ENCRYPTION_SECRETS="2:newBase64Secret,1:oldBase64Secret"
```

- Parser splits by `,`, then each entry by first `:` -> `{ version: number, secret: string }`
- Sorted by version descending; first entry = current for new encryptions
- Encrypt: always uses current (highest version) key, embeds version as blob[1]
- Decrypt: read blob[1] to know which key version was used, select matching key from keyring
- Lazy re-encryption: on read with non-current key version, re-encrypt on next write
- Keep old secrets in keyring for at least 90 days to handle offline devices

### Format Version Upgrade Path

- Format version 1 = XChaCha20-Poly1305 with key version byte at blob[1]

Format version bumps only needed for algorithm or binary layout changes (extremely rare):

| Scenario | Bumps format version? |
|---|---|
| Secret rotation (new entry in ENCRYPTION_SECRETS) | No--key version in blob[1] handles this |
| Switch to different algorithm (unlikely) | Yes--different cipher |
| Add compression before encryption | Yes--different plaintext encoding |
| Change HKDF parameters (SHA-384, non-empty salt) | Yes--different key derivation |

### isEncryptedBlob Detection

```typescript
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return value instanceof Uint8Array && value[0] === 1;
}
```

User values in the CRDT are always JS objects (from schema definitions), never Uint8Arrays.
This makes `instanceof Uint8Array` a reliable discriminant. Truncated or corrupted blobs
that pass this check will fail during `decryptValue()` and get quarantined by the
encrypted wrapper's error containment.

### AAD (Additional Authenticated Data)

When encrypting workspace values, the entry key is bound as AAD to prevent ciphertext transplant attacks (moving an encrypted value from one key to another).

Authenticate every piece of metadata that changes plaintext interpretation. If ciphertext can cross workspace, table, row, or entry boundaries, bind those identifiers as AAD too.

## Version Boundaries

Keep these concepts separate:

- Blob format version: binary layout and algorithm.
- Key version: which secret encrypted a blob.
- Protocol or serialization version: how plaintext is interpreted before encryption.

Do not use one version number to stand in for another.

## Test Vectors And Operational Gates

- Add fixed test vectors for HKDF labels, blob packing, version-byte parsing, AAD mismatch, tampering, unknown key version, and old-key decrypt.
- Define server visibility plainly: what the server can decrypt, what it only stores, and what metadata remains visible.
- Bulk or account-level rotation should validate the encrypted object set before committing the rotation.
- Keep auth secrets, encryption secrets, recovery flows, and session invalidation separate. Rotating or invalidating one should not silently imply another.
