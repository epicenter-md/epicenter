import { type } from 'arktype';
import { createApps, createAppUrls } from '#apps';

/**
 * Cloudflare Workers constants and utilities
 * Takes environment at call time for dynamic resolution
 * Source of truth for lazy app constants
 */

// Schema
const cloudflareEnvSchema = type({
	NODE_ENV: "'development' | 'production'",

	DATABASE_URL: 'string.url',
	BETTER_AUTH_URL: 'string.url',
	BETTER_AUTH_SECRET: 'string',
	GITHUB_CLIENT_ID: 'string',
	GITHUB_CLIENT_SECRET: 'string',
});

export function validateCloudflareEnv(env: unknown): CloudflareEnv {
	const result = cloudflareEnvSchema(env);
	if (result instanceof type.errors) throw new Error(result.summary);
	return result;
}

export type CloudflareEnv = typeof cloudflareEnvSchema.infer;

/**
 * Cloudflare Workers URLs - lazy evaluation with environment.
 *
 * For use in Cloudflare Workers and other contexts where environment is provided at call time.
 */
export const APPS = (env: CloudflareEnv) => createApps(env.NODE_ENV);

/**
 * All application URLs for Cloudflare Workers.
 * Takes environment at call time for dynamic resolution.
 *
 * Primarily used for CORS configuration.
 */
export const APP_URLS = (env: CloudflareEnv) => createAppUrls(env.NODE_ENV);
