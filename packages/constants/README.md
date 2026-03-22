# @epicenter/constants

Shared URLs, ports, and version info for the Epicenter monorepo. Each runtime context gets its own subpath export so bundlers only pull in what they need.

## Single source of truth

All app metadata lives in `APPS` inside `src/apps.ts`:

```typescript
export const APPS = {
  API:   { port: 8787, url: 'https://api.epicenter.so' },
  SH:    { port: 5173, url: 'https://epicenter.sh' },
  AUDIO: { port: 1420, url: 'https://whispering.epicenter.so' },
} as const;
```

Everything else is derived from this.

## Exports

### `@epicenter/constants/vite`

For Vite-bundled apps (SvelteKit, Tauri, WXT). Auto-detects dev vs prod via `import.meta.env.MODE`.

```typescript
import { APP_URLS } from '@epicenter/constants/vite';

const apiUrl = APP_URLS.API;
// dev:  'http://localhost:8787'
// prod: 'https://api.epicenter.so'
```

### `@epicenter/constants/apps`

For non-Vite contexts (Cloudflare Workers, CLI scripts). Use `APPS` directly.

```typescript
import { APPS } from '@epicenter/constants/apps';

// CORS origins:
const prodOrigins = Object.values(APPS).map(a => a.url);
const devOrigins = Object.values(APPS).map(a => `http://localhost:${a.port}`);

// Dev server port:
server: { port: APPS.AUDIO.port, strictPort: true }

// CLI tool — always local:
const baseURL = `http://localhost:${APPS.API.port}`;
```

### `@epicenter/constants/versions`

Monorepo-wide version string, stamped by CI on each release.

```typescript
import { VERSION } from '@epicenter/constants/versions';
```

## Adding a new app

1. Add an entry to `APPS` in `src/apps.ts` with `port` and `url`.
2. Every export picks it up automatically — TypeScript enforces completeness.
