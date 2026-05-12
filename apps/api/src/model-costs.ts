import type { ANTHROPIC_MODELS } from '@tanstack/ai-anthropic';
import type { GeminiTextModels } from '@tanstack/ai-gemini';
import type { GROK_CHAT_MODELS } from '@tanstack/ai-grok';
import type { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';

type SupportedModel =
	| (typeof OPENAI_CHAT_MODELS)[number]
	| (typeof ANTHROPIC_MODELS)[number]
	| (typeof GeminiTextModels)[number]
	| (typeof GROK_CHAT_MODELS)[number];

/**
 * Per-model credit costs for proportional AI billing.
 *
 * Each credit ≈ $0.01 on the Pro plan ($1/100 credits overage).
 * Costs are set to maintain ~50%+ margin based on provider pricing
 * (estimated at 750 input + 1500 output tokens per average message).
 *
 * Models not in this map are rejected with 400 "Unknown model".
 * This effectively blocks unsupported or prohibitively expensive models
 * (e.g., o1-pro at $150/$600 per M tokens).
 */
export const MODEL_CREDITS: Partial<Record<SupportedModel, number>> = {
	// ── OpenAI: Nano/Mini (1 credit) ─────────────────────────────
	'gpt-5-nano': 1, // $0.05/$0.40
	'gpt-4.1-nano': 1, // $0.10/$0.40
	'gpt-4o-mini': 1, // $0.15/$0.60
	'gpt-5-mini': 1, // $0.25/$2.00
	'gpt-4.1-mini': 1, // $0.40/$1.60
	'gpt-3.5-turbo': 1, // $0.50/$1.50

	// ── OpenAI: Reasoning Mini (2 credits) ───────────────────────
	'o4-mini': 2, // $1.10/$4.40
	'o3-mini': 2, // $1.10/$4.40

	// ── OpenAI: Standard (3 credits) ─────────────────────────────
	'gpt-5': 3, // $1.25/$10
	'gpt-5.1': 3, // $1.25/$10
	'gpt-5-codex': 3, // $1.25/$10
	'gpt-5.1-codex': 3, // $1.25/$10
	'gpt-4.1': 3, // $2/$8
	o3: 3, // $2/$8
	'o4-mini-deep-research': 3, // $2/$8

	// ── OpenAI: Enhanced (4–5 credits) ───────────────────────────
	'gpt-4o': 4, // $2.50/$10
	'gpt-5.2': 5, // $1.75/$14
	'gpt-5.2-chat-latest': 5, // $1.75/$14
	'computer-use-preview': 5, // $3/$12

	// ── OpenAI: Audio (2–4 credits) ──────────────────────────────
	'gpt-audio': 4, // $2.50/$10
	'gpt-audio-mini': 2, // estimated mini pricing
	'gpt-4o-audio': 4, // $2.50/$10
	'gpt-4o-mini-audio': 1, // estimated mini pricing

	// ── OpenAI: Chat/Search variants ─────────────────────────────
	'gpt-5.1-chat-latest': 3, // same as gpt-5.1
	'gpt-5-chat-latest': 3, // same as gpt-5
	'chatgpt-4o-latest': 4, // same as gpt-4o
	'gpt-4o-search-preview': 4, // same as gpt-4o
	'gpt-4o-mini-search-preview': 1, // same as gpt-4o-mini
	'gpt-5.1-codex-mini': 1, // mini pricing
	'codex-mini-latest': 1, // mini pricing

	// ── OpenAI: Legacy (expensive) ───────────────────────────────
	'gpt-4-turbo': 12, // $10/$30
	'gpt-4': 25, // $30/$60

	// ── OpenAI: Premium reasoning ────────────────────────────────
	o1: 25, // $15/$60
	'o3-deep-research': 15, // $10/$40
	'o3-pro': 30, // $20/$80

	// ── OpenAI: Pro tier (very expensive) ────────────────────────
	'gpt-5-pro': 40, // $15/$120
	'gpt-5.2-pro': 55, // $21/$168
	// o1-pro: BLOCKED ($150/$600 — not included)

	// ── Gemini: Flash Lite (1 credit) ────────────────────────────
	'gemini-3.1-flash-lite-preview': 1, // $0.25/$1.50
	'gemini-2.5-flash-lite': 1, // $0.04/$0.16
	'gemini-2.5-flash-lite-preview-09-2025': 1, // $0.04/$0.16
	'gemini-2.0-flash-lite': 1, // $0.02/$0.08

	// ── Gemini: Flash (1–2 credits) ──────────────────────────────
	'gemini-3-flash-preview': 2, // $0.30/$2.50
	'gemini-2.5-flash': 1, // $0.15/$0.60
	'gemini-2.5-flash-preview-09-2025': 1, // $0.15/$0.60
	'gemini-2.0-flash': 1, // $0.10/$0.40

	// ── Gemini: Pro (5 credits) ──────────────────────────────────
	'gemini-3.1-pro-preview': 5, // $1.25/$10
	'gemini-3-pro-preview': 5, // $1.25/$10
	'gemini-2.5-pro': 5, // $1.25/$10

	// ── Anthropic: Haiku (1–2 credits) ───────────────────────────
	'claude-3-haiku': 1, // $0.25/$1
	'claude-3-5-haiku': 2, // $0.80/$4
	'claude-haiku-4-5': 2, // $1/$5

	// ── Anthropic: Sonnet (5 credits) ────────────────────────────
	'claude-3-7-sonnet': 5, // $3/$15
	'claude-sonnet-4': 5, // $3/$15
	'claude-sonnet-4-5': 5, // $3/$15
	'claude-sonnet-4-6': 5, // $3/$15

	// ── Anthropic: Opus (10–30 credits) ──────────────────────────
	'claude-opus-4-6': 10, // $5/$25
	'claude-opus-4': 30, // $15/$75
	'claude-opus-4-1': 30, // $15/$75
	'claude-opus-4-5': 30, // $15/$75

	// ── Grok: Mini/Fast non-reasoning (1–2 credits) ───────────────
	'grok-3-mini': 1, // $0.30/$0.50
	'grok-4-fast-non-reasoning': 2, // $0.40/$1
	'grok-4-1-fast-non-reasoning': 2, // $0.40/$1
	'grok-2-vision-1212': 2, // older vision model

	// ── Grok: Fast reasoning / code (3 credits) ───────────────────
	'grok-code-fast-1': 3, // $2/$8
	'grok-4-fast-reasoning': 3, // $2/$8
	'grok-4-1-fast-reasoning': 3, // $2/$8

	// ── Grok: Full models (5 credits) ─────────────────────────────
	'grok-3': 5, // $3/$15
	'grok-4': 5, // $3/$15
};
