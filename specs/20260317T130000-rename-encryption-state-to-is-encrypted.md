# Rename `encryptionState` to `isEncrypted` Boolean

## Problem

After eliminating locked mode, `EncryptionState` is a union of exactly two values: `'plaintext' | 'encrypted'`. This is a boolean in disguise. Every usage site checks `=== 'encrypted'` or `=== 'plaintext'`, which is just `true`/`false`.

The internal state variable `encryptionState` also duplicates the key's presence. After locked mode removal, `encryptionState === 'encrypted'` is always equivalent to `currentKey !== undefined`. The variable is redundant.

## Decision

- **Collapse to `isEncrypted: boolean`.** Two states representing "on/off" → boolean is the honest type.
- **Eliminate the internal `encryptionState` variable.** Derive `isEncrypted` from `currentKey !== undefined`. Single source of truth.
- **Remove `EncryptionState` type entirely.** No type alias needed for a boolean.
- **Follow the `is`-prefix convention** per the TypeScript skill (just added).

### Before

```typescript
// Type
export type EncryptionState = 'plaintext' | 'encrypted';

// Internal variable
let encryptionState: EncryptionState = currentKey ? 'encrypted' : 'plaintext';

// Getter
get encryptionState() { return encryptionState; }

// Usage
if (encryptionState === 'plaintext') { /* plaintext path */ }
workspace.current.encryptionState === 'encrypted'
```

### After

```typescript
// No type alias needed

// No internal variable: derived from key presence

// Getter
get isEncrypted() { return currentKey !== undefined; }

// Usage
if (!currentKey) { /* plaintext path: internal only */ }
workspace.current.isEncrypted
```

Note: internally, `set()` checks `!currentKey` directly (not `!isEncrypted`) since the getter is on the returned object. The internal branching stays the same. It already checks `currentKey`.

## Todo

### packages/workspace: Core rename

- [x] In `y-keyvalue-lww-encrypted.ts`:
  - Remove the `EncryptionState` type export (line ~109)
  - Remove the `let encryptionState` variable (line ~218)
  - Remove the `encryptionState = 'encrypted'` assignment in `activateEncryption()` (line ~415)
  - Change `set()` from `if (encryptionState === 'plaintext')` to `if (!currentKey)` (line ~333)
  - Change the getter from `get encryptionState() { return encryptionState; }` to `get isEncrypted() { return currentKey !== undefined; }` (line ~465)
  - Update the `YKeyValueLwwEncrypted` type: `readonly encryptionState: EncryptionState` → `readonly isEncrypted: boolean` (line ~136)
  - Update JSDoc references to `encryptionState`
- [x] In `types.ts`:
  - Remove `import type { EncryptionState }` (line ~13)
  - Change `readonly encryptionState: EncryptionState` → `readonly isEncrypted: boolean` on `WorkspaceClient` type (line ~1291)
- [x] In `create-workspace.ts`:
  - Change `get encryptionState()` → `get isEncrypted()` (line ~288)
  - Change `encryptedStores[0]?.encryptionState ?? 'plaintext'` → `encryptedStores[0]?.isEncrypted ?? false` (line ~290)
- [x] In `index.ts`:
  - Remove the `EncryptionState` re-export and its comment (lines ~123-124)
- [x] Update tests in `y-keyvalue-lww-encrypted.test.ts`:
  - Remove `type EncryptionState` import
  - Change `expect(kv.encryptionState).toBe('plaintext' satisfies EncryptionState)` → `expect(kv.isEncrypted).toBe(false)`
  - Change `expect(kv.encryptionState).toBe('encrypted' satisfies EncryptionState)` → `expect(kv.isEncrypted).toBe(true)`
- [x] Update tests in `create-workspace.test.ts`:
  - Change `expect(client.encryptionState).toBe('plaintext')` → `expect(client.isEncrypted).toBe(false)`
  - Change `expect(client.encryptionState).toBe('encrypted')` → `expect(client.isEncrypted).toBe(true)`

### apps/: Consumer updates

- [x] In `encryption-wiring.svelte.ts`: File no longer exists (removed during locked-mode elimination)
- [x] Grep for any remaining `encryptionState` or `EncryptionState` references across the entire codebase: confirmed zero

### Verify

- [x] Run `bun test` in packages/workspace: 490 tests pass
- [x] Run `bun run typecheck` across the monorepo: zero new type errors (6 pre-existing errors unrelated to this change)
- [x] Confirm zero references to `encryptionState` or `EncryptionState` remain in `packages/` and `apps/`

## Review

Pure rename + simplification, no behavioral changes.

### Changes made

**6 files changed:**

| File | What changed |
|---|---|
| `y-keyvalue-lww-encrypted.ts` | Deleted `EncryptionState` type and `let encryptionState` variable. Getter now derives `isEncrypted` from `currentKey !== undefined`. `set()` guard changed to `!currentKey`. Removed redundant `encryptionState = 'encrypted'` in `activateEncryption()`. |
| `types.ts` | Removed `EncryptionState` import. `readonly encryptionState: EncryptionState` → `readonly isEncrypted: boolean` on `WorkspaceClient`. |
| `create-workspace.ts` | `get encryptionState()` → `get isEncrypted()`, fallback `'plaintext'` → `false`. |
| `index.ts` | Removed `EncryptionState` re-export and comment. |
| `y-keyvalue-lww-encrypted.test.ts` | Removed `EncryptionState` import, 5 assertion sites updated to boolean checks. |
| `create-workspace.test.ts` | 3 assertion sites updated to boolean checks. |

**Net effect:** ~10 lines deleted (type, variable, assignment, import, re-export). The `isEncrypted` getter is now a single-line derivation from `currentKey`, eliminating a redundant state variable.

### Not changed

- `encryption-wiring.svelte.ts`: already removed during the locked-mode elimination spec.
- Spec files (`specs/*.md`): these are historical documentation, not source code.
