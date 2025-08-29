# Documentation Update Plan: mapErr to catch Migration

**Timestamp**: 2025-01-29T16:00:00  
**Feature**: Update all documentation to use `catch` instead of `mapErr` and explain recovery vs propagation patterns

## Overview

Update all documentation across the wellcrafted repository to:
1. Replace all `mapErr` references with `catch`
2. Add explanations of recovery vs propagation patterns
3. Show smart return type narrowing examples
4. Update all code examples consistently

## Files Requiring Updates

### High Priority Documentation Files

**Main Documentation:**
- [ ] `/README.md` - Multiple mapErr examples
- [ ] `/ERROR_HANDLING_GUIDE.md` - Extensive mapErr usage
- [ ] `/NAMING_CONVENTION.md` - References to mapError/mapErr conventions
- [ ] `/src/README.md` - Function signatures and examples

**Core Documentation (docs/):**
- [ ] `/docs/getting-started/quick-start.mdx` - Core examples users see first
- [ ] `/docs/getting-started/core-concepts.mdx` - Fundamental concepts
- [ ] `/docs/getting-started/installation.mdx` - First examples
- [ ] `/docs/core/error-system.mdx` - Error handling explanations
- [ ] `/docs/core/implementation.mdx` - Technical implementation details

**Pattern Documentation:**
- [ ] `/docs/patterns/service-layer.mdx` - Service layer patterns
- [ ] `/docs/patterns/real-world.mdx` - Real world examples  
- [ ] `/docs/migration/from-try-catch.mdx` - Migration guides
- [ ] `/docs/philosophy/design-principles.mdx` - Design philosophy

**Integration Guides:**
- [ ] `/docs/integrations/svelte-tanstack.mdx` - Svelte examples
- [ ] `/docs/integrations/react-tanstack.mdx` - React examples
- [ ] `/docs/integrations/nodejs-express.mdx` - Node.js examples

**Case Studies:**
- [ ] `/docs/case-studies/whispering-architecture.mdx` - Real application examples

### Medium Priority Files

**Legacy Documentation:**
- [ ] `/README_MD.md` - Backup README with old examples
- [ ] `/README_OG.md` - Original README
- [ ] `/CHANGELOG.md` - Historical references (keep for history)

**Spec Files:**
- [ ] `/specs/launch/effect-comparison.md` - Comparison examples
- [ ] `/specs/launch/platform-posts.md` - Social media content
- [ ] `/specs/launch/20250630T120000-blog-post.md` - Blog post examples

**Utility Documentation:**
- [ ] `/src/error/utils.ts` - JSDoc comments with examples

### Low Priority Files

**Archive/Historical (Update but not critical):**
- [ ] `/docs/index.mdx` - Documentation index
- [ ] Various spec files in `/specs/`

## Update Strategy

### 1. Parameter Replacement
```typescript
// Before
mapErr: (error) => Err(ServiceError({...}))

// After  
catch: (error) => Err(ServiceError({...}))
```

### 2. Add Recovery Pattern Examples
```typescript
// Show both patterns in documentation
// Recovery Pattern (returns Ok<T>)
const alwaysSucceeds = trySync({
  try: () => riskyOperation(),
  catch: () => Ok("fallback value") // Always recovers
});
// alwaysSucceeds: Ok<string> - no error checking needed!

// Propagation Pattern (returns Result<T, E>)  
const mayFail = trySync({
  try: () => riskyOperation(),
  catch: (error) => Err(ServiceError({...})) // May propagate errors
});  
// mayFail: Result<string, ServiceError> - must check for errors
```

### 3. Update Function Signatures
```typescript
// Before
trySync<T, E>({ try, mapErr }): Result<T, E>
tryAsync<T, E>({ try, mapErr }): Promise<Result<T, E>>

// After (show overloads)
trySync<T>({ try, catch: () => Ok<T> }): Ok<T>
trySync<T, E>({ try, catch: () => Err<E> }): Result<T, E>
```

### 4. Explain the "Why" of the Change

Add sections explaining:
- **Semantic Clarity**: `catch` better represents error handling than `mapErr`
- **Recovery Patterns**: How `catch` can return `Ok(value)` for fallbacks
- **Type Safety**: Smart return type narrowing eliminates unnecessary checks
- **Developer Experience**: Better hover tooltips and autocomplete

## Implementation Plan

### Phase 1: Core Documentation (30 min)
1. Start with `/README.md` - most visible
2. Update `/docs/getting-started/quick-start.mdx` - first user experience  
3. Update `/ERROR_HANDLING_GUIDE.md` - comprehensive guide

### Phase 2: Pattern Documentation (20 min)
1. Update service layer patterns
2. Update migration guides
3. Update real-world examples

### Phase 3: Integration Documentation (15 min)  
1. Update Svelte/React integration examples
2. Update Node.js examples
3. Update case studies

### Phase 4: Cleanup & Verification (10 min)
1. Update utility files and legacy docs
2. Run search to verify all mapErr references updated
3. Test that all examples compile and make sense

## Key Messaging for Documentation

### Smart Return Type Narrowing
"The return type is automatically narrowed based on what your catch function returns:
- If catch always returns `Ok<T>`, the function returns `Ok<T>` (guaranteed success)  
- If catch can return `Err<E>`, the function returns `Result<T, E>` (may succeed or fail)"

### Recovery vs Propagation
"Use `catch` for two patterns:
- **Recovery**: Return `Ok(fallbackValue)` to always succeed with a fallback
- **Propagation**: Return `Err(specificError)` to let failures bubble up"

### Migration Guide
"Update all `mapErr` to `catch` - the functionality is identical, only the name changed for better semantic clarity."

## Success Criteria

- [ ] All documentation uses `catch` instead of `mapErr`
- [ ] Examples show both recovery and propagation patterns
- [ ] Smart return type narrowing is explained clearly
- [ ] No broken links or compilation errors
- [ ] Consistent terminology throughout all docs

## Timeline

**Total Estimated Time**: 75 minutes
- Phase 1 (Core): 30 min
- Phase 2 (Patterns): 20 min  
- Phase 3 (Integrations): 15 min
- Phase 4 (Cleanup): 10 min