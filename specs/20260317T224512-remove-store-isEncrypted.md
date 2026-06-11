# Remove `isEncrypted` from Store Public API

## Motivation

`isEncrypted` on the store is a leaked implementation detail. The store has a key and uses it. That's its job. Whether that constitutes "being encrypted" is a question for the workspace, which is where the decision lives. Two independent answers to the same question is a bug waiting to happen.

## Current State

- **Store**: `YKeyValueLwwEncrypted<T>` exposes `readonly isEncrypted: boolean` (derived from `currentKey !== undefined`)
- **Workspace**: `create-workspace.ts` reads `encryptedStores[0]?.isEncrypted` as proxy for workspace encryption state
- **Workspace type**: `types.ts` exposes `readonly isEncrypted: boolean` on the workspace client (stays)

## Changes

### 1. `y-keyvalue-lww-encrypted.ts`: Remove from type + implementation

- [ ] Remove `readonly isEncrypted: boolean` from `YKeyValueLwwEncrypted<T>` type (line 131)
- [ ] Remove `get isEncrypted()` getter from return object (lines 448-450)
- [ ] Update JSDoc: module header diagram (lines 38, 43), options doc (line 97), type doc (line 108), usage example (lines 169, 173)

### 2. `create-workspace.ts`: Workspace becomes sole truth

- [ ] Add `let workspaceKey: Uint8Array | undefined = options?.key;` alongside `encryptedStores`
- [ ] Change `get isEncrypted()` from `encryptedStores[0]?.isEncrypted ?? false` to `workspaceKey !== undefined`
- [ ] Update `activateEncryption()` to set `workspaceKey = key` before calling store activates encryption

### 3. `y-keyvalue-lww-encrypted.test.ts`: Replace self-report with behavior assertions

- [ ] "starts in plaintext when no key provided" (line 521): write value, assert raw yarray entry is NOT `isEncryptedBlob`
- [ ] "starts in encrypted when key provided" (line 531): write value, assert raw yarray entry IS `isEncryptedBlob`
- [ ] "plaintext → encrypted via activateEncryption(key)" (lines 541-543): write before activateEncryption → plaintext raw, activateEncryption, write after → encrypted raw
- [ ] "plaintext stays readable after activateEncryption" (line 621): remove `kv.isEncrypted` assertion (surrounding assertions already verify behavior)

### 4. `key-manager.ts`: JSDoc only

- [ ] Lines 46-48: Already correct ("the key manager never reads `isEncrypted`; encryption state guarding is the client's responsibility"): no change needed
- [ ] Lines 78-79: Already correct ("the client's job"): no change needed
- [ ] Lines 162-163: Already correct ("the client's responsibility"): no change needed

### 5. Files NOT touched

- `types.ts`: Workspace-level `isEncrypted` stays (line 1290). This is the single source of truth now.
- `create-workspace.test.ts`: Tests `client.isEncrypted`, which is workspace-level. No change.
- `crypto/index.ts`, `crypto.test.ts`: These reference `isEncryptedBlob()` (the utility function), not the property. Unrelated.

## Code Smells to Review After

For each file touched, look for:
- Redundant state tracking
- Leaked implementation details
- JSDoc that references removed concepts
- Dead code paths

## Review

_To be filled after implementation._
