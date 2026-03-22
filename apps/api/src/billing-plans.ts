/**
 * Single source of truth for billing IDs and plan metadata.
 * Runtime-safe (no atmn dependency). Both autumn.config.ts (CLI)
 * and runtime code (billing.tsx, ai-chat.ts) import from here.
 */

export const FEATURE_IDS = {
	aiUsage: 'ai_usage',
	aiCredits: 'ai_credits',
} as const;

export const PLAN_IDS = {
	free: 'free',
	pro: 'pro',
	max: 'max',
	creditTopUp: 'credit_top_up',
} as const;

/** Main plan IDs in display order. */
export const MAIN_PLAN_IDS = [PLAN_IDS.free, PLAN_IDS.pro, PLAN_IDS.max] as const;

export const PLANS = {
	[PLAN_IDS.free]: {
		name: 'Free',
		group: 'main',
		addOn: false,
		autoEnable: true,
		price: null,
		credits: { included: 50, reset: 'month' as const, overage: null },
	},
	[PLAN_IDS.pro]: {
		name: 'Pro',
		group: 'main',
		addOn: false,
		autoEnable: false,
		price: { amount: 20, interval: 'month' as const },
		credits: {
			included: 2000,
			reset: 'month' as const,
			overage: { amount: 1, billingUnits: 100, billingMethod: 'usage_based' as const },
		},
	},
	[PLAN_IDS.max]: {
		name: 'Max',
		group: 'main',
		addOn: false,
		autoEnable: false,
		price: { amount: 100, interval: 'month' as const },
		credits: {
			included: 15000,
			reset: 'month' as const,
			overage: { amount: 0.5, billingUnits: 100, billingMethod: 'usage_based' as const },
		},
	},
	[PLAN_IDS.creditTopUp]: {
		name: 'Credit Top-Up',
		group: '',
		addOn: true,
		autoEnable: false,
		price: null,
		credits: {
			included: 0,
			reset: null,
			overage: { amount: 5, billingUnits: 500, billingMethod: 'prepaid' as const },
		},
	},
} as const;
