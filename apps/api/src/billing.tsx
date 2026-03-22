import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { Err, tryAsync } from 'wellcrafted/result';
import type { Env } from './app';
import { createAutumn } from './autumn';
import { FEATURE_IDS, MAIN_PLAN_IDS, PLAN_IDS, PLANS } from './billing-plans';

const billing = new Hono<Env>();

billing.use(csrf());

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const FLASH_MESSAGES: Record<
	string,
	{ type: 'success' | 'error'; message: string }
> = {
	upgraded: { type: 'success', message: 'Plan upgraded successfully.' },
	canceled: {
		type: 'success',
		message: 'Subscription will cancel at the end of this billing cycle.',
	},
	uncanceled: {
		type: 'success',
		message: 'Cancellation reversed\u2014your plan stays active.',
	},
	topped_up: { type: 'success', message: 'Credits added to your account.' },
};

type PlanCardPlan = {
	id: string;
	name: string;
	price: { amount: number; interval: string } | null;
	items: Array<{
		included: number;
		price: { amount?: number; billingUnits: number } | null;
	}>;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /billing — Main dashboard */
billing.get('/', async (c) => {
	const autumn = createAutumn(c.env);
	const userId = c.var.user.id;

	const q = c.req.query();
	const flashKey = Object.keys(q).find((k) => k in FLASH_MESSAGES);
	const flash = q['error']
		? { type: 'error' as const, message: decodeURIComponent(q['error']!) }
		: flashKey
			? FLASH_MESSAGES[flashKey]
			: undefined;

	const { data, error } = await tryAsync({
		try: () =>
			Promise.all([
				autumn.customers.getOrCreate({
					customerId: userId,
					name: c.var.user.name ?? undefined,
					email: c.var.user.email ?? undefined,
					expand: ['subscriptions.plan', 'balances.feature'],
				}),
				autumn.plans.list({ customerId: userId }),
			]),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (error) {
		console.error('Billing dashboard error:', error);
		return c.html(
			<Layout
				flash={{
					type: 'error',
					message: 'Failed to load billing data. Try refreshing.',
				}}
			>
				<p class="text-zinc-500">
					Something went wrong loading your billing information.
				</p>
			</Layout>,
		);
	}

	const [customer, plansResult] = data;

	const creditBalance = customer.balances[FEATURE_IDS.aiCredits];
	const currentBalance = creditBalance?.remaining ?? 0;
	const includedCredits = creditBalance?.granted ?? 50;
	const resetsAt = creditBalance?.nextResetAt
		? formatDate(creditBalance.nextResetAt)
		: null;

	const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
	const currentPlanId = mainSub?.planId ?? 'free';

	const eligibilityMap = new Map<string, string>();
	for (const plan of plansResult.list) {
		if (plan.customerEligibility) {
			eligibilityMap.set(plan.id, plan.customerEligibility.attachAction);
		}
	}

	const planMap = new Map(plansResult.list.map((p) => [p.id, p]));
	const mainPlans = MAIN_PLAN_IDS.map((id) => planMap.get(id)).filter(
		(p) => p !== undefined,
	);

	return c.html(
		<Layout flash={flash}>
			<CreditBalance
				balance={currentBalance}
				included={includedCredits}
				resetsAt={resetsAt}
			/>

			<section class="mb-10">
				<h2 class="text-lg font-medium mb-3">Plans</h2>
				<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
					{mainPlans.map((plan) => (
						<PlanCard
							plan={plan}
							isCurrent={currentPlanId === plan.id}
							eligibility={eligibilityMap.get(plan.id)}
						/>
					))}
				</div>
			</section>

			<SubscriptionSection subscription={mainSub} />

			<section class="flex flex-wrap gap-3">
				<form method="post" action="/billing/top-up">
					<button
						type="submit"
						class="py-2.5 px-5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors"
					>
						Buy {PLANS[PLAN_IDS.creditTopUp].credits.overage!.billingUnits} credits —
					${PLANS[PLAN_IDS.creditTopUp].credits.overage!.amount}
					</button>
				</form>
				<a
					href="/billing/portal"
					class="inline-flex items-center py-2.5 px-5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors"
				>
					Manage billing
				</a>
			</section>
		</Layout>,
	);
});

/** POST /billing/upgrade — Attach a plan */
billing.post('/upgrade', async (c) => {
	const planId = await parsePlanId(c);
	if (!planId) return c.redirect('/billing?error=Missing+plan+ID');

	const { data: result, error } = await tryAsync({
		try: () =>
			createAutumn(c.env).billing.attach({
				customerId: c.var.user.id,
				planId,
				successUrl: new URL('/billing/success', c.req.url).toString(),
			}),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (error) {
		console.error('Upgrade error:', error);
		return c.redirect('/billing?error=Upgrade+failed.+Please+try+again.');
	}

	if (result.paymentUrl) return c.redirect(result.paymentUrl);
	return c.redirect('/billing?upgraded=true');
});

/** POST /billing/cancel — Cancel subscription at end of cycle */
billing.post('/cancel', async (c) => {
	const planId = await parsePlanId(c);
	if (!planId) return c.redirect('/billing?error=Missing+plan+ID');

	const { error } = await tryAsync({
		try: () =>
			createAutumn(c.env).billing.update({
				customerId: c.var.user.id,
				planId,
				cancelAction: 'cancel_end_of_cycle',
			}),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (error) {
		console.error('Cancel error:', error);
		return c.redirect('/billing?error=Cancellation+failed.+Please+try+again.');
	}

	return c.redirect('/billing?canceled=true');
});

/** POST /billing/uncancel — Reverse pending cancellation */
billing.post('/uncancel', async (c) => {
	const planId = await parsePlanId(c);
	if (!planId) return c.redirect('/billing?error=Missing+plan+ID');

	const { error } = await tryAsync({
		try: () =>
			createAutumn(c.env).billing.update({
				customerId: c.var.user.id,
				planId,
				cancelAction: 'uncancel',
			}),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (error) {
		console.error('Uncancel error:', error);
		return c.redirect('/billing?error=Failed+to+reverse+cancellation.');
	}

	return c.redirect('/billing?uncanceled=true');
});

/** GET /billing/portal — Redirect to Stripe customer portal */
billing.get('/portal', async (c) => {
	const { data: result, error } = await tryAsync({
		try: () =>
			createAutumn(c.env).billing.openCustomerPortal({
				customerId: c.var.user.id,
				returnUrl: new URL('/billing', c.req.url).toString(),
			}),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (error) {
		console.error('Portal error:', error);
		return c.redirect('/billing?error=Could+not+open+billing+portal.');
	}

	return c.redirect(result.url);
});

/** POST /billing/top-up — Purchase credit top-up */
billing.post('/top-up', async (c) => {
	const { data: result, error } = await tryAsync({
		try: () =>
			createAutumn(c.env).billing.attach({
				customerId: c.var.user.id,
				planId: PLAN_IDS.creditTopUp,
				successUrl: new URL('/billing/success', c.req.url).toString(),
			}),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (error) {
		console.error('Top-up error:', error);
		return c.redirect('/billing?error=Top-up+failed.+Please+try+again.');
	}

	if (result.paymentUrl) return c.redirect(result.paymentUrl);
	return c.redirect('/billing?topped_up=true');
});

/** GET /billing/success — Post-checkout landing */
billing.get('/success', (c) => {
	return c.html(
		<Layout title="Payment successful" redirectAfter={[3, '/billing']}>
			<div class="text-center py-20">
				<div class="text-4xl mb-4">✓</div>
				<h2 class="text-xl font-semibold mb-2">Payment successful</h2>
				<p class="text-zinc-400 mb-6">Your account has been updated.</p>
				<a
					href="/billing"
					class="inline-flex py-2.5 px-5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
				>
					Back to billing
				</a>
			</div>
		</Layout>,
	);
});

export { billing };

// ---------------------------------------------------------------------------
// Components (function declarations hoist above routes)
// ---------------------------------------------------------------------------

function Layout({
	children,
	title,
	flash,
	redirectAfter,
}: {
	children: unknown;
	title?: string;
	flash?: { type: 'success' | 'error'; message: string };
	redirectAfter?: [number, string];
}) {
	return (
		<html lang="en" class="dark">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{title ? `${title} — Epicenter` : 'Billing — Epicenter'}</title>
				{redirectAfter && (
					<meta
						http-equiv="refresh"
						content={`${redirectAfter[0]};url=${redirectAfter[1]}`}
					/>
				)}
				<script src="https://cdn.tailwindcss.com"></script>
				<style>{`
					body { font-family: system-ui, -apple-system, sans-serif; }
					.credit-bar { background: #27272a; border-radius: 6px; overflow: hidden; height: 8px; }
					.credit-fill { background: #10b981; height: 100%; transition: width 0.3s; border-radius: 6px; }
				`}</style>
			</head>
			<body class="bg-zinc-950 text-zinc-100 min-h-screen">
				<div class="max-w-4xl mx-auto px-6 py-12">
					<header class="mb-10">
						<h1 class="text-2xl font-semibold tracking-tight">Billing</h1>
						<p class="text-zinc-400 mt-1 text-sm">
							Manage your plan, credits, and payment methods.
						</p>
					</header>

					{flash && (
						<div
							class={`mb-6 px-4 py-3 rounded-lg text-sm ${
								flash.type === 'success'
									? 'bg-emerald-950 text-emerald-200 border border-emerald-800'
									: 'bg-red-950 text-red-200 border border-red-800'
							}`}
						>
							{flash.message}
						</div>
					)}

					{children}
				</div>
			</body>
		</html>
	);
}

function CreditBalance({
	balance,
	included,
	resetsAt,
}: {
	balance: number;
	included: number;
	resetsAt: string | null;
}) {
	const pct =
		included > 0 ? Math.min(100, Math.round((balance / included) * 100)) : 0;
	return (
		<section class="mb-10">
			<h2 class="text-lg font-medium mb-3">Credits</h2>
			<div class="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
				<div class="flex items-baseline justify-between mb-3">
					<span class="text-2xl font-semibold tabular-nums">
						{balance.toLocaleString()}
					</span>
					<span class="text-zinc-400 text-sm">
						of {included.toLocaleString()} included
					</span>
				</div>
				<div class="credit-bar">
					<div class="credit-fill" style={`width: ${pct}%`} />
				</div>
				{resetsAt && (
					<p class="text-zinc-500 text-xs mt-2">Resets {resetsAt}</p>
				)}
			</div>
		</section>
	);
}

function PlanCard({
	plan,
	isCurrent,
	eligibility,
}: {
	plan: PlanCardPlan;
	isCurrent: boolean;
	eligibility: string | undefined;
}) {
	const creditItem = plan.items[0];

	const labels: Record<string, string> = {
		upgrade: `Upgrade to ${plan.name}`,
		downgrade: `Downgrade to ${plan.name}`,
		activate: `Subscribe to ${plan.name}`,
	};
	const buttonLabel = isCurrent
		? 'Current plan'
		: (labels[eligibility ?? ''] ?? `Switch to ${plan.name}`);

	return (
		<div
			class={`rounded-xl border p-5 flex flex-col ${
				isCurrent
					? 'border-emerald-700 bg-emerald-950/30'
					: 'border-zinc-800 bg-zinc-900'
			}`}
		>
			<h3 class="text-lg font-semibold">{plan.name}</h3>
			<p class="text-2xl font-bold mt-1">{formatPrice(plan.price)}</p>
			<p class="text-zinc-400 text-sm mt-1">{formatCredits(creditItem)}</p>
			<p class="text-zinc-500 text-xs mt-0.5">{formatOverage(creditItem)}</p>
			<div class="mt-auto pt-4">
				{isCurrent ? (
					<button
						disabled
						class="w-full py-2 px-4 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-500 cursor-not-allowed"
					>
						Current plan
					</button>
				) : (
					<form method="post" action="/billing/upgrade">
						<input type="hidden" name="planId" value={plan.id} />
						<button
							type="submit"
							class={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
								eligibility === 'upgrade'
									? 'bg-emerald-600 hover:bg-emerald-500 text-white'
									: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
							}`}
						>
							{buttonLabel}
						</button>
					</form>
				)}
			</div>
		</div>
	);
}

function SubscriptionSection({
	subscription,
}: {
	subscription: {
		planId: string;
		plan?: { name: string };
		status: string;
		canceledAt: number | null;
		expiresAt: number | null;
		currentPeriodEnd: number | null;
	} | null;
}) {
	if (!subscription || subscription.planId === 'free') return null;

	const isCanceled = subscription.canceledAt && subscription.canceledAt > 0;

	return (
		<section class="mb-10">
			<h2 class="text-lg font-medium mb-3">Subscription</h2>
			<div class="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
				{isCanceled ? (
					<div class="flex items-center justify-between">
						<div>
							<p class="text-rose-300 text-sm">
								Cancels on{' '}
								{formatDate(
									subscription.expiresAt ?? subscription.currentPeriodEnd,
								)}
							</p>
							<p class="text-zinc-500 text-xs mt-0.5">
								You'll lose access to paid features after this date.
							</p>
						</div>
						<form method="post" action="/billing/uncancel">
							<input type="hidden" name="planId" value={subscription.planId} />
							<button
								type="submit"
								class="py-2 px-4 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
							>
								Keep plan
							</button>
						</form>
					</div>
				) : (
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm">
								{subscription.plan?.name ?? subscription.planId} plan—active
							</p>
							{subscription.currentPeriodEnd && (
								<p class="text-zinc-500 text-xs mt-0.5">
									Renews {formatDate(subscription.currentPeriodEnd)}
								</p>
							)}
						</div>
						<form method="post" action="/billing/cancel">
							<input type="hidden" name="planId" value={subscription.planId} />
							<button
								type="submit"
								class="py-2 px-4 rounded-lg text-sm font-medium bg-zinc-700 hover:bg-red-900 hover:text-red-200 text-zinc-300 transition-colors"
							>
								Cancel plan
							</button>
						</form>
					</div>
				)}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Helpers (function declarations hoist above routes)
// ---------------------------------------------------------------------------

function formatPrice(
	price: { amount: number; interval: string } | null,
): string {
	if (!price || price.amount === 0) return '$0';
	return `$${price.amount}/${price.interval}`;
}

function formatCredits(item: { included: number } | undefined): string {
	if (!item) return 'No credits';
	return `${item.included.toLocaleString()} credits/mo`;
}

function formatOverage(
	item: { price: { amount?: number; billingUnits: number } | null } | undefined,
): string {
	if (!item?.price?.amount) return 'No overage';
	return `$${item.price.amount} per ${item.price.billingUnits} extra`;
}

/** Format a unix timestamp (seconds) to a human-readable date. */
function formatDate(timestamp: number | null | undefined): string {
	if (!timestamp) return '—';
	return new Date(timestamp * 1000).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

async function parsePlanId(c: {
	req: { parseBody: () => Promise<Record<string, unknown>> };
}) {
	const body = await c.req.parseBody();
	const planId = body['planId'];
	return typeof planId === 'string' ? planId : undefined;
}
