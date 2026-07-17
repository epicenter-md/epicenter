import {
	parseBaselineScanRequest,
	parseEnrollRequest,
	parseSyncRequest,
	ROW_SYNC_ADMISSION_LIMITS,
	roundRequestsGrowth,
} from '@epicenter/row-sync';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type {
	Records,
	RecordsPartition,
	ResolveGrowth,
} from '../records/contracts.js';
import type { Env } from '../types.js';
import { RecordsError } from './records-errors.js';

const RECORDS_PREFIX = '/api/records';
const RECORDS_ROUTE = `${RECORDS_PREFIX}/:workspaceId` as const;
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

function createRecordsApp<E extends Env>(
	resolveRecords: (env: E['Bindings']) => Records,
	resolveGrowth: ResolveGrowth | undefined,
): Hono<E> {
	const app = new Hono<E>();
	app.use(`${RECORDS_ROUTE}/*`, async (c, next) => {
		const workspaceId = c.req.param('workspaceId');
		if (
			workspaceId.length === 0 ||
			new TextEncoder().encode(workspaceId).byteLength >
				ROW_SYNC_ADMISSION_LIMITS.identifierBytes
		) {
			return invalidRequest(c, 'invalid');
		}
		await next();
	});

	function partition(c: {
		var: Env['Variables'];
		req: { param(name: 'workspaceId'): string };
	}): RecordsPartition {
		return {
			principalId: c.var.principal.id,
			workspaceId: c.req.param('workspaceId'),
		};
	}

	function growthUnavailable<TContext extends Context<E>>(c: TContext) {
		const error = RecordsError.GrowthUnavailable();
		return c.json(error, error.error.status);
	}

	return app
		.post(`${RECORDS_ROUTE}/enroll`, async (c) => {
			const parsed = await parseJson(c, parseEnrollRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			try {
				// Enrollment creates a durable receipt, so it is growth
				// (ADR-0137): an unavailable decision fails it closed.
				const growth = await resolveGrowth?.(partition(c));
				if (growth === 'unavailable') return growthUnavailable(c);
				return c.json(
					await resolveRecords(c.env).enroll(
						partition(c),
						parsed.value,
						growth === undefined ? undefined : { growth },
					),
				);
			} catch (cause) {
				if (cause instanceof TypeError) return invalidRequest(c, 'invalid');
				throw cause;
			}
		})
		.post(`${RECORDS_ROUTE}/sync`, async (c) => {
			const parsed = await parseJson(c, parseSyncRequest);
			if (!parsed.ok) {
				return invalidRequest(c, parsed.reason);
			}
			try {
				const wantsGrowth =
					parsed.value.sealedRound !== undefined &&
					roundRequestsGrowth(parsed.value.sealedRound.intents);
				let growth = await resolveGrowth?.(partition(c));
				if (growth === 'unavailable') {
					// Only growth fails closed and retryably; pulls and
					// all-delete rounds proceed under delete-only admission.
					if (wantsGrowth) return growthUnavailable(c);
					growth = 'delete-only';
				}
				return c.json(
					await resolveRecords(c.env).sync(
						partition(c),
						parsed.value,
						growth === undefined ? undefined : { growth },
					),
				);
			} catch (cause) {
				// The authority throws TypeError for client-authored corruption
				// (a digest that does not match its intents, a checkpoint ahead
				// of the head); those are invalid requests, not server faults.
				if (cause instanceof TypeError) return invalidRequest(c, 'invalid');
				throw cause;
			}
		})
		.post(`${RECORDS_ROUTE}/baseline-scan`, async (c) => {
			const parsed = await parseJson(c, parseBaselineScanRequest);
			if (!parsed.ok) {
				return invalidRequest(c, parsed.reason);
			}
			try {
				return c.json(
					await resolveRecords(c.env).baselineScan(partition(c), parsed.value),
				);
			} catch (cause) {
				if (cause instanceof TypeError) return invalidRequest(c, 'invalid');
				throw cause;
			}
		});
}

/** Mount the authenticated logical-record authority HTTP surface. */
export function mountRecordsApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveRecords,
		resolveGrowth,
	}: {
		auth: MiddlewareHandler<E>;
		resolveRecords: (env: E['Bindings']) => Records;
		/**
		 * Deployment capacity admission (ADR-0137). Omitted for deployments
		 * without a storage policy, like the self-hosted instance: every
		 * exchange then runs with the authority's policy-free default.
		 */
		resolveGrowth?: ResolveGrowth;
	},
): void {
	app.use(`${RECORDS_PREFIX}/*`, auth);
	app.route('/', createRecordsApp(resolveRecords, resolveGrowth));
}
