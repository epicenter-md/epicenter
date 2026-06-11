# Encryption Wiring Factory

**Date**: 2026-03-15
**Status**: Draft
**Builds on**: `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`, `specs/20260315T083000-keycache-chrome-extension.md`

## Overview

Extract the per-app reactive encryption glue into a framework-agnostic `createEncryptionWiring()` factory in `@epicenter/workspace`. Today the tab-manager has 58 lines of bespoke Svelte wiring that every encrypted app would need to replicate. The factory encodes the hard parts. Async HKDF bridging, three-way key-loss branching, mode guard subtlety, race protection. So consumers write ~5 lines of framework glue instead.

## Motivation

### Current State

`apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts` is the only encryption wiring in the monorepo:

```typescript
export function initEncryptionWiring() {
  return $effect.root(() => {
    $effect(() => {
      const keyBase64 = authState.encryptionKey;
      const status = authState.status;

      if (keyBase64) {
        const userKey = base64ToBytes(keyBase64);
        void deriveWorkspaceKey(userKey, workspaceClient.id).then((wsKey) => {
          workspaceClient.activateEncryption(wsKey);
        });
      } else if (workspaceClient.mode === 'encrypted') {
        if (status === 'signing-out') {
          void workspaceClient.clearLocalData();
        } else {
          workspaceClient.lock();
        }
      }
    });
  });
}
```

This creates problems:

1. **Framework coupling.** Uses Svelte 5's `$effect.root` + `$effect`, making it non-portable to non-Svelte consumers (Tauri commands, service workers, tests, future React apps).
2. **Replication burden.** Whispering, epicenter, and any future encrypted app would copy-paste this file and adapt the auth state shape. The kind of duplication that drifts.
3. **Timing gap.** The `void deriveWorkspaceKey(...).then(...)` is fire-and-forget. Between key arrival and HKDF completion, the workspace stays in its previous mode. No way for the UI to gate on "encryption is ready."
4. **Subtle correctness.** The three-way branch on key loss (sign-out → clearLocalData, session expiry → lock, never-had-key → no-op) and the `mode === 'encrypted'` guard are easy to get wrong. One mistake either soft-locks a plaintext-mode workspace or skips cleanup on sign-out.

### Desired State

```typescript
// Framework-agnostic core (packages/workspace)
const wiring = createEncryptionWiring(workspaceClient);

// Per-app Svelte adapter (~5 lines)
$effect(() => {
  const key = authState.encryptionKey;
  if (key) {
    wiring.connect(key);
  } else {
    wiring.disconnect({ wipe: authState.status === 'signing-out' });
  }
});
```

The hard parts live in the factory. The framework glue is trivially portable.

## Research Findings

### The Four Hard Parts

The encryption wiring encodes four things that are genuinely tricky:

| Hard Part | What Makes It Hard | Current Handling |
|---|---|---|
| Async-to-sync bridge | `deriveWorkspaceKey` is async (Web Crypto HKDF), but `activateEncryption()` is sync. The workspace stays in its previous mode during derivation. | Fire-and-forget `void promise.then()`. No way to know when activateEncryption completes. |
| Three-way key-loss branch | When key goes null, must distinguish sign-out (clearLocalData) from session expiry (lock) from "never had a key" (no-op). | Reads both `authState.encryptionKey` AND `authState.status`, coupling auth semantics into wiring. |
| Mode guard subtlety | The `mode === 'encrypted'` guard prevents locking a workspace that was never unlocked. Getting this wrong either soft-locks a plaintext-mode workspace or skips cleanup. | Imperative check on `workspaceClient.mode` (NOT reactive. Checked only when the effect fires). |
| Race conditions | If `disconnect()` fires while HKDF is in-flight, the stale `activateEncryption()` must not land. If key changes rapidly, only the latest derivation should win. | None. Current code has no race protection. |

### What The Decision Tree Actually Encodes

```
keyBase64 present?
├─ YES → base64ToBytes → deriveWorkspaceKey(userKey, wsId) → activateEncryption(wsKey)
└─ NO  → was workspace encrypted?
     ├─ NO  → no-op (plaintext mode, never had a key)
     └─ YES → is signing out?
          ├─ YES → clearLocalData() (wipe IndexedDB, keep client alive)
          └─ NO  → lock() (soft lock, data preserved)
```

### Existing API Surface

| Component | Location | Signature |
|---|---|---|
| `deriveWorkspaceKey` | `@epicenter/workspace/shared/crypto` | `(userKey: Uint8Array, workspaceId: string) → Promise<Uint8Array>` |
| `base64ToBytes` | `@epicenter/workspace/shared/crypto` | `(base64: string) → Uint8Array` |
| `bytesToBase64` | `@epicenter/workspace/shared/crypto` | `(bytes: Uint8Array) → string` |
| `client.mode` | `WorkspaceClient` | `EncryptionMode = 'plaintext' \| 'locked' \| 'encrypted'` |
| `client.lock()` | `WorkspaceClient` | `void`: no-op if plaintext |
| `client.activateEncryption(key)` | `WorkspaceClient` | `void`: rollback on failure |
| `client.clearLocalData()` | `WorkspaceClient` | `Promise<void>`: lock + LIFO extension clear |
| `client.id` | `WorkspaceClient` | `string`: workspace ID for HKDF info |

### Current Reactive Dependency Chain

```
authState.checkSession()          ← App.svelte onMount
  → getSession() from Better Auth
  → encryptionKey = data.encryptionKey    ← sets reactive $state
  → phase = { status: 'signed-in' }

authState.encryptionKey  ← $state<string | undefined>
authState.status         ← derived from phase.status

$effect in encryption-wiring.svelte.ts
  reads: authState.encryptionKey, authState.status   (reactive: triggers re-run)
  reads: workspaceClient.mode                        (imperative, NOT reactive)
  calls: deriveWorkspaceKey() → workspaceClient.activateEncryption()
      or workspaceClient.lock()
      or workspaceClient.clearLocalData()
```

**Important subtlety**: `workspaceClient.mode` is NOT a Svelte reactive signal. The `$effect` doesn't re-run when mode changes. It only re-runs when `authState.encryptionKey` or `authState.status` changes. The `mode === 'encrypted'` check is a guard read, not a subscription. This is correct. The wiring should only fire on *auth* changes, not on workspace state changes.

### App Landscape

| App | Has Auth | Has Encryption Wiring | Notes |
|---|---|---|---|
| tab-manager | Yes (Better Auth + Chrome identity) | Yes (58 lines) | Only consumer today |
| whispering | No (Tauri desktop, no auth yet) | No | Will need it when auth is added |
| epicenter | N/A (app doesn't exist in tree yet) | No | Planned future consumer |
| fuji, honeycrisp, opensidian | Unknown | No | May need it if auth-backed |
| tab-manager-markdown | No (CLI) | No | No auth, no encryption |

The factory is designed for the second consumer before code gets duplicated.

## Alternatives Considered

### Alternative A: Reactive `update()` model

```typescript
type EncryptionWiring = {
  update(): void;
  whenUnlocked: Promise<void>;
  dispose(): void;
};

function createEncryptionWiring(options: {
  client: EncryptionWiringClient;
  getEncryptionKey: () => string | undefined;
  getIsSigningOut: () => boolean;
}): EncryptionWiring;
```

The consumer calls `update()` from their reactive system. The factory reads getters for current state.

**Pros**: Pure pull model, no arguments on each call, idempotent.
**Cons**: Getter functions add a layer of indirection. The factory holds references to external state. Testing requires mocking getters. `update()` is vague. Doesn't communicate what's changing.

### Alternative B: Imperative `connect()`/`disconnect()` model (chosen)

```typescript
type EncryptionWiring = {
  connect(userKeyBase64: string, userId?: string): void;
  disconnect(options?: { wipe?: boolean }): void;
  loadCachedKey(userId: string): Promise<boolean>;
};

function createEncryptionWiring(
  client: EncryptionWiringClient,
  config?: EncryptionWiringConfig,
): EncryptionWiring;
```

The consumer pushes values into the factory. The factory has no knowledge of external state.

**Pros**: Explicit data flow. Easy to test (pass values, check effects). No getter references to mock. Naming communicates intent: `connect` means "here's a key," `disconnect` means "key is gone."
**Cons**: Caller must compute the wipe boolean. Slightly more ceremony per call.

### Alternative C: Subscription model

```typescript
type EncryptionWiring = {
  subscribe(source: Observable<{ key?: string; isSigningOut: boolean }>): () => void;
};
```

The factory subscribes to an observable/signal stream.

**Pros**: Automatic cleanup. Framework adapters just provide the stream.
**Cons**: Introduces observable dependency. Harder to test. Overly abstract for what's essentially two function calls.

**Decision**: Alternative B. The imperative model follows the codebase's factory function pattern (see `createSyncExtension`). The caller owns the reactive glue, the factory owns the crypto and state management. Clean separation.

### Key-Loss Signal: Three Options

How should the consumer tell the factory whether to wipe or soft-lock when the key disappears?

| Option | API | Trade-off |
|---|---|---|
| **(A)** `disconnect({ wipe: boolean })` | Caller maps auth semantics to a boolean | Simple. Decoupled from auth state shape. Caller decides policy. |
| **(B)** `getIsSigningOut: () => boolean` getter | Factory reads auth state via getter | Couples factory to auth concept. Getter reference management. |
| **(C)** `keyAction: () => 'lock' \| 'clear' \| 'noop'` | Caller fully controls the null-key branch | Maximum flexibility but pushes the decision tree to the caller. Defeats the purpose of extracting it. |

**Decision**: Option A (`disconnect({ wipe })`). It's the minimum information the factory needs, and it keeps the decision tree inside the factory where it belongs. The consumer just answers "are you signing out right now?" and passes a boolean. Different apps map their auth concept differently:

```typescript
// Tab-manager: reads authState.status
wiring.disconnect({ wipe: authState.status === 'signing-out' });

// Tauri app: might use a different signal
wiring.disconnect({ wipe: isExplicitSignOut });

// CLI: always wipe
wiring.disconnect({ wipe: true });
```

### HKDF Derivation Ownership: Two Options

Should the factory own `deriveWorkspaceKey` internally, or should the consumer pass an already-derived key?

| Option | API | Trade-off |
|---|---|---|
| **(A)** Factory owns HKDF | `connect(base64Key)`: factory does `base64ToBytes → deriveWorkspaceKey → activateEncryption` | Hides complexity. Every consumer uses the same derivation. Factory manages async timing. |
| **(B)** Consumer derives key | `connect(derivedKey: Uint8Array)`: consumer handles HKDF | Flexible for different key sources (password-based, pre-derived). But pushes async management to caller. |

**Decision**: Option A. Every consumer uses the same HKDF derivation with the same parameters (`HKDF-SHA256`, empty salt, `workspace:{id}` info string). No app has needed a different key source. The async timing gap management is the hard part. The factory already needs to manage the promise lifecycle. Hiding HKDF reduces per-app boilerplate from ~15 lines to ~5 lines.

If a future consumer needs a pre-derived key, add an optional `deriveKey` override:

```typescript
type EncryptionWiringConfig = {
  keyCache?: KeyCache;
  /** Override the default HKDF derivation. Useful for password-based or pre-derived keys. */
  deriveKey?: (userKey: Uint8Array, workspaceId: string) => Promise<Uint8Array>;
};
```

This is not needed today and should not be added until there's a real consumer.

### Timing Gap Formalization: Two Options

Should the factory expose readiness signals so the UI can gate on "encryption is ready"?

| Option | API | Trade-off |
|---|---|---|
| **(A)** No readiness signal | Factory is fire-and-forget. UI uses `client.whenReady` or ignores the gap. | Simple. Matches current behavior. The gap is ~1-5ms for HKDF. |
| **(B)** `whenUnlocked` promise | `wiring.whenUnlocked: Promise<void>` resolves on first successful activateEncryption. | UI can `{#await wiring.whenUnlocked}`. Formalizes the timing gap. Adds complexity. |

**Decision**: Defer. The current timing gap is ~1-5ms (HKDF is fast on modern hardware). The workspace starts in plaintext mode and transitions to encrypted. UI is functional the entire time. The KeyCache spec (`specs/20260315T083000-keycache-chrome-extension.md`) addresses the real UX problem (flash on refresh) by seeding the key instantly from cache, bypassing the gap entirely.

If the gap becomes a real UX problem, the factory's internal `generation` counter makes it trivial to add `whenUnlocked` later without breaking the API.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Location | `packages/workspace/src/shared/crypto/encryption-wiring.ts` | Sits next to `key-cache.ts` and crypto primitives it depends on. Same `shared/crypto` barrel export. |
| API style | Imperative `connect()`/`disconnect()` | Framework-agnostic. Follows `createSyncExtension` factory pattern. See Alternatives Considered above. |
| Key input format | `string` (base64) | Matches what Better Auth sessions return. Factory handles `base64ToBytes` internally. |
| HKDF derivation | Automatic inside `connect()` | Every consumer needs it. Factory knows the workspace ID. See HKDF Ownership analysis above. |
| Wipe signal | `disconnect({ wipe: true })` | Decouples from auth state shape. Caller maps their auth semantics to a boolean. See Key-Loss Signal analysis above. |
| KeyCache | Optional config | Apps without caching skip it. When provided, `connect()` writes, `disconnect({ wipe })` clears, `loadCachedKey()` reads. |
| Race protection | Generation counter | `connect()` is fire-and-forget async. A `disconnect()` during in-flight derivation must not let a stale `activateEncryption()` land. Fixes a bug in the current code. |
| Client typing | `Pick<WorkspaceClient, 'id' \| 'mode' \| 'activateEncryption' \| 'lock' \| 'clearLocalData'>` | Minimal surface. Doesn't couple to the full workspace client type. |
| Duplicate key skip | Track `lastKeyBase64` | `activateEncryption()` rebuilds the decrypted map every time. Skipping when the key hasn't changed avoids unnecessary work. |
| Timing gap | Deferred | Gap is ~1-5ms. KeyCache addresses the real UX problem. See Timing Gap analysis above. |
| Svelte adapter | Not in scope | The factory API is simple enough that a Svelte adapter adds no value. The consumer writes 5 lines of `$effect` glue directly. A `createSvelteEncryptionWiring` wrapper can be added later if a pattern emerges. |

## Architecture

```
Better Auth Server (customSession plugin)
       │
       │  session response: { user, session, encryptionKey: "base64..." }
       ▼
┌─────────────────────────────────────────────────┐
│  Auth Client (per app)                          │
│  encryptionKey is typed and accessible          │
└────────────────────┬────────────────────────────┘
                     │
                     │  App-specific reactive bridge (5 lines)
                     │    Svelte $effect / React useEffect / callback
                     ▼
┌─────────────────────────────────────────────────┐
│  createEncryptionWiring(client, config?)        │
│                                                 │
│  connect(base64Key)                             │
│    → base64ToBytes(key)                         │
│    → ++generation (race protection)             │
│    → deriveWorkspaceKey(userKey, wsId)           │
│    → if (gen === generation) activateEncryption(wsKey)       │
│    → keyCache?.set(userId, userKey)              │
│                                                 │
│  disconnect({ wipe })                           │
│    → ++generation (cancel in-flight)            │
│    → if mode === 'encrypted':
│        wipe ? clearLocalData() : lock()         │
│    → if wipe: keyCache?.clear()                 │
│                                                 │
│  loadCachedKey(userId)                          │
│    → keyCache?.get(userId)                      │
│    → if found: connect(cached)                  │
└─────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  WorkspaceClient                                │
│    .mode     'plaintext' | 'locked' | 'encrypted'│
│    .activateEncryption(key)   decrypt stores                │
│    .lock()        clear key, block writes       │
│    .clearLocalData()  lock + wipe extensions    │
└─────────────────────────────────────────────────┘
```

## API

```typescript
import type { KeyCache } from './key-cache';

type EncryptionWiringConfig = {
  /** Optional key cache for instant activateEncryption on page refresh. */
  keyCache?: KeyCache;
};

type EncryptionWiringClient = {
  readonly id: string;
  readonly mode: 'plaintext' | 'locked' | 'encrypted';
  activateEncryption(key: Uint8Array): void;
  lock(): void;
  clearLocalData(): Promise<void>;
};

type EncryptionWiring = {
  /**
   * Supply a user-level encryption key (base64-encoded).
   *
   * Decodes base64 → derives per-workspace key via HKDF → calls `activateEncryption()`.
   * No-op if called with the same key as the previous `connect()`.
   * If `keyCache` was provided, caches the key bytes under `userId`.
   *
   * @param userKeyBase64 - Base64-encoded user encryption key from the auth session
   * @param userId - Required when keyCache is configured. Identifies whose key to cache.
   */
  connect(userKeyBase64: string, userId?: string): void;

  /**
   * Remove the encryption key.
   *
   * - `wipe: true` → `clearLocalData()` (sign-out: wipe IndexedDB, keep client alive)
   * - `wipe: false` (default) → `lock()` (soft lock: data preserved, writes blocked)
   *
   * Only acts when `mode === 'encrypted'`. No-op in plaintext/locked modes.
   * Cancels any in-flight HKDF derivation from a prior `connect()`.
   * If `keyCache` was provided and `wipe` is true, clears the cache.
   */
  disconnect(options?: { wipe?: boolean }): void;

  /**
   * Attempt to restore from a cached key.
   *
   * Reads from the `keyCache` for the given `userId`. If found, calls
   * `connect()` internally (skipping re-encoding. Uses bytes directly).
   * Returns `true` if a cached key was found and `connect()` was initiated.
   *
   * No-op if no `keyCache` was configured.
   */
  loadCachedKey(userId: string): Promise<boolean>;
};

function createEncryptionWiring(
  client: EncryptionWiringClient,
  config?: EncryptionWiringConfig,
): EncryptionWiring;
```

## Internal Implementation Sketch

```typescript
function createEncryptionWiring(
  client: EncryptionWiringClient,
  config?: EncryptionWiringConfig,
): EncryptionWiring {
  // Zone 1: Immutable state
  const keyCache = config?.keyCache;

  // Zone 2: Mutable state
  let generation = 0;          // Race protection for async HKDF
  let lastKeyBase64: string | undefined;

  // Zone 3: Private helpers
  function deriveAndUnlock(userKey: Uint8Array, gen: number) {
    void deriveWorkspaceKey(userKey, client.id).then((wsKey) => {
      if (gen === generation) client.activateEncryption(wsKey);
    });
  }

  // Zone 4: Public API
  return {
    connect(userKeyBase64, userId) {
      if (userKeyBase64 === lastKeyBase64) return;
      lastKeyBase64 = userKeyBase64;

      const gen = ++generation;
      const userKey = base64ToBytes(userKeyBase64);

      deriveAndUnlock(userKey, gen);

      if (userId && keyCache) {
        void keyCache.set(userId, userKey);
      }
    },

    disconnect({ wipe = false } = {}) {
      ++generation;           // Invalidate any in-flight derivation
      lastKeyBase64 = undefined;

      if (client.mode === 'encrypted') {
        if (wipe) {
          void client.clearLocalData();
        } else {
          client.lock();
        }
      }

      if (wipe && keyCache) {
        void keyCache.clear();
      }
    },

    async loadCachedKey(userId) {
      if (!keyCache) return false;
      const cached = await keyCache.get(userId);
      if (!cached) return false;

      // Convert bytes back to base64 for the connect() dedup check
      const base64 = bytesToBase64(cached);
      this.connect(base64, userId);
      return true;
    },
  };
}
```

## Per-App Usage

### Svelte (tab-manager): Before (58 lines)

```typescript
import { base64ToBytes, deriveWorkspaceKey } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';

export function initEncryptionWiring() {
  return $effect.root(() => {
    $effect(() => {
      const keyBase64 = authState.encryptionKey;
      const status = authState.status;
      if (keyBase64) {
        const userKey = base64ToBytes(keyBase64);
        void deriveWorkspaceKey(userKey, workspaceClient.id).then((wsKey) => {
          workspaceClient.activateEncryption(wsKey);
        });
      } else if (workspaceClient.mode === 'encrypted') {
        if (status === 'signing-out') {
          void workspaceClient.clearLocalData();
        } else {
          workspaceClient.lock();
        }
      }
    });
  });
}
```

### Svelte (tab-manager): After (~10 lines)

```typescript
import { createEncryptionWiring } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';

const wiring = createEncryptionWiring(workspaceClient);

export function initEncryptionWiring() {
  return $effect.root(() => {
    $effect(() => {
      const key = authState.encryptionKey;
      if (key) {
        wiring.connect(key);
      } else {
        wiring.disconnect({ wipe: authState.status === 'signing-out' });
      }
    });
  });
}
```

### Svelte (tab-manager): After, with KeyCache (~15 lines)

```typescript
import { createEncryptionWiring } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';
import { keyCache } from './key-cache';

const wiring = createEncryptionWiring(workspaceClient, { keyCache });

export function initEncryptionWiring() {
  // Fast path: load cached key before auth roundtrip
  const userId = authState.user?.id;
  if (userId) void wiring.loadCachedKey(userId);

  return $effect.root(() => {
    $effect(() => {
      const key = authState.encryptionKey;
      if (key) {
        wiring.connect(key, authState.user?.id);
      } else {
        wiring.disconnect({ wipe: authState.status === 'signing-out' });
      }
    });
  });
}
```

### React (hypothetical)

```typescript
import { createEncryptionWiring } from '@epicenter/workspace/shared/crypto';

const wiring = createEncryptionWiring(workspaceClient);

function useEncryptionWiring(encryptionKey: string | undefined, isSigningOut: boolean) {
  useEffect(() => {
    if (encryptionKey) {
      wiring.connect(encryptionKey);
    } else {
      wiring.disconnect({ wipe: isSigningOut });
    }
  }, [encryptionKey, isSigningOut]);
}
```

### Vanilla (Tauri keychain, service worker, test harness)

```typescript
import { createEncryptionWiring } from '@epicenter/workspace/shared/crypto';

const wiring = createEncryptionWiring(workspaceClient);

// On keychain activateEncryption:
wiring.connect(keychainBase64Key);

// On app lock:
wiring.disconnect();

// On sign-out:
wiring.disconnect({ wipe: true });
```

## Edge Cases

### Race: disconnect() during in-flight HKDF derivation

`connect()` increments `generation` before starting async HKDF. `disconnect()` also increments `generation`. When the HKDF promise resolves, it checks `gen === generation`: stale derivations are silently dropped. This is a bug fix over the current code, which has no race protection.

### Rapid connect() calls (key changes twice before first HKDF resolves)

Each `connect()` increments `generation`. Only the latest derivation's `gen` matches `generation` when the promise resolves. Earlier derivations are silently dropped.

### Duplicate key (same key passed to connect twice)

Tracked via `lastKeyBase64`. Second call is a no-op. Avoids redundant `activateEncryption()` rebuilds. `activateEncryption()` rebuilds the entire decrypted map, so skipping is a meaningful optimization.

### disconnect() when already locked/plaintext

The `client.mode === 'encrypted'` guard prevents no-op `lock()` calls. `clearLocalData()` is also gated. No wipe if never unlocked. This matches the current behavior exactly.

### Key rotation (server changes ENCRYPTION_SECRETS)

`lastKeyBase64` changes → `connect()` proceeds → new workspace key derived → `activateEncryption()` with new key. The encrypted KV wrapper handles re-keying internally (quarantined entries are retried with the new key).

### loadCachedKey() without keyCache configured

Returns `false` immediately. No error. The `if (!keyCache) return false` guard makes this safe.

### connect() after disconnect({ wipe: true })

Valid. This is the re-sign-in flow. `clearLocalData()` wipes IndexedDB but keeps the client alive. The next `connect()` derives a new key, calls `activateEncryption()`, and the workspace re-syncs from the server.

### activateEncryption() throws (wrong key, corrupted data)

`client.activateEncryption()` has built-in rollback. If any store fails, already-unlocked stores are re-locked. The error propagates out of `connect()`. Since `connect()` is called from within a fire-and-forget async chain (`deriveAndUnlock`), the error is swallowed unless the caller adds a `.catch()`. This matches the current behavior.

If error reporting is needed, the factory could accept an `onError` callback in config. Not needed today.

## Open Questions

1. **Should the factory expose an `onError` callback for failed `activateEncryption()` calls?**

   Currently, errors from `activateEncryption()` (wrong key, corrupted store) are silently swallowed because `deriveAndUnlock` is fire-and-forget. The workspace rolls back to its previous state, so no data is lost, but the consumer has no way to know it failed.

   - Options: (a) Add `onError?: (error: unknown) => void` to config, (b) Return a promise from `connect()` that rejects on failure, (c) Leave as-is since the workspace self-heals on retry
   - **Recommendation**: Leave as-is for now. The workspace's built-in rollback handles the failure case. If users report "activateEncryption seemed to fail silently," add `onError` then.

2. **Should the factory support multiple workspace clients?**

   Some apps might have multiple workspaces (e.g., a shared workspace + a personal workspace). Should the factory accept an array of clients and activateEncryption them all with the same derived key?

   - Options: (a) Single client per factory (create one factory per workspace), (b) Accept `client | client[]`
   - **Recommendation**: Single client per factory. One factory per workspace is clearer and matches `createSyncExtension`'s pattern. If an app has N workspaces, it creates N wirings. The overhead is negligible.

3. **Should a Svelte adapter be provided in-package?**

   A `createSvelteEncryptionWiring` in `packages/workspace/src/svelte/` could hide the `$effect.root` + `$effect` boilerplate entirely. But it's only ~5 lines of glue, and adding it means `@epicenter/workspace` has a Svelte-aware entry point.

   - Options: (a) No adapter. Consumer writes 5 lines, (b) Thin adapter in `@epicenter/workspace/svelte`, (c) Adapter lives in each app
   - **Recommendation**: Defer. The 5-line glue is trivially portable. If a third encrypted app appears and all three copy the same `$effect.root` pattern, extract then. YAGNI.

4. **Should the `deriveKey` override be added now?**

   The config type could accept a `deriveKey?: (userKey: Uint8Array, workspaceId: string) => Promise<Uint8Array>` for non-HKDF key sources (password-based, pre-derived, etc.).

   - Options: (a) Add now for future-proofing, (b) Add when the first non-HKDF consumer appears
   - **Recommendation**: Defer. No consumer needs it today. Adding it now invites unused code paths and untested branches.

## Implementation Plan

### Phase 1: Core factory

- [ ] **1.1** Create `packages/workspace/src/shared/crypto/encryption-wiring.ts` with `createEncryptionWiring()` factory
- [ ] **1.2** Export `createEncryptionWiring` and types from `packages/workspace/src/shared/crypto/index.ts`
- [ ] **1.3** Verify `./shared/crypto` export exists in workspace `package.json` (added in HKDF spec)

### Phase 2: Tests

- [ ] **2.1** Write tests in `packages/workspace/src/shared/crypto/encryption-wiring.test.ts` covering:
  - `connect()` calls `deriveWorkspaceKey` then `activateEncryption()` with derived key
  - `disconnect()` calls `lock()` when mode is `'encrypted'`
  - `disconnect({ wipe: true })` calls `clearLocalData()` when mode is `'encrypted'`
  - `disconnect()` is a no-op when mode is `'plaintext'`
  - Duplicate key skip (same `connect()` twice → one `activateEncryption()`)
  - Race protection: `disconnect()` during in-flight derivation → stale `activateEncryption()` never fires
  - Race protection: rapid `connect()` calls → only latest key wins
  - `loadCachedKey()` with and without keyCache configured

### Phase 3: Tab-manager migration

- [ ] **3.1** Refactor `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts` to use the new factory
- [ ] **3.2** Verify tab-manager encryption wiring connects/disconnects on sign-in/sign-out

### Phase 4: Verify

- [ ] **4.1** Run `bun test` in workspace package: all tests pass
- [ ] **4.2** Run `bun run typecheck` across the monorepo
- [ ] **4.3** Verify tab-manager builds: `bun run build` in `apps/tab-manager`

## Success Criteria

- [ ] `createEncryptionWiring()` exported from `@epicenter/workspace/shared/crypto`
- [ ] Factory handles base64 decoding, HKDF derivation, activateEncryption/lock/clearLocalData branching
- [ ] Race protection via generation counter prevents stale activates encryption
- [ ] Duplicate key deduplication prevents redundant `activateEncryption()` rebuilds
- [ ] Optional `keyCache` integration for `connect`/`disconnect`/`loadCachedKey`
- [ ] Tab-manager's `encryption-wiring.svelte.ts` reduced from 58 lines to ~10 lines
- [ ] All tests pass, typecheck clean, tab-manager builds

## References

- `packages/workspace/src/shared/crypto/index.ts`: `base64ToBytes`, `bytesToBase64`, `deriveWorkspaceKey`
- `packages/workspace/src/shared/crypto/key-cache.ts`: `KeyCache` interface
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: `EncryptionMode`, `lock()`, `activateEncryption()` internals
- `packages/workspace/src/workspace/create-workspace.ts`: `lock()`, `activateEncryption()`, `clearLocalData()` implementation
- `packages/workspace/src/workspace/types.ts`: `WorkspaceClient` type with encryption API docs
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts`: current implementation to replace
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: auth state shape (`encryptionKey`, `status`)
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: where `initEncryptionWiring()` is called
- `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md`: HKDF key derivation design
- `specs/20260313T180100-client-side-encryption-wiring.md`: original wiring plan (superseded, useful reference for edge cases)
- `specs/20260315T083000-keycache-chrome-extension.md`: KeyCache integration plan
- `specs/20260315T083500-encryption-mode-renaming.md`: mode naming updated (`'plaintext'`, `'encrypted'`, `'locked'`)

## Execution Notes

**Execution order**: 2nd (after or parallel with KV Simplification)

**Selected over**: `specs/20260315T213228-create-encryption-wiring.md` (subscription-based `EncryptionSource` pattern with `getSnapshot`/`subscribe`). The imperative `connect()`/`disconnect()` API was chosen for simplicity: one consumer today, 2 types vs 5, less adapter boilerplate.

**Dependencies**: None for core factory. Tab-manager migration depends on this existing.

**Note**: Use the NEW mode names (`'plaintext' | 'encrypted' | 'locked'`) during implementation. The mode renaming spec (`20260315T083500`) documents the change.

**Open question resolutions**:
- No `onError` callback: workspace self-heals via built-in rollback on retry
- Single client per factory: one factory per workspace, create N wirings for N workspaces
- No Svelte adapter in-package: 5 lines of `$effect` glue is trivially portable
- No `deriveKey` override: no consumer needs it today, add when one appears
