# Encrypted KV: Collapse the Helper Sprawl

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive (continuing)

## Overview

Rewrite the internals of `createEncryptedYkvLww` to collapse five decrypt-adjacent helpers into two and eliminate a redundant decrypt op on the rotation path. Public API, observable behavior, and test surface are unchanged. This is a clarity-driven refactor, not a behavior change.

## Motivation

### Current state

The module exports one factory, `createEncryptedYkvLww`. Inside, five closure-scoped helpers handle the decrypt path and two structural copies handle the encrypt path.

```ts
// Five decrypt-adjacent helpers:
const tryDecryptBlob  = (blob, aad, state) => { /* try currentKey, then keyring[version] */ };
const tryDecryptEntry = (key, entry)       => { /* isEncryptedBlob guard + tryDecryptBlob + JSON.parse + log on failure */ };
const tryDecryptValue = (raw, aad, state)  => { /* isEncryptedBlob guard + tryDecryptBlob + JSON.parse, silent */ };
const countDecryptable = ()                => { /* iterate inner.map, tryDecryptValue each */ };
const iterateDecrypted = function* (it)    => { /* iterate, tryDecryptValue each, yield plaintext */ };

// Two parallel encrypt paths:
set(key, val)        { if (!encryption) inner.set(key, val); else inner.set(key, encryptValue(...)); }
bulkSet(entries)     { if (!encryption) inner.bulkSet(entries); else { const enc = encryption; inner.bulkSet(entries.map(...)); } }
```

This creates problems:

1. **Three near-duplicates of the same decrypt dance.** `tryDecryptBlob`, `tryDecryptValue`, and `tryDecryptEntry` all handle "isEncryptedBlob guard → try current key → try recorded version → JSON.parse". They differ only in return shape (string vs T vs entry) and in whether they log on failure. Anyone changing the decrypt fallback policy has to update three places.
2. **Logging coupled to a helper identity.** `tryDecryptEntry` logs; `tryDecryptValue` doesn't. The distinction is "who calls it" (observer logs, everyone else is silent), but that's encoded as two helpers rather than a caller-side choice. Moves the logging decision away from the one call site that actually cares.
3. **Redundant decrypt during `activateEncryption` walk.** The walk decrypts each rotatable entry *twice*: once to get the plaintext for re-encryption, again against `previousEncryption` to answer "was this readable before?" With authenticated crypto and immutable key versions, a map lookup (`previousEncryption?.keyring.has(version)`) is equivalent and O(1). Small perf win, but a real one under rotation.
4. **`bulkSet`'s `const enc = encryption;` narrowing workaround.** TS doesn't preserve the closure-captured `encryption` guard into the `.map` callback, so `bulkSet` aliases it to a fresh `const`. Ugly and unnecessary if the encrypt path is extracted to a helper.

### Desired state

Two helpers carry all the real work. Everything else is wiring.

```ts
// One decrypt function. Caller decides whether to log.
const decrypt = (raw, aad, state = encryption): T | undefined => { /* ~7 lines */ };

// One encrypt/passthrough function for writes.
const toStored = (key, val): EncryptedBlob | T => { /* ~3 lines */ };

set(key, val)    { inner.set(key, toStored(key, val)); }
bulkSet(entries) { inner.bulkSet(entries.map(({key, val}) => ({key, val: toStored(key, val)}))); }

get(key)         { const raw = inner.get(key); return raw === undefined ? undefined : decrypt(raw, textEncoder.encode(key)); }
```

The observer logs at its own call site. `size` and `unreadableEntryCount` inline a 3-line loop each. The walk uses `previousEncryption?.keyring.has(version)` instead of a second decrypt.

## Research findings

### Why five helpers exist today

Historical accretion, not design. Git-trace: `tryDecryptBlob` predates the other two and factored the keyring-fallback logic. `tryDecryptValue` and `tryDecryptEntry` grew alongside separate call sites (observer vs. get/entries) with slightly different return shapes and logging needs. Nothing forced the three-helper split. It emerged from not consolidating as call sites were added.

### Call-site audit

| Helper             | Callers                                          | What's needed       |
| ------------------ | ------------------------------------------------ | ------------------- |
| `tryDecryptBlob`   | `tryDecryptValue`, `tryDecryptEntry`             | Inline into one `decrypt` |
| `tryDecryptValue`  | `get`, `has`, `countDecryptable`, `iterateDecrypted`, `activateEncryption` walk | All want `T \| undefined` silently |
| `tryDecryptEntry`  | observer only                                    | Inline into observer, own the log there |
| `countDecryptable` | `size`, `unreadableEntryCount`                   | Two callers, 3 lines: inline |
| `iterateDecrypted` | `entries` only                                   | One caller: inline |

**Key finding**: every "helper" with one caller should inline; every helper with multiple callers that does the same work should unify. Current file has the opposite pattern.

### Why the double-decrypt is safe to replace

Claim: `tryDecryptValue(blob, aad, previousEncryption) !== undefined` ⇔ `previousEncryption?.keyring.has(getKeyVersion(blob)) === true`, for blobs that also decrypt under `nextEncryption`.

Proof sketch:
- `⇐` direction: if previous keyring had the version, and the blob later decrypts under new keyring (which contains all previous versions plus the new one), the key material at that version didn't change → it decrypted before too.
- `⇒` direction: if it decrypted before, the key for its version was in `previousEncryption.keyring` by definition.
- Corruption case: a corrupted blob doesn't decrypt under *any* keyring. The walk filters those out at `if (decrypted === undefined) continue;` before the `wasReadable` check, so they never reach the version-lookup path.

Assumption this rests on: **key material for an existing version is immutable across calls to `activateEncryption`.** This is true for the shipped rotation flow (rotation adds new versions; never rewrites old ones). If an app somehow passes a different `Uint8Array` for version 1 across two calls, that's misuse, and the current double-decrypt would also produce surprising results in that case.

## Design decisions

| Decision                                              | Choice                                   | Rationale                                                                                              |
| ----------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| How many decrypt helpers                              | One (`decrypt`)                          | Same dance in all three current helpers; return shape differences are trivial at the call site        |
| How many encrypt helpers                              | One (`toStored`)                         | `set` and `bulkSet` have identical shape; eliminates the `const enc = encryption;` TS workaround       |
| Where logging lives                                   | Observer call site                       | Only one caller needs logging; moving it there removes the need for a second decrypt helper           |
| Walk's "wasReadable" check                            | `previousEncryption?.keyring.has(ver)`   | Equivalent under authenticated crypto + immutable versions; O(1) vs. XChaCha20 op                      |
| `size` and `unreadableEntryCount` implementation      | Inline 3-line loops                      | Two callers, trivial body: helper adds nothing                                                        |
| `iterateDecrypted` generator                          | Inline into `entries()`                  | One caller: no reason to extract                                                                      |
| Whether to change public API                          | **No**                                   | Strictly internal cleanup; all 50+ call sites untouched                                                |
| Whether to change test surface                        | **No**                                   | Tests assert behavior; this rewrite is behavior-preserving                                             |
| Whether to change the `REENCRYPT_ORIGIN` mechanism    | **No**                                   | Works correctly; not what we're here to fix                                                            |
| Whether to change `let encryption`                    | **No**                                   | Fundamental to the API (passthrough-then-activate); no cleaner alternative                             |

## Architecture

### Before (current)

```
createEncryptedYkvLww(ydoc, arrayKey)
  │
  ├── tryDecryptBlob    ─┐
  ├── tryDecryptValue   ─┼── three overlapping decrypt paths
  ├── tryDecryptEntry   ─┘
  │
  ├── countDecryptable  ─┐
  ├── iterateDecrypted  ─┘── two single-caller iterators
  │
  └── returns { set, bulkSet, get, has, delete, ..., activateEncryption, ... }
      │                 │
      └── set  / bulkSet: two copies of "if encryption then encrypt else passthrough"
```

### After (proposed)

```
createEncryptedYkvLww(ydoc, arrayKey)
  │
  ├── decrypt    ── one decrypt function, silent, caller-driven
  ├── toStored   ── one encrypt/passthrough function for writes
  │
  └── returns { set, bulkSet, get, has, delete, ..., activateEncryption, ... }
      │                 │
      ├── set  / bulkSet: both call toStored
      ├── get  / has:     both call decrypt
      ├── entries:        inline loop over inner.entries, call decrypt
      ├── observer:       inline loop, call decrypt, log on failure here
      ├── size / unreadableEntryCount: inline 3-line loop each
      └── activateEncryption:
            walk uses decrypt(entry.val, aad, nextEncryption)
            uses previousEncryption?.keyring.has(ver) for wasReadable (no second decrypt)
            writes via toStored inside REENCRYPT_ORIGIN transact
```

### `decrypt` signature

```ts
const decrypt = (
  raw: EncryptedBlob | T,
  aad: Uint8Array,
  state: EncryptionState | undefined = encryption,
): T | undefined => {
  if (!isEncryptedBlob(raw)) return raw as T;         // plaintext passthrough
  if (!state) return undefined;                        // passthrough mode, blob unreadable
  try { return JSON.parse(decryptValue(raw, state.currentKey, aad)) as T; } catch {}
  const versionKey = state.keyring.get(getKeyVersion(raw));
  if (!versionKey || versionKey === state.currentKey) return undefined;
  try { return JSON.parse(decryptValue(raw, versionKey, aad)) as T; } catch { return undefined; }
};
```

The `state` parameter defaults to the closure's `encryption`. The walk overrides it to compare blobs against `nextEncryption` before mutating the closure mid-iteration.

### `toStored` signature

```ts
const toStored = (key: string, val: T): EncryptedBlob | T => {
  if (!encryption) return val;
  return encryptValue(
    JSON.stringify(val),
    encryption.currentKey,
    textEncoder.encode(key),
    encryption.currentVersion,
  );
};
```

Pure function of the closure's `encryption`. No TS narrowing workaround needed; the body reads `encryption` twice under one conditional.

## Implementation plan

### Phase 1: mechanical rewrite

- [ ] **1.1** Replace `tryDecryptBlob`, `tryDecryptValue`, `tryDecryptEntry` with one `decrypt` helper.
- [ ] **1.2** Add `toStored` helper; rewrite `set` and `bulkSet` to call it.
- [ ] **1.3** Inline `countDecryptable` into both `size` and `unreadableEntryCount` getters (or collapse: `size = inner.map.size - unreadableEntryCount`).
- [ ] **1.4** Inline `iterateDecrypted` into `entries()`.
- [ ] **1.5** Move the decrypt-failure warning from the deleted `tryDecryptEntry` into the observer's inline loop. Preserve exact warning text.
- [ ] **1.6** In `activateEncryption`'s walk, replace the second `tryDecryptValue(..., previousEncryption)` call with `previousEncryption?.keyring.has(getKeyVersion(entry.val)) ?? false`, negated for `wasReadable`.
- [ ] **1.7** Run the full workspace test suite. Expect: all 98 existing tests pass unchanged.

### Phase 2: docstring cleanup

- [ ] **2.1** Update the top-level `@module` JSDoc to reference the new structure (no more three-helper mention).
- [ ] **2.2** Delete the now-obsolete comment on `tryDecryptBlob`'s `state` parameter (lines 198-200 in current file). Move the "why state is overrideable" note to `decrypt`'s JSDoc.

### Phase 3: stretch (not blocking)

- [ ] **3.1** Consider deduplicating the decrypt-failure warning (once per key until seen successfully). Currently flags every pass. Not a bug, not required.
- [ ] **3.2** Benchmark `activateEncryption` walk at 10K / 100K rows, pre- and post-refactor. Confirm the version-lookup path is measurably faster under rotation.

## Edge cases

### Corrupted blob during activation walk

1. `inner.map` iteration reaches a blob whose MAC fails validation under the current key AND whose version-indexed key also fails.
2. `decrypt(entry.val, aad, nextEncryption)` returns `undefined`.
3. `continue`: not added to `toRewrite`, not added to `newlyReadable`.
4. Entry stays unreadable. `unreadableEntryCount` reflects it. Unchanged from today.

### Blob at a version present in `nextEncryption` but not `previousEncryption`

1. First `activateEncryption(keyring = {1})` call → some blobs encrypted at v1.
2. Second call: `activateEncryption(keyring = {1, 2})`, so `previousEncryption = {1}`, `nextEncryption = {1, 2}`.
3. A blob at v1 decrypts under `nextEncryption` (key 1 is in it).
4. `previousEncryption?.keyring.has(1)` → `true` → NOT newly readable. Correct: it was readable before.
5. Re-encrypted under v2 as part of rotation.

### First activation (previousEncryption is undefined)

1. `activateEncryption({1})` for the first time.
2. `previousEncryption === undefined`.
3. `previousEncryption?.keyring.has(version) ?? false` evaluates to `false` → newly readable.
4. Every previously-skipped ciphertext entry fires a synthetic `add` event. Correct: observer in passthrough mode silently skipped them all.

### Observer fires during the walk's inner.doc.transact

1. REENCRYPT_ORIGIN writes happen inside `inner.doc.transact(..., REENCRYPT_ORIGIN)`.
2. Inner observer runs with `origin === REENCRYPT_ORIGIN` → filtered at line 1, no handler dispatch.
3. Unchanged from today.

### Concurrent `set` during `activateEncryption`

1. JS single-threaded + `activateEncryption` is sync → not possible.
2. No-op.

## Open questions

1. **Should `size` short-circuit if `encryption` is absent?**
   - In passthrough mode, every entry is plaintext, so `size === inner.map.size`. The current `countDecryptable` pays O(n) for nothing.
   - Options: (a) add a fast path `if (!encryption) return inner.map.size;`, (b) leave as-is for uniformity.
   - **Recommendation**: (a) is trivially correct and turns a linear scan into a property read. Worth including.

2. **Move the REENCRYPT_ORIGIN symbol inside the factory?**
   - It's currently module-scoped. It doesn't need to be: the symbol is only used internally.
   - **Recommendation**: leave module-scoped. Moving it inside the factory creates a fresh symbol per instance and marginally complicates testing. Not worth the change.

3. **Should `decrypt` log at the call site or push a "decrypt result" type?**
   - Alternative: `decrypt` returns `{ ok: true, val } | { ok: false, reason }` and callers pattern-match.
   - **Recommendation**: no. Two call sites need the silent version, one needs the logging version. A tagged union adds wrapping/unwrapping at three call sites to save one `console.warn`. Overshoot.

## Success criteria

- [ ] `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` shrinks by ~80 lines (estimate; actual may vary).
- [ ] Five helper declarations reduce to two (`decrypt`, `toStored`).
- [ ] `bun test packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts` → 98 pass, 0 fail.
- [ ] `bun test packages/workspace/src/shared/crypto/crypto.test.ts` → all pass.
- [ ] `bun test packages/workspace/src/document/attach-encryption.test.ts` → all pass.
- [ ] `bunx tsc --noEmit` for the workspace package → no new errors in touched files.
- [ ] No public API changes; no test file needs to change.
- [ ] The decrypt-failure warning text is identical to today's (observers depend on grep-ability).

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: the target module.
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts`: 98 behavior tests that must keep passing.
- `packages/workspace/src/shared/crypto/index.ts`: `encryptValue`, `decryptValue`, `getKeyVersion`, `isEncryptedBlob`. Unchanged.
- `packages/workspace/src/document/y-keyvalue/index.ts`: `YKeyValueLww` and its types. Unchanged.
- `packages/workspace/src/document/attach-encryption.ts`: the only production caller. No changes expected.
- `specs/20260422T181617-encryption-policy-split.md`: prior spec that shipped the 4-case walk. This rewrite preserves that walk's semantics.
- Commit `06014afa5`: added the rotation fix whose "double-decrypt for wasReadable" is the perf pebble this spec kicks out.
- Commit `3b7cdf1f6`: dropped `initialKeyring` opt; the cleaner API this rewrite assumes.
