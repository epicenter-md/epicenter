/**
 * Provider and model configuration for AI chat.
 *
 * Pure data — no Svelte runes, no side effects.
 * Model arrays are maintained by TanStack AI provider packages.
 * To update model lists, run: `bun update @tanstack/ai-openai @tanstack/ai-anthropic ...`
 */

import { ANTHROPIC_MODELS } from '@tanstack/ai-anthropic';
import { GeminiTextModels } from '@tanstack/ai-gemini';
import { GROK_CHAT_MODELS } from '@tanstack/ai-grok';
import { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';

/**
 * Model arrays imported from TanStack AI provider packages.
 *
 * These are maintained by the TanStack AI team — no local hardcoded lists.
 * To update model lists, run: `bun update @tanstack/ai-openai @tanstack/ai-anthropic ...`
 *
 * Arrays are ordered newest-first by the upstream packages.
 */
export const PROVIDER_MODELS = {
	openai: OPENAI_CHAT_MODELS,
	anthropic: ANTHROPIC_MODELS,
	gemini: GeminiTextModels,
	grok: GROK_CHAT_MODELS,
} as const;

export type Provider = keyof typeof PROVIDER_MODELS;

export const DEFAULT_PROVIDER: Provider = 'openai';
export const DEFAULT_MODEL = PROVIDER_MODELS[DEFAULT_PROVIDER][0];
export const AVAILABLE_PROVIDERS = Object.keys(PROVIDER_MODELS) as Provider[];
