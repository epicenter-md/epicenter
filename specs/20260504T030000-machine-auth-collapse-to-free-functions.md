# Collapse Machine Auth to Free Functions

**Date**: 2026-05-04
**Status**: Implemented with Verification Blockers
**Author**: AI-assisted (Claude)
**Branch**: TBD (single PR; depends on `codex/sync-create-auth` landing)

## One-Sentence Test

The machine-auth Node module exports OAuth ceremony as free functions whose signatures are inferred from their bodies, transport errors are composed bottom-up by fault domain, and `createMachineAuth`, `MachineAuthError`, `MachineAuthStorage`, `MachineAuthStorageBackend`, and the wide `MachineAuthTransportError` aggregate no longer exist.

If `createMachineAuth(...)` still returns an object with methods, the work is not done.
If any function declares an error variant it cannot produce, the work is not done.
If any method uses `Extract<MachineAuthTransportError, ...>` to narrow its return, the work is not done.
If `console.*` still appears in the file, the work is not done.

## Overview

After `split browser and bearer factories` (commit `af5fea8e1`), the auth package's stateful clients live in `createBearerAuth`/`createCookieAuth`. The stateless OAuth ceremony lives in `createMachineAuth`, which is a factory that holds no state. It only closes over its three injected dependencies and exposes four methods.

This spec converts that factory into top-level free functions. The `MachineAuthError` union dissolves by construction (no shared interface to declare it on). The `MachineAuthStorage` interface, the `MachineAuthStorageBackend` parallel type, and the `createKeychainMachineAuthStorage` factory collapse to two free functions: `loadMachineSession` and `saveMachineSession`. `console.warn` and `console.error` calls move to `wellcrafted/logger`.

It also decomposes the transport's error union. `MachineAuthTransportError` today claims four variants (`RequestFailed`, `DeviceCodeExpired`, `DeviceAccessDenied`, `DeviceAuthorizationFailed`) on every method, but only `pollDeviceToken` ever produces the three OAuth variants. Splitting into `MachineAuthRequestError` and `DeviceTokenError` and dropping per-method return-type annotations lets each transport method's signature reflect what its body actually constructs. No `Extract<>` filtering required.

`createMachineAuthClient` stays as a thin wiring helper. `createMachineAuthTransport` stays as a factory; it owns real state (the injected `fetch`) and OAuth response classification.

Consumers that want a grouped namespace use `import * as machineAuth from '@epicenter/auth/node/machine-auth'` at the import site. The library publishes flat exports; the namespace is a consumer-side reading convention.

## Why this is its own spec

The thesis of `split browser and bearer factories` is *"two unlike credential lifecycles deserve two factories, not one factory with a discriminator."*

This spec's thesis is parallel but distinct: *"stateless orchestration is free functions, and error unions compose bottom-up at fault domains, not top-down with a wide aggregate filtered by `Extract<>`."* Different code surface, different motivating evidence (factory holds no state vs two factories sharing a base), different consumers. Per the cohesive-clean-breaks skill: when the work has its own sentence, it deserves its own spec.

The repo's prevailing pattern matches: see how `auth-client-sync-clean-break` and `auth-unified-client-two-factories` ship as separate specs even though they touch the same package.

## Motivation

### Current state

```ts
// packages/auth/src/node/machine-auth.ts

export const MachineAuthStorageError = defineErrors({
    StorageFailed: ({ cause }) => ({...}),
});

export type MachineAuthError =
    | MachineAuthTransportError
    | MachineAuthStorageError;

export type MachineAuthStorage = {  // interface
    load(): Promise<Result<BearerSessionType | null, MachineAuthStorageError>>;
    save(session): Promise<Result<undefined, MachineAuthStorageError>>;
};

export type MachineAuthStorageBackend = {  // parallel to typeof Bun.secrets
    get(options): Promise<string | null>;
    set(options, value): Promise<void>;
    delete(options): Promise<unknown>;
};

export function createKeychainMachineAuthStorage({  // factory wrapping backend
    backend = Bun.secrets,
}: { backend?: MachineAuthStorageBackend } = {}): MachineAuthStorage {...}

export function createMachineAuth({  // factory holds no state
    transport = createMachineAuthTransport(),
    storage  = createKeychainMachineAuthStorage(),
    sleep    = Bun.sleep,
} = {}) {
    return {
        async loginWithDeviceCode(...): Promise<Result<_, MachineAuthError>> {...},
        async status():               Promise<Result<_, MachineAuthError>> {...},
        async logout():               Promise<Result<_, MachineAuthError>> {...},
        async getEncryptionKeys():    Promise<Result<_, MachineAuthStorageError>> {...},
    };
}
```

```ts
// packages/auth/src/node/machine-auth-transport.ts

export const MachineAuthTransportError = defineErrors({
    RequestFailed:             ({ cause }) => ({...}),
    DeviceCodeExpired:         () => ({...}),
    DeviceAccessDenied:        () => ({...}),
    DeviceAuthorizationFailed: ({ code, description }) => ({...}),
});

export function createMachineAuthTransport({ fetch = globalThis.fetch } = {}) {
    return {
        async requestDeviceCode(): Promise<Result<DeviceCodeResponse, MachineAuthTransportError>> {...},
        async pollDeviceToken():   Promise<Result<DevicePollOutcome, MachineAuthTransportError>> {...},
        async fetchSession():      Promise<Result<{ session }, MachineAuthTransportError>> {...},
        async signOut():           Promise<Result<undefined, MachineAuthTransportError>> {...},
    };
}
```

### Problems

The `createMachineAuth` factory holds no state:
- No `let` at the factory scope.
- The closure exists purely to bundle `transport`, `storage`, and `sleep`.
- Compare to `createBearerAuth` in `create-auth.ts:88-170`, which holds `let session`, listener sets, and a dispose flag. That factory is justified. This one is not.
- Every call site constructs and immediately calls one method. The "bundle deps once, reuse across calls" pitch never lands.

The `MachineAuthError` union over-types three of four coordinator methods:

| Method | Declared | Actual |
|---|---|---|
| `loginWithDeviceCode` | `MachineAuthError` | transport + storage (correct) |
| `status` | `MachineAuthError` | storage only: `machine-auth.ts:223-229` folds transport into `Ok({ status: 'unverified', verificationError })` |
| `logout` | `MachineAuthError` | storage only: `machine-auth.ts:244-249` swallows transport with `console.warn` |
| `getEncryptionKeys` | `MachineAuthStorageError` | storage only (already correct) |

The `MachineAuthTransportError` union has the same disease one layer down:

| Transport method | Declared | Variants it actually constructs |
|---|---|---|
| `requestDeviceCode` | `MachineAuthTransportError` | `RequestFailed` only |
| `pollDeviceToken`   | `MachineAuthTransportError` | all four (it's the OAuth classifier) |
| `fetchSession`      | `MachineAuthTransportError` | `RequestFailed` only |
| `signOut`           | `MachineAuthTransportError` | `RequestFailed` only |

Three of four transport methods overstate. Patching this with `Extract<MachineAuthTransportError, { name: 'RequestFailed' }>` per method is top-down filtering on a union we own. Splitting the union by fault domain is the bottom-up fix. See `docs/articles/20260504T100000-extract-is-the-tell-you-composed-top-down.md`.

`MachineAuthStorageBackend` is a parallel type for `typeof Bun.secrets`. The probe at `packages/auth/src/node/machine-auth.ts` typechecks cleanly with `typeof Bun.secrets` substituted (verified locally: `bun run --filter @epicenter/auth typecheck` passes when the parameter type is replaced).

`MachineAuthStorageError` defines one variant (`StorageFailed`) that only wraps the cause. The CLI never branches on the tag; it reads `.message`. The named alias does no work but is consistent with codebase typed-error discipline, so it stays.

The `console.warn`/`console.error` calls (`machine-auth.ts:110, 245-248, 283-285`) violate the codebase logger convention (`wellcrafted/logger` for library code per the `logging` skill).

`getEncryptionKeys` is a three-line helper:
```ts
const { data: session, error } = await storage.load();
if (error) return Err(error);
return Ok(session?.encryptionKeys ?? null);
```
The single external caller is `apps/fuji/src/lib/fuji/script.ts:26-31`. Inlining loses nothing.

### Desired state

```ts
// packages/auth/src/node/machine-session-store.ts (new)

export const MachineAuthStorageError = defineErrors({
    StorageFailed: ({ cause }) => ({...}),
});
export type MachineAuthStorageError = InferErrors<typeof MachineAuthStorageError>;

export async function loadMachineSession({
    backend = Bun.secrets,
}: { backend?: typeof Bun.secrets } = {}): Promise<Result<BearerSession | null, MachineAuthStorageError>>;

export async function saveMachineSession(
    session: BearerSession | null,
    { backend = Bun.secrets }: { backend?: typeof Bun.secrets } = {},
): Promise<Result<undefined, MachineAuthStorageError>>;
```

```ts
// packages/auth/src/node/machine-auth.ts (collapsed)

// MachineAuthError, MachineAuthStorage, MachineAuthStorageBackend,
// createKeychainMachineAuthStorage, createMachineAuth, MachineAuth,
// and getEncryptionKeys: all gone.

export async function loginWithDeviceCode({
    transport = createMachineAuthTransport(),
    sleep = Bun.sleep,
    backend = Bun.secrets,
    onDeviceCode,
}: {...} = {}) {
    // body only constructs MachineAuthRequestError, DeviceTokenError, MachineAuthStorageError
    // → infers Result<MachineAuthLoginResult, MachineAuthRequestError | DeviceTokenError | MachineAuthStorageError>
}

export async function status({
    transport = createMachineAuthTransport(),
    backend = Bun.secrets,
}: {...} = {}) {
    // body only constructs MachineAuthStorageError (transport errors fold to Ok({status:'unverified'}))
    // → infers Result<MachineAuthStatus, MachineAuthStorageError>
}

export async function logout({
    transport = createMachineAuthTransport(),
    backend = Bun.secrets,
}: {...} = {}) {
    // body only constructs MachineAuthStorageError (transport errors logged and swallowed)
    // → infers Result<MachineAuthLogoutResult, MachineAuthStorageError>
}

export async function createMachineAuthClient(): Promise<AuthClient> {
    // unchanged signature; trimmed body using loadMachineSession/saveMachineSession
}
```

```ts
// packages/auth/src/node/machine-auth-transport.ts (decomposed errors)

export const MachineAuthRequestError = defineErrors({
    RequestFailed: ({ cause }) => ({...}),
});
export type MachineAuthRequestError = InferErrors<typeof MachineAuthRequestError>;

export const DeviceTokenError = defineErrors({
    DeviceCodeExpired:         () => ({...}),
    DeviceAccessDenied:        () => ({...}),
    DeviceAuthorizationFailed: ({ code, description }) => ({...}),
});
export type DeviceTokenError = InferErrors<typeof DeviceTokenError>;

export function createMachineAuthTransport({ fetch = globalThis.fetch } = {}) {
    return {
        async requestDeviceCode() {
            // body only constructs MachineAuthRequestError.RequestFailed
            // → infers Result<DeviceCodeResponse, MachineAuthRequestError>
        },
        async pollDeviceToken() {
            // body constructs both
            // → infers Result<DevicePollOutcome, MachineAuthRequestError | DeviceTokenError>
        },
        async fetchSession() {
            // → infers Result<{ session: BearerSession }, MachineAuthRequestError>
        },
        async signOut() {
            // → infers Result<undefined, MachineAuthRequestError>
        },
    };
}
```

Each transport method's signature now matches what it constructs. The aggregate `MachineAuthTransportError` union stops existing as a top-level export. Callers that want it (e.g., the coordinator's `loginWithDeviceCode` Result type) get it naturally where the pieces meet.

```ts
// CLI consumer (packages/cli/src/commands/auth.ts)

import * as machineAuth from '@epicenter/auth/node/machine-auth';

handler: async () => {
    const result = await machineAuth.status();
    // ...
}
```

```ts
// fuji consumer (apps/fuji/src/lib/fuji/script.ts): inlined

import { loadMachineSession } from '@epicenter/auth/node';

async function loadMachineOfflineEncryptionKeys() {
    const { data: session, error } = await loadMachineSession();
    if (error) throw error;
    return session?.encryptionKeys ?? null;
}
```

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Coordinator shape | Free functions | Factory held no state and no production caller exercises bundling. Free functions match what the code is. |
| Coordinator namespace | Consumer-side `import * as machineAuth` | Library publishes flat exports; grouping is a reading convention at the call site, not a library decision. Matches Node stdlib (`fs.readFile`). |
| Error union (coordinator) | Inferred per method, no aggregate | Each function's body declares its real error set. `MachineAuthError` deleted. |
| Error union (transport) | Decomposed by fault domain, inferred per method | `RequestFailed` is one fault domain; OAuth classification is another. They aren't a single union pretending to be one. `Extract<>` would be a top-down patch on a wide aggregate we own. See `docs/articles/20260504T100000-extract-is-the-tell-you-composed-top-down.md`. |
| Storage shape | Free functions in `machine-session-store.ts` | Storage interface added an interface and factory for ~10 lines of real logic (key naming, schema validation, corrupt-blob recovery). Free functions hold the same logic without ceremony. |
| Storage backend type | `typeof Bun.secrets` | Verified to typecheck in-project. The named `MachineAuthStorageBackend` was a parallel type for the same shape. Drop. |
| Storage error type | Keep `MachineAuthStorageError` as one-variant `defineErrors` | Consistent with codebase typed-error discipline. The variant name documents the failure mode even if the CLI doesn't branch on it. |
| `getEncryptionKeys` | Inline at the single consumer | Three-line helper; only `apps/fuji/src/lib/fuji/script.ts:26-31` calls it. Inlining is `loadMachineSession()` + `session?.encryptionKeys ?? null`. |
| `createMachineAuthClient` `{ backend }` parameter | Don't add | No caller exercises it. Add when a real consumer needs it. |
| Logger | `wellcrafted/logger` | Per `logging` skill: no `console.*` in library code. |
| Test logger sink | Inject a no-op sink in `beforeEach` | Concrete Wave 4 task, not an open question. |
| Transport namespace | Unchanged factory shape | `createMachineAuthTransport` factory closes over `fetch` (real DI state) and owns OAuth response classification. Justified. |
| `DeviceCodeExpired` from coordinator | Move to `DeviceTokenError` (already lives there post-decomposition) | Coordinator constructs it on timeout; same fault domain as polling-time expiration. |
| Public API | `node.ts` exports change | Drop `MachineAuthError`, `MachineAuth`, `MachineAuthStorage`, `MachineAuthStorageBackend`, `createKeychainMachineAuthStorage`, the `MachineAuthTransportError` aggregate type, `getEncryptionKeys`. Add `loginWithDeviceCode`, `status`, `logout`, `loadMachineSession`, `saveMachineSession`, `MachineAuthRequestError`, `DeviceTokenError`. |

## Surface map

### Consumers of `createMachineAuth().{login,logout,status,getEncryptionKeys}`

| Site | Method | Migration |
|---|---|---|
| `packages/cli/src/commands/auth.ts:36` | login | `import * as machineAuth from '@epicenter/auth/node/machine-auth'`; `await machineAuth.loginWithDeviceCode({ onDeviceCode })` |
| `packages/cli/src/commands/auth.ts:56` | logout | `await machineAuth.logout()` |
| `packages/cli/src/commands/auth.ts:76` | status | `await machineAuth.status()` |
| `apps/fuji/src/lib/fuji/script.ts:27` | getEncryptionKeys | inline: `await loadMachineSession()` + `session?.encryptionKeys ?? null` |
| `playground/tab-manager-e2e/epicenter.config.ts:44` | (already broken; calls `getActiveEncryptionKeys`) | not in scope |
| `playground/opensidian-e2e/epicenter.config.ts:61` | (already broken; calls `getActiveEncryptionKeys`) | not in scope |

### Consumers of `createMachineAuthClient()`

8 sites across `apps/{opensidian,honeycrisp,zhongwen,fuji}/src/lib/*/{script,daemon}.ts` and `examples/notes-cross-peer/notes.ts`. Signature unchanged (no `{ backend }` parameter added).

### Public API churn (`packages/auth/src/node.ts`)

```diff
 export {
-    createKeychainMachineAuthStorage,
-    createMachineAuth,
     createMachineAuthClient,
-    type MachineAuth,
-    type MachineAuthError,
-    type MachineAuthStorage,
-    type MachineAuthStorageBackend,
-    type MachineAuthStorageError,
+    loginWithDeviceCode,
+    status,
+    logout,
 } from './node/machine-auth.js';
+export {
+    loadMachineSession,
+    saveMachineSession,
+    MachineAuthStorageError,
+    type MachineAuthStorageError,
+} from './node/machine-session-store.js';
 export type {
     DeviceCodeResponse,
     DevicePollOutcome,
     MachineAuthTransport,
-    MachineAuthTransportError,
 } from './node/machine-auth-transport.js';
+export {
+    MachineAuthRequestError,
+    type MachineAuthRequestError,
+    DeviceTokenError,
+    type DeviceTokenError,
+} from './node/machine-auth-transport.js';
```

## Implementation plan

Single PR. Waves are sequential but small.

### Wave 1: extract storage to free functions

- [x] **1.1** Create `packages/auth/src/node/machine-session-store.ts`. Move `MachineAuthStorageError` definition, the keychain key, the schema validation, and the corrupt-blob recovery into two free functions: `loadMachineSession({ backend })` and `saveMachineSession(session, { backend })`. Both return `Result`. Both default `backend` to `Bun.secrets`. Both type the parameter as `typeof Bun.secrets` (no parallel type).
- [x] **1.2** The corrupt-blob warning uses `wellcrafted/logger` (not `console.warn`).
- [x] **1.3** Delete `MachineAuthStorage`, `MachineAuthStorageBackend`, `createKeychainMachineAuthStorage` from `machine-auth.ts`. The `MachineAuthStorageError` definition lives in `machine-session-store.ts`.

### Wave 2: decompose transport errors

- [x] **2.1** In `machine-auth-transport.ts`, replace the single `MachineAuthTransportError` `defineErrors` with two: `MachineAuthRequestError` (one variant: `RequestFailed`) and `DeviceTokenError` (three variants: `DeviceCodeExpired`, `DeviceAccessDenied`, `DeviceAuthorizationFailed`).
- [x] **2.2** Drop the explicit `Promise<Result<_, MachineAuthTransportError>>` return-type annotations on all four transport methods. TypeScript infers per-method return types from the bodies.
- [x] **2.3** Delete the `MachineAuthTransportError` aggregate type alias. Callers that need the union spell `MachineAuthRequestError | DeviceTokenError` at the use site (only `pollDeviceToken`'s inferred return type and the coordinator's `loginWithDeviceCode` need it).

### Wave 3: collapse coordinator to free functions

- [x] **3.1** In `machine-auth.ts`, rewrite `createMachineAuth` body's three remaining methods as three exported free functions: `loginWithDeviceCode`, `status`, `logout`. Each takes `{ transport?, sleep?, backend?, onDeviceCode? }` (only the params it uses).
- [x] **3.2** Replace `storage.load()`/`storage.save()` calls with `loadMachineSession({ backend })` / `saveMachineSession(session, { backend })`.
- [x] **3.3** Delete `createMachineAuth`, `MachineAuth` (`ReturnType<typeof createMachineAuth>` alias), `MachineAuthError` union, and `getEncryptionKeys`.
- [x] **3.4** Drop explicit return-type annotations on the three free functions. TypeScript infers `Result<_, MachineAuthRequestError | DeviceTokenError | MachineAuthStorageError>` for `loginWithDeviceCode` and `Result<_, MachineAuthStorageError>` for `status` and `logout` from the bodies.
- [x] **3.5** The `signOutError` warning uses `wellcrafted/logger`.

### Wave 4: trim `createMachineAuthClient`

- [x] **4.1** Trim `createMachineAuthClient` to use `loadMachineSession` and `saveMachineSession` directly. Signature unchanged (no `{ backend }` parameter added).
- [x] **4.2** The `saveSession` callback's failure log uses `wellcrafted/logger`.

### Wave 5: update tests

- [x] **5.1** `packages/auth/src/node/machine-auth.test.ts`: drop `makeMemoryStorage` (no longer needed) and `MachineAuthStorage`/`MachineAuthStorageBackend` imports. Use only `makeMemoryKeychainBackend` for storage in all tests.
- [x] **5.2** Replace `createTestMachineAuth(fetch)` factory with direct calls: `await loginWithDeviceCode({ transport, backend, sleep })`, etc. Hoist a `makeTestDeps(fetch)` helper if multiple tests share construction.
- [x] **5.3** `keychain machine session storage` describe block tests `loadMachineSession`/`saveMachineSession` directly.
- [x] **5.4** Inject a no-op logger sink in `beforeEach` so library log output does not leak into test reports. Use the `wellcrafted/logger` test-sink pattern (capturing collector if a test wants to assert on a log).
- [x] **5.5** Test that `status` and `logout` inferred return types are `Result<_, MachineAuthStorageError>` (use a type-level `expectTypeOf` or equivalent assertion). Test that `loginWithDeviceCode` is `Result<_, MachineAuthRequestError | DeviceTokenError | MachineAuthStorageError>`.

### Wave 6: update consumers

- [x] **6.1** `packages/cli/src/commands/auth.ts` x3 handlers: replace `const machineAuth = createMachineAuth(); await machineAuth.X()` with `import * as machineAuth from '@epicenter/auth/node/machine-auth'`; `await machineAuth.loginWithDeviceCode(...)`, `machineAuth.status()`, `machineAuth.logout()`.
- [x] **6.2** `apps/fuji/src/lib/fuji/script.ts:26-31`: inline `getEncryptionKeys`. Direct `await loadMachineSession()`; `return session?.encryptionKeys ?? null`.
- [x] **6.3** `createMachineAuthClient` consumers: no signature change.

### Wave 7: public exports

- [x] **7.1** Update `packages/auth/src/node.ts` per the diff above.
  > **Note**: Added the `./node/machine-auth` package export so the CLI can use the requested consumer-side namespace import.
- [x] **7.2** `packages/cli/README.md` examples updated (line 340-341 import block).

### Wave 8: verification

- [x] **8.1** `bun run --filter @epicenter/auth typecheck` passes.
- [x] **8.2** `bun run --filter @epicenter/auth test` passes.
- [ ] **8.3** `bun run --filter @epicenter/cli typecheck` passes.
  > **Blocked**: Bun reports `error: No packages matched the filter`. `bun run typecheck --filter=@epicenter/cli` finds the package but executes no task because `packages/cli/package.json` has no `typecheck` script. `bun x tsc --noEmit` in `packages/cli` passes.
- [ ] **8.4** `bun run --filter fuji typecheck` passes.
  > **Blocked**: Bun reports `error: No packages matched the filter`. `bun run typecheck --filter=@epicenter/fuji` reaches Fuji but fails on pre-existing Svelte/UI errors outside this spec: `from-table.svelte.ts`, `toast-on-error.ts`, `button.svelte`, `sidebar-menu-button.svelte`, `EntriesTable.svelte`, and `workspace-gate.svelte`.
- [ ] **8.5** Workspace-wide `bun run typecheck` passes (every consumer migrated).
  > **Blocked**: Workspace-wide typecheck fails before this auth migration is implicated. The first failing package is `@epicenter/tab-manager`, mostly unresolved `#/...` UI imports and unrelated Svelte/type errors.
- [ ] **8.6** `epicenter auth login` / `status` / `logout` smoke test against staging API.
  > **Not run**: Requires staging API/device-code auth environment.

## Acceptance criteria

- [x] `MachineAuthError` does not exist in the codebase.
- [x] `MachineAuthStorage` and `MachineAuthStorageBackend` do not exist in the codebase.
- [x] `createMachineAuth` does not exist in the codebase.
- [x] `createKeychainMachineAuthStorage` does not exist in the codebase.
- [x] `MachineAuth` type alias does not exist.
- [x] `getEncryptionKeys` does not exist as an exported function.
- [x] The aggregate `MachineAuthTransportError` type alias does not exist.
- [x] `MachineAuthRequestError` and `DeviceTokenError` exist as separate `defineErrors`.
- [x] No `Extract<MachineAuthTransportError, ...>` or `Extract<MachineAuthError, ...>` anywhere in the codebase.
- [x] No explicit return-type annotation on `loginWithDeviceCode`, `status`, `logout`, or any `createMachineAuthTransport` method (TypeScript infers).
- [x] No `console.warn`, `console.error`, or `console.log` in `machine-auth.ts`, `machine-session-store.ts`, or `machine-auth-transport.ts`.
- [x] `loadMachineSession`, `saveMachineSession` exist as free functions in `machine-session-store.ts`.
- [x] All 5 consumer files migrated (`apps/fuji/src/lib/fuji/script.ts` inlines, three CLI handlers use namespace import).
- [ ] Workspace-wide typecheck passes.

## Open questions

1. **Where does `MachineAuthStorageError` live after the split?** Two reasonable choices: (a) define it in `machine-session-store.ts` and re-export from `machine-auth.ts`; (b) keep its definition in `machine-auth.ts` and import from `machine-session-store.ts`. (a) is more cohesive (the error is owned by the file that produces it). Going with (a).

2. **Does inferring return types break Go-to-Definition?** TypeScript's inferred types are visible on hover and in declaration files generated from `.d.ts`. Acceptable. If a downstream consumer wants to spell the error type, `MachineAuthRequestError | DeviceTokenError | MachineAuthStorageError` is a one-line union at the use site.

3. **Should the spec split into two PRs (transport decomposition + storage collapse, then coordinator collapse)?** No, all three changes share motivation and live in the same package; cohesive change.

## Out of scope

- The playground configs that already reference removed methods (`getActiveEncryptionKeys`, `createMachineTokenGetter`); they're stale from a prior spec and need their own cleanup.
- Any in-memory cache between `createMachineAuth*` callers and `createMachineAuthClient` instances; CLI/daemon staleness is a known concern handled elsewhere.
- The `createMachineAuthClient` `{ backend }` parameter; add when a real consumer needs it.

## References

- `packages/auth/src/node/machine-auth.ts` (current implementation)
- `packages/auth/src/node/machine-auth-transport.ts` (transport, decomposed)
- `packages/auth/src/create-auth.ts:88-170` (stateful factory for contrast)
- `specs/20260503T230000-auth-unified-client-two-factories.md` (the split that established the precedent)
- `docs/articles/20260504T100000-extract-is-the-tell-you-composed-top-down.md` (rationale for bottom-up error composition)
- Skills referenced: `cohesive-clean-breaks`, `logging`, `factory-function-composition`, `define-errors`, `error-handling`, `one-sentence-test`, `typescript`

## Review

**Completed**: 2026-05-04
**Branch**: `codex/sync-create-auth`

### Files Read

```txt
apps/fuji/src/lib/fuji/
`-- script.ts
packages/auth/
|-- package.json
`-- src/
    |-- node.ts
    `-- node/
        |-- machine-auth-transport.ts
        |-- machine-auth.test.ts
        |-- machine-auth.ts
        `-- machine-session-store.ts
packages/cli/
|-- README.md
`-- src/commands/
    `-- auth.ts
```

### Summary

Machine auth now exports stateless OAuth ceremony as free functions, with keychain session persistence split into `loadMachineSession` and `saveMachineSession`. Transport errors are composed from `MachineAuthRequestError` and `DeviceTokenError`, with method return types inferred from the bodies and no wide aggregate transport error.

### Deviations from Spec

- Added a `./node/machine-auth` package export so `packages/cli/src/commands/auth.ts` can use the requested namespace import.
- The logger is injectable for `status`, `logout`, and `loadMachineSession` so tests can use a memory sink. `createMachineAuthClient` keeps the required zero-argument signature and uses the default `machine-auth` logger.
- Wave 3 through Wave 5 were committed together because the coordinator collapse and test migration are typecheck-coupled.

### Verification

- `bun run --filter @epicenter/auth typecheck`: passed.
- `bun run --filter @epicenter/auth test`: passed, 27 tests.
- `bun x tsc --noEmit` in `packages/cli`: passed.
- Requested CLI and Fuji filter commands did not map cleanly in Bun. Fuji and workspace typechecks still fail on unrelated existing Svelte/UI errors documented in Wave 8.

### Follow-Up Work

- Add a `typecheck` script to `packages/cli/package.json` if the repo expects `bun run typecheck --filter=@epicenter/cli` to execute work.
- Clean up the existing Fuji/workspace typecheck failures outside this auth migration before treating Wave 8.4 and Wave 8.5 as release gates.
- Run the staging `epicenter auth login`, `status`, and `logout` smoke test in an environment with the device-code API configured.
