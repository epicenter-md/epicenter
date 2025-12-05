# Managing Environment Constants: The `/env/vite` vs `/env/node` Pattern

I hit an interesting decision when managing environment constants across my monorepo. In development, my client needs to hit my development server. But from the Vite config, I need to access `import.meta.env.MODE` to determine the right server. From Node.js contexts, I need `process.env.NODE_ENV` to get the proper configuration.

I originally tried a unified `APPS(env)` function. Instead, I decided to export them as two completely separate files. Here's why that works better.

## The Problem

My original approach used a runtime function:

```typescript
// Single file with runtime function
export const APPS = (env) => ({
  AUTH: {
    URL: env.MODE === 'production' 
      ? 'https://auth.epicenter.so'
      : 'http://localhost:8787'
  },
  SH: {
    URL: env.MODE === 'production'
      ? 'https://epicenter.sh' 
      : 'http://localhost:5173'
  }
});

// Usage everywhere
import { APPS } from '@epicenter/constants';
const url = APPS(import.meta.env).SH.URL; // Vite
const url = APPS(env).SH.URL; // Node
```

This required passing environment objects around everywhere and coupling URL access to environment validation.

## The Solution: Separate Files

I split constants into context-specific files using package.json subpath exports:

```json
{
  "exports": {
    "./env/vite": "./src/env/vite.ts",
    "./env/node": "./src/env/node.ts"
  }
}
```

**Vite contexts** (`src/env/vite.ts`):
```typescript
export const APPS = {
  AUTH: {
    URL: import.meta.env.MODE === 'production'
      ? 'https://auth.epicenter.so'
      : 'http://localhost:8787',
  },
  SH: {
    URL: import.meta.env.MODE === 'production'
      ? 'https://epicenter.sh'
      : 'http://localhost:5173',
  },
} as const;
```

**Node.js contexts** (`src/env/node.ts`):
```typescript
import { validateEnv } from '#env-schema';

export const env = validateEnv(process.env);

export const APPS = {
  AUTH: {
    URL: process.env.NODE_ENV === 'production'
      ? 'https://auth.epicenter.so'
      : 'http://localhost:8787',
  },
  SH: {
    URL: process.env.NODE_ENV === 'production'
      ? 'https://epicenter.sh'
      : 'http://localhost:5173',
  },
} as const;
```

Now consumers import exactly what they need:

```typescript
// Client-side code (just APPS)
import { APPS } from '@epicenter/constants/env/vite';
const authUrl = APPS.AUTH.URL;

// Server-side code (APPS + validated env)
import { APPS, env } from '@epicenter/constants/env/node';
const authUrl = APPS.AUTH.URL;
const dbUrl = env.DATABASE_URL;
```

## Why Separate Files Matter

The key insight: **these files should never mix**. If you put both contexts in the same file, you get import issues. Vite code trying to access `process.env` fails. Node.js code trying to access `import.meta.env` fails.

By separating them completely, each file only imports what's available in its runtime context. The bundler can optimize each one independently.

This also follows platform conventions. Vite naturally uses `MODE`, while Node.js uses `NODE_ENV`. Making this explicit through separate imports is clearer than hiding it behind function parameters.

## Build-Time Resolution

Constants resolve at build time, not runtime. When Vite builds with `MODE=production`, the URLs are already hardcoded to production values. Same for Node.js with `NODE_ENV=production`.

This eliminates runtime environment checking and makes your constants predictable. No more passing environment objects around or wondering what values you'll get.

## Implementation Notes

I keep the constants structure identical between files—only the environment detection differs. This maintains API consistency while optimizing for each runtime.

The `/env/vite` and `/env/node` naming makes the intended context obvious. You know exactly which file to import based on your environment.

The lesson: When you have different runtime contexts, embrace separate files instead of trying to unify them. Your bundler and your code clarity will thank you.