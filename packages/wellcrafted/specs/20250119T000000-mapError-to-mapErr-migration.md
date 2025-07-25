# Migration Plan: mapError to mapErr

## Overview
This plan outlines the migration from `mapError` back to `mapErr` in the wellcrafted library. This is essentially reversing the changes made in commit `0416841` (June 2, 2025) where `mapErr` was renamed to `mapError`.

## Key Changes Required

### 1. Core Type Changes
The main change is in the `trySync` and `tryAsync` function signatures where:
- Current: `mapError: (error: unknown) => E`
- Target: `mapErr: (error: unknown) => Err<E>`

This means `mapErr` will return an `Err<E>` wrapper instead of just the error value `E`.

### 2. Implementation Changes
In `src/result/result.ts`:
- Update parameter name from `mapError` to `mapErr`
- Change return type from `E` to `Err<E>`
- Update the error handling to expect `Err<E>` return value:
  - Current: `return Err(mapError(error))`
  - Target: `return mapErr(error)`

### 3. Documentation Updates
All documentation files need to be updated to reflect:
- Parameter name change from `mapError` to `mapErr`
- Updated examples showing `mapErr` returning `Err` objects
- Updated type signatures in documentation

## Todo List

### [ ] 1. Update Core Implementation
- [ ] Update `trySync` function in `src/result/result.ts`:
  - [ ] Change parameter name from `mapError` to `mapErr`
  - [ ] Change type from `(error: unknown) => E` to `(error: unknown) => Err<E>`
  - [ ] Update implementation from `return Err(mapError(error))` to `return mapErr(error)`
- [ ] Update `tryAsync` function in `src/result/result.ts`:
  - [ ] Change parameter name from `mapError` to `mapErr`
  - [ ] Change type from `(error: unknown) => E` to `(error: unknown) => Err<E>`
  - [ ] Update implementation from `return Err(mapError(error))` to `return mapErr(error)`
- [ ] Update JSDoc comments for both functions

### [ ] 2. Update Documentation Examples
- [ ] Update `README.md` - all examples using `mapError`
- [ ] Update `docs/getting-started/quick-start.mdx`
- [ ] Update `docs/getting-started/core-concepts.mdx`
- [ ] Update `docs/getting-started/installation.mdx`
- [ ] Update `docs/migration/from-try-catch.mdx`
- [ ] Update `docs/patterns/service-layer.mdx`
- [ ] Update `docs/core/error-system.mdx`
- [ ] Update `docs/core/implementation.mdx`
- [ ] Update `docs/index.mdx`
- [ ] Update `ERROR_HANDLING_GUIDE.md`
- [ ] Update `NAMING_CONVENTION.md`
- [ ] Update `src/README.md`
- [ ] Update `src/error/utils.ts` - comment example

### [ ] 3. Update Example Patterns
All examples need to change from:
```typescript
trySync({
  try: () => JSON.parse(text),
  mapError: (error) => ({
    name: "JsonError",
    message: "Failed to parse",
    context: { text },
    cause: error
  })
})
```

To:
```typescript
trySync({
  try: () => JSON.parse(text),
  mapErr: (error) => Err({
    name: "JsonError",
    message: "Failed to parse",
    context: { text },
    cause: error
  })
})
```

### [ ] 4. Update Other Documentation
- [ ] Update spec files in `specs/` directory
- [ ] Update `README_MD.md` and `README_OG.md`

### [ ] 5. Update Changelog
- [ ] Add new changelog entry explaining the breaking change

### [ ] 6. Consider Migration Guide
- [ ] Create a migration guide for users upgrading from `mapError` to `mapErr`

## Impact Analysis

### Breaking Changes
This is a **breaking change** that will affect all users of `trySync` and `tryAsync`:
1. Parameter name change requires updating all call sites
2. Return type change requires wrapping error values in `Err()`
3. Generic type constraints may need adjustment

### Migration Path for Users
Users will need to:
1. Update all `mapError` to `mapErr`
2. Wrap their error returns in `Err()`:
   ```typescript
   // Before
   mapError: (error) => ({ name: "Error", ... })
   
   // After
   mapErr: (error) => Err({ name: "Error", ... })
   ```

## Review Notes
- This reverses the decision made in commit `0416841` to standardize on `mapError`
- The new approach requires explicit `Err()` wrapping, which may be more verbose but clearer about intent
- Consider if this change aligns with the overall API design philosophy

## Migration Complete ✅

### Summary of Changes Made
Successfully migrated the wellcrafted library from `mapError` to `mapErr` with the following updates:

#### ✅ Core Implementation Changes
- Updated `trySync` function in `src/result/result.ts`:
  - Changed parameter from `mapError` to `mapErr`
  - Updated type signature from `(error: unknown) => E` to `(error: unknown) => Err<E>`
  - Changed implementation from `return Err(mapError(error))` to `return mapErr(error)`
- Updated `tryAsync` function with the same changes
- Updated all JSDoc comments and examples to reflect the new parameter name and return type

#### ✅ Documentation Updates
- **README.md**: Updated all examples to use `mapErr` with `Err()` wrapping
- **docs/getting-started/quick-start.mdx**: Updated trySync and tryAsync examples
- **docs/core/error-system.mdx**: Updated all retry logic and database examples
- **docs/migration/from-try-catch.mdx**: Updated all migration examples
- **ERROR_HANDLING_GUIDE.md**: Updated createTryFns pattern and examples
- **src/README.md**: Updated API documentation and examples
- **src/error/utils.ts**: Updated JSDoc example

#### ✅ Supporting Files
- **specs/launch/** files: Updated blog post, platform posts, and effect comparison examples
- **CHANGELOG.md**: Added v0.20.0 entry with breaking change notice and migration guide

### Breaking Change Impact
This is a **major breaking change** (version 0.20.0) that affects all users of `trySync` and `tryAsync`. The migration requires:

1. Renaming `mapError` to `mapErr` in all call sites
2. Wrapping error returns in `Err()`:
   ```typescript
   // Before
   mapError: (error) => ({ name: "MyError", ... })
   
   // After  
   mapErr: (error) => Err({ name: "MyError", ... })
   ```

### Files Changed
- `src/result/result.ts` (core implementation)
- `README.md` and `src/README.md` (documentation)
- All documentation files in `docs/` directory
- `ERROR_HANDLING_GUIDE.md`
- Spec files in `specs/launch/`
- `CHANGELOG.md` (breaking change notice)
- Migration plan document

The migration successfully reverses commit `0416841` and provides users with more explicit control over error wrapping through the `mapErr` function that returns `Err<E>` directly.