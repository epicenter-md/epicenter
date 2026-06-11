# Encryption Policies: Docs + Rotation Fix

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive (continuing)

## Overview

Two changes ship together:

1. **Document the encryption policies** the library supports: one-off, two core, plus an app-level discipline. Previously implicit; now written down.
2. **Extend `applyKeys`'s walk to handle key rotation correctly.** Old-version ciphertext now gets re-encrypted under the new current key on every `applyKeys` call, not just plaintext. Same `applyKeys(keys)` signature; stronger guarantee.

**No new API surface.** No `strict` flag. No `reencryptAll` method. No `opts` parameter. This spec supersedes an earlier draft that proposed all three: those additions were speculative and didn't earn their keep.

## Motivation

### What the library actually needs to do

Three user stories, from observed Epicenter apps:

- **Plaintext forever** (tab manager, any app without a privacy story): no encryption attached.
- **Encrypt-after-login with eventual re-encryption** (fuji, whispering, opensidian, every app that offers offline-first before auth): write freely, sign in, everything converges to ciphertext on the current key.
- **Zero-knowledge** (password managers, vaults): app blocks writes in the UI until the user unlocks.

The first is trivially supported today: don't call `attachEncryption`. The second is what `applyKeys` does, but with one gap. The third is an app-level concern: see "Non-goals."

### The gap in the current `applyKeys`

Today, `applyKeys` walks every registered store and:

- Encrypts plaintext entries → current key. ✓
- Leaves old-version ciphertext alone (lazy migration on next `set` for that key). ✗

That second behavior is wrong for key rotation. When a user rotates their password, the keyring picks up a new current version; old-version ciphertext stays old-version until someone happens to write to it. For a workspace where most rows are read-only (notes, transcriptions, history), old-version ciphertext can live forever. If rotation was triggered by "I think my old password leaked," that's a meaningful security gap.

### The stated invariant

> **After `applyKeys(keys)` resolves, every decryptable entry in every registered store is ciphertext at the current key version.**

This extends the "eventually encrypted" invariant you had in mind to also cover rotation. It delivers the user story "rotate my password, all data upgrades to the new key" via one method call. The same one apps already make on login.

## The three policies

### Policy 1: Plaintext forever

**Who**: tab manager, any app without a privacy story.

```ts
const app = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = attachTables(ydoc, myTables);
  // no attachEncryption
  return { ydoc, tables, /* ... */ };
});
```

Already supported. No changes.

### Policy 2: Encrypt-after-login with eventual re-encryption (DEFAULT)

**Who**: every Epicenter app that wants encryption and also wants offline-first usage before sign-in.

```ts
const app = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id, gc: false });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, myTables);
  const kv = encryption.attachKv(ydoc, myKv);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { getToken: () => auth.token, waitFor: idb.whenLoaded });
  return { ydoc, tables, kv, encryption, idb, sync, /* ... */ };
});

// On login:
workspace.encryption.applyKeys(session.encryptionKeys);
workspace.sync.reconnect();

// On password change (rotation):
workspace.encryption.applyKeys(updatedSessionKeys);
// → every entry upgrades to the new key. Ciphertext propagates via CRDT sync.
```

**Guarantee**: live state on every device converges to ciphertext at the current key version. Pre-login plaintext becomes ciphertext on first login. Old-version ciphertext becomes current-version ciphertext on rotation.

**How eventual rotation works across devices:**

```
t0: Device A has v1 ciphertext for row X.
t1: User changes password. Device A runs applyKeys(v1+v2).
    → Walk re-encrypts X: {key: X, val: v2-ciphertext, ts: 2000} (monotonic).
t2: Sync uploads ciphertext. Server's LWW picks the ts=2000 v2 entry over ts=1000 v1.
t3: Device B downloads; its live view has v2 ciphertext.
```

At microseconds per XChaCha20-Poly1305 op on small JSON blobs (per the crypto module's docstring), a walk over 3000 rows is ~30ms. 100k rows ~1s. Not a perf concern.

### Policy 3: Zero-knowledge (app-level discipline, not a library mode)

**Who**: password managers; any "we never see your data, not even during setup" product.

Same primitives as Policy 2, plus app-level write gating in the UI. The library does not provide a runtime strict-mode flag: see "Non-goals" for the reasoning. An app that wants runtime enforcement can build a ~10-line Proxy wrapper:

```ts
function guardedTable<T>(table: Table<T>, areKeysLoaded: () => boolean): Table<T> {
  return new Proxy(table, {
    get(t, prop) {
      if ((prop === 'set' || prop === 'update' || prop === 'delete') && !areKeysLoaded())
        throw new Error('Cannot write before unlock');
      return t[prop];
    },
  });
}
```

**Guarantee** (enforced by the app, not the library): no data exists in plaintext. Ever. If you haven't entered your password, the UI refuses to write.

## The change

### API: unchanged

```ts
encryption.applyKeys(keys: EncryptionKeys): void;
```

One method. No opts. Same signature that's shipped for every prior version of the library.

### Behavior: extended walk

Inside `activateEncryption` on each store, the per-entry classification becomes:

```
for each entry in inner.map:
  case plaintext:
    → encrypt with currentKey (unchanged from prior behavior)
  case ciphertext at currentVersion:
    → no-op, skip (new: explicit cheap skip)
  case ciphertext at non-current version, decryptable via keyring:
    → decrypt, re-encrypt with currentKey (new: proactive rotation)
  case ciphertext at unknown version:
    → skip (unchanged; will catch up on a future applyKeys if the key arrives)
```

All re-encryption writes still go through `inner.doc.transact(..., REENCRYPT_ORIGIN)`, so observers don't see them as changes. Synthetic `add` events still fire for entries that became readable this pass (unchanged).

### Library-internal changes

- `y-keyvalue-lww-encrypted.ts:activateEncryption(keyring)`: walk classifies four cases instead of two; rewrites old-version ciphertext. Roughly +10 lines.
- `attach-encryption.ts`: unchanged. `applyKeys(keys)` does what it always did, fanning out to every store.

### What apps need to do

**Nothing.** Every existing app calls `applyKeys(keys)` with no options. The signature is unchanged. The behavior change is a strict improvement: rotation now works without the app needing to do anything.

## Why this replaces the earlier spec

An earlier draft of this spec proposed:

- `attachEncryption(ydoc, { strict: true })`: a zero-knowledge mode flag.
- `applyKeys(keys, { reencryptExisting: false })`: an opt-out for Policy 2 (never re-encrypt historical plaintext).
- `reencryptAll()`: a public method to explicitly trigger the plaintext-walk.

All three were added to support speculative use cases neither the user nor any shipped app had asked for. On review:

- **`strict` flag**: belt-and-suspenders for app-level UI gating. An app that zero-knowledges its writes already blocks at the UI layer; a library runtime check is dead code. Adding the flag required introducing `EncryptionNotReadyError`: an asymmetric error class that doesn't match the library's `throw new Error(...)` pattern used for every other invariant violation. `defineErrors` from `wellcrafted` wasn't a fit: it's a Result-type primitive, and `set` is a sync-throw API with 394+ call sites.
- **`reencryptExisting: false`**: opt-out for Policy 2. Policy 2 itself was speculative: no shipped app has a reason to keep pre-login plaintext plaintext at rest. The user's stated invariant ("eventually everything encrypted") is Policy 3 behavior, not Policy 2.
- **`reencryptAll()`**: only useful if you took the `reencryptExisting: false` opt-out. Remove the opt-out → no need for the method. The documented key-rotation use case is better served by the extended walk in `applyKeys` itself.

**Lesson**: don't add API surface for speculative policies. If someone needs a knob later, the knob can land with a real user story attached.

## Deleted from the earlier spec

- Policy 2 (never re-encrypt historical plaintext): dropped as a supported mode.
- `strict` flag + `EncryptionNotReadyError` class: rejected; rationale moved to "Non-goals."
- `reencryptAll()` method: rejected; better served by extending `applyKeys`.
- `opts?: { reencryptExisting? }` on `applyKeys`: rejected.
- `opts?: { reencryptPlaintext? }` on store-level `activateEncryption`: rejected.

## Security guarantees per policy

| Policy | At-rest encryption | Over-the-wire encryption | Pre-login data after login | Rotation behavior | First-write latency |
|---|---|---|---|---|---|
| 1: Plaintext | None | None | N/A | N/A | Instant |
| 2: Encrypt after login (default) | Eventually current-version ciphertext | Briefly plaintext during re-encrypt window, then current-version ciphertext | Re-encrypted on device, propagates via LWW | **Proactive**: all entries upgrade to new key on `applyKeys` | Instant |
| 3: Zero-knowledge (app-gated) | Always ciphertext (app gates writes) | Always ciphertext (app gates writes) | N/A: nothing exists pre-unlock | Same as Policy 2 | Blocks on unlock |

### CRDT history retention: unchanged nuance

Yjs with `gc: false` retains the full operation log. When `applyKeys` rewrites an entry, the LWW layer deletes the losing entry from the live yarray, but the losing operation persists in the doc's update history. A full state export (`Y.encodeStateAsUpdate(ydoc)`) still contains the old op.

Policy 2's guarantee is about **live state**, not history. Apps that need history-free plaintext have to prevent plaintext from ever entering the CRDT. I.e., Policy 3's app-level gating.

## Migration impact

**Zero action required.** Every existing Epicenter app calls `applyKeys(keys)`; all continue to work, just with correct rotation semantics as a free upgrade.

No version bump: packages in this repo are pre-release (workspace@0.2.0, others @0.1.0), unaligned, not yet published. Version alignment is a separate cleanup.

## Non-goals

- **`strict` flag / library-level write gating / `EncryptionNotReadyError`.** Considered and rejected:
  1. Belt-and-suspenders with app-level UI gating.
  2. Asymmetric error class (nothing else in the library throws a named subclass).
  3. `defineErrors` is a Result-type primitive; our sync-throw API doesn't fit.
  4. Policy 3 apps that want runtime enforcement can build it themselves (10-line Proxy).
- **`reencryptAll()` / `opts?: { reencryptExisting }`.** Considered and rejected: every use case collapses into either "rotation" (handled by the extended walk) or "opt out of eventual encryption" (no shipped app wants this).
- **Two-workspace anonymous migration model.** Rejected: Policy 2 with the extended walk achieves eventual encryption across devices without forcing apps to manage two `defineDocument` factories.
- **Touch-on-write lazy re-encryption.** Rejected: doubles every write, leaks ordering information, doesn't self-heal inactive rows. The eager walk on `applyKeys` is cleaner.
- **Per-row policy choice.** Encryption is a per-store decision (via `encryption.attachTable` vs plain `attachTable`). Keep.
- **Deprecating or breaking `applyKeys(keys)`.** No deprecation. Behavior extended within the existing signature.

## Rationale summary

The library's encryption layer was already correct for most of what Epicenter apps need. The only real gap was key rotation: existing code did lazy migration (wait for next `set`), which leaks old-version ciphertext indefinitely for read-heavy workspaces.

Fixing that is one classification case in the per-entry walk: "ciphertext at a non-current-but-decryptable version → re-encrypt." Roughly ten lines. One method, no flags, no new errors, no new mode. The rest of the work was spec and docs: writing down the policies so future contributors don't accidentally add speculative surface area (like an earlier draft of this spec did).

## Wave 1: shipped

- Extended `activateEncryption(keyring)` to re-encrypt old-version ciphertext in addition to plaintext.
- Updated tests that asserted the old lazy-migration behavior to assert the new eager-rotation behavior.
- Added a coordinator-level test verifying at-rest blob version upgrades on rotation.
- Rewrote the spec (this document) to reflect the actual shipped change.

## Wave 2: docs (pending)

- Update `packages/workspace/README.md` "Plaintext vs encrypted" section to describe the three policies (not two).
- Add a short "encryption policies" explainer with the policy selector, the CRDT-history nuance, the Policy 3 Proxy pattern.
- Update `.agents/skills/workspace-api/references/primitive-api.md`.

## Wave 3: optional hardening (stretch)

- Two-device test: device A writes pre-login, device B logs in first, rotation propagates to A.
- Benchmark `applyKeys` walk at 1K / 10K / 100K rows.
- Rename `activateEncryption` → something that reflects the extended behavior (e.g., `applyKeyring` or `setKeyring`). Low priority: internal-only name.
