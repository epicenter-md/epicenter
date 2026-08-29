/**
 * Epicenter Cloud's hosted model catalog: the models Cloud sells, and the vendor
 * lane each one routes to.
 *
 * This is a COMMERCIAL fact, not shared infrastructure. Its readers are
 * `apps/api` (gateway routing and the key into Cloud-only pricing) and the Cloud
 * client apps (picker labels). A self-hosted instance serves the operator's own
 * upstream with the operator's own key, so it has no business reading what
 * Epicenter sells and imports none of this.
 *
 * `HOSTED_MODELS` is the single source of the live provider vocabulary:
 * `HostedProvider` is derived from it, and `HOSTED_PROVIDERS` must carry a label
 * for every provider it serves, enforced at compile time. There is no separate
 * durable provider registry: a provider retired from the catalog drops out of the
 * vocabulary, and `providerLabel` degrades its historical id to raw text at the
 * render edge rather than throwing. The model id is a free string on the wire:
 * the OpenAI-compatible gateway (ADR-0050) owns routing, so an id the backend
 * cannot serve is a runtime gateway error, not a compile error here.
 *
 * The catalog carries NO pricing. Per-model cost is token-based and Cloud-only,
 * living in `apps/api/worker/billing/model-pricing.ts` (spec
 * `specs/20260826T120000-inference-credit-billing.md`), keyed by the ids here.
 *
 * This is the build-time SEED of a layered catalog (ADR-0104): a typed `as const`
 * so `HostedModelId` keeps its literal narrowing, bundled at compile time, offline,
 * present at first paint. Hosted models are authored here, never discovered: unlike
 * a custom endpoint (someone else's box, discovered via `/v1/models`, ADR-0060), we
 * own this list. A runtime OVERLAY that spreads more entries on top is deliberately
 * NOT built: it is deferred until the catalog changes faster than clients ship, and
 * grafts on then with no rework. Keep this a typed const, not a raw `.json` (a JSON
 * import would widen ids to `string` and lose the union).
 */

/**
 * One sellable model. `label` is the product role shown in the picker (Fast,
 * Best), not a vendor name. `provider` tags the gateway lane the id routes to.
 * The catalog literal pins `id`, `provider`, and `label` together, so a model is
 * described in exactly one place. Pricing is intentionally absent: it is
 * token-based and Cloud-only (see the module comment).
 */
export type HostedCatalogEntry = {
	id: string;
	provider: 'openai' | 'gemini';
	label: string;
};

/** A vendor Cloud sells through. Derived from the catalog literal, so
 *  `HOSTED_MODELS` is the single source of the provider vocabulary. */
export type HostedProvider = HostedCatalogEntry['provider'];

/**
 * Vendor display names, keyed by provider id. `satisfies Record<HostedProvider>`
 * forces a label for every live provider: add a provider to the catalog and
 * forget its label here, and this stops compiling at the missing key. Internal:
 * callers resolve a label through `providerLabel`, which tolerates ids this code
 * does not recognize, so a stray historical id degrades to one literal cell.
 */
const HOSTED_PROVIDERS = {
	openai: { label: 'OpenAI' },
	gemini: { label: 'Google' },
} as const satisfies Record<HostedProvider, { label: string }>;

/**
 * Resolve a persisted provider id to its vendor label for display, falling back
 * to the raw id when this deploy does not recognize it. The picker always passes
 * a known `HostedProvider`; the activity feed may pass an arbitrary historical
 * string, so one unrecognized id never fails the whole read.
 */
export function providerLabel(id: string): string {
	return Object.hasOwn(HOSTED_PROVIDERS, id)
		? HOSTED_PROVIDERS[id as HostedProvider].label
		: id;
}

/**
 * The catalog, in display order. `gemini-3.5-flash` is the Chinese-tuned default
 * for Vocab and is not offered elsewhere. What each model costs is resolved
 * Cloud-side per request (token-based); nothing here.
 */
export const HOSTED_MODELS = [
	{ id: 'gpt-5.4-mini', provider: 'openai', label: 'Fast' },
	{ id: 'gpt-5.5', provider: 'openai', label: 'Best' },
	{ id: 'gemini-3.5-flash', provider: 'gemini', label: 'Fast' },
] as const satisfies readonly HostedCatalogEntry[];

export type HostedModelId = (typeof HOSTED_MODELS)[number]['id'];

/** Tuple of every hosted model id, for arktype `type.enumerated(...)`. */
export const HOSTED_MODEL_IDS = HOSTED_MODELS.map((model) => model.id) as [
	HostedModelId,
	...HostedModelId[],
];

/** Catalog entry by id, for pickers that render the label and route by provider. */
export const HOSTED_MODELS_BY_ID = Object.fromEntries(
	HOSTED_MODELS.map((model) => [model.id, model]),
) as Record<HostedModelId, HostedCatalogEntry>;

/**
 * Decorate the hosted ids an app sells with their product label. Every chat app
 * feeds the result to `createInferenceConnections` as its hosted catalog, so the
 * `{ id, label }` mapping lives here once instead of being rewritten per app. The
 * shape matches `@epicenter/app-shell` `HostedModel`. Per-model cost is not part
 * of the catalog; a live cost estimate is a Cloud-sourced display concern.
 */
export function hostedCatalogFor(
	ids: readonly HostedModelId[],
): { id: HostedModelId; label: string }[] {
	return ids.map((id) => ({
		id,
		label: HOSTED_MODELS_BY_ID[id].label,
	}));
}
