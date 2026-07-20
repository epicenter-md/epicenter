/**
 * The Ark Public Delivery Plane Tests
 *
 * Pure fetch-handler tests over a stub Env. The stub R2 mirrors the binding
 * semantics this Worker actually relies on (onlyIf preconditions return a
 * body-less object, an unsatisfiable Range throws), so these tests pin the
 * routing, key-mapping, and streaming-header invariants without Miniflare.
 *
 * Key behaviors:
 * - URL to R2 key mapping: human routes and artifact outputs stay disjoint
 * - Hostile paths (traversal, encoding, uppercase) 404 before touching R2
 * - Trailing slashes 308-redirect to the slashless canonical URL
 * - Only GET and HEAD are allowed; conditional and Range reads behave
 * - The Worker owns cache policy; the publisher owns bytes and content-type
 */
import { describe, expect, test } from 'bun:test';

import { handleRequest, resolveProjection } from './index';

const ARTIFACT_ID = '019f79b2-a3f1-7000-97ea-04851c5323f2';

type StoredObject = {
	data: string;
	contentType?: string;
	cacheControl?: string;
};

function setup(objects: Record<string, StoredObject> = {}) {
	const requestedKeys: string[] = [];

	const makeMeta = (
		key: string,
		stored: StoredObject,
		range?: { offset: number; length: number },
	) => ({
		key,
		// Test payloads are ASCII, so string length is byte length.
		size: stored.data.length,
		httpEtag: `"etag-${key}"`,
		range,
		writeHttpMetadata(headers: Headers) {
			if (stored.contentType) headers.set('content-type', stored.contentType);
			if (stored.cacheControl)
				headers.set('cache-control', stored.cacheControl);
		},
	});

	const env = {
		PROJECTIONS: {
			async head(key: string) {
				requestedKeys.push(key);
				const stored = objects[key];
				return stored ? makeMeta(key, stored) : null;
			},
			async get(key: string, options?: { onlyIf?: Headers; range?: Headers }) {
				requestedKeys.push(key);
				const stored = objects[key];
				if (!stored) return null;
				const bytes = stored.data;
				const etag = `"etag-${key}"`;

				const ifNoneMatch = options?.onlyIf?.get('if-none-match');
				const ifMatch = options?.onlyIf?.get('if-match');
				if (ifNoneMatch === etag || (ifMatch && ifMatch !== etag)) {
					return makeMeta(key, stored);
				}

				let range: { offset: number; length: number } | undefined;
				let slice = bytes;
				const rangeHeader = options?.range?.get('range');
				if (rangeHeader) {
					const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
					if (match && (match[1] || match[2])) {
						let offset: number;
						let length: number;
						if (match[1]) {
							offset = Number(match[1]);
							const end = match[2]
								? Math.min(Number(match[2]), bytes.length - 1)
								: bytes.length - 1;
							length = end - offset + 1;
						} else {
							length = Math.min(Number(match[2]), bytes.length);
							offset = bytes.length - length;
						}
						if (offset >= bytes.length || length <= 0) {
							throw new Error(
								'get: The requested range is not satisfiable (10039)',
							);
						}
						range = { offset, length };
						slice = bytes.slice(offset, offset + length);
					}
				}
				return {
					...makeMeta(key, stored, range),
					body: new Response(slice).body,
				};
			},
		},
		ASSETS: {
			async fetch(input: Request | { toString(): string } | string) {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				const shells: Record<string, string> = {
					'/home.html': '<home shell>',
					'/not-found.html': '<not-found shell>',
				};
				const body = shells[url.pathname];
				if (body === undefined)
					return new Response('asset missing', { status: 404 });
				const method = input instanceof Request ? input.method : 'GET';
				return new Response(method === 'HEAD' ? null : body, {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				});
			},
		},
	};

	const fetch = (path: string, init?: RequestInit) =>
		handleRequest(new Request(`https://theark.so${path}`, init), env as Env);
	return { fetch, requestedKeys };
}

// ============================================================================
// Key resolution
// ============================================================================

describe('resolveProjection', () => {
	test('artifact permalink maps to its index.html object', () => {
		expect(resolveProjection('/braden/first-artifact')).toEqual({
			key: 'routes/braden/first-artifact/index.html',
			isPage: true,
		});
	});

	test('single-segment person route maps to its index.html object', () => {
		expect(resolveProjection('/braden')).toEqual({
			key: 'routes/braden/index.html',
			isPage: true,
		});
	});

	test('artifact output maps through its immutable UUIDv7 namespace', () => {
		expect(resolveProjection(`/_artifacts/${ARTIFACT_ID}/video.mp4`)).toEqual({
			key: `artifacts/${ARTIFACT_ID}/video.mp4`,
			isPage: false,
		});
	});

	test('rejects uppercase, underscores, dotfiles, double dots, and empty segments', () => {
		expect(resolveProjection('/Braden/foo')).toBeNull();
		expect(resolveProjection('/braden/some_slug')).toBeNull();
		expect(resolveProjection(`/_artifacts/${ARTIFACT_ID}/.hidden`)).toBeNull();
		expect(resolveProjection(`/_artifacts/${ARTIFACT_ID}/a..b`)).toBeNull();
		expect(resolveProjection('/braden//foo')).toBeNull();
	});

	test('rejects route file aliases, arbitrary route depth, and non-v7 artifact IDs', () => {
		expect(resolveProjection('/braden/first-artifact/index.html')).toBeNull();
		expect(resolveProjection('/braden/first-artifact/extra')).toBeNull();
		expect(
			resolveProjection(
				'/_artifacts/019f79b2-a3f1-6000-97ea-04851c5323f2/video.mp4',
			),
		).toBeNull();
	});

	test('rejects percent-encoded aliases', () => {
		expect(resolveProjection('/braden/%zz')).toBeNull();
		expect(resolveProjection('/br%61den/first-artifact')).toBeNull();
	});
});

// ============================================================================
// Methods, root, and redirects
// ============================================================================

test('POST, PUT, and DELETE get 405 with an Allow header', async () => {
	const { fetch } = setup();
	for (const method of ['POST', 'PUT', 'DELETE']) {
		const response = await fetch('/braden/foo', { method });
		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
	}
});

test('root serves the deploy-time home shell', async () => {
	const { fetch } = setup();
	const response = await fetch('/');
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('<home shell>');
});

test('HEAD on root returns the shell headers without a body', async () => {
	const { fetch } = setup();
	const response = await fetch('/', { method: 'HEAD' });
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('');
});

test('trailing slash 308-redirects to the slashless canonical URL', async () => {
	const { fetch, requestedKeys } = setup();
	const response = await fetch('/braden/foo/');
	expect(response.status).toBe(308);
	expect(response.headers.get('location')).toBe('https://theark.so/braden/foo');
	expect(requestedKeys).toEqual([]);
});

test('encoded traversal 404s without ever touching the bucket', async () => {
	// Plain `%2e%2e` is normalized away by the WHATWG URL parser before the
	// Worker runs; double encoding survives parsing and must die in the
	// allowlist, never as an R2 key.
	const { fetch, requestedKeys } = setup();
	const doubleEncoded = await fetch('/braden/%252e%252e/secrets');
	expect(doubleEncoded.status).toBe(404);
	const encodedSlash = await fetch('/braden%2f..%2fsecrets');
	expect(encodedSlash.status).toBe(404);
	expect(requestedKeys).toEqual([]);
});

// ============================================================================
// Projection reads
// ============================================================================

const PAGE_KEY = 'routes/braden/first-artifact/index.html';

test('published page serves with html content-type, etag, and delivery cache policy', async () => {
	const { fetch } = setup({
		[PAGE_KEY]: { data: '<article>frozen words</article>' },
	});
	const response = await fetch('/braden/first-artifact');
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('<article>frozen words</article>');
	expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
	expect(response.headers.get('etag')).toBe(`"etag-${PAGE_KEY}"`);
	expect(response.headers.get('cache-control')).toBe(
		'public, max-age=300, must-revalidate',
	);
	expect(response.headers.get('accept-ranges')).toBe('bytes');
});

test('query strings do not change the resolved object', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: 'page' } });
	const response = await fetch('/braden/first-artifact?utm_source=x');
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('page');
});

test('publisher-set cache-control is overwritten by the delivery policy', async () => {
	const { fetch } = setup({
		[PAGE_KEY]: {
			data: 'page',
			cacheControl: 'public, max-age=31536000, immutable',
		},
	});
	const response = await fetch('/braden/first-artifact');
	expect(response.headers.get('cache-control')).toBe(
		'public, max-age=300, must-revalidate',
	);
});

test('missing projection serves the not-found shell with no-store', async () => {
	const { fetch } = setup();
	const response = await fetch('/braden/unpublished');
	expect(response.status).toBe(404);
	expect(await response.text()).toBe('<not-found shell>');
	expect(response.headers.get('cache-control')).toBe('no-store');
});

test('HEAD on a missing projection has a 404 status and empty body', async () => {
	const { fetch } = setup();
	const response = await fetch('/braden/unpublished', { method: 'HEAD' });
	expect(response.status).toBe(404);
	expect(await response.text()).toBe('');
});

test('artifact output without stored content-type falls back to octet-stream', async () => {
	const key = `artifacts/${ARTIFACT_ID}/blob.bin`;
	const { fetch } = setup({ [key]: { data: 'binary' } });
	const response = await fetch(`/_artifacts/${ARTIFACT_ID}/blob.bin`);
	expect(response.headers.get('content-type')).toBe('application/octet-stream');
});

test('stored content-type wins over the fallback', async () => {
	const key = `artifacts/${ARTIFACT_ID}/cover.png`;
	const { fetch } = setup({
		[key]: { data: 'png-bytes', contentType: 'image/png' },
	});
	const response = await fetch(`/_artifacts/${ARTIFACT_ID}/cover.png`);
	expect(response.headers.get('content-type')).toBe('image/png');
});

test('HEAD on a projection reports size without a body', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: '0123456789' } });
	const response = await fetch('/braden/first-artifact', { method: 'HEAD' });
	expect(response.status).toBe(200);
	expect(response.headers.get('content-length')).toBe('10');
	expect(await response.text()).toBe('');
});

// ============================================================================
// Conditional and Range reads
// ============================================================================

test('matching If-None-Match returns 304 with the etag and no body', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: 'page' } });
	const response = await fetch('/braden/first-artifact', {
		headers: { 'if-none-match': `"etag-${PAGE_KEY}"` },
	});
	expect(response.status).toBe(304);
	expect(response.headers.get('etag')).toBe(`"etag-${PAGE_KEY}"`);
	expect(await response.text()).toBe('');
});

test('failing If-Match returns 412', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: 'page' } });
	const response = await fetch('/braden/first-artifact', {
		headers: { 'if-match': '"some-other-etag"' },
	});
	expect(response.status).toBe(412);
});

const VIDEO_KEY = `artifacts/${ARTIFACT_ID}/video.mp4`;

test('bounded range returns 206 with content-range and the exact slice', async () => {
	const { fetch } = setup({
		[VIDEO_KEY]: { data: '0123456789', contentType: 'video/mp4' },
	});
	const response = await fetch(`/_artifacts/${ARTIFACT_ID}/video.mp4`, {
		headers: { range: 'bytes=0-4' },
	});
	expect(response.status).toBe(206);
	expect(response.headers.get('content-range')).toBe('bytes 0-4/10');
	expect(response.headers.get('content-length')).toBe('5');
	expect(await response.text()).toBe('01234');
});

test('suffix range returns the final bytes', async () => {
	const { fetch } = setup({
		[VIDEO_KEY]: { data: '0123456789', contentType: 'video/mp4' },
	});
	const response = await fetch(`/_artifacts/${ARTIFACT_ID}/video.mp4`, {
		headers: { range: 'bytes=-3' },
	});
	expect(response.status).toBe(206);
	expect(response.headers.get('content-range')).toBe('bytes 7-9/10');
	expect(await response.text()).toBe('789');
});

test('unsatisfiable range returns 416', async () => {
	const { fetch } = setup({
		[VIDEO_KEY]: { data: '0123456789', contentType: 'video/mp4' },
	});
	const response = await fetch(`/_artifacts/${ARTIFACT_ID}/video.mp4`, {
		headers: { range: 'bytes=99-' },
	});
	expect(response.status).toBe(416);
	expect(response.headers.get('content-range')).toBe('bytes */10');
});
