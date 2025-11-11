import { type } from 'arktype';
import { createApps, createAppUrls } from '#apps';

/**
 * Node.js/server-side constants and utilities
 * Uses process.env.NODE_ENV for environment detection
 */

// Schema
const nodeEnvSchema = type({
	NODE_ENV: "'development' | 'production'",

	DATABASE_URL: 'string.url',
	BETTER_AUTH_URL: 'string.url',
	BETTER_AUTH_SECRET: 'string',
	GH_CLIENT_ID: 'string',
	GH_CLIENT_SECRET: 'string',
});

export function validateNodeEnv(env: unknown): NodeEnv {
	const result = nodeEnvSchema(env);
	if (result instanceof type.errors) throw new Error(result.summary);
	return result;
}

export type NodeEnv = typeof nodeEnvSchema.infer;

/**
 * Node.js build-time environment.
 * Uses process.env.NODE_ENV for environment detection.
 *
 * For use in Node.js contexts (server-side applications).
 *
 * IMPORTANT: This file reads from `process.env` which is only available at build time.
 * DO NOT import this file inside Cloudflare Workers or other edge runtime environments
 * where `process.env` is not available.
 *
 * This is intended for use in build-time configuration files (like `drizzle.config.ts`
 * and `auth.ts`) which are meant to be run locally on my machine (where the Node.js
 * environment is available) to generate files.
 *
 * For runtime environments like Cloudflare Workers, access environment variables through
 * the platform's native env object (`c.env`) instead.
 */
export const env = validateNodeEnv(process.env);

/**
 * Node.js build-time URLs (derived from shared lazy functions).
 * Uses process.env.NODE_ENV for environment detection.
 *
 * For use in Node.js contexts that only need URL constants.
 */
export const APPS = createApps(env.NODE_ENV);

/**
 * All application URLs for Node.js contexts.
 * Derived from shared lazy function, evaluated at build time.
 *
 * Primarily used for CORS configuration in server-side applications.
 */
export const APP_URLS = createAppUrls(env.NODE_ENV);
