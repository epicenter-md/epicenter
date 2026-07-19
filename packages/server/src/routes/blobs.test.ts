/**
 * Blob route boundary tests.
 *
 * Wave 3 removes the identity URL segment. Auth supplies the principal; the route
 * URL carries only the blob surface and optional BlobId.
 */

import { afterEach, expect, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { asPrincipalId } from '@epicenter/identity';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { mountBlobsApp } from './blobs.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('list route uses the principal from auth without a principal URL segment', async () => {
	const app = new Hono().get(
		API_ROUTES.blobs.list.pattern,
		(c) =>
			new Response(JSON.stringify({ path: c.req.path }), {
				headers: { 'content-type': 'application/json' },
			}),
	);
	const url = API_ROUTES.blobs.list.url('https://x');
	const res = await app.request(url);

	expect(res.status).toBe(200);
	expect(new URL(url).pathname).toBe('/api/blobs');
	const body = (await res.json()) as unknown;
	expect(body).toEqual({ path: '/api/blobs' });
});

test('by-id route accepts only canonical BlobIds', async () => {
	const app = new Hono().get(API_ROUTES.blobs.byId.pattern, (c) =>
		c.text(c.req.param('blobId')),
	);
	const blobId = generateBlobId();

	expect(
		(await app.request(API_ROUTES.blobs.byId.url('https://x', blobId))).status,
	).toBe(200);
	expect(
		(await app.request(`https://x/api/blobs/${'a'.repeat(64)}`)).status,
	).toBe(404);
});

test('upload ticket presigns directly without a HEAD request', async () => {
	globalThis.fetch = (async () => {
		throw new Error('ticket mint must not call S3');
	}) as unknown as typeof fetch;
	const app = new Hono<Env>();
	mountBlobsApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			c.set('authBaseURL', 'https://api.example.com');
			await next();
		},
	});
	const blobId = generateBlobId();
	const res = await app.request(
		API_ROUTES.blobs.list.url('https://api.example.com'),
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				blobId,
				sizeBytes: 5,
				contentType: 'text/plain',
			}),
		},
		{
			BLOBS_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
			BLOBS_S3_ACCESS_KEY_ID: 'test-access-key',
			BLOBS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
		},
	);

	expect(res.status).toBe(200);
	const ticket = (await res.json()) as {
		url: string;
		uploadUrl: string;
		requiredHeaders: Record<string, string>;
	};
	expect(ticket.url).toBe(
		API_ROUTES.blobs.byId.url('https://api.example.com', blobId),
	);
	expect(ticket.requiredHeaders).toEqual({
		'content-type': 'text/plain',
		'if-none-match': '*',
	});
	expect(ticket.uploadUrl).toContain(`/principals/alice/blobs/${blobId}`);
});
