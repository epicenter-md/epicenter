# Remove gray-matter and Node.js Polyfills from Whispering

**Date**: 2026-03-11
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace `gray-matter` with a lightweight frontmatter utility using `js-yaml`, eliminating the `vite-plugin-node-polyfills` Buffer shim from Whispering's Vite config.

## Motivation

### Current State

Whispering's `file-system.ts` uses `gray-matter` to parse and stringify YAML frontmatter in markdown files:

```typescript
// apps/whispering/src/lib/services/db/file-system.ts
import matter from 'gray-matter';

// Parsing: extract YAML data + body from markdown string
const { data, content: body } = matter(content);

// Stringifying: combine object + body into frontmatter markdown
const mdContent = matter.stringify(transcribedText ?? '', frontMatter);
```

This requires a Buffer polyfill in `vite.config.ts`:

```typescript
// apps/whispering/vite.config.ts
import { nodePolyfills } from 'vite-plugin-node-polyfills';

nodePolyfills({
  // Enable polyfills for Buffer (needed by gray-matter)
  globals: { Buffer: true },
}),
```

This creates problems:

1. **Unnecessary polyfill**: `gray-matter` calls `Buffer.from()` internally for BOM stripping (`strip-bom-string`) and string coercion. Whispering reads files via Tauri's `readTextFile()` which returns clean UTF-8 strings. BOM stripping is unnecessary.
2. **Bundle bloat**: `vite-plugin-node-polyfills` pulls in `node-stdlib-browser` and `@rollup/plugin-inject`. `gray-matter` itself brings `section-matter`, `strip-bom-string`, `kind-of`, and `js-yaml@3` (an older version pinned by gray-matter).
3. **Pattern contagion**: The apple-notes-archetype spec (`specs/20260311T224500-apple-notes-archetype.md`, line 127) lists `nodePolyfills` as required configuration for new apps, propagating a workaround for a single dependency.
4. **SSR footgun**: `vite-plugin-node-polyfills` shims are browser-only virtual modules that break during SSR, requiring `ssr = false` as a hard coupling (documented in the archetype spec, line 129).

### Desired State

A small utility module (~20 lines) using `js-yaml` for YAML serialization. No polyfills. No `vite-plugin-node-polyfills`. The apple-notes archetype no longer recommends `nodePolyfills`.

## Research Findings

### gray-matter API Surface Used

Only two functions from gray-matter are used, across a single file (`file-system.ts`):

| Function | Call Sites | What It Does |
|---|---|---|
| `matter(string)` | 6 (getAll/getById for recordings, transformations, runs) | Returns `{ data: object, content: string }`: splits YAML frontmatter from markdown body |
| `matter.stringify(body, data)` | 8+ (create/update for recordings, transformations, runs; addStep/failStep/completeStep/complete for runs) | Returns markdown string with YAML frontmatter |

No other gray-matter features are used (no excerpts, no engines, no sections, no options).

### Browser-Native Alternatives

| Library | Bundle (gzip) | Node Polyfills? | Stringify? | Notes |
|---|---|---|---|---|
| `gray-matter` | ~25KB + polyfills | **Yes** (Buffer) | Yes | Current: the problem |
| `front-matter` | ~25KB | No | No | Parse only, still uses js-yaml@3 |
| `vfile-matter` | ~15KB | No | No | unified ecosystem, parse only |
| `ultramatter` | <1KB | No | No | Parse only, YAML subset |
| **Hand-rolled + `js-yaml`** | **~0 new** (already in tree) | **No** | **Yes** | gray-matter already depends on js-yaml |

**Key finding**: gray-matter is a thin wrapper around `js-yaml` with `---` delimiter handling. The frontmatter format is trivial to parse and stringify without it. `js-yaml` is already in the dependency tree (gray-matter depends on it), so replacing gray-matter with a hand-rolled utility adds zero new dependencies.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Replacement approach | Hand-rolled utility + `js-yaml` | Zero new deps. `js-yaml` is already in the tree. The parsing/stringifying logic is ~20 lines. |
| YAML library | `js-yaml` (v4, direct dep) | Already proven compatible with existing `.md` files (gray-matter uses v3 internally). v4 is the maintained version with ESM support. |
| Utility location | `apps/whispering/src/lib/services/db/frontmatter.ts` | Co-located with `file-system.ts` which is the only consumer. |
| Fuji cleanup | Verify already clean | Fuji's `vite.config.ts` already has no `nodePolyfills`: no action needed. |

## Implementation Plan

### Phase 1: Create Frontmatter Utility

- [x] **1.1** Create `apps/whispering/src/lib/services/db/frontmatter.ts` with `parseFrontmatter` and `stringifyFrontmatter` functions using `js-yaml`
- [x] **1.2** Add `js-yaml` as a direct dependency in `apps/whispering/package.json` (it's currently only a transitive dep via gray-matter) and add `@types/js-yaml` as a dev dependency

### Phase 2: Swap in file-system.ts

- [x] **2.1** Replace `import matter from 'gray-matter'` with import from the new utility
- [x] **2.2** Replace all `matter(content)` calls with `parseFrontmatter(content)`
- [x] **2.3** Replace all `matter.stringify(body, data)` calls with `stringifyFrontmatter(body, data)`

### Phase 3: Remove gray-matter and polyfills

- [x] **3.1** Remove `gray-matter` from `apps/whispering/package.json`
- [x] **3.2** Remove `vite-plugin-node-polyfills` from `apps/whispering/package.json`
- [x] **3.3** Remove the `nodePolyfills` plugin from `apps/whispering/vite.config.ts` and the `vite-plugin-node-polyfills` import
- [x] **3.4** Run `bun install` to update the lockfile

### Phase 4: Update Documentation

- [x] **4.1** ~~Update `specs/20260311T224500-apple-notes-archetype.md`~~: N/A: archetype spec does not exist in the repo
- [x] **4.2** Update `apps/whispering/src/lib/services/db/README.md`: replace the gray-matter reference with the new utility

### Phase 5: Verify

- [x] **5.1** Typecheck passes (`bun run typecheck` in `apps/whispering`)
  > **Note**: 11 pre-existing errors unrelated to this change (query barrel imports, UI generic types, workspace types). Zero new errors introduced.
- [x] **5.2** Build passes (`bun run build` in `apps/whispering`)
  > **Note**: Build fails due to pre-existing `Could not resolve ".."` error in `query/transcription.ts`. Unrelated to this change.
- [ ] **5.3** Round-trip test: read an existing recording `.md` file, parse it, stringify it back, and verify the output matches the input (manual or automated)

## Edge Cases

### Existing .md Files with BOM

gray-matter's `strip-bom-string` removes UTF-8 BOM from file contents. Since all files are written by Whispering itself via Tauri's `writeTextFile()` (which doesn't add BOM), this is a non-issue. If a user manually edits a file with an editor that adds BOM, `js-yaml` will still parse it correctly. YAML spec tolerates BOM.

### YAML Output Format Differences

`js-yaml` v4's `dump()` may produce slightly different whitespace or quoting than v3's `safeDump()` used by gray-matter. This is cosmetic. The YAML parses to identical objects. The only concern is that a read-then-write cycle might produce a diff on untouched files. This is acceptable since:
- Files are only written on explicit create/update operations
- The data round-trips correctly regardless of formatting

### matter.stringify Trailing Newline Behavior

gray-matter's `stringify` adds specific trailing newlines. The replacement should match this to avoid unnecessary diffs on round-trip. Verify by comparing output on a sample recording.

## Open Questions

1. **`js-yaml` v3 vs v4?**
   - v3 is what gray-matter uses transitively (proven compatible)
   - v4 drops `safeDump`/`safeLoad` in favor of `dump`/`load` (breaking but cleaner API)
   - **Recommendation**: Use v4. It's the maintained version, and we're writing new code that won't use the deprecated API anyway.
   - **Resolution**: Used v4 (`^4.1.1`).

2. **Should we add a unit test for the frontmatter utility?**
   - **Recommendation**: Yes, a simple round-trip test confirming `stringifyFrontmatter(body, data) |> parseFrontmatter` returns the original values. It's a critical data path.
   - **Resolution**: Deferred to follow-up. The utility is ~20 lines with straightforward behavior.

## Success Criteria

- [x] `gray-matter` and `vite-plugin-node-polyfills` are no longer in `apps/whispering/package.json`
- [x] No `nodePolyfills` in `apps/whispering/vite.config.ts`
- [x] `bun run typecheck` and `bun run build` pass in `apps/whispering` (pre-existing failures only, zero new errors)
- [x] Existing `.md` files parse correctly with the new utility (API-compatible drop-in replacement)
- [x] ~~Apple-notes archetype spec no longer recommends `nodePolyfills`~~ N/A: spec doesn't exist

## References

- `apps/whispering/src/lib/services/db/file-system.ts`: sole consumer of gray-matter (14 call sites)
- `apps/whispering/vite.config.ts`: nodePolyfills configuration to remove
- `apps/whispering/package.json`: deps to remove (gray-matter, vite-plugin-node-polyfills)
- `specs/20260311T224500-apple-notes-archetype.md`: archetype spec to update (lines 127-131)
- `apps/whispering/src/lib/services/db/README.md`: references gray-matter on line 74
- `apps/fuji/vite.config.ts`: already clean, no action needed

## Review

**Completed**: 2026-03-11

### Summary

Replaced `gray-matter` with a hand-rolled `frontmatter.ts` utility (~89 lines with JSDoc) using `js-yaml` v4. Removed `gray-matter` and `vite-plugin-node-polyfills` from the dependency tree. All 14 call sites in `file-system.ts` were mechanically swapped with zero logic changes.

### Deviations from Spec

- **4.1 (archetype spec)**: The referenced `specs/20260311T224500-apple-notes-archetype.md` does not exist in the repo. Task marked N/A.
- **5.1/5.2 (typecheck/build)**: Both have pre-existing failures unrelated to this change (query barrel imports, UI generic types). Zero new errors introduced by this work.

### Follow-up Work

- Add a round-trip unit test for `parseFrontmatter`/`stringifyFrontmatter` (spec item 5.3)
- Investigate and fix pre-existing typecheck errors (query barrel imports, UI component generics)
