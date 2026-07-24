import type {
	ExchangeRequest,
	ExchangeResponse,
} from '@epicenter/data/protocol';
import {
	parseExchangeRequest,
	parseQualifiedKey,
	parseRowId,
} from '@epicenter/data/protocol';
import {
	DOCUMENT_MAX_TRANSFER_BYTES,
	type DocumentAddress,
} from '@epicenter/document-sync';
import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import type {
	DocumentAppendOutcome,
	DocumentReadOutcome,
} from './document-store.js';

const MAX_SYNC_REQUEST_BYTES = 1_048_576;

export type AuthorityLocator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => (request: ExchangeRequest) => ExchangeResponse | Promise<ExchangeResponse>;

/** Create the authenticated scalar sync sub-app without mounting it. */
export function createEpicenterSyncApp<E extends Env = Env>(
	locateAuthority: AuthorityLocator<E>,
): Hono<E> {
	const app = new Hono<E>();
	return app.post('/api/sync/v1', async (c) => {
		try {
			const declaredLength = Number(c.req.raw.headers.get('content-length'));
			if (
				Number.isFinite(declaredLength) &&
				declaredLength > MAX_SYNC_REQUEST_BYTES
			) {
				return c.json({ error: 'request-too-large' } as const, 413);
			}
			const text = await c.req.raw.text();
			if (new TextEncoder().encode(text).byteLength > MAX_SYNC_REQUEST_BYTES) {
				return c.json({ error: 'request-too-large' } as const, 413);
			}
			const parsed = parseExchangeRequest(JSON.parse(text));
			if (parsed.error !== null) {
				return c.json({ error: 'invalid-request' } as const, 400);
			}
			return c.json(
				await locateAuthority(c.var.principal.id, c.env)(parsed.data),
			);
		} catch (cause) {
			if (cause instanceof SyntaxError || cause instanceof TypeError) {
				return c.json({ error: 'invalid-request' } as const, 400);
			}
			throw cause;
		}
	});
}

export type DocumentPublishDispatch<E extends Env = Env> = (
	principalId: PrincipalId,
	address: DocumentAddress,
	update: Uint8Array,
	env: E['Bindings'],
) => DocumentAppendOutcome | Promise<DocumentAppendOutcome>;

export type DocumentPullDispatch<E extends Env = Env> = (
	principalId: PrincipalId,
	address: DocumentAddress,
	sinceVersion: number | undefined,
	env: E['Bindings'],
) => DocumentReadOutcome | Promise<DocumentReadOutcome>;

function parseAddress(key: string, rowId: string): DocumentAddress | undefined {
	if (
		parseQualifiedKey(key).error !== null ||
		parseRowId(rowId).error !== null
	) {
		return undefined;
	}
	return { key, rowId };
}

function documentETag(version: number): string {
	return `"${version}"`;
}

function parseIfNoneMatch(header: string | undefined): number | undefined {
	const matched = header === undefined ? null : /^"(\d{1,15})"$/.exec(header);
	return matched === null ? undefined : Number(matched[1]);
}

/** Create the authenticated document publish and pull sub-app. */
export function createDocumentSyncApp<E extends Env = Env>({
	publish,
	pull,
}: {
	publish: DocumentPublishDispatch<E>;
	pull: DocumentPullDispatch<E>;
}): Hono<E> {
	const app = new Hono<E>();
	app.post('/api/sync/v1/documents/:key/:rowId', async (c) => {
		const address = parseAddress(c.req.param('key'), c.req.param('rowId'));
		if (address === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const declaredLength = Number(c.req.raw.headers.get('content-length'));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > DOCUMENT_MAX_TRANSFER_BYTES
		) {
			return c.json({ error: 'request-too-large' } as const, 413);
		}
		const body = new Uint8Array(await c.req.raw.arrayBuffer());
		if (body.byteLength === 0) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		if (body.byteLength > DOCUMENT_MAX_TRANSFER_BYTES) {
			return c.json({ error: 'request-too-large' } as const, 413);
		}
		const result = await publish(c.var.principal.id, address, body, c.env);
		if (result.outcome === 'invalid-update') {
			return c.json({ error: 'invalid-update' } as const, 400);
		}
		return c.json({ outcome: result.outcome } as const);
	});
	app.get('/api/sync/v1/documents/:key/:rowId', async (c) => {
		const address = parseAddress(c.req.param('key'), c.req.param('rowId'));
		if (address === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const sinceVersion = parseIfNoneMatch(c.req.header('if-none-match'));
		const result = await pull(c.var.principal.id, address, sinceVersion, c.env);
		if (result.kind === 'not-live') {
			return c.json({ error: 'not-live' } as const, 404);
		}
		const headers = { etag: documentETag(result.version) };
		if (result.kind === 'unchanged') {
			return c.body(null, 304, headers);
		}
		if (result.state === undefined) {
			return c.body(null, 204, headers);
		}
		return c.body(result.state.slice().buffer as ArrayBuffer, 200, {
			...headers,
			'content-type': 'application/octet-stream',
		});
	});
	return app;
}

/**
 * Mount the bearer-authenticated document synchronization ingress: POST
 * publishes one candidate into the authority acceptance operation, GET pulls
 * accepted state with a conditional version so unchanged documents transfer
 * no body (ADR-0174).
 */
export function mountDocumentSyncRoute<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		publish,
		pull,
	}: {
		auth: MiddlewareHandler<E>;
		publish: DocumentPublishDispatch<E>;
		pull: DocumentPullDispatch<E>;
	},
): void {
	app.use('/api/sync/v1/documents/:key/:rowId', auth);
	app.route('/', createDocumentSyncApp<E>({ publish, pull }));
}

/** Mount the bearer-authenticated scalar exchange. */
export function mountEpicenterSyncRoute<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		locateAuthority,
	}: {
		auth: MiddlewareHandler<E>;
		locateAuthority: AuthorityLocator<E>;
	},
): void {
	app.use('/api/sync/v1', auth);
	app.route('/', createEpicenterSyncApp<E>(locateAuthority));
}
