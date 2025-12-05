# Running Shell Commands in Node.js: The execAsync Pattern

I needed to run shell commands from a Node.js script. Specifically, git commands. I wanted to check if a directory is a git repo, get the current branch, run git status. Standard stuff.

My first instinct was to reach for `child_process.exec`. But that uses callbacks. I wanted async/await. So I went looking for the "right" way to do this, and ended up in decision paralysis. There are like five different approaches, each with their own trade-offs.

Here's what I learned about the execAsync pattern and when to use it versus the alternatives.

## The Pattern

execAsync isn't a function you import. It's a pattern. You take Node's built-in `exec` and wrap it with `promisify`:

```typescript
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

// Now you can use async/await
const { stdout, stderr } = await execAsync('git status');
console.log(stdout);
```

That's it. No external dependencies. No learning a new API. Just the stdlib wrapped in promises.

The return value is an object with two string properties: `stdout` (standard output) and `stderr` (standard error). Both are captured and returned when the command completes.

## Why This Exists

Node's `child_process.exec` was designed in the callback era:

```javascript
exec('git status', (error, stdout, stderr) => {
  if (error) {
    console.error(error);
    return;
  }
  console.log(stdout);
});
```

This works, but it doesn't play nicely with async/await. You end up wrapping everything in promises manually or nesting callbacks.

The `promisify` utility from `util` converts callback-based functions to promise-based ones. It's specifically designed for Node.js APIs that follow the error-first callback pattern. Apply it to `exec`, and you get execAsync.

## When to Use execAsync

I use execAsync for:

**Quick scripts**: Build scripts, deployment scripts, CLI tools. When I'm writing a one-off Node script and need to run a few shell commands.

**Simple commands**: Single commands that complete quickly and produce bounded output. Git commands, directory operations, basic file manipulation.

**No dependencies preferred**: When I'm already using Node and don't want to add external packages. The stdlib is right there.

Here's a concrete example from a deploy script:

```typescript
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

async function deploy() {
  // Check if working directory is clean
  const { stdout } = await execAsync('git status --porcelain');
  if (stdout.trim()) {
    throw new Error('Working directory not clean');
  }

  // Get current branch
  const { stdout: branch } = await execAsync('git branch --show-current');
  console.log(`Deploying from branch: ${branch.trim()}`);

  // Run tests
  await execAsync('npm test');

  // Deploy
  await execAsync('npm run build && firebase deploy');
}
```

Simple, readable, no dependencies beyond Node's stdlib.

## The Alternatives

But execAsync isn't always the right choice. Here are the alternatives I've seen most commonly.

### execa

[execa](https://github.com/sindresorhus/execa) is the most popular third-party library for running shell commands:

```typescript
import { execa } from 'execa';

const { stdout } = await execa('git', ['status']);
console.log(stdout);
```

Key differences from execAsync:

**Doesn't use a shell by default**: `execa('git', ['status'])` directly executes the git binary. execAsync runs commands through a shell (`/bin/sh` on Unix). This makes execa safer (no shell injection) and faster (no shell overhead).

**Better error handling**: Errors include the command, exit code, stdout, stderr, all in one object. Makes debugging easier.

**Streaming support**: You can stream stdout/stderr as the command runs, not just get the full output at the end.

**More features**: Kill timeouts, input/output transformations, better Windows support, colored output preservation.

Example with streaming:

```typescript
import { execa } from 'execa';

const subprocess = execa('npm', ['install']);

subprocess.stdout.pipe(process.stdout);
subprocess.stderr.pipe(process.stderr);

await subprocess;
```

### spawn

For long-running processes or large output, use `spawn` instead of exec:

```typescript
import { spawn } from 'child_process';

const child = spawn('npm', ['install'], {
  stdio: 'inherit', // Stream to parent's stdio
});

child.on('close', (code) => {
  if (code !== 0) {
    throw new Error(`Process exited with code ${code}`);
  }
});
```

The key difference: spawn streams data as it arrives, exec buffers everything in memory. If your command outputs megabytes of data, spawn is the right choice.

### Bun's $

If you're using Bun instead of Node.js, there's a built-in shell scripting API:

```typescript
import { $ } from 'bun';

const output = await $`git status`;
console.log(output.text());
```

The `$` template tag makes shell scripting feel native to the language. It's fast, ergonomic, and has great error handling. But it only works in Bun, not Node.js.

For a detailed comparison: [execAsync vs Bun's $ Shell](./execasync-vs-bun-shell.md)

## The Decision Tree

Here's how I decide which approach to use:

**If I'm using Bun**: Always use `$`. It's built-in, simplest, and nicest.

**If I'm using Node**: **execAsync** or maybe **spawn** for the simplest commands and long-running processes, otherwise always **execa**

## The Lesson

You don't always need a library. For simple shell commands in Node scripts, `promisify(exec)` gives you 90% of what you need with zero dependencies.

But know when to graduate to something more capable. If you're hitting limits or building anything user-facing, reach for execa. If you're in Bun, use `$`. If you need streaming or low-level control, use spawn.

The execAsync pattern is a tool, not a dogma. Use it where it fits, and don't be afraid to upgrade when the requirements change.
