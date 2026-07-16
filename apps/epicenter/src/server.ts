/**
 * The Bun-owned Epicenter origin: trusted SPA documents, Query APIs, and the
 * Query session WebSocket. The launch credential can only mint short-lived
 * browser sessions at the bootstrap route; it never appears in a URL or
 * durable browser storage.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { createBunRooms } from '@epicenter/server/bun';
import { MAIN_SUBPROTOCOL, parseSubprotocols } from '@epicenter/sync';
import type { AgentToolDefinition } from '@epicenter/workspace/agent';
import type { DesktopWorkspaceOwner } from '@epicenter/workspace/sqlite/desktop-owner';
import { DesktopWorkspaceError } from '@epicenter/workspace/sqlite/desktop-owner';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import { Ok } from 'wellcrafted/result';
import {
	parseQueryCommand,
	type QueryHost,
	type QuerySessionSnapshot,
} from './host.ts';
import {
	BOOTSTRAP_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	SURFACE_ROUTES,
	type SurfaceId,
} from './routes.ts';
import type { EpicenterStaticAssets } from './static-assets.ts';
import { PLACEHOLDER_SURFACE_PAGES } from './surface-pages.ts';

export type QueryServerEvent = {
	type: 'snapshot';
	snapshot: QuerySessionSnapshot;
};

export type QuerySessionResponse = {
	tools: AgentToolDefinition[];
	snapshot: QuerySessionSnapshot;
};

export type QueryServerOptions = {
	host: QueryHost;
	/** Exact active origin, including the Rust-selected explicit port. */
	origin: string;
	/** Per-launch credential received from Rust over stdin. */
	launchToken: string;
	/** Release-built documents and the contained Whispering asset resolver. */
	staticAssets: EpicenterStaticAssets;
	workspaceOwner?: DesktopWorkspaceOwner;
	rooms?: ReturnType<typeof createBunRooms>;
};

const SESSION_COOKIE = 'epicenter_session';
const MAX_BROWSER_SESSIONS = 32;

export function createQueryServer({
	host,
	origin,
	launchToken,
	staticAssets,
	workspaceOwner,
	rooms,
}: QueryServerOptions) {
	if (launchToken === '') {
		throw new Error('Epicenter refuses to serve without a launch token.');
	}
	const activeUrl = validateOrigin(origin);
	const activeHost = activeUrl.host;
	const sessionHashes = new Set<string>();
	const surfacePages = {
		query: staticAssets.queryPage,
		whispering: staticAssets.whisperingPage,
		...PLACEHOLDER_SURFACE_PAGES,
	} satisfies Record<SurfaceId, string>;
	const csp = contentSecurityPolicy(Object.values(surfacePages).join('\n'));
	const { upgradeWebSocket, websocket } = createBunWebSocket();
	const app = new Hono();

	app.use('*', async (c, next) => {
		if (c.req.header('host') !== activeHost) {
			return c.text('Misdirected Request', 421);
		}
		const requestOrigin = c.req.header('origin');
		if (requestOrigin !== undefined && requestOrigin !== origin) {
			return c.text('Forbidden', 403);
		}

		c.header('content-security-policy', csp);
		c.header('referrer-policy', 'no-referrer');
		c.header('x-content-type-options', 'nosniff');
		c.header('x-frame-options', 'DENY');
		await next();
	});

	app.post(BOOTSTRAP_ROUTE.pattern, (c) => {
		if (c.req.header('origin') !== origin) return c.text('Forbidden', 403);
		const header = c.req.header('authorization');
		const candidate = header?.startsWith('Bearer ')
			? header.slice('Bearer '.length)
			: undefined;
		if (candidate === undefined || !tokensMatch(candidate, launchToken)) {
			return c.text('Unauthorized', 401);
		}

		const session = randomBytes(32).toString('base64url');
		sessionHashes.add(tokenHash(session));
		while (sessionHashes.size > MAX_BROWSER_SESSIONS) {
			const oldest = sessionHashes.values().next().value;
			if (oldest === undefined) break;
			sessionHashes.delete(oldest);
		}
		setCookie(c, SESSION_COOKIE, session, {
			httpOnly: true,
			path: '/',
			sameSite: 'Strict',
		});
		return c.body(null, 204);
	});

	for (const surface of [
		SURFACE_ROUTES.query,
		SURFACE_ROUTES.mail,
		SURFACE_ROUTES.books,
	]) {
		app.get(surface.pattern, (c) => {
			c.header('cache-control', 'no-store');
			return c.html(surfacePages[surface.id]);
		});
	}
	app.get('/apps/whispering/*', async (c) => {
		const asset = await staticAssets.resolveWhispering(
			new URL(c.req.url).pathname,
		);
		if (!asset) return c.text('Not Found', 404);
		c.header('cache-control', 'no-store');
		c.header('content-type', asset.contentType);
		return c.body(asset.file.stream());
	});
	app.get('/apps/*', (c) => c.text('Not Found', 404));

	const requireSession = async (
		c: Parameters<Parameters<typeof app.use>[1]>[0],
		next: () => Promise<void>,
	) => {
		const session = getCookie(c, SESSION_COOKIE);
		if (session === undefined || !sessionHashes.has(tokenHash(session))) {
			return c.text('Unauthorized', 401);
		}
		await next();
	};
	app.use('/api/query/*', requireSession);
	app.use('/api/workspaces/*', requireSession);
	app.use('/api/rooms/*', requireSession);
	app.use(SESSION_STREAM_ROUTE.pattern, async (c, next) => {
		if (c.req.header('origin') !== origin) return c.text('Forbidden', 403);
		await next();
	});

	app.get(SESSION_ROUTE.pattern, (c) =>
		c.json({
			tools: host.toolDefinitions(),
			snapshot: host.snapshot(),
		} satisfies QuerySessionResponse),
	);

	app.post('/api/workspaces/:workspaceId/records', async (c) => {
		if (!workspaceOwner)
			return c.json(DesktopWorkspaceError.OwnerUnavailable(), 404);
		const workspaceId = c.req.param('workspaceId');
		if (!workspaceOwner.hasWorkspace(workspaceId)) {
			return c.json(
				DesktopWorkspaceError.UnknownWorkspace({ workspaceId }),
				404,
			);
		}
		try {
			return c.json(
				Ok(await workspaceOwner.execute(workspaceId, await c.req.json())),
			);
		} catch (cause) {
			return c.json(DesktopWorkspaceError.InvalidRequest({ cause }), 400);
		}
	});

	app.post(
		'/api/workspaces/:workspaceId/documents/:declaration/open',
		async (c) => {
			if (!workspaceOwner)
				return c.json(DesktopWorkspaceError.OwnerUnavailable(), 404);
			const workspaceId = c.req.param('workspaceId');
			if (!workspaceOwner.hasWorkspace(workspaceId)) {
				return c.json(
					DesktopWorkspaceError.UnknownWorkspace({ workspaceId }),
					404,
				);
			}
			try {
				const body = (await c.req.json()) as { params?: unknown };
				if (!isPlainObject(body.params)) {
					throw new TypeError('Document params must be a plain object');
				}
				return c.json(
					Ok(
						workspaceOwner.authorizeDocument(
							workspaceId,
							c.req.param('declaration'),
							body.params,
						),
					),
				);
			} catch (cause) {
				return c.json(DesktopWorkspaceError.InvalidRequest({ cause }), 400);
			}
		},
	);

	app.get('/api/rooms/:roomId', async (c) => {
		if (!workspaceOwner || !rooms) return c.text('Not Found', 404);
		const roomId = c.req.param('roomId');
		if (!workspaceOwner.isDocumentAuthorized(roomId)) {
			return c.text('Unknown room', 404);
		}
		const nodeId = c.req.query('nodeId');
		if (!nodeId) return c.text('Missing nodeId', 400);
		const offered = parseSubprotocols(
			c.req.header('sec-websocket-protocol') ?? null,
		);
		if (!offered.includes(MAIN_SUBPROTOCOL)) {
			return c.text(`Expected ${MAIN_SUBPROTOCOL} subprotocol`, 400);
		}
		return rooms.rooms.get(roomId).handleUpgrade({
			request: c.req.raw,
			principalId: 'instance' as never,
			nodeId,
		});
	});

	app.get(
		SESSION_STREAM_ROUTE.pattern,
		upgradeWebSocket(() => {
			let unsubscribe: (() => void) | undefined;
			const push = (ws: { send(data: string): void }) => {
				const event: QueryServerEvent = {
					type: 'snapshot',
					snapshot: host.snapshot(),
				};
				ws.send(JSON.stringify(event));
			};
			return {
				onOpen(_event, ws) {
					unsubscribe = host.subscribe(() => push(ws));
					push(ws);
				},
				onMessage(event, ws) {
					const command = parseQueryCommand(parseFrame(event.data));
					if (!command) return;
					host.handleCommand(command);
					push(ws);
				},
				onClose() {
					unsubscribe?.();
				},
			};
		}),
	);

	const ownedWebsocket = rooms
		? mergeDesktopWebSocketHandlers(websocket, rooms.websocket)
		: (websocket as unknown as WebSocketHandler<unknown>);
	return {
		app,
		websocket: ownedWebsocket,
		bindServer: rooms?.bindServer ?? (() => undefined),
	};
}

function mergeDesktopWebSocketHandlers(
	queryInput: unknown,
	roomsInput: unknown,
): WebSocketHandler<unknown> {
	const query = queryInput as WebSocketHandler<unknown>;
	const rooms = roomsInput as WebSocketHandler<unknown>;
	const pick = (ws: ServerWebSocket<unknown>): WebSocketHandler<unknown> =>
		isPlainObject(ws.data) && ws.data.surface === 'rooms' ? rooms : query;
	return {
		open(ws) {
			pick(ws).open?.(ws);
		},
		message(ws, message) {
			pick(ws).message?.(ws, message);
		},
		close(ws, code, reason) {
			pick(ws).close?.(ws, code, reason);
		},
		drain(ws) {
			pick(ws).drain?.(ws);
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOrigin(origin: string): URL {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`Invalid Epicenter origin: ${origin}`);
	}
	if (
		url.origin !== origin ||
		url.protocol !== 'http:' ||
		url.hostname !== '127.0.0.1' ||
		url.port === '' ||
		url.username !== '' ||
		url.password !== ''
	) {
		throw new Error(
			'Epicenter origin must be exact http://127.0.0.1:<port> without credentials or a path.',
		);
	}
	return url;
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

function tokensMatch(candidate: string, expected: string): boolean {
	const a = createHash('sha256').update(candidate).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

function contentSecurityPolicy(page: string): string {
	const scriptHashes = [
		...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
	]
		.map((match) => match[1] ?? '')
		.map(
			(script) =>
				`'sha256-${createHash('sha256').update(script).digest('base64')}'`,
		);
	return [
		"default-src 'self'",
		`script-src 'self' ${scriptHashes.join(' ')}`,
		"style-src 'self' 'unsafe-inline'",
		"connect-src 'self' ipc: http://ipc.localhost",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
	].join('; ');
}

function parseFrame(data: unknown): unknown {
	if (typeof data !== 'string') return undefined;
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}
