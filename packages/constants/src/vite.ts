/// <reference types="vite/client" />

import { APPS, type AppId } from '#apps';

/**
 * Flat URL strings resolved at Vite build time.
 *
 * `import.meta.env.MODE` is statically replaced by Vite:
 * - `vite dev`   → `'development'` → `http://localhost:<port>`
 * - `vite build` → `'production'`  → production URLs
 */
const isDev = import.meta.env.MODE !== 'production';

export const APP_URLS = Object.fromEntries(
	Object.entries(APPS).map(([id, app]) => [
		id,
		isDev ? `http://localhost:${app.port}` : app.url,
	]),
) as { readonly [K in AppId]: string };
