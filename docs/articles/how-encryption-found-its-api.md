# How Encryption Found Its API

The hard part of adding encryption to Epicenter wasn't encryption. It was deciding where encryption belonged once auth, workspace startup, and sync all happened at different times. That took 161 commits and three wrong answers before the right one showed up.

## Encryption wraps values, not transport

The core decision was made early and never changed. Encryption wraps individual values inside `YKeyValueLww`: a last-writer-wins map built on Yjs, the CRDT library that backs every table and KV store. Key names, timestamps, and conflict resolution stay in plaintext so Yjs can merge edits. Row data becomes opaque ciphertext.

```
set('tab-1', { url: 'https://bank.com' })
  → JSON.stringify → encryptValue → Uint8Array blob
  → Y.Array entry: { key: 'tab-1', val: Uint8Array[0x01|keyVer|nonce|ct+tag], ts: ... }
```

Persistence sees ciphertext. Sync sees ciphertext. The server sees ciphertext. Nobody downstream needs to know encryption exists. That part worked from day one.

The problem was everything upstream.

## The key shows up late

The encryption key derives from a two-level HKDF (HMAC-based key derivation) hierarchy. On the server, Better Auth's `customSession()` hook runs HKDF-SHA256 against a root secret and adds `encryptionKey` to every `getSession()` response. The client then derives a per-workspace key locally, so each workspace gets a unique key even from the same user secret.

```
Server
  ENCRYPTION_SECRETS + userId
    → deriveUserKey(secret, userId)
    → customSession() adds encryptionKey to getSession() response

Client
  signIn() / signUp()
    → getSession()              ← signIn doesn't return custom fields;
    → base64ToBytes(key)          separate getSession() call required
    → workspace.activateEncryption(userKeyBytes)
      → HKDF(userKey, workspaceId)  → per-workspace key (32 bytes)
      → stores activate
      → onActivate() caches userKey to chrome.storage.session

Page reopen (no server roundtrip)
  → keyCache.get(userId)        ← restore from chrome.storage.session
  → workspace.activateEncryption(cachedKey)
```

The key arrives via authentication or a cached session. Either way, the workspace is created at module scope. Before auth completes, before cache restores. Encryption activates later. That async gap between workspace creation and key arrival is where all the architectural trouble lived.

## Putting lock/unlock on every client polluted the type

The initial API put `lock()`, `unlock(key)`, and `mode` directly on `WorkspaceClient`. Auth code called `unlock()` when it had a key and `lock()` on sign-out.

`unlock()` took a pre-derived workspace key, so auth had to run HKDF itself. Calling it twice with the same key repeated work. Worse, a slow HKDF from an old session could finish after a newer session's key was already active, silently corrupting the encryption state.

And every app that used `WorkspaceClient` saw `lock`/`unlock`/`mode` on the type, whether it needed encryption or not. The client type was polluted for every app. Whispering (transcription, no auth) and CLI tools had encryption methods they should never call.

## EncryptionAdapter: indirection without value

The first decoupling attempt introduced `EncryptionAdapter`: a callback-based interface between the workspace stores and auth. The workspace registered an adapter; the adapter received lifecycle events.

```typescript
// The pattern that didn't survive
workspace.registerEncryptionAdapter({
  onLock: () => { ... },
  onUnlock: (key) => { ... },
});
```

This just moved the coupling. The adapter was a thin passthrough that didn't add any value over calling the methods directly. It felt cleaner on paper, but in code it was just another hop. Removed after a few commits.

## KeyManager: right logic, wrong boundary

The next attempt had more substance. `createEncryptionWiring()` (quickly renamed to `createKeyManager()`) was a factory function that wrapped the workspace and added the missing pieces: byte-level dedup (skip if same key bytes), a generation counter for race protection, and HKDF derivation.

```typescript
const keyManager = createKeyManager({
  target: workspace,   // { id, activateEncryption }
  keyCache,            // platform-specific key storage
});

// Auth calls this
await keyManager.activateKey(userKeyBase64);

// Sign-out calls this
await keyManager.clearKeys();
```

The dedup caught redundant activations. The generation counter killed stale HKDF results. Key caching survived page refreshes. For a while, this was the answer.

Then the app code exposed the flaw.

## Two sign-out paths forgot the second call

Sign-out required two calls: `keyManager.clearKeys()` to wipe the cached key and stop future derivations, then `workspace.deactivateEncryption()` to clear the stores and wipe persisted data. Two objects, two methods, correct order required.

```typescript
// The contract: both calls, correct order
await keyManager.clearKeys();
await workspace.deactivateEncryption();  // ← forgotten in 2 of 4 paths
```

Auth.svelte.ts had four sign-out paths. Two got the sequence right. Two. The `$effect` token-cleared path and the `!data` branch in `checkSession`: forgot `workspace.deactivateEncryption()`. The key cache cleared, but the workspace stores stayed encrypted with a key about to be garbage collected. Real bugs. Easy to miss in review.

The KeyManager's `KeyManagerTarget` interface, `{ id, activateEncryption }`, was just a narrowed copy of `WorkspaceClient`, not a real boundary. It was plumbing that had leaked into architecture.

## `.withEncryption()` moves the boundary to the right place

We mapped KeyManager's nine responsibilities to where they naturally belong:

| Responsibility | Where it lives |
|---|---|
| Dedup (same key → skip) | Workspace owns key state |
| Generation counter (race protection) | Protects workspace state |
| HKDF derivation | `deriveWorkspaceKey` already in workspace package |
| Base64 → bytes conversion | Caller (encoding isn't encryption) |
| Apply key to stores | Already in workspace |
| Key caching (set) | Caller via `onActivate` callback |
| Cache clearing | Workspace triggers via `onDeactivate` callback |
| Cache restore | Caller (app-level: read cache → activate) |

Nothing remained that justified a standalone module. Everything either belonged in the workspace or in the caller. KeyManager was deleted.

The API became a builder method:

```typescript
const workspace = createWorkspace(definition)
  .withEncryption({
    onActivate: (userKey) => keyCache.save(bytesToBase64(userKey)),
    onDeactivate: () => keyCache.clear(),
  })
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ ... }));
```

One call does the full pipeline:

```
activateEncryption(userKeyBytes)
  → same key bytes as last time? skip (dedup)
  → ++generation
  → await HKDF(userKey, workspaceId) → 32-byte workspace key
  → generation changed since we started? discard (race protection)
  → apply key to all encrypted stores
  → await onActivate(userKey)

deactivateEncryption()
  → ++generation (kills any in-flight HKDF)
  → clear key + deactivate all stores
  → clearData() on each extension (persistence wipes IndexedDB)
  → await onDeactivate()
```

No two-step dance. No forgotten cleanup paths. No separate object to coordinate.

## The workspace doesn't know where the key comes from

The consumer decides where the key comes from, how long to cache it, and when encryption becomes active. The workspace accepts bytes and two callbacks. It doesn't know about Better Auth, `chrome.storage.session`, or any specific key source.

Whispering can skip `.withEncryption()` entirely: `activateEncryption` and `isEncrypted` don't exist on its client type. The type system enforces the opt-in.

Extension ordering doesn't matter. The builder tracks encrypted stores separately from extension callbacks, so chaining order doesn't change the runtime behavior:

```typescript
// Both work identically
createWorkspace(def).withEncryption({...}).withExtension('persistence', ...)
createWorkspace(def).withExtension('persistence', ...).withEncryption({...})
```

## The builder already accumulates capabilities

`.withEncryption()` works because the builder already accumulates capabilities. `.withExtension()` returns a new builder with the extension's type and lifecycle hooks added. `.withEncryption()` does the same. It keeps a small closure for encryption state (`lastUserKey` for dedup, `keyGeneration` for the race counter), then returns a client with `activateEncryption`, `deactivateEncryption`, and `isEncrypted` added. No class, no module, no separate object. The state lives in the builder's closure and dies with the workspace.

## What the abstraction graveyard taught us

Each intermediate abstraction was wrong in a different way. The EncryptionAdapter was a layer that didn't do anything. KeyManager was a real abstraction that sat between auth and workspace when the logic belonged inside workspace with the boundary pushed out to callbacks.

The right answer was to stop asking "how do I wire auth to encryption?" and start asking "what does encryption need from the outside?" The answer turned out to be remarkably little: some bytes and two lifecycle hooks. Everything else is internal to the workspace and shouldn't leak: dedup, race protection, HKDF, store coordination.

Encryption ended up as an opt-in workspace capability. Auth passes bytes in and gets lifecycle hooks back.
