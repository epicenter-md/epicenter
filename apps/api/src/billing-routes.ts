/**
 * Typed Hono routes for the billing dashboard SPA.
 *
 * All routes require authentication (authGuard applied in app.ts).
 * Data flows from Autumn's API—no custom tables needed.
 *
 * Response types are defined in billing-contract.ts (the shared contract).
 * The dashboard imports those same types for its typed fetch client.
 */

import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import type { Env } from './app';
import { createAutumn } from './autumn';
import type {
	AggregateResponse,
	AttachResponse,
	EventsListResponse,
	ModelsResponse,
	PlansListResponse,
	PortalResponse,
	PreviewResponse,
} from './billing-contract';
import { ANNUAL_PLANS, FEATURE_IDS, PLAN_IDS, PLANS } from './billing-plans';
import { MODEL_CREDITS } from './model-costs';

const billingRoutes = new Hono<Env>();

// Catch Autumn SDK errors and return proper HTTP status codes instead of 500.
billingRoutes.onError((err, c) => {
	const autumnErr = err as { statusCode?: number; body?: string };
	if (autumnErr.statusCode && autumnErr.body) {
		try {
			const body = JSON.parse(autumnErr.body);
			return c.json(body, autumnErr.statusCode as 400);
		} catch {
			return c.json({ message: autumnErr.body }, autumnErr.statusCode as 400);
		}
	}
	throw err;
});

// ── Balance + subscription info ──────────────────────────────────────────

/**
 * GET /billing/balance
 *
 * Returns customer balance, subscription status, and credit breakdown.
 * The `breakdown` array separates monthly vs rollover vs top-up credits.
 */
billingRoutes.get('/balance', async (c) => {
	const autumn = createAutumn(c.env);
	const customer = await autumn.customers.getOrCreate({
		customerId: c.var.user.id,
		name: c.var.user.name ?? undefined,
		email: c.var.user.email ?? undefined,
		expand: ['subscriptions.plan', 'balances.feature'],
	});
	return c.json(customer);
});

// ── Usage aggregation (powers charts) ────────────────────────────────────

const usageQuerySchema = type({
	'range?': "'24h' | '7d' | '30d' | '90d' | 'last_cycle' | undefined",
	'binSize?': "'hour' | 'day' | 'month' | undefined",
	'groupBy?': "'properties.model' | 'properties.provider' | undefined",
	'maxGroups?': 'number | undefined',
});

/**
 * POST /billing/usage
 *
 * Aggregates usage events by time period and optionally by model/provider.
 * Powers the usage chart in the dashboard Overview tab.
 *
 * @example
 * ```typescript
 * // 30-day usage grouped by model
 * const res = await client.billing.usage.$post({
 *   json: { range: '30d', binSize: 'day', groupBy: 'properties.model' }
 * });
 * ```
 */
billingRoutes.post(
	'/usage',
	sValidator('json', usageQuerySchema),
	async (c) => {
		const autumn = createAutumn(c.env);
		const data = c.req.valid('json');
		const result = await autumn.events.aggregate({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.aiUsage,
			...data,
		});
		return c.json(result);
	},
);

// ── Event history (powers activity feed) ─────────────────────────────────

const eventsQuerySchema = type({
	'limit?': 'number | undefined',
	'startingAfter?': 'string | undefined',
});

/**
 * POST /billing/events
 *
 * Lists individual usage events with timestamps, model, and credit cost.
 * Powers the Activity tab in the dashboard.
 */
billingRoutes.post(
	'/events',
	sValidator('json', eventsQuerySchema),
	async (c) => {
		const autumn = createAutumn(c.env);
		const data = c.req.valid('json');
		const result = await autumn.events.list({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.aiUsage,
			...data,
		});
		return c.json(result);
	},
);

// ── Plans list ───────────────────────────────────────────────────────────

/**
 * GET /billing/plans
 *
 * Returns all available plans with customer eligibility info.
 * Used by the plan comparison cards in the dashboard.
 */
billingRoutes.get('/plans', async (c) => {
	const autumn = createAutumn(c.env);
	const plans = await autumn.plans.list({ customerId: c.var.user.id });
	return c.json(plans);
});

// ── Model credits map ────────────────────────────────────────────────────

/**
 * GET /billing/models
 *
 * Returns the MODEL_CREDITS map as JSON plus plan metadata.
 * Powers the Model Cost Guide table in the dashboard.
 */
billingRoutes.get('/models', (c) => {
	return c.json({
		credits: MODEL_CREDITS,
		plans: PLANS,
		annualPlans: ANNUAL_PLANS,
	} satisfies ModelsResponse);
});

// ── Upgrade preview ──────────────────────────────────────────────────────

const planIdSchema = type({ planId: 'string' });

/**
 * POST /billing/preview
 *
 * Preview what a plan change will cost before committing.
 * Shows prorated amount for upgrades, or schedule info for downgrades.
 */
billingRoutes.post('/preview', sValidator('json', planIdSchema), async (c) => {
	const autumn = createAutumn(c.env);
	const { planId } = c.req.valid('json');
	const preview = await autumn.billing.previewAttach({
		customerId: c.var.user.id,
		planId,
	});
	return c.json(preview);
});

// ── Upgrade / attach plan ────────────────────────────────────────────────

const attachSchema = type({
	planId: 'string',
	'successUrl?': 'string | undefined',
});

/**
 * POST /billing/upgrade
 *
 * Attach a plan to the customer. For upgrades from Pro to Ultra/Max,
 * carries over unused credits via `carryOverBalances`.
 * Returns a `paymentUrl` for Stripe checkout if payment is required.
 */
billingRoutes.post('/upgrade', sValidator('json', attachSchema), async (c) => {
	const autumn = createAutumn(c.env);
	const { planId, successUrl } = c.req.valid('json');

	// Carry over credits when upgrading to Ultra/Max (plans with rollover).
	// NOTE: If a new rollover plan is added, update this set.
	const isRolloverPlan =
		planId === PLAN_IDS.ultra ||
		planId === PLAN_IDS.max ||
		planId === PLAN_IDS.ultraAnnual ||
		planId === PLAN_IDS.maxAnnual;

	const result = await autumn.billing.attach({
		customerId: c.var.user.id,
		planId,
		successUrl,
		...(isRolloverPlan && {
			carryOverBalances: {
				enabled: true,
				featureIds: [FEATURE_IDS.aiCredits],
			},
		}),
	});
	return c.json(result);
});

// ── Cancel subscription ──────────────────────────────────────────────────

/**
 * POST /billing/cancel
 *
 * Cancel a subscription at end of billing cycle.
 */
billingRoutes.post('/cancel', sValidator('json', planIdSchema), async (c) => {
	const autumn = createAutumn(c.env);
	const { planId } = c.req.valid('json');
	const result = await autumn.billing.update({
		customerId: c.var.user.id,
		planId,
		cancelAction: 'cancel_end_of_cycle',
	});
	return c.json(result);
});

// ── Uncancel ─────────────────────────────────────────────────────────────

/**
 * POST /billing/uncancel
 *
 * Reverse a pending cancellation.
 */
billingRoutes.post('/uncancel', sValidator('json', planIdSchema), async (c) => {
	const autumn = createAutumn(c.env);
	const { planId } = c.req.valid('json');
	const result = await autumn.billing.update({
		customerId: c.var.user.id,
		planId,
		cancelAction: 'uncancel',
	});
	return c.json(result);
});

// ── Top-up ───────────────────────────────────────────────────────────────

/**
 * POST /billing/top-up
 *
 * Purchase a credit top-up ($5 for 500 credits).
 */
billingRoutes.post(
	'/top-up',
	sValidator('json', type({ 'successUrl?': 'string | undefined' })),
	async (c) => {
		const autumn = createAutumn(c.env);
		const { successUrl } = c.req.valid('json');
		const result = await autumn.billing.attach({
			customerId: c.var.user.id,
			planId: PLAN_IDS.creditTopUp,
			successUrl,
		});
		return c.json(result);
	},
);

// ── Stripe portal ────────────────────────────────────────────────────────

/**
 * GET /billing/portal
 *
 * Redirect to Stripe customer portal for payment method management.
 */
billingRoutes.get('/portal', async (c) => {
	const autumn = createAutumn(c.env);
	const result = await autumn.billing.openCustomerPortal({
		customerId: c.var.user.id,
		returnUrl:
			c.req.query('returnUrl') ?? new URL('/dashboard', c.req.url).toString(),
	});
	return c.json(result);
});

// ── Billing controls (spend limits, alerts, auto top-ups) ────────────────

const controlsSchema = type({
	'spendLimits?': type({
		featureId: 'string',
		enabled: 'boolean',
		'overageLimit?': 'number | undefined',
	})
		.array()
		.or('undefined'),
	'usageAlerts?': type({
		featureId: 'string',
		threshold: 'number',
		thresholdType: "'usage' | 'usage_percentage'",
		enabled: 'boolean',
		'name?': 'string | undefined',
	})
		.array()
		.or('undefined'),
	'autoTopups?': type({
		featureId: 'string',
		enabled: 'boolean',
		threshold: 'number',
		quantity: 'number',
		'purchaseLimit?': type({
			interval: "'month'",
			intervalCount: 'number',
			limit: 'number',
		}).or('undefined'),
	})
		.array()
		.or('undefined'),
});

/**
 * POST /billing/controls
 *
 * Update per-user billing controls: spend limits, usage alerts, auto top-ups.
 * These are stored and evaluated by Autumn—no infrastructure on our side.
 */
billingRoutes.post(
	'/controls',
	sValidator('json', controlsSchema),
	async (c) => {
		const autumn = createAutumn(c.env);
		const data = c.req.valid('json');
		const result = await autumn.customers.update({
			customerId: c.var.user.id,
			billingControls: data,
		});
		return c.json(result);
	},
);

export { billingRoutes };
