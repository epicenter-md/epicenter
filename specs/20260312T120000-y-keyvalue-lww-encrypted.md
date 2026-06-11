# YKeyValueLww Encrypted

**Date**: 2026-03-12
**Status**: Draft (Updated 2026-03-12: key option, decrypted map, all open questions resolved)
**Builds on**: `specs/20260213T005300-encrypted-workspace-storage.md`

> **Note (2026-03-13)**: The `alg` and `iv` fields were later removed from `EncryptedBlob`. The blob format is now `{ v: 1, ct }`: the version field is the sole contract for algorithm and encoding. The `ct` field contains `base64(nonce(12) || ciphertext || tag(16))`. See `specs/20260313T202000-encrypted-blob-pack-nonce.md`.
> **Note (2026-03-14)**: The `{ v: 1, ct }` object wrapper has been replaced with a bare `Uint8Array` with self-describing binary header. See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.

## Overview

An encrypted variant of `YKeyValueLww` that transparently encrypts values before they enter the Y.Doc and decrypts on read. Encryption at the CRDT data structure level. The lowest possible insertion point. So no higher layer can accidentally bypass it.

## Motivation

### Current State

`YKeyValueLww<T>` stores entries as `{ key: string; val: T; ts: number }` in a Y.Array. Values are plaintext at every layer: in memory, in the Y.Doc binary, in WebSocket sync, in Durable Object SQLite, and in IndexedDB.

```typescript
// Today: plaintext everywhere
const kv = new YKeyValueLww<TabData>(yarray);
kv.set('tab-1', { url: 'https://bank.com', title: 'My Bank Account' });
// Y.Doc contains: { key: 'tab-1', val: { url: 'https://bank.com', ... }, ts: 1706200000 }
// Durable Object SQLite: plaintext
// IndexedDB: plaintext
```

This creates problems:

1. **Storage-layer exposure**: A Postgres backup, Cloudflare DO dump, or IndexedDB export reveals all user data in plaintext.
2. **No defense in depth**: TLS protects transit, Cloudflare encrypts disks, but no application-controlled encryption exists.
3. **Compliance gap**: Enterprise customers expect encryption at rest as a baseline.

### Desired State

```typescript
// Encrypted at the data structure level
const kv = createEncryptedKvLww<TabData>(yarray, { key: encryptionKey });
kv.set('tab-1', { url: 'https://bank.com', title: 'My Bank Account' });
// Y.Doc contains: { key: 'tab-1', val: { v: 1, ct: '...' }, ts: 1706200000 }
// Every layer below sees ciphertext. Same API surface as YKeyValueLww.
```

## Strategic Decision: Client-Side CRDT Encryption

Three options were evaluated:

**Option A: Server-side at-rest only.** The Durable Object encrypts when persisting to SQLite. The client Y.Doc and IndexedDB stay plaintext. Simplest. No loading gates, no key management. But IndexedDB is fully readable by any browser extension, any XSS attack, any forensic tool. Cloudflare already encrypts disks, so this adds minimal real security. And anyone with access to the DO runtime (Cloudflare employee, security breach, law enforcement request) sees plaintext values in the Y.Doc.

**Option B: Client-side CRDT encryption (this spec).** Values encrypted before entering the Y.Doc. Everything downstream. IndexedDB, WebSocket sync, DO storage. Automatically gets ciphertext. One wrapper, one code path. The key source is the only variable between cloud and self-hosted.

**Option C: Hybrid.** Server-side for cloud, client-side for self-hosted. Two encryption strategies, two code paths. Every data feature asks "which mode am I in?" Double the test surface for marginal UX gain in cloud mode.

**Decision: Option B.** One code path. One primitive (`createEncryptedKvLww`). The key source is the only variable:

| Mode | Key source | Server can decrypt? |
|---|---|---|
| Epicenter Cloud | Server derives from `BETTER_AUTH_SECRET`, sends on auth | Yes (stated in README. Server is trusted) |
| Self-hosted (opt-in) | User password → PBKDF2 → key | No (real E2E zero-knowledge) |
| Local / no encryption | No key → passthrough | N/A (plaintext, OS disk encryption suffices) |

**Why not server-side only?** Client-side CRDT encryption costs ~100 lines of wrapper code and adds ~1ms per 1000 values. The self-hosted E2E story falls out for free. Same code, different key source. Server-side only saves no meaningful complexity while losing the security narrative that matters: "Self-hosted is real zero-knowledge. The server never sees your key."

**What Cloudflare disk encryption doesn't cover:** Cloudflare encrypts hard drives. But anyone with access to the Durable Object runtime sees the Y.Doc in plaintext. Values are right there in the SQLite rows. With CRDT-level encryption, that same person sees noise. They can see key names (`tab-1`, `theme`) and timestamps, but not the values. They'd need `BETTER_AUTH_SECRET` to decrypt.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Composition wrapper around `YKeyValueLww` | Zero changes to the existing LWW class. Yjs `ContentAny` stores objects by reference-`YKeyValueLww` relies on `indexOf()` (strict `===`) for conflict resolution. A fork that decrypts into new objects breaks `indexOf` because the map entries are no longer the same JS objects as the yarray entries. Empirically verified with 8 experiments (see `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`). |
| Encrypted value format | `{ v: 1, ct: string }` | `v` for format versioning. `ct` contains `base64(nonce(12) || ciphertext || tag(16))` for JSON-safe Yjs ContentAny storage. |
| Algorithm shorthand | `'A256GCM'` (not `'AES-256-GCM'`) | JWE algorithm identifier. Compact, standardized, unambiguous. |
| No-key passthrough | When `key` is undefined, behave identically to plain `YKeyValueLww` | Zero overhead for unencrypted workspaces. Same code path, just no encryption. |
| Key parameter | `key?: Uint8Array` (plain value) | Seeded at creation time. The workspace is created eagerly as a module-level export before auth completes. After creation, `lock()` and `activateEncryption(key)` handle all key transitions. Encryption activates when a key is provided. |
| Encryption library | `@noble/ciphers` (pure JS, synchronous) | Preserves the synchronous `set()` API. Web Crypto is async-only, which would break 394 synchronous call sites across 23 files. Noble is audited (Cure53, Sep 2024), zero dependencies, 11KB gzipped, works in Cloudflare Workers and browser extensions. |
| Serialization | `JSON.stringify` before encryption, `JSON.parse` after decryption | Values are already JSON-serializable (they're stored in Yjs ContentAny). Round-trip fidelity is guaranteed. |
| IV strategy | Random 12-byte IV per encryption via `randomBytes(12)` from `@noble/ciphers/utils` | Wraps `crypto.getRandomValues`. No coordination needed between devices. Birthday bound (~2^48) is unreachable at workspace scale. |
| Mixed-mode detection | Check for `v`/`ct` fields on read | Enables migration from plaintext to encrypted. If a value doesn't have the encrypted shape, return it as-is (plaintext). |
| Decrypted `.map` | Wrapper maintains its own `Map<string, YKeyValueLwwEntry<T>>` with plaintext values | `table-helper.ts` reads `ykv.map` directly for `getAll()`, `filter()`, `find()`, `count()`, `clear()`. If the wrapper exposed the inner map, table helpers would see encrypted blobs. The wrapper's own `.map` is kept in sync via `inner.observe()`. Zero changes to table helper. |
| No `entries()` cache | Decrypt on every `entries()` call, no cached result set | ~5ms for 1000 decrypts. Caching would need invalidation logic tied to the observer and doubles memory. Not worth the complexity at workspace scale. |
| Base64 encoding | `ct` and `iv` stored as base64 strings, not raw `Uint8Array` | Yjs ContentAny JSON-serializes object properties. A `Uint8Array` in an object property would serialize to `{"0":1,"1":2,...}` instead of compact binary. Base64 adds ~33% overhead but guarantees correct round-trip through Yjs's internal serialization. |
| No `kid` field (deferred) | No key identifier in `EncryptedBlob` v1 | Key rotation is a future concern. When needed, bump blob format to `v: 2` and add `kid`. For now, one key per workspace, derived deterministically from server secret (cloud) or user password (self-hosted). |
| Self-hosted salt derivation | `SHA-256(userId + workspaceId)`: deterministic, no storage | Salt syncs implicitly because both inputs are already known. No need to store/distribute salts separately. Unique per user×workspace pair. |
| Abstraction level | Encrypt at YKeyValueLww level, plumbed through createKv/createTables/createWorkspace | Lowest possible insertion point. Every layer above gets encryption for free. Tables are KV stores with schema validation on top. Encrypt at KV, tables inherit. |
| Migration safety | Eager on sign-in, single Y.Doc transaction, ~50ms for 1000 entries | Interruption-safe: if migration is interrupted, unencrypted entries remain plaintext and will be encrypted on next sign-in (mixed-mode detection handles this). Concurrent devices: each device migrates independently. LWW ensures the latest encrypted write wins. |

## Architecture

### Composition Pattern

```
APPLICATION CODE (tables, KV, app layer)
       │
       ├── kv.set('theme', { mode: 'dark' })
       ├── kv.get('theme')
       ├── table.getAll()  →  reads wrapper.map  →  plaintext ✓
       │
┌──────────────────────────────────────────────────────────────┐
│  createEncryptedKvLww<T>(yarray, { key })                 │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  wrapper.map: Map<string, YKeyValueLwwEntry<T>>         │ │
│  │  ← DECRYPTED in-memory index (plaintext values)         │ │
│  │  ← Sole writer: inner.observe() handler                 │ │
│  │  ← table-helper reads THIS map directly                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  set(key, val):                                              │
│    key = options.key  // seeded at creation, or via lock()/activateEncryption()
│    if (!key) → inner.set(key, val)  ← passthrough           │
│    plaintext = JSON.stringify(val)                           │
│    { ct } = encrypt(plaintext, key)                     │
│    inner.set(key, { v: 1, ct })                        │
│                                                              │
│  get(key):                                                   │
│    entry = wrapper.map.get(key) ?? pending.get(key)          │
│    return entry?.val  ← already decrypted                    │
│                                                              │
│  observe(handler):                                           │
│    inner.observe((changes) =>                                │
│      for each change:                                        │
│        decrypt value → wrapper.map.set(key, decrypted)       │
│        forward decrypted change to handler)                  │
│                                                              │
└───────────────────┬──────────────────────────────────────────┘
                    │  inner = new YKeyValueLww<EncryptedBlob>(yarray)
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  YKeyValueLww<EncryptedBlob>  (UNCHANGED)                    │
│                                                              │
│  inner.map: Map<string, YKeyValueLwwEntry<EncryptedBlob>>    │
│  ← ENCRYPTED values (ciphertext)                            │
│  ← Only inner's own observer writes here                    │
│                                                              │
│  All existing logic: LWW timestamps, pending/map,           │
│  conflict resolution, monotonic clock. Sees EncryptedBlob   │
│  as just another value type. No modifications whatsoever.    │
└───────────────────┬──────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  Y.Array<YKeyValueLwwEntry<EncryptedBlob>>                   │
│                                                              │
│  Y.Doc binary → WebSocket → Durable Object SQLite           │
│  All ciphertext from this point down.                        │
└──────────────────────────────────────────────────────────────┘
```

### Why the Wrapper Needs Its Own `.map`

`table-helper.ts` methods (`getAll()`, `getAllValid()`, `filter()`, `find()`, `clear()`, `count()`) iterate `ykv.map` directly. They don't call `get()` per entry:

```typescript
// From table-helper.ts: reads ykv.map directly
getAll(): RowResult<TRow>[] {
  const results: RowResult<TRow>[] = [];
  for (const [key, entry] of ykv.map) {
    const result = parseRow(key, entry.val);  // ← entry.val must be plaintext
    results.push(result);
  }
  return results;
}
```

If the encrypted wrapper only overrode `get()`/`set()` but exposed the inner `YKeyValueLww`'s map, table helpers would see `EncryptedBlob` objects where they expect row data. Schema validation would fail on every entry.

The fix: the wrapper maintains its own decrypted `.map`. This follows the same "observer is sole writer to map" pattern that `YKeyValueLww` itself uses:

```
Data flow for wrapper.map:

  inner.observe fires (encrypted entry changed)
    │
    ├── isEncryptedBlob(entry.val)?
    │     ├── YES: decrypt → wrapper.map.set(key, { ...entry, val: decrypted })
    │     └── NO:  passthrough → wrapper.map.set(key, entry)  (plaintext)
    │
    └── action === 'delete'?
          └── wrapper.map.delete(key)

Result: wrapper.map always contains plaintext. Table helper reads it. Zero changes.
```

### Encrypted Value Shape

```typescript
/**
 * Encrypted blob stored in the Y.Array.
 *
 * Field names are compact because these are persisted and synced
 * across devices in every Y.Doc update.
 */
type EncryptedBlob = {
  /** Format version. Increment when the blob structure changes. */
  v: 1;
  /** Base64-encoded packed format: nonce(12) || ciphertext || tag(16). */
  ct: string;
};
```

### Storage Overhead Per Value

```
Fixed overhead:  ~86 bytes  (v + alg + iv + auth tag + JSON structure)
Variable overhead: +33%     (base64 encoding of ciphertext)

Example: 500-byte tab entry
  Plaintext:  500 bytes
  Encrypted:  ~750 bytes (+50%)

For a full workspace (500 tabs + 1000 KV entries + 1000 chat messages):
  Plaintext:  ~600 KB
  Encrypted:  ~940 KB (+340 KB)
```

## API Surface

```typescript
/**
 * Create an encrypted LWW key-value store.
 *
 * Returns the same API surface as YKeyValueLww<T>. When `key` is provided,
 * values are transparently encrypted/decrypted. When `key` is undefined,
 * behaves identically to a plain YKeyValueLww<T> (zero overhead passthrough).
 *
 * The `key` option is seeded at creation time. The workspace is created eagerly as a module-level export before auth completes.
 * The workspace is created eagerly as a module-level export before auth completes.
 * After creation, `lock()` and `activateEncryption(key)` handle all key transitions. Encryption activates when a key is provided.
 * so encryption activates the moment a key becomes available.
 */
function createEncryptedKvLww<T>(
  yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>,
  options?: { key?: Uint8Array },
): EncryptedKvLww<T>;

type EncryptedKvLww<T> = {
  // Same API as YKeyValueLww<T>
  set(key: string, val: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  delete(key: string): void;
  entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;
  observe(handler: YKeyValueLwwChangeHandler<T>): void;
  unobserve(handler: YKeyValueLwwChangeHandler<T>): void;

  // Decrypted in-memory index (mirrors inner.map with plaintext values)
  readonly map: Map<string, YKeyValueLwwEntry<T>>;

  // Additional: read the underlying Y.Array (for debugging, not normal use)
  readonly yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>;
  readonly doc: Y.Doc;
};
```

## Key Delivery & UX Impact

### Key Delivery

The encryption key piggybacks on the existing auth flow. No extra requests, no extra roundtrips, no extra ceremony.

The app already calls Better Auth's `getSession` on load (the `authGuard` in `app.ts` does this). Today that returns `{ user, session }`. Add `encryptionKey` to that response. Same request, same roundtrip, one more field.

For cloud mode, the server derives the key from `BETTER_AUTH_SECRET` via SHA-256 at request time. No per-user key storage. No key generation on signup. No key rotation logic.

### UX Timeline

There is zero additional UX cost. The app already gates workspace access on authentication (`authGuard` middleware). The encryption key arrives at the same moment auth does.

```
Today (no encryption):
  App loads → auth check (50-200ms) → show workspace

With encryption:
  App loads → auth check (50-200ms, key included) → decrypt → show workspace
                                                     ↑
                                              adds ~1ms for 1000 values
```

The user sees the same loading screen for the same duration. Decryption overhead is negligible (~5µs per value on Apple M4).

### Key Caching (Offline & Restart)

| Scenario | Strategy |
|---|---|
| Tauri desktop, app restart | Cache key in OS keychain via Tauri. Read on launch, no network needed. |
| Browser, tab refresh | `sessionStorage`. Survives refresh, clears on tab close. |
| Browser, cold start (offline) | "Sign in to access your data." Can't sync anyway. Honest UX. |
| Self-hosted | Password prompt before workspace opens. |

Key caching means subsequent launches don't require network. Only the first login (or session expiry) hits the server for the key.

### Why the Loading Gate Is Not Always a Gate

When an encryption key exists, the app can't show workspace data until the key is available. This is not a regression. The app already requires auth for workspace access.

When no key exists (unauthenticated, first launch, local-only), passthrough mode kicks in. The user creates and edits data in plaintext. Encryption activates transparently when they sign in and the key arrives.

## Session & Data Lifecycle

The full lifecycle from first launch through logout and re-login. Encryption is opportunistic. It activates when a key exists and passes through when it doesn't. The user is never locked out of their own device.

### First Launch (No Account)

```
App opens → no auth, no key → passthrough mode → plaintext Y.Doc
User creates data → stored in IndexedDB as plaintext → works offline
```

No server contact. No encryption. Pure local-first.

### Sign Up / Sign In

```
User authenticates → server sends encryption key with session response
→ new writes encrypted → background migration re-encrypts plaintext entries (~50ms)
→ sync connects → encrypted Y.Doc synced to Durable Object
```

Key cached in OS keychain (Tauri) or `sessionStorage` (browser).

### Normal Use (Key Cached)

```
App opens → key from keychain → decrypt local IndexedDB → show workspace
→ sync connects when online → encrypt/decrypt all local, no server needed for crypto
```

Fully offline-capable. Encryption/decryption is local JavaScript (`@noble/ciphers`).

### Logout (Default: Disconnect)

```
Stop sync → clear session token → keep key in keychain → keep IndexedDB
→ user keeps editing locally with encryption encrypted
→ re-login resumes sync
```

This is the default because local-first means local-first. Linear, Notion, Obsidian, and Logseq all keep local data on logout. Daily-driver users don't expect data loss from a sign-out. "Logout" means "stop talking to the server," not "lock me out of my own data."

### Sign Out & Clear Data (Explicit Security Action)

```
Stop sync → clear session token → clear key from keychain → wipe IndexedDB via clearData()
→ clean slate, no local data remains
```

For shared devices, selling hardware, or security concerns. An explicit user action, never the default. Standard Notes and Signal use this pattern because their audience is security-first. For a daily-driver productivity tool, it's an option. Not the default.

### Re-Login After Full Clear

```
User authenticates → server sends encryption key
→ getDoc() pulls full Y.Doc from Durable Object
→ Y.applyUpdateV2 rehydrates local doc → IndexedDB repopulated
→ all data back, no loss
```

The Durable Object holds the canonical Y.Doc. Clearing IndexedDB and re-syncing is a clean pull. CRDT merge with an empty local doc produces the server's state exactly. No conflicts, no data loss. This is what CRDTs are designed for.

### Different User Logs In

```
New user authenticates → detect different user ID → wipe previous user's IndexedDB
→ pull new user's Y.Doc from their Durable Object → clean start
```

Mandatory wipe when the user ID changes. Previous user's encrypted data is useless without their key, but leaving stale data wastes storage and could cause merge corruption if Y.Doc GUIDs collide.

### Offline After Session Expiry

```
Session expires → key still cached in keychain → encrypt/decrypt locally → edit freely
→ can't sync until re-auth → re-login sends queued updates
```

Key caching decouples encryption from auth. The key persists in the OS keychain even after the session token expires. The user keeps working; sync resumes on re-auth.

## Crypto Module (Prerequisite)

Synchronous functions using `@noble/ciphers`. Async only for key derivation (PBKDF2).

```typescript
// packages/workspace/src/shared/crypto/index.ts

import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/utils';

/** Generate a random AES-256 key (32 bytes). */
function generateEncryptionKey(): Uint8Array;

/** Encrypt a string value. Synchronous. Returns base64-encoded ct and iv. */
function encryptValue(plaintext: string, key: Uint8Array): EncryptedBlob;

/** Decrypt an encrypted blob. Synchronous. Returns the original string. */
function decryptValue(blob: EncryptedBlob, key: Uint8Array): string;

/** Type guard: is this value an EncryptedBlob? */
function isEncryptedBlob(value: unknown): value is EncryptedBlob;

/** Derive key from password (self-hosted opt-in). Async: PBKDF2 via Web Crypto. */
function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<Uint8Array>;

/** Derive deterministic salt for self-hosted PBKDF2 (no storage needed). */
async function deriveSalt(userId: string, workspaceId: string): Promise<Uint8Array>;
```

### Implementation Notes

```typescript
// encryptValue internals:
function encryptValue(plaintext: string, key: Uint8Array): EncryptedBlob {
  const nonce = randomBytes(12);
  const data = new TextEncoder().encode(plaintext);
  const nonce = randomBytes(12);
  const ciphertext = gcm(key, nonce).encrypt(data);
  const tag = ciphertext.slice(-16); // GCM tag is last 16 bytes
  return {
    v: 1,
    ct: bytesToBase64(nonce.concat(ciphertext)), // nonce || ciphertext || tag
  };
}

// decryptValue internals:
function decryptValue(blob: EncryptedBlob, key: Uint8Array): string {
  const packed = base64ToBytes(blob.ct);
  const nonce = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plaintext = gcm(key, nonce).decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

// deriveKeyFromPassword uses Web Crypto (async, runs once at session start):
async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return new Uint8Array(bits);
}

// deriveSalt for self-hosted PBKDF2 (deterministic, no storage):
async function deriveSalt(userId: string, workspaceId: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(userId + workspaceId);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return new Uint8Array(hash).slice(0, 16); // 16 bytes
}
// Same userId + workspaceId always produces the same salt.
// No need to store/distribute salts: both inputs are already known on every device.
```

## Implementation Plan

### Phase 1: Crypto Module

Synchronous via `@noble/ciphers`. Zero Yjs dependency. Independently testable.

- [x] **1.1** `bun add @noble/ciphers` in `packages/workspace`
- [x] **1.2** Create `packages/workspace/src/shared/crypto/index.ts`
- [x] **1.3** Implement `generateEncryptionKey` (`randomBytes(32)` from noble)
- [x] **1.4** Implement `encryptValue`, `decryptValue` (synchronous, AES-256-GCM via `gcm` from `@noble/ciphers/aes`)
  > **Note**: Added 32-byte key length validation guard. `@noble/ciphers` `gcm()` accepts 16-byte keys (AES-128) which we don't want. Import paths use `.js` extension per `@noble/ciphers` v2.x exports map.
- [x] **1.5** Implement `isEncryptedBlob` type guard
- [x] **1.6** Implement `deriveKeyFromPassword` (async PBKDF2 via Web Crypto: only for self-hosted password mode)
- [x] **1.7** Implement `deriveSalt` (deterministic `SHA-256(userId + workspaceId)`: no random salt, syncs implicitly)
- [x] **1.8** Tests: round-trip, same password + salt = same key, unique IV per call, invalid key throws, tampered ciphertext throws, `deriveSalt` is deterministic (39 tests, all passing)

### Phase 2: `createEncryptedKvLww`

Composition wrapper. Zero changes to `YKeyValueLww`.

- [x] **2.1** Create `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`
- [x] **2.2** Implement `createEncryptedKvLww` factory function with `key` option
- [x] **2.3** `set()`: read `key` from options → if undefined, passthrough; else serialize → encrypt → delegate to inner
- [x] **2.4** `get()`: read from wrapper.map (decrypted) or pending → return plaintext
- [x] **2.5** Maintain decrypted `wrapper.map` via `inner.observe()`: decrypt each change, write to wrapper.map
- [x] **2.6** `entries()`: iterate wrapper.map (already decrypted), merge with pending
- [x] **2.7** `observe()`: wrap inner observer, decrypt change values before forwarding to registered handlers
- [x] **2.8** No-key passthrough: when `key` is undefined, all operations pass through without encryption
- [x] **2.9** Tests: 24 tests passing: encrypt round-trip, no-key passthrough, observer decryption, mixed plaintext/encrypted migration, wrapper.map always plaintext, two-device sync with same key, batch operations, mid-session key availability

### Phase 3: Wire into `createKv`

Replace the `YKeyValueLww` instantiation in `createKv` with `createEncryptedKvLww`.

- [x] **3.1** Add optional `key?: Uint8Array` parameter to `createKv`
- [x] **3.2** Pass through to `createEncryptedKvLww`
- [x] **3.3** Existing tests pass with no `key` (passthrough mode)

### Phase 4: Wire into `createWorkspace`

The workspace creation flow passes the encryption key down.

- [x] **4.1** Add `key` option to workspace options or extension context
- [x] **4.2** All table and KV helpers receive the `key` option
- [x] **4.3** Extensions (SQLite, persistence) continue to work. They read through the same helpers

## Edge Cases

### Mixed plaintext/encrypted data (migration)

1. User enables encryption on an existing workspace with 500 plaintext entries.
2. `get()` reads each entry. `isEncryptedBlob` returns false for plaintext values.
3. Plaintext values returned as-is. No decryption needed.
4. Migration script reads all plaintext entries and re-writes them encrypted.
5. After migration, all entries are encrypted. Old plaintext entries are overwritten by LWW.

### ~~Encryption key not yet available~~ (RESOLVED)

No longer a concern. The `key` option is seeded at creation time. After creation, `lock()` and `activateEncryption(key)` handle all key transitions. The wrapper calls these methods when the key changes:

1. **`key` is undefined (no key yet):** Passthrough mode. Values stored/read as plaintext. Zero overhead.
2. **`key` is provided:** Encrypted mode. Values encrypted on write, decrypted on read.
3. **Key becomes available mid-session:** Call `activateEncryption(key)` to transition. The wrapper re-decrypts all entries. Existing plaintext entries are read via `isEncryptedBlob` mixed-mode detection.

The workspace is created eagerly as a module-level export (`apps/tab-manager/src/lib/workspace.ts` line 572) before auth completes. The `key` option is seeded at creation time. After auth, `activateEncryption(key)` is called to activate encryption. No wrapper recreation needed.

### ~~Observer fires with encrypted data before key is set~~ (RESOLVED)

The wrapper maintains its own decrypted `.map` (see Architecture section). Observers registered on the wrapper always receive decrypted values. Two scenarios:

1. **`key` is undefined:** Inner map has plaintext. Wrapper's `.map` mirrors it as-is. Observers see plaintext.
2. **`key` is provided:** Inner map has encrypted blobs. Wrapper decrypts them into its own `.map`. Observers see plaintext.

If a key becomes available mid-session via `activateEncryption(key)`, existing plaintext entries in the inner map are detected via `isEncryptedBlob` and passed through. New writes are encrypted. The wrapper's `.map` always contains plaintext regardless.

### Different user logs in

When a different user authenticates on the same device, the app must wipe the previous user's IndexedDB before syncing the new user's data. This prevents stale encrypted data from the previous user interfering with the new user's workspace. Detection is simple: compare the authenticated user ID against the last-known user ID stored locally. If they differ, call `clearData()` on all workspace persistence providers before initializing.

Existing infrastructure: `clearData()` in `packages/workspace/src/extensions/sync/web.ts` handles the IndexedDB wipe. The auth state in `apps/tab-manager/src/lib/state/auth.svelte.ts` already tracks the current user.

### ~~Concurrent `set()` calls during encryption~~ (RESOLVED)

No longer an issue. `@noble/ciphers` `gcm().encrypt()` is synchronous: `set()` remains synchronous.
Two rapid `set('x', 1)` then `set('x', 2)` calls execute sequentially as they always have.

## Open Questions

1. ~~**Sync vs async API**~~: **RESOLVED.** Use `@noble/ciphers` for synchronous AES-256-GCM.
   - `gcm(key, nonce).encrypt(data)` returns `Uint8Array` synchronously
   - `set()` stays `void`, not `Promise<void>`. Zero call-site changes.
   - Audited by Cure53 (Sep 2024), zero dependencies, 11KB gzipped
   - Works in Cloudflare Workers, browser extensions, all browsers
   - Performance: ~5µs per 64-byte encrypt on Apple M4 (201K ops/sec), well within the <5ms/1000-ops target
   - Key type changes from `CryptoKey` to `Uint8Array` (32 bytes): simpler, no import/export ceremony
   - PBKDF2 key derivation (self-hosted) remains async via Web Crypto: runs once at session start, not in hot path

2. ~~**Class vs factory function**~~: **RESOLVED.** Factory function (`createEncryptedKvLww<T>()`). Matches `createKv`, `createTables`, and the rest of the codebase's preference for factory functions over classes.

3. ~~**Key mutability**: Can the encryption key change mid-session?~~ **RESOLVED.** Yes, via `lock()` and `activateEncryption(key)`. The key is seeded at creation time. After creation, `activateEncryption(newKey)` handles key arrival and `lock()` handles key removal. The key either goes from undefined→present (auth) or present→undefined (logout). Re-keying is a separate future concern.

4. ~~**Table encryption**~~: **RESOLVED.** Same `createEncryptedKvLww` wrapper. Tables are KV stores with schema validation on top. Both `createKv` and `createTables` instantiate `YKeyValueLww` internally. Both switch to `createEncryptedKvLww`. Encrypt at the KV level, tables get encryption for free.

5. ~~**Key field in entries**~~: **RESOLVED.** Entry keys (like `'tab-1'`) remain plaintext. They're structural metadata required for CRDT conflict resolution. Encrypting keys would break LWW entirely. They reveal "what kinds of data exist" but not the content. Same as column names in a database.

6. ~~**`entries()` caching**~~: **RESOLVED.** No cache. Decrypt on every call. ~5ms for 1000 values is acceptable. Caching would require invalidation tied to the observer and doubles memory for negligible gain.

7. ~~**Base64 vs raw bytes**~~: **RESOLVED.** Base64 is necessary. Yjs ContentAny JSON-serializes object properties. A `Uint8Array` inside an object property becomes `{"0":1,"1":2,...}`. Base64 adds ~33% overhead but guarantees correct round-trip.

8. ~~**Table helper compatibility**~~: **RESOLVED.** The wrapper maintains its own decrypted `.map`. Table helper methods (`getAll()`, `filter()`, `find()`, etc.) read `ykv.map` directly: they get plaintext values from the wrapper's map. Zero changes to `table-helper.ts`.

9. ~~**Key rotation / `kid` field**~~: **RESOLVED.** Deferred. No `kid` in `EncryptedBlob` v1. When key rotation is needed, bump to `v: 2` and add `kid`. For now, one key per workspace.

10. ~~**Abstraction level**~~: **RESOLVED.** Encrypt at YKeyValueLww level. This is the lowest possible insertion point: plumbed through `createKv` / `createTables` / `createWorkspace`. Tables are KV stores with schema validation on top, so encrypting at the KV level gives tables encryption for free.

11. ~~**Self-hosted salt**~~: **RESOLVED.** Derive deterministically from `SHA-256(userId + workspaceId)`. No storage needed: both inputs are already known on every device. Unique per user×workspace pair.

12. ~~**Migration safety**~~: **RESOLVED.** Eager on sign-in, single Y.Doc transaction. Interruption-safe: unencrypted entries stay plaintext, re-encrypted on next sign-in. Concurrent devices migrate independently: LWW ensures the latest encrypted write wins.

## Key Management & Lifecycle APIs

### Server: Key Delivery via `customSession` Plugin

Better Auth's `customSession` plugin wraps `getSession` and lets you add arbitrary fields to the response. The encryption key piggybacks on every session check. No extra endpoint, no extra request.

```typescript
// In app.ts auth config
import { customSession } from 'better-auth/plugins';

function createAuth(db: Db, env: Env['Bindings']) {
  // Derive encryption key from BETTER_AUTH_SECRET via SHA-256.
  // Deterministic: same secret = same key. No per-user storage.
  const encryptionKey = deriveKeyFromSecret(env.BETTER_AUTH_SECRET);

  return betterAuth({
    ...BASE_AUTH_CONFIG,
    plugins: [
      bearer(),
      jwt(),
      customSession(async ({ user, session }) => {
        return {
          user,
          session,
          encryptionKey: bytesToBase64(encryptionKey),
        };
      }),
      // ... other plugins ...
    ],
  });
}
```

On the client, `customSessionClient` infers the custom fields:

```typescript
import { customSessionClient } from 'better-auth/client/plugins';

const authClient = createAuthClient({
  plugins: [customSessionClient<typeof auth>()],
});

// authClient.getSession() now returns { user, session, encryptionKey }
```

The app already uses `bearer()` for Tauri OAuth/PKCE auth (`tauri://localhost/auth/callback`). The `customSession` plugin composes alongside it. No conflicts.

**Note on Tauri**: Better Auth has `@better-auth/electron` for Electron (uses `safeStorage` + `conf` package). No Tauri-specific integration exists. The current setup. Bearer tokens via OAuth/PKCE. Already works. The encryption key is a separate concern stored via `tauri-plugin-stronghold` (encrypted vault with password-based snapshots, memory zeroization. The Tauri equivalent of Electron's `safeStorage`). Do NOT use `tauri-plugin-store` for secrets. It writes plain JSON to disk.

### Client: Key Cache Interface

Platform-specific implementations behind a unified interface. The workspace layer doesn't care where the key comes from.

```typescript
// packages/workspace/src/shared/crypto/key-cache.ts

type KeyCache = {
  /** Store encryption key for this user. */
  set(userId: string, key: Uint8Array): Promise<void>;
  /** Retrieve cached key, or undefined if not cached. */
  get(userId: string): Promise<Uint8Array | undefined>;
  /** Clear all cached keys (logout or user switch). */
  clear(): Promise<void>;
};
```

| Platform | Implementation |
|---|---|
| Tauri desktop | `tauri-plugin-stronghold`: encrypted vault with password-based snapshots, memory zeroization. The Tauri equivalent of Electron's `safeStorage`. |
| Browser | `sessionStorage`: survives tab refresh, clears on tab close |
| Self-hosted | No cache needed. User enters password each session, key derived via PBKDF2 |

### Client: Lifecycle Operations

These live at the app layer (not workspace layer) since they coordinate auth + persistence + sync.

```typescript
// App-level auth state (e.g., apps/tab-manager/src/lib/state/auth.svelte.ts)

/** Default logout: stop sync, keep local data and key. */
async function logout() {
  syncProvider.disconnect();
  await authClient.signOut();
  // Key stays in cache. IndexedDB stays. User keeps editing.
}

/** Security wipe: clear everything. */
async function signOutAndClear() {
  syncProvider.disconnect();
  await authClient.signOut();
  await keyCache.clear();
  await workspace.extensions.persistence.clearData();
  // Clean slate. Re-login pulls from DO.
}

/** Called on every auth: detects user switch, triggers migration. */
async function onAuthenticated(newUserId: string, encryptionKey: Uint8Array) {
  const cachedUserId = localStorage.getItem('lastUserId');

  if (cachedUserId && cachedUserId !== newUserId) {
    // Different user: mandatory wipe
    await workspace.extensions.persistence.clearData();
    await keyCache.clear();
  }

  await keyCache.set(newUserId, encryptionKey);
  localStorage.setItem('lastUserId', newUserId);

  // Trigger eager migration: re-encrypt any plaintext entries
  await migrateToEncrypted(workspace, encryptionKey);
}
```

### Plaintext → Encrypted Migration

Runs eagerly on sign-in inside a single Y.Doc transaction. All plaintext entries are re-encrypted atomically.

```typescript
/** Re-encrypt all plaintext entries in a single Y.Doc transaction. */
function migrateToEncrypted(workspace: WorkspaceClient, key: Uint8Array) {
  const ydoc = workspace.ydoc;
  ydoc.transact(() => {
    // For each table and KV store:
    // 1. Iterate all entries
    // 2. If entry value is NOT an EncryptedBlob (isEncryptedBlob returns false)
    // 3. Re-write it through the encrypted wrapper (set triggers encrypt)
    // ~50ms for 1000 entries. One transaction = one Y.Doc update = one sync message.
  });
}
```

## Success Criteria

- [ ] `createEncryptedKvLww` with a key: set → get round-trips correctly
- [ ] Without a key: identical behavior to plain `YKeyValueLww` (zero overhead)
- [ ] Two Y.Docs synced via `Y.applyUpdateV2`: encrypted on one, decrypted on the other with same key
- [ ] Observer fires with decrypted values, not encrypted blobs
- [ ] Mixed plaintext/encrypted entries: plaintext passes through, encrypted decrypts
- [ ] Tampered ciphertext: `get()` returns an error or undefined (does not silently return garbage)
- [ ] Performance: < 5ms overhead for 1000 encrypt/decrypt operations
- [ ] Encrypted value format includes `v` and `alg` for future cryptographic agility

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts`: The existing LWW class (unchanged)
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.test.ts`: Test patterns to follow
- `packages/workspace/src/workspace/create-kv.ts`: Where KV is instantiated (wire-in point)
- `specs/20260213T005300-encrypted-workspace-storage.md`: Broader encryption architecture
- `apps/api/src/app.ts`: Better Auth config (key delivery endpoint)
- `apps/tab-manager/src/lib/workspace.ts`: Consumer that creates workspaces
- `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`: Why composition over fork (reference equality analysis)
