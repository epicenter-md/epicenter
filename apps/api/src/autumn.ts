import { Autumn } from 'autumn-js';

/**
 * Create an Autumn SDK client from worker env bindings.
 *
 * Stateless—safe to create per-request. No connection pooling needed.
 *
 * We use the SDK client directly instead of `autumnHandler` from
 * `autumn-js/hono`. That handler creates `/api/autumn/*` proxy routes
 * designed to be called by Autumn's frontend React hooks. We don't need
 * it because all billing logic is server-side (Hono JSX in billing.tsx,
 * check/track in ai-chat.ts). If we add Svelte-side billing hooks that
 * need to call Autumn from the client, mount `autumnHandler` then.
 *
 * @example
 * ```ts
 * const autumn = createAutumn(c.env);
 * const { allowed } = await autumn.check({ ... });
 * ```
 */
export function createAutumn(env: { AUTUMN_SECRET_KEY: string }) {
	return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });
}
