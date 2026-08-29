/**
 * Cloud-only, token-based model pricing.
 *
 * Cloud's hosted catalog (`@epicenter/constants/hosted-catalog`) owns the product
 * vocabulary (id, provider, label) and carries NO cost. All per-model cost lives
 * here, keyed by catalog id, Cloud-only (spec
 * `specs/20260826T120000-inference-credit-billing.md`).
 *
 * A credit is a fixed, published $0.01. Per-model credit cost is derived from a
 * provider cost table (USD per 1M tokens, seeded from models.dev) times a layered
 * markup, then converted through the peg. The credit peg never changes; only the
 * per-model cost does, and only through a reviewed price update.
 *
 * The chat charge is settled on the provider's ACTUAL returned token counts
 * (`creditsForChat`); there is no per-call pre-estimate. `nominalChatCredits` is
 * a representative typical-call figure used only for the "requires a paid plan"
 * message and as the fallback charge when a stream ends without readable usage.
 */

import {
	HOSTED_MODELS_BY_ID,
	type HostedModelId,
	type HostedProvider,
} from '@epicenter/constants/hosted-catalog';

/** The fixed, published credit peg. 1 credit = $0.01. Never re-rated. */
export const CREDIT_USD = 0.01;

/**
 * Per-model provider cost, USD per 1,000,000 tokens, plus whether the free tier
 * may use the model. Seeded from models.dev (`https://models.dev/api.json`,
 * captured 2026-08-26); the daily sync job will own the cost numbers (spec phase
 * 5). `gpt-5.5` also carries a >272k-token tier at 10/45 that is deferred until a
 * call can exceed it.
 */
const MODEL_COST: Record<
	HostedModelId,
	{ inputPerMTok: number; outputPerMTok: number; freeEligible: boolean }
> = {
	'gpt-5.4-mini': {
		inputPerMTok: 0.75,
		outputPerMTok: 4.5,
		freeEligible: true,
	},
	'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, freeEligible: false },
	'gemini-3.5-flash': {
		inputPerMTok: 1.5,
		outputPerMTok: 9,
		freeEligible: true,
	},
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
const PROVIDER_MARKUP: Partial<Record<HostedProvider, number>> = {};
const MODEL_MARKUP: Partial<Record<HostedModelId, number>> = {};

function markupForModel(
	model: HostedModelId,
	provider: HostedProvider,
): number {
	return MODEL_MARKUP[model] ?? PROVIDER_MARKUP[provider] ?? DEFAULT_MARKUP;
}

/** Marked-up USD to whole credits: ceil at the peg, floor 1. */
function usdToCredits(pricedUsd: number): number {
	return Math.max(1, Math.ceil(pricedUsd / CREDIT_USD));
}

/** The chat cost entry for a model, or undefined if unpriced (gate fails closed). */
export function chatModelCost(model: HostedModelId) {
	return MODEL_COST[model];
}

/**
 * Credits for one settled chat turn from the provider's AUTHORITATIVE returned
 * token counts. Profit-safe: it prices the real usage times the markup. The
 * provider is derived from the catalog, so the caller passes only real tokens.
 * Throws on a model with no configured cost (a real 500, never a zero charge).
 */
export function creditsForChat(input: {
	model: HostedModelId;
	inputTokens: number;
	outputTokens: number;
}): number {
	const cost = MODEL_COST[input.model];
	const entry = HOSTED_MODELS_BY_ID[input.model];
	if (!cost || !entry) {
		throw new Error(`No cost configured for model ${input.model}`);
	}
	const provider = entry.provider;
	const usd =
		(input.inputTokens * cost.inputPerMTok +
			input.outputTokens * cost.outputPerMTok) /
		1_000_000;
	const priced = usd * (1 + markupForModel(input.model, provider));
	return usdToCredits(priced);
}

/** Typical-call tokens for the nominal-credit figure. Not a per-request estimate. */
const TYPICAL_INPUT_TOKENS = 750;
const TYPICAL_OUTPUT_TOKENS = 1500;

/**
 * A representative per-call credit for a model (what a typical call costs). Used
 * only for the "requires a paid plan" display and as the fallback charge when a
 * stream ends without readable usage (client abort or a mid-stream error). Never
 * the real per-call charge, which settles on actual returned tokens.
 */
export function nominalChatCredits(model: HostedModelId): number {
	return creditsForChat({
		model,
		inputTokens: TYPICAL_INPUT_TOKENS,
		outputTokens: TYPICAL_OUTPUT_TOKENS,
	});
}

/**
 * Credits for one settled transcription from the provider's returned duration.
 * Rounded up per call with a floor of one credit.
 */
export function transcriptionCredits(input: {
	provider: HostedProvider;
	minutes: number;
}): number {
	const usd = input.minutes * TRANSCRIPTION_USD_PER_MINUTE;
	const priced =
		usd * (1 + (PROVIDER_MARKUP[input.provider] ?? DEFAULT_MARKUP));
	return usdToCredits(priced);
}
