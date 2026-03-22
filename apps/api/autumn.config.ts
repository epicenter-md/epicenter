import { feature, item, plan } from 'atmn';
import { FEATURE_IDS, PLAN_IDS, PLANS } from './src/billing-plans';

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

// ---------------------------------------------------------------------------
// Plans
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
	],
});

const p = PLANS[PLAN_IDS.pro];
export const pro = plan({
	id: PLAN_IDS.pro,
	name: p.name,
	group: p.group,
	price: p.price!,
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
	],
});

const m = PLANS[PLAN_IDS.max];
export const max = plan({
	id: PLAN_IDS.max,
	name: m.name,
	group: m.group,
	price: m.price!,
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
				amount: t.credits.overage!.amount,
				billingUnits: t.credits.overage!.billingUnits,
				billingMethod: t.credits.overage!.billingMethod,
				interval: 'month',
			},
		}),
	],
});
