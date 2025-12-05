# Fix Markdown Index Path Resolution

## Problem

The markdown index currently has an incorrect assertion at line 338:

```typescript
const absoluteRootPath = rootPath as AbsolutePath;
```

This assumes `rootPath` is already an absolute path, but according to the three-layer path resolution pattern documented in the codebase, `rootPath` can be:

1. **Relative to epicenter.config.ts** (default, recommended)
2. **Absolute path** (explicit)
3. **Explicit control via import.meta.dirname** (which produces absolute paths)

The current implementation skips the crucial resolution step that converts relative paths to absolute paths based on the current working directory (which should be where epicenter.config.ts is located).

## Three-Layer Path Resolution Pattern

From `docs/specs/20251103T175503 config-relative-path-resolution.md`:

```typescript
/**
 * Root path where markdown files should be stored.
 *
 * **Relative paths** (recommended): Resolved relative to epicenter.config.ts location
 * rootPath: './content'  // → <config-dir>/content
 * rootPath: '../vault'   // → <config-dir>/../vault
 *
 * **Absolute paths**: Used as-is
 * rootPath: '/absolute/path/to/vault'
 *
 * **Explicit control**: Use import.meta.dirname if needed
 * rootPath: path.join(import.meta.dirname, './vault')
 */
```

## Current Behavior

Looking at other implementations:

**SQLite Index** (`src/indexes/sqlite/index.ts:58`):
```typescript
const resolvedDatabasePath = path.join('.epicenter', `${id}.db`);
```
Simple case: always uses a relative path, which works because it's always in the same structure.

**Persistence Provider** (`src/core/workspace/providers/persistence/desktop.ts:57-58`):
```typescript
const storagePath = '.epicenter';
const filePath = path.join(storagePath, `${id}.yjs`);
```
Same approach: simple relative path.

**Path Resolver** (`src/cli/lsp/utils/path-resolver.ts:40-43`):
```typescript
const rootPath = markdownIndex.rootPath || `./${workspace.id}`;
const absoluteRootPath = path.isAbsolute(rootPath)
    ? rootPath
    : path.resolve(process.cwd(), rootPath);
```
**This is the correct pattern!** It checks if the path is already absolute, and if not, resolves it relative to `process.cwd()` (which is where epicenter.config.ts is located).

## Solution

Update the markdown index to follow the same three-layer resolution pattern:

```typescript
// Before (incorrect)
const absoluteRootPath = rootPath as AbsolutePath;

// After (correct)
const absoluteRootPath = (
  path.isAbsolute(rootPath)
    ? rootPath
    : path.resolve(process.cwd(), rootPath)
) as AbsolutePath;
```

This matches exactly what the path resolver does and ensures that:
1. Relative paths (like `./content` or `../vault`) are resolved relative to where epicenter.config.ts is located (process.cwd())
2. Absolute paths (like `/absolute/path/to/vault`) are used as-is
3. Explicit paths using `import.meta.dirname` are already absolute and pass through unchanged

## Implementation Plan

- [x] Update `markdownIndex` function in `packages/epicenter/src/indexes/markdown/index.ts:338` to properly resolve the path
- [x] Update JSDoc to explain the three path options (not "three-layer pattern")
- [x] Fix path resolution in `sqliteIndex` to use absolute paths consistently
- [x] Fix path resolution in `setupPersistence` to use absolute paths consistently

## Review

### Changes Made

All path resolution has been updated to be consistent across the codebase. The key insight was that while the markdown index was documented to support three ways of specifying paths, it wasn't actually implementing the resolution correctly. Additionally, SQLite and persistence were using relative paths without explicit resolution.

**1. Markdown Index** (`packages/epicenter/src/indexes/markdown/index.ts`):
- **Line 340-342**: Added proper path resolution that checks if path is absolute, otherwise resolves relative to `process.cwd()`
- **Line 335-339**: Updated comment to explain the three path options clearly
- **Line 66-97**: Updated JSDoc to use "Three ways to specify the path" instead of "three-layer pattern"

**2. SQLite Index** (`packages/epicenter/src/indexes/sqlite/index.ts`):
- **Line 59-60**: Changed from `path.join('.epicenter', ...)` directly to `path.resolve(process.cwd(), ...)`
- **Line 63-64**: Also resolved the storage directory to absolute path before creating it
- Now explicitly resolves relative paths to absolute paths for consistency

**3. Persistence Provider** (`packages/epicenter/src/core/workspace/providers/persistence/desktop.ts`):
- **Line 58**: Changed from `const storagePath = '.epicenter'` to `const storageDir = path.resolve(process.cwd(), EPICENTER_STORAGE_DIR)`
- **Line 59**: Updated filePath to use the resolved `storageDir`
- **Line 62-63**: Updated directory existence check to use resolved path

### Three Ways to Specify Paths

All three implementations now consistently support:

1. **Relative paths** (recommended): `./content`, `../vault` → resolved relative to epicenter.config.ts location
2. **Absolute paths**: `/absolute/path/to/vault` → used as-is
3. **Explicit control**: `path.join(import.meta.dirname, './vault')` → produces absolute paths

### Why This Matters

- **Consistency**: All path operations now work the same way across indexes and providers
- **Predictability**: Users can rely on relative paths being resolved relative to their config file location
- **Clarity**: The "three options" terminology is more accurate than "three-layer pattern"
- **Absolute paths everywhere**: All filesystem operations now receive absolute paths, eliminating ambiguity about what `process.cwd()` is at operation time
