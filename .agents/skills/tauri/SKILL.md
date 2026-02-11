---
name: tauri
description: Tauri path handling, cross-platform file operations, and API usage. Use when working with file paths in Tauri frontend code, accessing filesystem APIs, or handling platform differences in desktop apps.
---

# Tauri Path Handling

## Context Detection

Before choosing a path API, determine your execution context:

| Context                 | Location                                       | Correct API            |
| ----------------------- | ---------------------------------------------- | ---------------------- |
| **Tauri frontend**      | `apps/*/src/**/*.ts`, `apps/*/src/**/*.svelte` | `@tauri-apps/api/path` |
| **Node.js/Bun backend** | `packages/**/*.ts`, CLI tools                  | Node.js `path` module  |

**Rule**: If the code runs in the browser (Tauri webview), use Tauri's path APIs. If it runs in Node.js/Bun, use the Node.js `path` module.

## Available Functions from `@tauri-apps/api/path`

### Path Manipulation

| Function               | Purpose                                    | Example                                           |
| ---------------------- | ------------------------------------------ | ------------------------------------------------- |
| `join(...paths)`       | Join path segments with platform separator | `await join(baseDir, 'workspaces', id)`           |
| `dirname(path)`        | Get parent directory                       | `await dirname('/foo/bar/file.txt')` → `/foo/bar` |
| `basename(path, ext?)` | Get filename, optionally strip extension   | `await basename('/foo/bar.txt', '.txt')` → `bar`  |
| `extname(path)`        | Get file extension                         | `await extname('file.txt')` → `.txt`              |
| `normalize(path)`      | Resolve `..` and `.` segments              | `await normalize('/foo/bar/../baz')` → `/foo/baz` |
| `resolve(...paths)`    | Resolve to absolute path                   | `await resolve('relative', 'path')`               |
| `isAbsolute(path)`     | Check if path is absolute                  | `await isAbsolute('/foo')` → `true`               |

### Platform Constants

| Function      | Purpose                 | Returns                      |
| ------------- | ----------------------- | ---------------------------- |
| `sep()`       | Platform path separator | `\` on Windows, `/` on POSIX |
| `delimiter()` | Platform path delimiter | `;` on Windows, `:` on POSIX |

### Base Directories

| Function                | Purpose                            |
| ----------------------- | ---------------------------------- |
| `appLocalDataDir()`     | App's local data directory         |
| `appDataDir()`          | App's roaming data directory       |
| `appConfigDir()`        | App's config directory             |
| `appCacheDir()`         | App's cache directory              |
| `appLogDir()`           | App's log directory                |
| `tempDir()`             | System temp directory              |
| `resourceDir()`         | App's resource directory           |
| `resolveResource(path)` | Resolve path relative to resources |

## Patterns

### Constructing Paths (Correct)

```typescript
import { appLocalDataDir, dirname, join } from '@tauri-apps/api/path';

// Join path segments - handles platform separators automatically
const baseDir = await appLocalDataDir();
const filePath = await join(baseDir, 'workspaces', workspaceId, 'data.json');

// Get parent directory - cleaner than manual slicing
const parentDir = await dirname(filePath);
await mkdir(parentDir, { recursive: true });
```

### Logging Paths (Exception)

For human-readable log output, hardcoded `/` is acceptable since it's not used for filesystem operations:

```typescript
// OK for logging - consistent cross-platform log output
const logPath = pathSegments.join('/');
console.log(`[Persistence] Loading from ${logPath}`);
```

## Anti-Patterns

### Never: Manual String Concatenation

```typescript
// BAD: Hardcoded separator breaks on Windows
const filePath = baseDir + '/' + 'workspaces' + '/' + id;

// BAD: Template literal with hardcoded separator
const filePath = `${baseDir}/workspaces/${id}`;

// GOOD: Use join()
const filePath = await join(baseDir, 'workspaces', id);
```

### Never: Manual Parent Directory Extraction

```typescript
// BAD: Manual slicing is error-prone
const parentSegments = pathSegments.slice(0, -1);
const parentDir = await join(baseDir, ...parentSegments);

// GOOD: Use dirname()
const parentDir = await dirname(filePath);
```

### Never: Hardcoded Separators in Filesystem Operations

```typescript
// BAD: Windows uses backslashes
const configPath = appDir + '/config.json';

// GOOD: Platform-agnostic
const configPath = await join(appDir, 'config.json');
```

### Never: Assuming Path Format

```typescript
// BAD: Splitting on '/' fails on Windows paths
const parts = filePath.split('/');

// GOOD: Use dirname/basename for extraction
const dir = await dirname(filePath);
const file = await basename(filePath);
```

## Import Pattern

Always import from `@tauri-apps/api/path`:

```typescript
import {
	appLocalDataDir,
	dirname,
	join,
	basename,
	extname,
	normalize,
	resolve,
	sep,
} from '@tauri-apps/api/path';
```

## Note on Async

All Tauri path functions are **async** because they communicate with the Rust backend via IPC. Always `await` them:

```typescript
// All path operations return Promises
const baseDir = await appLocalDataDir();
const filePath = await join(baseDir, 'file.txt');
const parent = await dirname(filePath);
const separator = await sep();
```

## Filesystem Operations

Use `@tauri-apps/plugin-fs` for file operations, combined with Tauri path APIs:

```typescript
import { appLocalDataDir, dirname, join } from '@tauri-apps/api/path';
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';

async function saveData(segments: string[], data: Uint8Array) {
	const baseDir = await appLocalDataDir();
	const filePath = await join(baseDir, ...segments);

	// Ensure parent directory exists
	const parentDir = await dirname(filePath);
	await mkdir(parentDir, { recursive: true });

	await writeFile(filePath, data);
}
```
