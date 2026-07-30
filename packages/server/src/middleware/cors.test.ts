/**
 * CORS allowances the document sync protocol depends on.
 *
 * A browser client on a different origin from its authority (a hosted app
 * against `apps/api`, or a browser app against a self-host that configured
 * `TRUSTED_BROWSER_ORIGINS`) pulls documents conditionally: it SENDS
 * `If-None-Match` and READS `ETag` (`packages/document-sync/src/protocol.ts`).
 * Neither header is CORS-safelisted, so both need an explicit allowance here.
 * Drop either one and cross-origin pull breaks silently: the preflight fails,
 * or `headers.get('etag')` returns `null` and the client cannot settle a
 * revision. These tests exist so that failure is a red test, not a field bug.
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { corsMiddleware } from './cors.js';

const TRUSTED_ORIGIN = 'https://notes.example.com';
const DOCUMENT_PATH =
	'/api/sync/v1/documents/so.epicenter.test/notes/aaaaaaaaaaaaaaaaaaaaaaaa';

function createCorsTestApp() {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('trustedOrigins', [TRUSTED_ORIGIN]);
		await next();
	});
	app.use('*', corsMiddleware);
	app.get(DOCUMENT_PATH, (c) => c.body(null, 204, { etag: '"7"' }));
	return app;
}

test('preflight admits the conditional document pull headers', async () => {
	const res = await createCorsTestApp().request(DOCUMENT_PATH, {
		method: 'OPTIONS',
		headers: {
			origin: TRUSTED_ORIGIN,
			'access-control-request-method': 'GET',
			'access-control-request-headers': 'if-none-match, authorization',
		},
	});
	const allowed = (res.headers.get('access-control-allow-headers') ?? '')
		.toLowerCase()
		.split(',')
		.map((header) => header.trim());
	expect(allowed).toContain('if-none-match');
	expect(allowed).toContain('authorization');
	expect(allowed).toContain('content-type');
});

test('document pull exposes ETag so the client can read the version', async () => {
	const res = await createCorsTestApp().request(DOCUMENT_PATH, {
		headers: { origin: TRUSTED_ORIGIN },
	});
	expect(res.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN);
	const exposed = (res.headers.get('access-control-expose-headers') ?? '')
		.toLowerCase()
		.split(',')
		.map((header) => header.trim());
	expect(exposed).toContain('etag');
});

test('an untrusted origin gets no allow-origin header', async () => {
	const res = await createCorsTestApp().request(DOCUMENT_PATH, {
		headers: { origin: 'https://evil.example' },
	});
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
});

test('a request with no Origin header is untouched', async () => {
	const res = await createCorsTestApp().request(DOCUMENT_PATH);
	expect(res.status).toBe(204);
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
});
