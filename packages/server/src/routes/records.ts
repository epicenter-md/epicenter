import {
	type EnrollResponse,
	parseBaselineScanRequest,
	parseEnrollRequest,
	parseSyncRequest,
	requestRefusal,
	ROW_SYNC_ADMISSION_LIMITS,
} from '@epicenter/row-sync';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Records, RecordsPartition } from '../records/contracts.js';
import type { Env } from '../types.js';
import { RecordsError } from './records-errors.js';

/**
 * The deployment's complete capability-issuance strategy for one enrollment
 * (ADR-0137). The strategy receives the authority operation as an opaque
 * closure so a deployment can decide, register the admitted source, and only
 * then mint its durable replica receipt. `unavailable` means the deployment
 * could not safely complete issuance, so enrollment fails closed and
 * retryably. Synchronization never consults this seam. Shared server code
 * never learns plan ids, allowances, or billing concepts.
 */
export type IssueEnrollment<E extends Env = Env> = (
	c: Context<E>,
	partition: RecordsPartition,
	enroll: () => Promise<EnrollResponse>,
) => Promise<EnrollResponse | 'unavailable'>;

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
	issueEnrollment: IssueEnrollment<E> | undefined,
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

	return app
		.post(`${RECORDS_ROUTE}/enroll`, async (c) => {
			const parsed = await parseJson(c, parseEnrollRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			// Refuse a dead protocol before spending capability issuance work;
			// the authority would refuse identically (ADR-0131).
			const refusal = requestRefusal(parsed.value);
			if (refusal) return c.json({ result: refusal });
			try {
				const recordsPartition = partition(c);
				const enroll = () =>
					resolveRecords(c.env).enroll(recordsPartition, parsed.value);
				const response = issueEnrollment
					? await issueEnrollment(c, recordsPartition, enroll)
					: await enroll();
				if (response === 'unavailable') {
					const error = RecordsError.EnrollmentUnavailable();
					return c.json(error, error.error.status);
				}
				return c.json(response);
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
				return c.json(
					await resolveRecords(c.env).sync(partition(c), parsed.value),
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
		issueEnrollment,
	}: {
		auth: MiddlewareHandler<E>;
		resolveRecords: (env: E['Bindings']) => Records;
		/**
		 * Deployment capability issuance for enrollment (ADR-0137).
		 * Omitted for deployments without a storage allowance, like the
		 * self-hosted instance: enrollment then goes straight to its authority.
		 */
		issueEnrollment?: IssueEnrollment<E>;
	},
): void {
	app.use(`${RECORDS_PREFIX}/*`, auth);
	app.route('/', createRecordsApp(resolveRecords, issueEnrollment));
}
