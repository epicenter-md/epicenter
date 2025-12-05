# Node.js execAsync vs Bun's $: Built-in Command Execution

If you need to run shell commands without installing third-party libraries, these are the two most common built-in patterns I've seen: Node.js's `execAsync` and Bun's `$` shell.

## The Two Patterns

### Node.js: execAsync (promisify + exec)

```typescript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Usage
const { stdout } = await execAsync('git status');
console.log(stdout);
```

This is the standard Node.js approach. You take the callback-based `exec` function and convert it to return Promises using `promisify`.

### Bun: $ Shell

```typescript
import { $ } from 'bun';

// Usage
await $`git status`;
```

Bun provides a built-in shell API with template literal syntax. No setup needed.

## Quick Comparison

**Simple command:**
```typescript
// Node.js
const { stdout } = await execAsync('ls -la');

// Bun
await $`ls -la`;  // Prints to console
const output = await $`ls -la`.text();  // Capture output
```

**With variables:**
```typescript
const version = '7.5.6';

// Node.js - manual string interpolation
await execAsync(`git tag v${version}`);

// Bun - template literal
await $`git tag v${version}`;
```

**Error handling:**
```typescript
// Node.js
try {
  await execAsync('git push');
} catch (error) {
  console.error('Failed:', error.message);
}

// Bun
try {
  await $`git push`;
} catch (error) {
  console.error('Failed:', error);
}
```

## When to Use Each

**Use Node.js execAsync when:**
- Your code needs to run in Node.js
- You're building a library that others will use
- You need maximum compatibility

**Use Bun $ when:**
- You're building scripts or apps specifically for Bun
- You control the runtime environment
- You want cleaner syntax

## The Real Difference

The key difference: Node.js shells out to your system shell (bash, cmd.exe, etc.), while Bun implements its own shell interpreter. This means:

- **Node.js**: Platform-dependent behavior, uses system shell features
- **Bun**: Consistent cross-platform behavior, reimplements bash-like syntax

## Example: Our Version Bump Script

Here's how we use Bun's $ in our release script:

```typescript
import { $ } from 'bun';

// Update version files...
// Then automate the release workflow:

await $`git add -A`;
await $`git commit -m "chore: bump version to ${newVersion}"`;
await $`git tag v${newVersion}`;
await $`git push`;
await $`git push --tags`;
```

This is cleaner than the Node.js equivalent:

```typescript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

await execAsync('git add -A');
await execAsync(`git commit -m "chore: bump version to ${newVersion}"`);
await execAsync(`git tag v${newVersion}`);
await execAsync('git push');
await execAsync('git push --tags');
```

Both work. Bun's version is just less boilerplate.

## Third-Party Alternative: execa

If you want a better API for Node.js, [execa](https://github.com/sindresorhus/execa) is the most popular choice:

```typescript
import { execa } from 'execa';

await execa('git', ['push']);
await execa('git', ['push', '--tags']);
```

But that's a dependency you need to install. The article here focuses on built-in options only.

## The Lesson

These are the two patterns for running commands without dependencies. Use execAsync for Node.js, use $ for Bun. Both work fine; the choice is determined by your runtime, not by which is "better."
