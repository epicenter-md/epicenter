import type { PrincipalId } from '@epicenter/identity';
import {
	currentStateRequestRefusal,
	parseAcquireRequest,
	parsePullRequest,
	parsePushRequest,
	ROW_SYNC_ADMISSION_LIMITS,
} from '@epicenter/row-sync';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type {
	AccountAuthorities,
	AccountAuthority,
} from '../records/current-state-contracts.js';
import type { Env } from '../types.js';
import { RecordsError } from './records-errors.js';

export type AdmitFirstContact<E extends Env = Env> = (
	c: Context<E>,
	input: {
		authority: AccountAuthority;
		principalId: PrincipalId;
		workspaceId: string;
	},
) => Promise<'allow' | 'refuse'>;

const WORKSPACES_PREFIX = '/api/workspaces';
const WORKSPACE_ROUTE = `${WORKSPACES_PREFIX}/:workspaceId` as const;
const RECORDS_ROUTE = `${WORKSPACE_ROUTE}/records` as const;
const MAX_RECORDS_REQUEST_BYTES = 1_048_576;

async function parseJson<TValue>(
	c: { req: { raw: Request } },
	parse: (value: unknown) => TValue,
): Promise<
	{ ok: true; value: TValue } | { ok: false; reason: 'invalid' | 'too-large' }
> {
	try {
		const declaredLength = Number(c.req.raw.headers.get('content-length'));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > MAX_RECORDS_REQUEST_BYTES
		) {
			return { ok: false, reason: 'too-large' };
		}
		const text = await c.req.raw.text();
		if (new TextEncoder().encode(text).byteLength > MAX_RECORDS_REQUEST_BYTES) {
			return { ok: false, reason: 'too-large' };
		}
		return { ok: true, value: parse(JSON.parse(text)) };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function invalidRequest<E extends Env>(
	c: Context<E>,
	reason: 'invalid' | 'too-large',
) {
	const error =
		reason === 'too-large'
			? RecordsError.RequestTooLarge()
			: RecordsError.InvalidRequest();
	return c.json(error, error.error.status);
}

function createCurrentStateRecordsApp<E extends Env>(
	resolveAuthorities: (env: E['Bindings']) => AccountAuthorities,
	admitFirstContact: AdmitFirstContact<E> | undefined,
): Hono<E> {
	const app = new Hono<E>();
	const requireBoundedWorkspaceId: MiddlewareHandler<E> = async (c, next) => {
		const workspaceId = c.req.param('workspaceId');
		if (
			!workspaceId ||
			new TextEncoder().encode(workspaceId).byteLength >
				ROW_SYNC_ADMISSION_LIMITS.identifierBytes
		) {
			return invalidRequest(c, 'invalid');
		}
		await next();
	};
	app.use(`${WORKSPACE_ROUTE}/*`, requireBoundedWorkspaceId);
	app.use(WORKSPACE_ROUTE, requireBoundedWorkspaceId);

	function refuseMismatchedProtocol<ERequest extends { protocolMajor: number }>(
		c: Context<E>,
		request: ERequest,
	) {
		const refusal = currentStateRequestRefusal(request);
		return refusal ? c.json({ result: refusal }) : undefined;
	}

	function selectAuthority(c: {
		env: E['Bindings'];
		var: Env['Variables'];
		req: { param(name: 'workspaceId'): string };
	}): {
		authority: AccountAuthority;
		principalId: PrincipalId;
		workspaceId: string;
	} {
		const principalId = c.var.principal.id;
		return {
			authority: resolveAuthorities(c.env).authority(principalId),
			principalId,
			workspaceId: c.req.param('workspaceId'),
		};
	}

	return app
		.post(`${RECORDS_ROUTE}/push`, async (c) => {
			const parsed = await parseJson(c, parsePushRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			const refusal = refuseMismatchedProtocol(c, parsed.value);
			if (refusal) return refusal;
			try {
				const selected = selectAuthority(c);
				if (
					!(await selected.authority.hasReplica(
						selected.workspaceId,
						parsed.value.replicaId,
					)) &&
					admitFirstContact &&
					(await admitFirstContact(c, selected)) === 'refuse'
				) {
					return c.json({ result: 'storage-limit' } as const);
				}
				return c.json(
					await selected.authority.push(selected.workspaceId, parsed.value),
				);
			} catch (cause) {
				if (cause instanceof TypeError) return invalidRequest(c, 'invalid');
				throw cause;
			}
		})
		.post(`${RECORDS_ROUTE}/pull`, async (c) => {
			const parsed = await parseJson(c, parsePullRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			const refusal = refuseMismatchedProtocol(c, parsed.value);
			if (refusal) return refusal;
			try {
				const selected = selectAuthority(c);
				return c.json(
					await selected.authority.pull(selected.workspaceId, parsed.value),
				);
			} catch (cause) {
				if (cause instanceof TypeError) return invalidRequest(c, 'invalid');
				throw cause;
			}
		})
		.post(`${RECORDS_ROUTE}/acquire`, async (c) => {
			const parsed = await parseJson(c, parseAcquireRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			const refusal = refuseMismatchedProtocol(c, parsed.value);
			if (refusal) return refusal;
			try {
				const selected = selectAuthority(c);
				return c.json(
					await selected.authority.acquire(selected.workspaceId, parsed.value),
				);
			} catch (cause) {
				if (cause instanceof TypeError) return invalidRequest(c, 'invalid');
				throw cause;
			}
		})
		// Workspace deletion is never refused (ADR-0145): it is a pure authority
		// transaction that shrinks the database and closes the workspace's document
		// sockets after commit. Account deletion is a separate operation because it
		// coordinates authority storage, R2, and authentication-owned records.
		.delete(WORKSPACE_ROUTE, async (c) => {
			const selected = selectAuthority(c);
			await selected.authority.deleteWorkspace(selected.workspaceId);
			return c.body(null, 204);
		});
}

/** Mount the authenticated current-state logical-record authority. */
export function mountCurrentStateRecordsApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveAuthorities,
		admitFirstContact,
	}: {
		auth: MiddlewareHandler<E>;
		resolveAuthorities: (env: E['Bindings']) => AccountAuthorities;
		admitFirstContact?: AdmitFirstContact<E>;
	},
): void {
	app.use(`${WORKSPACES_PREFIX}/*`, auth);
	app.route(
		'/',
		createCurrentStateRecordsApp(resolveAuthorities, admitFirstContact),
	);
}
