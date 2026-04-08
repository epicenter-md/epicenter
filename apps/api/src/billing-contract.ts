/**
 * Billing route contract—the shared type boundary between server and client.
 *
 * This file is the "C" that defines both "A" and "B":
 * - The API routes (A) satisfy these types when returning responses
 * - The dashboard client (B) consumes these types for typed fetch calls
 * - Neither derives from the other; both derive from this contract
 *
 * Response types are derived from the Autumn SDK via `Awaited<ReturnType<...>>`
 * so they stay in sync with the SDK automatically. Request types that the
 * dashboard needs (params for POST bodies) are defined explicitly since
 * the SDK's param types include server-only fields (customerId, featureId)
 * that the dashboard never sends.
 *
 * This file imports `autumn-js` for type derivation only—zero runtime cost.
 * The dashboard imports from `@epicenter/api/billing-contract` and never
 * touches autumn-js directly.
 *
 * @see docs/articles/shared-contract-over-derived-types.md
 */

import type { Autumn } from 'autumn-js';

// ── Derived response types (from Autumn SDK method signatures) ───────

/** Response from `autumn.customers.getOrCreate()` with expand. */
export type CustomerResponse = Awaited<
	ReturnType<Autumn['customers']['getOrCreate']>
>;

/** Response from `autumn.events.aggregate()`. */
export type AggregateResponse = Awaited<
	ReturnType<Autumn['events']['aggregate']>
>;

/** Response from `autumn.events.list()`. */
export type EventsListResponse = Awaited<ReturnType<Autumn['events']['list']>>;

/** Response from `autumn.plans.list()`. */
export type PlansListResponse = Awaited<ReturnType<Autumn['plans']['list']>>;

/** Response from `autumn.billing.attach()`. */
export type AttachResponse = Awaited<ReturnType<Autumn['billing']['attach']>>;

/** Response from `autumn.billing.previewAttach()`. */
export type PreviewResponse = Awaited<
	ReturnType<Autumn['billing']['previewAttach']>
>;

/** Response from `autumn.billing.openCustomerPortal()`. */
export type PortalResponse = Awaited<
	ReturnType<Autumn['billing']['openCustomerPortal']>
>;

// ── Dashboard request types (subset of SDK params, no server fields) ─

/**
 * Params the dashboard sends for usage aggregation.
 * Server adds customerId and featureId before forwarding to Autumn.
 */
export type UsageParams = {
	range?: '24h' | '7d' | '30d' | '90d' | 'last_cycle';
	binSize?: 'hour' | 'day' | 'month';
	groupBy?: 'properties.model' | 'properties.provider';
	maxGroups?: number;
};

/** Params the dashboard sends for event listing. */
export type EventsParams = {
	limit?: number;
	startingAfter?: string;
};

// ── Custom response types (our code, not Autumn) ─────────────────────

/**
 * Response from GET /api/billing/models.
 * This endpoint returns our own data (MODEL_CREDITS + plan metadata),
 * not an Autumn API response.
 */
export type ModelsResponse = {
	credits: Record<string, number>;
	plans: Record<string, unknown>;
	annualPlans: Record<string, unknown>;
};
