# Bun.Glob for Monorepo Workspace Discovery

When you need to discover workspace packages in a monorepo, don't hardcode the paths. Derive them from `package.json` and use `Bun.Glob` to expand the patterns.

## The Problem

Monorepo scripts often need to iterate over all workspace packages. The naive approach hardcodes the workspace directories:

```typescript
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const packageRoots = (
    await Promise.all(
        ['apps', 'packages', 'examples'].map(async (parent) => {
            try {
                const entries = await readdir(parent, { withFileTypes: true });
                return entries
                    .filter((e) => e.isDirectory())
                    .map((e) => join(parent, e.name));
            } catch {
                return [];
            }
        }),
    )
).flat();
```

This has problems:
- **Duplication**: The `['apps', 'packages', 'examples']` array duplicates what's already in `package.json`
- **Drift**: If you add `tools/*` to workspaces, you have to remember to update this script too
- **Verbose**: 14 lines for something conceptually simple

## The Solution

Your `package.json` already defines workspaces:

```json
{
  "workspaces": {
    "packages": ["apps/*", "packages/*", "examples/*"]
  }
}
```

Bun can statically import JSON, so TypeScript knows the exact shape. Combine this with `Bun.Glob`:

```typescript
import pkg from '../package.json';

const packageRoots = pkg.workspaces.packages.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ onlyFiles: false }),
]);
```

That's it. Three lines.

## Why This Works

**Static JSON imports**: When you `import pkg from './package.json'`, Bun (and TypeScript) statically analyze the JSON structure. You get full type inference:

```typescript
pkg.workspaces.packages  // TypeScript knows this is string[]
```

No runtime checks needed for whether `workspaces` is an array or object.

**Bun.Glob.scanSync**: The `scanSync` method expands glob patterns against the filesystem:

```typescript
new Bun.Glob('apps/*').scanSync({ onlyFiles: false })
// Returns: ['apps/epicenter', 'apps/web', ...]
```

The `onlyFiles: false` option is required because `scanSync` defaults to returning only files. We want directories (the package roots).

## Bun.Glob Options

```typescript
interface GlobScanOptions {
    cwd?: string;           // Root directory (default: process.cwd())
    dot?: boolean;          // Match dotfiles (default: false)
    absolute?: boolean;     // Return absolute paths (default: false)
    followSymlinks?: boolean;
    onlyFiles?: boolean;    // Only files, not directories (default: true)
}
```

## Real Example: Clean Script

Here's a monorepo clean script using this pattern:

```typescript
#!/usr/bin/env bun
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import pkg from '../package.json';

const subDirs = ['.svelte-kit', 'dist', 'node_modules'] as const;

const packageRoots = pkg.workspaces.packages.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ onlyFiles: false }),
]);

const dirsToRemove = packageRoots.flatMap((root) =>
    subDirs.map((subDir) => join(root, subDir)),
);

await Promise.all(
    dirsToRemove.map((path) => rm(path, { recursive: true, force: true })),
);
```

## The Lesson

Use `package.json` as the single source of truth for workspace locations. When Bun can statically analyze your imports, take advantage of it. The result is less code, no duplication, and automatic consistency when your workspace configuration changes.
