# Encryption Mode Renaming

**Date**: 2026-03-15
**Status**: Implemented

## Overview

Rename two of the three `EncryptionMode` values: `'plaintext'` → `'plaintext'` and `'unlocked'` → `'encrypted'`. Keep `'locked'` unchanged. It's universally understood and both vault and encryption metaphors agree on its meaning.

## Motivation

### Current State

```typescript
// packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts
export type EncryptionMode = 'plaintext' | 'locked' | 'unlocked';
```

### Problems

1. **`'unlocked'` sounds like encryption is off.** It actually means "encryption is encrypted, key in memory, reads decrypt, writes encrypt." A developer seeing `mode === 'unlocked'` for the first time would reasonably think the data is NOT encrypted.

2. **`'locked'` doesn't describe what's locked.** Is the data locked? The workspace? The user? It means "key was cleared, cache stays, writes throw". A suspension of the encryption capability, not a lock on anything visible.

3. **`'plaintext'` is the least confusing** but still has an issue: it's the name for both "never had a key" AND the format of data written in that mode. Overloaded meaning.

4. **The vault metaphor requires context.** Bitwarden/1Password users understand "locked vault = need to re-enter master password." But this isn't a vault app. It's a workspace platform. The metaphor adds a layer of indirection for developers who need to understand the encryption states.

### Desired State

```typescript
export type EncryptionMode = 'plaintext' | 'encrypted' | 'locked';
```

| Change | New Name | Meaning | Old Name |
|---|---|---|---|
| Rename | `'plaintext'` | No encryption configured. Data stored as raw JSON. | `'plaintext'` |
| Rename | `'encrypted'` | Key in memory. Writes encrypt, reads decrypt. | `'unlocked'` |
| Keep | `'locked'` | Key cleared. Cache readable, writes throw. | `'locked'` |

Reading `mode === 'encrypted'` immediately communicates "encryption is encrypted." `mode === 'plaintext'` communicates "no encryption at all." `mode === 'locked'` is universally understood. The workspace is locked, writes are blocked, re-authenticate to activateEncryption.

## Research Findings

### Is the Bitwarden naming a formal standard?

No. Bitwarden uses "Lock" and "Log out" in their UI. 1Password uses "Lock" and "Sign Out." KeePass uses "Lock workspace." These are UX conventions in vault apps, not formal specifications. The underlying concepts (key in memory vs key zeroed) are standard in cryptographic key management (NIST SP 800-57), but the specific words "locked"/"unlocked" are informal.

### What do other encrypted storage libraries use?

| Library | States | Naming |
|---|---|---|
| Bitwarden | 2 states | Locked / Unlocked |
| Signal Protocol | N/A | Key present or not (no named states) |
| libsodium | N/A | No state machine (caller manages key) |
| Web Crypto API | N/A | Key as CryptoKey object (no modes) |

Most encryption libraries don't have named modes. The caller either has the key or doesn't. Named modes are a convenience abstraction for the workspace layer. Since there's no industry standard, we should optimize for developer clarity.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `'plaintext'` → | `'plaintext'` | Descriptive, not editorial. `encryptionMode: 'plaintext'` reads like natural English-"What's the encryption mode? None." Follows standard patterns (`overflow: 'plaintext'`, `display: 'plaintext'`). Avoids the overloaded meaning of `'plaintext'` (both a mode and a data format) without being judgmental like `'unprotected'`. |
| `'unlocked'` → | `'encrypted'` | Reads naturally: "encryption is encrypted." Removes the ambiguity where `'unlocked'` could mean "encryption is off." |
| `'locked'` | Keep as-is | Universally understood. `lock()` → `'locked'` and `activateEncryption()` → `'encrypted'` read naturally. No rename needed. |
| Scope | All occurrences in workspace package + consumers | Mechanical rename via ast-grep + manual JSDoc/comment updates |

## Implementation Plan

### Phase 1: Rename the type and constants (mechanical)

- [ ] **1.1** `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: update `EncryptionMode` type definition and all string literals
- [ ] **1.2** `packages/workspace/src/workspace/types.ts`: update JSDoc references
- [ ] **1.3** `packages/workspace/src/workspace/create-workspace.ts`: update implementation references
- [ ] **1.4** `packages/workspace/src/workspace/index.ts`: re-export (no change needed if type re-exported)

### Phase 2: Update tests

- [ ] **2.1** `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts`: ~40 occurrences of mode string literals and `satisfies EncryptionMode`
- [ ] **2.2** `packages/workspace/src/workspace/create-workspace.test.ts`: ~10 occurrences

### Phase 3: Update consumers

- [ ] **3.1** `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts`: `mode === 'unlocked'` → `mode === 'encrypted'`
- [ ] **3.2** Any other apps referencing `workspaceClient.mode` (search all apps/)
- [ ] **3.3** Error messages or string literals containing `'unlocked'` or `'plaintext'` as mode references: update to new names. `'locked'` references do NOT change.

### Phase 4: Update documentation

- [ ] **4.1** JSDoc on `lock()`, `activateEncryption()` in `types.ts`: references to mode names
- [ ] **4.2** Spec file `specs/20260314T234500-encryption-hygiene.md`: mode references
- [ ] **4.3** Any CLAUDE.md or AGENTS.md references

### ast-grep Strategy

Mechanical renames that ast-grep can handle:
- String literal: `'plaintext'` → `'plaintext'` (in encryption mode contexts only)
- String literal: `'unlocked'` → `'encrypted'` (in encryption mode contexts only)

**Note**: `'locked'` does NOT change: no search/replace needed.

**Caution**: `'plaintext'` appears in non-mode contexts (crypto function parameters, test descriptions, JSDoc). ast-grep patterns must be scoped carefully. Target `satisfies EncryptionMode`, `mode ===`, and the type definition. Manual pass for JSDoc and comments. `'plaintext'` is a common word, so replacements must be strictly scoped to encryption mode contexts.

## Edge Cases

### Third-party code referencing modes

Consumers outside the monorepo (if any) would break. Currently all consumers are internal. The `EncryptionMode` type export ensures TypeScript catches any missed renames at compile time.

### Error messages containing old names

Error messages containing `'locked'` do NOT need to change (e.g., "Workspace is locked: sign in to write" stays as-is). Review error messages or logs that reference `'unlocked'` or `'plaintext'` as mode values and update them.

## Open Questions

1. **Should `lock()` and `activateEncryption()` methods also be renamed?**
   - Since `'locked'` stays as-is, `lock()` → `'locked'` is perfectly aligned
   - `activateEncryption()` → `'encrypted'` reads naturally: "you activateEncryption the workspace and encryption becomes encrypted"
   - **Decision**: Keep `lock()`/`activateEncryption()` as method names. They describe the ACTION; mode names describe the RESULTING STATE.

2. **Why `'plaintext'` over `'unprotected'`?**
   - `'unprotected'` is editorial. It describes a security *judgment*, not a state. Good enum values describe what IS, not how to feel about it.
   - `'unprotected'` is grammatically wrong for the type: "Encryption mode is unprotected" doesn't parse. `'plaintext'` does: "Encryption mode is plaintext."
   - `'plaintext'` follows established patterns: `overflow: 'plaintext'`, `display: 'plaintext'`, `pointerEvents: 'plaintext'`. Developers parse it instantly.
   - Alternatives considered: `'open'`, `'passthrough'`, `'disabled'`: all weaker than `'plaintext'` for this context.
   - **Decision**: Use `'plaintext'`. Descriptive, idiomatic, zero ambiguity.

## Success Criteria

- [ ] `EncryptionMode` type is `'plaintext' | 'encrypted' | 'locked'`
- [ ] All tests pass with new mode names
- [ ] No string literal `'plaintext'` or `'unlocked'` used as mode values anywhere
- [ ] `'locked'` remains unchanged throughout codebase
- [ ] JSDoc and error messages updated where they reference old names
- [ ] TypeScript compilation succeeds across all packages and apps

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: Type definition and implementation (~60 mode references)
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts`: ~40 test references
- `packages/workspace/src/workspace/types.ts`: WorkspaceClient type JSDoc
- `packages/workspace/src/workspace/create-workspace.ts`: Implementation
- `packages/workspace/src/workspace/create-workspace.test.ts`: ~10 test references
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts`: Consumer
