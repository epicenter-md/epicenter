# Rename "content" to "body" in Markdown Index

**Timestamp**: 20251103T214530
**Status**: Planning

## Problem Statement

The Markdown index currently uses the term "content" to describe the markdown body (the text after the frontmatter delimiters). However, this terminology is overloaded:
- In `parseMarkdownFile()`, "content" refers to both the entire file AND the extracted body
- Variable naming uses `markdownContent` and `bodyContent` inconsistently
- The semantic intent is: a markdown file has a "front matter" and a "body"

This creates cognitive overhead for developers. We want to standardize on "body" everywhere for clarity.

## Scope Analysis

### Files Affected
1. `/packages/epicenter/src/indexes/markdown/index.ts` - Main implementation
2. `/packages/epicenter/src/indexes/markdown/parser.ts` - File parsing logic
3. `/packages/epicenter/src/indexes/markdown/operations.ts` - File writing logic
4. `/packages/epicenter/src/indexes/markdown/README.md` - Documentation

### Breaking vs. Non-Breaking
- **Breaking**: `MarkdownSerializer` interface (public API) uses `content` parameter
- **Non-Breaking**: Internal variable names and documentation

### Key Insight
Users with custom serializers will need to update from `content` to `body`, but the change is straightforward. The semantic clarity is worth the breaking change.

## Refactoring Plan

### Phase 1: Type Definitions & Public API
- [ ] Rename `content: string` to `body: string` in `MarkdownSerializer.serialize()` return type
- [ ] Rename `content: string` to `body: string` in `MarkdownSerializer.deserialize()` parameter
- [ ] Update JSDoc comments to reference "body" instead of "content"

### Phase 2: Implementation (index.ts)
- [ ] Update `registerYJSObservers()` destructuring: `const { frontmatter, content }` → `{ frontmatter, body }`
- [ ] Update `registerFileWatcher()` destructuring: `const { data: frontmatter, content }` → `{ data: frontmatter, body }`
- [ ] Update calls to `serializer.serialize()` and `serializer.deserialize()` to use `body` parameter

### Phase 3: Parser (parser.ts)
- [ ] Rename return type from `{ data, content }` to `{ data, body }`
- [ ] Rename internal variable `markdownContent` to `bodyContent` for consistency
- [ ] Update JSDoc to reference "body"

### Phase 4: Operations (operations.ts)
- [ ] Rename parameter `content: string` to `body: string` in `writeMarkdownFile()`
- [ ] Update JSDoc and parameter documentation
- [ ] Update function body references from `content` to `body`

### Phase 5: Documentation (README.md)
- [ ] Update all examples showing `content:` to `body:`
- [ ] Update conceptual explanations to use "body" terminology
- [ ] Update migration guides and best practices

### Phase 6: Verification
- [ ] Search for any remaining "content" references in markdown index files
- [ ] Verify all imports and exports still work
- [ ] Run tests to ensure no regressions

## Rollout Strategy

**Maximum simplicity principle**: Each phase is independent and can be completed in isolation. We'll do:
1. Type definitions first (defines the API)
2. Implementation changes (uses the new API)
3. Parser and operations (all consuming the new types)
4. Documentation (reflects the new terminology)

This ensures each change is minimal and focused.

## Review Criteria

- [ ] All "content" references in markdown index renamed to "body" where semantically appropriate
- [ ] JSDoc comments clearly distinguish "body" as markdown content after frontmatter
- [ ] README examples consistently use "body" terminology
- [ ] No breaking changes to code outside the markdown index
- [ ] Clear commit messages explaining the rename rationale

## Estimated Impact

- **Lines changed**: ~50-75 across 4 files
- **Breaking changes**: Yes (for users with custom `MarkdownSerializer` implementations)
- **Migration effort**: Minimal (find/replace in user code)
- **Clarity gain**: High (eliminates overloaded terminology)

---

## TODO Checklist

- [x] Get approval on this plan
- [x] Phase 1: Update type definitions
- [x] Phase 2: Update index.ts implementation
- [x] Phase 3: Update parser.ts
- [x] Phase 4: Update operations.ts
- [x] Phase 5: Update README.md
- [x] Phase 6: Final verification
- [x] Add review section with summary

---

## Implementation Review

### Summary of Changes

All phases were completed successfully. The rename from "content" to "body" has been applied consistently across the markdown index implementation.

### Files Modified

1. **index.ts** (6 changes)
   - Updated `MarkdownSerializer` type definition: `content: string` → `body: string` in both serialize and deserialize
   - Updated JSDoc comments to reference "body" terminology
   - Updated `createDefaultSerializer` to return `body: ''` instead of `content: ''`
   - Updated `writeRowToMarkdown` destructuring: `{ frontmatter, content }` → `{ frontmatter, body }`
   - Updated `registerFileWatcher` destructuring: `{ data: frontmatter, content }` → `{ data: frontmatter, body }`
   - Updated `serializer.deserialize()` call to pass `body` parameter

2. **parser.ts** (5 changes)
   - Updated `parseMarkdownFile` return type: `{ data, content }` → `{ data, body }`
   - Updated JSDoc: "content" → "body" in parameter and return descriptions
   - Updated implementation: `markdownContent` variable → `bodyContent`
   - Updated return statements to use `body` property
   - Updated `parseMarkdownWithValidation` destructuring and usage

3. **operations.ts** (2 changes)
   - Updated `writeMarkdownFile` parameter: `content: string` → `body: string`
   - Updated function implementation to use `body` variable
   - Updated comment to reference "markdown file with frontmatter and body"

4. **README.md** (7 changes)
   - Updated conceptual description: "content field" → "body field"
   - Updated Example 1: serialize/deserialize parameters changed from `content` to `body`
   - Updated Example 2: serialize/deserialize parameters changed from `content` to `body`
   - Updated Full Configuration example: parameters changed from `content` to `body`
   - Updated all code examples to use the new `body` parameter name

### Terminology Decision

After discussion, standardized on:
- **Key name**: `body` (consistently used across all APIs)
- **Documentation term**: "markdown body" (parallels "front matter" as a structural concept)
- **Parameter descriptions**: "Markdown body content" for clarity when needed

This avoids redundancy ("body content") while maintaining clarity and consistency with markdown file structure semantics.

### Breaking Changes

This is a **breaking change** for users with custom `MarkdownSerializer` implementations:

**Old code:**
```typescript
serialize: ({ row }) => ({
  frontmatter: { /* ... */ },
  content: row.body
}),
deserialize: ({ id, frontmatter, content }) => ({ /* ... */ })
```

**New code:**
```typescript
serialize: ({ row }) => ({
  frontmatter: { /* ... */ },
  body: row.body
}),
deserialize: ({ id, frontmatter, body }) => ({ /* ... */ })
```

Migration is straightforward: rename `content` to `body` in serializer definitions.

### Verification

- All "content" references in markdown index files are either:
  - Legitimate uses referring to entire file content (e.g., `const content = await file.text()`)
  - Legitimate uses referring to database field names (e.g., `row.content`)
  - Legitimate uses in directory paths (e.g., `rootPath: './content'`)
- No syntax errors detected
- All type definitions are consistent across files
- README examples are up-to-date and consistent

### Notes

The refactoring was systematic and low-risk because:
1. The rename was highly localized to the markdown index module
2. All changes were mechanical (straightforward parameter/variable renaming)
3. No other modules depend on the internal implementation details
4. Type system ensures all usages are updated consistently
