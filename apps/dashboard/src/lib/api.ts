/**
 * Typed API client for the billing dashboard.
 *
 * Uses direct fetch with auth.fetch for Bearer tokens.
 * Same-origin deployment—no CORS config needed.
 *
 * Every method returns `Result<T, BillingApiError>` so consumers
 * destructure `{ data, error }` instead of try/catch.
 *
 * Response types come from the shared billing contract
 * (`@epicenter/api/billing-contract`), which the API routes also
 * satisfy. Neither side derives from the other—both derive from
 * the contract.
 *
 * @see docs/articles/shared-contract-over-derived-types.md
 */
import type {
	AggregateResponse,
	AttachResponse,
	CustomerResponse,
	EventsListResponse,
	EventsParams,
	ModelsResponse,
	PlansListResponse,
	PortalResponse,
	PreviewResponse,
	UsageParams,
} from '@epicenter/api/billing-contract';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import { auth } from './auth';

/**
 * Tagged error for the billing API boundary.
 *
 * Covers both network failures (fetch throws) and non-OK HTTP
 * responses (our status guard throws).
 */
export const BillingApiError = defineErrors({
	RequestFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Request to ${path} failed: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
});
export type BillingApiError = import('wellcrafted/error').InferErrors<
	typeof BillingApiError
>;

/** Fetch JSON from an API endpoint with auth. */
async function get<TResponse>(
	path: string,
): Promise<Result<TResponse, BillingApiError>> {
	return tryAsync({
		try: async () => {
			const res = await auth.fetch(path, { credentials: 'include' });
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return (await res.json()) as TResponse;
		},
		catch: (cause) => BillingApiError.RequestFailed({ path, cause }),
	});
}

/** POST JSON to an API endpoint with auth. */
async function post<TBody, TResponse>(
	path: string,
	body: TBody,
): Promise<Result<TResponse, BillingApiError>> {
	return tryAsync({
		try: async () => {
			const res = await auth.fetch(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				credentials: 'include',
			});
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return (await res.json()) as TResponse;
		},
		catch: (cause) => BillingApiError.RequestFailed({ path, cause }),
	});
}

export const api = {
	billing: {
		balance: () => get<CustomerResponse>('/api/billing/balance'),
		usage: (params: UsageParams) =>
			post<UsageParams, AggregateResponse>('/api/billing/usage', params),
		events: (params: EventsParams = {}) =>
			post<EventsParams, EventsListResponse>('/api/billing/events', params),
		plans: () => get<PlansListResponse>('/api/billing/plans'),
		models: () => get<ModelsResponse>('/api/billing/models'),
		preview: (planId: string) =>
			post<{ planId: string }, PreviewResponse>('/api/billing/preview', {
				planId,
			}),
		upgrade: (planId: string, successUrl?: string) =>
			post<{ planId: string; successUrl?: string }, AttachResponse>(
				'/api/billing/upgrade',
				{ planId, successUrl },
			),
		topUp: (successUrl?: string) =>
			post<{ successUrl?: string }, AttachResponse>('/api/billing/top-up', {
				successUrl,
			}),
		portal: () => get<PortalResponse>('/api/billing/portal'),
	},
};
