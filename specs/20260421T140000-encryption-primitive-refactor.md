# Encryption Primitive Refactor: Explicit Encrypted Variants

**Date**: 2026-04-21
**Status**: Completed (2026-04-21)
**Author**: AI-assisted (design discussion with Braden)
**Branch**: `braden-w/document-primitive`

> **Completion note (2026-04-21):** Shipped as designed. Current code matches the Desired State below: `attachEncryption(ydoc)` with internal `register()`, and positional `attachEncryptedTable` / `attachEncryptedTables` / `attachEncryptedKv` variants. All seven app `client.ts` files compose using this shape. Retained as a completed record because the Variant A vs B vs C analysis under "Research Findings" is the rationale for future readers asking "why not `enc.attachTable(...)`?".

## Overview

Replace the `{ helpers } / { helper } / { tables, kv }` plumbing on `attachTables`, `attachKv`, and `attachEncryption` with explicit encrypted-variant primitives (`attachEncryptedTable`, `attachEncryptedTables`, `attachEncryptedKv`) that take `encryption` as a positional argument. Every `attachX` call site reads as its own intent, no stripped-off internal fields, no threaded dependency objects.

## Motivation

### Current State

```ts
// apps/whispering/src/lib/client.ts
const ydoc   = new Y.Doc({ guid: id, gc: false });
const tables = attachTables(ydoc, whisperingTables);
const kv     = attachKv(ydoc, whisperingKv);
const enc    = attachEncryption(ydoc, { tables, kv });

return {
  ydoc,
  tables: tables.helpers,   // strip internal coordination cable
  kv:     kv.helper,         // strip internal coordination cable
  enc,
  // ...
};
```

`attachTables` returns `{ helpers, stores }`; `attachKv` returns `{ helper, store }`. The `.stores`/`.store` fields exist solely so `attachEncryption` can coordinate key application across them. Every caller then has to strip them.

This creates problems:

1. **Leaky return types**: internal encryption plumbing surfaces in every `defineDocument` closure. Callers must know to write `tables.helpers` and `kv.helper`, or nothing works.
2. **Non-generalizable signature**: `attachEncryption(ydoc, { tables, kv })` hard-codes the two primitive kinds that can register. Any future encrypted primitive forces a signature change.
3. **Silent-plaintext failure mode**: the `{ stores }` escape hatch exists to let tests construct stores outside `attachTables`/`attachKv`. A caller who forgets to wire a store into that array writes plaintext indefinitely. No type guards prevent this.
4. **Implicit "all stores are encrypted"**: there's no way to attach a plaintext table today: e.g., for ephemeral UI state or local indexes. Every primitive always encrypts.

### Desired State

```ts
const ydoc       = new Y.Doc({ guid: id, gc: false });
const encryption = attachEncryption(ydoc);
const tables     = attachEncryptedTables(ydoc, encryption, whisperingTables);
const kv         = attachEncryptedKv(ydoc, encryption, whisperingKv);

return { ydoc, tables, kv, encryption, /* ... */ };
```

Every attachment returns the user-facing shape directly. `attachEncryption` has no per-primitive signature. The verb names the encryption policy: `attachEncryptedTable` is a grep-friendly audit token.

Plaintext variants remain available (`attachTable`, `attachTables`, `attachKv`) for ephemeral state that doesn't need encryption: composition by call-site choice, not global invariant.

## Research Findings

### Encryption mechanism: narrower than assumed, broader than it looks

`EncryptedYKeyValueLww` intercepts `set(key, val)` at the entry level: `JSON.stringify(val) → encryptValue(...) → Uint8Array blob`. The blob is stored as the value inside a `YKeyValueLwwEntry`. The `Y.Array` mechanics are encryption-unaware.

**Implications**:
- Encryption pattern is not `Y.Array`-specific; it's "intercept value-level writes on a CRDT." Same pattern would work for `Y.Map`.
- `Y.Text` is structurally incompatible: character-delta CRDT loses collaborative semantics if encrypted as blob.
- IDB / sync / broadcast / sqlite never see plaintext when encryption is active. They all transport Yjs binary update format, which carries the already-encrypted blobs inside it. No additional encryption needed at those layers.
- Awareness is ephemeral state over y-protocols. Encrypting it is possible but a different threat model; out of scope.

### Call-site variant comparison

Three shapes were evaluated at `apps/whispering/src/lib/client.ts` scale (5 tables, ~40 KV, IDB, broadcast):

| Variant | Call shape | Cold-read | Failure visibility | Extensibility | Grep-audit |
|---|---|---|---|---|---|
| A: separate primitives | `attachEncryptedTable(ydoc, enc, ...)` | 🟢 verb names outcome | 🟢 name differs | 🔴 combinatorial on 2nd axis | 🟢 one token |
| B: factory method | `enc.attachTable(...)` | 🟡 needs enc context | 🟡 receiver differs | 🟡 | 🔴 two tokens |
| C: option bag | `attachTable(ydoc, ..., { encryption: enc })` | 🟢 good | 🔴 silent omission | 🟢 scales | 🟡 |

**Key finding**: for a codebase where silent plaintext is the worst failure mode, A's grep-friendly audit surface (`rg "attachEncrypted"` finds every encrypted attachment) outweighs B's brevity and C's extensibility.

**Implication**: ship Variant A. The second-axis extensibility cost only matters if more per-store modifiers emerge (TTL, locality, custom merger); none exist today. If that day comes, migrate to C then.

### `attachSqlite` role

Bidirectional persistence, not a materializer. Reads all `updates` rows on open (`attach-sqlite.ts:64-68`), applies via `Y.applyUpdateV2`; writes every new update back (`:42-43`); compacts periodically. Sees already-encrypted bytes from the CRDT. No changes needed; keep name.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Call-site shape | Variant A (separate primitives, positional `encryption` arg) | Cold-readability + grep-audit outweigh brevity |
| Variable name | `encryption` | Reads as prose alongside `ydoc`; unambiguous at call sites |
| Batch form | Sugar over singular via `Object.fromEntries` | Zero semantics, pure naming |
| `register()` visibility | Internal (`@epicenter/document/internal`) | Only framework-internal primitives need it; no consumer-facing register |
| Plaintext primitives | Preserved (`attachTable`, `attachTables`, `attachKv`) | Enables ephemeral state; composition over enforcement |
| `attachEncryption` signature | `(ydoc)`: no `{ tables, kv }` | Stores self-register via `encryption.register(store)` |
| `attachEncryption` escape hatch | Dropped (no `{ stores }` overload) | Tests use the same `register()` pathway |
| `attachSqlite` rename | Keep | Correctly named: bidirectional persistence |
| `attachAwareness` change | None | No encryption axis in-scope |
| `defineWorkspace` fate | Update body to new primitives; evaluate removal separately | Decouple from this refactor |
| Migration rollout | Big-bang: all apps updated in one pass | Avoids parallel API surface |
| Type guard on `defineWorkspace` encryption | Skip | Encryption is composable by design; guard would overreach |

## Architecture

### Primitive matrix (post-refactor)

```
Plaintext                         Encrypted
─────────                         ─────────
attachTable(ydoc, name, def)      attachEncryptedTable(ydoc, encryption, name, def)
attachTables(ydoc, defs)          attachEncryptedTables(ydoc, encryption, defs)
attachKv(ydoc, defs)              attachEncryptedKv(ydoc, encryption, defs)
attachAwareness(ydoc, defs)       (n/a: out of scope)
```

All four table/kv entry points are thin wrappers over one internal `_attachTable` / `_attachKv` core.

### Encryption coordination

```
STEP 1: Construct encryption coordinator
────────────────────────────────────────
const encryption = attachEncryption(ydoc);
  → returns { applyKeys, register, whenDisposed }
  → register() is internal; public consumers never call it

STEP 2: Each encrypted primitive registers its store
────────────────────────────────────────────────────
attachEncryptedTable(ydoc, encryption, 'users', def)
  → creates EncryptedYKeyValueLww store
  → calls encryption.register(store)
  → returns typed Table helper

STEP 3: applyKeys iterates registered stores
────────────────────────────────────────────
encryption.applyKeys(keys)
  → dedup by fingerprint
  → derive keyring via HKDF
  → for each registered store: store.activateEncryption(keyring)
```

### Bundle shape diff

```
Before                           After
──────                           ─────
tables: tables.helpers      →   tables
kv:     kv.helper           →   kv
enc                         →   encryption       (variable renamed)
```

## Implementation Plan

### Phase 1: Core primitive refactor (`@epicenter/document` + `@epicenter/workspace`)

- [ ] **1.1** Add `register(store)` method to `EncryptionAttachment` type (exported from `packages/document/src/internal.ts`).
- [ ] **1.2** Rewrite `attachEncryption(ydoc)` to construct the registry internally; drop `{ tables, kv }` and `{ stores }` overloads.
- [ ] **1.3** Rewrite `attachTables` to return the helpers record directly (no `.helpers`/`.stores`). Add `attachTable` singular.
- [ ] **1.4** Add `attachEncryptedTable(ydoc, encryption, name, def)` and `attachEncryptedTables(ydoc, encryption, defs)` as thin wrappers that call `encryption.register(store)` after creation.
- [ ] **1.5** Rewrite `attachKv` to return the helper directly. Add `attachEncryptedKv(ydoc, encryption, defs)`.
- [ ] **1.6** Update `packages/workspace/src/index.ts` exports.
- [ ] **1.7** Commit as one atomic change: this layer has no external consumers beyond the apps (and `defineWorkspace`).

### Phase 2: Internal consumer updates

- [ ] **2.1** Update `defineWorkspace` body to use new primitives. Bundle shape preserves `enc` (aliased to `encryption`) for compatibility; deprecate in a follow-up.
- [ ] **2.2** Update `packages/skills/src/skill-instructions-docs.ts`, `reference-content-docs.ts`, and `packages/filesystem/src/file-content-docs.ts` if they touch these APIs.

### Phase 3: App migrations

- [ ] **3.1** `apps/whispering/src/lib/client.ts`
- [ ] **3.2** `apps/tab-manager/src/lib/client.ts`
- [ ] **3.3** `apps/zhongwen/src/lib/client.ts`
- [ ] **3.4** `apps/honeycrisp/src/lib/client.ts`
- [ ] **3.5** `apps/fuji/src/lib/client.ts`
- [ ] **3.6** `apps/opensidian/src/lib/client.ts`
- [ ] **3.7** `apps/breddit/src/lib/workspace/ingest/reddit/workspace.ts`

### Phase 4: Tests

- [ ] **4.1** Rewrite `packages/workspace/src/workspace/attach-tables.test.ts`
- [ ] **4.2** Rewrite `packages/workspace/src/workspace/attach-kv.test.ts`
- [ ] **4.3** Rewrite `packages/workspace/src/shared/attach-encryption.test.ts`
- [ ] **4.4** Verify `packages/document/src/attach-awareness.test.ts` is unaffected

### Phase 5: Documentation

- [ ] **5.1** Update `packages/document/README.md`
- [ ] **5.2** Update `.agents/skills/workspace-api/references/document-primitive.md`
- [ ] **5.3** Update the `defineDocument` module doc block (the `buildDoc` example at `define-document.ts:46-67`)

## Edge Cases

### Mix-and-match plaintext + encrypted

1. Caller batch-attaches 4 encrypted tables via `attachEncryptedTables(ydoc, encryption, {...})`.
2. Caller also needs one plaintext ephemeral cache table.
3. They add `const cache = attachTable(ydoc, 'cache', cacheDef)` and spread into the bundle: `tables: { ...encryptedTables, cache }`.
4. Expected: works; each call is independent; mix composes at the record-literal level.

### Singular inside mostly-batch workspace

1. Caller uses `attachEncryptedTables(ydoc, encryption, preBundledDefs)` for the main schemas.
2. Adds one extra encrypted table inline: `const drafts = attachEncryptedTable(ydoc, encryption, 'drafts', draftsDef)`.
3. Expected: both register with the same `encryption` handle; `applyKeys` activates all stores uniformly.

### Forgetting encryption on a table that should be encrypted

1. Caller writes `attachTable(ydoc, 'profile', profileDef)` when they meant `attachEncryptedTable(...)`.
2. Store is permanently plaintext: `applyKeys` doesn't touch it.
3. Failure mode: silent data-at-rest exposure. Mitigation: the `Encrypted` prefix in `attachEncryptedTable` is the loudest marker available without type-level enforcement. See Open Questions.

### Encryption attached before or after tables

1. `attachEncryption(ydoc)` must exist before any `attachEncrypted*` call that references it.
2. If caller inverts the order, TypeScript will error (undefined variable).
3. No runtime ordering requirement beyond the above: stores register into the live array; `applyKeys` iterates current registrations each call.

### `applyKeys` called before any stores registered

1. Caller calls `encryption.applyKeys(keys)` on an empty registry.
2. Fingerprint is recorded; HKDF runs; zero stores activated.
3. Subsequent `attachEncryptedTable` calls: stores are created fresh with no keyring applied.
4. Expected: `encryption.applyKeys` is idempotent: callers re-invoke after attaching stores. Behavior identical to today.

## Open Questions

1. **Should the encrypted registry auto-apply the current keyring to newly-registered stores?**
   - Options: (a) require explicit `applyKeys` after every new `register`, (b) cache the last-applied keyring and auto-activate on `register`.
   - **Recommendation**: (b): cache `lastKeyring` inside `EncryptionAttachment`; `register(store)` checks it and immediately calls `store.activateEncryption(lastKeyring)` if present. Matches intuition ("once keys are applied, new stores are encrypted from creation"). Low risk.

2. **Should plaintext primitives (`attachTable`, `attachKv`) still create `EncryptedYKeyValueLww` stores (just without ever activating them), or a distinct plaintext `YKeyValueLww` type?**
   - Options: (a) same `EncryptedYKeyValueLww`, activation is the toggle, (b) introduce a non-encrypted class, (c) make encryption a constructor flag.
   - **Recommendation**: (a) for now: the existing store already runs plaintext until activation. Adding a second class is premature given encryption may never be applied. Revisit if a perf audit shows overhead from carrying unused encryption scaffolding.

3. **Should `attachAwareness` gain an encrypted variant in this refactor?**
   - Out of scope per research findings; awareness is ephemeral and the threat model differs. Mark as non-goal.
   - **Recommendation**: defer. File a follow-up spec if needed.

4. **Type-level enforcement that `defineWorkspace` schemas go encrypted?**
   - Options: (a) no enforcement, (b) type-only assertion in the `defineWorkspace` sugar layer.
   - **Recommendation**: skip. `defineWorkspace` is scheduled for removal evaluation after this spec ships; spending complexity on enforcing an invariant on a potentially-doomed API is low-ROI.

5. **`attachEncryptedAwareness` / `attachEncryptedBlob` / encrypted `Y.Map`: are these foreseeable?**
   - Deferred. If/when they appear, they follow the same `encryption.register(store)` contract.

## Success Criteria

- [ ] All `tables.helpers` / `kv.helper` references removed from the codebase
- [ ] `attachEncryption` no longer accepts `{ tables, kv }` or `{ stores }`
- [ ] `rg "attachEncrypted"` lists every encrypted attachment across the monorepo
- [ ] All 7 apps migrated to new primitives
- [ ] `bun test` passes across `packages/workspace` and `packages/document`
- [ ] `bun run build` succeeds in every affected app
- [ ] `defineWorkspace` still functions (deprecation evaluation is a separate change)

## References

- `packages/document/src/define-document.ts`: cache + lifecycle
- `packages/document/src/attach-sqlite.ts`: persistence sibling (unchanged, kept for naming reference)
- `packages/document/src/attach-awareness.ts`: unchanged baseline
- `packages/workspace/src/shared/attach-encryption.ts`: primary rewrite target
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts:319`: encryption interception site
- `packages/workspace/src/workspace/attach-tables.ts`: primary rewrite target
- `packages/workspace/src/workspace/attach-kv.ts`: primary rewrite target
- `packages/workspace/src/workspace/define-workspace.ts`: internal consumer, update body
- `apps/whispering/src/lib/client.ts`: canonical app reference
- `specs/20260420T152026-definedocument-primitive.md`: upstream design
- `specs/20260420T230200-workspace-as-definedocument.md`: sibling restructuring
