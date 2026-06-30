/**
 * `local-books daemon --http-port <port>`: serve the books MCP tools over a
 * private HTTP `/mcp` endpoint, so the user's other devices can reach them
 * directly across their tailnet (ADR-0079, the capability plane).
 *
 * This is the SAME airlock as `local-books mcp`, on a different transport. The
 * server definition, the tool table, the read-only gate, and the two error
 * channels all come from `buildBooksServer`; this file adds only HTTP framing:
 * a stateless Streamable HTTP transport and a CORS layer.
 *
 * Transport is intentionally minimal. There is NO bearer, NO session, NO box
 * identity: the box is exposed via `tailscale serve` (private HTTPS, tailnet
 * only), and the Tailscale ACLs are the network authz (ADR-0079). The data
 * never leaves the box; an MCP `query` runs read-only SQL against the local
 * SQLite exactly as the stdio verb does. No `@epicenter/workspace`, no relay,
 * no mesh, so `bun build --compile` stays one binary.
 *
 * Stateless mode is load-bearing: the Web-Standard transport is single-use (it
 * throws "cannot be reused across requests"), so a FRESH transport and a FRESH
 * server are built per request. There is no `Mcp-Session-Id`, and GET/DELETE on
 * `/mcp` answer 405; POST returns its JSON or SSE stream.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ParsedArgs } from '../cli.ts';
import { loadConfig } from '../config.ts';
import {
	type BooksServerDeps,
	buildBooksServer,
	createBooksServerDeps,
} from './mcp-server.ts';

/**
 * The headers a browser needs to reach `/mcp`. The MCP client sends
 * `mcp-protocol-version` (and `mcp-session-id` in stateful mode, unused here),
 * so the preflight must bless these.
 *
 * CORS here FAILS CLOSED, and that is load-bearing, not paranoia. The box has
 * no auth in V0 (the tailnet ACL gates the NETWORK, not the user's own
 * browser), so a browser read grant is the only thing standing between any
 * website a tailnet device visits and that site reading the books cross-origin
 * (a classic confused-deputy: the site's `fetch` reaches the box because the
 * device is on the tailnet, and a permissive `Access-Control-Allow-Origin`
 * would let the site read the `query` response). So a browser is granted a read
 * ONLY when its origin is explicitly allowlisted (`LOCAL_BOOKS_CORS_ORIGIN`).
 * An empty allowlist grants no browser anything; native MCP clients (Claude
 * Code, a desktop app's native HTTP client) do not speak CORS and are
 * unaffected.
 */
function corsHeaders(requestOrigin: string | null, allow: string[]): Headers {
	const headers = new Headers({
		'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
		'access-control-allow-headers':
			'content-type, mcp-session-id, mcp-protocol-version, last-event-id, authorization',
		'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
		'access-control-max-age': '86400',
	});
	const origin =
		requestOrigin && allow.includes(requestOrigin) ? requestOrigin : null;
	if (origin !== null) headers.set('access-control-allow-origin', origin);
	return headers;
}

/** Merge CORS headers onto a transport Response without consuming its (possibly streaming) body. */
function withCors(response: Response, cors: Headers): Response {
	const headers = new Headers(response.headers);
	cors.forEach((value, key) => headers.set(key, value));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * The daemon's `fetch` handler. Pure of process concerns (no `Bun.serve`, no
 * logging), so a test drives it with plain `Request`s. Routes only `/mcp`;
 * everything else is an honest 404 ("reachable, MCP not served").
 */
export function createDaemonFetch(
	deps: BooksServerDeps,
	options: { corsOrigins?: string[] } = {},
): (request: Request) => Promise<Response> {
	const allow = options.corsOrigins ?? [];
	return async (request) => {
		const cors = corsHeaders(request.headers.get('origin'), allow);

		// Preflight: answer the browser before it sends the real request.
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		const { pathname } = new URL(request.url);
		if (pathname !== '/mcp') {
			return withCors(
				new Response('Not found. The books MCP endpoint is /mcp.', {
					status: 404,
				}),
				cors,
			);
		}

		// Stateless: a single-use transport and a single-use server per request
		// (the transport throws on reuse). `enableJsonResponse` makes the tool
		// reply a single buffered JSON body instead of an SSE stream, so the
		// per-request server and transport can be torn down as soon as the body is
		// produced, with no long-lived stream to leak on an always-on box.
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		const server = buildBooksServer(deps);
		await server.connect(transport);
		try {
			const response = await transport.handleRequest(request);
			return withCors(response, cors);
		} finally {
			await transport.close();
			await server.close();
		}
	};
}

/**
 * Parse the comma-separated `LOCAL_BOOKS_CORS_ORIGIN` allowlist. Unset or empty
 * means no browser is granted a cross-origin read (native MCP clients still
 * work); set means exactly these web origins may read the box from a browser.
 */
function readCorsAllowlist(): string[] {
	return (process.env.LOCAL_BOOKS_CORS_ORIGIN ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export async function runDaemon(args: ParsedArgs): Promise<number> {
	if (args.httpPort === undefined) {
		console.error('daemon: --http-port <port> is required.');
		return 1;
	}

	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});
	const deps = createBooksServerDeps(config);
	const fetch = createDaemonFetch(deps, { corsOrigins: readCorsAllowlist() });

	const server = Bun.serve({ port: args.httpPort, fetch });
	const readOnly = config.readOnly ? ' (read-only)' : '';
	console.log(
		`local-books daemon listening on http://localhost:${server.port}/mcp${readOnly}`,
	);
	console.log(
		'Expose it to your other devices with: tailscale serve --bg --https=443 ' +
			`http://localhost:${server.port}`,
	);

	// Block until a termination signal; stop the listener, then exit cleanly.
	await new Promise<void>((resolve) => {
		const stop = () => resolve();
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	});
	server.stop();
	return 0;
}
