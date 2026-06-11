# WorkspaceClient Surface Audit

**Date**: 2026-03-15
**Status**: Draft
**Author**: AI-assisted

## Overview

The encryption branch added four members to `WorkspaceClient`: `mode`, `lock()`, `activateEncryption(key)`, and `clearLocalData()`. It also renamed `destroy()` → `dispose()` and introduced a `clearData` lifecycle hook for extensions. This spec audits that surface area for unnecessary exposure, naming confusion, and leaky abstractions. Then proposes a tighter API shape.

## Motivation

### Current State

`WorkspaceClient` is the type every feature developer touches. After the encryption work, it carries five encryption-related members:

```typescript
// packages/workspace/src/workspace/types.ts (lines 1238-1438)
export type WorkspaceClient<...> = {
  id: TId;
  ydoc: Y.Doc;
  tables: TablesHelper<TTableDefinitions>;
  kv: KvHelper<TKvDefinitions>;
  awareness: AwarenessHelper<TAwarenessDefinitions>;
  extensions: TExtensions;
  documents: DocumentsHelper<TTableDefinitions>;
  definitions: { tables; kv; awareness };

  // ── Encryption surface (new) ──────────────
  readonly mode: EncryptionMode;
  lock(): void;
  activateEncryption(key: Uint8Array): void;

  // ── Lifecycle ─────────────────────────────
  batch(fn: () => void): void;
  whenReady: Promise<void>;
  dispose(): Promise<void>;
  clearLocalData(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
```

The entire codebase has **one runtime caller** for `lock()`, `activateEncryption()`, `mode`, and `clearLocalData()`: the encryption wiring file:

```typescript
// apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts (58 lines total)
export function initEncryptionWiring() {
  return $effect.root(() => {
    $effect(() => {
      const keyBase64 = authState.encryptionKey;
      const status = authState.status;

      if (keyBase64) {
        const userKey = base64ToBytes(keyBase64);
        void deriveWorkspaceKey(userKey, workspaceClient.id).then((wsKey) => {
          workspaceClient.activateEncryption(wsKey);        // ← only caller
        });
      } else if (workspaceClient.mode === 'encrypted') {  // ← only reader
        if (status === 'signing-out') {
          void workspaceClient.clearLocalData(); // ← only caller
        } else {
          workspaceClient.lock();                // ← only caller
        }
      }
    });
  });
}
```

This creates problems:

1. **Wiring-only methods on a feature-facing type.** No feature developer, UI component, or action handler ever calls `lock()` or `activateEncryption()`. They're imperative escape hatches for the wiring layer, but they show up in autocomplete for every `client.` keystroke.

2. **Inconsistent `ExtensionContext` omissions.** Extensions already can't see `dispose` or `clearLocalData` (omitted via `Omit<WorkspaceClient, ...>`), but they CAN see `lock()`, `activateEncryption()`, and `mode`. If extensions shouldn't control lifecycle, they shouldn't control encryption lifecycle either.

3. **`clearLocalData()` naming is misleading.** The method does two things: locks encryption AND wipes extension persistence. The name suggests only the second.

### Desired State

A `WorkspaceClient` where feature developers see tables, KV, awareness, documents, batch, and read-only status. Encryption lifecycle control lives on a narrow interface that only the wiring layer imports.

## Research Findings

### Who calls what

Exhaustive search across `packages/workspace/`, `apps/epicenter/`, `apps/tab-manager/`, and all other apps:

| Member             | Runtime call sites | Location                        | Caller type   |
| ------------------ | ------------------ | ------------------------------- | ------------- |
| `lock()`           | 1                  | `encryption-wiring.svelte.ts`   | Wiring        |
| `activateEncryption(key)`      | 1                  | `encryption-wiring.svelte.ts`   | Wiring        |
| `mode`             | 1 (guard)          | `encryption-wiring.svelte.ts`   | Wiring        |
| `clearLocalData()` | 1                  | `encryption-wiring.svelte.ts`   | Wiring        |
| `dispose()`        | 0 app-level        | Framework internal only         | Framework     |
| `batch()`          | Feature code       | Various                         | Feature       |
| `whenReady`        | Feature code       | UI render gates                 | Feature       |

**Key finding**: All four encryption members are called exclusively from wiring code. Zero feature-level consumers exist.

### Extension `clearData` implementations

| Extension              | File                                          | `dispose()` | `clearData()` |
| ---------------------- | --------------------------------------------- | ----------- | -------------- |
| `indexeddbPersistence`  | `packages/workspace/src/extensions/sync/web.ts` | `idb.destroy()` | `idb.clearData()` |
| `createSyncExtension`  | `packages/workspace/src/extensions/sync.ts`    | `provider.dispose()` |: |
| `broadcastChannelSync` | `packages/workspace/src/extensions/sync/broadcast-channel.ts` | Channel close |: |
| Desktop persistence     | `packages/workspace/src/extensions/sync/desktop.ts` | Compaction + cleanup |: |

**Key finding**: Only `indexeddbPersistence` implements `clearData`. The semantics are genuinely different from `dispose`: one wipes data while keeping the client alive; the other releases resources while preserving data. They're not the same operation with a flag.

### Quarantine exposure

The `YKeyValueLwwEncrypted<T>` type has a `quarantine` member (entries that failed to decrypt). The type chain from `WorkspaceClient` to implementation:

```
WorkspaceClient
  ├── tables: TablesHelper<T>  →  TableHelper<TRow>  →  CRUD methods
  ├── kv: KvHelper<T>          →  get/set/delete/observe
  └─ mode: EncryptionMode     →  'plaintext' | 'locked' | 'encrypted'
                                   (only public encryption surface)

Internal (not on WorkspaceClient):
  └── encryptedStores[]  →  YKeyValueLwwEncrypted<T>
                              ├── quarantine: ReadonlyMap<...>
                              ├── map: Map<...>  (decrypted cache)
                              └── lock/activateEncryption/mode
```

**Key finding**: `quarantine` does not leak into `WorkspaceClient`, `TableHelper`, or `KvHelper`. The abstraction boundary is clean. `EncryptionMode` is the only encryption type re-exported from the package index. Intentional and benign.

### Precedent: IndexedDB persistence

IndexedDB persistence (`y-indexeddb`) exposes `provider.destroy()` and `provider.clearData()` on the provider instance. But neither method appears on `WorkspaceClient`. They're internal to the extension lifecycle. The client calls `dispose()` or `clearLocalData()` and the framework dispatches to the right extension hooks. Lock/activateEncryption should follow the same pattern: internal to the encryption machinery, dispatched by the framework, not exposed on the client.

## Design Decisions

### 1. Move `lock()` and `activateEncryption()` off the public type

#### Option A: Extract a `WorkspaceEncryptionControl` interface (Recommended)

Create a narrow interface the wiring layer imports directly:

```typescript
// New type in packages/workspace/src/workspace/types.ts
export type WorkspaceEncryptionControl = {
  id: string;
  readonly mode: EncryptionMode;
  lock(): void;
  activateEncryption(key: Uint8Array): void;
  lockAndClear(): Promise<void>;  // renamed clearLocalData
};
```

The wiring function's signature changes from accepting the full client to accepting this interface:

```typescript
// Before
function initEncryptionWiring(client: WorkspaceClient<...>) { ... }

// After
function initEncryptionWiring(control: WorkspaceEncryptionControl) { ... }
```

`createWorkspace` returns the full client as before, but `WorkspaceClient` omits the encryption control methods. The runtime object still has them. Consumers just need to cast or use the narrow type.

**Pros:**
- Feature developers never see `lock`/`activateEncryption` in autocomplete
- Wiring layer gets exactly the interface it needs. Nothing more
- `ExtensionContext` omission list stays consistent (already omits lifecycle methods)
- Follows the same pattern as IndexedDB persistence internals

**Cons:**
- Introduces a new type that must stay in sync with the client implementation
- The runtime object still has these methods; a determined consumer can access them via `as any` or by importing the narrow type

#### Option B: Omit from `WorkspaceClient`, keep on `WorkspaceClientBuilder`

The builder already has a wider type than the final client. Lock/activateEncryption could live on the builder only, accessible during setup but not after `.withActions()` seals the client.

**Pros:**
- No new type. Uses existing builder/client distinction
- Natural temporal scoping: setup phase has access, runtime doesn't

**Cons:**
- The builder is returned from `createWorkspace()` before extensions are added. Encryption wiring runs after extension chaining is complete, so the builder type is gone by the time you need lock/activateEncryption
- Conflates "building" with "wiring". They're different phases

#### Option C: Keep on `WorkspaceClient`, omit from `ExtensionContext`

Add `lock`, `activateEncryption`, and `mode` to the `ExtensionContext` omit list alongside `dispose` and `clearLocalData`. The full client still has them, but extensions don't see them.

```typescript
// Current
type ExtensionContext<...> = Omit<WorkspaceClient<...>,
  'dispose' | 'clearLocalData' | typeof Symbol.asyncDispose
>;

// Proposed
type ExtensionContext<...> = Omit<WorkspaceClient<...>,
  'dispose' | 'clearLocalData' | 'lock' | 'activateEncryption' | typeof Symbol.asyncDispose
>;
```

**Pros:**
- Minimal change. One line diff
- Extensions can't call lock/activateEncryption (good)

**Cons:**
- Feature developers still see lock/activateEncryption on the client in UI components, action handlers, etc.
- Doesn't solve the autocomplete pollution for the primary consumer type

#### Option D: Do nothing

Leave the current surface as-is.

**Pros:**
- Zero work
- Having the methods visible is arguably "honest". The client does support locking

**Cons:**
- Autocomplete noise for every feature developer
- Inconsistent with the `ExtensionContext` omission pattern already in place for `dispose`/`clearLocalData`
- Every new workspace app will have these methods in autocomplete even if encryption is never used

### 2. Should `mode` stay on the public type?

#### Option A: Keep `mode` as read-only on `WorkspaceClient` (Recommended)

`mode` is informational, not imperative. It's a read-only status indicator, unlike `lock()`/`activateEncryption()` which are commands. A UI component showing a lock icon or gating features on encryption status is a likely near-future use case.

```typescript
// WorkspaceClient keeps:
readonly mode: EncryptionMode;
```

If lock/activateEncryption move to a wiring interface, `mode` lives on both: public as read-only (informational), wiring interface as part of the control surface (used for guards).

**Pros:**
- Cheap to have, expensive to add back later
- Legitimate UI use cases (lock icon, feature gating, "workspace encrypted" badge)
- Read-only signals intent: you can observe it but not change it

**Cons:**
- For plaintext-only workspaces, `mode` is always `'plaintext'`: noise if encryption is never used

#### Option B: Remove `mode` from public type, keep only on wiring interface

If no UI consumer exists yet, don't expose it. Add it back when a UI component actually needs it.

**Pros:**
- Strictly minimal surface
- YAGNI. No UI consumer exists today

**Cons:**
- Adding a member to a public type later is a minor API change that touches types, tests, and docs
- `mode` is a cheap read-only property; removing it just to re-add it is churn

### 3. Rename `clearLocalData()`

#### Option A: `lockAndClear()` (Recommended)

The method does two things: (1) locks encryption (clears key, blocks writes), (2) wipes extension persistence via `clearData()` callbacks. The name `lockAndClear` describes both steps without leaking auth concepts into the workspace layer.

```typescript
// Before
clearLocalData(): Promise<void>;

// After
lockAndClear(): Promise<void>;
```

**Pros:**
- Accurately describes both steps
- No auth coupling. The workspace package doesn't know about sessions
- Makes it obvious this is more destructive than a plain `lock()`

**Cons:**
- "lockAndClear" could be read as "lock the data and then clear the lock" by someone unfamiliar with the codebase
- Slightly unusual method name

#### Option B: `signOut()`

The actual semantic from the caller's perspective. The encryption wiring calls this on sign-out.

**Pros:**
- Clearest intent for the caller
- Matches what the user mentally models

**Cons:**
- Couples naming to an auth concept the workspace package has no knowledge of
- Workspace is a data layer. It shouldn't know what "signing out" means
- Misleading if called for non-auth reasons (e.g., "reset workspace to clean state")

#### Option C: `wipeAndLock()`

Same idea as `lockAndClear()` but emphasizes the data destruction first.

**Pros:**
- "Wipe" is stronger than "clear". Signals destructiveness
- Order of words matches execution order (lock happens first in code, but the wipe is the more significant action)

**Cons:**
- Execution order is actually lock-then-clear; name suggests wipe-then-lock
- "Wipe" might be too strong for clearing IndexedDB (it's local persistence, not deletion of cloud data)

#### Option D: Keep `clearLocalData()`

Leave as-is.

**Pros:**
- Zero renaming churn
- "Clear local data" is descriptively accurate for step 2

**Cons:**
- Completely omits step 1 (locking). A developer reading `clearLocalData()` doesn't expect it to also lock encryption and block writes
- The JSDoc has to do the heavy lifting that the name should handle

### 4. Extension `clearData` hook granularity

#### Option A: Keep `clearData` as a separate optional hook (Recommended)

The current design has `clearData` as an optional member on the `Extension<T>` type, alongside the required `dispose` and `whenReady`:

```typescript
// packages/workspace/src/workspace/lifecycle.ts
export type Extension<T> = T & {
  whenReady: Promise<void>;
  dispose: () => MaybePromise<void>;
  clearData?: () => MaybePromise<void>;  // optional, persistence-only
};
```

Only one extension (`indexeddbPersistence`) implements it. The semantics are genuinely different:

- `dispose()`: Release resources, keep data. Called on normal shutdown.
- `clearData()`: Wipe data, keep client alive. Called on sign-out.

These happen at different times in different contexts. `clearLocalData()` calls `clearData()` without disposing. `dispose()` is called without clearing data. They're independent lifecycle events.

**Pros:**
- Opt-in: 5 of 6 extensions never touch it
- Clean semantics: dispose ≠ wipe
- Framework calls them independently. Not a parameter on the same method

**Cons:**
- Extension authors must learn a third lifecycle hook exists (even if they usually ignore it)

#### Option B: `dispose({ clearData: true })`

Merge clearData into dispose as a parameter.

**Pros:**
- One fewer lifecycle hook to learn
- Conceptually simpler for extension authors who never need clearData

**Cons:**
- **Lifecycle conflict**: `clearLocalData()` calls `clearData()` without disposing. If clear is a parameter on dispose, you'd be calling `dispose({ clearData: true })` but meaning "don't actually dispose." That's contradictory
- **Overloaded semantics**: `dispose` means "I'm done with this resource." Adding clearData makes it "I'm done with this resource AND/OR delete its data". Which overloads the concept
- **Extension author burden**: Every `dispose` implementation now has an optional parameter, even though 5 of 6 extensions would ignore it

### 5. Quarantine exposure

#### Option A: No changes needed (Recommended)

Quarantine is fully internal. The type chain is:

```
WorkspaceClient → TablesHelper → TableHelper<TRow>    (no quarantine)
WorkspaceClient → KvHelper<T>                          (no quarantine)
                     ↓ (internal)
                  YKeyValueLwwEncrypted<T>.quarantine   (internal only)
```

`quarantine` is on `YKeyValueLwwEncrypted<T>`, which is not exported from the package index. `TableHelper` and `KvHelper` see only plaintext via the encrypted wrapper's `map` property. Decrypt failures are logged via `console.warn` and quarantined silently.

**Pros:**
- Clean abstraction boundary
- Feature developers never encounter decrypt failures in types
- Console warnings provide debug visibility without API surface

**Cons:**
- No UI feedback mechanism for "N entries couldn't decrypt". If the wrong key is used, entries silently return `undefined`

#### Option B: Add a top-level `quarantineCount` to WorkspaceClient

If a future UI needs to show "3 entries failed to decrypt. Try a different key":

```typescript
readonly quarantineCount: number;
```

**Pros:**
- Minimal surface (one number, not the full map)
- Enables UI feedback for wrong-key scenarios

**Cons:**
- No consumer exists yet. YAGNI
- Can be added later without breaking changes

**Recommendation**: Don't add it until a UI component actually needs it.

## Architecture

### Current WorkspaceClient surface

```
┌─────────────────────────────────────────────────────────┐
│  WorkspaceClient<TId, TTables, TKv, TAwareness, TExt>   │
│                                                         │
│  Feature surface (daily use)                            │
│  ├── id, ydoc, definitions                              │
│  ├── tables: TablesHelper<TTables>                      │
│  ├── documents: DocumentsHelper<TTables>                │
│  ├── kv: KvHelper<TKv>                                  │
│  ├── awareness: AwarenessHelper<TAwareness>              │
│  ├── extensions: TExt                                   │
│  ├── batch(fn)                                          │
│  └── whenReady: Promise<void>                           │
│                                                         │
│  Encryption surface (wiring-only)     ← AUDIT TARGET   │
│  ├── mode: EncryptionMode (read-only)                   │
│  ├── lock()                                             │
│  └── activateEncryption(key)                                        │
│                                                         │
│  Lifecycle surface (framework-only)                     │
│  ├── dispose()                                          │
│  ├── clearLocalData()                                   │
│  └── [Symbol.asyncDispose]()                            │
└─────────────────────────────────────────────────────────┘
```

### Proposed WorkspaceClient surface

```
┌─────────────────────────────────────────────────────────┐
│  WorkspaceClient<TId, TTables, TKv, TAwareness, TExt>   │
│                                                         │
│  Feature surface (daily use)                            │
│  ├── id, ydoc, definitions                              │
│  ├── tables, documents, kv, awareness, extensions       │
│  ├── batch(fn)                                          │
│  ├── whenReady: Promise<void>                           │
│  └── mode: EncryptionMode (read-only, informational)    │
│                                                         │
│  Lifecycle surface (framework-only)                     │
│  ├── dispose()                                          │
│  ├── lockAndClear()          ← renamed clearLocalData   │
│  └── [Symbol.asyncDispose]()                            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  WorkspaceEncryptionControl                             │
│                                                         │
│  Wiring-only interface (encryption-wiring.svelte.ts)    │
│  ├── id: string                                         │
│  ├── mode: EncryptionMode (read-only)                   │
│  ├── lock()                                             │
│  ├── activateEncryption(key: Uint8Array)                            │
│  └── lockAndClear(): Promise<void>                      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  ExtensionContext (already exists, updated omit list)    │
│                                                         │
│  = Omit<WorkspaceClient,                                │
│      'dispose' | 'lockAndClear' | asyncDispose>         │
│                                                         │
│  Extensions see: tables, kv, awareness, documents,      │
│    extensions, batch, whenReady, mode, id, ydoc,        │
│    definitions                                          │
│                                                         │
│  Extensions do NOT see: lock, activateEncryption, dispose,          │
│    lockAndClear, [Symbol.asyncDispose]                  │
│    (lock/activateEncryption are not on WorkspaceClient at all)      │
└─────────────────────────────────────────────────────────┘
```

### Extension lifecycle (unchanged)

```
Extension<T> = T & {
  whenReady: Promise<void>;      // required (defaulted)
  dispose: () => MaybePromise;   // required (defaulted)
  clearData?: () => MaybePromise; // optional (persistence only)
}

Normal shutdown:     dispose() on each extension (LIFO)
Sign-out:            lock() → clearData() on each extension (LIFO)
                     Client stays alive for re-signin
```

## Implementation Plan

### Phase 1: Type changes

- [ ] **1.1** Add `WorkspaceEncryptionControl` type to `packages/workspace/src/workspace/types.ts`
- [ ] **1.2** Remove `lock()` and `activateEncryption(key)` from `WorkspaceClient` type
- [ ] **1.3** Rename `clearLocalData` → `lockAndClear` on `WorkspaceClient` type
- [ ] **1.4** Update `ExtensionContext` omit list (`clearLocalData` → `lockAndClear`)
- [ ] **1.5** Export `WorkspaceEncryptionControl` from package index

### Phase 2: Runtime changes

- [ ] **2.1** Rename `clearLocalData` → `lockAndClear` in `create-workspace.ts` client object
- [ ] **2.2** Update `encryption-wiring.svelte.ts` to use the narrow `WorkspaceEncryptionControl` type (the runtime object is the same, just typed narrower)
- [ ] **2.3** Update JSDoc on `lockAndClear` to reflect the new name

### Phase 3: Downstream updates

- [ ] **3.1** Update any specs referencing `clearLocalData` (e.g., `encryption-wiring-factory.md`)
- [ ] **3.2** Update any tests referencing `clearLocalData`
- [ ] **3.3** Search for string literal `'clearLocalData'` across codebase in case of dynamic references

## Edge Cases

### None-mode workspace with no encryption

1. Workspace created without a key → `mode` is `'plaintext'`
2. Wiring layer never calls `lock()` or `activateEncryption()`
3. `lockAndClear()` calls `lock()` internally → no-op on plaintext-mode stores, then runs `clearData()` callbacks normally
4. No behavioral change

### Extension that implements `clearData` but not `dispose`

1. Extension returns `{ clearData: () => wipeDB() }` without a `dispose`
2. `defineExtension()` defaults `dispose` to no-op
3. `lockAndClear()` calls `clearData()` ✓, `dispose()` calls no-op ✓
4. Works correctly

### Runtime object vs type

1. After removing `lock`/`activateEncryption` from the `WorkspaceClient` type, the runtime object returned by `createWorkspace()` still has these methods
2. A consumer could access them via `(client as any).lock()` or by importing `WorkspaceEncryptionControl` and casting
3. This is acceptable. TypeScript types are guardrails, not walls. The goal is autocomplete cleanliness and API signaling, not runtime enforcement

## Open Questions

1. **Should `lock()` and `activateEncryption()` also be removed from the runtime object, or just the type?**
   - Options: (a) Type-only removal (methods still exist at runtime, just not on the type), (b) Runtime removal (methods moved to a separate object returned by `createWorkspace`)
   - **Recommendation**: Type-only removal. The wiring layer casts to `WorkspaceEncryptionControl` and gets what it needs. Restructuring the runtime object to return two objects is over-engineering for one call site.

2. **Should `lockAndClear()` also move to the wiring-only interface?**
   - It's currently on `WorkspaceClient` and omitted from `ExtensionContext` (same as `dispose`). The wiring layer is its only caller, same as `lock`/`activateEncryption`.
   - Options: (a) Keep on `WorkspaceClient` alongside `dispose` (both are lifecycle methods), (b) Move to `WorkspaceEncryptionControl` only
   - **Recommendation**: Keep on `WorkspaceClient`. It's a lifecycle method like `dispose`: both are "you shouldn't call this from feature code" but they're part of the client's lifecycle contract. Removing lifecycle methods from the primary type would be confusing.

3. **Should `mode` stay on `ExtensionContext`?**
   - Extensions currently see `mode` because `ExtensionContext` only omits `dispose`/`clearLocalData`/`asyncDispose`. An extension might legitimately want to check `mode` (e.g., a sync extension that behaves differently when locked).
   - Options: (a) Keep `mode` on `ExtensionContext`, (b) Omit it
   - **Recommendation**: Keep it. `mode` is read-only and informational. Extensions may have legitimate reasons to check encryption status (e.g., skip sync when locked, show warnings). It's not a control surface.

4. **Naming: `lockAndClear` vs `wipeAndLock` vs `clearAndLock` vs something else?**
   - The audit recommends `lockAndClear` but naming is subjective. The execution order is lock-then-clear, so `lockAndClear` matches. But the significant action is the clear. Lock is a side effect.
   - **Recommendation**: Decide during implementation. `lockAndClear` is the default unless you feel differently.

## Success Criteria

- [ ] `WorkspaceClient` type no longer exposes `lock()` or `activateEncryption()`
- [ ] `clearLocalData` renamed to `lockAndClear` (or chosen alternative) across types, implementation, and call sites
- [ ] `WorkspaceEncryptionControl` type exported from package index
- [ ] `encryption-wiring.svelte.ts` uses `WorkspaceEncryptionControl` instead of the full client type
- [ ] `ExtensionContext` omit list updated for the rename
- [ ] All existing tests pass (no behavioral changes, only type/name changes)
- [ ] `mode` remains on `WorkspaceClient` as read-only
- [ ] Extension `clearData` hook unchanged

## References

- `packages/workspace/src/workspace/types.ts`: `WorkspaceClient`, `ExtensionContext`, `WorkspaceClientBuilder` types
- `packages/workspace/src/workspace/create-workspace.ts`: Runtime client assembly, `clearLocalData` implementation
- `packages/workspace/src/workspace/lifecycle.ts`: `Extension<T>` type, `defineExtension()`, `clearData` hook
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: `YKeyValueLwwEncrypted<T>`, quarantine, `EncryptionMode`
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts`: Sole runtime consumer of lock/activateEncryption/mode/clearLocalData
- `packages/workspace/src/extensions/sync/web.ts`: `indexeddbPersistence`, sole `clearData` implementor
- `specs/20260315T141700-encryption-wiring-factory.md`: Prior spec referencing the encryption surface

## Execution Notes

**Execution order**: 3rd (after Encryption Wiring Factory)

**Dependencies**: Encryption Wiring Factory (spec `20260315T141700`) must be implemented first: the factory already types its client narrowly as `EncryptionWiringClient`, which becomes the basis for `WorkspaceEncryptionControl`.

**Decision resolutions**:
- **`clearLocalData` naming**: Keep `clearLocalData()`. Do NOT rename to `lockAndClear()`. The JSDoc already describes both steps (lock + wipe). Renaming adds churn across specs, tests, and consumers for marginal clarity.
- **lock/activateEncryption removal**: Option A: type-only removal. Runtime object keeps the methods; `WorkspaceClient` type hides them. Wiring layer uses `WorkspaceEncryptionControl`.
- **`mode` on WorkspaceClient**: Keep as read-only. Informational, legitimate UI use cases (lock icon, feature gating).
- **`mode` on ExtensionContext**: Keep. Read-only, extensions may check encryption status.
- **Quarantine exposure**: No changes needed: already fully internal.
- **`lockAndClear` on wiring interface**: Keep `clearLocalData` on `WorkspaceClient` alongside `dispose`: both are lifecycle methods.

**Note**: After this spec executes, `WorkspaceClient` will no longer expose `lock()` or `activateEncryption()` in its type. The encryption wiring (now using the factory) will import `WorkspaceEncryptionControl` for the narrow interface.

## Review

**Executed**: 2026-03-16

### Changes made

1. **`packages/workspace/src/workspace/types.ts`**:
   - Added `WorkspaceEncryptionControl` type with `id`, `mode`, `lock()`, `activateEncryption()`, `clearLocalData()`
   - Removed `lock()` and `activateEncryption()` from `WorkspaceClient` type (type-only: runtime object unchanged)
   - `mode` and `clearLocalData()` remain on `WorkspaceClient`

2. **`packages/workspace/src/workspace/index.ts`**: Exported `WorkspaceEncryptionControl`

3. **`packages/workspace/src/index.ts`**: Exported `WorkspaceEncryptionControl` from package root

4. **`apps/tab-manager/src/lib/state/key-manager.svelte.ts`**: Cast `workspaceClient` through `WorkspaceEncryptionControl` for `createKeyManager()` since the client type no longer exposes `lock()`/`activateEncryption()`

5. **`packages/workspace/src/workspace/create-workspace.test.ts`**: Updated encryption test helper to return an `encryption` reference (`WorkspaceEncryptionControl` cast) for lock/activateEncryption calls while keeping `client` for data operations and mode checks

### Deviations from spec

- **`encryption-wiring.svelte.ts`** no longer exists: replaced by `key-manager.svelte.ts` + `createKeyManager` factory (Encryption Wiring Factory spec already executed)
- **`EncryptionWiringClient`** renamed to `KeyManagerTarget`: lives in `packages/workspace/src/shared/crypto/key-manager.ts`. Left as-is; `WorkspaceEncryptionControl` is the public type, `KeyManagerTarget` is the internal key-manager interface. Structurally compatible (WEC ⊃ KMT)
- **`clearLocalData` NOT renamed**: per explicit instruction, kept current name
- **`ExtensionContext` unchanged**: `lock()`/`activateEncryption()` removal from `WorkspaceClient` automatically excludes them from `ExtensionContext` via existing `Omit<>`. No omit list update needed

### Verification

- `bun run typecheck` in `packages/workspace`: ✓ (pre-existing errors in ingest/, define-table.ts unrelated)
- `bun run typecheck` in `apps/tab-manager`: ✓ (pre-existing UI package `#/utils.js` resolution errors unrelated)
- `bun test` in `packages/workspace`: 498 pass, 0 fail
