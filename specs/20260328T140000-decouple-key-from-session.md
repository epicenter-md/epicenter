# Decouple Workspace Key from Session Response

## Problem

`customSession` returns `userKeyBase64` on every `getSession()` call, which means:
- HKDF runs on every tab-focus refresh (wasted work)
- Key material travels in every session response (unnecessary exposure)
- Auth layer carries encryption concerns (wrong responsibility)

## Solution

`customSession` returns only `keyVersion`. A dedicated `/workspace-key` endpoint returns the actual key material, called once on first auth and only again if the cached version is stale.

## Changes

### Wave 1: Server contract + endpoint (no client changes yet)

- [ ] **1.1** `apps/api/src/auth/contracts/get-session.ts`: Remove `userKeyBase64` from `EpicenterSessionFields`. Type becomes `{ keyVersion: number }`.
- [ ] **1.2** `apps/api/src/auth/encryption.ts`: Add `getKeyVersion()` that returns `{ keyVersion: currentKey.version }` synchronously. Keep `createSessionEncryptionFields` for the new endpoint.
- [ ] **1.3** `apps/api/src/auth/create-auth.ts`: Replace `await createSessionEncryptionFields(user.id)` with `getKeyVersion()` in customSession. Drop `async` from the callback.
- [ ] **1.4** `apps/api/src/app.ts`: Add `GET /workspace-key` route behind `authGuard`. Returns `createSessionEncryptionFields(c.var.user.id)` (the full `{ userKeyBase64, keyVersion }`).

### Wave 2: Client transport + types

- [ ] **2.1** `packages/svelte-utils/src/auth-transport.ts`: In `SessionResolution`, replace `userKeyBase64: string` with `keyVersion: number`. Update `resolveSessionWithToken` to map `data.keyVersion`. Add `fetchWorkspaceKey(baseURL, token)` export.
- [ ] **2.2** `packages/svelte-utils/src/auth-session.svelte.ts`: In `AuthRefreshResult`, replace `workspaceKeyBase64?: string` with `keyVersion?: number`. Update `applyResolvedSession`'s authenticated branch.
- [ ] **2.3** `packages/svelte-utils/src/auth-transport.test.ts`: Update test fixtures: remove `userKeyBase64`, add `keyVersion` in mock `getSession` responses.

### Wave 3: Workspace auth (core logic change)

- [ ] **3.1** `packages/svelte-utils/src/workspace-auth.svelte.ts`: Accept `fetchWorkspaceKey` in options. `applyAuthResult` compares `result.keyVersion` against a locally-tracked version. Fetches key only on mismatch.
- [ ] **3.2** `packages/svelte-utils/src/workspace-auth.test.ts`: Update test fixtures: `workspaceKeyBase64` → `keyVersion`. Add test for "same version skips key fetch".

### Wave 4: Cache durability upgrade

- [ ] **4.1** `packages/svelte-utils/src/indexed-db-key-cache.ts`: New shared factory `createIndexedDbKeyCache(storageKey)` using raw IndexedDB API (no `idb` dep needed. Only 3 ops on 1 key).
- [ ] **4.2** `apps/honeycrisp/src/lib/workspace/user-key-cache.ts`: Replace sessionStorage impl with `createIndexedDbKeyCache('honeycrisp:encryption-key')`.
- [ ] **4.3** `apps/zhongwen/src/lib/workspace/user-key-cache.ts`: Same, with `'zhongwen:encryption-key'`.
- [ ] **4.4** `apps/opensidian/src/lib/user-key-cache.ts`: Same, with `'opensidian:encryption-key'`.

### Wave 5: Re-exports + barrel cleanup

- [ ] **5.1** `packages/svelte-utils/src/auth.svelte.ts`: Verify barrel re-exports are correct after type changes.
- [ ] **5.2** Run typecheck across monorepo to catch any remaining references.

## Design Decisions

| Decision | Rationale |
|---|---|
| customSession returns `keyVersion` only | No HKDF on every `getSession()`. Cheap integer comparison on client. |
| Dedicated `/workspace-key` behind `authGuard` | Reuses existing auth middleware. Clear separation of concerns. |
| `fetchWorkspaceKey` lives in auth-transport | Same module that owns the Better Auth client and base URL. |
| `UserKeyCache` interface unchanged | Version tracking belongs to workspace-auth layer, not the crypto cache. |
| IndexedDB for browser caches | Survives tab close. Shared factory in svelte-utils avoids adding `idb` dep to 3 apps. Raw API is fine for 1 key. |
| tab-manager cache unchanged | WXT `session:` storage is already durable enough for an extension. |

## What's NOT Changing

- `UserKeyCache` interface (`save(key)`, `load()`, `clear()`): stays as-is
- `workspace.unlockWithKey(userKeyBase64)`: still called, just gets key from the new endpoint instead of session
- `create-workspace.ts` encryption runtime: untouched
- Whispering (no encryption yet): untouched
- CLI auth flow: uses its own `EpicenterSessionResponse` import, will get the slimmer type

## Review

### What changed

**Server (4 files)**:
- `EpicenterSessionFields` slimmed to `{ keyVersion: number }`: `userKeyBase64` removed from session contract
- `encryption.ts` split: `getKeyVersion()` (sync, for customSession) + `deriveWorkspaceKey()` (async, for new endpoint)
- `customSession` callback is now synchronous: no HKDF on every `getSession()` call
- New `GET /workspace-key` route behind `authGuard`: the only place HKDF runs now

**Client transport (3 files)**:
- `SessionResolution.userKeyBase64` → `SessionResolution.keyVersion` (integer, not key material)
- `AuthRefreshResult.workspaceKeyBase64` → `AuthRefreshResult.keyVersion`: the `userKeyBase64`→`workspaceKeyBase64` rename indirection is gone entirely
- New `fetchWorkspaceKey(baseURL, token)` export for the dedicated endpoint

**Workspace auth (2 files)**:
- `applyAuthResult()` now does version comparison: `keyVersion === lastKeyVersion` → skip fetch
- Key material only fetched when version changes or on first auth
- `lastKeyVersion` reset on sign-out
- New test: "skips key fetch when keyVersion matches the last unlocked version"

**Cache durability (4 files)**:
- New `createIndexedDbKeyCache(storageKey)` shared factory in svelte-utils (raw IndexedDB, no `idb` dep)
- Honeycrisp, Zhongwen, Opensidian all upgraded from `sessionStorage` → IndexedDB (survives tab close)
- Tab-manager unchanged (WXT `session:` storage already durable enough)

### What was removed

- `userKeyBase64` field from `EpicenterSessionFields` type
- `createSessionEncryptionFields()` function (replaced by `getKeyVersion()` + `deriveWorkspaceKey()`)
- `workspaceKeyBase64` field from `AuthRefreshResult` type
- The `userKeyBase64` → `workspaceKeyBase64` name-mapping indirection in `applyResolvedSession()`

### Verification

- 0 LSP errors across all 13 changed files
- 8/8 tests pass (6 workspace-auth, 2 auth-transport)
- 5 pre-existing typecheck errors in svelte-utils (unrelated: `NumberKeysOf`, `Ok<undefined>` type mismatches)
