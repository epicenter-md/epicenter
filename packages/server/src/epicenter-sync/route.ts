import type {
	ExchangeRequest,
	ExchangeResponse,
} from '@epicenter/data/protocol';
import { parseExchangeRequest } from '@epicenter/data/protocol';
import type { PrincipalId } from '@epicenter/identity';
import { type Context, Hono, type MiddlewareHandler } from 'hono';

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { verifyDocumentUpgrade } from './document-server.js';

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

/** Resolve a document bearer with the deployment's existing upgrade-time policy. */
export async function resolveEpicenterDocumentUpgrade<E extends Env>(
	c: Context<E>,
	resolveDocumentPrincipal: ResolveDocumentPrincipal<E>,
) {
	let authorization:
		| {
				principalId: PrincipalId;
				authorizationExpiresAt: number;
		  }
		| undefined;
	const verified = await verifyDocumentUpgrade({
		request: c.req.raw,
		resolveBearer: async (bearer) => {
			const resolution = await resolveDocumentPrincipal(c, bearer);
			if (resolution.error !== null) return undefined;
			authorization = {
				principalId: resolution.data.principal.id,
				authorizationExpiresAt: resolution.data.authorizationExpiresAt,
			};
			return authorization.principalId;
		},
	});
	return verified.error === null && authorization !== undefined
		? { ...authorization, address: verified.data.address }
		: undefined;
}
