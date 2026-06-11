# Client-Side Encryption Wiring

**Date**: 2026-03-13
**Status**: Superseded
**Builds on**: `specs/20260313T180000-encrypted-blob-format-simplification.md`, `specs/20260312T120000-y-keyvalue-lww-encrypted.md`, `specs/20260213T005300-encrypted-workspace-storage.md`
**Related**: PR #1507 (encryption infrastructure), `apps/api/src/app.ts` (server-side key delivery)
> **Superseded (2026-03-14)**: This spec has been refactored into two focused specs:
>
> 1. **`specs/20260314T063000-encryption-wrapper-hardening.md`**: Three explicit encryption modes, error containment, key transition hook, AAD binding. Covers Phase 0 below. Execute first.
> 2. **`specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`**: Per-user-per-workspace key derivation via HKDF, `GET /workspaces/:id/key` endpoint, workspace-scoped key cache. Replaces Phases 1-2 below (deployment-wide key from session → per-user-workspace key from endpoint).
>
> Phase 3 (per-app wiring) is now part of the HKDF spec's Phase 3. The app inventory and edge cases sections below remain useful reference.
>
> **Execution order**: Spec A (hardening) → Spec B (HKDF key derivation, includes per-app wiring).
>
> The original content below is preserved for context but should not be executed as-is.

## Overview

Wire the encryption infrastructure from PR #1507 into every auth-backed app. The crypto primitives and encrypted KV wrapper exist but are dormant. Every app calls `createWorkspace(definition)` without `key`, so nothing encrypts. This spec activates encryption by delivering the server-provided key to each app's workspace.

## Motivation

### Current State

The server already delivers an encryption key via Better Auth's `customSession` plugin:

```typescript
// apps/api/src/app.ts: server side (already implemented)
customSession(async ({ user, session }) => {
  const encryptionKey = await deriveKeyFromSecret(env.BETTER_AUTH_SECRET);
  return { user, session, encryptionKey: bytesToBase64(encryptionKey) };
}),
```

But no client consumes it. Every app creates its workspace without `key`:

```typescript
// Current: encryption dormant
const workspace = createWorkspace(definition)
  .withExtension('persistence', ...)
  .withExtension('sync', ...);
```

### Desired State

```typescript
// After: encryption encrypted when signed in, via lock()/activateEncryption()
const workspace = createWorkspace(definition)
  .withExtension('persistence', ...)
  .withExtension('sync', ...);

// Auth subscription: sole mechanism for key delivery
session.subscribe((s) => {
  workspace.activateEncryption(s?.encryptionKey ? base64ToBytes(s.encryptionKey) : undefined);
});
```

The key flows from the server session to `activateEncryption()` via a subscription. Before auth completes, the workspace is in `plaintext` mode (fully functional, unencrypted). After sign-in, `activateEncryption(key)` transitions to `encrypted` mode. The `key` constructor option is reserved for future KeyCache optimization (seeding from a cached key on page refresh) and is not needed for the initial wiring.

## Architecture

```
Better Auth Server (customSession plugin)
       │
       │  session response: { user, session, encryptionKey: "base64..." }
       ▼
┌─────────────────────────────────────────────────┐
│  Auth Client (per app)                          │
│  + customSessionClient() plugin                 │
│  session.encryptionKey is typed and accessible   │
└────────────────────┬────────────────────────────┘
                     │
                     │  $session store subscription
                     ▼
┌─────────────────────────────────────────────────┐
│  workspace.activateEncryption(key) or workspace.lock()         │
│                                                 │
│  key arrives    → plaintext → encrypted          │
│  key cleared    → encrypted  → locked            │
│  key re-arrives → locked    → encrypted          │
└─────────────────────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Key delivery | `activateEncryption()` / `lock()` via `$session` subscription | `key` constructor option is static (set once). All runtime key transitions go through `activateEncryption()` and `lock()`. No in-memory key store needed. The subscription calls these methods directly. |
| Key format in memory | `Uint8Array` (decoded from base64 once) | Avoids repeated base64 decode on every `key` access. |
| Auth client plugin | `customSessionClient()` from `better-auth/client/plugins` | Required to type `session.encryptionKey` on the client. Server already uses `customSession`. |
| Loading gate | Not needed for initial wiring | Apps are local-first and work without auth. The workspace starts in `plaintext` mode and transitions to `encrypted` when auth completes. No loading gate required. The UI is fully functional in plaintext mode. For page refresh with mixed data, KeyCache (future) prevents partial-data flash. |
| No-auth apps | Unchanged | `fs-explorer` and `tab-manager-markdown` don't have auth, don't need encryption. |
| One commit per app | Yes | Each app is independently deployable and testable. |
| Encryption mode | Three explicit modes: `plaintext` \| `locked` \| `encrypted` | `key === undefined` currently means passthrough. For encrypted workspaces, no key should mean **locked/read-only**, not plaintext-mode writes that can LWW-win over ciphertext. |
| Per-workspace subkeys | Derive subkey: `HKDF(masterKey, workspaceId)` | Current `SHA-256(BETTER_AUTH_SECRET)` is deployment-wide. One compromised client can decrypt any workspace. Subkey derivation bounds blast radius to one workspace. |
| AAD context binding | Pass `workspaceId + tableName + key` as AES-GCM AAD | Prevents ciphertext from one table being replayed into another. AES-GCM supports this natively at zero extra cost. |
| Error containment | `trySync` around decrypt in observer; quarantine bad blobs | One corrupted blob currently throws inside the Y.Array observer and poisons the entire observation chain. Containment isolates failures. |
| Key transition hook | `activateEncryption(key)` rebuilds `wrapper.map` | Initial map hydration happens once at creation. If workspace loads before auth, encrypted entries stay as raw blobs until individually touched. An explicit rebuild on key arrival fixes this. |

## App Inventory

| App | Platform | Has Auth | Encryption? | Key Source |
|-----|----------|----------|-------------|-----------|
| epicenter | Tauri desktop (Svelte) | Yes (OAuth/PKCE) | ✅ Wire | Session via `customSessionClient` |
| whispering | Tauri desktop (Svelte) | Yes | ✅ Wire | Session via `customSessionClient` |
| tab-manager | Chrome extension (WXT/Svelte) | Yes | ✅ Wire | Session via `customSessionClient` |
| fs-explorer | Browser (Svelte) | No | ❌ Skip | N/A |
| tab-manager-markdown | Node.js CLI | No | ❌ Skip | N/A |

## Implementation Plan

### Phase 1: Per-App Wiring

No shared key store needed. The `$session` subscription calls `workspace.activateEncryption()` or `workspace.lock()` directly. No intermediate abstraction. Each app wires the same 3-line pattern:

```typescript
session.subscribe((s) => {
  const key = s?.encryptionKey ? base64ToBytes(s.encryptionKey) : undefined;
  if (key) {
    workspace.activateEncryption(key);
  } else {
    workspace.lock();
  }
});

### Phase 0: Encryption Hardening (before or alongside Phase 1)

These items address architectural gaps identified during review. They should land before real keys flow to real clients.

- [x] **0.1** **Three explicit encryption modes**: Add a `mode: 'plaintext' | 'locked' | 'encrypted'` state to `createEncryptedKvLww`. When mode is `locked` (key was previously encrypted but is now cleared), `set()` throws or no-ops instead of writing plaintext-mode. Mode transitions: `plaintext` → `encrypted` (key arrives) → `locked` (key cleared / sign-out). Workspaces that have never seen a key stay in `plaintext` mode.
- [ ] **0.2** **Per-workspace subkey derivation**: In `apps/api/src/app.ts`, change `SHA-256(BETTER_AUTH_SECRET)` to `HKDF(SHA-256(BETTER_AUTH_SECRET), workspaceId)`. Client receives a workspace-scoped key. No change to the encryption primitives. Just a different key per workspace.
- [x] **0.3** **AAD context binding**: Update `encryptValue` and `decryptValue` to accept an optional `aad?: Uint8Array` parameter. The encrypted wrapper passes `encode(workspaceId + ':' + tableName + ':' + key)` as AAD. Ciphertext becomes position-bound.
- [x] **0.4** **Error containment in observer**: Wrap `maybeDecrypt` calls in the `inner.observe()` handler with `trySync`. On failure, log the error and skip the entry (or mark it as `{ status: 'decrypt-failed' }`) instead of throwing. One bad blob should not poison the entire table.
- [x] **0.5** **Key transition hook**: Add `lock()` and `activateEncryption(key: Uint8Array)` methods to `YKeyValueLwwEncrypted`. When called, they re-iterate `inner.map`, re-decrypt all entries with the new key, and rebuild `wrapper.map`. The key store calls these when the key changes.

### Phase 2: Per-App Wiring (one commit each)

For each auth-backed app:

- [ ] **2.1** **epicenter**: Add `customSessionClient()` to auth client config. Add `$session` subscription calling `workspace.activateEncryption(key)` or `workspace.lock()`. Disable editing UI when `workspace.mode === 'locked'`.
- [ ] **2.2** **whispering**: Same pattern. Auth client → `$session` subscription → `activateEncryption()`/`lock()`. Disable editing in locked mode.
- [ ] **2.3** **tab-manager**: Same pattern. Note: Chrome extension auth flow may have different session access patterns (popup vs background). Verify `$session` subscription works in the extension context.

### Phase 3: Verify

- [ ] **3.1** Run `bun test` in `packages/workspace`: all tests pass (passthrough still works)
- [ ] **3.2** Run `bun run typecheck` across the monorepo
- [ ] **3.3** Verify each app builds: `bun run build` in each app directory
- [ ] **3.4** Manual verification: sign in → check that new KV writes produce `EncryptedBlob` in Y.Doc. Sign out → check that `key` is `undefined`.

## Edge Cases

### Workspace Created Before Auth Completes

This is the common case. Workspaces are created at module scope as side-effect-free exports. The workspace starts in `plaintext` mode (fully functional, no encryption). Users can read and write freely. Once auth completes, the `$session` subscription calls `activateEncryption(key)`, transitioning to `encrypted` mode. New writes encrypt; old plaintext-mode data stays readable via mixed-mode detection.

### Session Refresh / Token Rotation

When Better Auth refreshes the session, `$session` emits a new value. The subscription calls `activateEncryption()` with the (possibly unchanged) key. If the key hasn't changed, `activateEncryption()` is a no-op. The subscription handles this transparently.

### Sign Out

On sign-out, `$session` emits `null`. The subscription calls `lock()`. Mode transitions to `locked`: `set()` throws instead of falling through to plaintext-mode. This prevents sign-out from accidentally downgrading previously encrypted data via LWW timestamp wins.

**UX in locked mode**: Apps are local-first. Users were editing freely before sign-in and expect to keep working. But once encryption has activated, allowing plaintext-mode writes is a security downgrade. The UI should:
- Detect `workspace.mode === 'locked'`
- Disable all editing controls (forms, inputs, buttons that trigger writes)
- Show a clear message: "Sign in to continue editing"
- Keep all data readable from the cached decrypted map
- On re-sign-in, `activateEncryption(key)` transitions back to `encrypted` and editing resumes

This matches how cloud apps handle expired auth in offline mode. Read-only until credentials are restored.

### Mixed None-Mode and Encrypted Data

When encryption first activates, existing data is plaintext-mode. The encrypted wrapper's `maybeDecrypt` function checks `isEncryptedBlob()` on every read. None-mode values pass through. New writes encrypt. Over time, as entries are edited, they migrate from plaintext-mode to encrypted. No explicit migration step needed for the initial rollout.

## Open Questions

1. ~~**Should the key store live in `packages/workspace` or per-app?**~~ **RESOLVED.** No key store needed. The `$session` subscription calls `workspace.activateEncryption()` or `workspace.lock()` directly. No intermediate abstraction.

2. **Loading gate UX. What does the user see before auth completes?**
   - Apps are local-first and work without auth. The workspace is fully functional in `plaintext` mode before sign-in. No loading gate needed.
   - **Caveat**: After sign-in + page refresh, encrypted entries are invisible until `activateEncryption()` fires (~100-500ms). KeyCache (future) would eliminate this flash by seeding the key at construction via the `key` option. For the initial wiring, this brief partial-data flash is acceptable.

3. **Tab-manager extension context. Does `$session` work in service workers?**
   - The extension's auth client may behave differently in the WXT background script vs popup.
   - **Recommendation**: Investigate during implementation. If `$session` doesn't work in the service worker, use `chrome.storage.session` as an intermediary.

## Success Criteria

- [ ] `customSessionClient()` added to all 3 auth-backed apps
- [ ] `session.encryptionKey` is typed and accessible in each app
- [ ] Each app subscribes to `$session` and calls `workspace.activateEncryption(key)` or `workspace.lock()` on sign-in/out
- [ ] New KV/table writes produce `EncryptedBlob` when signed in
- [ ] Reads decrypt transparently (existing plaintext + new ciphertext coexist)
- [ ] Sign-out transitions to `locked` mode; `set()` rejects writes (not `plaintext`-mode passthrough)
- [ ] `activateEncryption()` rebuilds decrypted map when key arrives after workspace creation
- [ ] One corrupted blob does not poison the observation chain (error containment)
- [ ] All tests pass, typecheck clean, each app builds

## References

- `packages/workspace/src/shared/crypto/index.ts`: `base64ToBytes`, `EncryptedBlob`
- `packages/workspace/src/shared/crypto/key-cache.ts`: `KeyCache` interface (not used yet, but defines the future extensibility point)
- `packages/workspace/src/workspace/create-workspace.ts`: `options.key` parameter
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: `createEncryptedKvLww`, `key` option
- `apps/api/src/app.ts`: server-side `customSession` plugin delivering `encryptionKey`
- `apps/epicenter/src/lib/yjs/workspace.ts`: Epicenter workspace creation
- `apps/whispering/src/lib/workspace.ts`: Whispering workspace creation
- `apps/tab-manager/src/lib/workspace.ts`: Tab Manager workspace creation
- Better Auth docs: `customSessionClient()` from `better-auth/client/plugins`
