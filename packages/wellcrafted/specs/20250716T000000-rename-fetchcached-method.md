# Rename fetchCached Method Analysis and Plan

## Current Situation

The `fetchCached` method in the query system is misleadingly named. Looking at the implementation in `src/query/utils.ts:250`, it:

1. **Calls `queryClient.fetchQuery()`** - This is TanStack Query's method that:
   - Returns cached data if it's fresh (within staleTime)
   - Fetches from the network if data is stale or missing
   - Handles deduplication of concurrent requests

2. **Wraps the result in a Result type** - Converts TanStack Query's throw-on-error pattern to our Result pattern

## The Problem

The name `fetchCached` is confusing because:
- It suggests it only returns cached data
- In reality, it may fetch fresh data from the network
- The behavior is actually "fetch with caching intelligence"

## Naming Options Analysis

### Option 1: `fetch` (User's suggestion)
**Pros:**
- Simple and clear
- Matches the actual behavior (may fetch from network)
- Consistent with web standards (fetch API)
- Short and easy to type

**Cons:**
- Doesn't indicate caching behavior
- Might suggest it always hits the network

### Option 2: `get`
**Pros:**
- Semantic clarity - "get me this data"
- Doesn't imply network vs cache
- Common in data access patterns
- Short and intuitive

**Cons:**
- Very generic
- Doesn't indicate async nature

### Option 3: `load`
**Pros:**
- Implies data loading from any source
- Suggests async operation
- Common in UI frameworks

**Cons:**
- Slightly less clear than `get`
- Could imply always loading

### Option 4: `ensure`
**Pros:**
- Clearly indicates "ensure I have this data"
- Implies smart caching behavior
- Semantic match for the actual behavior

**Cons:**
- Less common in data fetching APIs
- Might be unclear to new developers

## Recommendation: `fetch`

After analyzing the options, I recommend **`fetch`** for these reasons:

1. **Semantic Accuracy**: The method may actually fetch from the network, so "fetch" is more accurate than "fetchCached"
2. **Simplicity**: It's the simplest, most direct name
3. **Familiarity**: Developers understand `fetch` means "get me this data"
4. **Implementation Detail**: The caching is an implementation detail that users don't need to think about

The caching behavior is handled transparently by TanStack Query - users just want their data, regardless of whether it comes from cache or network.

## Implementation Plan

### Todo Items:
- [ ] Update method name in `DefineQueryOutput` type (line 63)
- [ ] Update method implementation in `defineQuery` function (line 250)
- [ ] Update all JSDoc comments referencing `fetchCached`
- [ ] Update README.md documentation
- [ ] Update all spec files that reference `fetchCached`
- [ ] Search for any other references in the codebase
- [ ] Verify no breaking changes in external usage

### Files to Update:
1. `src/query/utils.ts` - Main implementation
2. `src/query/README.md` - Documentation
3. `specs/20250110T184500-simplify-query-docs.md`
4. `specs/20250109T183400-query-factory-refactor.md`

## Review Section

### Changes Made

1. **Updated Type Definition**: Changed `fetchCached` to `fetch` in `DefineQueryOutput` type (line 63)
2. **Updated Method Implementation**: Renamed the actual method from `fetchCached()` to `fetch()` (line 250)
3. **Updated JSDoc Comments**: Fixed all references to `fetchCached` in documentation comments throughout `src/query/utils.ts`
4. **Updated README Documentation**: Changed all examples in `src/query/README.md` to use `.fetch()` instead of `.fetchCached()`
5. **Updated Spec Files**: Fixed references in existing spec files to maintain consistency

### Files Modified
- `src/query/utils.ts` - Main implementation and types
- `src/query/README.md` - Documentation examples
- `specs/20250110T184500-simplify-query-docs.md` - Reference update
- `specs/20250109T183400-query-factory-refactor.md` - Reference updates

### Verification
- ✅ TypeScript compilation successful (`npm run build` passed)
- ✅ No remaining `fetchCached` references found in codebase
- ✅ All method signatures and types updated consistently

### Summary
Successfully renamed `fetchCached` to `fetch` across the entire codebase. The new name better reflects the actual behavior: intelligently fetching data from cache or network as needed. The change maintains full backward compatibility in terms of functionality while providing a clearer, more intuitive API.