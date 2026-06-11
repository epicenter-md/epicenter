# Filesystem Error Namespace Migration

**Date**: 2026-02-20
**Status**: Complete
**Author**: AI-assisted

## Overview

Migrate `packages/filesystem` error construction from `fsError('CODE', msg)` to a namespace object `FS_ERRORS.CODE(msg)` for better IDE discoverability while preserving grep-ability and just-bash compatibility.

## Motivation

### Current State

```typescript
// validation.ts
type FsErrorCode =
	| 'ENOENT'
	| 'EISDIR'
	| 'EEXIST'
	| 'ENOSYS'
	| 'EINVAL'
	| 'ENOTEMPTY'
	| 'ENOTDIR';

export function fsError(
	code: FsErrorCode,
	message: string,
): Error & { code: FsErrorCode } {
	const err = new Error(`${code}: ${message}`) as Error & { code: FsErrorCode };
	err.code = code;
	return err;
}

// Call sites (~20 across 3 files):
throw fsError('ENOENT', path);
throw fsError('EISDIR', abs);
throw fsError('ENOSYS', 'symlinks not supported');
```

This works, but:

1. **Discoverability**: A new developer must know to type `fsError('` and wait for string literal autocomplete to see available codes. The available errors aren't browseable from the import alone.
2. **Call-site noise**: The quoted string code + separate message reads more "generic API" than "errno-style throw".

### Desired State

```typescript
throw FS_ERRORS.ENOENT(path);
throw FS_ERRORS.EISDIR(abs);
throw FS_ERRORS.ENOSYS('symlinks not supported');
```

Type `FS_ERRORS.` and the IDE immediately lists all 7 errno codes. The code is visible at the call site for grep. Single import.

## Research Findings

### How just-bash Consumes These Errors

just-bash catches errors from `IFileSystem` implementations and **string-matches the error message**:

```javascript
// From just-bash bundled source (minified):
s.includes('ENOENT') || s.includes('no such file');
s.includes('EEXIST') || s.includes('already exists');
s.includes('ENOTEMPTY') || s.includes('not empty');
```

**Key finding**: just-bash does NOT check `.code` or use `instanceof`. The error message string is the only contract.

**Implication**: The error message must contain the errno code string (e.g., `"ENOENT: /foo.txt"`). The `.code` property, class hierarchy, and construction method are irrelevant to just-bash. Any approach that preserves the message format works.

### Internal Consumers

Only one file in the monorepo catches filesystem errors with `.code` checks: `packages/epicenter/src/cli/parse-input.ts`, and it checks **Node.js** `readFileSync` errors, not virtual filesystem errors. No code outside `packages/filesystem` catches `fsError`-produced errors by `.code`.

### Ergonomics Comparison (Four Approaches Evaluated)

| Criterion             | A: `fsError('CODE', msg)`   | B: `FS_ERRORS.CODE(msg)`    | C: `fsEnoent(msg)`       | D: `FsError.enoent(msg)` |
| --------------------- | --------------------------- | --------------------------- | ------------------------ | ------------------------ |
| Discoverability       | Good (string autocomplete)  | **Best** (dot-autocomplete) | Worst (must know naming) | Good (dot-autocomplete)  |
| Grep-ability          | **Best** (`ENOENT` literal) | **Best** (`ENOENT` literal) | Bad (grep `fsEnoent`)    | Bad (grep `.enoent`)     |
| Import ergonomics     | 1 import                    | 1 import                    | 7 imports                | 1 import                 |
| Extensibility         | Update union                | Add property + union        | New export + union       | Add static + union       |
| Call-site readability | Fine but noisy              | **Clean**                   | Inconsistent casing      | Lowercase hides code     |

**Ranking**: B > A > D > C

B wins because it's the only approach that maximizes both discoverability (dot-autocomplete) AND grep-ability (ENOENT visible at call sites).

## Design Decisions

| Decision                                  | Choice | Rationale                                                                   |
| ----------------------------------------- | ------ | --------------------------------------------------------------------------- |
| Keep `fsError` as internal implementation | Yes    | Single place for message formatting. `FS_ERRORS` delegates to it.           |
| Export `FS_ERRORS` as the public API      | Yes    | Replaces direct `fsError` usage at call sites.                              |
| Keep `FsErrorCode` union type             | Yes    | Source of truth for valid codes. `FS_ERRORS` keys mirror it.                |
| Export `FsErrorCode` type                 | Yes    | Consumers may need it for catch-site type narrowing.                        |
| Stop exporting `fsError` from `index.ts`  | Yes    | `FS_ERRORS` replaces it as the public API. Keep `fsError` as internal-only. |

## Architecture

```
┌─────────────────────────────────────────┐
│ validation.ts                           │
│                                         │
│  type FsErrorCode = 'ENOENT' | ...     │
│                                         │
│  function fsError(code, msg)  (private) │
│                                         │
│  export const FS_ERRORS = {             │
│    ENOENT: (msg) => fsError(...)        │
│    EISDIR: (msg) => fsError(...)        │
│    EEXIST: (msg) => fsError(...)        │
│    ENOSYS: (msg) => fsError(...)        │
│    EINVAL: (msg) => fsError(...)        │
│    ENOTEMPTY: (msg) => fsError(...)     │
│    ENOTDIR: (msg) => fsError(...)       │
│  }                                      │
└─────────────────────────────────────────┘
         │
         ▼ used by
┌─────────────────────────────────────────┐
│ file-tree.ts, yjs-file-system.ts,       │
│ validation.ts (internal)                │
│                                         │
│ throw FS_ERRORS.ENOENT(path)            │
│ throw FS_ERRORS.EISDIR(abs)             │
└─────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Add `FS_ERRORS` namespace to `validation.ts`

- [x] **1.1** Add `FS_ERRORS` object with a factory function per `FsErrorCode`, each delegating to `fsError`
- [x] **1.2** Remove the `export` keyword from `fsError` (make it module-private)
- [x] **1.3** Update `index.ts`: replace `fsError` export with `FS_ERRORS` export; also export `FsErrorCode` type

### Phase 2: Migrate call sites

- [x] **2.1** `validation.ts`: update `validateName` and `assertUniqueName` (~3 throw sites)
- [x] **2.2** `file-tree.ts`: update all `fsError` calls (~4 throw sites), update import
- [x] **2.3** `yjs-file-system.ts`: update all `fsError` calls (~12 throw sites), update import

### Phase 3: Verify

- [x] **3.1** Run `lsp_diagnostics` on all changed files: 0 errors on all 5 changed files
- [x] **3.2** Run `bun test` in `packages/filesystem`: 208 tests pass, 0 failures

## Edge Cases

### Existing external consumers importing `fsError`

1. `fsError` is currently exported from `packages/filesystem/src/index.ts`
2. Removing it is a breaking change for any external consumer
3. Grep showed no imports of `fsError` outside `packages/filesystem` itself
4. Safe to remove from public API

### Test assertions checking error shape

1. Tests in `validation.test.ts` assert on `fsError` directly
2. Tests in `file-tree.test.ts` and `yjs-file-system.test.ts` assert on thrown error properties
3. All tests check `.code` and/or `.message`: both remain identical after migration
4. The `validation.test.ts` tests that call `fsError` directly will need updating to use `FS_ERRORS` or to keep calling the now-private `fsError` via `FS_ERRORS` indirectly

## Open Questions (Resolved)

1. **Should `fsError` remain exported for test access?**
   - **Resolution**: (b): tests updated to use `FS_ERRORS.ENOENT()` directly. `fsError` is now fully private.

2. **Should `FS_ERRORS` factory signatures be more specific than `(message: string)`?**
   - **Resolution**: (a): all factories take `(message: string)`. Cosmetic parameter names not worth the maintenance cost.

## Success Criteria

- [x] `FS_ERRORS` is the only public error construction API
- [x] All ~19 throw sites use `FS_ERRORS.CODE(msg)` pattern
- [x] `fsError` is no longer exported from `index.ts`
- [x] All existing tests pass without modification to assertions (only import/call changes)
- [x] `grep ENOENT packages/filesystem/src/` finds every throw site
- [x] No residual `fsError` references outside `validation.ts` private implementation

## References

- `packages/filesystem/src/validation.ts`: error factory definition (change here)
- `packages/filesystem/src/file-tree.ts`: ~5 throw sites to migrate
- `packages/filesystem/src/yjs-file-system.ts`: ~12 throw sites to migrate
- `packages/filesystem/src/index.ts`: public API exports (swap `fsError` → `FS_ERRORS`)
- `packages/filesystem/src/validation.test.ts`: tests that import `fsError` directly

## Review

### Changes made (5 files)

| File                 | What changed                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `validation.ts`      | Added `FS_ERRORS` namespace with `satisfies` constraint, made `fsError` private, exported `FsErrorCode` type, migrated 3 internal throws |
| `index.ts`           | Swapped `fsError` export → `FS_ERRORS` + `FsErrorCode`                                                                                   |
| `file-tree.ts`       | Updated import, migrated 4 throw sites                                                                                                   |
| `yjs-file-system.ts` | Updated import, migrated 12 throw sites                                                                                                  |
| `validation.test.ts` | Updated import + test block to use `FS_ERRORS.ENOENT()`                                                                                  |

### Verification

- 0 LSP errors across all changed files
- 208 tests pass, 0 failures
- `grep fsError` across the monorepo returns only the private function + its 7 delegate calls in `validation.ts`
- No external consumers of `fsError` existed, so no breakage
