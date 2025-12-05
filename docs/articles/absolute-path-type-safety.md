# Absolute Path Type Safety: A Branded Type Pattern

I needed a way to accept flexible paths from users while guaranteeing absolute paths internally. The problem: users want convenience (they shouldn't have to calculate absolute paths), but internal code needs reliability (relative paths are unpredictable). I also wanted compile-time guarantees, not just runtime checks.

## The Branded Type Approach

TypeScript's type system sees all strings as the same. A relative path and an absolute path are both just `string`. That's where branded types come in.

```typescript
import type { Brand } from 'wellcrafted/brand';

export type AbsolutePath = string & Brand<'AbsolutePath'>;
```

This is still a string at runtime, but TypeScript treats it as a distinct type. You can't accidentally pass a regular string where an `AbsolutePath` is expected. The brand acts like a compile-time seal of approval: "This string has been verified as absolute."

Why bother with this complexity? Because the type system catches errors before they happen:

```typescript
function saveFile(path: AbsolutePath) {
	/* ... */
}

saveFile('/absolute/path'); // Type error - not branded
saveFile('./relative'); // Type error - not branded
saveFile(absolutePath); // OK - has AbsolutePath brand
```

## The Resolution Boundary Pattern

Here's the key insight: there's a natural boundary where user input becomes internal state. In Epicenter, that boundary is the client initialization. The config accepts plain strings, then we resolve to absolute and brand it:

```typescript
// User passes plain string
const epicenter = await createEpicenterClient({
	storageDir: './my-content', // Relative or absolute both work
	workspaces: [blogWorkspace],
});

// Inside createEpicenterClient - the resolution boundary
let storageDir: AbsolutePath | undefined = undefined;
const isNode =
	typeof process !== 'undefined' &&
	process.versions != null &&
	process.versions.node != null;
if (isNode) {
	const configuredPath = config.storageDir ?? process.cwd();
	storageDir = path.resolve(configuredPath) as AbsolutePath;
}
```

The cast to `AbsolutePath` is the only place we sidestep the type system. It's safe because `path.resolve()` guarantees an absolute path. User input (string) comes in, absolute paths (AbsolutePath) flow out.

## Cascading Guarantees

Once we have that branded `AbsolutePath` at the top level, it cascades down through the entire system:

```
User Config (string)
    ↓
Resolution (path.resolve)
    ↓
AbsolutePath (branded)
    ↓
ProviderContext { storageDir: AbsolutePath | undefined }
    ↓
IndexContext { storageDir: AbsolutePath | undefined }
    ↓
Internal file operations
```

Every layer receives `storageDir: AbsolutePath | undefined`. When indexes need to create file paths, they can trust that `storageDir` is absolute:

```typescript
const absoluteRootDir = path.resolve(storageDir, `./${id}`) as AbsolutePath;
```

Any time you join an absolute path with a relative path, the result is absolute. The type system enforces this flow: if you need an `AbsolutePath`, you must either receive it from above or create it through resolution.

## The Browser Case

Not all environments have filesystems. By typing `storageDir` as `AbsolutePath | undefined`, we force every consumer to handle the browser case:

```typescript
function myIndex({ storageDir }: IndexContext) {
	if (!storageDir) {
		throw new Error('This index requires Node.js environment');
	}
	// Now TypeScript knows storageDir is AbsolutePath
	const dbPath = path.join(storageDir, 'data.db');
}
```

The `| undefined` isn't just for browsers; it documents that filesystem operations might not be available.

## What This Prevents

Without branded types, these bugs slip through:

```typescript
// Accidentally passing relative path
const userPath = './content';
writeFile(userPath, data); // Where does this go? Depends on cwd!

// Mixing user input with internal paths
const configPath = getUserConfig();
const dataPath = path.join(configPath, 'data'); // Is configPath absolute?
```

With branded types, TypeScript stops you:

```typescript
function writeFile(path: AbsolutePath, data: string) {
	/* ... */
}

const userPath = './content';
writeFile(userPath, data); // Type error: string is not AbsolutePath

// Must resolve first
const absoluteUserPath = path.resolve(userPath) as AbsolutePath;
writeFile(absoluteUserPath, data); // OK
```

The cast is explicit. You can't accidentally pass a relative path. Every cast is a signal: "I'm asserting this path is absolute."

## The Lesson

Not every data access needs a service, and not every type constraint needs runtime overhead. Branded types give you compile-time safety without changing runtime behavior.

The pattern: accept flexible input at the boundary, resolve to absolute, brand it, cascade down. One resolution point, type-safe everywhere else.

Here's what made this work:

1. **Clear boundary**: User-facing config accepts strings, internal code uses AbsolutePath
2. **Single source of truth**: Resolution happens once, at initialization
3. **Type system enforcement**: Can't accidentally bypass the resolution step
4. **Browser handling**: `| undefined` forces explicit environment checks

I was treating paths like any other string. The realization: not all strings are equal. Some strings carry guarantees (this is absolute), others don't (user input). The type system should reflect that.

Branded types aren't just for paths. Anytime you have a value that requires validation or transformation, consider whether a branded type makes sense. User IDs, email addresses, sanitized HTML: these all have invariants the type system can enforce.

The key insight: the type system isn't just for finding bugs. It's for encoding knowledge. "This path is absolute" is knowledge worth encoding.
