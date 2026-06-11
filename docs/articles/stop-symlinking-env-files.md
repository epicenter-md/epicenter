# Stop Symlinking Your .env Files

**TL;DR**: If your tool expects `.env` but your project uses `.dev.vars`, don't create a symlink. Use `bun --env-file=.dev.vars` in your package.json scripts. Add runtime validation so you get a clear error instead of silent undefined behavior.

---

I was setting up `@better-auth/cli` in a Cloudflare Workers project and hit an immediate wall. The CLI tool reads from `.env`. But Cloudflare Workers uses `.dev.vars` for local secrets. Two different files, same purpose, different names.

The obvious fix is a symlink: `ln -s .dev.vars .env`. Done, right?

Wrong. Let me tell you why that's a bad idea, and what to do instead.

## The Symlink Trap

A symlink looks like a solution because it makes both tools happy in the moment. But here's what you've actually created:

**On macOS and Linux**, a symlink is a special filesystem entry that transparently redirects reads. Fine.

**On Windows**, git stores symlinks as plain text files containing the target path: literally the string `.dev.vars` written into a file called `.env`. When a Windows dev clones your repo, they get a text file instead of a working symlink. Their tools break. They spend an hour debugging something that has nothing to do with what they're trying to do.

Even if you gitignore both files (which you should, since they contain secrets), the symlink itself can end up in the repo accidentally. And even when it doesn't, you've created something conceptually weird: two files that are "the same thing." When a new person looks at the project, they see `.env` and `.dev.vars` and wonder what's different about them. There's nothing different. That's the whole problem.

A symlink is a local workaround pretending to be project infrastructure. There's a better way.

## The Fix: `--env-file`

Bun has a flag for exactly this: `--env-file`. You tell bun where to load environment variables from, and it loads them before running the script.

Instead of a symlink, your package.json script looks like this:

```json
{
  "scripts": {
    "auth:generate": "bun --env-file=.dev.vars x @better-auth/cli generate src/auth.ts",
    "auth:migrate": "bun --env-file=.dev.vars x @better-auth/cli migrate src/auth.ts"
  }
}
```

Run `bun run auth:generate` and bun loads `.dev.vars` into `process.env` before the CLI sees it. The CLI finds its `DATABASE_URL`. No symlink. No confusion. No Windows footgun.

The intent is also explicit now. Anyone reading `package.json` can see exactly where the env vars come from. It's not hidden in a filesystem relationship between two files.

## But Wait: What If the Env Vars Are Missing?

Here's where this gets interesting. When the CLI parses `src/auth.ts` to understand your schema, it actually executes that file. That means your auth config runs at codegen time, not just at server startup. If `DATABASE_URL` is missing, you get something like:

```
TypeError: Cannot read properties of undefined (reading 'url')
```

That error doesn't tell you anything useful. You have to trace back through the stack to realize the real problem is that your env file wasn't loaded.

The fix is to validate early and fail loudly. Here's the actual `auth.ts` file that serves as the CLI entry point:

```ts
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { sharedAuthConfig } from './auth/server';

const CliEnv = type({
  DATABASE_URL: 'string',
  BETTER_AUTH_SECRET: 'string',
});

const env = CliEnv(process.env);
if (env instanceof type.errors) {
  throw new Error(
    `Missing env vars for Better Auth CLI. Run with --env-file=.dev.vars.\n${env.summary}`,
  );
}

export const auth = betterAuth({
  ...sharedAuthConfig,
  database: { type: 'postgres', url: env.DATABASE_URL },
  secret: env.BETTER_AUTH_SECRET,
});
```

Now if you forget `--env-file`, or if `.dev.vars` is missing a key, you get:

```
Error: Missing env vars for Better Auth CLI. Run with --env-file=.dev.vars.
DATABASE_URL must be a string (was undefined)
```

That's a good error. It tells you exactly what's wrong and exactly how to fix it.

## The Pattern: One Config, Two Entry Points

There's something worth naming here. Notice that `auth.ts` spreads `sharedAuthConfig`:

```ts
export const auth = betterAuth({
  ...sharedAuthConfig,          // shared: plugins, basePath, email/password
  database: { ... },            // env-specific
  secret: env.BETTER_AUTH_SECRET,  // env-specific
});
```

The runtime worker does the same thing:

```ts
export function createAuth(env: AuthEnv) {
  return betterAuth({
    ...sharedAuthConfig,          // same shared config
    database: { ... },            // runtime env-specific
    secret: env.BETTER_AUTH_SECRET,
    secondaryStorage: { ... },    // runtime-only (KV caching)
    session: { ... },             // runtime-only
  });
}
```

`sharedAuthConfig` lives in one place and contains everything that affects the database schema: plugins, base path, feature flags. The CLI entry point and the runtime entry point both spread it and then add their own env-specific bits.

This matters because the CLI generates migrations based on your schema. If the CLI's config and the runtime's config ever diverge, your migrations won't match your actual tables. By sharing one source of truth, that problem can't happen.

One recent simplification: since March 2025, `import { env } from "cloudflare:workers"` gives you module-level access to bindings. The runtime entry point can now be a top-level singleton (`export const auth = createAuth(env)`) instead of a per-request factory. The `--env-file` pattern and arktype validation for the CLI entry point are unchanged. The CLI still runs in Node/Bun, not Workers.

Call it the **Split Entry Point Pattern**: one shared config for schema-affecting options, two entry points for the execution context.

```
┌─────────────────────┐
│   sharedAuthConfig  │  ← plugins, basePath, feature flags
│   (schema-affecting)│
└──────────┬──────────┘
           │ spreads into
     ┌─────┴─────┐
     │           │
┌────▼────┐  ┌───▼──────────────┐
│ auth.ts │  │ createAuth(env)  │
│  (CLI)  │  │  (Worker runtime)│
└─────────┘  └──────────────────┘
  validates    gets env from
  process.env  Cloudflare bindings
```

## ❌ The Symlink Approach

```bash
# Don't do this
ln -s .dev.vars .env

# Now both are gitignored, but:
# - Windows devs get a text file instead of a working symlink
# - Two files with no apparent difference
# - The relationship is invisible to anyone reading the code
```

## The `--env-file` Approach

```json
{
  "scripts": {
    "auth:generate": "bun --env-file=.dev.vars x @better-auth/cli generate src/auth.ts",
    "auth:migrate": "bun --env-file=.dev.vars x @better-auth/cli migrate src/auth.ts"
  }
}
```

```ts
// auth.ts: validates env before anything else runs
const CliEnv = type({
  DATABASE_URL: 'string',
  BETTER_AUTH_SECRET: 'string',
});

const env = CliEnv(process.env);
if (env instanceof type.errors) {
  throw new Error(
    `Missing env vars for Better Auth CLI. Run with --env-file=.dev.vars.\n${env.summary}`,
  );
}
```

| Approach | Works on Windows | Self-documenting | Fails clearly | Intent visible in code |
|----------|-----------------|------------------|---------------|----------------------|
| Symlink | No | No | No | No |
| `--env-file` + validation | Yes | Yes | Yes | Yes |

## When Symlinks Are Fine

Symlinks have legitimate uses: pointing a `node_modules/.bin` entry at a script, aliasing a build output. The problem is using them to paper over a naming mismatch between tools. That's a convention difference, and the right place to resolve convention differences is in your scripts, not in your filesystem.

If you're on a project where everyone is on macOS or Linux and symlinks always work, the symlink approach isn't going to break anything. But it's still solving the wrong problem in the wrong place.

---

**The Golden Rule**: Name the env file in your scripts, not in your filesystem. If two tools disagree on where to find secrets, teach one tool where to look: don't create a filesystem relationship that silently breaks on other platforms.

---

### Quotable Moments

> "A symlink is a local workaround pretending to be project infrastructure."

> "The intent is explicit now. Anyone reading package.json can see exactly where the env vars come from. It's not hidden in a filesystem relationship between two files."

> "If the CLI's config and the runtime's config ever diverge, your migrations won't match your actual tables. By sharing one source of truth, that problem can't happen."

> "Name the env file in your scripts, not in your filesystem."

---

**Related:** [Better Auth Needs Two Entry Points in Serverless](./better-auth-needs-two-entry-points-in-serverless.md) dives deeper into the split entry point pattern and the module-level singleton update. [Hono Factory Pattern](./20260305T110000-hono-factory-pattern-type-safety.md) covers the type-safe middleware side of the same architecture.
