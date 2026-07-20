/**
 * The Ark public delivery plane.
 *
 * One responsibility: resolve a public URL to an immutable projection object
 * in R2 and stream it. The publishing side (the Vault) writes the objects;
 * a publication appears by writing R2 keys, never by redeploying this Worker.
 *
 * URL contract (the canonical artifact permalink is
 * `https://theark.so/braden/<artifact-slug>`):
 *
 *   /                              deploy-time home shell from static assets
 *   /<identity>[/<slug-or-facet>]  R2 `routes/<path>/index.html`
 *   /_artifacts/<uuid>/<file.ext>  R2 `artifacts/<uuid>/<file.ext>`
 *
 * A pretty segment is lowercase-hyphenated ([a-z0-9-]); a file segment adds
 * dot-separated extensions. Anything else is 404 before R2 is consulted, so
 * traversal or encoded surprises never become object keys. Trailing slashes
 * 308-redirect to the slashless canonical form.
 *
 * Only GET and HEAD exist. There is no write route, no auth, no API: the
 * bucket binding's write capability is deliberately unused (see the ADR).
 */

/**
 * One delivery-owned cache policy for every projection. Bytes at a key can be
 * regenerated (a theme rebuild rewrites disposable HTML, per the Vault's
 * ADR-0064), so nothing is `immutable`; a short shared TTL plus ETag
 * revalidation keeps rebuilds visible within minutes while edge caches absorb
 * repeat reads. The publisher owns content bytes and content-type; this
 * Worker owns delivery policy, so any publisher-set cache-control is
 * overwritten.
 */
const PROJECTION_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

const PRETTY_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_SEGMENT = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9]+)+$/;
const ARTIFACT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ResolvedProjection = {
	key: string;
	/** True when the URL is a page address served from a `.../index.html` object. */
	isPage: boolean;
};

/**
 * Map a slashless pathname to its R2 object key, or null when the path can
 * never name a projection. Human-readable routes and immutable artifact
 * outputs occupy disjoint namespaces: a route has one or two pretty
 * segments, while an output is addressed only through its UUIDv7 artifact
 * identity. Percent-encoded aliases are refused so every accepted pathname
 * is already its one canonical ASCII spelling.
 */
export function resolveProjection(pathname: string): ResolvedProjection | null {
	if (!pathname.startsWith('/') || pathname.includes('%')) return null;
	const segments = pathname.slice(1).split('/');

	if (
		segments.length === 3 &&
		segments[0] === '_artifacts' &&
		ARTIFACT_ID.test(segments[1] ?? '') &&
		FILE_SEGMENT.test(segments[2] ?? '')
	) {
		return {
			key: `artifacts/${segments[1]}/${segments[2]}`,
			isPage: false,
		};
	}

	if (
		(segments.length === 1 || segments.length === 2) &&
		segments.every((segment) => PRETTY_SEGMENT.test(segment))
	) {
		return {
			key: `routes/${segments.join('/')}/index.html`,
			isPage: true,
		};
	}

	return null;
}

function projectionHeaders(
	object: R2Object,
	{ isPage }: ResolvedProjection,
): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	if (!headers.has('content-type')) {
		headers.set(
			'content-type',
			isPage ? 'text/html; charset=utf-8' : 'application/octet-stream',
		);
	}
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', PROJECTION_CACHE_CONTROL);
	headers.set('accept-ranges', 'bytes');
	headers.set('x-content-type-options', 'nosniff');
	return headers;
}

/** Normalize R2's satisfied range shapes to an absolute offset and length. */
function resolveRange(
	range: R2Range,
	size: number,
): { offset: number; length: number } {
	if ('suffix' in range) {
		const length = Math.min(range.suffix, size);
		return { offset: size - length, length };
	}
	const offset = range.offset ?? 0;
	const length = Math.min(range.length ?? size - offset, size - offset);
	return { offset, length };
}

async function serveNotFound(request: Request, env: Env): Promise<Response> {
	const page = await env.ASSETS.fetch(new URL('/not-found.html', request.url));
	return new Response(request.method === 'HEAD' ? null : page.body, {
		status: 404,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// Never cache absence: the moment the publisher writes the object,
			// the address must start serving it.
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		},
	});
}

function isUnsatisfiableRange(error: unknown): boolean {
	return error instanceof Error && error.message.includes('(10039)');
}

export async function handleRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD' },
		});
	}

	const url = new URL(request.url);

	// The home shell is a deploy-time design asset, not a projection: before
	// any artifact exists, R2 is empty but the network root must still answer.
	if (url.pathname === '/') {
		return env.ASSETS.fetch(
			new Request(new URL('/home.html', url).toString(), {
				method: request.method,
			}),
		);
	}

	if (url.pathname.endsWith('/')) {
		const canonical = new URL(url);
		canonical.pathname = url.pathname.replace(/\/+$/, '') || '/';
		return Response.redirect(canonical.toString(), 308);
	}

	const projection = resolveProjection(url.pathname);
	if (!projection) return serveNotFound(request, env);

	if (request.method === 'HEAD') {
		const object = await env.PROJECTIONS.head(projection.key);
		if (!object) return serveNotFound(request, env);
		const headers = projectionHeaders(object, projection);
		headers.set('content-length', String(object.size));
		return new Response(null, { status: 200, headers });
	}

	let object: R2Object | R2ObjectBody | null;
	try {
		object = await env.PROJECTIONS.get(projection.key, {
			onlyIf: request.headers,
			range: request.headers,
		});
	} catch (error) {
		// R2 rejects a malformed or unsatisfiable Range instead of returning
		// null. Only its documented range error becomes 416; an unrelated R2
		// failure must remain a 5xx rather than being mislabeled as client input.
		if (request.headers.has('range') && isUnsatisfiableRange(error)) {
			const metadata = await env.PROJECTIONS.head(projection.key);
			const headers = new Headers({ 'accept-ranges': 'bytes' });
			if (metadata) {
				headers.set('content-range', `bytes */${metadata.size}`);
			}
			return new Response('Range Not Satisfiable', {
				status: 416,
				headers,
			});
		}
		throw error;
	}
	if (!object) return serveNotFound(request, env);

	const headers = projectionHeaders(object, projection);

	if (!('body' in object)) {
		// A precondition from `onlyIf` failed. Reads send If-None-Match or
		// If-Modified-Since (304); anything stricter is a 412.
		const wantsNotModified =
			request.headers.has('if-none-match') ||
			request.headers.has('if-modified-since');
		return new Response(null, {
			status: wantsNotModified ? 304 : 412,
			headers,
		});
	}

	if (object.range && request.headers.has('range')) {
		const { offset, length } = resolveRange(object.range, object.size);
		headers.set(
			'content-range',
			`bytes ${offset}-${offset + length - 1}/${object.size}`,
		);
		headers.set('content-length', String(length));
		return new Response(object.body, { status: 206, headers });
	}

	headers.set('content-length', String(object.size));
	return new Response(object.body, { status: 200, headers });
}

export default {
	fetch: handleRequest,
} satisfies ExportedHandler<Env>;
