# /api/keyring and the secret-vault wiring

**Date**: 2026-07-01
**Status**: Draft
**Owner**: Braden
**Branch**: not started (designed on feat/whispering-cloud-sync-rebase)

## One Sentence

A portable authenticated `GET /api/keyring` endpoint derives the ADR-0074 per-principal keyring from a deployment root secret, and Whispering's secrets facade uses it to move bring-class provider keys from plaintext device `localStorage` into the one user-global encrypted vault doc.

## Overview

ADR-0074 is Accepted but half-built: the encrypted-KV primitive, the HKDF derivation helpers, and the `available | missing` facade all exist and are tested, but no server endpoint delivers a keyring and no app attaches the vault doc. This spec wires the two halves together. It is the feature the Whispering auth work exists to deliver.

## Motivation

### Current State

The server side has derivation helpers with zero consumers:

```ts
// packages/encryption/src/derivation.ts:80 — exists, tested, never called by any server
export async function deriveKeyring({ rootKeyring, label }: {...}): Promise<Keyring>
// packages/encryption/src/secrets.ts:82 — parses ENCRYPTION_SECRETS ("2:new,1:old"), zero call sites
export function parseRootKeyring(value: string): RootKeyring
```

The client side has an encrypted store with no keys to activate it:

```ts
// packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts:179
// Starts passthrough; activateEncryption(keyring) upgrades existing plaintext entries.
export function createEncryptedYkvLww<T>(ydoc: Y.Doc, arrayKey: string)
```

And Whispering's facade reads device-local plaintext as the documented degenerate:

```ts
// apps/whispering/src/lib/state/secrets.svelte.ts:57
get(key: SecretKey): SecretRead {
	const value = deviceConfig.get(key); // plaintext localStorage
	return value ? { status: 'available', value } : { status: 'missing' };
}
```

This creates problems:

1. **Provider keys never leave the device**: entering a Groq key in Whispering does nothing for Whispering-on-a-second-device or for Vocab, which is the exact friction ADR-0074 exists to kill.
2. **Keys sit in plaintext `localStorage`**: acceptable as a signed-out degenerate, but signed-in users get no upgrade even though every primitive for one already exists.
3. **The auth system delivers nothing yet**: ADR-0079's whole justification is "auth exists to deliver the keyring." Until this endpoint exists, sign-in buys sync but not the vault.

### Desired State

Sign in on any device; the client fetches `GET /api/keyring` with its bearer; the facade attaches the one user-global vault doc, activates encryption, and migrates device keys in. A key entered in any app reads `available` in every app on every signed-in device. Signed-out behavior is byte-identical to today.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Portable or cloud-only | 2 coherence | Portable (`packages/server`), like blobs/inference | ADR-0074 invariant 1: self-host derives the keyring with *your* root. An instance serves `/api/keyring` from its own `ENCRYPTION_SECRETS` for its one pinned partition. Cloud-only would fork the read contract per deployment. |
| Env contract home | 2 coherence | `ENCRYPTION_SECRETS?` joins portable `ServerBindings` | Same seam as `OPENAI_API_KEY?`: optional, mount 503s when unconfigured (`server-bindings.ts:42`). Not `CloudAuthBindings`: that is the relational-auth substrate (ADR-0076), and instances have no Better Auth but DO need keyrings. |
| Own endpoint vs enriching `/api/session` | 3 taste | Own endpoint `/api/keyring` | The session projection is cached by clients in plain storage for offline boot; key material must not ride into that cache. A separate endpoint lets each platform pick the key cache substrate (OS keychain on desktop). `create-auth.ts` already records the historical split ("no longer enriches `/auth/get-session` with encryption keys"). Revisit only if a third session-adjacent secret shows up. |
| Response shape | 1 evidence | `{ keyring: Keyring }`, `Cache-Control: no-store` | `Keyring` (`packages/encryption/src/keys.ts:25`) is already documented as "transport-safe per-label key material delivered through auth sessions." |
| Derivation label | 1 evidence | `c.var.principal.id` | Matches `deriveKeyring`'s JSDoc (`label` is typically a `PrincipalId`, info bytes `principal:${label}`), and the deployment auth middleware already resolves it for both deployables. |
| Auth middleware | 2 coherence | Deployment-supplied, same as `mountSessionApp` | Cloud passes `cookieOrBearer`, instance passes `bearer`. The keyring is the principal's own decryption key, not a secret from the caller, so any authenticated surface for that principal may read it. |
| Vault doc identity | 1 evidence | User-global guid constant, principal-scoped persistence | ADR-0074 invariants 2 and 3. Constant lives in `packages/constants` beside the other cross-app identifiers. |
| Per-doc key derivation | 1 evidence | `deriveWorkspaceKey(keyBytes, guid)` per keyring version into a `WorkspaceKeyring` map | Exactly what `activateEncryption` consumes (`keys.ts:41`, `y-keyvalue-lww-encrypted.ts`). The vault guid is the workspaceId label. |
| Offline keyring cache | 2 coherence | Cache the fetched keyring on device: OS keychain on desktop, `localStorage` on web | Invariant 5 has no `locked` state; an offline boot with a synced vault replica MUST still decrypt, so the keyring must survive offline. Web cache is the same risk class as the grant beside it; desktop keychain is the "bootstrap root" role the keychain commit anticipated. |
| Secret migration on sign-in | 2 coherence | Write-through device values into the vault, then delete local | Invariant 4 forbids a two-place read. Migration is copy-then-remove: local copy cleared only after a confirmed vault write. |
| Zero-knowledge / passphrase | Banked | Refused | ADR-0074 forecloses it as default; deferred premium seam. Do not reopen. |

## Architecture

```txt
Server (both deployables)

  GET /api/keyring        (auth: cookieOrBearer on cloud, bearer on instance)
    -> c.var.principal.id (user principal | INSTANCE_PRINCIPAL_ID)
      -> parseRootKeyring(env.ENCRYPTION_SECRETS)   (503 KeyringNotConfigured when unset)
        -> deriveKeyring({ rootKeyring, label: principalId })
          -> { keyring: [{ version, keyBytesBase64 }, ...] }   Cache-Control: no-store

Client (per app, behind the auth session)

  signed in
    -> fetch /api/keyring with auth-owned fetch -> cache on device
         desktop: OS keychain (service 'whispering', account 'vault-keyring')
         web:     localStorage ('whispering.vault.keyring')
    -> vaultDoc = new Y.Doc({ guid: SECRET_VAULT_GUID })
    -> connectDoc(vaultDoc, { principalId, ... })    (same primitive as the app doc)
    -> kv = createEncryptedYkvLww<string>(vaultDoc, 'secrets')
    -> kv.activateEncryption(toWorkspaceKeyring(keyring, SECRET_VAULT_GUID))
    -> migrate device-local bring-class keys in (copy, confirm, delete local)

  signed out
    -> deviceConfig plaintext, unchanged (the blessed degenerate)
```

Trust line, verbatim from ADR-0074: the relay stores ciphertext and never holds the keyring (it lives beside the auth service, derived per request from the deployment root); on hosted, the operator can read a stored key, and the remedy for refusing that is self-host. Copy at key entry says "Synced to your devices," never "encrypted."

## Call sites: before and after

### Whispering secrets facade

**Before** (`apps/whispering/src/lib/state/secrets.svelte.ts:53`):

```ts
export function createSecrets() {
	return {
		get(key: SecretKey): SecretRead {
			const value = deviceConfig.get(key);
			return value ? { status: 'available', value } : { status: 'missing' };
		},
		set(key: SecretKey, value: string): void {
			deviceConfig.set(key, value);
		},
	};
}
```

**After** (shape, not prescription):

```ts
export function createSecrets() {
	return {
		get(key: SecretKey): SecretRead {
			const home = vault.isAttached ? vault : deviceConfig; // one home, never merged
			const value = home.get(key);
			return value ? { status: 'available', value } : { status: 'missing' };
		},
		set(key: SecretKey, value: string): void {
			(vault.isAttached ? vault : deviceConfig).set(key, value);
		},
	};
}
```

**Semantic shift to flag**: after sign-in migration, `deviceConfig` no longer holds provider keys, so anything reading them off `deviceConfig` directly (grep before wiring; the facade should be the only reader) silently loses data. `vault.get` must stay synchronous and rune-reactive for existing `$derived` consumers; the encrypted store surfaces plaintext through its observable contract, so this holds.

### Server mount (new, mirrors `mountSessionApp`)

**Reference** (`packages/server/src/routes/session.ts:48`):

```ts
export function mountSessionApp<E extends Env = Env>(
	app: Hono<E>,
	opts: { auth: MiddlewareHandler<E> },
): void
```

`mountKeyringApp` takes the identical options bag; both deployables add one line at their edge.

## Implementation Plan

### Phase 1: the endpoint

- [ ] **1.1** Add `ENCRYPTION_SECRETS?: 'string'` to `ServerBindings` with a comment following the blobs/AI-key precedent (optional, 503 when reached unconfigured).
- [ ] **1.2** Add `API_ROUTES.keyring` (`/api/keyring`) in `packages/constants/src/api-routes.ts`. Check any route-literal guards that require API paths to go through `API_ROUTES`.
- [ ] **1.3** `packages/server/src/routes/keyring.ts`: `mountKeyringApp` with the session-app options shape; handler parses the root keyring once per request, derives for `c.var.principal.id`, returns `{ keyring }` with `Cache-Control: no-store`; 503 typed error when `ENCRYPTION_SECRETS` is unset; 500 (fail closed, log) when it is set but malformed.
- [ ] **1.4** Mount in `apps/api/worker/index.ts` (auth: `cookieOrBearer`) and both `apps/self-host` entries (auth: `bearer`). Add the secret to the cloud deploy config and the self-host reference config/docs.
- [ ] **1.5** Response contract type (`ApiKeyringResponse`) exported beside `ApiSessionResponse` so clients and server share it (see Open Question 1 for its package home).
- [ ] **1.6** Tests: derivation is stable per principal, differs across principals, respects root version order; unconfigured 503; route registered on both deployables.

### Phase 2: client fetch + cache

- [ ] **2.1** A `fetchKeyring` client reader beside `readApiSession` (auth-owned fetch, bearer attached, `credentials: 'omit'`).
- [ ] **2.2** Device cache: desktop keychain entry (`vault-keyring` account via a new vault-cache command pair), web `localStorage` key. Refresh on every successful fetch; delete on sign-out. Note: the auth-grant keyring commands were collapsed to zero-account in both apps (PR #2378). Rust owns the service and account strings, so this wave adds an explicit second command pair for the vault-keyring cache, with each command hardcoding the `vault-keyring` account in Rust, not an allowlist entry or a generic account parameter.
- [ ] **2.3** Offline boot path: cached keyring hydrates activation before the first fetch resolves.

### Phase 3: vault doc + facade wire (Whispering first)

- [ ] **3.1** `SECRET_VAULT_GUID` constant in `packages/constants`.
- [ ] **3.2** Attach the vault doc inside the signed-in session overlay (the session owns only the vault doc and keyring per ADR-0079); `connectDoc` + `createEncryptedYkvLww` + `activateEncryption`.
- [ ] **3.3** Facade branch + one-time migration (copy device keys, confirm, delete local). Respect invariant 4: no merged reads, ever.
- [ ] **3.4** Key-entry copy: "Synced to your devices" / "Saved only on this device" per ADR-0074's consequences.
- [ ] **3.5** Live verification with two signed-in sessions: key entered on web reads `available` on desktop.

### Phase 4: cross-app + cleanup

- [ ] **4.1** Second consumer (Vocab or Fuji) attaches the same vault; verifies invariant 3 for real.
- [ ] **4.2** Amend ADR-0074 status notes if any invariant was refined during implementation; delete this spec.

## Edge Cases

### Offline boot, signed in, vault previously synced

1. No network; IndexedDB has the vault replica; the keyring cache has the last fetched keyring.
2. Activation runs from the cache; keys read `available`.
3. If the cache is empty (first boot ever offline), keys read `missing` until online. This is the one honest gap; do not invent a `locked` state for it.

### Root secret rotation

1. Operator prepends `2:new` to `ENCRYPTION_SECRETS`, keeping `1:old`.
2. Next fetch delivers both versions; `activateEncryption` re-encrypts old-version entries under v2 (documented behavior of the store).
3. Dropping `1:old` before every replica has re-encrypted orphans those blobs (`keys.ts` warning). Operator docs must say: remove old versions only after a soak.

### Sign-out

1. Grant revoked; vault doc detached; keyring cache deleted.
2. Local vault replica handling follows the same "sign-out preserves local data" stance as the rest of the app; ciphertext without a keyring is inert.
3. Device-local (pinned) secrets are untouched.

### Same user, two apps, different origins

1. Whispering and Vocab each fetch `/api/keyring` with their own bearer; HKDF is deterministic, so both derive identical vault keys.
2. Nothing is shared between origins except through the server. This is the designed path (ADR-0074 consequence 2).

## Open Questions

1. **Where does `ApiKeyringResponse` live?** `ApiSessionResponse` lives in `@epicenter/auth`, but `Keyring` lives in `@epicenter/encryption`.
   - Options: (a) `@epicenter/auth` importing the type from encryption, (b) export the contract from `@epicenter/encryption` beside `Keyring`.
   - **Recommendation**: (b); the auth package should not grow an encryption dependency for one type alias.

2. **Does the web keyring cache live inside the persisted-auth record or beside it?** Extending `PersistedAuth` (arktype schema in `@epicenter/auth`) couples grant and keyring lifecycles; a sibling key duplicates the substrate choice.
   - **Recommendation**: sibling key, same substrate. Lifecycles differ (keyring survives token rotation; both die on sign-out), and the desktop already needs a second keychain account anyway.

3. **Which secrets migrate by default on first sign-in?** ADR-0074 invariant 4 allows a per-secret home. Migrating everything silently maximizes the payoff; a prompt respects the work-laptop case.
   - **Recommendation**: migrate all bring-class provider keys silently with the save-time announcement copy, and add the per-secret "keep on this device" pin only when a user asks; a prompt per key is ceremony ADR-0074 tried to kill.

4. **Does the instance (self-host) wave ship now or with the first self-host connect UI?** Nothing writes `instanceSetting` in Whispering today.
   - **Recommendation**: ship the server mount now (it is ~5 lines against the same portable route) but defer any instance-specific client work; the mount makes the reference deployment honest without new UI.

## Success Criteria

- [ ] `GET /api/keyring` returns a stable per-principal keyring on cloud and instance; 503 when unconfigured; never cached.
- [ ] Key entered in signed-in Whispering web reads `available` on signed-in Whispering desktop (live verification, two devices).
- [ ] The relay row for the vault doc holds ciphertext (inspect the DO SQLite in `.wrangler/state`).
- [ ] Signed-out Whispering behavior is byte-identical to today; device-local pinned secrets never sync.
- [ ] Offline boot with a warm cache decrypts; no `locked` state exists anywhere in the facade contract.
- [ ] Typecheck, `packages/server` and `packages/encryption` tests green.

## References

- `docs/adr/0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md` — the decision this implements; its five invariants are the acceptance contract.
- `packages/encryption/src/derivation.ts`, `secrets.ts`, `keys.ts` — derivation, root parsing, `Keyring`/`WorkspaceKeyring` types (all exist, unconsumed).
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` — the encrypted store and `activateEncryption` lifecycle.
- `packages/server/src/routes/session.ts` — the mount pattern to mirror.
- `packages/server/src/server-bindings.ts` — where `ENCRYPTION_SECRETS?` joins.
- `apps/whispering/src/lib/state/secrets.svelte.ts` — the facade whose JSDoc already narrates this exact wave.
- `apps/whispering/src/lib/runtime/auth.epicenter.ts` — the existing consumer of the keyring commands; the desktop keyring cache mirrors its `tauriOnly.keyring` usage.
