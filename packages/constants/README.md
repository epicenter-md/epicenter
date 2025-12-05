# @epicenter/constants

Environment-aware constants and configuration for all services in the ecosystem. This package provides a unified way to manage service URLs and environment-specific settings across different platforms (Node.js, Cloudflare Workers, and Vite).

## Installation

```bash
bun add @epicenter/constants
```

## Architecture

Files are separated by runtime context (`./cloudflare`, `./node`, `./vite`) to prevent import issues:

- **`/node`**: For Node.js server environments. Build-time evaluation using `process.env.NODE_ENV`.
- **`/cloudflare`**: For Cloudflare Workers. Runtime evaluation using `c.env` and lazily evaluating at runtime per request.
- **`/vite`**: For Vite client applications. Build-time evaluation using `import.meta.env.MODE`.

## Usage

### Node.js

```typescript
import { APPS, APP_URLS, env } from '@epicenter/constants/node';

// Access pre-evaluated constants
console.log(APPS.AUTH.URL); // 'http://localhost:8787' or 'https://auth.epicenter.so'

// Use in CORS configuration
const corsOptions = {
  origin: APP_URLS
};

// Access validated environment
console.log(env.NODE_ENV); // 'development' or 'production'
```

### Cloudflare Workers

Everything you need for Cloudflare Workers with runtime environment:

```typescript
import { APPS, APP_URLS, validateNodeEnv, type NodeEnv } from '@epicenter/constants/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono<{ Bindings: NodeEnv }>();

app.use('/api/*', (c, next) =>
    cors({
        origin: APP_URLS(c.env),
        credentials: true,
    })(c, next),
);

// App constants (runtime resolution)
app.get('/config', (c) => {
    const authUrl = APPS(c.env).AUTH.URL;
    return c.json({ authUrl });
});
```
### Vite

```typescript
import { APPS, APP_URLS } from '@epicenter/constants/vite';

// Use in your client application
const authEndpoint = `${APPS.AUTH.URL}/api/login`;

// Configure allowed origins
const allowedOrigins = APP_URLS;
```
