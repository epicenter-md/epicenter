import { feature, item, plan } from 'atmn';
import {
	ANNUAL_PLANS,
	FEATURE_IDS,
	PLAN_IDS,
	PLANS,
} from './src/billing-plans';

/** Asserts a value is non-null at runtime. Used for plan fields that are null on some tiers. */
function defined<T>(value: T): NonNullable<T> {
	if (value == null)
		throw new Error('Expected defined value in billing plan config');
	return value as NonNullable<T>;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export const aiUsage = feature({
	id: FEATURE_IDS.aiUsage,
	name: 'AI Usage',
	type: 'metered',
	consumable: true,
});

export const aiCredits = feature({
	id: FEATURE_IDS.aiCredits,
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [{ meteredFeatureId: aiUsage.id, creditCost: 1 }],
});

export const storageBytes = feature({
	id: FEATURE_IDS.storageBytes,
	name: 'Storage',
	type: 'metered',
	consumable: false,
});

// ---------------------------------------------------------------------------
// Plans — Monthly
// ---------------------------------------------------------------------------

const f = PLANS[PLAN_IDS.free];
export const free = plan({
	id: PLAN_IDS.free,
	name: f.name,
	group: f.group,
	autoEnable: f.autoEnable,
	items: [
		item({
			featureId: aiCredits.id,
			included: f.credits.included,
			reset: { interval: f.credits.reset },
		}),
		item({ featureId: storageBytes.id, included: 0 }),
	],
});

const p = PLANS[PLAN_IDS.pro];
export const pro = plan({
	id: PLAN_IDS.pro,
	name: p.name,
	group: p.group,
	price: defined(p.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: p.credits.included,
			price: {
				amount: p.credits.overage.amount,
				billingUnits: p.credits.overage.billingUnits,
				billingMethod: p.credits.overage.billingMethod,
				interval: p.credits.reset,
			},
		}),
		item({
			featureId: storageBytes.id,
			included: 5_000_000_000,
			price: {
				amount: 1,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: p.credits.reset,
			},
		}),
	],
});

const u = PLANS[PLAN_IDS.ultra];
export const ultra = plan({
	id: PLAN_IDS.ultra,
	name: u.name,
	group: u.group,
	price: defined(u.price),
	freeTrial: { durationLength: 14, durationType: 'day', cardRequired: false },
	autoEnable: true,
	items: [
		item({
			featureId: aiCredits.id,
			included: u.credits.included,
			price: {
				amount: u.credits.overage.amount,
				billingUnits: u.credits.overage.billingUnits,
				billingMethod: u.credits.overage.billingMethod,
				interval: u.credits.reset,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 10_000_000_000,
			price: {
				amount: 0.75,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: u.credits.reset,
			},
		}),
	],
});

const m = PLANS[PLAN_IDS.max];
export const max = plan({
	id: PLAN_IDS.max,
	name: m.name,
	group: m.group,
	price: defined(m.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: m.credits.included,
			price: {
				amount: m.credits.overage.amount,
				billingUnits: m.credits.overage.billingUnits,
				billingMethod: m.credits.overage.billingMethod,
				interval: m.credits.reset,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 50_000_000_000,
			price: {
				amount: 0.5,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: m.credits.reset,
			},
		}),
	],
});

const t = PLANS[PLAN_IDS.creditTopUp];
export const creditTopUp = plan({
	id: PLAN_IDS.creditTopUp,
	name: t.name,
	addOn: t.addOn,
	items: [
		item({
			featureId: aiCredits.id,
			price: {
				amount: defined(t.credits.overage).amount,
				billingUnits: defined(t.credits.overage).billingUnits,
				billingMethod: defined(t.credits.overage).billingMethod,
				interval: 'month',
			},
		}),
	],
});

// ---------------------------------------------------------------------------
// Plans — Annual (~17% discount, credits still reset monthly)
// ---------------------------------------------------------------------------

const pa = ANNUAL_PLANS[PLAN_IDS.proAnnual];
export const proAnnual = plan({
	id: PLAN_IDS.proAnnual,
	name: pa.name,
	group: pa.group,
	price: defined(pa.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: pa.credits.included,
			price: {
				amount: pa.credits.overage.amount,
				billingUnits: pa.credits.overage.billingUnits,
				billingMethod: pa.credits.overage.billingMethod,
				interval: 'month',
			},
		}),
		item({
			featureId: storageBytes.id,
			included: 5_000_000_000,
			price: {
				amount: 1,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: 'month',
			},
		}),
	],
});

const ua = ANNUAL_PLANS[PLAN_IDS.ultraAnnual];
export const ultraAnnual = plan({
	id: PLAN_IDS.ultraAnnual,
	name: ua.name,
	group: ua.group,
	price: defined(ua.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: ua.credits.included,
			price: {
				amount: ua.credits.overage.amount,
				billingUnits: ua.credits.overage.billingUnits,
				billingMethod: ua.credits.overage.billingMethod,
				interval: 'month',
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 10_000_000_000,
			price: {
				amount: 0.75,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: 'month',
			},
		}),
	],
});

const ma = ANNUAL_PLANS[PLAN_IDS.maxAnnual];
export const maxAnnual = plan({
	id: PLAN_IDS.maxAnnual,
	name: ma.name,
	group: ma.group,
	price: defined(ma.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: ma.credits.included,
			price: {
				amount: ma.credits.overage.amount,
				billingUnits: ma.credits.overage.billingUnits,
				billingMethod: ma.credits.overage.billingMethod,
				interval: 'month',
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 50_000_000_000,
			price: {
				amount: 0.5,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: 'month',
			},
		}),
	],
});
