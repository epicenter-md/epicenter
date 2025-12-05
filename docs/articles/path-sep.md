# Use `path.sep` for Platform-Agnostic Path Splitting

When you have a file path string that you need to split, you might be tempted to split it using a hardcoded delimiter:

```typescript
// ❌ Don't do this
const parts = relativePath.split('/');  // Breaks on Windows
const parts = relativePath.split('\\'); // Breaks on Unix
```

Instead, use `path.sep`:

```typescript
// ✅ Do this
import path from 'node:path';

const parts = relativePath.split(path.sep);
```

`path.sep` automatically provides the correct path separator for the operating system:
- Windows: `\` (backslash)
- macOS/Linux: `/` (forward slash)

This ensures your code works correctly regardless of where it runs.



## Real Example

From `src/indexes/markdown/index.ts`:

```typescript
// Parse relative path from file watcher
// Expected format: [tableName]/[id].md
const parts = relativePath.split(path.sep);
if (parts.length !== 2) return;
const [tableName, filenameWithExt] = parts;
```

This code handles paths like `pages/my-page.md` on Unix and `pages\my-page.md` on Windows without any special logic.

---

Other method:

## Understanding `path.sep` for Platform-Agnostic Paths

When working with file paths in programming, you might encounter situations where you need to split a string representing a path. A common temptation is to split it using a standard delimiter like a backslash (`\`) or a forward slash (`/`). However, for robust and platform-agnostic code, you should use `path.sep`.

`path.sep` is a property that provides the platform-specific path segment separator. This means it will automatically use the correct separator for the operating system your code is running on.

For example, on Windows, `path.sep` will be a backslash (`\`), while on macOS and Linux, it will be a forward slash (`/`). By using `path.sep`, you ensure that your code works correctly regardless of the user's operating system, preventing potential errors and making your applications more portable.