/**
 * Cloud-only, token-based model pricing.
 *
 * The shared catalog (`@epicenter/constants/ai-providers`) owns the product
 * vocabulary (id, provider, label) and carries NO cost, so the billing-agnostic
 * library route and self-host import it without any pricing. All per-model cost
 * lives here, Cloud-only (spec `specs/20260826T120000-inference-credit-billing.md`).
 *
 * A credit is a fixed, published $0.01. Per-model credit cost is derived from a
 * provider cost table (USD per 1M tokens, seeded from models.dev) times a layered
 * markup, then converted through the peg. The credit peg never changes; only the
 * per-model cost does, and only through a reviewed price update.
 *
 * Phase status (see the spec): this module is the pricing HOME. `creditsForChat`
 * and `transcriptionCredits` are the token-based functions the settle path will
 * use once the gateway extracts real usage (spec phase 3/4). Until then,
 * `reserveAiChat` charges `INTERIM_FIXED_CHAT_CREDITS` (the prior hand-set values,
 * relocated here unchanged) so the split lands behavior-preserving.
 */

import type {
	AiProvider,
	ServableModel,
} from '@epicenter/constants/ai-providers';

/** The fixed, published credit peg. 1 credit = $0.01. Never re-rated. */
export const CREDIT_USD = 0.01;

/**
 * Per-model provider cost, USD per 1,000,000 tokens. Seeded from models.dev
 * (`https://models.dev/api.json`, captured 2026-08-26); the daily sync job will
 * own these numbers (spec phase 5). `gpt-5.5` also carries a >272k-token tier at
 * 10/45 that is deferred until a call can exceed it.
 */
const MODEL_COST: Record<
	ServableModel,
	{ inputPerMTok: number; outputPerMTok: number }
> = {
	'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 },
	'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30 },
	'gemini-3.5-flash': { inputPerMTok: 1.5, outputPerMTok: 9 },
};

/**
 * OpenAI Whisper has no per-minute price in models.dev (the dataset omits it or
 * expresses audio as input tokens), so the transcription rate is a manual cost:
 * OpenAI `whisper-1` list price, USD per minute.
 */
const TRANSCRIPTION_USD_PER_MINUTE = 0.006;

/**
 * Layered markup, most-specific wins: per-model, then per-provider, then the
 * default. The markup is the guaranteed floor margin (spec: profit per call >=
 * cost * markup). Start at 1.5x cost; a healthy buffer absorbs models.dev drift
 * and non-token overhead. Raise-averse: start high and discount, never re-rate up.
 */
const DEFAULT_MARKUP = 0.5;
const PROVIDER_MARKUP: Partial<Record<AiProvider, number>> = {};
const MODEL_MARKUP: Partial<Record<ServableModel, number>> = {};

function markupForModel(model: ServableModel, provider: AiProvider): number {
	return (
		MODEL_MARKUP[model] ?? PROVIDER_MARKUP[provider] ?? DEFAULT_MARKUP
	);
}

/** Marked-up USD to whole credits: ceil at the peg, floor 1. */
function usdToCredits(pricedUsd: number): number {
	return Math.max(1, Math.ceil(pricedUsd / CREDIT_USD));
}

/**
 * Credits for one settled chat turn from the provider's AUTHORITATIVE returned
 * token counts. This is the charge the settle path commits (spec phase 3); it is
 * profit-safe because it prices the real usage times the markup.
 */
export function creditsForChat(input: {
	model: ServableModel;
	provider: AiProvider;
	inputTokens: number;
	outputTokens: number;
}): number {
	const cost = MODEL_COST[input.model];
	if (!cost) {
		// A served model with no configured cost is a config invariant break, not
		// a user error: fail closed (a real 500) rather than charge zero.
		throw new Error(`No cost configured for model ${input.model}`);
	}
	const usd =
		(input.inputTokens * cost.inputPerMTok +
			input.outputTokens * cost.outputPerMTok) /
		1_000_000;
	const priced = usd * (1 + markupForModel(input.model, input.provider));
	return usdToCredits(priced);
}

/**
 * Credits for one settled transcription from the provider's returned duration.
 * Rounded up per call with a floor of one credit.
 */
export function transcriptionCredits(input: {
	provider: AiProvider;
	minutes: number;
}): number {
	const usd = input.minutes * TRANSCRIPTION_USD_PER_MINUTE;
	const priced = usd * (1 + (PROVIDER_MARKUP[input.provider] ?? DEFAULT_MARKUP));
	return usdToCredits(priced);
}

/**
 * Interim per-model chat credit, relocated unchanged from the old shared catalog
 * so the registry split lands behavior-preserving. `reserveAiChat` charges this
 * fixed amount until the settle path (spec phase 3) replaces it with
 * {@link creditsForChat} over real returned usage. DELETE with that phase.
 */
export const INTERIM_FIXED_CHAT_CREDITS: Record<ServableModel, number> = {
	'gpt-5.4-mini': 2,
	'gpt-5.5': 10,
	'gemini-3.5-flash': 2,
};
