# Encrypted Workspace Storage

**Date**: 2026-02-13
**Status**: Archived: every major decision in this spec has been superseded by later specs (see redirects below)
**Supersedes**: `20260213T030000-encrypted-api-key-vault.md` (original was overengineered; see Analysis section)

## Where to look instead

This spec was the starting point for encrypted workspace storage. Every significant design decision evolved through subsequent specs. Here's what replaced what:

| This spec's topic | Current spec | What changed |
|---|---|---|
| Encryption library (Web Crypto async) | `20260312T120000-y-keyvalue-lww-encrypted.md` | Switched to `@noble/ciphers` XChaCha20-Poly1305 (synchronous) to preserve `set() → void` API |
| Blob format (`{ v: 1, alg, iv, ct }`) | `20260314T230000-bare-uint8array-encrypted-blob.md` | Bare `Uint8Array` with binary header: `[formatVersion][keyVersion][24-byte nonce][ciphertext+tag]` |
| Key derivation (deployment-wide SHA-256) | `20260314T070000-per-user-workspace-hkdf-key-derivation.md` | Two-level HKDF: server derives per-user key, client derives per-workspace key |
| Key source (`BETTER_AUTH_SECRET`) | `20260314T070000-per-user-workspace-hkdf-key-derivation.md` | `ENCRYPTION_SECRETS` env var with versioned keyring for rotation support |
| API key encryption | `20260223T102844-remove-key-store-simplify-api-key-resolution.md` | API key storage removed entirely. Keys come from env vars or per-request headers |
| Encryption mode system | `20260314T063000-encryption-wrapper-hardening.md` | Mode state machine, error containment, key transition |

The overall concept is still the architecture: value-level encryption where the CRDT structure remains mergeable but values are opaque ciphertext. The implementation details below are all stale.

---

## Historical notes (preserved for context)

> **Note (2026-02-22)**: The API key encryption portions of this spec were superseded by `20260222T195800-server-side-api-key-management.md`, which itself has been superseded by `20260223T102844-remove-key-store-simplify-api-key-resolution.md`. Server-side API key storage has been removed entirely: API keys now come from env vars (operator keys) or per-request headers (user BYOK). The broader value-level workspace encryption described here (for transcriptions, notes, chat histories) remains valid and is a separate concern from API key storage.

> **Note (2026-03-12)**: The implementation uses `@noble/ciphers` (synchronous AES-256-GCM) instead of Web Crypto API as originally planned. Synchronous encryption preserves the `set()` → `void` API across 394 call sites. See `specs/20260312T120000-y-keyvalue-lww-encrypted.md` for the final implementation spec. The encrypted blob format is now `{ v: 1, ct }` where `ct = base64(nonce(12) || ciphertext || tag(16))`.

> **Note (2026-03-13)**: The `alg` and `iv` fields were later removed from `EncryptedBlob`. The blob format is now `{ v: 1, ct }`: the version field is the sole contract for algorithm and encoding. The `ct` field contains `base64(nonce(12) || ciphertext || tag(16))`. See `specs/20260313T202000-encrypted-blob-pack-nonce.md`.
> **Note (2026-03-14)**: The key derivation approach has evolved from deployment-wide `SHA-256(BETTER_AUTH_SECRET)` to per-user-per-workspace HKDF derivation with a separate `WORKSPACE_KEY_SECRET`. Blast radius reduced from "all users, all apps" to "one user, one app." Full envelope encryption deferred. See `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`.
> **Note (2026-03-14)**: The `{ v: 1, ct }` object wrapper has been replaced with a bare `Uint8Array` with self-describing binary header. See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.
## Overview

Optional value-level encryption for all workspace data stored in Yjs. When enabled, every value written to tables and KV is encrypted with AES-256-GCM before entering the Y.Doc. The CRDT structure remains intact (Y-Sweet can still merge), but the content is opaque.

Encryption is not just for API keys. Transcriptions, notes, chat histories, and settings are arguably more sensitive than replaceable API keys. If we're going to encrypt one thing, we should encrypt everything.

## How It Works (Plain English)

You get an encryption key one of three ways depending on your setup:

1. **Epicenter Cloud**: The server derives an AES-256 key from `BETTER_AUTH_SECRET` via SHA-256. One key for all users. Sent to the client over TLS on login. Done. You never think about it.
2. **Self-hosted / Local (opt-in)**: You set an encryption password in settings. Your browser derives a key from it using PBKDF2 (intentionally slow to resist brute-force). This only happens once per session.
3. **Self-hosted / Local (default)**: No encryption. Your device, your server, your data. OS-level disk encryption (FileVault, BitLocker, LUKS) and network-level encryption (Tailscale/WireGuard/TLS) are the right layers for this.

Once you have a key, every value is encrypted before it enters Yjs and decrypted when it comes out. The encryption layer sits between your application code and the Yjs document. Extensions (SQLite, markdown) see plaintext because they read through the same decrypt path.

## Architecture

### Encryption Layer Position

The encryption layer wraps table and KV operations. It sits between application code and the Y.Doc:

```
APPLICATION CODE
       │
       ▼
┌──────────────────────────────────┐
│      Encrypted Storage Layer      │
│                                   │
│  write(key, value):               │
│    if (encryptionKey) {           │
│      value = aesGcmEncrypt(value) │
│    }                              │
│    kv.set(key, value)             │
│                                   │
│  read(key):                       │
│    value = kv.get(key)            │
│    if (encryptionKey) {           │
│      value = aesGcmDecrypt(value) │
│    }                              │
│    return value                   │
│                                   │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│         Y.Doc (CRDT)              │
│                                   │
│  Y.Array('table:posts')          │
│    { key: id, val: 'encrypted    │
│      blob or plaintext', ts }    │
│                                   │
│  Y.Array('kv')                   │
│    { key: 'apiKey:openai',       │
│      val: 'encrypted blob', ts } │
│                                   │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│     Y-Sweet / Persistence         │
│                                   │
│  Sees CRDT structure (keys, ts)  │
│  Cannot read values (encrypted)  │
│  Can still merge (LWW on blobs)  │
└──────────────────────────────────┘
```

### What Y-Sweet Sees

With encryption enabled, Y-Sweet sees key names and timestamps but not values:

```
// Y-Sweet can see:
{ key: 'apiKey:openai',     val: { v: 1, ct: 'aGVsbG8...' }, ts: 1706200000 }
{ key: 'apiKey:anthropic',  val: { v: 1, ct: 'dG9rZW4...' }, ts: 1706200001 }

// Table row:
{ key: 'post:abc',          val: { v: 1, ct: 'ZW5jcnl...' }, ts: 1706200002 }

// Y-Sweet can still:
// - Merge concurrent updates (LWW on the whole { v: 1, ct } blob)
// - Sync between devices (CRDT protocol is unaffected)
// - Garbage collect old entries
//
// Y-Sweet cannot:
// - Read the actual API key, post content, or any value
```

// Y-Sweet can still:
// - Merge concurrent updates (LWW on the whole { v: 1, ct } blob)
// - Sync between devices (CRDT protocol is unaffected)
// - Garbage collect old entries
//
// Y-Sweet cannot:
// - Read the actual API key, post content, or any value
```

### Key Source by Sync Mode

```
┌─────────────────────────────────────────────────────────────┐
│                    ENCRYPTION KEY SOURCE                      │
│                                                               │
│  EPICENTER CLOUD                                             │
│  ────────────────                                            │
│  Login via Better Auth                                       │
│    → Server derives AES-256 key from BETTER_AUTH_SECRET      │
│      (SHA-256 hash of the secret → raw 256-bit key)          │
│    → Same key for all users (single server secret)           │
│    → Sent to client over TLS on authentication               │
│    → Client holds key in memory for session                  │
│                                                               │
│  Password change: No-op for encryption (key is server-side)  │
│  Forgot password: No-op for encryption (key is server-side)  │
│  New device: Login → derive key → decrypt synced data        │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  SELF-HOSTED (opt-in encryption)                             │
│  ───────────────────────────────                             │
│  User sets encryption password in app settings               │
│    → Password + PBKDF2 (600k iterations) → AES-256 key      │
│    → Key held in memory for session                          │
│    → Salt stored locally (per-device)                        │
│                                                               │
│  Password change: Re-encrypt all values (~50ms for 1000)     │
│  Forgot password: Re-enter API keys from provider dashboards │
│  New device: Enter same password on new device               │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  LOCAL (opt-in encryption)                                   │
│  ─────────────────────────                                   │
│  Same as self-hosted opt-in                                  │
│  Most users won't enable this (OS disk encryption suffices)  │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  LOCAL / SELF-HOSTED (default)                               │
│  ─────────────────────────────                               │
│  No encryption. Values stored as plaintext in Yjs.           │
│  Protected by OS-level disk encryption + network encryption. │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Cross-Device Sync (Cloud Mode)

```
DEVICE A (Origin)                 SERVER                          DEVICE B (New)
─────────────────                 ──────                          ──────────────

1. Login                          derive key from
2. Receive key ◄──────────────── BETTER_AUTH_SECRET (SHA-256)
3. Encrypt values
4. Store in KV ──────────────▶  [ Durable Object: encrypted blobs ]

                                  derive key from
                                  BETTER_AUTH_SECRET ──────────▶ 5. Login
                                                                6. Receive key
                                 [ DO sync ] ────────────────▶ 7. Sync encrypted KV
                                                                8. Decrypt values
```

## Performance

AES-GCM is hardware-accelerated on modern CPUs (AES-NI). The overhead is negligible:

| Operation                             | Data Size  | Time              | Impact                     |
| ------------------------------------- | ---------- | ----------------- | -------------------------- |
| Encrypt 1 value                       | ~100 bytes | ~0.01ms           | Imperceptible              |
| Encrypt 1 table row                   | ~1-10 KB   | ~0.01-0.05ms      | Imperceptible              |
| Encrypt 100 values on bulk load       | ~100 KB    | ~1-5ms            | Imperceptible              |
| Encrypt 1,000 values on full sync     | ~1 MB      | ~10-50ms          | Barely noticeable          |
| PBKDF2 key derivation (once at login) | N/A        | ~500-1000ms       | One-time cost              |
| SQLite materialization with decrypt   | 1,000 rows | ~10-50ms overhead | Negligible vs rebuild cost |

The only perceptible cost is PBKDF2 key derivation, which happens once per session (self-hosted/local opt-in only). Cloud users never experience this.

## Data Flow Through Extensions

The critical insight: extensions like SQLite read through the same table/KV helpers. If those helpers decrypt transparently, extensions get plaintext without any changes:

```
Yjs (encrypted values)
       │
       ▼ table.observe() fires
       │
       ▼ table.get(id) → decrypt → plaintext row
       │
       ▼ SQLite extension inserts plaintext into local .db
       │
       ▼ Drizzle queries work on plaintext SQLite
```

SQLite is a local materialized view on the user's device. Storing plaintext in the local SQLite is correct because:

- SQLite is never synced (it's rebuilt from Yjs on each device)
- The user's device is trusted (same as OS filesystem)
- Queries need plaintext to work (you can't WHERE on ciphertext)

The same applies to markdown extension, revision history snapshots, and any future extensions.

## Design Decisions

| Decision                     | Choice                                | Rationale                                                                                                                  |
| ---------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Encryption scope             | All values, not just API keys         | Uniform security model. Transcriptions and notes are more sensitive than replaceable API keys. Marginal cost is near zero. |
| Encryption layer             | Value-level (inside CRDT)             | Y-Sweet can still merge. Structure visible, content opaque. No sync protocol changes.                                      |
| No KEK / Master Key wrapping | Direct key usage                      | KEK exists to make password changes cheap. Re-encrypting 1000 values takes ~50ms. Not worth the complexity for our scale.  |
| Cloud key source             | Derived from `BETTER_AUTH_SECRET`     | One key for all users. No per-user key storage. No key generation on signup. No key delivery logic. Same security as per-user keys when keys live in the same DB. |
| Self-hosted encryption       | Opt-in via password                   | Most self-hosted users are on Tailscale. Don't add friction for the common case.                                           |
| Local encryption             | Opt-in via password                   | OS disk encryption is the right layer. App-level encryption is a nice-to-have.                                             |
| Algorithm                    | AES-256-GCM via ~~Web Crypto API~~ `@noble/ciphers` | Originally planned for Web Crypto; switched to @noble/ciphers for synchronous API. Cure53-audited, zero deps, 11KB gzipped. |
| Key derivation               | PBKDF2, 600k iterations, SHA-256      | PBKDF2 via Web Crypto API (async, runs once at session start). 600k is OWASP 2024+ recommendation.                         |
| IV management                | Random 12-byte IV per encryption      | Stored alongside ciphertext. Never reused. Standard AES-GCM practice.                                                      |
| Encrypted value format       | `{ v: 1, ct: string }` | Compatible with KV LWW and table value storage. `ct` contains `base64(nonce(12) || ciphertext || tag(16))`. Safe for JSON serialization. |

## What Was Eliminated (vs Original Spec)

The original spec (`20260213T030000-encrypted-api-key-vault.md`) used a 3-layer encryption hierarchy (Password → KEK → Master Key → Encrypted Values). This simplified spec eliminates:

| Eliminated                                                                     | Why                                                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| KEK (Key Encryption Key) layer                                                 | Only purpose was cheap password changes. Re-encrypting 1000 values is ~50ms. Not worth the complexity.    |
| Master Key generation                                                          | No master key needed. The encryption key IS the key.                                                      |
| Wrap/unwrap operations                                                         | No wrapping layer.                                                                                        |
| `wrappedMasterKey`, `masterKeySalt`, `masterKeyIv`, `keyVersion` on user table | Cloud mode: key derived from existing env var. Self-hosted: salt stored locally.                           |
| Password interception at login (Open Question #2)                              | Cloud: password has nothing to do with encryption. Self-hosted: separate encryption password in settings. |
| Password change re-wrap flow                                                   | Cloud: no-op. Self-hosted: re-encrypt all (~50ms).                                                        |
| "Forgot password = permanent loss" footgun                                     | Cloud: key on server, just reset password. Self-hosted: API keys are replaceable.                         |
| Zero-knowledge requirement for all modes                                       | Only self-hosted opt-in provides zero-knowledge. Cloud trusts the server (users already trust the relay). |

**Complexity reduction**: ~60-70% of the original spec's crypto work is eliminated.

## Implementation Plan

### Phase 1: Crypto Module

~~Pure Web Crypto API functions.~~ Implemented with `@noble/ciphers` (synchronous). PBKDF2 key derivation remains async via Web Crypto. No Yjs or framework dependencies.

- [ ] `encryptValue(plaintext, key)` → `{ v: 1, ct: string }`
- [ ] `decryptValue({ v: 1, ct }, key)` → plaintext string
- [ ] Tests: round-trip encrypt/decrypt, same secret = same key, same password + salt = same key, unique IV per encryption

### Phase 2: Encrypted Storage Layer

A wrapper that intercepts table and KV operations to encrypt/decrypt transparently.

- [ ] `createEncryptedTables(tables, encryptionKey?)`: wraps table helpers with encrypt-on-write, decrypt-on-read
- [ ] `createEncryptedKv(kv, encryptionKey?)`: wraps KV helpers with encrypt-on-write, decrypt-on-read
- [ ] When `encryptionKey` is `undefined`, pass through without encryption (the default/no-encryption case)
- [ ] Ensure `table.observe()` callbacks still work (observers fire on the encrypted Y.Doc, extensions read through the decrypt wrapper)
- [ ] Tests: write encrypted → read decrypted, no-key passthrough, observer fires correctly

### Phase 3: Key Source Integration

Where the encryption key comes from, per sync mode.

- [ ] **Cloud**: Derive AES-256 key from `BETTER_AUTH_SECRET` via SHA-256 at server startup. Include derived key in auth session response so client receives it on login.
- [ ] **Self-hosted / Local opt-in**: Settings UI for encryption password. Derive key via PBKDF2. Store salt in app settings (local only, not synced).
- [ ] **Self-hosted / Local default**: No encryption. No key. Passthrough mode.
- [ ] Hold derived/received key in memory for the session duration. Clear on logout/close.

### Phase 4: Workspace Integration

Wire the encryption layer into the workspace creation flow.

- [ ] `createWorkspace(definition).withEncryption(key?)` or pass encryption key via extension context
- [ ] Extensions (SQLite, markdown, persistence) continue to work unchanged: they read through the encrypted table/KV wrappers
- [ ] Migration path for existing unencrypted data: on first encryption setup, read all plaintext values and re-write as encrypted

### Phase 5: UI

- [ ] API Keys settings page: list, add, edit, delete (reads/writes through encrypted KV)
- [ ] Encryption status indicator in settings
- [ ] Self-hosted: encryption password setup/entry
- [ ] Cloud: automatic, no UI needed beyond showing "encrypted" badge

## Edge Cases

### Self-hosted: Password change

Derive new key from new password. Read all values with old key, re-encrypt with new key, write back. For 1000 values this takes ~50ms. No separate wrapping layer needed.

### Self-hosted: Forgot encryption password

API keys are replaceable (regenerate from provider dashboards in seconds). Other data (transcriptions, notes) is in the local Yjs persistence. If the user has the `.yjs` file, the data is there in the CRDT. The encryption only affects the synced representation. Local persistence can optionally store unencrypted.

### Cloud: Forgot login password

No impact on encryption. The encryption key is derived from `BETTER_AUTH_SECRET`, not from the user's password. Password reset via Better Auth recovers account access; encryption continues to work because the server secret hasn't changed.

### Browser data cleared

No impact. Cloud: log in again, server derives key from `BETTER_AUTH_SECRET`, Durable Objects re-sync encrypted data, decrypt. Self-hosted: enter encryption password again, derive key, local persistence reloads.

### Mixed encrypted/unencrypted devices

If Device A has encryption enabled and Device B doesn't, Device B will see encrypted blobs as raw `{ v: 1, ct }` objects instead of plaintext values. The application should detect this (check if value has `v` and `ct` fields) and prompt for the encryption key.

### Concurrent updates

Two devices encrypt the same key simultaneously with different values. LWW resolves by timestamp. The higher `ts` wins. Both devices converge on the same ciphertext. The "loser" is overwritten. No corruption because the entire `{ v: 1, ct }` blob is replaced atomically.

### Migration: Existing unencrypted data

On first encryption setup, the application reads all existing plaintext values, encrypts them, and writes them back. This is a one-time migration. For 1000 values, ~50ms.

## Open Questions

1. ~~**Key storage for cloud mode**~~: Resolved. Key derived from `BETTER_AUTH_SECRET`. No per-user storage needed.

2. **Selective encryption**: Should users be able to choose which workspaces are encrypted? Or all-or-nothing?
   - Recommendation: All-or-nothing per sync mode. Cloud = always encrypted. Self-hosted = user chooses once. Reduces configuration surface.

3. ~~**Key rotation**~~: Resolved. Key rotates when `BETTER_AUTH_SECRET` rotates. Re-encryption of all data required on rotation, but this is a rare admin-level operation. No `keyVersion` field needed.

## Self-Hosted Deployment Context

For context on why self-hosted encryption is opt-in rather than required:

**Typical self-hosted setup (lowest friction)**:

- Y-Sweet server running on home machine or VPS
- Accessible via Tailscale (WireGuard-encrypted mesh VPN, zero config)
- Only user's devices can reach the server
- Data in transit: encrypted by WireGuard
- Data at rest: protected by OS disk encryption on the server

**Other self-hosted options**:

- Cloudflare Tunnel (public URL with access policies, zero ports opened)
- Direct reverse proxy (nginx/Caddy with TLS + Y-Sweet token auth)
- ZeroTier, Headscale, plain WireGuard

In all these cases, the user controls the server. Client-side encryption protects against server compromise, but for someone running Y-Sweet on their Tailscale network, server compromise risk is near zero. Hence: opt-in.

## Success Criteria

- [ ] Value encrypted with AES-GCM, stored in Yjs, syncs to second device, decrypts correctly
- [ ] Y-Sweet inspection shows only ciphertext (no plaintext values anywhere in the CRDT)
- [ ] SQLite extension materializes decrypted plaintext correctly
- [ ] Cloud mode: login on new device recovers all data via key derived from `BETTER_AUTH_SECRET`
- [ ] Self-hosted opt-in: same password on two devices yields same key and can decrypt each other's data
- [ ] No encryption mode: everything works exactly as it does today (zero overhead)
- [ ] Encryption overhead: < 50ms for 1000 values on bulk operations

## References

- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Workspace creation, extension wiring
- `packages/epicenter/src/dynamic/tables/create-tables.ts`: Table helper creation
- `packages/epicenter/src/dynamic/kv/create-kv.ts`: KV helper creation
- `packages/epicenter/src/extensions/sqlite/sqlite.ts`: SQLite materialization (reads through table helpers)
- `packages/epicenter/src/static/define-kv.ts`: KV schema definition
- `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts`: LWW KV store
- `specs/20260121T170000-sync-architecture.md`: Sync modes (local, self-hosted, cloud)
- `specs/20260213T030000-encrypted-api-key-vault.md`: Original spec (superseded)

## Analysis: Why the Original Spec Was Overengineered

The original spec used a 3-layer encryption hierarchy (Password → KEK → Master Key → Encrypted Values) borrowed from enterprise key management systems (Google Cloud KMS, 1Password). This pattern exists to solve three problems:

1. **Cheap password changes** (re-wrap one master key, not re-encrypt all data)
2. **Multiple authentication methods** (biometric, hardware key each wrap the same master key)
3. **Key rotation without re-encryption** (rotate master key, re-wrap with KEK)

None of these apply to Epicenter at current scale:

- Password changes: re-encrypting 1000 values takes ~50ms. No optimization needed.
- Multiple auth methods: not planned.
- Key rotation: deferred. Can be added later without changing the encryption layer.

The KEK layer was ~60-70% of the original spec's complexity (PBKDF2 derivation, wrap/unwrap operations, password interception at login, salt management, additional database fields). Removing it cuts implementation time roughly in half while maintaining the same security properties for the actual threat model.

Additionally, requiring zero-knowledge encryption for all deployment modes was unnecessary. Cloud users already trust the Epicenter relay (stated in the sync architecture spec). Self-hosted users own their server. Gating encryption behind login for cloud (server-held key) eliminates the hardest UX problems: password interception, forgot-password-loses-everything, and password change flows.
