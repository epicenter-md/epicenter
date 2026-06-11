# Shared Encryption Wiring Factory

**Date**: 2026-03-15
**Status**: Superseded by `specs/20260315T141700-encryption-wiring-factory.md`: the imperative `connect()`/`disconnect()` API was chosen over the subscription-based `EncryptionSource` pattern for simplicity (one consumer today, fewer types, less adapter boilerplate).
**Author**: AI-assisted

## Overview

Extract a framework-agnostic `createEncryptionWiring()` factory from the tab-manager's bespoke Svelte wiring into `@epicenter/workspace`. The factory handles the hard parts. Async key derivation with race protection, three-way key-loss branching, and mode guard logic. So apps provide only a thin adapter that maps their auth state into a normalized snapshot.

## Motivation

### Current State

The tab-manager has a 58-line `encryption-wiring.svelte.ts` that wires auth state to workspace lock/activateEncryption:

```typescript
// apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts
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

It's consumed exactly once, in `App.svelte`:

```typescript
onMount(() => {
  authState.checkSession();
  const cleanupEncryption = initEncryptionWiring();
  // ...
  return () => { cleanupEncryption(); };
});
```

This creates problems:

1. **Stale async derive race**: `deriveWorkspaceKey()` is async (HKDF via Web Crypto). Nothing prevents a slow derivation from completing after auth has moved on. If a user signs out while HKDF is still running, the stale `.then()` calls `activateEncryption()` after `clearLocalData()` already ran. Corrupting state.

2. **Framework coupling**: `$effect.root` + `$effect` makes this non-portable. Tests, Tauri commands, service workers, and non-Svelte consumers can't use it.

3. **Copy-paste multiplication**: Every new Epicenter app (Whispering is next) must replicate the same subtle three-way branch logic, the same HKDF wiring, the same guard conditions. Getting any of them wrong either soft-locks a `plaintext`-mode workspace or skips cleanup on sign-out.

4. **Opaque timing gap**: Between `authState.encryptionKey` becoming non-null and `activateEncryption()` completing, the workspace is in its previous mode. Consumers have no way to know "key derivation is in progress". They must guess.

5. **Implicit auth semantics in wiring**: The three-way branch requires reading `authState.status` to distinguish sign-out from session expiry from "never had a key." This couples auth-domain knowledge into what should be pure workspace orchestration.

### Desired State

```typescript
// packages/workspace: framework-agnostic core
import { createEncryptionWiring } from '@epicenter/workspace';

const wiring = createEncryptionWiring(workspaceClient, {
  source: myAuthSource, // normalized snapshot interface
});

wiring.phase;     // 'idle' | 'deriving' | 'clearing'
wiring.whenReady; // Promise<void>: first snapshot fully settled
wiring.dispose(); // cleanup
```

```typescript
// apps/tab-manager: thin Svelte adapter (~20 lines)
const source = createSvelteEncryptionSource(authState);
const wiring = createEncryptionWiring(workspaceClient, { source });
// dispose on cleanup
```

## Research Findings

### Existing Encryption Infrastructure

| Component | Location | Role |
|---|---|---|
| `deriveWorkspaceKey()` | `packages/workspace/src/shared/crypto/index.ts` | HKDF-SHA256 via Web Crypto, async, `(userKey: Uint8Array, workspaceId: string) => Promise<Uint8Array>` |
| `base64ToBytes()` | Same file | Sync base64 decode: transport concern, not crypto |
| `EncryptionMode` | `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` | `'plaintext' \| 'locked' \| 'encrypted'`: the workspace mode state |
| `WorkspaceClient.activateEncryption()` | `packages/workspace/src/workspace/create-workspace.ts` | Sync: sets key on all encrypted stores, rolls back on failure |
| `WorkspaceClient.lock()` | Same file | Sync: clears key, cached data stays |
| `WorkspaceClient.clearLocalData()` | Same file | Async: calls `lock()` + extension `clearData` callbacks in LIFO order |
| `authState` | `apps/tab-manager/src/lib/state/auth.svelte.ts` | Svelte 5 reactive singleton with `encryptionKey: string \| undefined` and `status: AuthPhase['status']` |

### Cross-App Survey

| App | Has encryption wiring? | Auth integration? |
|---|---|---|
| `apps/tab-manager` | Yes: `encryption-wiring.svelte.ts` (58 lines) | Yes: Better Auth via `auth.svelte.ts` |
| `apps/whispering` | No | No auth yet (Tauri desktop app) |
| `apps/api` | N/A (server) | Server-side key derivation |

Only tab-manager has this today. Whispering will need it when auth is added. The API server derives keys server-side (different flow, not relevant here).

### The Auth → Encryption Reactive Chain

```
authState.encryptionKey (base64 string | undefined)
authState.status ('checking' | 'signing-in' | 'signing-out' | 'signed-in' | 'signed-out')
     │
     │  Svelte $effect reads both reactively
     ▼
┌─────────────────────────────────────────────────────────┐
│  Three-way branch:                                       │
│                                                          │
│  key present?                                            │
│    → base64ToBytes → deriveWorkspaceKey → activateEncryption         │
│                                                          │
│  key null + mode encrypted + signing-out?                  │
│    → clearLocalData (wipe IndexedDB)                     │
│                                                          │
│  key null + mode encrypted + other?                        │
│    → lock (soft, data preserved)                         │
│                                                          │
│  key null + mode NOT encrypted?                            │
│    → no-op (never had a key, or already locked)          │
└─────────────────────────────────────────────────────────┘
     │
     ▼
workspaceClient.mode changes: 'plaintext' → 'encrypted' → 'locked' → ...
```

### Auth State Transition Sequence (from `auth.svelte.ts`)

The sign-out flow sets state in this order:
1. `phase = { status: 'signing-out' }`: synchronous
2. `await client.signOut()`: server-side invalidation
3. `await clearState()`: clears token + user from chrome.storage
4. `encryptionKey = undefined`: **this triggers the encryption wiring**
5. `phase = { status: 'signed-out' }`: synchronous

The encryption wiring sees the key go null while status is still `'signing-out'`. This is how it distinguishes sign-out from session expiry.

### Extension Pattern Assessment

The workspace extension chain (`.withExtension()`, `.withWorkspaceExtension()`) is designed for startup/lifecycle concerns. Persistence, sync, broadcast. Extensions fire once at build time, return `{ whenReady, dispose, clearData }`, and are tied to the Y.Doc lifecycle.

Encryption wiring is fundamentally different:
- It's **long-lived auth orchestration**, not startup initialization
- It reacts to **external state changes** (auth events), not workspace events
- It needs to **run and re-run** throughout the app lifetime, not fire once
- It logically **sits between** auth and workspace. Not inside workspace

Forcing it into the extension chain would misuse the pattern. A standalone factory is the right shape.

### `useSyncExternalStore` Pattern

The `getSnapshot + subscribe` pattern (from React's `useSyncExternalStore`) is the established approach for bridging external state into framework-agnostic consumers:
- `getSnapshot()`: Read current value synchronously (needed for initial state + consistency)
- `subscribe(listener)`: Get notified of changes (needed for reactivity)

This avoids two failure modes:
- Pure subscribe is brittle on startup (misses initial state)
- Pure getter has no change trigger (requires polling)

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Extension vs standalone | **Standalone factory** | Extension chain is startup/lifecycle-oriented. Encryption wiring is long-lived auth orchestration. Different lifecycle shape. Standalone is testable without a Y.Doc. |
| Input contract | **`EncryptionSource` with `getSnapshot + subscribe`** | Avoids startup race (pure subscribe) and polling (pure getter). Matches `useSyncExternalStore` pattern. Framework-agnostic. |
| Key format accepted | **`Uint8Array` (user key bytes)** | Transport encoding (base64) is adapter responsibility. Factory gets raw bytes. Supports password-derived keys, hardware keys, server-provided keys without change. |
| Own `deriveWorkspaceKey` or take pre-derived? | **Own it, with optional override** | 90% case is HKDF. Default to `deriveWorkspaceKey` from `@epicenter/workspace/shared/crypto`. Accept `deriveKey` option for password-based or hardware key sources. |
| Timing gap handling | **Expose `phase` property** (`'idle' \| 'deriving' \| 'clearing'`) | Consumers can gate UI on `phase !== 'deriving'`. More useful than a one-shot `whenUnlocked` promise. Works across multiple lock/activateEncryption cycles. |
| `whenReady` semantics | **Resolves when first snapshot fully settles** | Matches extension `whenReady` convention. For `waiting-for-key`, resolves immediately (no work to do). For `user-key`, resolves after first derive + activateEncryption. |
| Three-way null branch encoding | **Discriminated union in `EncryptionSourceSnapshot`** | `kind: 'no-key', reason: 'signed-out' \| 'session-lost'` makes the branch explicit in the type system. Cleaner than `isSigningOut: boolean` which doesn't capture "waiting for key." |
| Race protection | **Monotonic operation version counter** | Each snapshot gets a version. Late async results (derive, clear) check version before applying. Stale results are silently dropped. |
| Error handling | **`onError` callback, no throws** | Errors in derive or clearLocalData are reported via callback. Never throw out of the subscription loop. That would kill the wiring permanently. |
| `waiting-for-key` behavior | **No-op** | During bootstrap (`checking`, `signing-in`), the wiring does nothing. This is correct. The workspace starts in `plaintext` mode and stays there until a key arrives. |

## Architecture

### Type Definitions

```typescript
// ── Source contract (what the adapter provides) ──────────────────────

type EncryptionSourceSnapshot =
  | { kind: 'waiting-for-key' }
  | { kind: 'user-key'; userKey: Uint8Array }
  | { kind: 'no-key'; reason: 'signed-out' | 'session-lost' };

type EncryptionSource = {
  /** Read current state synchronously. */
  getSnapshot(): EncryptionSourceSnapshot;
  /** Subscribe to changes. Returns unsubscribe function. */
  subscribe(listener: (snapshot: EncryptionSourceSnapshot) => void): () => void;
};

// ── Client contract (narrow interface, not full WorkspaceClient) ─────

type EncryptionWiringClient = {
  readonly id: string;
  readonly mode: 'plaintext' | 'locked' | 'encrypted';
  lock(): void;
  activateEncryption(key: Uint8Array): void;
  clearLocalData(): Promise<void>;
};

// ── Factory output ───────────────────────────────────────────────────

type EncryptionWiringPhase = 'idle' | 'deriving' | 'clearing';

type EncryptionWiring = {
  /** Current operational phase. */
  readonly phase: EncryptionWiringPhase;
  /** Resolves when the first snapshot has been fully processed. */
  readonly whenReady: Promise<void>;
  /** Stop watching and clean up. */
  dispose(): void;
};
```

### Factory Signature

```typescript
function createEncryptionWiring(
  client: EncryptionWiringClient,
  options: {
    source: EncryptionSource;
    /** Override key derivation. Default: HKDF via deriveWorkspaceKey(). */
    deriveKey?: (userKey: Uint8Array, workspaceId: string) => Promise<Uint8Array>;
    /** Called on derive or clearLocalData errors. Default: console.error. */
    onError?: (error: unknown) => void;
  },
): EncryptionWiring;
```

### State Machine

```
                         ┌──────────────────┐
                         │  waiting-for-key  │
                         │    phase: idle     │
                         │    action: no-op   │
                         └──────────────────┘

                         ┌──────────────────────────────────────────────┐
  snapshot: user-key     │  DERIVE FLOW                                 │
  ──────────────────────►│  1. phase = 'deriving'                       │
                         │  2. version = ++counter                      │
                         │  3. wsKey = await deriveKey(userKey, id)     │
                         │  4. if version !== counter → DROP (stale)    │
                         │  5. client.activateEncryption(wsKey)                     │
                         │  6. phase = 'idle'                           │
                         └──────────────────────────────────────────────┘

                         ┌──────────────────────────────────────────────┐
  snapshot: no-key       │  NULL-KEY FLOW                               │
  (reason: session-lost) │                                              │
  ──────────────────────►│  if client.mode === 'encrypted':
                         │    client.lock()                             │
                         │  else: no-op                                 │
                         │  phase = 'idle'                              │
                         └──────────────────────────────────────────────┘

                         ┌──────────────────────────────────────────────┐
  snapshot: no-key       │  CLEAR FLOW                                  │
  (reason: signed-out)   │                                              │
  ──────────────────────►│  if client.mode === 'encrypted':
                         │    1. phase = 'clearing'                     │
                         │    2. version = ++counter                    │
                         │    3. await client.clearLocalData()          │
                         │    4. if version !== counter → already moved │
                         │    5. phase = 'idle'                         │
                         │  else: no-op (already locked or plaintext)   │
                         └──────────────────────────────────────────────┘
```

### Race Protection via Monotonic Version

```
Time ──────────────────────────────────────────────────────────►

  snapshot: user-key (v=1)
  │
  │  deriveKey() starts...          snapshot: no-key/signed-out (v=2)
  │  ╎                              │
  │  ╎  (HKDF running ~1ms)        │  clearLocalData() starts...
  │  ╎                              │  ╎
  │  deriveKey() resolves           │  ╎
  │  version check: 1 !== 2         │  clearLocalData() resolves
  │  → DROPPED (stale)              │  version check: 2 === 2
  │                                 │  → phase = 'idle' ✓
```

Without the version counter, the stale derive would call `activateEncryption()` after `clearLocalData()` had already wiped the workspace. Silently re-unlocking with the old key.

### Svelte Adapter Pattern

```typescript
// apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts

import { createEncryptionWiring, type EncryptionSource } from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';

/**
 * Initialize the encryption wiring as a root effect.
 *
 * Maps `authState` reactive signals into the framework-agnostic
 * `EncryptionSource` contract, then delegates all lock/activateEncryption/clear
 * logic to `createEncryptionWiring()`.
 *
 * @returns Cleanup function (call from onMount cleanup)
 */
export function initEncryptionWiring() {
  const source: EncryptionSource = {
    getSnapshot() {
      const keyBase64 = authState.encryptionKey;
      const status = authState.status;

      if (keyBase64) {
        return { kind: 'user-key', userKey: base64ToBytes(keyBase64) };
      }

      const isBootstrapping = status === 'checking' || status === 'signing-in';
      if (isBootstrapping) {
        return { kind: 'waiting-for-key' };
      }

      const isSigningOut = status === 'signing-out';
      if (isSigningOut) {
        return { kind: 'no-key', reason: 'signed-out' };
      }

      return { kind: 'no-key', reason: 'session-lost' };
    },

    subscribe(listener) {
      return $effect.root(() => {
        $effect(() => {
          // Touch reactive dependencies to track them
          authState.encryptionKey;
          authState.status;
          listener(source.getSnapshot());
        });
      });
    },
  };

  return createEncryptionWiring(workspaceClient, { source }).dispose;
}
```

### File Layout

```
packages/workspace/src/
  workspace/
    create-encryption-wiring.ts       ← core factory (new)
    create-encryption-wiring.test.ts  ← unit tests (new)
  index.ts                            ← re-export createEncryptionWiring

apps/tab-manager/src/lib/state/
  encryption-wiring.svelte.ts         ← rewritten to thin adapter
```

## Implementation Plan

### Phase 1: Core Factory

- [ ] **1.1** Create `packages/workspace/src/workspace/create-encryption-wiring.ts` with the `EncryptionSourceSnapshot`, `EncryptionSource`, `EncryptionWiringClient`, `EncryptionWiringPhase`, and `EncryptionWiring` types
- [ ] **1.2** Implement `createEncryptionWiring()` with the monotonic version counter, snapshot processing, and dispose logic
- [ ] **1.3** Export from `packages/workspace/src/workspace/index.ts`
- [ ] **1.4** Write unit tests in `create-encryption-wiring.test.ts` covering all state transitions and race conditions (see Edge Cases)

### Phase 2: Tab-Manager Adapter

- [ ] **2.1** Rewrite `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts` to the thin Svelte adapter pattern
- [ ] **2.2** Verify `App.svelte` consumption doesn't change (same `initEncryptionWiring()` → cleanup pattern)
- [ ] **2.3** Manual test: sign in → workspace activates encryption, sign out → clearLocalData, session expiry → lock

### Phase 3: Documentation

- [ ] **3.1** Add JSDoc to the factory with `@example` blocks showing both direct usage and Svelte adapter usage
- [ ] **3.2** Add this spec's review section with implementation notes

## Edge Cases

### Stale Derive After Sign-Out

1. User signs in → `user-key` snapshot → `deriveKey()` starts (v=1)
2. User signs out immediately → `no-key/signed-out` snapshot → `clearLocalData()` starts (v=2)
3. `deriveKey()` resolves → version check: `1 !== 2` → **dropped**
4. `clearLocalData()` resolves → version check: `2 === 2` → phase = idle

Expected: Workspace is cleared. Old key never applied.

### Rapid Key Rotation (Sign-Out → Sign-In)

1. User signs out → `no-key/signed-out` → `clearLocalData()` starts (v=1)
2. User signs in quickly → `user-key` → `deriveKey()` starts (v=2)
3. `clearLocalData()` resolves → version check: `1 !== 2` → **dropped** (phase already moved on)
4. `deriveKey()` resolves → version check: `2 === 2` → `activateEncryption()` → phase = idle

Expected: New key wins. Clear result is stale and dropped.

### Bootstrap: No Auth (None Mode Workspace)

1. App starts, no session → `waiting-for-key` snapshot
2. Wiring does nothing, workspace stays in `plaintext` mode
3. `whenReady` resolves immediately (no work to do)

Expected: No-op. None-mode workspaces are unaffected.

### Bootstrap: Cached Session

1. App starts, `checkSession()` running → `waiting-for-key` (status = `'checking'`)
2. Session validated → `user-key` snapshot
3. Normal derive flow

Expected: Wiring waits for auth to settle, then activates encryption.

### Key Derivation Failure

1. `user-key` snapshot → `deriveKey()` starts
2. `deriveKey()` throws (e.g., invalid key length)
3. `onError` callback invoked with the error
4. Phase returns to `idle`. Workspace stays in previous mode.
5. Next snapshot re-triggers the flow

Expected: Error reported, wiring survives. No broken state.

### clearLocalData Failure

1. `no-key/signed-out` → `clearLocalData()` starts
2. Extension `clearData` callback throws
3. `clearLocalData()` itself catches and logs (it already does this)
4. `onError` callback invoked as well
5. Phase returns to `idle`

Expected: Best-effort clear. Wiring doesn't crash.

### Double Dispose

1. Consumer calls `dispose()` twice
2. Second call is a no-op (unsubscribe already ran)

Expected: Idempotent.

### Synchronous Key Availability (Future: Key Cache)

1. If a future key-cache provides a `Uint8Array` synchronously at startup, the source can return `user-key` from `getSnapshot()` on the first call
2. The factory processes it immediately. No "waiting" phase needed
3. `whenReady` resolves after the derive + activateEncryption completes

Expected: Works without changes. The `waiting-for-key` state is optional, not mandatory.

### clearLocalData When Already Locked

1. `no-key/signed-out` snapshot arrives
2. `client.mode` is already `'locked'` (e.g., from a previous session expiry)
3. Guard check: `mode !== 'encrypted'` → **no-op**

Expected: Don't clear data that's already locked. The data might be from a different session that should be preserved for re-login.

## Open Questions

1. **Should `phase` be observable (callback) or just a readable property?**
   - If consumers want to react to phase changes (e.g., show a spinner during `'deriving'`), a callback would be more ergonomic than polling
   - **Recommendation**: Start with a readable property. Add `onPhaseChange` callback if demand appears. YAGNI for now. The main consumer just needs `whenReady`.

2. **Should `clearLocalData` guard check `mode === 'encrypted'` or `mode !== 'plaintext'`?**
   - Current code checks `mode === 'encrypted'`. But what about `mode === 'locked'` + sign-out? Should that also clear?
   - A user who was locked (session expired) and then explicitly signs out might expect their data to be wiped
   - **Recommendation**: Keep `mode === 'encrypted'` guard for now. A locked workspace means the user might re-authenticate. Clearing preemptively is destructive. If needed, the adapter can call `client.clearLocalData()` directly for the locked+sign-out case.

3. **Should `whenReady` reject on derive error, or always resolve?**
   - Rejecting gives consumers an error signal for the initial boot
   - Always resolving is simpler and matches extension `whenReady` convention (extensions log errors, don't reject)
   - **Recommendation**: Always resolve. Report errors via `onError`. This matches the existing extension convention and avoids unhandled rejection footguns.

4. **Should the factory accept multiple workspace clients?**
   - An app might have multiple workspaces (e.g., one for user data, one for shared team data)
   - **Recommendation**: Defer. Create one wiring per client. If a multi-client need appears, compose externally.

5. **Should the `EncryptionSource.subscribe` listener receive the snapshot, or should the factory call `getSnapshot()` itself after notification?**
   - Passing snapshot in the listener avoids a redundant `getSnapshot()` call
   - Calling `getSnapshot()` after notification matches `useSyncExternalStore` semantics more closely and ensures consistency
   - **Recommendation**: Pass the snapshot in the listener for simplicity. The source already computed it. If consistency becomes an issue, switch to the `getSnapshot()` pattern.

## Success Criteria

- [ ] `createEncryptionWiring()` exists in `@epicenter/workspace` with full JSDoc
- [ ] Unit tests pass for all edge cases listed above (especially stale derive race and rapid key rotation)
- [ ] Tab-manager's `encryption-wiring.svelte.ts` is rewritten to the thin adapter pattern (~20-30 lines)
- [ ] Tab-manager behavior is identical: sign in → activateEncryption, sign out → clear, session expiry → lock
- [ ] No Svelte imports in the core factory
- [ ] `phase` property exposes derivation state
- [ ] `whenReady` resolves on first snapshot settlement
- [ ] `dispose()` is idempotent and cleans up the subscription
- [ ] Build passes (`bun run build` in workspace package and tab-manager)
- [ ] Existing tests pass (`bun test` in workspace package)

## References

- `packages/workspace/src/shared/crypto/index.ts`: `deriveWorkspaceKey`, `base64ToBytes` definitions
- `packages/workspace/src/workspace/create-workspace.ts`: `activateEncryption()`, `lock()`, `clearLocalData()` implementations, extension chain pattern
- `packages/workspace/src/workspace/types.ts`: `WorkspaceClient`, `EncryptionMode`, `ExtensionContext` types
- `packages/workspace/src/workspace/lifecycle.ts`: `defineExtension()`, `MaybePromise` patterns
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: `EncryptionMode` type definition
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts`: current implementation (to be rewritten)
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: auth state reactive singleton, sign-out flow sequence
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: consumption site
- `apps/tab-manager/src/lib/workspace.ts`: workspace client instantiation with extensions
