# Finding Node.js Alternatives to Bun's Shell

I hit an interesting architectural decision while trying to publish my CLI to npm. The code relied heavily on Bun's `$` shell API, but targeting Node.js meant finding alternatives.

## The Problem

Bun's shell API is beautifully simple:

```javascript
import { $ } from "bun";
await $`ls -la`;
```

But it's Bun-specific. The Bun documentation states:

> "Bun Shell is a small programming language. It's not bash, sh, or zsh. It's a custom language that interprets a subset of bash syntax."

When building for Node.js, you need alternatives. 

## Why Not Native child_process?

Before exploring libraries, let's address the elephant in the room: Node.js's built-in `child_process` module.

```javascript
const { exec, spawn } = require('child_process');

// Callback hell
exec('ls -la', (error, stdout, stderr) => {
  if (error) {
    console.error(`error: ${error.message}`);
    return;
  }
  console.log(stdout);
});

// Or with spawn (even more verbose)
const ls = spawn('ls', ['-la']);
ls.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});
```

The problems compound quickly:
- Callbacks or manual promisification required
- String escaping becomes your responsibility
- Error handling is inconsistent
- Performance degrades with repeated spawning
- Platform differences (Windows vs Unix) handled manually
- No built-in piping or redirection support

This is exactly why alternatives exist. As one developer noted on Hacker News:

> "For something which works across all JS runtimes (Deno, Node) and achieves basically the same, check out the popular JS library Execa. Works like a charm!"

## The Contenders

### execa: The Lightweight Choice

```javascript
import { execa } from 'execa';
await execa('ls', ['-la']);
```

Execa takes a more explicit approach. Every command is broken into the program and its arguments. At ~50KB, it's lean and focused on doing one thing well: executing commands with excellent error handling.

What struck me about execa is its production readiness. It powers many popular npm packages and provides detailed error messages that actually help when things go wrong. The tradeoff? More verbose syntax and no built-in shell features unless you enable `shell: true`.

### zx: The Developer-Friendly Option

```javascript
import { $ } from 'zx';
await $`ls -la`;
```

Google's zx feels familiar if you're coming from Bun. Same `$` syntax, same intuitive API. But it brings ~500KB of dependencies and opinions about how shell scripting should work in JavaScript.

The appeal of zx is its kitchen-sink approach. Need to change directories? Use `cd()`. Want to fetch a URL? There's `fetch()`. It's designed for scripts where developer experience trumps bundle size.

### Other Alternatives

The Hacker News discussion also mentioned Dax as a cross-platform shell for Deno, showing the JavaScript ecosystem's ongoing efforts to solve shell scripting across different runtimes.

## The Architectural Difference

Bun's approach is fundamentally different. From the Bun documentation:

> "The Bun Shell is a new experimental embedded language and interpreter in Bun that allows you to run cross-platform shell scripts in JavaScript & TypeScript."

Unlike zx which shells out to bash or PowerShell, Bun reimplements the shell entirely. This fundamental difference affects portability, performance, and behavior consistency across platforms.

## Making the Choice

For my CLI package, I chose execa. Why?

1. **Library context**: OpenCode is a dependency, not a standalone script
2. **Minimal footprint**: 50KB vs 500KB matters when you're someone else's dependency
3. **Explicit control**: Better for understanding exactly what's happening
4. **Flexibility**: Works in CommonJS and ESM environments

## The Migration Pattern

Moving from Bun's `$` to execa looks like this:

```javascript
// Before (Bun)
const result = await $`git status --porcelain`.text();

// After (execa)
const { stdout } = await execa('git', ['status', '--porcelain']);
```

More verbose? Yes. But also more explicit about what's actually happening.

## The Lesson

Not every elegant API needs a direct replacement. Sometimes the "less convenient" option is the right architectural choice. Bun's `$` is fantastic for Bun-first applications. But when you need broad compatibility, embracing the constraints of your target platform leads to better decisions.

The JavaScript ecosystem is still figuring out the best patterns for shell interaction. Each tool represents different priorities: developer experience, bundle size, cross-platform compatibility, or native integration. Understanding these tradeoffs helps you pick the right tool for your specific constraints.

## References

- [Bun Shell Documentation](https://github.com/oven-sh/bun/blob/main/docs/runtime/shell.md)
- [Hacker News Discussion on Bun Shell](https://news.ycombinator.com/item?id=39071982)
- [execa](https://github.com/sindresorhus/execa)
- [zx](https://github.com/google/zx)